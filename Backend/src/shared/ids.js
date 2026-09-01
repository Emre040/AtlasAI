'use strict';

const crypto = require('node:crypto');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createUuidV7Buffer(unixMs = Date.now()) {
  if (!Number.isSafeInteger(unixMs) || unixMs < 0 || unixMs >= 2 ** 48) {
    throw new RangeError('UUIDv7 time must be a non-negative 48-bit Unix millisecond value.');
  }

  const bytes = crypto.randomBytes(16);
  bytes.writeUIntBE(unixMs, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

function uuidBufferToString(value) {
  if (!Buffer.isBuffer(value) || value.length !== 16) {
    throw new TypeError('UUID value must be a 16-byte Buffer.');
  }
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidStringToBuffer(value) {
  const normalized = String(value || '').trim();
  if (!UUID_PATTERN.test(normalized)) throw new TypeError('Invalid UUID.');
  return Buffer.from(normalized.replaceAll('-', ''), 'hex');
}

function createUuidV7() {
  const bytes = createUuidV7Buffer();
  return { bytes, text: uuidBufferToString(bytes) };
}

module.exports = {
  createUuidV7,
  createUuidV7Buffer,
  uuidBufferToString,
  uuidStringToBuffer
};
