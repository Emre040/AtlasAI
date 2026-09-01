'use strict';

const { createUuidV7, uuidBufferToString } = require('../shared/ids');
const {
  createOpaqueToken,
  hashToken,
  tokenHashMatches
} = require('./tokens');

const TABLES = Object.freeze({
  visitors: '`atlasai`.`visitors`',
  sessions: '`atlasai`.`auth_sessions`',
  refreshTokens: '`atlasai`.`auth_refresh_tokens`'
});

class AuthenticationError extends Error {
  constructor(code = 'invalid_session') {
    super(code);
    this.name = 'AuthenticationError';
    this.code = code;
  }
}

function createSecrets() {
  const accessToken = createOpaqueToken();
  const refreshToken = createOpaqueToken();
  const csrfToken = createOpaqueToken();
  return {
    accessToken,
    refreshToken,
    csrfToken,
    accessTokenHash: hashToken(accessToken, 'access token'),
    refreshTokenHash: hashToken(refreshToken, 'refresh token'),
    csrfTokenHash: hashToken(csrfToken, 'CSRF token')
  };
}

class SessionService {
  constructor(db, config) {
    if (!db?.transaction || !db?.execute) throw new TypeError('SessionService requires a transactional database client.');
    this.db = db;
    this.config = config;
  }

  expiry(now) {
    return {
      accessExpiresUnixMs: now + this.config.accessTtlMs,
      idleExpiresUnixMs: now + this.config.idleTtlMs,
      absoluteExpiresUnixMs: now + this.config.absoluteTtlMs
    };
  }

  async createSession() {
    const now = Date.now();
    const visitorPublic = createUuidV7();
    const sessionPublic = createUuidV7();
    const refreshFamily = createUuidV7();
    const secrets = createSecrets();
    const expiry = this.expiry(now);

    const ids = await this.db.transaction(async tx => {
      const [visitorResult] = await tx.execute(
        `INSERT INTO ${TABLES.visitors} (
          public_id, status, first_seen_unix_ms, last_seen_unix_ms, request_count, revision
        ) VALUES (?, 'active', ?, ?, 0, 1)`,
        [visitorPublic.bytes, now, now]
      );

      const [sessionResult] = await tx.execute(
        `INSERT INTO ${TABLES.sessions} (
          public_id, visitor_id, refresh_family_id, access_token_sha256,
          csrf_token_sha256, status, access_expires_unix_ms,
          idle_expires_unix_ms, absolute_expires_unix_ms,
          created_unix_ms, last_seen_unix_ms, revision
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 1)`,
        [
          sessionPublic.bytes,
          visitorResult.insertId,
          refreshFamily.bytes,
          secrets.accessTokenHash,
          secrets.csrfTokenHash,
          expiry.accessExpiresUnixMs,
          expiry.idleExpiresUnixMs,
          expiry.absoluteExpiresUnixMs,
          now,
          now
        ]
      );

      await tx.execute(
        `INSERT INTO ${TABLES.refreshTokens} (
          session_id, parent_token_id, token_sha256, status,
          created_unix_ms, expires_unix_ms
        ) VALUES (?, NULL, ?, 'active', ?, ?)`,
        [sessionResult.insertId, secrets.refreshTokenHash, now, expiry.absoluteExpiresUnixMs]
      );

      return { visitorId: visitorResult.insertId, sessionId: sessionResult.insertId };
    });

    return {
      ...ids,
      visitorPublicId: visitorPublic.text,
      sessionPublicId: sessionPublic.text,
      ...secrets,
      ...expiry
    };
  }

  async authenticateAccessToken(accessToken) {
    let tokenHash;
    try {
      tokenHash = hashToken(accessToken, 'access token');
    } catch {
      return null;
    }

    const [rows] = await this.db.execute(
      `SELECT
         s.id AS session_id,
         s.public_id AS session_public_id,
         s.visitor_id,
         v.public_id AS visitor_public_id,
         v.status AS visitor_status,
         s.status,
         s.csrf_token_sha256,
         s.access_expires_unix_ms,
         s.idle_expires_unix_ms,
         s.absolute_expires_unix_ms
       FROM ${TABLES.sessions} s
       JOIN ${TABLES.visitors} v ON v.id = s.visitor_id
       WHERE s.access_token_sha256 = ?
       LIMIT 1`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row || row.status !== 'active' || row.visitor_status !== 'active') return null;

    const now = Date.now();
    if (
      Number(row.idle_expires_unix_ms) <= now ||
      Number(row.absolute_expires_unix_ms) <= now
    ) {
      await this.expireSession(row.session_id, now);
      return null;
    }
    if (Number(row.access_expires_unix_ms) <= now) return null;

    return {
      sessionId: row.session_id,
      sessionPublicId: uuidBufferToString(row.session_public_id),
      visitorId: row.visitor_id,
      visitorPublicId: uuidBufferToString(row.visitor_public_id),
      accessExpiresUnixMs: Number(row.access_expires_unix_ms),
      idleExpiresUnixMs: Number(row.idle_expires_unix_ms),
      absoluteExpiresUnixMs: Number(row.absolute_expires_unix_ms),
      csrfTokenHash: row.csrf_token_sha256
    };
  }

  async expireSession(sessionId, now = Date.now()) {
    await this.db.transaction(async tx => {
      await tx.execute(
        `UPDATE ${TABLES.sessions}
         SET status = 'expired', revision = revision + 1
         WHERE id = ? AND status = 'active'`,
        [sessionId]
      );
      await tx.execute(
        `UPDATE ${TABLES.refreshTokens}
         SET status = 'expired'
         WHERE session_id = ? AND status = 'active'`,
        [sessionId]
      );
    });
  }

