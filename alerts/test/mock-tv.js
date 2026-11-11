'use strict';

// Minimal SSAP WebSocket TV for tests. Hand-written frame codec on purpose:
// the whole service has zero dependencies, so the tests must not need one
// either. Adapted from tools/logger-server.js.

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_MESSAGE = 4 * 1024 * 1024;

function frame(opcode, payload) {
  const len = payload.length;
  let header;
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

class MockTv {
  constructor(options) {
    const opts = options || {};
    this.clientKey = opts.clientKey || 'mock-client-key';
    this.appId = opts.appId || 'com.webos.app.livetv';
    this.registrations = [];
    this.requests = [];
    this.toasts = [];
    this.alerts = [];
    this.sockets = new Set();
    this.server = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('WebSocket only\n');
    });
    this.server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
  }

  start() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.server.once('error', onError);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        this.port = this.server.address().port;
        this.url = 'ws://127.0.0.1:' + this.port;
        resolve(this);
      });
    });
  }

  close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  _upgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
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
    this.sockets.add(socket);

    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    let parts = [];

    const send = (obj) => {
      if (socket.destroyed) return;
      socket.write(frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')));
    };

    const onMessage = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        return;
      }
      if (msg.type === 'register') {
        this.registrations.push(msg.payload);
        send({
          type: 'registered',
          id: msg.id,
          payload: { returnValue: true, 'client-key': this.clientKey }
        });
        return;
      }
      if (msg.type === 'request') {
        this.requests.push(msg);
        if (msg.uri === 'ssap://system.notifications/createAlert') {
          this.alerts.push(msg.payload || {});
          send({ type: 'response', id: msg.id, payload: { returnValue: true } });
        } else if (msg.uri === 'ssap://system.notifications/createToast') {
          this.toasts.push(msg.payload || {});
          send({ type: 'response', id: msg.id, payload: { returnValue: true } });
        } else if (msg.uri === 'ssap://com.webos.applicationManager/getForegroundAppInfo') {
          send({
            type: 'response',
            id: msg.id,
            payload: { returnValue: true, appId: this.appId }
          });
        } else {
          send({ type: 'error', id: msg.id, error: 'unhandled uri in test TV' });
        }
      }
    };

    const pump = () => {
      while (true) {
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;

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

        if (len > MAX_MESSAGE) { socket.destroy(); return; }

        let mask = null;
        if (masked) {
          if (buf.length < off + 4) return;
          mask = buf.subarray(off, off + 4);
          off += 4;
        }
        if (buf.length < off + len) return;

        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) {
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.subarray(off + len);

        if (opcode === 0x8) {
          socket.end(frame(0x8, Buffer.alloc(0)));
          return;
        } else if (opcode === 0x9) {
          socket.write(frame(0xA, payload));
        } else if (opcode === 0xA) {
          // pong
        } else if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            onMessage(payload.toString('utf8'));
            parts = [];
          } else {
            parts = [payload];
          }
        } else if (opcode === 0x0) {
          parts.push(payload);
          if (fin) {
            onMessage(Buffer.concat(parts).toString('utf8'));
            parts = [];
          }
        }
      }
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      pump();
    });
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));

    pump();
  }
}

module.exports = { MockTv };
