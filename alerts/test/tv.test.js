'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { trimMessage, MAX_MESSAGE } = require('../lib/tv');

test('toast messages are trimmed to the SSAP 60-character limit', () => {
  const trimmed = trimMessage('x'.repeat(100));
  assert.equal(Array.from(trimmed).length, MAX_MESSAGE);
  assert.ok(trimmed.endsWith('…'));
});

test('short toast messages are untouched', () => {
  assert.equal(trimMessage('Front: Person detected'), 'Front: Person detected');
});
