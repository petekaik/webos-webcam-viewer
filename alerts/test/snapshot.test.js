'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { createGrabber } = require('../lib/snapshot');

function ffmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

test('grabs an 80x80 PNG from a local test pattern', {
  skip: ffmpegAvailable() ? false : 'ffmpeg is not installed'
}, async () => {
  const silent = { log() {}, warn() {}, error() {} };
  const grab = createGrabber({ size: 80, timeoutMs: 10_000, logger: silent });
  const png = await grab(['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1']);

  assert.ok(Buffer.isBuffer(png), 'expected a PNG buffer');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 80, 'width');
  assert.equal(png.readUInt32BE(20), 80, 'height');
});

test('returns null instead of throwing when the source is bad', async () => {
  const silent = { log() {}, warn() {}, error() {} };
  const grab = createGrabber({ size: 80, timeoutMs: 5_000, logger: silent });
  const png = await grab(['-f', 'lavfi', '-i', 'this-is-not-a-source']);
  assert.equal(png, null);
});
