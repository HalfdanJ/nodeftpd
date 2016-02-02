/* @//flow */

import net from 'net';
import {EventEmitter} from 'events';

import starttls from './starttls';

const DEFAULT_OPTIONS = {
  BIND_ADDRESS: '0.0.0.0',
  MIN_PORT: 44001,
  MAX_PORT: 44010,
};

// Maximum time we will wait for client to connect after PASV command.
const WAIT_TIMEOUT = 9000;

export const CONNECTION_STATE = {
  WAITING: 0,          // Listener is waiting for client to connect (initial state).
  INITIALIZING_TLS: 1, // Client is connected but we are negotiating TLS.
  READY: 2,            // Client is connected and socket is ready.
  CLOSED: 3,           // Connection is closed (error or normal connection end).
};

export const LISTENER_STATE = {
  INITIALIZING: 0, // Initial state.
  LISTENING: 1,    // Listener is waiting for client to connect.
  CLOSED: 2,       // Listener has stopped listening (connections may still exist).
};

// For use constructing an error using `new Error()`
let listenError = (errorCode, address, port) => ({
  message: `listen ${errorCode} ${address}:${port}`,
  props: {code: errorCode, address, port},
});

export class PassiveDataConnection extends EventEmitter {
  constructor(port, remoteAddress, options) {
    super();
    // It's important to store the listening port here so the control connection
    // can send: 227 Entering Passive Mode (<IP_INFO>,<PORT_INFO>)
    this.port = port;
    this.remoteAddress = remoteAddress;
    this.state = CONNECTION_STATE.WAITING;
    this._useTLS = options.useTLS;
    this._socket = null;
    this._timer = setTimeout(() => {
      this._onError(
        new Error(`Expected a connection within ${WAIT_TIMEOUT}ms`)
      );
    }, WAIT_TIMEOUT);
    // Auto-bind methods.
    this._onError = this._onError.bind(this);
    this._close = this._close.bind(this);
  }

  getSocket() {
    return this._socket;
  }

  // This is not really a public method, except for use from the code that
  // created this instance (Listener).
  setSocket(socket) {
    if (this._socket) {
      throw new Error('PassiveDataConnection: method setSocket() called more than once.');
    }
    clearTimeout(this._timer);
    if (!this._useTLS) {
      this._socket = socket;
      this.state = CONNECTION_STATE.READY;
      socket.on('error', this._onError);
      socket.on('close', this._close);
      this.emit('ready', socket);
      return;
    }
    this.state = CONNECTION_STATE.INITIALIZING_TLS;
    this._upgradeConnection(socket, (error, cleartext) => {
      this._socket = cleartext;
      this.state = CONNECTION_STATE.READY;
      cleartext.on('error', this._onError);
      cleartext.on('close', this._close);
      this.emit('ready', cleartext);
    });
  }

  _upgradeConnection(rawSocket, callback) {
    // this._log(LOG.INFO, 'Upgrading passive connection to TLS');
    let {tlsOptions} = this.options;
    starttls.starttlsServer(rawSocket, tlsOptions, (error, cleartext) => {
      if (error) {
        // this._log(LOG.ERROR, 'Error upgrading passive connection to TLS:' + util.inspect(error));
        this._closeSocket(rawSocket, true);
        callback(error);
        return;
      }

      if (cleartext.authorized || this.options.allowUnauthorizedTls) {
        // this._log(LOG.INFO, 'Allowing unauthorized connection (allowUnauthorizedTls is on)');
        // this._log(LOG.INFO, 'Passive connection secured');
        callback(null, cleartext);
      } else {
        // this._log(LOG.INFO, 'Closing unauthorized connection (allowUnauthorizedTls is off)');
        this._closeSocket(rawSocket, true);
      }
    });
  }

  destroy() {
    if (this._socket) {
      this._socket.destroy(); // Will automatically emit `close`;
    } else {
      this._close();
    }
  }

  _onError(error) {
    this.emit('error', error);
    process.nextTick(this._close);
  }

  _close() {
    if (this.state === CONNECTION_STATE.CLOSED) {
      return;
    }
    this.state = CONNECTION_STATE.CLOSED;
    this.emit('close');
  }
}

export class Listener extends EventEmitter {
  constructor(port, bindAddress) {
    super();
    this.port = port;
    this.bindAddress = bindAddress;
    this.state = LISTENER_STATE.CLOSED;
    this._waitingConnections = new Map();
    this._allConnections = new Set();
    // Auto-bind methods.
    this._onStartingError = this._onStartingError.bind(this);
    this._onRunningError = this._onRunningError.bind(this);
    this._onReady = this._onReady.bind(this);
    this._onConnection = this._onConnection.bind(this);
  }

