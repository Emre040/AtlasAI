'use strict';

const crypto = require('node:crypto');
const { createUuidV7, uuidStringToBuffer } = require('../../shared/ids');
const { allCidrValues, ipToBuffer, parseCidr } = require('../../shared/network');

const ACCESS_RULES = '`atlasai`.`access_rules`';

function unsignedBigIntBuffer(value) {
  const number = BigInt(value);
  if (number < 0n || number > 0xffffffffffffffffn) throw new TypeError('Integer is out of range.');
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(number);
  return buffer;
}

function canonicalMatchValue(type, value) {
  switch (type) {
    case 'visitor': return uuidStringToBuffer(value);
    case 'ip': return ipToBuffer(value);
    case 'ip_cidr': return parseCidr(value);
    case 'asn': return unsignedBigIntBuffer(value);
    case 'country': {
      const country = String(value || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{2}$/.test(country)) throw new TypeError('Invalid country code.');
      return Buffer.from(country, 'ascii');
    }
    case 'ja3': {
      const fingerprint = String(value || '').trim().toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(fingerprint)) throw new TypeError('Invalid JA3 fingerprint.');
      return Buffer.from(fingerprint, 'ascii');
    }
    case 'ja4': {
      const fingerprint = String(value || '').trim();
      if (!fingerprint || fingerprint.length > 128) throw new TypeError('Invalid JA4 fingerprint.');
      return Buffer.from(fingerprint, 'ascii');
    }
    default: throw new TypeError(`Unsupported access-rule match type '${type}'.`);
  }
}

function matchHash(type, canonicalValue) {
  return crypto
    .createHash('sha256')
    .update(type, 'ascii')
    .update(Buffer.from([0]))
    .update(canonicalValue)
    .digest();
}

function candidateHashes({ visitorPublicId, ip, asn, country, ja3, ja4 }) {
  const candidates = [];
  const add = (type, value) => {
    if (value === null || value === undefined || value === '') return;
    const canonical = canonicalMatchValue(type, value);
    candidates.push(matchHash(type, canonical));
  };

  add('visitor', visitorPublicId);
  add('ip', ip);
  if (ip) {
    for (const network of allCidrValues(ip)) candidates.push(matchHash('ip_cidr', network));
  }
  add('asn', asn);
  add('country', country);
  add('ja3', ja3);
  add('ja4', ja4);
  return candidates;
}

class AccessRuleRepository {
  constructor(db) {
    this.db = db;
  }

  async findEffective(context) {
    const hashes = candidateHashes(context);
    if (hashes.length === 0) return null;
    const placeholders = hashes.map(() => '?').join(', ');
    const [rows] = await this.db.execute(
      `SELECT id, action, match_type, priority
         FROM ${ACCESS_RULES}
        WHERE active_match_sha256 IN (${placeholders})
          AND (expires_unix_ms IS NULL OR expires_unix_ms > ?)
        ORDER BY priority DESC,
                 FIELD(action, 'block', 'challenge', 'allow', 'log'),
                 id DESC
        LIMIT 1`,
      [...hashes, Date.now()]
    );
    return rows[0] || null;
  }

  async create({
    type,
    value,
    visitorId = null,
    action,
    priority = 100,
    reason,
    createdBy = 'admin',
    expiresUnixMs = null
  }) {
    if (!['block', 'allow', 'challenge', 'log'].includes(action)) {
      throw new TypeError('Invalid access-rule action.');
    }
    if (!Number.isSafeInteger(priority) || priority < 0 || priority > 65535) {
      throw new TypeError('Invalid access-rule priority.');
    }
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 1024) {
      throw new TypeError('Invalid access-rule reason.');
    }
    if (typeof createdBy !== 'string' || createdBy.length > 128) {
      throw new TypeError('Invalid access-rule creator.');
    }

    const canonical = canonicalMatchValue(type, value);
    const hash = matchHash(type, canonical);
    const publicId = createUuidV7();
    const now = Date.now();
    if (expiresUnixMs !== null && (!Number.isSafeInteger(expiresUnixMs) || expiresUnixMs <= now)) {
      throw new TypeError('Access-rule expiration must be a future Unix millisecond value.');
    }

    const result = await this.db.transaction(async tx => {
      await tx.execute(
        `UPDATE ${ACCESS_RULES}
            SET status = 'expired'
          WHERE active_match_sha256 = ?
            AND expires_unix_ms IS NOT NULL
            AND expires_unix_ms <= ?`,
        [hash, now]
      );
      const [insertResult] = await tx.execute(
        `INSERT INTO ${ACCESS_RULES} (
           public_id, match_type, match_value, match_sha256, visitor_id,
           action, priority, status, reason, created_by,
           created_unix_ms, expires_unix_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        [
          publicId.bytes,
          type,
          canonical,
          hash,
          visitorId,
          action,
          priority,
          reason.trim(),
          createdBy,
          now,
          expiresUnixMs
        ]
      );
      return insertResult;
    });
    return { id: result.insertId, publicId: publicId.text };
  }

  async revoke(type, value) {
    const canonical = canonicalMatchValue(type, value);
    const hash = matchHash(type, canonical);
    const now = Date.now();
    const [result] = await this.db.execute(
      `UPDATE ${ACCESS_RULES}
          SET status = 'revoked', revoked_unix_ms = ?
        WHERE active_match_sha256 = ?`,
      [now, hash]
    );
    return result.affectedRows;
  }
}

module.exports = {
  AccessRuleRepository,
  candidateHashes,
  canonicalMatchValue,
  matchHash
};
