'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createUuidV7Buffer,
  uuidBufferToString,
  uuidStringToBuffer
} = require('../../src/shared/ids');

test('UUIDv7 values preserve time, version, variant, and round-trip bytes', () => {
  const unixMs = 1_725_000_000_123;
  const bytes = createUuidV7Buffer(unixMs);
  assert.equal(bytes.readUIntBE(0, 6), unixMs);
  assert.equal(bytes[6] >> 4, 7);
  assert.equal(bytes[8] >> 6, 2);
  assert.deepEqual(uuidStringToBuffer(uuidBufferToString(bytes)), bytes);
});

test('UUID parsing rejects malformed identifiers', () => {
  assert.throws(() => uuidStringToBuffer('not-a-uuid'), /Invalid UUID/);
  assert.throws(() => uuidStringToBuffer('00000000-0000-0000-0000-000000000000'), /Invalid UUID/);
});
