'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Unsigned manifest on purpose: current LG firmware rejects the widely shared
// signed certificate ("blacklisted certificate detected"). Copied from the
// proven Lumen app (../lg-webos/app/js/app.js).
const PERMISSIONS = [
  'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED',
  'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK',
  'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV',
  'CONTROL_POWER', 'CONTROL_TV_SCREEN', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL',
  'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE', 'READ_RUNNING_APPS',
  'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE',
  'READ_COUNTRY_INFO', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD',
  'READ_INSTALLED_APPS', 'READ_SETTINGS', 'READ_STORAGE_DEVICE_LIST'
];

const MANIFEST = {
  manifestVersion: 1,
  appVersion: '1.1',
  permissions: PERMISSIONS
};

const TOAST_URI = 'ssap://system.notifications/createToast';
const ALERT_URI = 'ssap://system.notifications/createAlert';
const FOREGROUND_URI = 'ssap://com.webos.applicationManager/getForegroundAppInfo';
const MAX_MESSAGE = 60;

function trimMessage(message) {
  const value = String(message);
  const chars = Array.from(value);
  if (chars.length <= MAX_MESSAGE) return value;
  return chars.slice(0, MAX_MESSAGE - 1).join('') + '…';
}

class Session {
  constructor(ws, client) {
    this.ws = ws;
    this.client = client;
    this.pending = new Map();
    this.seq = 0;
    this.registration = null;

    ws.addEventListener('message', (event) => this.handleMessage(event));
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', () => {
      this.fail(new Error('TV connection closed'));
    });
  }

  open(timeoutMs) {
    if (this.ws.readyState === 1) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('error', onError);
        this.ws.removeEventListener('close', onClose);
        if (err) reject(err);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = () => finish(new Error('TV unreachable'));
      const onClose = () => finish(new Error('TV closed the connection'));
      const timer = setTimeout(() => {
        try { this.ws.close(); } catch (err) { /* already closing */ }
        finish(new Error('TV connection timed out'));
      }, timeoutMs);

      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onError);
      this.ws.addEventListener('close', onClose);
    });
  }

  register(clientKey) {
    const timeoutMs = clientKey
      ? this.client.registerTimeoutMs
      : this.client.pairingTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.registration) {
          this.registration = null;
          reject(new Error('TV registration timed out'));
        }
      }, timeoutMs);

      this.registration = {
        resolve: () => {
          clearTimeout(timer);
          this.registration = null;
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          this.registration = null;
          reject(err);
        }
      };

      const payload = {
        forcePairing: false,
        pairingType: 'PROMPT',
        manifest: MANIFEST
      };
      if (clientKey) payload['client-key'] = clientKey;

      try {
        this.send({ type: 'register', id: 'register_1', payload });
      } catch (err) {
        this.registration.reject(err);
      }
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  handleMessage(event) {
    let message;
    try {
      const raw = typeof event.data === 'string'
        ? event.data
        : Buffer.from(event.data).toString('utf8');
      message = JSON.parse(raw);
    } catch (err) {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'registered') {
      if (message.payload && message.payload['client-key']) {
        this.client.saveClientKey(message.payload['client-key']);
      }
      if (this.registration) this.registration.resolve();
      return;
    }

    if (message.type === 'error' && message.id === 'register_1' && this.registration) {
      this.registration.reject(new Error(message.error || 'TV refused registration'));
      return;
    }

    if (message.type !== 'response' && message.type !== 'error') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === 'error') {
      pending.reject(new Error(message.error || 'SSAP request failed'));
    } else {
      pending.resolve(message.payload || {});
    }
  }

  request(uri, payload, timeoutMs) {
    if (this.ws.readyState !== 1) {
      return Promise.reject(new Error('TV connection closed'));
    }

    const id = 'req_' + (++this.seq);
    const wait = timeoutMs || this.client.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('SSAP request timed out'));
      }, wait);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.send({ type: 'request', id, uri, payload: payload || {} });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async toast(message, pngBuffer, params) {
    const payload = { message: trimMessage(message) };
    if (pngBuffer && pngBuffer.length) {
      payload.iconData = pngBuffer.toString('base64');
      payload.iconExtension = 'png';
    }
    payload.onClick = {
      appId: this.client.appId,
      params: params || {}
    };
    const response = await this.request(TOAST_URI, payload);
    if (response && response.returnValue === false) {
      throw new Error(response.errorText || 'TV refused the toast');
    }
    return response;
  }

  // Popup over whatever is on screen, with "Open live view" (launches our app with params)
  // and "Dismiss". Verified on the OLED65C8, webOS 4.4.3, 11 Nov 2026.
  async alert(message, params) {
    const response = await this.request(ALERT_URI, {
      message: trimMessage(message),
      buttons: [
        { label: 'Open live view', onclick: 'luna://com.webos.applicationManager/launch',
          params: { id: this.client.appId, params: params || {} } },
        { label: 'Dismiss' }
      ]
    });
    if (response && response.returnValue === false) {
      throw new Error(response.errorText || 'TV refused the alert');
    }
    return response;
  }

  async foregroundAppId() {
    const payload = await this.request(FOREGROUND_URI, {});
    if (payload && payload.appId) return payload.appId;
    if (payload && payload.foregroundAppInfo && payload.foregroundAppInfo.appId) {
      return payload.foregroundAppInfo.appId;
    }
    return null;
  }

  fail(err) {
    if (this.registration) this.registration.reject(err);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  close() {
    try { this.ws.close(); } catch (err) { /* already closed */ }
  }
}

class TvClient {
  constructor(options) {
    const opts = options || {};
    if (!opts.host) throw new Error('tv.host is required');

    this.host = opts.host;
    this.port = opts.port || 3000;
    this.appId = opts.appId || '';
    this.clientKeyPath = opts.clientKeyPath || null;
    this.connectTimeoutMs = opts.connectTimeoutMs || 3000;
    this.registerTimeoutMs = opts.registerTimeoutMs || 3000;
    this.pairingTimeoutMs = opts.pairingTimeoutMs || 75000;
    this.requestTimeoutMs = opts.requestTimeoutMs || 3000;
    this.logger = opts.logger || console;
  }

  url() {
    if (/^wss?:\/\//.test(this.host)) return this.host;
    return 'ws://' + this.host + ':' + this.port;
  }

  readClientKey() {
    if (!this.clientKeyPath) return null;
    try {
      const key = fs.readFileSync(this.clientKeyPath, 'utf8').trim();
      return key || null;
    } catch (err) {
      return null;
    }
  }

  saveClientKey(key) {
    if (!this.clientKeyPath || !key) return;
    try {
      fs.mkdirSync(path.dirname(this.clientKeyPath), { recursive: true });
      fs.writeFileSync(this.clientKeyPath, key + '\n', { mode: 0o600 });
    } catch (err) {
      this.logger.warn('[alerts] could not save client-key: ' + err.message);
    }
  }

  async connect() {
    const clientKey = this.readClientKey();
    const ws = new WebSocket(this.url());
    const session = new Session(ws, this);

    try {
      await session.open(this.connectTimeoutMs);
      if (!clientKey) {
        this.logger.log('[alerts] no client-key yet; accept the pairing prompt on the TV');
      }
      await session.register(clientKey);
      return session;
    } catch (err) {
      session.close();
      throw err;
    }
  }
}

module.exports = {
  TvClient,
  Session,
  trimMessage,
  TOAST_URI,
  FOREGROUND_URI,
  PERMISSIONS,
  MAX_MESSAGE
};
