'use strict';

const crypto = require('node:crypto');
const {
  createUuidV7,
  uuidBufferToString,
  uuidStringToBuffer
} = require('../../shared/ids');
const { sqlLimit } = require('../sql');

const CONVERSATIONS = '`atlasai`.`conversations`';
const MESSAGES = '`atlasai`.`messages`';

function asUnixMs(value) {
  return Number(value);
}

class ConversationRepository {
  constructor(db) {
    this.db = db;
  }

  async create(visitorId, title) {
    const publicId = createUuidV7();
    const now = Date.now();
    const [result] = await this.db.execute(
      `INSERT INTO ${CONVERSATIONS} (
         public_id, visitor_id, status, title,
         created_unix_ms, updated_unix_ms, revision
       ) VALUES (?, ?, 'active', ?, ?, ?, 1)`,
      [publicId.bytes, visitorId, title, now, now]
    );
    return { id: result.insertId, publicId: publicId.text, title, createdUnixMs: now };
  }

  async findOwned(publicId, visitorId) {
    const publicIdBytes = uuidStringToBuffer(publicId);
    const [rows] = await this.db.execute(
      `SELECT id, public_id, title, created_unix_ms, updated_unix_ms
         FROM ${CONVERSATIONS}
        WHERE public_id = ? AND visitor_id = ? AND status = 'active'
        LIMIT 1`,
      [publicIdBytes, visitorId]
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      publicId: uuidBufferToString(rows[0].public_id),
      title: rows[0].title,
      createdUnixMs: asUnixMs(rows[0].created_unix_ms),
      updatedUnixMs: asUnixMs(rows[0].updated_unix_ms)
    };
  }

  async list(visitorId, limit = 200) {
    const rowLimit = sqlLimit(limit, 200);
    const [rows] = await this.db.execute(
      `SELECT
         c.public_id,
         c.title,
         c.created_unix_ms,
         c.updated_unix_ms,
         (
           SELECT m.content_text
             FROM ${MESSAGES} m
            WHERE m.conversation_id = c.id AND m.role = 'user'
            ORDER BY m.id
            LIMIT 1
         ) AS preview
       FROM ${CONVERSATIONS} c
       WHERE c.visitor_id = ? AND c.status = 'active'
       ORDER BY c.updated_unix_ms DESC, c.id DESC
       LIMIT ${rowLimit}`,
      [visitorId]
    );
    return rows.map(row => ({
      id: uuidBufferToString(row.public_id),
      title: row.title,
      created_at: asUnixMs(row.created_unix_ms),
      date: asUnixMs(row.updated_unix_ms),
      preview: row.preview
    }));
  }

  async listMessages(conversationId, limit = 1000) {
    const rowLimit = sqlLimit(limit, 1000);
    const [rows] = await this.db.execute(
      `SELECT public_id, role AS sender_type, content_text AS text, created_unix_ms
         FROM ${MESSAGES}
        WHERE conversation_id = ?
        ORDER BY id
        LIMIT ${rowLimit}`,
      [conversationId]
    );
    return rows.map(row => ({
      id: uuidBufferToString(row.public_id),
      type: row.sender_type,
      sender_type: row.sender_type,
      text: row.text,
      created_at: asUnixMs(row.created_unix_ms)
    }));
  }

  async history(conversationId, limit = 100) {
    const rowLimit = sqlLimit(limit, 1000);
    const [rows] = await this.db.execute(
      `SELECT role AS sender_type, content_text AS text
         FROM ${MESSAGES}
        WHERE conversation_id = ?
        ORDER BY id DESC
        LIMIT ${rowLimit}`,
      [conversationId]
    );
    return rows;
  }

  async addMessage(conversationId, text, {
    role,
    kind = 'text',
    totalTokens = null,
    inferenceModelId = null,
    runPublicId = null
  }) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) throw new TypeError('Message text must not be empty.');

    const publicId = createUuidV7();
    const now = Date.now();
    const contentHash = crypto.createHash('sha256').update(normalizedText, 'utf8').digest();
    const runBytes = runPublicId ? uuidStringToBuffer(runPublicId) : null;
    const [result] = await this.db.execute(
      `INSERT INTO ${MESSAGES} (
         public_id, conversation_id, run_public_id, role, kind, state,
         content_text, content_sha256, inference_model_id, total_tokens,
         created_unix_ms, completed_unix_ms
       ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`,
      [
        publicId.bytes,
        conversationId,
        runBytes,
        role,
        kind,
        normalizedText,
        contentHash,
        inferenceModelId,
        totalTokens,
        now,
        now
      ]
    );
    return { id: result.insertId, publicId: publicId.text };
  }

  async touch(conversationId) {
    await this.db.execute(
      `UPDATE ${CONVERSATIONS}
          SET updated_unix_ms = ?, revision = revision + 1
        WHERE id = ? AND status = 'active'`,
      [Date.now(), conversationId]
    );
  }
}

module.exports = { ConversationRepository };
