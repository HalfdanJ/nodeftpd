import net from 'net';
import util from 'util';
import {EventEmitter} from 'events';
import pathModule from 'path';
import fsModule from 'fs';
import StatMode from 'stat-mode';
import dateformat from 'dateformat';

import * as glob from './glob';
import starttls from './starttls';
import Constants from './Constants';

import pathEscape from './helpers/pathEscape';
import withCwd from './helpers/withCwd';
import stripOptions from './helpers/stripOptions';
import leftPad from './helpers/leftPad';

const ENCODED_ADDRESS = /^[0-9]{1,3}(,[0-9]{1,3}){5}$/;

const {
  // Use LOG for brevity.
  LOG_LEVELS: LOG,
  COMMANDS_SUPPORTED,
  COMMANDS_NO_AUTH,
  COMMANDS_REQUIRE_DATA_SOCKET,
} = Constants;

const encodeAddress = (host, port) => {
  var i1 = (port / 256) | 0;
  var i2 = port % 256;
  return host.split('.').join(',') + ',' + i1 + ',' + i2;
};

const decodeAddress = (encoded) => {
  if (ENCODED_ADDRESS.test(encoded) === false) {
    return null;
  }
  let octets = encoded.split(',').map((value) => parseInt(value, 10));
  let isOutOfRange = octets.some((number) => number > 255);
  if (isOutOfRange) {
    return null;
  }
  return {
    host: octets.slice(0, 4).join('.'),
    port: (octets[5] << 8) + octets[6],
  };
};

class FtpConnection extends EventEmitter {
  constructor(options = {}) {
    super();
    // TODO: Throw if any required option not present.
    this.server = options.server;
    this.socket = options.socket;
    this.passiveListenerPool = options.passiveListenerPool;
    this.allowedCommands = options.allowedCommands;
    this.tlsOptions = options.tlsOptions;

    // TODO: I don't think this should be 20.
    this.dataPort = 20;
    this.dataHost = null;
    // The incoming (PASV) data connection.
    this.dataConnection = null;
    // the actual data socket
    this.dataSocket = null;
    this._isEstablishingDataConnection = false;
    this._hasReceivedPASV = false;
    this._hasReceivedPORT = false;

    this.mode = 'ascii';
    this.filefrom = '';
    this.username = null;
    this.fs = null;
    this.cwd = null;
    this.root = null;
    this.hasQuit = false;
    // State for handling TLS upgrades.
    this.secure = false;
    this.pbszReceived = false;
  }

  // TODO: rename this to writeLine?
  respond(message, callback) {
    return this._writeText(this.socket, message + '\r\n', callback);
  }

  _log(verbosity, message) {
    var peerAddr = this.socket ? this.socket.remoteAddress : null;
    return this.server._log(
      verbosity,
      peerAddr ? `<${peerAddr}> ${message}` : message
    );
  }

  // We don't want to use setEncoding because it screws up TLS, but we
  // also don't want to explicitly specify ASCII encoding for every call to 'write'
  // with a string argument.
  _writeText(socket, data, callback) {
    if (!socket.writable) {
      this._log(LOG.DEBUG, 'Attempted writing to a closed socket:\n>> ' + data.trim());
      return;
    }
    this._log(LOG.TRACE, '>> ' + data.trim());
    return socket.write(data, 'utf8', callback);
  }

  _isAuthenticated() {
    return !!this.username;
  }

  _doesRequireDataConnection(command) {
    return (COMMANDS_REQUIRE_DATA_SOCKET[command] === true);
  }

  _hasReceivedDataConnectionRequest() {
    return (
      this._isEstablishingDataConnection ||
      this.dataConnection != null
    );
  }

  // TODO: rename this method.
  _closeDataConnections() {
    if (this.dataConnection) {
      this.dataConnection.destroy();
      this.dataConnection = null;
    }
  }

  _whenDataReady(callback) {
    // TODO: Better to check which mode we are (Active or Passive) and then act accordingly.
    if (this._isEstablishingDataConnection) {
      // TODO: reword.
      this._log(LOG.DEBUG, 'Currently no data connection; expecting client to connect to pasv server shortly...');
      this.on('dataConnectionEstablished', () => {
        this._log(LOG.DEBUG, '...client has connected now');
        let socket = this.dataConnection.getSocket();
        callback(socket);
      });
    } else if (this.dataConnection) {
      this._log(LOG.DEBUG, 'A data connection exists');
      let socket = this.dataConnection.getSocket();
      process.nextTick(() => {
        callback(socket);
      });
    } else {
      // This makes a connection to the client (Active mode).
      this._initiateData((socket) => {
        callback(socket);
      });
    }
  }

  // This makes a connection to the client (Active mode).
  // TODO: fix some stuff here.
  _initiateData(callback) {
    if (this.dataSocket) {
      return callback(this.dataSocket);
    }
    var socket = net.connect(this.dataPort, this.dataHost || this.socket.remoteAddress);
    socket.on('connect', () => {
      this.dataSocket = socket;
      callback(socket);
    });
    const allOver = (err) => {
      this.dataSocket = null;
      this._log(
        err ? LOG.ERROR : LOG.DEBUG,
        'Non-passive data connection ended' + (err ? 'due to error: ' + util.inspect(err) : '')
      );
    };
    // TODO: allOver will get executed twice here.
    socket.on('end', allOver);
    socket.on('close', allOver);
    socket.on('error', (err) => {
      this._closeSocket(socket, true);
      this._log(LOG.ERROR, 'Data connection error: ' + util.inspect(err));
      this.dataSocket = null;
    });
  }

