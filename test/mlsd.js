var common = require('./lib/common');

describe('MLSD command', function() {
  'use strict';

  var client;
  var server;

  beforeEach(function(done) {
    server = common.server();
    client = common.client(done);
  });

  it('should return "Type=" as first characters on all lines', function(done) {
    client.getPasvSocket(function(err, socket) {
      if (err) {
        throw err;
      }

      var listing = '';

      socket.setEncoding('utf8');
      socket.on('data', function(data) {
        listing += data;
      });

      client.pasvTimeout(socket);

      socket.once('close', function(err) {
        if (err) {
          throw err;
        }

        listing = listing.split('\r\n');
        for (var i = 0; i < listing.length; i++) {
          if (listing[i].length > 0) {
            listing[i].should.match(/^(\w+=\w+;)+ .+$/);
            listing[i].should.match(/Type=\w+;/);
            listing[i].should.match(/Modify=\w+;/);
            //listing[i].should.match(/Perm=\w+;/);
          }
        }

        done();
      });

      client.execute('MLSD');
    });
  });

  afterEach(function() {
    server.close();
  });
});
