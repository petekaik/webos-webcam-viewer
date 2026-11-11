'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { shouldAlert } = require('./lib/dnd');
const {
  DETECTION_TYPES,
  validateSettings,
  loadConfig,
  loadSettings,
  saveSettings
} = require('./lib/config');
const { TvClient } = require('./lib/tv');
const { createGrabber } = require('./lib/snapshot');

const DEFAULT_PORT = 8790;
const BODY_LIMIT = 1024 * 1024;
const TYPE_LABEL = {
  person: 'Person',
  vehicle: 'Vehicle',
  animal: 'Animal',
  motion: 'Motion'
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;

    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        done = true;
        const err = new Error('request body too large');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false };
  }
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function tokenValid(expected, supplied) {
  if (typeof expected !== 'string' || !expected || typeof supplied !== 'string') {
    return false;
  }
  return crypto.timingSafeEqual(hashToken(supplied), hashToken(expected));
}

// ?type=person etc. (Homey / Home Assistant), else Protect's alarm.triggers[0].key.
function detectionType(body, url) {
  const fromQuery = url && url.searchParams.get('type');
  if (fromQuery) return DETECTION_TYPES.includes(fromQuery) ? fromQuery : 'motion';
  if (!body) return 'motion';
  const parsed = parseJson(body);
  if (!parsed.ok || !parsed.value) return 'motion';
  const alarm = parsed.value.alarm;
  const triggers = alarm && alarm.triggers;
  const key = Array.isArray(triggers) && triggers[0] && triggers[0].key;
  return DETECTION_TYPES.includes(key) ? key : 'motion';
}

