#!/usr/bin/env node
// Laptop-side log sink for the webOS webcam app.
//
// The app phone-homes its console output over a WebSocket as
//   {t: Date.now(), level: 'log'|'warn'|'error', msg: '...'}
// Start this BEFORE launching the app, then put this machine's LAN IP into
// the app's LOGGER_HOST.
//
//   node tools/logger-server.js          (port 8765)
//   PORT=8766 node tools/logger-server.js
//
// Zero dependencies on purpose: raw Node http + a hand-rolled WebSocket
// server, so it runs standalone with no package.json / npm install.
'use strict';

var http = require('http');
var crypto = require('crypto');
var os = require('os');

var PORT = Number(process.env.PORT || process.env.LOGGER_PORT || 8765);
if (!(PORT > 0 && PORT < 65536 && Math.floor(PORT) === PORT)) {
  console.error('Invalid PORT: ' + process.env.PORT);
  process.exit(1);
}

var COLOR = process.stdout.isTTY;
var COLORS = {
  log: COLOR ? '' : '',
  warn: COLOR ? '\x1b[33m' : '',
  error: COLOR ? '\x1b[31m' : ''
};
var RESET = COLOR ? '\x1b[0m' : '';
var TAGS = { log: 'LOG  ', warn: 'WARN ', error: 'ERROR' };
var MAX_MESSAGE = 1024 * 1024; // 1 MB per frame is plenty for a log line

function print(level, msg, ts) {
  level = (level === 'warn' || level === 'error') ? level : 'log';
  var d = new Date(typeof ts === 'number' && isFinite(ts) ? ts : Date.now());
  var line = '[' + d.toTimeString().slice(0, 8) + '] ' + TAGS[level] + ' ' + msg;
  console.log(COLORS[level] + line + RESET);
}

// Accept {t, level, msg} from the app; fall back to plain strings / other JSON.
function emit(raw) {
  var data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    print('log', raw);
    return;
  }
  if (data === null || typeof data !== 'object') {
    print('log', String(data));
    return;
  }
  var msg = data.msg;
  if (msg === undefined) msg = data.message;
  if (msg === undefined) msg = JSON.stringify(data);
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  print(data.level, msg, data.t);
}

function frame(opcode, payload) {
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function acceptKey(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function lanIps() {
  var found = [];
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (addr) {
      if (addr.family === 'IPv4' && !addr.internal) {
        found.push({ name: name, address: addr.address });
      }
    });
  });
  return found;
}

var server = http.createServer(function (req, res) {
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('WebSocket log endpoint. Point the app at ws://<laptop-ip>:' + PORT + '\n');
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use. Stop the other process or use PORT=8766.');
  } else {
    console.error('Logger server error: ' + err.message);
  }
  process.exit(1);
});

server.on('upgrade', function (req, socket, head) {
  var key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  var peer = String(req.socket.remoteAddress || '?').replace(/^::ffff:/, '') +
    ':' + req.socket.remotePort;
  print('log', '--- app connected from ' + peer + ' ---');

  var buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  var parts = [];

  function pump() {
    while (true) {
      if (buf.length < 2) return;
      var b0 = buf[0];
      var b1 = buf[1];
      var fin = (b0 & 0x80) !== 0;
      var opcode = b0 & 0x0f;
      var masked = (b1 & 0x80) !== 0;
      var len = b1 & 0x7f;
      var off = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) { socket.destroy(); return; }
        len = buf.readUInt32BE(6);
        off = 10;
      }

      if (len > MAX_MESSAGE) {
        print('warn', 'message of ' + len + ' bytes rejected; dropping client');
        socket.end(frame(0x8, Buffer.alloc(0)));
        return;
      }

      var mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.slice(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;

      var payload = Buffer.from(buf.slice(off, off + len));
      if (mask) {
        for (var i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buf = buf.slice(off + len);

      if (opcode === 0x8) {           // close
        socket.end(frame(0x8, Buffer.alloc(0)));
        return;
      } else if (opcode === 0x9) {    // ping -> pong
        socket.write(frame(0xA, payload));
      } else if (opcode === 0xA) {    // pong, ignore
        // no-op
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          emit(payload.toString('utf8'));
          parts = [];
        } else {
          parts = [payload];
        }
      } else if (opcode === 0x0) {    // continuation
        parts.push(payload);
        if (fin) {
          emit(Buffer.concat(parts).toString('utf8'));
          parts = [];
        }
      }
    }
  }

  socket.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  // A dropped TV must never take the server down.
  socket.on('error', function () {});
  socket.on('close', function () {
    print('log', '--- app disconnected (' + peer + ') ---');
  });

  pump();
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('');
  console.log('webcam logger — listening on 0.0.0.0:' + PORT);
  var ips = lanIps();
  if (ips.length) {
    console.log('LOGGER_HOST candidates (put one in the app):');
    ips.forEach(function (ip) {
      console.log('  ' + ip.address + '  (' + ip.name + ')');
    });
  } else {
    console.log('No LAN IPv4 address found — is this machine on the network?');
  }
  console.log('Waiting for the app to connect. Ctrl-C to stop.');
  console.log('');
});