  _onError(err) {
    this._log(LOG.ERROR, 'Client connection error: ' + util.inspect(err));
    this._closeSocket(this.socket, true);
  }

  _onEnd() {
    this._log(LOG.DEBUG, 'Client connection ended');
  }

  _onClose(hadError) {
    // I feel like some of this might be redundant since we probably close some
    // of these sockets elsewhere, but it is fine to call _closeSocket more than
    // once.
    if (this.dataSocket) {
      this._closeSocket(this.dataSocket, hadError);
      this.dataSocket = null;
    }
    if (this.socket) {
      this._closeSocket(this.socket, hadError);
      this.socket = null;
    }
    if (this.dataConnection) {
      this.dataConnection.destroy();
      this.dataConnection = null;
    }
    // TODO: LOG.DEBUG?
    this._log(LOG.INFO, 'Client connection closed');
  }

  _onData(data) {
    if (this.hasQuit) {
      return;
    }
    data = data.toString('utf-8').trim();
    this._log(LOG.TRACE, '<< ' + data);
    // Don't include passwords in logs.
    this._log(
      LOG.INFO,
      'FTP command: ' + data.replace(/^PASS [\s\S]*$/i, 'PASS ***')
    );
    var parts = data.split(' ');
    var command = parts.shift().toUpperCase();
    var commandArg = parts.join(' ').trim();
    if (
      COMMANDS_SUPPORTED[command] !== true ||
      (this.allowedCommands != null && this.allowedCommands[command] !== true)
    ) {
      this.respond('502 Command not implemented.');
      return;
    }
    if (COMMANDS_NO_AUTH[command] === true) {
      this._execCommand(command, commandArg);
      return;
    }
    // If 'tlsOnly' option is set, all commands which require user authentication will only
    // be permitted over a secure connection. See RFC4217 regarding error code.
    if (!this.secure && this.server.options.tlsOnly) {
      this.respond('522 Protection level not sufficient; send AUTH TLS');
      return;
    }
    if (!this._isAuthenticated()) {
      this.respond('530 Not logged in.');
      return;
    }
    if (
      this._doesRequireDataConnection(command) &&
      !this._hasReceivedDataConnectionRequest()
    ) {
      this.respond('425 Data connection not configured; send PASV or PORT');
      return;
    }
    this._execCommand(command, commandArg);
  }

  _execCommand(command, commandArg) {
    var methodName = '__' + command;
    // this.emit('pre-command:' + command, commandArg, command);
    this[methodName](commandArg, command);
    // this.emit('post-command:' + command, commandArg, command);
  }

  _listFiles(fileInfos, isDetailed, command) {
    const whenReady = (listconn) => {
      const success = (err) => {
        if (err) {
          this.respond('550 Error listing files');
        } else {
          this.respond(END_MSGS[command]);
        }
        if (command !== 'STAT') {
          this._closeSocket(listconn);
        }
      };

      if (fileInfos.length === 0) {
        return success();
      }

      this._log(LOG.DEBUG, 'Sending file list');

      for (var i = 0; i < fileInfos.length; ++i) {
        var fileInfo = fileInfos[i];

        var line = '';
        var file;

        if (!isDetailed) {
          file = fileInfo;
          line += file.name + '\r\n';
        } else {
          file = fileInfo.file;
          var s = file.stats;
          var allModes = (new StatMode({mode: s.mode})).toString();
          var rwxModes = allModes.substr(1, 9);
          line += (s.isDirectory() ? 'd' : '-') + rwxModes;
          // ^-- Clients don't need to know about special files and pipes
          line += ' 1 ' +
            (fileInfo.uname || 'ftp') + ' ' +
            (fileInfo.gname === null ? 'ftp' : fileInfo.gname) + ' ';
          line += leftPad(s.size.toString(), 12) + ' ';
          var d = new Date(s.mtime);
          line += leftPad(dateformat(d, 'mmm dd HH:MM'), 12) + ' ';
          line += file.name;
          line += '\r\n';
        }
        this._writeText(
          listconn,
          line,
          (i === fileInfos.length - 1 ? success : undefined)
        );
      }
    };

    var m = '150 Here comes the directory listing';
    var BEGIN_MSGS = {
      LIST: m, NLST: m, STAT: '213-Status follows',
    };
    m = '226 Transfer OK';
    var END_MSGS = {
      LIST: m, NLST: m, STAT: '213 End of status',
    };

    this.respond(BEGIN_MSGS[command], () => {
      if (command === 'STAT') {
        whenReady(this.socket);
      } else {
        this._whenDataReady(whenReady);
      }

    });
  }

