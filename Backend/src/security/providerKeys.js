'use strict';

// Visitor-supplied provider API keys: AES-256-GCM at rest with a server secret, verified against
// the provider before they are stored, and decrypted only for the request that uses them.

const crypto = require('node:crypto');
const { createUuidV7, uuidBufferToString } = require('../shared/ids');

const KEYS = '`atlasai`.`visitor_provider_keys`';
const PROVIDERS = '`atlasai`.`inference_providers`';
const MAX_KEY_LENGTH = 1024;

function encryptionKeyFromHex(hex) {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('Provider key secret must be 32 bytes of lowercase hex.');
  return Buffer.from(hex, 'hex');
}

function encryptSecret(plaintext, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

function decryptSecret({ ciphertext, nonce, tag }, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function normalizeApiKey(value) {
  if (typeof value !== 'string') throw new TypeError('API key must be a string.');
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > MAX_KEY_LENGTH || /\s/.test(trimmed)) {
    throw new TypeError('API key must be 8 to 1024 characters without whitespace.');
  }
  return trimmed;
}

function keySuffix(apiKey) {
  return apiKey.slice(-4);
}

class VisitorProviderKeyRepository {
  constructor(db, encryptionKey) {
    this.db = db;
    this.key = encryptionKey;
  }

  async findProvider(providerKey) {
    const [rows] = await this.db.execute(
      `SELECT id, provider_key, display_name, adapter_key, api_base_url, status FROM ${PROVIDERS} WHERE provider_key = ? LIMIT 1`,
      [providerKey]
    );
    return rows[0] || null;
  }

  async save(visitorId, providerId, apiKey, verifiedUnixMs) {
    const normalized = normalizeApiKey(apiKey);
    const sealed = encryptSecret(normalized, this.key);
    const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest();
    const now = Date.now();
    const publicId = createUuidV7();
    await this.db.execute(
      `INSERT INTO ${KEYS} (
         public_id, visitor_id, provider_id, key_ciphertext, key_nonce, key_tag, key_sha256, key_suffix,
         verified_unix_ms, use_count, last_used_unix_ms, created_unix_ms, updated_unix_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
       ON DUPLICATE KEY UPDATE
         key_ciphertext = VALUES(key_ciphertext), key_nonce = VALUES(key_nonce), key_tag = VALUES(key_tag),
         key_sha256 = VALUES(key_sha256), key_suffix = VALUES(key_suffix), verified_unix_ms = VALUES(verified_unix_ms),
         use_count = 0, last_used_unix_ms = NULL, updated_unix_ms = VALUES(updated_unix_ms)`,
      [publicId.bytes, visitorId, providerId, sealed.ciphertext, sealed.nonce, sealed.tag, digest, keySuffix(normalized),
        verifiedUnixMs, now, now]
    );
    return { suffix: keySuffix(normalized), verifiedUnixMs };
  }

  async remove(visitorId, providerId) {
    const [result] = await this.db.execute(
      `DELETE FROM ${KEYS} WHERE visitor_id = ? AND provider_id = ?`,
      [visitorId, providerId]
    );
    return result.affectedRows === 1;
  }

  // Decrypted key for one request; NULL when the visitor has none for this provider.
  async credential(visitorId, providerId) {
    const [rows] = await this.db.execute(
      `SELECT id, key_ciphertext, key_nonce, key_tag, key_suffix FROM ${KEYS}
        WHERE visitor_id = ? AND provider_id = ? LIMIT 1`,
      [visitorId, providerId]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      id: row.id,
      suffix: row.key_suffix,
      apiKey: decryptSecret({ ciphertext: row.key_ciphertext, nonce: row.key_nonce, tag: row.key_tag }, this.key)
    };
  }

  async recordUse(keyId) {
    await this.db.execute(
      `UPDATE ${KEYS} SET use_count = use_count + 1, last_used_unix_ms = ? WHERE id = ?`,
      [Date.now(), keyId]
    );
  }

  async list(visitorId) {
    const [rows] = await this.db.execute(
      `SELECT k.public_id, p.provider_key, k.key_suffix, k.verified_unix_ms, k.use_count, k.last_used_unix_ms, k.created_unix_ms
         FROM ${KEYS} k
         JOIN ${PROVIDERS} p ON p.id = k.provider_id
        WHERE k.visitor_id = ?
        ORDER BY p.id`,
      [visitorId]
    );
    return rows.map(row => ({
      id: uuidBufferToString(row.public_id),
      provider: row.provider_key,
      suffix: row.key_suffix,
      verified_at: Number(row.verified_unix_ms),
      use_count: Number(row.use_count),
      last_used_at: row.last_used_unix_ms === null ? null : Number(row.last_used_unix_ms),
      created_at: Number(row.created_unix_ms)
    }));
  }
}

module.exports = {
  VisitorProviderKeyRepository,
  encryptionKeyFromHex,
  encryptSecret,
  decryptSecret,
  normalizeApiKey
};
