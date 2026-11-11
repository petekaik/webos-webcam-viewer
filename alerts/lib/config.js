'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DETECTION_TYPES = ['person', 'vehicle', 'animal', 'motion'];

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function defaultConfig() {
  return {
    tv: { host: '192.168.0.50', port: 3000 },
    appId: 'com.petekaik.webcamviewer',
    token: randomToken(),
    cameras: {
      // snapshot: webcam-web's cached HTTP still (~0.2 s). Preferred over rtsp, which has
      // to wait for the next keyframe (cameras send one every 5 s: grabs took 3.7-6.1 s).
      front: { name: 'Front', snapshot: 'http://192.168.0.10/snap/front.jpg',
        rtsp: 'rtsp://192.168.0.10:8554/front' },
      back: { name: 'Back', snapshot: 'http://192.168.0.10/snap/back.jpg',
        rtsp: 'rtsp://192.168.0.10:8554/back' }
    },
    // The OLED65C8 (webOS 4.4.3, fw 05.50.70) silently drops toasts that carry iconData:
    // no reply and nothing on screen (tested 11 Nov 2026). Text-only toasts work.
    toastIcon: false,
    iconSize: 80
  };
}

function defaultSettings(config) {
  const cameraIds = config && config.cameras
    ? Object.keys(config.cameras)
    : ['front', 'back'];
  const cameras = {};
  for (const id of cameraIds) cameras[id] = true;

  return {
    enabled: true,
    cameras,
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    cooldownSeconds: 120,
    snoozeUntil: 0,
    suppressWhileViewing: true,
    types: { person: true, vehicle: true, animal: false, motion: true },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    // popup: LG alert with "Open live view" / "Dismiss" buttons. toast: corner toast, select to open.
    style: 'popup'
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validClock(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return Boolean(match) && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function validateSettings(value, cameraIds) {
  const errors = [];

  if (!isObject(value)) {
    return { ok: false, errors: ['settings must be an object'] };
  }

  const allowedRoot = [
    'enabled', 'cameras', 'quietHours', 'cooldownSeconds', 'snoozeUntil',
    'suppressWhileViewing', 'types', 'timezone', 'style'
  ];
  for (const key of Object.keys(value)) {
    if (!allowedRoot.includes(key)) errors.push('unknown key: ' + key);
  }

  if (typeof value.enabled !== 'boolean') errors.push('enabled must be a boolean');

  if (!isObject(value.cameras)) {
    errors.push('cameras must be an object');
  } else {
    for (const [id, enabled] of Object.entries(value.cameras)) {
      if (Array.isArray(cameraIds) && !cameraIds.includes(id)) {
        errors.push('unknown camera: ' + id);
      }
      if (typeof enabled !== 'boolean') errors.push('cameras.' + id + ' must be a boolean');
    }
  }

  if (!isObject(value.quietHours)) {
    errors.push('quietHours must be an object');
  } else {
    for (const key of Object.keys(value.quietHours)) {
      if (!['enabled', 'start', 'end'].includes(key)) {
        errors.push('unknown key: quietHours.' + key);
      }
    }
    if (typeof value.quietHours.enabled !== 'boolean') {
      errors.push('quietHours.enabled must be a boolean');
    }
    if (!validClock(value.quietHours.start)) {
      errors.push('quietHours.start must be HH:MM');
    }
    if (!validClock(value.quietHours.end)) {
      errors.push('quietHours.end must be HH:MM');
    }
  }

  if (!Number.isInteger(value.cooldownSeconds) || value.cooldownSeconds < 0) {
    errors.push('cooldownSeconds must be a non-negative integer');
  }
  if (typeof value.snoozeUntil !== 'number' || !Number.isFinite(value.snoozeUntil) ||
      value.snoozeUntil < 0) {
    errors.push('snoozeUntil must be a non-negative number');
  }
  if (typeof value.suppressWhileViewing !== 'boolean') {
    errors.push('suppressWhileViewing must be a boolean');
  }

  if (!isObject(value.types)) {
    errors.push('types must be an object');
  } else {
    for (const key of Object.keys(value.types)) {
      if (!DETECTION_TYPES.includes(key)) errors.push('unknown detection type: ' + key);
      if (typeof value.types[key] !== 'boolean') {
        errors.push('types.' + key + ' must be a boolean');
      }
    }
    for (const key of DETECTION_TYPES) {
      if (!(key in value.types)) errors.push('missing detection type: ' + key);
    }
  }

  if (value.style !== undefined && value.style !== 'popup' && value.style !== 'toast') {
    errors.push('style must be "popup" or "toast"');
  }

  if (typeof value.timezone !== 'string' || value.timezone.length === 0) {
    errors.push('timezone must be an IANA timezone name');
  } else {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value.timezone });
    } catch (err) {
      errors.push('unknown timezone: ' + value.timezone);
    }
  }

  return errors.length
    ? { ok: false, errors }
    : { ok: true, value };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function loadConfig(dataDir) {
  const file = path.join(dataDir, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(file)) {
    const config = defaultConfig();
    writeJson(file, config);
    return config;
  }

  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = false;
  if (!config.token) {
    config.token = randomToken();
    changed = true;
  }
  if (changed) writeJson(file, config);
  return config;
}

function loadSettings(dataDir, config) {
  const file = path.join(dataDir, 'settings.json');
  if (!fs.existsSync(file)) {
    const settings = defaultSettings(config);
    writeJson(file, settings);
    return settings;
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = validateSettings(raw, Object.keys(config.cameras || {}));
  if (!result.ok) {
    throw new Error('Invalid ' + file + ': ' + result.errors.join('; '));
  }
  return result.value;
}

function saveSettings(dataDir, settings) {
  writeJson(path.join(dataDir, 'settings.json'), settings);
}

module.exports = {
  DETECTION_TYPES,
  defaultConfig,
  defaultSettings,
  validateSettings,
  loadConfig,
  loadSettings,
  saveSettings,
  randomToken
};
