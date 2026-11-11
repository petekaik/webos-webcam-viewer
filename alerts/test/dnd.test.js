'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { shouldAlert } = require('../lib/dnd');

const OK = { ok: true, reason: 'ok' };

function settings(overrides) {
  return Object.assign({
    enabled: true,
    cameras: { front: true, back: true },
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    cooldownSeconds: 120,
    snoozeUntil: 0,
    suppressWhileViewing: true,
    types: { person: true, vehicle: true, animal: false, motion: true },
    timezone: 'Europe/Athens'
  }, overrides);
}

function state(lastToastAt) {
  return { lastToastAt: lastToastAt || {} };
}

const NOW = Date.parse('2026-01-01T12:00:00Z'); // 14:00 in Athens (UTC+2)
const EVENT = { camera: 'front', type: 'person' };

test('alerts when every rule passes', () => {
  assert.deepEqual(shouldAlert(settings(), state(), EVENT, NOW), OK);
});

test('master switch off wins over everything else', () => {
  const s = settings({
    enabled: false,
    cameras: { front: false, back: true },
    quietHours: { enabled: true, start: '00:00', end: '23:59' }
  });
  assert.deepEqual(shouldAlert(s, state(), EVENT, NOW), { ok: false, reason: 'disabled' });
});

test('camera disabled', () => {
  const s = settings({ cameras: { front: false, back: true } });
  assert.deepEqual(shouldAlert(s, state(), EVENT, NOW), { ok: false, reason: 'camera-disabled' });
});

test('detection type disabled', () => {
  assert.deepEqual(
    shouldAlert(settings(), state(), { camera: 'front', type: 'animal' }, NOW),
    { ok: false, reason: 'type-disabled' }
  );
});

test('snoozed until the timestamp passes', () => {
  const s = settings({ snoozeUntil: NOW + 60_000 });
  assert.deepEqual(shouldAlert(s, state(), EVENT, NOW), { ok: false, reason: 'snoozed' });
  assert.deepEqual(shouldAlert(s, state(), EVENT, NOW + 60_000), OK);
});

test('quiet hours inside a window', () => {
  const s = settings({ quietHours: { enabled: true, start: '13:00', end: '15:00' } });
  assert.deepEqual(shouldAlert(s, state(), EVENT, NOW), { ok: false, reason: 'quiet-hours' });
  assert.deepEqual(shouldAlert(s, state(), EVENT, Date.parse('2026-01-01T15:00:00+02:00')), OK);
});

test('quiet hours window crossing midnight', () => {
  const s = settings({ quietHours: { enabled: true, start: '23:00', end: '07:00' } });
  const assertQuiet = (iso) =>
    assert.deepEqual(shouldAlert(s, state(), EVENT, Date.parse(iso)), { ok: false, reason: 'quiet-hours' });
  const assertAwake = (iso) =>
    assert.deepEqual(shouldAlert(s, state(), EVENT, Date.parse(iso)), OK);

  assertQuiet('2026-01-01T23:00:00+02:00'); // start is inclusive
  assertQuiet('2026-01-01T23:30:00+02:00');
  assertQuiet('2026-01-02T00:30:00+02:00');
  assertQuiet('2026-01-02T06:59:00+02:00');
  assertAwake('2026-01-02T07:00:00+02:00'); // end is exclusive
  assertAwake('2026-01-01T22:59:00+02:00');
});

test('quiet hours use the configured timezone', () => {
  const instant = Date.parse('2026-01-01T22:30:00Z'); // 00:30 Athens, 22:30 UTC
  const quiet = { enabled: true, start: '23:00', end: '07:00' };
  assert.deepEqual(
    shouldAlert(settings({ quietHours: quiet, timezone: 'Europe/Athens' }), state(), EVENT, instant),
    { ok: false, reason: 'quiet-hours' }
  );
  assert.deepEqual(
    shouldAlert(settings({ quietHours: quiet, timezone: 'UTC' }), state(), EVENT, instant),
    OK
  );
});

test('per-camera cooldown blocks until it expires', () => {
  const s = settings({ cooldownSeconds: 120 });
  assert.deepEqual(
    shouldAlert(s, state({ front: NOW - 30_000 }), EVENT, NOW),
    { ok: false, reason: 'cooldown' }
  );
  assert.deepEqual(shouldAlert(s, state({ front: NOW - 119_999 }), EVENT, NOW), {
    ok: false,
    reason: 'cooldown'
  });
  assert.deepEqual(shouldAlert(s, state({ front: NOW - 120_000 }), EVENT, NOW), OK);
});

test('cooldown is tracked per camera', () => {
  const s = settings({ cooldownSeconds: 120 });
  assert.deepEqual(shouldAlert(s, state({ back: NOW - 1_000 }), EVENT, NOW), OK);
});