  _parseEPRT(commandArg) {
    if (
      commandArg.length >= 3 &&
      commandArg.charAt(0) === '|' &&
      commandArg.charAt(2) === '|' &&
      commandArg.charAt(1) === '2'
    ) {
      // Only IPv4 is supported.
      this.respond('522 Server cannot handle IPv6 EPRT commands, use (1)');
      return;
    }
    var m = commandArg.match(/^\|1\|([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\|([0-9]{1,5})/);
    if (!m) {
      this.respond('501 Bad Argument to EPRT');
      return;
    }
    var r = parseInt(m[2], 10);
    if (isNaN(r)) {
      // The value should never be NaN because the relevant group in the regex matches 1-5 digits.
      throw new Error('Impossible NaN in FtpConnection.prototype._PORT (2)');
    }
    if (r > 65535 || r <= 0) {
      this.respond('501 Bad argument to EPRT (invalid port number)');
      return;
    }
    return {host: m[1], port: r};
  }

  // TODO: this should work the same for active or passive.
  _onDataConnection(socket) {
    this.dataSocket = socket;
    if (this._isEstablishingDataConnection) {
      this.emit('dataConnectionEstablished');
      this._isEstablishingDataConnection = false;
    }

    socket.on('error', (err) => {
      this._log(LOG.ERROR, 'Data socket event: error: ' + err);
      // TODO: Can we can rely on self.dataSocket having been closed?
      this.dataSocket = null;
    });

    const allOver = (name) => {
      return (error) => {
        // Prevent calling twice.
        if (this.dataSocket == null) {
          return;
        }
        this._log(
          error ? LOG.ERROR : LOG.DEBUG,
          'Data socket event: ' + name + (error ? ' due to error' : '')
        );
        this.dataSocket = null;
      };
    };

    // Responses are not guaranteed to have an 'end' event
    // (https://github.com/joyent/node/issues/728), but we want to set
    // dataSocket to null as soon as possible, so we handle both events.
    socket.on('close', allOver('close'));
    socket.on('end', allOver('end'));
  }

  _retrieveUsingCreateReadStream(commandArg, filename) {
    var startTime = new Date();

    this.emit('file:retr', 'open', {
      user: this.username,
      file: filename,
      sTime: startTime,
    });

    const afterOk = (callback) => {
      this.respond('150 Opening ' + this.mode.toUpperCase() + ' mode data connection', callback);
    };

    this.fs.open(filename, 'r', (err, fd) => {
      if (err) {
        this.emit('file:retr', 'error', {
          user: this.username,
          file: filename,
          filesize: 0,
          sTime: startTime,
          eTime: new Date(),
          duration: new Date() - startTime,
          errorState: true,
          error: err,
        });
        if (err.code === 'ENOENT') {
          this.respond('550 Not Found');
        } else { // Who knows what's going on here...
          this.respond('550 Not Accessible');
          this._log(LOG.ERROR, "Error at read of '" + filename + "' other than ENOENT " + err);
        }
      } else {
        afterOk(() => {
          this._whenDataReady((pasvconn) => {
            var readLength = 0;
            var now = new Date();
            var rs = this.fs.createReadStream(null, {fd: fd});
            rs.pause();
            rs.once('error', (err) => {
              this.emit('file:retr', 'close', {
                user: this.username,
                file: filename,
                filesize: 0,
                sTime: startTime,
                eTime: now,
                duration: now - startTime,
                errorState: true,
                error: err,
              });
            });

            rs.on('data', (buffer) => {
              readLength += buffer.length;
            });

            rs.on('end', () => {
              var now = new Date();
              this.emit('file:retr', 'close', {
                user: this.username,
                file: filename,
                filesize: 0,
                sTime: startTime,
                eTime: now,
                duration: now - startTime,
                errorState: false,
              });
              this.respond('226 Closing data connection, sent ' + readLength + ' bytes');
            });

            rs.pipe(pasvconn);
            rs.resume();
          });
        });
      }
    });
  }

  _retrieveUsingReadFile(commandArg, filename) {
    var startTime = new Date();

    this.emit('file:retr', 'open', {
      user: this.username,
      file: filename,
      sTime: startTime,
    });

    const afterOk = (callback) => {
      this.respond('150 Opening ' + this.mode.toUpperCase() + ' mode data connection', callback);
    };

    this.fs.readFile(filename, (err, contents) => {
      if (err) {
        this.emit('file:retr', 'error', {
          user: this.username,
          file: filename,
          filesize: 0,
          sTime: startTime,
          eTime: new Date(),
          duration: new Date() - startTime,
          errorState: true,
          error: err,
        });
        if (err.code === 'ENOENT') {
          this.respond('550 Not Found');
        } else { // Who knows what's going on here...
          this.respond('550 Not Accessible');
          this._log(LOG.ERROR, "Error at read of '" + filename + "' other than ENOENT " + err);
        }
      } else {
        afterOk(() => {
          this._whenDataReady((pasvconn) => {
            contents = {filename: filename, data: contents};
            this.emit('file:retr:contents', contents);
            contents = contents.data;
            pasvconn.write(contents);
            var contentLength = contents.length;
            this.respond('226 Closing data connection, sent ' + contentLength + ' bytes');
            this.emit('file:retr', 'close', {
              user: this.username,
              file: filename,
              filesize: contentLength,
              sTime: startTime,
              eTime: new Date(),
              duration: new Date() - startTime,
              errorState: false,
            });
            this._closeSocket(pasvconn);
          });
        });
      }
    });
  }

  // 'initialBuffers' argument is set when this is called from _storeUsingWriteFile.
  _storeUsingCreateWriteStream(filename, initialBuffers, flag) {
    var wStreamFlags = {flags: flag || 'w', mode: 0o644};
    var storeStream = this.fs.createWriteStream(pathModule.join(this.root, filename), wStreamFlags);
    var notErr = true;
    // Adding for event metadata for file upload (STOR)
    var startTime = new Date();
    var uploadSize = 0;

    if (initialBuffers) {
      //todo: handle back-pressure
      initialBuffers.forEach((b) => {
        storeStream.write(b);
      });
    }

    const handleUpload = (dataSocket) => {
      var isPaused = false;
      dataSocket.on('data', (buff) => {
        var result = storeStream.write(buff);
        // Handle back-pressure
        if (result === false) {
          dataSocket.pause();
          isPaused = true;
          storeStream.once('drain', () => {
            dataSocket.resume();
            isPaused = false;
          });
        }
      });
      dataSocket.once('error', () => {
        notErr = false;
        storeStream.end();
      });
      dataSocket.once('finish', () => {
        if (isPaused) {
          storeStream.once('drain', () => {
            storeStream.end();
          });
        } else {
          storeStream.end();
        }
      });
    };

    this._whenDataReady(handleUpload);

    storeStream.on('open', () => {
      this._log(LOG.DEBUG, 'File opened/created: ' + filename);
      this._log(LOG.DEBUG, 'Told client ok to send file data');
      // Adding event emitter for upload start time
      this.emit('file:stor', 'open', {
        user: this.username,
        file: filename,
        time: startTime,
      });

      this.respond('150 Ok to send data');
    });

    storeStream.on('error', () => {
      this.emit('file:stor', 'error', {
        user: this.username,
        file: filename,
        filesize: uploadSize,
        sTime: startTime,
        eTime: new Date(),
        duration: new Date() - startTime,
        errorState: !notErr,
      });
      storeStream.end();
      notErr = false;
      if (this.dataSocket) {
        this._closeSocket(this.dataSocket, true);
      }
      this.respond('426 Connection closed; transfer aborted');
    });

    storeStream.on('finish', () => {
      // Adding event emitter for completed upload.
      this.emit('file:stor', 'close', {
        user: this.username,
        file: filename,
        filesize: uploadSize,
        sTime: startTime,
        eTime: new Date(),
        duration: new Date() - startTime,
        errorState: !notErr,
      });
      notErr ? this.respond('226 Closing data connection') : true;
      if (this.dataSocket) {
        this._closeSocket(this.dataSocket);
      }
    });
  }

  _storeUsingWriteFile(filename, flag) {
    var erroredOut = false;
    var slurpBuf = new Buffer(1024); // TODO: Why is there a magic number here?
    var totalBytes = 0;
    var startTime = new Date();

    this.emit('file:stor', 'open', {
      user: this.username,
      file: filename,
      time: startTime,
    });

    const dataHandler = (buf) => {
      if (
        this.server.options.uploadMaxSlurpSize != null &&
        totalBytes + buf.length > this.server.options.uploadMaxSlurpSize
      ) {
        // Give up trying to slurp it -- it's too big.

        // If the 'fs' module we've been given doesn't implement 'createWriteStream', then
        // we give up and send the client an error.
        if (!this.fs.createWriteStream) {
          if (this.dataSocket) {
            this._closeSocket(this.dataSocket, true);
          }
          this.respond('552 Requested file action aborted; file too big');
          return;
        }

        // Otherwise, we call _STOR_usingWriteStream, and tell it to prepend the stuff
        // that we've buffered so far to the file.
        this._log(LOG.WARN, 'uploadMaxSlurpSize exceeded; falling back to createWriteStream');
        this._storeUsingCreateWriteStream(filename, [slurpBuf.slice(0, totalBytes), buf], flag);
        this.dataSocket.removeListener('data', dataHandler);
        this.dataSocket.removeListener('error', errorHandler);
        this.dataSocket.removeListener('close', closeHandler);
      } else {
        if (totalBytes + buf.length > slurpBuf.length) {
          var newLength = slurpBuf.length * 2;
          if (newLength < totalBytes + buf.length) {
            newLength = totalBytes + buf.length;
          }

          var newSlurpBuf = new Buffer(newLength);
          slurpBuf.copy(newSlurpBuf, 0, 0, totalBytes);
          slurpBuf = newSlurpBuf;
        }
        buf.copy(slurpBuf, totalBytes, 0, buf.length);
        totalBytes += buf.length;
      }
    };

    const closeHandler = () => {
      if (erroredOut) {
        return;
      }

      var wOptions = {flag: flag || 'w', mode: 0o644};
      var contents = {filename: filename, data: slurpBuf.slice(0, totalBytes)};
      this.emit('file:stor:contents', contents);
      this.fs.writeFile(pathModule.join(this.root, filename), contents.data, wOptions, (err) => {
        this.emit('file:stor', 'close', {
          user: this.username,
          file: filename,
          filesize: totalBytes,
          sTime: startTime,
          eTime: new Date(),
          duration: new Date() - startTime,
          errorState: err ? true : false,
        });
        if (err) {
          erroredOut = true;
          this._log(LOG.ERROR, 'Error writing file. ' + err);
          if (this.dataSocket) {
            this._closeSocket(this.dataSocket, true);
          }
          this.respond('426 Connection closed; transfer aborted');
          return;
        }

        this.respond('226 Closing data connection');
        if (this.dataSocket) {
          this._closeSocket(this.dataSocket);
        }
      });
    };

    const errorHandler = () => {
      erroredOut = true;
    };

    const handleUpload = () => {
      this.dataSocket.on('data', dataHandler);
      this.dataSocket.once('close', closeHandler);
      this.dataSocket.once('error', errorHandler);
    };

    this.respond('150 Ok to send data', () => {
      this._whenDataReady(handleUpload);
    });
  }

  _closeSocket(socket, shouldDestroy) {
    // TODO: Should we always use destroy() to avoid keeping sockets open longer
    // than necessary (and possibly exceeding OS max open sockets)?
    if (shouldDestroy || this.server.options.destroySockets) {
      // Don't call destroy() more than once.
      if (!socket.destroyed) {
        socket.destroy();
      }
    } else {
      // Don't call `end()` more than once.
      if (socket.writable) {
        socket.end();
      }
    }
  }

  // Specify the user's account (superfluous)
  __ACCT() {
    this.respond('202 Command not implemented, superfluous at this site.');
    return this;
  }

  // Allocate storage space (superfluous)
  __ALLO() {
    this.respond('202 Command not implemented, superfluous at this site.');
    return this;
  }

  __AUTH(commandArg) {
    let {tlsOptions} = this;
    if (!tlsOptions || commandArg !== 'TLS') {
      return this.respond('502 Command not implemented');
    }

    this.respond('234 Honored', () => {
      this._log(LOG.INFO, 'Establishing secure connection...');
      starttls.starttlsServer(this.socket, tlsOptions, (err, cleartext) => {
        const switchToSecure = () => {
          this._log(LOG.INFO, 'Secure connection started');
          this.socket = cleartext;
          this.socket.on('data', (data) => {
            this._onData(data);
          });
          this.secure = true;
        };
        if (err) {
          this._log(LOG.ERROR, 'Error upgrading connection to TLS: ' + util.inspect(err));
          this._closeSocket(this.socket, true);
        } else if (!cleartext.authorized) {
          this._log(LOG.INFO, 'Secure socket not authorized: ' + util.inspect(cleartext.authorizationError));
          if (this.server.options.allowUnauthorizedTls) {
            this._log(LOG.INFO, 'Allowing unauthorized connection (allowUnauthorizedTls is on)');
            switchToSecure();
          } else {
            this._log(LOG.INFO, 'Closing unauthorized connection (allowUnauthorizedTls is off)');
            this._closeSocket(this.socket, true);
          }
        } else {
          switchToSecure();
        }
      });
    });
  }

  // Change working directory to parent directory
  __CDUP() {
    var pathServer = pathModule.dirname(this.cwd);
    var pathEscaped = pathEscape(pathServer);
    this.cwd = pathServer;
    this.respond('250 Directory changed to "' + pathEscaped + '"');
    return this;
  }

  // Change working directory
  __CWD(pathRequest) {
    var pathServer = withCwd(this.cwd, pathRequest);
    var pathFs = pathModule.join(this.root, pathServer);
    var pathEscaped = pathEscape(pathServer);
    this.fs.stat(pathFs, (err, stats) => {
      if (err) {
        this._log(LOG.ERROR, 'CWD ' + pathRequest + ': ' + err);
        this.respond('550 Directory not found.');
      } else if (!stats.isDirectory()) {
        this._log(LOG.WARN, 'Attempt to CWD to non-directory');
        this.respond('550 Not a directory');
      } else {
        this.cwd = pathServer;
        this.respond('250 CWD successful. "' + pathEscaped + '" is current directory');
      }
    });
    return this;
  }

  __DELE(commandArg) {
    var filename = withCwd(this.cwd, commandArg);
    this.fs.unlink(pathModule.join(this.root, filename), (err) => {
      if (err) {
        this._log(LOG.ERROR, 'Error deleting file: ' + filename + ', ' + err);
        // write error to socket
        this.respond('550 Permission denied');
      } else {
        this.respond('250 File deleted');
      }
    });
  }

  // Get the feature list implemented by the server. (RFC 2389)
  __FEAT() {
    let features = ['SIZE', 'UTF8', 'MDTM'];
    if (this.tlsOptions) {
      features.push('AUTH TLS', 'PBSZ', 'PROT');
    }
    features = features.map((feature) => ' ' + feature + '\r\n');
    this.respond('211-Features\r\n' + features.join('') + '211 end');
  }

  __OPTS(commandArg) {
    // http://tools.ietf.org/html/rfc2389#section-4
    if (commandArg.toUpperCase() === 'UTF8 ON') {
      this.respond('200 OK');
    } else {
      this.respond('451 Not supported');
    }
  }

  // Print the file modification time
  __MDTM(file) {
    file = withCwd(this.cwd, file);
    file = pathModule.join(this.root, file);
    this.fs.stat(file, (err, stats) => {
      if (err) {
        this.respond('550 File unavailable');
      } else {
        this.respond('213 ' + dateformat(stats.mtime, 'yyyymmddhhMMss'));
      }
    });
    return this;
  }

  __LIST(commandArg, command) {
    let isDetailed = (command === 'LIST' || command === 'STAT');
    /*
     Normally the server responds with a mark using code 150. It then stops
     accepting new connections, attempts to send the contents of the directory
     over the data connection, and closes the data connection.
     Finally it:
      - accepts the LIST or NLST request with code 226 if the entire directory
        was successfully transmitted
      - rejects the LIST or NLST request with code 425 if no TCP connection was
        established
      - rejects the LIST or NLST request with code 426 if the TCP connection was
        established but then broken by the client or by network failure
      - rejects the LIST or NLST request with code 451 if the server had trouble
        reading the directory from disk

     The server may reject the LIST or NLST request (with code 450 or 550)
     without first responding with a mark. In this case the server does not
     touch the data connection.
     */

    // LIST may be passed options (-a in particular). We just ignore any of these.
    // (In the particular case of -a, we show hidden files anyway.)
    let dirname = stripOptions(commandArg);
    let dir = withCwd(this.cwd, dirname);

    // TODO: this is bad practice, use a class if options are required:
    // new Glob({maxConcurrency: 5}).glob()
    glob.setMaxStatsAtOnce(this.server.options.maxStatsAtOnce);
    glob.glob(
      pathModule.join(this.root, dir),
      this.fs,
      (err, files) => {
        if (err) {
          this._log(LOG.ERROR, 'Error sending file list, reading directory: ' + err);
          this.respond('550 Not a directory');
          return;
        }

        const handleFile = (ii) => {
          if (i >= files.length) {
            return i === files.length + j ? finished() : null;
          }
          this.server.getUsernameFromUid(files[ii].stats.uid, (e1, uname) => {
            this.server.getGroupFromGid(files[ii].stats.gid, (e2, gname) => {
              if (e1 || e2) {
                this._log(LOG.WARN, 'Error getting user/group name for file: ' + util.inspect(e1 || e2));
                fileInfos.push({
                  file: files[ii],
                  uname: null,
                  gname: null,
                });
              } else {
                fileInfos.push({
                  file: files[ii],
                  uname: uname,
                  gname: gname,
                });
              }
              handleFile(++i);
            });
          });
        };

        const finished = () => {
          // Sort file names.
          if (!this.server.options.dontSortFilenames) {
            if (this.server.options.filenameSortMap !== false) {
              var sm = (
                this.server.options.filenameSortMap ||
                ((x) => x.toUpperCase())
              );
              for (var i = 0; i < fileInfos.length; ++i) {
                fileInfos[i]._s = sm(isDetailed ? fileInfos[i].file.name : fileInfos[i].name);
              }
            }

            var sf = (this.server.options.filenameSortFunc ||
              ((x, y) => x.localeCompare(y))
            );
            fileInfos = fileInfos.sort((x, y) => {
              if (this.server.options.filenameSortMap !== false) {
                return sf(x._s, y._s);
              } else if (isDetailed) {
                return sf(x.file.name, y.file.name);
              } else {
                return sf(x.name, y.name);
              }
            });
          }

          this._listFiles(fileInfos, isDetailed, command);
        };

        if (this.server.options.hideDotFiles) {
          files = files.filter((file) => (
            (file.name && file.name[0] !== '.') ? true : false
          ));
        }

        this._log(LOG.INFO, 'Directory has ' + files.length + ' files');
        if (files.length === 0) {
          return this._listFiles([], isDetailed, command);
        }

        var fileInfos; // To contain list of files with info for each.

        if (!isDetailed) {
          // We're not doing a detailed listing, so we don't need to get username
          // and group name.
          fileInfos = files;
          return finished();
        }

        // Now we need to get username and group name for each file from user/group ids.
        fileInfos = [];

        var CONC = this.server.options.maxStatsAtOnce;
        var j = 0;
        for (var i = 0; i < files.length && i < CONC; ++i) {
          handleFile(i);
        }
        j = --i;

      },
      this.server.options.noWildcards
    );
  }

  __NLST(commandArg, command) {
    this.__LIST(commandArg, command);
  }

  __STAT(commandArg, command) {
    if (commandArg) {
      this.__LIST(commandArg, command);
    } else {
      this.respond('211 FTP Server Status OK');
    }
  }

  // Create a directory
  __MKD(pathRequest) {
    var pathServer = withCwd(this.cwd, pathRequest);
    var pathEscaped = pathEscape(pathServer);
    var pathFs = pathModule.join(this.root, pathServer);
    this.fs.mkdir(pathFs, 0o755, (err) => {
      if (err) {
        this._log(LOG.ERROR, 'MKD ' + pathRequest + ': ' + err);
        this.respond('550 "' + pathEscaped + '" directory NOT created');
      } else {
        this.respond('257 "' + pathEscaped + '" directory created');
      }
    });
    return this;
  }

  // Perform a no-op (used to keep-alive connection)
  __NOOP() {
    this.respond('200 OK');
    return this;
  }

  __PORT(commandArg) {
    if (this._hasReceivedPASV || this._hasReceivedPORT) {
      this.respond('503 Bad sequence of commands.');
      return;
    }
    this._hasReceivedPORT = true;
    let {host, port} = decodeAddress(commandArg) || {};
    if (host == null || port == null) {
      this.respond('501 Bad argument to PORT');
      return;
    }
    this.dataHost = host;
    this.dataPort = port;
    this._log(LOG.DEBUG, `self.dataHost, self.dataPort set to ${host}:${port}`);
    this.respond('200 OK');
  }

  __EPRT(commandArg, command) {
    this.__PORT(commandArg, command);
  }

  _getDataConnection() {
    const DATA_CONNECTION_STATE = {};
    class DataConnection {
      constructor(ftpConnection) {
        this.state = DATA_CONNECTION_STATE.NOT_READY;
        this.isActive = false;
        this.isPassive = false;
        this._ftpConnection = ftpConnection;
      }
      setActivePort(port) {
        this.isActive = true;
        this._activePort = port;
      }
    }
    return new DataConnection();
  }

  __PASV(commandArg, command) {
    if (this._hasReceivedPASV || this._hasReceivedPORT) {
      this.respond('503 Bad sequence of commands.');
      return;
    }
    this._hasReceivedPASV = true;
    let isExtendedPASV = (command === 'EPSV');
    this._log(LOG.DEBUG, 'Setting up listener for passive connections');
    this._isEstablishingDataConnection = true;
    // TODO: find a better way to get the address on which to bind listener.
    let host = this.server.host;
    this.passiveListenerPool.createDataConnection(
      host,
      {useTLS: this.secure},
      (error, dataConnection) => {
        if (error) {
          this._isEstablishingDataConnection = false;
          this._log(LOG.WARN, 'Error with passive data listener: ' + util.inspect(error));
          this.respond('421 Server was unable to open passive connection listener');
          return;
        }
        this.dataConnection = dataConnection;
        var port = dataConnection.port;
        this._log(LOG.DEBUG, `Listening for passive data connection on port ${port}`);
        // Now that we're successfully listening, tell the client.
        if (isExtendedPASV) {
          this.respond('229 Entering Extended Passive Mode (|||' + port + '|)');
        } else {
          this.respond(`227 Entering Passive Mode (${encodeAddress(host, port)})`);
        }
        dataConnection.on('error', (error) => {
          this._log(LOG.WARN, 'Error with passive data connection: ' + util.inspect(error));
          // TODO: handle error
        });
        dataConnection.on('ready', (socket) => {
          // TODO: reword
          this._log(LOG.INFO, 'Passive data event: connect');
          this._onDataConnection(socket);
        });
        dataConnection.on('close', () => {
          // TODO: reword.
          this._log(LOG.DEBUG, 'Passive data listener closed');
        });
      }
    );
  }

  __EPSV(commandArg, command) {
    if (commandArg && commandArg !== '1') {
      this.respond('202 Not supported');
    } else {
      this.__PASV(commandArg, command);
    }
  }

  __PBSZ(commandArg) {
    if (!this.tlsOptions) {
      return this.respond('202 Not supported');
    }

    // Protection Buffer Size (RFC 2228)
    if (!this.secure) {
      this.respond('503 Secure connection not established');
    } else if (parseInt(commandArg, 10) !== 0) {
      // RFC 2228 specifies that a 200 reply must be sent specifying a more
      // satisfactory PBSZ size (0 in our case, since we're using TLS).
      // Doubt that this will do any good if the client was already confused
      // enough to send a non-zero value, but ok...
      this.pbszReceived = true;
      this.respond('200 buffer too big, PBSZ=0');
    } else {
      this.pbszReceived = true;
      this.respond('200 OK');
    }
  }

  __PROT(commandArg) {
    if (!this.tlsOptions) {
      return this.respond('202 Not supported');
    }

    if (!this.pbszReceived) {
      this.respond('503 No PBSZ command received');
    } else if (commandArg === 'S' || commandArg === 'E' || commandArg === 'C') {
      this.respond('536 Not supported');
    } else if (commandArg === 'P') {
      this.respond('200 OK');
    } else {
      // Don't even recognize this one...
      this.respond('504 Not recognized');
    }
  }

  // Print the current working directory.
  __PWD(commandArg) {
    var pathEscaped = pathEscape(this.cwd);
    if (commandArg === '') {
      this.respond('257 "' + pathEscaped + '" is current directory');
    } else {
      this.respond('501 Syntax error in parameters or arguments.');
    }
    return this;
  }

  __QUIT() {
    this.hasQuit = true;
    this.respond('221 Goodbye', (err) => {
      if (err) {
        this._log(LOG.ERROR, "Error writing 'Goodbye' message following QUIT");
      }
      this._closeSocket(this.socket, true);
      this._closeDataConnections();
    });
  }

  __RETR(commandArg) {
    var filename = pathModule.join(this.root, withCwd(this.cwd, commandArg));

    if (this.server.options.useReadFile) {
      this._retrieveUsingReadFile(commandArg, filename);
    } else {
      this._retrieveUsingCreateReadStream(commandArg, filename);
    }
  }

  // Remove a directory
  __RMD(pathRequest) {
    var pathServer = withCwd(this.cwd, pathRequest);
    var pathFs = pathModule.join(this.root, pathServer);
    this.fs.rmdir(pathFs, (err) => {
      if (err) {
        this._log(LOG.ERROR, 'RMD ' + pathRequest + ': ' + err);
        this.respond('550 Delete operation failed');
      } else {
        this.respond('250 "' + pathServer + '" directory removed');
      }
    });
    return this;
  }

  __RNFR(commandArg) {
    this.filefrom = withCwd(this.cwd, commandArg);
    this._log(LOG.DEBUG, 'Rename from ' + this.filefrom);
    this.respond('350 Ready for destination name');
  }

  __RNTO(commandArg) {
    var fileto = withCwd(this.cwd, commandArg);
    this.fs.rename(pathModule.join(this.root, this.filefrom), pathModule.join(this.root, fileto), (err) => {
      if (err) {
        this._log(LOG.ERROR, 'Error renaming file from ' + this.filefrom + ' to ' + fileto);
        this.respond('550 Rename failed' + (err.code === 'ENOENT' ? '; file does not exist' : ''));
      } else {
        this.respond('250 File renamed successfully');
      }
    });
  }

  __SIZE(commandArg) {
    var filename = withCwd(this.cwd, commandArg);
    this.fs.stat(pathModule.join(this.root, filename), (err, s) => {
      if (err) {
        this._log(LOG.ERROR, "Error getting size of file '" + filename + "' ");
        this.respond('450 Failed to get size of file');
        return;
      }
      this.respond('213 ' + s.size + '');
    });
  }

  __TYPE(commandArg) {
    if (commandArg === 'I' || commandArg === 'A') {
      this.respond('200 OK');
    } else {
      this.respond('202 Not supported');
    }
  }

  __SYST() {
    this.respond('215 UNIX Type: I');
  }

  __STOR(commandArg) {
    var filename = withCwd(this.cwd, commandArg);

    if (this.server.options.useWriteFile) {
      this._storeUsingWriteFile(filename, 'w');
    } else {
      this._storeUsingCreateWriteStream(filename, null, 'w');
    }
  }

  __APPE(commandArg) {
    var filename = withCwd(this.cwd, commandArg);
    if (this.server.options.useWriteFile) {
      this._storeUsingWriteFile(filename, 'a');
    } else {
      this._storeUsingCreateWriteStream(filename, null, 'a');
    }
  }

  // Specify a username for login
  __USER(username) {
    if (this.server.options.tlsOnly && !this.secure) {
      this.respond(
        '530 This server does not permit login over a non-secure connection; ' +
        'connect using FTP-SSL with explicit AUTH TLS'
      );
    } else {
      this.emit(
        'command:user',
        username,
        // success callback
        () => {
          this.respond('331 User name okay, need password.');
          this.isWaitingForPassword = true;
        },
        // failure callback
        () => {
          this.respond('530 Not logged in.');
        }
      );
    }
    return this;
  }

  // Specify a password for login
  __PASS(password) {
    if (!this.isWaitingForPassword) {
      this.respond('503 Bad sequence of commands.');
    } else {
      this.isWaitingForPassword = false;
      this.emit(
        'command:pass',
        password,
        // success callback
        (username, userFsModule) => {
          const panic = (error, method) => {
            this._log(LOG.ERROR, method + ' signaled error ' + util.inspect(error));
            this.respond('421 Service not available, closing control connection.', () => {
              this._closeSocket(this.socket, true);
            });
          };
          const setCwd = (cwd) => {
            const setRoot = (root) => {
              this.root = root;
              this.respond('230 User logged in, proceed.');
            };

            this.cwd = cwd;
            if (this.server.getRoot.length <= 1) {
              setRoot(this.server.getRoot(this));
            } else {
              this.server.getRoot(this, (err, root) => {
                if (err) {
                  panic(err, 'getRoot');
                } else {
                  setRoot(root);
                }
              });
            }
          };
          this.username = username;
          this.fs = userFsModule || fsModule;
          if (this.server.getInitialCwd.length <= 1) {
            setCwd(withCwd(this.server.getInitialCwd(this)));
          } else {
            this.server.getInitialCwd(this, (err, cwd) => {
              if (err) {
                panic(err, 'getInitialCwd');
              } else {
                setCwd(withCwd(cwd));
              }
            });
          }
        },
        // failure callback
        () => {
          this.respond('530 Not logged in.');
          this.username = null;
        }
      );
    }
    return this;
  }
}

export default FtpConnection;