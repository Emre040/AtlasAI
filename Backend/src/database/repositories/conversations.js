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
const CALLS = '`atlasai`.`inference_calls`';
const MODELS = '`atlasai`.`inference_models`';

const ROLES = new Set(['user', 'assistant']);

function asUnixMs(value) {
  return Number(value);
}

function asNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function toMessage(row) {
  return {
    id: row.id,
    publicId: uuidBufferToString(row.public_id),
    parentMessageId: row.parent_message_id ?? null,
    role: row.role,
    text: row.content_text,
    createdUnixMs: asUnixMs(row.created_unix_ms),
    inference: row.call_public_id
      ? {
          callPublicId: uuidBufferToString(row.call_public_id),
          modelConfigKey: row.model_config_key,
          finishReason: row.finish_reason ?? null,
          inputTokens: asNumber(row.input_tokens),
          cachedInputTokens: asNumber(row.cached_input_tokens),
          outputTokens: asNumber(row.output_tokens),
          reasoningTokens: asNumber(row.reasoning_tokens),
          totalTokens: asNumber(row.total_tokens),
          firstTokenLatencyMs: asNumber(row.first_token_latency_ms),
          totalLatencyMs: asNumber(row.total_latency_ms),
          outputTokensPerSecond: asNumber(row.output_tokens_per_second)
        }
      : null
  };
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
         public_id, visitor_id, title,
         created_unix_ms, updated_unix_ms, revision
       ) VALUES (?, ?, ?, ?, ?, 1)`,
      [publicId.bytes, visitorId, title, now, now]
    );
    return { id: result.insertId, publicId: publicId.text, title, createdUnixMs: now };
  }

  async findOwned(publicId, visitorId) {
    const publicIdBytes = uuidStringToBuffer(publicId);
    const [rows] = await this.db.execute(
      `SELECT id, public_id, title, created_unix_ms, updated_unix_ms
         FROM ${CONVERSATIONS}
        WHERE public_id = ? AND visitor_id = ?
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
       WHERE c.visitor_id = ?
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

  // One human-visible message. Assistant messages name the user message they answer and the
  // inference call that produced them; user messages have neither.
  async addMessage(conversationId, role, text, { parentMessageId = null, inferenceCallId = null } = {}) {
    if (!ROLES.has(role)) throw new TypeError(`Unknown message role '${role}'.`);
    const normalizedText = String(text || '').trim();
    if (!normalizedText) throw new TypeError('Message text must not be empty.');
    if (role === 'user' && (parentMessageId !== null || inferenceCallId !== null)) {
      throw new TypeError('User messages carry no parent message or inference call.');
    }
    if (role === 'assistant' && !Number.isInteger(parentMessageId)) {
      throw new TypeError('Assistant messages require the user message they answer.');
    }

    const publicId = createUuidV7();
    const now = Date.now();
    const contentHash = crypto.createHash('sha256').update(normalizedText, 'utf8').digest();
    const [result] = await this.db.execute(
      `INSERT INTO ${MESSAGES} (
         public_id, conversation_id, parent_message_id, inference_call_id,
         role, content_text, content_sha256, created_unix_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [publicId.bytes, conversationId, parentMessageId, inferenceCallId, role, normalizedText, contentHash, now]
    );
    return { id: result.insertId, publicId: publicId.text, createdUnixMs: now };
  }

  async listMessages(conversationId, limit = 1000) {
    const rowLimit = sqlLimit(limit, 1000);
    const [rows] = await this.db.execute(
      `SELECT m.id, m.public_id, m.parent_message_id, m.role, m.content_text, m.created_unix_ms,
              c.public_id AS call_public_id, c.finish_reason, c.input_tokens, c.cached_input_tokens,
              c.output_tokens, c.reasoning_tokens, c.total_tokens, c.first_token_latency_ms,
              c.total_latency_ms, c.output_tokens_per_second,
              im.config_key AS model_config_key
         FROM ${MESSAGES} m
         LEFT JOIN ${CALLS} c ON c.id = m.inference_call_id
         LEFT JOIN ${MODELS} im ON im.id = c.inference_model_id
        WHERE m.conversation_id = ?
        ORDER BY m.id
        LIMIT ${rowLimit}`,
      [conversationId]
    );
    return rows.map(toMessage);
  }

  // The most recent messages in chronological order, for building the model's context.
  async history(conversationId, limit = 100) {
    const rowLimit = sqlLimit(limit, 1000);
    const [rows] = await this.db.execute(
      `SELECT id, parent_message_id, role, content_text
         FROM (
           SELECT id, parent_message_id, role, content_text
             FROM ${MESSAGES}
            WHERE conversation_id = ?
            ORDER BY id DESC
            LIMIT ${rowLimit}
         ) recent
        ORDER BY id`,
      [conversationId]
    );
    return rows.map(row => ({
      id: row.id,
      parentMessageId: row.parent_message_id ?? null,
      role: row.role,
      text: row.content_text
    }));
  }

  async touch(conversationId) {
    await this.db.execute(
      `UPDATE ${CONVERSATIONS}
          SET updated_unix_ms = ?, revision = revision + 1
        WHERE id = ?`,
      [Date.now(), conversationId]
    );
  }
}

module.exports = { ConversationRepository };
