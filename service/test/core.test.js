'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCore } = require('../lib/core');
const dnd = require('../lib/dnd');

const TOKEN = 'abc12345def';
const CAMS = [{ id: 'front', name: 'Front' }, { id: 'back', name: 'Back' }];

function make(opts) {
  const o = opts || {};
  const clock = { t: o.t || Date.parse('2026-06-15T12:00:00') }; /* local noon */
  const delivered = [];
  let saved = o.saved || { token: TOKEN, cameras: CAMS };
  const core = createCore({
    now: () => clock.t,
    load: () => saved,
    save: (d) => { saved = d; },
    randomToken: () => 'generated12',
    deliver: o.deliver || ((event, cb) => { delivered.push(event); cb(null, 'toast'); })
  });
  return { core, clock, delivered, saved: () => saved };
}

const motion = (core, q) => new Promise((res) => core.handleMotion(q, (status, body) => res({ status, body })));

test('bad or missing token is 401 and delivers nothing', async () => {
  const { core, delivered } = make();
  assert.equal((await motion(core, { camera: 'front', token: 'nope' })).status, 401);
  assert.equal((await motion(core, { camera: 'front' })).status, 401);
  assert.equal(delivered.length, 0);
});

test('unknown camera is 400', async () => {
  const { core } = make();
  const r = await motion(core, { camera: 'garage', token: TOKEN });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'unknown-camera');
});

test('a good webhook delivers once with name and type; unknown type means motion', async () => {
  const { core, delivered } = make();
  const r = await motion(core, { camera: 'front', type: 'person', token: TOKEN });
  assert.equal(r.status, 202);
  assert.equal(r.body.sent, true);
  assert.equal(delivered[0].name, 'Front');
  assert.equal(delivered[0].type, 'person');
  const odd = await motion(core, { camera: 'back', type: 'ufo', token: TOKEN });
  assert.equal(odd.body.type, 'motion');
});

test('a burst sends one: the cooldown is claimed before delivery finishes', async () => {
  const pending = [];
  const { core } = make({ deliver: (e, cb) => pending.push(cb) });
  const a = motion(core, { camera: 'front', token: TOKEN });
  const b = motion(core, { camera: 'front', token: TOKEN });
  assert.equal((await b).body.reason, 'cooldown');
  pending[0](null, 'toast');
  assert.equal((await a).body.sent, true);
});

test('a failed delivery releases the cooldown for the next alert', async () => {
  let n = 0;
  const { core } = make({ deliver: (e, cb) => cb(++n === 1 ? new Error('boom') : null, 'toast') });
  assert.equal((await motion(core, { camera: 'front', token: TOKEN })).body.reason, 'toast-failed');
  assert.equal((await motion(core, { camera: 'front', token: TOKEN })).body.sent, true);
});

test('cooldown expires', async () => {
  const { core, clock } = make();
  await motion(core, { camera: 'front', token: TOKEN });
  assert.equal((await motion(core, { camera: 'front', token: TOKEN })).body.reason, 'cooldown');
  clock.t += 121000;
  assert.equal((await motion(core, { camera: 'front', token: TOKEN })).body.sent, true);
});

test('do-not-disturb: master, camera, type, snooze, quiet hours (incl. past midnight)', async () => {
  const { core, clock } = make();
  const s = core.getSettings();
  s.enabled = false;
  assert.equal(core.putSettings(s).ok, true);
  assert.equal((await motion(core, { camera: 'front', token: TOKEN })).body.reason, 'disabled');
  s.enabled = true; s.cameras.front = false;
  core.putSettings(s);
  assert.equal((await motion(core, { camera: 'front', token: TOKEN })).body.reason, 'camera-disabled');
  s.cameras.front = true; s.types.person = false;
  core.putSettings(s);
  assert.equal((await motion(core, { camera: 'front', type: 'person', token: TOKEN })).body.reason, 'type-disabled');
  s.types.person = true;
  core.putSettings(s);
  assert.equal(core.snooze(30).ok, true);
  assert.equal((await motion(core, { camera: 'front', token: TOKEN })).body.reason, 'snoozed');
  core.snooze(0);
  s.quietHours = { enabled: true, start: '23:00', end: '07:00' };
  core.putSettings(s);
  clock.t = Date.parse('2026-06-15T23:30:00');
  assert.equal((await motion(core, { camera: 'front', token: TOKEN })).body.reason, 'quiet-hours');
  clock.t = Date.parse('2026-06-16T03:00:00');
  assert.equal((await motion(core, { camera: 'front', token: TOKEN })).body.reason, 'quiet-hours');
  clock.t = Date.parse('2026-06-16T12:00:00');
  assert.equal((await motion(core, { camera: 'front', token: TOKEN })).body.sent, true);
});

test('dnd quiet window with equal start and end means never', () => {
  assert.equal(dnd.inQuietHours({ enabled: true, start: '10:00', end: '10:00' }, Date.parse('2026-06-15T10:00:00')), false);
});

test('putSettings validates and ignores unknown cameras and keys', () => {
  const { core } = make();
  const s = core.getSettings();
  assert.equal(core.putSettings(Object.assign({}, s, { cooldownSeconds: -1 })).ok, false);
  assert.equal(core.putSettings(Object.assign({}, s, { quietHours: { enabled: true, start: '25:00', end: '07:00' } })).ok, false);
  assert.equal(core.putSettings(null).ok, false);
  const ok = core.putSettings(Object.assign({}, s, { style: 'toast', cameras: Object.assign({}, s.cameras, { ghost: true }) }));
  assert.equal(ok.ok, true);
  assert.equal('ghost' in ok.settings.cameras, false);
  assert.equal('style' in ok.settings, false);
});

test('configure: cameras sync keeps switches, adds new ones, drops removed; token and port validated', () => {
  const { core, saved } = make();
  const s = core.getSettings();
  s.cameras.back = false;
  core.putSettings(s);
  core.configure({ cameras: [{ id: 'back', name: 'Back yard' }, { id: 'porch', name: 'Porch' }] });
  const next = core.getSettings();
  assert.deepEqual(next.cameras, { back: false, porch: true });
  core.configure({ port: 80, token: 'short' });
  assert.equal(core.port(), 8791);
  assert.equal(core.token(), TOKEN);
  core.configure({ port: 9000, token: 'my-own-token-1' });
  assert.equal(core.port(), 9000);
  assert.equal(saved().token, 'my-own-token-1');
});

test('a token is generated on first run and survives a restart', () => {
  const { core, saved } = make({ saved: {} });
  assert.equal(core.token(), 'generated12');
  assert.equal(saved().token, 'generated12');
});

test('status lists recent events newest first, capped at 20', async () => {
  const { core, clock } = make();
  for (let i = 0; i < 25; i++) {
    clock.t += 200000;
    await motion(core, { camera: 'front', token: TOKEN });
  }
  assert.equal(core.status().events.length, 20);
  assert.ok(core.status().events[0].at > core.status().events[19].at);
});

test('test alert skips token and do-not-disturb', async () => {
  const { core, delivered } = make();
  const s = core.getSettings();
  s.enabled = false;
  core.putSettings(s);
  const r = await new Promise((res) => core.test('back', res));
  assert.equal(r.ok, true);
  assert.equal(delivered[0].type, 'test');
});
