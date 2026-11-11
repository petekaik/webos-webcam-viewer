/* Do-not-disturb rules. Pure functions, ES5 for the TV's Node 0.12 (port of alerts/lib/dnd.js).
   Quiet hours use the TV's own local time (Node's Date follows the TV's timezone). */
'use strict';

function minutesOfDay(hhmm) {
  var m;
  var h;
  var mi;
  if (typeof hhmm !== 'string') {
    return null;
  }
  m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) {
    return null;
  }
  h = parseInt(m[1], 10);
  mi = parseInt(m[2], 10);
  return h > 23 || mi > 59 ? null : h * 60 + mi;
}

function localMinutes(now) {
  var d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

function inQuietHours(quietHours, now) {
  var start;
  var end;
  var current;
  if (!quietHours || !quietHours.enabled) {
    return false;
  }
  start = minutesOfDay(quietHours.start);
  end = minutesOfDay(quietHours.end);
  if (start === null || end === null || start === end) { /* equal = never */
    return false;
  }
  current = localMinutes(now);
  return start < end ? (current >= start && current < end) : (current >= start || current < end);
}

/* settings: the alert settings; state: { lastAt: { cameraId: epochMs } }; event: { camera, type } */
function shouldAlert(settings, state, event, now) {
  var type = event.type || 'motion';
  var last;
  var cooldownMs;
  if (!settings.enabled) {
    return { ok: false, reason: 'disabled' };
  }
  if (settings.cameras && settings.cameras[event.camera] === false) {
    return { ok: false, reason: 'camera-disabled' };
  }
  if (settings.types && settings.types[type] === false) {
    return { ok: false, reason: 'type-disabled' };
  }
  if (settings.snoozeUntil && now < settings.snoozeUntil) {
    return { ok: false, reason: 'snoozed' };
  }
  if (inQuietHours(settings.quietHours, now)) {
    return { ok: false, reason: 'quiet-hours' };
  }
  last = state && state.lastAt && state.lastAt[event.camera];
  cooldownMs = Number(settings.cooldownSeconds || 0) * 1000;
  if (last && cooldownMs > 0 && now - last < cooldownMs) {
    return { ok: false, reason: 'cooldown' };
  }
  return { ok: true, reason: 'ok' };
}

module.exports = { shouldAlert: shouldAlert, inQuietHours: inQuietHours, minutesOfDay: minutesOfDay };
