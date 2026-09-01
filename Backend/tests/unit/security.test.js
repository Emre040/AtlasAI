'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOpaqueToken,
  hashToken,
  readBearerToken,
  readCookie,
  tokenHashMatches
} = require('../../src/security/tokens');

test('opaque tokens are random 256-bit values stored through SHA-256 digests', () => {
  const first = createOpaqueToken();
  const second = createOpaqueToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  const digest = hashToken(first, 'test token');
  assert.equal(digest.length, 32);
  assert.equal(tokenHashMatches(first, digest, 'test token'), true);
  assert.equal(tokenHashMatches(second, digest, 'test token'), false);
});

test('credential readers accept only exact cookie and Bearer token shapes', () => {
  const token = createOpaqueToken();
  assert.equal(readBearerToken(`Bearer ${token}`), token);
  assert.equal(readBearerToken(`Basic ${token}`), null);
  assert.equal(readCookie(`other=x; atlas_access=${token}; suffix=y`, 'atlas_access'), token);
  assert.equal(readCookie(`atlas_access_extra=${token}`, 'atlas_access'), null);
});
