'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadConfig,
  loadSettings,
  defaultSettings,
  validateSettings
} = require('../lib/config');

test('first run creates config.json and settings.json with defaults', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcam-alerts-config-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const config = loadConfig(dataDir);
  assert.ok(config.token, 'token generated on first run');
  assert.equal(config.iconSize, 80);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')),
    config
  );

  const settings = loadSettings(dataDir, config);
  assert.equal(settings.enabled, true);
  assert.equal(settings.cooldownSeconds, 120);
  assert.deepEqual(Object.keys(settings.cameras), Object.keys(config.cameras));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')),
    settings
  );
});

test('validateSettings accepts the defaults it generates', () => {
  const config = { cameras: { front: {}, back: {} } };
  const result = validateSettings(defaultSettings(config), Object.keys(config.cameras));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, defaultSettings(config));
});
