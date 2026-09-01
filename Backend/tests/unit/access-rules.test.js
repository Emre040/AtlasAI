'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  candidateHashes,
  canonicalMatchValue,
  matchHash
} = require('../../src/database/repositories/accessRules');
const { allCidrValues, ipToBuffer, parseCidr } = require('../../src/shared/network');

test('IPv4 and IPv6 addresses have canonical binary encodings', () => {
  assert.deepEqual(ipToBuffer('192.0.2.9'), Buffer.from([192, 0, 2, 9]));
  assert.equal(ipToBuffer('2001:db8::1').toString('hex'), '20010db8000000000000000000000001');
  assert.deepEqual(ipToBuffer('::ffff:192.0.2.9'), Buffer.from([192, 0, 2, 9]));
});

test('CIDR values normalize host bits and generate every candidate prefix', () => {
  assert.equal(parseCidr('192.0.2.129/24').toString('hex'), '0418c0000200');
  assert.equal(allCidrValues('192.0.2.9').length, 33);
  assert.equal(allCidrValues('2001:db8::1').length, 129);
});

test('access rules use deterministic indexed hashes without scanning rule values', () => {
  const ip = canonicalMatchValue('ip', '192.0.2.9');
  assert.deepEqual(matchHash('ip', ip), matchHash('ip', ip));
  const hashes = candidateHashes({
    visitorPublicId: '018f3f80-0000-7000-8000-000000000001',
    ip: '192.0.2.9',
    asn: 64500,
    country: 'se',
    ja3: '0123456789abcdef0123456789abcdef',
    ja4: 't13d1516h2_8daaf6152771_02713d6af862'
  });
  assert.equal(hashes.length, 39);
  assert.ok(hashes.every(value => Buffer.isBuffer(value) && value.length === 32));
});
