'use strict';

const mysql = require('mysql2/promise');

const REQUIRED_DB_ENV = ['HPA_DB_HOST', 'HPA_DB_USER', 'HPA_DB_PASS', 'HPA_DB_NAME', 'HPA_DB_CONN'];

const normalizeSql = (sql = '') => sql.replace(/\s+/g, ' ').trim().toLowerCase();

class MysqlClient {
  constructor(pool) {
    this.pool = pool;
    this.mode = 'mysql';
  }

  async query(sql, params) {
    return this.pool.query(sql, params);
  }
}

class MemoryClient {
  constructor() {
    this.mode = 'memory';
    this.cookies = new Map();
    this.conversations = new Map();
    this.messages = new Map();
    this.messageSeq = 1;
  }

  async query(sql, params = []) {
    const canonical = normalizeSql(sql);

    if (canonical.startsWith('select 1')) return [[{ '1': 1 }], []];

    if (canonical.startsWith('insert into ?? (cookie_value')) {
      return this.upsertCookie(params);
    }

    if (canonical.startsWith('insert into ?? (uuid, cookie_value, title) values')) {
      return this.insertConversation(params);
    }

    const isConversationList =
      canonical.startsWith('select uuid as id, title, updated_at as date') ||
      canonical.startsWith('select c.uuid as id, c.title, c.updated_at as date');
    if (isConversationList && canonical.includes('from ??') && canonical.includes('where cookie_value = ?')) {
      return this.listConversations(params);
    }

    if (canonical.startsWith('select uuid from ?? where uuid = ? and cookie_value = ?')) {
      return this.findConversation(params);
    }

    if (canonical.startsWith('select id, sender_type as type, text, created_at from ?? where conversation_uuid = ?')) {
      return this.listMessagesAscending(params);
    }

    if (canonical.startsWith('select sender_type, text from ?? where conversation_uuid = ?')) {
      return this.listMessagesDescending(params);
    }

    if (canonical.includes("values (?, 'user', ?)")) {
      return this.insertMessage(params, 'user');
    }

    if (canonical.includes("values (?, 'ai', ?)")) {
      return this.insertMessage(params, 'ai');
    }

    if (canonical.startsWith('update ?? set updated_at = current_timestamp where uuid = ?')) {
      return this.touchConversation(params);
    }

    throw new Error(`Memory DB does not understand query:\n${sql}`);
  }

  upsertCookie(params) {
    const [, cookieValue, lastIp, lastUserAgent, cfMetaJson, clientMetaJson] = params;
    const id = (cookieValue || '').trim();
    const now = new Date().toISOString();
    const current = this.cookies.get(id) || { cookie_value: id, access_count: 0, created_at: now };

    current.access_count += 1;
    current.last_seen = now;
    current.last_ip = lastIp || null;
    current.last_user_agent = lastUserAgent || null;
    current.cf_meta = cfMetaJson ? safeJsonParse(cfMetaJson) : null;
    current.client_meta = clientMetaJson ? safeJsonParse(clientMetaJson) : null;

    this.cookies.set(id, current);
    return [{ affectedRows: 1 }, []];
  }

  insertConversation(params) {
    const [, uuid, cookieValue, title] = params;
    const now = new Date().toISOString();
    const row = {
      uuid,
      cookie_value: cookieValue,
      title,
      created_at: now,
      updated_at: now
    };
    this.conversations.set(uuid, row);
    if (!this.messages.has(uuid)) this.messages.set(uuid, []);
    return [{ affectedRows: 1 }, []];
  }

  listConversations(params) {
    const cookieValue = params[params.length - 1];
    const rows = [...this.conversations.values()]
      .filter(conv => conv.cookie_value === cookieValue)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
      .slice(0, 200)
      .map(conv => ({
        id: conv.uuid,
        title: conv.title,
        date: conv.updated_at,
        preview: (() => {
          const messages = (this.messages.get(conv.uuid) || []).slice().sort((a, b) => a.id - b.id);
          const firstUser = messages.find(row => row.sender_type === 'user' && String(row.text || '').trim());
          return firstUser ? firstUser.text : null;
        })()
      }));

    return [rows, []];
  }

  findConversation(params) {
    const [, uuid, cookieValue] = params;
    const conv = this.conversations.get(uuid);
    if (!conv || conv.cookie_value !== cookieValue) return [[], []];
    return [[{ uuid }], []];
  }

  listMessagesAscending(params) {
    const [, conversationId] = params;
    const rows = (this.messages.get(conversationId) || [])
      .slice()
      .sort((a, b) => a.id - b.id)
      .slice(0, 1000)
      .map(row => ({
        id: row.id,
        type: row.sender_type,
        text: row.text,
        created_at: row.created_at
      }));
    return [rows, []];
  }

  listMessagesDescending(params) {
    const [, conversationId] = params;
    const rows = (this.messages.get(conversationId) || [])
      .slice()
      .sort((a, b) => b.id - a.id)
      .slice(0, 100)
      .map(row => ({
        sender_type: row.sender_type,
        text: row.text
      }));
    return [rows, []];
  }

  insertMessage(params, type) {
    const [, conversationId, text] = params;
    const entry = {
      id: this.messageSeq++,
      conversation_uuid: conversationId,
      sender_type: type,
      text,
      created_at: new Date().toISOString()
    };
    const list = this.messages.get(conversationId) || [];
    list.push(entry);
    this.messages.set(conversationId, list);
    return [{ insertId: entry.id }, []];
  }

  touchConversation(params) {
    const [, uuid] = params;
    const conv = this.conversations.get(uuid);
    if (conv) conv.updated_at = new Date().toISOString();
    return [{ affectedRows: conv ? 1 : 0 }, []];
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasDatabaseEnv() {
  return REQUIRED_DB_ENV.every(key => !!process.env[key]);
}

async function createDbClient() {
  if (process.env.HPA_FORCE_MEMORY === 'true') {
    console.warn('[DB] HPA_FORCE_MEMORY enabled. Using in-memory data store.');
    return new MemoryClient();
  }

  if (!hasDatabaseEnv()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[DB] MySQL configuration is required in production.');
    }
    console.warn('[DB] Missing SQL environment variables. Using in-memory data store for development.');
    return new MemoryClient();
  }

  try {
    const pool = mysql.createPool({
      host: process.env.HPA_DB_HOST,
      user: process.env.HPA_DB_USER,
      password: process.env.HPA_DB_PASS,
      database: process.env.HPA_DB_NAME,
      waitForConnections: true,
      connectionLimit: parseInt(process.env.HPA_DB_CONN, 10),
      timezone: '+00:00'
    });

    await pool.query('SELECT 1');
    console.log('[DB] Connected to MySQL.');
    return new MysqlClient(pool);
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      const code = err && err.code ? ` (${err.code})` : '';
      throw new Error(`[DB] MySQL connection failed in production${code}.`);
    }
    console.warn(`[DB] Could not reach MySQL (${err.message}). Falling back to in-memory store.`);
    return new MemoryClient();
  }
}

module.exports = {
  createDbClient,
  MemoryClient
};