function createServer(options) {
  const opts = options || {};
  if (!opts.config) throw new Error('config is required');
  if (!opts.settings) throw new Error('settings is required');
  if (!opts.dataDir) throw new Error('dataDir is required');

  const config = opts.config;
  const dataDir = opts.dataDir;
  const logger = opts.logger || console;
  const now = opts.now || Date.now;
  const state = opts.state || {};
  if (!Array.isArray(state.events)) state.events = [];
  if (!state.lastToastAt || typeof state.lastToastAt !== 'object') {
    state.lastToastAt = {};
  }

  let settings = opts.settings;

  const tv = opts.tv || new TvClient({
    host: config.tv.host,
    port: config.tv.port,
    appId: config.appId,
    clientKeyPath: path.join(dataDir, 'client-key'),
    logger
  });
  const snapshot = opts.grab || createGrabber({
    size: config.iconSize,
    logger
  });

  function record(event) {
    state.events.unshift(event);
    if (state.events.length > 20) state.events.length = 20;
  }

  function authorized(url) {
    return tokenValid(config.token, url.searchParams.get('token'));
  }

  function cameraIdFrom(url) {
    const camera = url.searchParams.get('camera');
    if (!camera || !config.cameras || !config.cameras[camera]) return null;
    return camera;
  }

  function cameraName(camera) {
    const entry = config.cameras && config.cameras[camera];
    return (entry && entry.name) || camera;
  }

  function notify(session, message, icon, camera) {
    const params = { camera, source: 'alert' };
    return settings.style === 'toast'
      ? session.toast(message, icon, params)
      : session.alert(message, params);
  }

  // HTTP still first (instant), RTSP frame as the fallback (waits for a keyframe).
  async function grabIcon(camera) {
    const entry = (config.cameras && config.cameras[camera]) || {};
    const icon = entry.snapshot ? await snapshot(entry.snapshot) : null;
    return icon || (entry.rtsp ? snapshot(entry.rtsp) : null);
  }

  function messageFor(camera, type) {
    return cameraName(camera) + ': ' + TYPE_LABEL[type] + ' detected';
  }

  async function handleMotion(req, res, url) {
    if (!authorized(url)) {
      return sendJson(res, 401, { ok: false, reason: 'unauthorized' });
    }

    const camera = cameraIdFrom(url);
    if (!camera) {
      return sendJson(res, 400, { ok: false, reason: 'unknown-camera' });
    }

    const body = req.method === 'POST' ? await readBody(req) : '';
    const type = detectionType(body, url);
    const startedAt = now();

    const decision = shouldAlert(settings, state, { camera, type }, startedAt);
    if (!decision.ok) {
      record({
        at: new Date(startedAt).toISOString(),
        camera,
        type,
        reason: decision.reason,
        sent: false,
        ms: now() - startedAt
      });
      return sendJson(res, 202, {
        ok: false,
        reason: decision.reason,
        camera,
        type,
        sent: false
      });
    }

    // Claim the cooldown slot now, not after sending: Protect fires several
    // webhooks within milliseconds (motion + smart detection) and a toast
    // round-trip, ffmpeg grab included, takes seconds. Released if not sent.
    const previousToastAt = state.lastToastAt[camera];
    state.lastToastAt[camera] = startedAt;
    const release = () => {
      if (previousToastAt) state.lastToastAt[camera] = previousToastAt;
      else delete state.lastToastAt[camera];
    };

    let session;
    try {
      session = await tv.connect();
    } catch (err) {
      release();
      logger.warn('[alerts] TV unreachable: ' + err.message);
      record({
        at: new Date(startedAt).toISOString(),
        camera,
        type,
        reason: 'tv-unreachable',
        sent: false,
        ms: now() - startedAt
      });
      return sendJson(res, 202, {
        ok: false,
        reason: 'tv-unreachable',
        camera,
        type,
        sent: false
      });
    }

    try {
      if (settings.suppressWhileViewing) {
        let foreground = null;
        try {
          foreground = await session.foregroundAppId();
        } catch (err) {
          logger.warn('[alerts] could not read foreground app: ' + err.message);
        }
        if (foreground && foreground === config.appId) {
          release();
          record({
            at: new Date(startedAt).toISOString(),
            camera,
            type,
            reason: 'viewing',
            sent: false,
            ms: now() - startedAt
          });
          return sendJson(res, 202, {
            ok: false,
            reason: 'viewing',
            camera,
            type,
            sent: false
          });
        }
      }

      const icon = config.toastIcon ? await grabIcon(camera) : null;
      const message = messageFor(camera, type);

      try {
        await notify(session, message, icon, camera);
      } catch (err) {
        release();
        logger.error('[alerts] toast failed: ' + err.message);
        record({
          at: new Date(startedAt).toISOString(),
          camera,
          type,
          reason: 'toast-failed',
          sent: false,
          ms: now() - startedAt
        });
        return sendJson(res, 202, {
          ok: false,
          reason: 'toast-failed',
          camera,
          type,
          sent: false
        });
      }

      state.lastToastAt[camera] = now();
      record({
        at: new Date(startedAt).toISOString(),
        camera,
        type,
        reason: 'ok',
        sent: true,
        ms: now() - startedAt
      });
      return sendJson(res, 202, {
        ok: true,
        reason: 'ok',
        camera,
        type,
        sent: true,
        message
      });
    } finally {
      session.close();
    }
  }

  async function handleTest(req, res, url) {
    if (!authorized(url)) {
      return sendJson(res, 401, { ok: false, reason: 'unauthorized' });
    }

    const camera = cameraIdFrom(url);
    if (!camera) {
      return sendJson(res, 400, { ok: false, reason: 'unknown-camera' });
    }

    const startedAt = now();
    let session;
    try {
      session = await tv.connect();
    } catch (err) {
      logger.warn('[alerts] TV unreachable: ' + err.message);
      return sendJson(res, 502, { ok: false, reason: 'tv-unreachable', sent: false });
    }

    try {
      const icon = config.toastIcon ? await grabIcon(camera) : null;
      const message = cameraName(camera) + ': Test notification';
      try {
        await notify(session, message, icon, camera);
      } catch (err) {
        logger.error('[alerts] test toast failed: ' + err.message);
        record({
          at: new Date(startedAt).toISOString(),
          camera,
          type: 'test',
          reason: 'toast-failed',
          sent: false,
          ms: now() - startedAt
        });
        return sendJson(res, 502, { ok: false, reason: 'toast-failed', sent: false });
      }
      record({
        at: new Date(startedAt).toISOString(),
        camera,
        type: 'test',
        reason: 'ok',
        sent: true,
        ms: now() - startedAt,
        test: true
      });
      return sendJson(res, 200, { ok: true, reason: 'ok', sent: true, message });
    } finally {
      session.close();
    }
  }

  async function handleSettings(req, res) {
    if (req.method === 'GET') {
      return sendJson(res, 200, settings);
    }

    const body = await readBody(req);
    const parsed = parseJson(body);
    if (!parsed.ok) {
      return sendJson(res, 400, { ok: false, error: 'body must be JSON' });
    }

    const result = validateSettings(parsed.value, Object.keys(config.cameras || {}));
    if (!result.ok) {
      return sendJson(res, 400, {
        ok: false,
        error: result.errors.join('; '),
        errors: result.errors
      });
    }

    settings = result.value;
    saveSettings(dataDir, settings);
    return sendJson(res, 200, { ok: true, settings });
  }

  async function handleSnooze(req, res) {
    const body = await readBody(req);
    const parsed = parseJson(body);
    if (!parsed.ok || !parsed.value || typeof parsed.value.minutes !== 'number' ||
        !Number.isFinite(parsed.value.minutes) || parsed.value.minutes < 0) {
      return sendJson(res, 400, { ok: false, error: 'minutes must be a non-negative number' });
    }

    const minutes = parsed.value.minutes;
    const snoozeUntil = minutes === 0 ? 0 : now() + Math.round(minutes * 60000);
    settings = Object.assign({}, settings, { snoozeUntil });
    saveSettings(dataDir, settings);

    return sendJson(res, 200, { ok: true, snoozeUntil });
  }

  const server = http.createServer(async (req, res) => {
    cors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: 'bad URL' });
    }

    try {
      if (url.pathname === '/motion') {
        if (req.method !== 'GET' && req.method !== 'POST') {
          res.setHeader('Allow', 'GET, POST');
          return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        }
        return await handleMotion(req, res, url);
      }

      if (url.pathname === '/test') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        }
        return await handleTest(req, res, url);
      }

      if (url.pathname === '/settings') {
        if (req.method !== 'GET' && req.method !== 'PUT') {
          res.setHeader('Allow', 'GET, PUT');
          return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        }
        return await handleSettings(req, res);
      }

      if (url.pathname === '/snooze') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        }
        return await handleSnooze(req, res);
      }

      if (url.pathname === '/status') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        }
        return sendJson(res, 200, { ok: true, events: state.events.slice(0, 20) });
      }

      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      logger.error('[alerts] request failed: ' + (err.stack || err.message));
      if (!res.headersSent) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'internal error'
        });
      }
      res.end();
    }
  });

  server.state = state;
  server.getSettings = () => settings;
  return server;
}

if (require.main === module) {
  const dataDir = process.env.ALERTS_DATA_DIR || '/data';
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const host = process.env.HOST || '0.0.0.0';

  try {
    const config = loadConfig(dataDir);
    const settings = loadSettings(dataDir, config);
    const server = createServer({ config, settings, dataDir, state: {} });

    server.on('error', (err) => {
      console.error('[alerts] ' + err.message);
      process.exitCode = 1;
    });

    server.listen(port, host, () => {
      console.log('[alerts] listening on http://' + host + ':' + port);
      console.log('[alerts] data directory: ' + dataDir);
      console.log('[alerts] webhook token: ' + config.token);
      if (!fs.existsSync(path.join(dataDir, 'client-key'))) {
        console.log('[alerts] no TV client key yet; accept the pairing prompt on the TV.');
      }
    });
  } catch (err) {
    console.error('[alerts] ' + err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  createServer,
  detectionType,
  tokenValid
};
