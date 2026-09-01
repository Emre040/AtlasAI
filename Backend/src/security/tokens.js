'use strict';

const crypto = require('node:crypto');

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function createOpaqueToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function assertOpaqueToken(value, label = 'token') {
  const token = String(value || '');
  if (!TOKEN_PATTERN.test(token)) throw new TypeError(`Invalid ${label}.`);
  return token;
}

function hashToken(value, label) {
  const token = assertOpaqueToken(value, label);
  return crypto.createHash('sha256').update(token, 'ascii').digest();
}

function tokenHashMatches(value, expectedHash, label) {
  if (!Buffer.isBuffer(expectedHash) || expectedHash.length !== 32) return false;
  let actualHash;
  try {
    actualHash = hashToken(value, label);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function readBearerToken(authorization) {
  const match = String(authorization || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
  return match ? match[1] : null;
}

function readCookie(cookieHeader, name) {
  const target = `${name}=`;
  for (const segment of String(cookieHeader || '').split(';')) {
    const item = segment.trim();
    if (!item.startsWith(target)) continue;
    const raw = item.slice(target.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = {
  createOpaqueToken,
  hashToken,
  tokenHashMatches,
  readBearerToken,
  readCookie
};
