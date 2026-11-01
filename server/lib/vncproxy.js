// Strict ES5: the TV's LibVNCServer already implements WebSocket framing.
var http = require('http');
var sessions = 0;

function refuse(socket, code) {
  socket.end('HTTP/1.1 ' + code + ' Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

function proxy(req, socket, head) {
  if (sessions >= 4) return refuse(socket, 503);
  sessions++;
  var upstream = null;
  var finished = false;
  var pending = http.request({
    hostname: '127.0.0.1', port: 5900, path: '/websockify', method: 'GET',
    headers: {
      Host: '127.0.0.1:5900', Origin: 'http://127.0.0.1', Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': req.headers['sec-websocket-key'],
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'binary'
    }
  });
  var timer = setTimeout(function () { refuse(socket, 504); cleanup(); }, 8000);
  function cleanup() {
    if (finished) return;
    finished = true;
    sessions--;
    clearTimeout(timer);
    pending.abort();
    if (upstream) upstream.destroy();
  }
  socket.on('error', cleanup);
  socket.on('close', cleanup);
  pending.on('error', function () {
    if (!finished) refuse(socket, 502);
    cleanup();
  });
  pending.on('response', function (res) {
    res.resume();
    refuse(socket, 502);
    cleanup();
  });
  pending.on('upgrade', function (res, peer, peerHead) {
    if (finished) return peer.destroy();
    upstream = peer;
    clearTimeout(timer);
    // No dashboard token, arbitrary URL or client headers reach VNC.
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + res.headers['sec-websocket-accept'] + '\r\n' +
      'Sec-WebSocket-Protocol: binary\r\n\r\n');
    socket.setTimeout(0);
    socket.setNoDelay(true);
    peer.setNoDelay(true);
    peer.on('error', function () { socket.destroy(); cleanup(); });
    peer.on('close', function () { socket.destroy(); cleanup(); });
    if (peerHead && peerHead.length) socket.write(peerHead);
    if (head && head.length) peer.write(head);
    socket.pipe(peer);
    peer.pipe(socket);
  });
  pending.end();
}

module.exports = { proxy: proxy, refuse: refuse };