  async refreshSession(refreshToken, csrfToken) {
    let refreshTokenHash;
    try {
      refreshTokenHash = hashToken(refreshToken, 'refresh token');
    } catch {
      throw new AuthenticationError('invalid_refresh');
    }

    const now = Date.now();
    const nextSecrets = createSecrets();
    const outcome = await this.db.transaction(async tx => {
      const [rows] = await tx.execute(
        `SELECT
           rt.id AS refresh_token_id,
           rt.status AS refresh_status,
           rt.expires_unix_ms AS refresh_expires_unix_ms,
           s.id AS session_id,
           s.public_id AS session_public_id,
           s.visitor_id,
           v.public_id AS visitor_public_id,
           v.status AS visitor_status,
           s.status AS session_status,
           s.csrf_token_sha256,
           s.idle_expires_unix_ms,
           s.absolute_expires_unix_ms
         FROM ${TABLES.refreshTokens} rt
         JOIN ${TABLES.sessions} s ON s.id = rt.session_id
         JOIN ${TABLES.visitors} v ON v.id = s.visitor_id
         WHERE rt.token_sha256 = ?
         LIMIT 1
         FOR UPDATE`,
        [refreshTokenHash]
      );
      const row = rows[0];
      if (!row) return { error: 'invalid_refresh' };

      if (row.refresh_status === 'rotated' || row.refresh_status === 'reused') {
        await tx.execute(
          `UPDATE ${TABLES.refreshTokens}
           SET status = 'reused', consumed_unix_ms = COALESCE(consumed_unix_ms, ?)
           WHERE id = ?`,
          [now, row.refresh_token_id]
        );
        await this.revokeInTransaction(tx, row.session_id, now, 'refresh_token_reuse');
        return { error: 'refresh_reuse' };
      }

      if (
        row.refresh_status !== 'active' ||
        row.session_status !== 'active' ||
        row.visitor_status !== 'active'
      ) {
        return { error: 'invalid_refresh' };
      }
      if (!tokenHashMatches(csrfToken, row.csrf_token_sha256, 'CSRF token')) {
        return { error: 'invalid_csrf' };
      }

      const absoluteExpiresUnixMs = Number(row.absolute_expires_unix_ms);
      if (
        Number(row.refresh_expires_unix_ms) <= now ||
        Number(row.idle_expires_unix_ms) <= now ||
        absoluteExpiresUnixMs <= now
      ) {
        await tx.execute(
          `UPDATE ${TABLES.sessions} SET status = 'expired', revision = revision + 1
           WHERE id = ? AND status = 'active'`,
          [row.session_id]
        );
        await tx.execute(
          `UPDATE ${TABLES.refreshTokens} SET status = 'expired'
           WHERE session_id = ? AND status = 'active'`,
          [row.session_id]
        );
        return { error: 'expired_refresh' };
      }

      const idleExpiresUnixMs = Math.min(now + this.config.idleTtlMs, absoluteExpiresUnixMs);
      const accessExpiresUnixMs = Math.min(now + this.config.accessTtlMs, idleExpiresUnixMs);

      await tx.execute(
        `UPDATE ${TABLES.refreshTokens}
         SET status = 'rotated', consumed_unix_ms = ?
         WHERE id = ? AND status = 'active'`,
        [now, row.refresh_token_id]
      );
      await tx.execute(
        `UPDATE ${TABLES.sessions}
         SET access_token_sha256 = ?, csrf_token_sha256 = ?,
             access_expires_unix_ms = ?, idle_expires_unix_ms = ?,
             last_seen_unix_ms = ?, revision = revision + 1
         WHERE id = ? AND status = 'active'`,
        [
          nextSecrets.accessTokenHash,
          nextSecrets.csrfTokenHash,
          accessExpiresUnixMs,
          idleExpiresUnixMs,
          now,
          row.session_id
        ]
      );
      await tx.execute(
        `INSERT INTO ${TABLES.refreshTokens} (
          session_id, parent_token_id, token_sha256, status,
          created_unix_ms, expires_unix_ms
        ) VALUES (?, ?, ?, 'active', ?, ?)`,
        [row.session_id, row.refresh_token_id, nextSecrets.refreshTokenHash, now, absoluteExpiresUnixMs]
      );

      return {
        sessionId: row.session_id,
        sessionPublicId: uuidBufferToString(row.session_public_id),
        visitorId: row.visitor_id,
        visitorPublicId: uuidBufferToString(row.visitor_public_id),
        accessExpiresUnixMs,
        idleExpiresUnixMs,
        absoluteExpiresUnixMs
      };
    });

    if (outcome.error) throw new AuthenticationError(outcome.error);
    return { ...outcome, ...nextSecrets };
  }

  async revokeInTransaction(tx, sessionId, now, reason) {
    await tx.execute(
      `UPDATE ${TABLES.sessions}
       SET status = 'revoked', revoked_unix_ms = ?, revocation_reason = ?, revision = revision + 1
       WHERE id = ? AND status = 'active'`,
      [now, reason, sessionId]
    );
    await tx.execute(
      `UPDATE ${TABLES.refreshTokens}
       SET status = 'revoked', revoked_unix_ms = ?
       WHERE session_id = ? AND status = 'active'`,
      [now, sessionId]
    );
  }

  revokeSession(sessionId, reason = 'logout') {
    const now = Date.now();
    return this.db.transaction(tx => this.revokeInTransaction(tx, sessionId, now, reason));
  }
}

module.exports = { SessionService, AuthenticationError };
