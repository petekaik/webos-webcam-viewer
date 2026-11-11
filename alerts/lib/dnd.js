'use strict';

// Pure do-not-disturb rules. Keep this file free of I/O so every rule can be
// tested with a fake clock.

function minutesOfDay(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function localMinutes(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(now));
    let hours = 0;
    let minutes = 0;
    for (const part of parts) {
      if (part.type === 'hour') hours = Number(part.value);
      else if (part.type === 'minute') minutes = Number(part.value);
    }
    return hours * 60 + minutes;
  } catch (err) {
    return null;
  }
}

function inQuietHours(quietHours, now, timeZone) {
  if (!quietHours || !quietHours.enabled) return false;
  const start = minutesOfDay(quietHours.start);
  const end = minutesOfDay(quietHours.end);
  // A zero-length window (start === end) means "never".
  if (start === null || end === null || start === end) return false;
  const current = localMinutes(now, timeZone);
  if (current === null) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

// settings: /data/settings.json
// state:    { lastToastAt: { [cameraId]: epochMs } }
// event:    { camera, type }
// now:      epoch ms
function shouldAlert(settings, state, event, now) {
  if (!settings.enabled) return { ok: false, reason: 'disabled' };

  if (settings.cameras && settings.cameras[event.camera] === false) {
    return { ok: false, reason: 'camera-disabled' };
  }

  const type = event.type || 'motion';
  if (settings.types && settings.types[type] === false) {
    return { ok: false, reason: 'type-disabled' };
  }

  if (settings.snoozeUntil && now < settings.snoozeUntil) {
    return { ok: false, reason: 'snoozed' };
  }

  if (inQuietHours(settings.quietHours, now, settings.timezone)) {
    return { ok: false, reason: 'quiet-hours' };
  }

  const last = state && state.lastToastAt && state.lastToastAt[event.camera];
  const cooldownMs = Number(settings.cooldownSeconds || 0) * 1000;
  if (last && cooldownMs > 0 && now - last < cooldownMs) {
    return { ok: false, reason: 'cooldown' };
  }

  return { ok: true, reason: 'ok' };
}

module.exports = { shouldAlert, inQuietHours, minutesOfDay };
