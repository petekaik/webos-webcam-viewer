/* Alert core: token check, settings, do-not-disturb decision, event log. No I/O of its own: persistence,
   delivery (banner or toast) and the clock are injected, so it can be tested off the TV.
   ES5 for the TV's Node 0.12. */
'use strict';

var dnd = require('./dnd');

var TYPES = ['person', 'vehicle', 'animal', 'motion'];
var MAX_EVENTS = 20;
var TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function safeEqual(a, b) {
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  var i;
  for (i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function defaultSettings(cameraIds) {
  var cams = {};
  var i;
  for (i = 0; i < cameraIds.length; i++) {
    cams[cameraIds[i]] = true;
  }
  return {
    enabled: true,
    cameras: cams,
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    cooldownSeconds: 120,
    snoozeUntil: 0,
    types: { person: true, vehicle: true, animal: false, motion: true }
  };
}

function idsOf(cameras) {
  var ids = [];
  var i;
  for (i = 0; i < cameras.length; i++) {
    ids.push(cameras[i].id);
  }
  return ids;
}

/* opts: now() -> ms, load() -> saved object or null, save(obj), randomToken() -> string,
         deliver(event, cb) with cb(err, 'banner' | 'toast') */
function createCore(opts) {
  var saved = opts.load() || {};
  var data = {
    port: typeof saved.port === 'number' ? saved.port : 8791,
    token: TOKEN_RE.test(saved.token || '') ? saved.token : opts.randomToken(),
    cameras: Array.isArray(saved.cameras) ? saved.cameras : [],
    settings: isObject(saved.settings) ? saved.settings : null
  };
  var state = { lastAt: {} };
  var events = [];

  if (!data.settings) {
    data.settings = defaultSettings(idsOf(data.cameras));
  }

  function persist() {
    opts.save(clone(data));
  }

  function cameraById(id) {
    var i;
    for (i = 0; i < data.cameras.length; i++) {
      if (data.cameras[i].id === id) {
        return data.cameras[i];
      }
    }
    return null;
  }

  function record(entry) {
    events.unshift(entry);
    if (events.length > MAX_EVENTS) {
      events.length = MAX_EVENTS;
    }
  }

  /* cfg: { port?, token?, cameras?: [{id, name}] } from the app, on every start and camera change. */
  function configure(cfg) {
    var i;
    var cams;
    var known = {};
    cfg = cfg || {};
    if (typeof cfg.port === 'number' && cfg.port >= 1024 && cfg.port <= 65535 && cfg.port % 1 === 0) {
      data.port = cfg.port;
    }
    if (typeof cfg.token === 'string' && TOKEN_RE.test(cfg.token)) {
      data.token = cfg.token;
    }
    if (Array.isArray(cfg.cameras)) {
      cams = [];
      for (i = 0; i < cfg.cameras.length; i++) {
        if (isObject(cfg.cameras[i]) && typeof cfg.cameras[i].id === 'string' && cfg.cameras[i].id &&
            typeof cfg.cameras[i].name === 'string') {
          cams.push({ id: cfg.cameras[i].id, name: cfg.cameras[i].name });
          known[cfg.cameras[i].id] = true;
        }
      }
      data.cameras = cams;
      /* keep the on/off switch of cameras that remain, default new ones to on, drop removed ones */
      for (i = 0; i < cams.length; i++) {
        if (typeof data.settings.cameras[cams[i].id] !== 'boolean') {
          data.settings.cameras[cams[i].id] = true;
        }
      }
      Object.keys(data.settings.cameras).forEach(function (id) {
        if (!known[id]) {
          delete data.settings.cameras[id];
        }
      });
    }
    persist();
    return { port: data.port, token: data.token, cameras: data.cameras.length };
  }

  function getSettings() {
    return clone(data.settings);
  }

  function putSettings(input) {
    var errors = [];
    var next = clone(data.settings);
    var q;
    var i;
    if (!isObject(input)) {
      return { ok: false, errors: ['settings must be an object'] };
    }
    if (typeof input.enabled !== 'boolean') {
      errors.push('enabled must be a boolean');
    } else {
      next.enabled = input.enabled;
    }
    if (isObject(input.cameras)) {
      Object.keys(next.cameras).forEach(function (id) {
        if (typeof input.cameras[id] === 'boolean') {
          next.cameras[id] = input.cameras[id];
        }
      });
    } else {
      errors.push('cameras must be an object');
    }
    q = input.quietHours;
    if (isObject(q) && typeof q.enabled === 'boolean' && dnd.minutesOfDay(q.start) !== null &&
        dnd.minutesOfDay(q.end) !== null) {
      next.quietHours = { enabled: q.enabled, start: q.start, end: q.end };
    } else {
      errors.push('quietHours must be { enabled, start: "HH:MM", end: "HH:MM" }');
    }
    if (typeof input.cooldownSeconds === 'number' && input.cooldownSeconds >= 0 && input.cooldownSeconds <= 86400) {
      next.cooldownSeconds = input.cooldownSeconds;
    } else {
      errors.push('cooldownSeconds must be a number from 0 to 86400');
    }
    if (typeof input.snoozeUntil === 'number' && input.snoozeUntil >= 0) {
      next.snoozeUntil = input.snoozeUntil;
    } else {
      errors.push('snoozeUntil must be a non-negative number');
    }
    if (isObject(input.types)) {
      for (i = 0; i < TYPES.length; i++) {
        if (typeof input.types[TYPES[i]] === 'boolean') {
          next.types[TYPES[i]] = input.types[TYPES[i]];
        } else {
          errors.push('types.' + TYPES[i] + ' must be a boolean');
        }
      }
    } else {
      errors.push('types must be an object');
    }
    if (errors.length) {
      return { ok: false, errors: errors };
    }
    data.settings = next;
    persist();
    return { ok: true, settings: clone(next) };
  }

  function snooze(minutes) {
    if (typeof minutes !== 'number' || !(minutes >= 0) || minutes > 14 * 24 * 60) {
      return { ok: false, error: 'minutes must be a number from 0 to 20160' };
    }
    data.settings.snoozeUntil = minutes === 0 ? 0 : opts.now() + Math.round(minutes * 60000);
    persist();
    return { ok: true, snoozeUntil: data.settings.snoozeUntil };
  }

  function status() {
    return { ok: true, events: clone(events) };
  }

  /* q: { camera, type, token }. cb(httpStatus, body). */
  function handleMotion(q, cb) {
    var now = opts.now();
    var camera = cameraById(q.camera);
    var type = TYPES.indexOf(q.type) !== -1 ? q.type : 'motion';
    var decision;
    var previous;
    var event;
    if (typeof q.token !== 'string' || !safeEqual(q.token, data.token)) {
      cb(401, { ok: false, reason: 'unauthorized' });
      return;
    }
    if (!camera) {
      cb(400, { ok: false, reason: 'unknown-camera' });
      return;
    }
    decision = dnd.shouldAlert(data.settings, state, { camera: camera.id, type: type }, now);
    if (!decision.ok) {
      record({ at: new Date(now).toISOString(), camera: camera.id, type: type, reason: decision.reason, sent: false });
      cb(202, { ok: false, reason: decision.reason, camera: camera.id, type: type, sent: false });
      return;
    }
    /* Claim the cooldown before delivering: camera systems fire several webhooks within
       milliseconds. Released again if nothing was delivered. */
    previous = state.lastAt[camera.id];
    state.lastAt[camera.id] = now;
    event = { camera: camera.id, name: camera.name, type: type, at: new Date(now).toISOString() };
    opts.deliver(event, function (err, how) {
      if (err) {
        if (previous) {
          state.lastAt[camera.id] = previous;
        } else {
          delete state.lastAt[camera.id];
        }
        record({ at: event.at, camera: camera.id, type: type, reason: 'toast-failed', sent: false });
        cb(202, { ok: false, reason: 'toast-failed', camera: camera.id, type: type, sent: false });
        return;
      }
      record({ at: event.at, camera: camera.id, type: type, reason: 'ok', sent: true, via: how });
      cb(202, { ok: true, reason: 'ok', camera: camera.id, type: type, sent: true, via: how });
    });
  }

  /* "Send test alert" from the app: skips token, do-not-disturb and cooldown. */
  function test(cameraId, cb) {
    var camera = cameraById(cameraId) || data.cameras[0];
    var event;
    if (!camera) {
      cb({ ok: false, error: 'no cameras configured' });
      return;
    }
    event = { camera: camera.id, name: camera.name, type: 'test', at: new Date(opts.now()).toISOString() };
    opts.deliver(event, function (err, how) {
      cb(err ? { ok: false, error: String(err.message || err) } : { ok: true, via: how });
    });
  }

  persist();
  return {
    configure: configure, getSettings: getSettings, putSettings: putSettings, snooze: snooze,
    status: status, handleMotion: handleMotion, test: test,
    port: function () { return data.port; }, token: function () { return data.token; }
  };
}

module.exports = { createCore: createCore, TYPES: TYPES };