  listenForClient(remoteAddress, options) {
    let {bindAddress, port} = this;
    let key = port + '|' + remoteAddress;
    let connection = new PassiveDataConnection(port, remoteAddress, options);
    if (this._waitingConnections.has(key)) {
      // We cannot simultaneously have more than one waitingConnection for the
      // same remote address or it would create ambiguity (we wouldn't know
      // which instance to associate the incoming connection with). Treat this
      // as an EADDRINUSE error to force the calling function to try another
      // port.
      process.nextTick(() => {
        let {message, props} = listenError('EADDRINUSE', bindAddress, port);
        connection.emit(
          'listenerError',
          Object.assign(new Error(message), props)
        );
      });
      return connection;
    }
    this._allConnections.add(connection);
    this._waitingConnections.set(key, connection);
    // `close` will be emitted when:
    //  * Client doesn't connect within wait time.
    //  * Client connects and transfer is completed successfully.
    //  * Client connects and some error occurs.
    // but it will *not* be emitted when:
    //  * Listener fails to bind to bindAddress.
    connection.on('close', () => {
      this._allConnections.delete(connection);
      this._waitingConnections.delete(key);
      this._stopIfDone();
    });
    // If we're already listening, emit listenerReady on next tick.
    // If we're not yet listening, start the listening server now.
    // If we're in the process of starting the listening server (INITIALIZING)
    // then do nothing since we will emit listenerReady when necessary.
    if (this.state === LISTENER_STATE.LISTENING) {
      process.nextTick(() => connection.emit('listenerReady'));
    } else if (this.state === LISTENER_STATE.CLOSED) {
      this._startServer();
    }
    return connection;
  }

  _onStartingError(error) {
    for (let [key, connection] of this._waitingConnections.entries()) {
      connection.emit('listenerError', error);
      this._waitingConnections.delete(key);
    }
    this.state = LISTENER_STATE.CLOSED;
  }

  _onRunningError(error) {
    this._stopServer();
    this.state = LISTENER_STATE.CLOSED;
    this.emit('error', error);
  }

  _onReady(...args) {
    this._server.removeListener('error', this._onStartingError);
    this._server.on('error', this._onRunningError);

    this.state = LISTENER_STATE.LISTENING;
    this.emit('listening', ...args);
    for (let connection of this._waitingConnections.values()) {
      connection.emit('listenerReady');
    }
  }

  _onConnection(socket) {
    let remoteAddress = socket.address().address;
    if (remoteAddress.indexOf(':') !== -1) {
      remoteAddress = remoteAddress.split(':').pop();
    }
    let key = this.port + '|' + remoteAddress;
    let connection = this._waitingConnections.get(key);
    if (connection == null) {
      socket.destroy();
      return;
    }
    this._waitingConnections.delete(key);
    connection.setSocket(socket);
  }

  _stopIfDone() {
    if (this._waitingConnections.size !== 0) {
      return;
    }
    this._stop();
  }

  // It's safe to call _stop() multiple times.
  _stop() {
    if (this._stopping) {
      return;
    }
    if (this.state === LISTENER_STATE.INITIALIZING) {
      this._stopping = true;
      this.on('listening', () => {
        this._stopping = false;
        this._stop();
      });
      return;
    }
    if (this.state === LISTENER_STATE.LISTENING) {
      this._stopServer();
    }
    this.state = LISTENER_STATE.CLOSED;
  }

  _startServer() {
    this._server = net.createServer();
    this._server.on('error', this._onStartingError);
    this._server.on('listening', this._onReady);
    this._server.on('connection', this._onConnection);
    this._server.listen(this.port, this.bindAddress);
    this.state = LISTENER_STATE.INITIALIZING;
  }

  _stopServer() {
    this._server.removeListener('error', this._onStartingError);
    this._server.removeListener('error', this._onRunningError);
    this._server.removeListener('listening', this._onReady);
    this._server.removeListener('connection', this._onConnection);
    this._server.close();
    this._server = null;
  }
}

export default class PassiveListenerPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this._bindAddress = options.bindAddress || DEFAULT_OPTIONS.BIND_ADDRESS;
    let portRange = options.portRange || [];
    this._minPort = portRange[0] || DEFAULT_OPTIONS.MIN_PORT;
    this._maxPort = portRange[1] || DEFAULT_OPTIONS.MAX_PORT;
    this._listeners = new Map();
  }

  createDataConnection(remoteAddress, options, callback) {
    let port = this._minPort;
    let dataConnection;
    let onError = (error) => {
      if (error.code === 'EADDRINUSE' && port < this._maxPort) {
        port += 1;
        startListener();
      } else {
        callback(error);
      }
    };
    let onSuccess = () => {
      dataConnection.removeListener('listenerError', onError);
      dataConnection.removeListener('listenerReady', onSuccess);
      callback(null, dataConnection);
    };
    let startListener = () => {
      let listener = this._listeners.get(port);
      if (listener == null) {
        listener = new Listener(port, this._bindAddress);
        this._listeners.set(port, listener);
      }
      dataConnection = listener.listenForClient(remoteAddress, options);
      dataConnection.on('listenerError', onError);
      dataConnection.on('listenerReady', onSuccess);
    };
    startListener();
  }
}
