// Strict ES5. Exercise the authenticated upgrade boundary and byte tunnel.
var assert = require('assert');
var http = require('http');
var net = require('net');
var events = require('events');
var routes = require('../server/lib/routes');

var config = { token: 'test-token', allowControl: true, remoteDesktop: { enabled: true, password: 'vnc-secret' } };
var starts = 0;
routes.init({ config: config, luna: function (uri, payload, cb) {
  assert.strictEqual(uri, 'org.webosbrew.vncserver.service/start');
  starts++;
  cb({ returnValue: true });
} });
function request() {
  var req = new events.EventEmitter();
  var fields = {
    method: 'GET', url: '/api/remote-desktop/socket?k=test-token',
    connection: { remoteAddress: '192.0.2.3' },
    headers: { host: '192.0.2.1:8080', origin: 'http://192.0.2.1:8080',
      upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-protocol': 'binary' }
  };
  Object.keys(fields).forEach(function (key) { req[key] = fields[key]; });
  return req;
}
function refused(change, code) {
  var req = request();
  change(req);
  var reply = '';
  routes.handleUpgrade(req, { end: function (data) { reply = data; } }, new Buffer(0));
  assert.ok(reply.indexOf('HTTP/1.1 ' + code + ' ') === 0, reply);
}
refused(function (r) { r.url = '/api/remote-desktop/socket'; }, 401);
refused(function (r) { r.url += '-wrong'; }, 401);
refused(function (r) { r.url = '/other'; }, 404);
refused(function (r) { r.headers.origin = 'http://evil.example'; }, 403);
refused(function (r) { delete r.headers.origin; }, 403);
refused(function (r) { r.headers.host = 'evil.example'; r.headers.origin = 'http://evil.example'; }, 403);
refused(function (r) { r.headers['sec-websocket-key'] = 'bad'; }, 400);
refused(function (r) { r.headers['sec-websocket-protocol'] = 'base64'; }, 400);
config.allowControl = false;
refused(function () {}, 403);
config.allowControl = true;
config.remoteDesktop.enabled = false;
refused(function () {}, 403);
config.remoteDesktop.enabled = true;

function apiReply(req) {
  var status, body;
  routes.handleRequest(req, {
    writeHead: function (code) { status = code; },
    end: function (text) { body = JSON.parse(text); }
  });
  if (req.method === 'POST' && status === undefined) {
    req.emit('data', '{}');
    req.emit('end');
  }
  return { status: status, body: body };
}
var req = request(); req.url = '/api/remote-desktop';
assert.strictEqual(apiReply(req).status, 401, 'VNC password requires dashboard authentication');
req.url += '?k=test-token';
assert.strictEqual(apiReply(req).body.password, 'vnc-secret');
config.allowControl = false;
assert.strictEqual(apiReply(req).status, 403);
config.allowControl = true;
req.method = 'POST';
req.headers['content-type'] = 'application/json';
req.headers.origin = 'http://evil.example';
assert.strictEqual(apiReply(req).status, 403);
assert.strictEqual(starts, 0, 'cross-origin requests must not start VNC');
req.headers.origin = 'http://192.0.2.1:8080';
assert.strictEqual(apiReply(req).body.returnValue, true);
assert.strictEqual(starts, 1);
console.log('  VNC upgrade rejects missing tokens, cross-origin requests, disabled control and bad handshakes');

var originalRequest = http.request;
var peers = [];
var upstream = http.createServer();
var frontend = http.createServer();
var timeout = setTimeout(function () { throw new Error('VNC tunnel test timed out'); }, 5000);
upstream.on('upgrade', function (incoming, socket, head) {
  peers.push(socket);
  assert.strictEqual(incoming.url, '/websockify');
  assert.strictEqual(incoming.headers.authorization, undefined);
  assert.strictEqual(incoming.headers.origin, 'http://127.0.0.1');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: test-accept\r\nSec-WebSocket-Protocol: binary\r\n\r\nRFB-test');
  if (head.length) socket.write(head);
  socket.on('data', function (data) { socket.write(data); });
});
upstream.listen(0, '127.0.0.1', function () {
  http.request = function (opts) {
    assert.strictEqual(opts.hostname, '127.0.0.1');
    assert.strictEqual(opts.port, 5900, 'the client cannot select a target');
    opts.port = upstream.address().port;
    return originalRequest(opts);
  };
  frontend.on('upgrade', routes.handleUpgrade);
  frontend.listen(0, '127.0.0.1', function () {
    var client = net.connect(frontend.address().port, '127.0.0.1');
    var received = '';
    client.on('connect', function () {
      client.write('GET /api/remote-desktop/socket?k=test-token HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nOrigin: http://127.0.0.1:8080\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n\r\nclient-head');
    });
    client.on('data', function (data) {
      received += data.toString();
      if (received.indexOf('RFB-test') !== -1 && received.indexOf('client-head') !== -1) {
        assert.ok(received.indexOf('HTTP/1.1 101 ') === 0);
        client.destroy();
        peers.forEach(function (peer) { peer.destroy(); });
        frontend.close(); upstream.close();
        http.request = originalRequest;
        clearTimeout(timeout);
        console.log('  VNC tunnel forwards the handshake and bytes in both directions, including upgrade head buffers');
      }
    });
  });
});
