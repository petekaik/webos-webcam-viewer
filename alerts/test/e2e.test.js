'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MockTv } = require('./mock-tv');
const { createServer } = require('../server');
const { defaultSettings } = require('../lib/config');

const TOKEN = 'test-token';
const APP_ID = 'com.petekaik.webcamviewer';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const silent = { log() {}, warn() {}, error() {} };

function makeConfig(port) {
  return {
    tv: { host: '127.0.0.1', port },
    appId: APP_ID,
    token: TOKEN,
    cameras: {
      front: { name: 'Front', rtsp: 'rtsp://127.0.0.1:8554/front' },
      back: { name: 'Back', rtsp: 'rtsp://127.0.0.1:8554/back' }
    },
    toastIcon: true,
    iconSize: 80
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  if (server.closeAllConnections) server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startHarness(t, options) {
  const opts = options || {};
  const mock = new MockTv({ appId: opts.mockAppId });
  await mock.start();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcam-alerts-'));
  const config = makeConfig(mock.port);
  const settings = Object.assign(defaultSettings(config), { style: 'toast' }, opts.settings || {});
  const server = createServer({
    config,
    settings,
    dataDir,
    grab: opts.grab || (async () => PNG),
    logger: silent
  });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;

  t.after(async () => {
    await closeServer(server);
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  return { mock, base, config, settings, dataDir, server };
}

async function motion(base, camera, options) {
  const opts = options || {};
  const token = opts.token === undefined ? TOKEN : opts.token;
  const method = opts.method || 'POST';
  const type = opts.type === undefined ? 'person' : opts.type;
  const headers = {};
  let body;
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify({ alarm: { triggers: [{ key: type }] } });
  }
  let url = base + '/motion?camera=' + encodeURIComponent(camera);
  if (token !== null) url += '&token=' + encodeURIComponent(token);
  const res = await fetch(url, { method, headers, body });
  return { res, json: await res.json() };
}

test('good motion POST sends the toast with icon, click app and params', async (t) => {
  const { mock, base } = await startHarness(t);

  const { res, json } = await motion(base, 'front');
  assert.equal(res.status, 202);
  assert.equal(json.ok, true);
  assert.equal(json.reason, 'ok');
  assert.equal(json.sent, true);

  assert.equal(mock.toasts.length, 1);
  const toast = mock.toasts[0];
  assert.equal(toast.message, 'Front: Person detected');
  assert.equal(toast.iconExtension, 'png');
  const icon = Buffer.from(toast.iconData, 'base64');
  assert.ok(icon.subarray(0, 8).equals(PNG_MAGIC), 'iconData is a PNG');
  assert.equal(toast.onClick.appId, APP_ID);
  assert.deepEqual(toast.onClick.params, { camera: 'front', source: 'alert' });

  const status = await (await fetch(base + '/status')).json();
  assert.equal(status.events.length, 1);
  assert.equal(status.events[0].camera, 'front');
  assert.equal(status.events[0].type, 'person');
  assert.equal(status.events[0].reason, 'ok');
  assert.equal(status.events[0].sent, true);
  assert.ok(status.events[0].at);
});

test('GET /motion also works and defaults to motion', async (t) => {
  const { mock, base } = await startHarness(t);
  const { res } = await motion(base, 'back', { method: 'GET', type: null });
  assert.equal(res.status, 202);
  assert.equal(mock.toasts.length, 1);
  assert.equal(mock.toasts[0].message, 'Back: Motion detected');
});

test('toastIcon off (the default): text-only toast, no grab', async (t) => {
  // The real TV silently drops toasts that carry iconData.
  let grabs = 0;
  const { mock, base, config } = await startHarness(t, { grab: async () => { grabs++; return PNG; } });
  config.toastIcon = false;
  const { json } = await motion(base, 'back');
  assert.equal(json.sent, true);
  assert.equal(grabs, 0);
  assert.equal(mock.toasts[0].iconData, undefined);
  assert.deepEqual(mock.toasts[0].onClick.params, { camera: 'back', source: 'alert' });
});

test('snapshot failure still sends the toast, without an icon', async (t) => {
  const { mock, base } = await startHarness(t, { grab: async () => null });

  const { res, json } = await motion(base, 'front');
  assert.equal(res.status, 202);
  assert.equal(json.sent, true);
  assert.equal(mock.toasts.length, 1);
  assert.equal(mock.toasts[0].iconData, undefined);
  assert.equal(mock.toasts[0].iconExtension, undefined);
});

test('bad and missing tokens get 401 and send nothing', async (t) => {
  const { mock, base } = await startHarness(t);

  let result = await motion(base, 'front', { token: 'wrong' });
  assert.equal(result.res.status, 401);
  assert.equal(result.json.ok, false);

  result = await motion(base, 'front', { token: null });
  assert.equal(result.res.status, 401);
  assert.equal(mock.toasts.length, 0);
});

test('second motion inside the cooldown sends no second toast', async (t) => {
  const { mock, base } = await startHarness(t);

  const first = await motion(base, 'front');
  assert.equal(first.json.reason, 'ok');

  const second = await motion(base, 'front');
  assert.equal(second.res.status, 202);
  assert.equal(second.json.ok, false);
  assert.equal(second.json.reason, 'cooldown');
  assert.equal(mock.toasts.length, 1);
});

test('a burst of concurrent webhooks sends one toast', async (t) => {
  // Protect fires motion + smart-detection webhooks within milliseconds; the
  // snapshot grab is slow, so the cooldown must be claimed before sending.
  const slowGrab = () => new Promise((resolve) => setTimeout(() => resolve(PNG), 200));
  const { mock, base } = await startHarness(t, { grab: slowGrab });

  const results = await Promise.all([
    motion(base, 'front', { type: 'motion' }),
    motion(base, 'front', { type: 'person' }),
    motion(base, 'front', { type: 'person' })
  ]);
  assert.equal(results.filter((r) => r.json.sent).length, 1);
  assert.equal(results.filter((r) => r.json.reason === 'cooldown').length, 2);
  assert.equal(mock.toasts.length, 1);
});

test('a suppressed alert frees the cooldown for the next one', async (t) => {
  const { mock, base } = await startHarness(t, { mockAppId: APP_ID });
  const first = await motion(base, 'front');
  assert.equal(first.json.reason, 'viewing');

  mock.appId = 'com.webos.app.livetv';
  const second = await motion(base, 'front');
  assert.equal(second.json.sent, true);
  assert.equal(mock.toasts.length, 1);
});

test('foreground app is ours: suppressed and no toast', async (t) => {
  const { mock, base } = await startHarness(t, { mockAppId: APP_ID });

  const { res, json } = await motion(base, 'front');
  assert.equal(res.status, 202);
  assert.equal(json.reason, 'viewing');
  assert.equal(json.sent, false);
  assert.equal(mock.toasts.length, 0);
});

test('TV unreachable: 202 tv-unreachable, service stays up', async (t) => {
  const dead = new MockTv();
  await dead.start();
  const port = dead.port;
  await dead.close();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcam-alerts-'));
  const config = makeConfig(port);
  const server = createServer({
    config,
    settings: defaultSettings(config),
    dataDir,
    grab: async () => PNG,
    logger: silent
  });
  const basePort = await listen(server);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { res, json } = await motion('http://127.0.0.1:' + basePort, 'front');
  assert.equal(res.status, 202);
  assert.equal(json.reason, 'tv-unreachable');
  assert.equal(json.sent, false);

  const settingsRes = await fetch('http://127.0.0.1:' + basePort + '/settings');
  assert.equal(settingsRes.status, 200);
});

test('POST /test sends a toast and skips do-not-disturb', async (t) => {
  const { mock, base } = await startHarness(t, {
    settings: { enabled: false, cooldownSeconds: 3600 }
  });

  const res = await fetch(base + '/test?camera=front&token=' + TOKEN, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(mock.toasts.length, 1);
  assert.equal(mock.toasts[0].message, 'Front: Test notification');
});

test('settings PUT validates unknown keys, types and cameras', async (t) => {
  const { base } = await startHarness(t);
  const current = await (await fetch(base + '/settings')).json();

  const put = (value) => fetch(base + '/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value)
  });

  assert.equal((await put(Object.assign({}, current, { nope: 1 }))).status, 400);
  assert.equal((await put(Object.assign({}, current, { enabled: 'yes' }))).status, 400);
  assert.equal((await put(Object.assign({}, current, {
    cameras: Object.assign({}, current.cameras, { attic: true })
  }))).status, 400);
  assert.equal((await put(Object.assign({}, current, {
    quietHours: { enabled: true, start: '25:99', end: '07:00' }
  }))).status, 400);

  const good = Object.assign({}, current, { cooldownSeconds: 5 });
  const goodRes = await put(good);
  assert.equal(goodRes.status, 200);
  assert.equal((await goodRes.json()).settings.cooldownSeconds, 5);
  assert.equal((await (await fetch(base + '/settings')).json()).cooldownSeconds, 5);
});

test('snooze sets and clears snoozeUntil', async (t) => {
  const { base } = await startHarness(t);

  const setRes = await fetch(base + '/snooze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ minutes: 2 })
  });
  assert.equal(setRes.status, 200);
  const set = await setRes.json();
  assert.ok(set.snoozeUntil > Date.now() + 60_000);

  const settings = await (await fetch(base + '/settings')).json();
  assert.equal(settings.snoozeUntil, set.snoozeUntil);

  const clearRes = await fetch(base + '/snooze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ minutes: 0 })
  });
  assert.equal((await clearRes.json()).snoozeUntil, 0);
});

test('popup style (default): createAlert with Open live view / Dismiss', async (t) => {
  const { mock, base } = await startHarness(t, { settings: { style: 'popup' } });
  const { json } = await motion(base, 'front');
  assert.equal(json.sent, true);
  assert.equal(mock.toasts.length, 0);
  assert.equal(mock.alerts.length, 1);
  const alert = mock.alerts[0];
  assert.equal(alert.message, 'Front: Person detected');
  assert.equal(alert.buttons[0].label, 'Open live view');
  assert.equal(alert.buttons[0].onclick, 'luna://com.webos.applicationManager/launch');
  assert.deepEqual(alert.buttons[0].params, { id: APP_ID, params: { camera: 'front', source: 'alert' } });
  assert.equal(alert.buttons[1].label, 'Dismiss');
});

test('?type= sets the detection type (Homey / Home Assistant webhooks)', async (t) => {
  const { mock, base } = await startHarness(t);
  const url = base + '/motion?camera=back&type=vehicle&token=' + encodeURIComponent(TOKEN);
  const json = await (await fetch(url, { method: 'POST' })).json();
  assert.equal(json.type, 'vehicle');
  assert.equal(mock.toasts[0].message, 'Back: Vehicle detected');
  const odd = await (await fetch(base + '/motion?camera=front&type=ufo&token=' + encodeURIComponent(TOKEN))).json();
  assert.equal(odd.type, 'motion');
});

test('settings: style must be popup or toast; absent is allowed', async (t) => {
  const { base, settings } = await startHarness(t);
  const put = (body) => fetch(base + '/settings', { method: 'PUT', body: JSON.stringify(body) });
  assert.equal((await put(Object.assign({}, settings, { style: 'banner' }))).status, 400);
  const noStyle = Object.assign({}, settings); delete noStyle.style;
  assert.equal((await put(noStyle)).status, 200);
});
