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

    this.workspaces = new Map();    // uuid -> workspace row
    this.artifacts = [];            // flat list of artifact rows
    this.batchJobs = new Map();     // job_uuid -> job row
    this.batchQueries = new Map();  // job_uuid -> Map(index -> query row)
  }

  async query(sql, params = []) {
    const canonical = normalizeSql(sql);

    if (canonical.startsWith('select 1')) return [[{ '1': 1 }], []];

    // ---------- Cookies (upsert + block flags + blocklist + analytics) ----------
    if (canonical.startsWith('insert into ?? (cookie_value')) {
      return this.upsertCookie(params);
    }

    if (canonical.startsWith('update ?? set') && canonical.includes('where cookie_value = ?')) {
      return this.updateCookieFlag(canonical, params);
    }

    if (canonical.includes('from ?? where block_fingerprint = 1 or block_ip = 1')) {
      return this.listBlocklist();
    }

    if (canonical.includes("json_extract(cf_meta, '$.ipcountry')") && canonical.includes('group by country')) {
      return this.listCountrySessions();
    }

    if (canonical.startsWith('select cookie_value, access_count, last_seen')) {
      return this.listCookiesDetailed();
    }

    // ---------- Conversations ----------
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

    if (canonical.startsWith('update ?? set updated_at = current_timestamp where uuid = ?')) {
      return this.touchConversation(params);
    }

    // ---------- Admin analytics (counts over conversations / messages) ----------
    if (canonical.includes('count(distinct cookie_value)') && canonical.includes('count(*) as conversations')) {
      return this.countConversationStats();
    }

    if (canonical.includes('count(*) as message_count') && canonical.includes('sum(token_count)')) {
      return this.countMessageStats();
    }

    // ---------- Messages ----------
    if (canonical.startsWith('select id, sender_type as type, text, created_at from ?? where conversation_uuid = ?')) {
      return this.listMessagesAscending(params);
    }

    if (canonical.startsWith('select sender_type, text from ?? where conversation_uuid = ?')) {
      return this.listMessagesDescending(params);
    }

    if (canonical.startsWith('insert into ?? (conversation_uuid, sender_type, text, token_count, ai_model)')) {
      return this.insertMessageExtended(params);
    }

    if (canonical.includes("values (?, 'user', ?)")) {
      return this.insertMessage(params, 'user');
    }

    if (canonical.includes("values (?, 'ai', ?)")) {
      return this.insertMessage(params, 'ai');
    }

    // ---------- ASO workspaces ----------
    if (canonical.startsWith('insert into hpa_agent_workspaces')) {
      return this.insertWorkspace(params);
    }

    if (canonical.startsWith('update hpa_agent_workspaces set')) {
      return this.updateWorkspace(canonical, params);
    }

    // ---------- ASO artifacts ----------
    if (canonical.startsWith('insert into hpa_agent_artifacts')) {
      return this.insertArtifact(params);
    }

    // ---------- Batch jobs ----------
    if (canonical.startsWith('insert into hpa_batch_jobs')) {
      return this.insertBatchJob(params);
    }

    if (canonical.startsWith('select job_uuid, status, total_queries') && canonical.includes('from hpa_batch_jobs')) {
      return this.getBatchJob(params);
    }

    if (canonical.startsWith('update hpa_batch_jobs set completed_queries = completed_queries + 1')) {
      return this.incrementBatchJobCompleted(params);
    }

    if (canonical.startsWith('update hpa_batch_jobs set status = ?, finished_at = current_timestamp')) {
      return this.finishBatchJob(params);
    }

    // ---------- Batch queries ----------
    if (canonical.startsWith('insert into hpa_batch_queries')) {
      return this.insertBatchQuery(params);
    }

    if (canonical.startsWith('select query_index, query_text, status, response_text')) {
      return this.listBatchQueries(params);
    }

    if (canonical.startsWith('select status from hpa_batch_queries')) {
      return this.listBatchQueryStatuses(params);
    }

    if (canonical.startsWith('update hpa_batch_queries set status = ?, response_text')) {
      return this.completeBatchQuery(params);
    }

    if (canonical.startsWith('update hpa_batch_queries set status = ?, error')) {
      return this.failBatchQuery(params);
    }

    if (canonical.startsWith('update hpa_batch_queries set status = ? where')) {
      return this.setBatchQueryStatus(params);
    }

    throw new Error(`Memory DB does not understand query:\n${sql}`);
  }

  // ========== Cookies ==========
  upsertCookie(params) {
    const [, cookieValue, lastIp, lastUserAgent, cfMetaJson, clientMetaJson] = params;
    const id = (cookieValue || '').trim();
    const now = new Date().toISOString();
    const current = this.cookies.get(id) || {
      cookie_value: id,
      access_count: 0,
      created_at: now,
      block_fingerprint: 0,
      block_ip: 0
    };

    current.access_count += 1;
    current.last_seen = now;
    current.last_ip = lastIp || null;
    current.last_user_agent = lastUserAgent || null;
    current.cf_meta = cfMetaJson ? safeJsonParse(cfMetaJson) : null;
    current.client_meta = clientMetaJson ? safeJsonParse(clientMetaJson) : null;

    this.cookies.set(id, current);
    return [{ affectedRows: 1 }, []];
  }

  updateCookieFlag(canonical, params) {
    const match = canonical.match(/set\s+(\w+)\s*=\s*\?/);
    const column = match ? match[1] : null;
    if (!column) return [{ affectedRows: 0 }, []];
    const [, value, cookieId] = params;
    const row = this.cookies.get(cookieId);
    if (!row) return [{ affectedRows: 0 }, []];
    row[column] = value;
    return [{ affectedRows: 1 }, []];
  }

  listBlocklist() {
    const rows = [...this.cookies.values()]
      .filter(c => c.block_fingerprint || c.block_ip)
      .map(c => ({
        cookie_value: c.cookie_value,
        last_ip: c.last_ip,
        last_user_agent: c.last_user_agent,
        block_fingerprint: c.block_fingerprint ? 1 : 0,
        block_ip: c.block_ip ? 1 : 0
      }));
    return [rows, []];
  }

  listCountrySessions() {
    const counts = new Map();
    for (const c of this.cookies.values()) {
      const country = c.cf_meta?.ipCountry || null;
      counts.set(country, (counts.get(country) || 0) + 1);
    }
    const rows = [...counts.entries()].map(([country, sessions]) => ({ country, sessions }));
    return [rows, []];
  }

  listCookiesDetailed() {
    const rows = [...this.cookies.values()]
      .sort((a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0))
      .slice(0, 50)
      .map(c => ({
        cookie_value: c.cookie_value,
        access_count: c.access_count,
        last_seen: c.last_seen,
        last_ip: c.last_ip,
        last_user_agent: c.last_user_agent,
        block_fingerprint: c.block_fingerprint ? 1 : 0,
        block_ip: c.block_ip ? 1 : 0,
        country: c.cf_meta?.ipCountry || null
      }));
    return [rows, []];
  }

  // ========== Conversations ==========
  insertConversation(params) {
    const [, uuid, cookieValue, title] = params;
    const now = new Date().toISOString();
    this.conversations.set(uuid, {
      uuid,
      cookie_value: cookieValue,
      title,
      created_at: now,
      updated_at: now
    });
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
          const msgs = (this.messages.get(conv.uuid) || []).slice().sort((a, b) => a.id - b.id);
          const firstUser = msgs.find(r => r.sender_type === 'user' && String(r.text || '').trim());
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

  touchConversation(params) {
    const [, uuid] = params;
    const conv = this.conversations.get(uuid);
    if (conv) conv.updated_at = new Date().toISOString();
    return [{ affectedRows: conv ? 1 : 0 }, []];
  }

  countConversationStats() {
    const cookieSet = new Set([...this.conversations.values()].map(c => c.cookie_value));
    return [[{ cookies: cookieSet.size, conversations: this.conversations.size }], []];
  }

  countMessageStats() {
    let count = 0;
    let tokens = 0;
    for (const list of this.messages.values()) {
      count += list.length;
      for (const msg of list) tokens += Number(msg.token_count || 0);
    }
    return [[{ message_count: count, total_tokens: tokens }], []];
  }

  // ========== Messages ==========
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
    return this.storeMessage(conversationId, type, text, null, null);
  }

  insertMessageExtended(params) {
    const [, conversationId, senderType, text, tokenCount, aiModel] = params;
    return this.storeMessage(conversationId, senderType, text, tokenCount, aiModel);
  }

  storeMessage(conversationId, senderType, text, tokenCount, aiModel) {
    const entry = {
      id: this.messageSeq++,
      conversation_uuid: conversationId,
      sender_type: senderType,
      text,
      token_count: tokenCount,
      ai_model: aiModel,
      created_at: new Date().toISOString()
    };
    const list = this.messages.get(conversationId) || [];
    list.push(entry);
    this.messages.set(conversationId, list);
    return [{ insertId: entry.id }, []];
  }

  // ========== ASO workspaces ==========
  insertWorkspace(params) {
    const [uuid, cookieValue, requestText, planJson, workspaceDir, logPath] = params;
    const now = new Date().toISOString();
    this.workspaces.set(uuid, {
      uuid,
      cookie_value: cookieValue,
      status: 'running',
      request_text: requestText,
      plan_json: planJson,
      workspace_dir: workspaceDir,
      log_path: logPath,
      message: null,
      finished_at: null,
      started_at: now,
      updated_at: now
    });
    return [{ affectedRows: 1 }, []];
  }

  updateWorkspace(canonical, params) {
    const afterSet = canonical.split(' set ')[1] || '';
    const setClause = afterSet.split(' where ')[0];
    const cols = setClause
      .split(',')
      .map(s => s.trim())
      .filter(s => s.includes('?'))
      .map(s => s.split('=')[0].trim());

    const uuid = params[params.length - 1];
    const row = this.workspaces.get(uuid);
    if (!row) return [{ affectedRows: 0 }, []];

    cols.forEach((col, i) => { row[col] = params[i]; });
    row.updated_at = new Date().toISOString();
    return [{ affectedRows: 1 }, []];
  }

  // ========== ASO artifacts ==========
  insertArtifact(params) {
    const [workspaceUuid, artifactUuid, kind, format, schemaJson, storageUri, metadataJson] = params;
    this.artifacts.push({
      workspace_uuid: workspaceUuid,
      artifact_uuid: artifactUuid,
      kind,
      format,
      schema_json: schemaJson,
      storage_uri: storageUri,
      metadata_json: metadataJson,
      created_at: new Date().toISOString()
    });
    return [{ affectedRows: 1 }, []];
  }

  // ========== Batch jobs ==========
  insertBatchJob(params) {
    const [jobId, status, totalQueries] = params;
    this.batchJobs.set(jobId, {
      job_uuid: jobId,
      status,
      total_queries: totalQueries,
      completed_queries: 0,
      created_at: new Date().toISOString(),
      finished_at: null
    });
    if (!this.batchQueries.has(jobId)) this.batchQueries.set(jobId, new Map());
    return [{ affectedRows: 1 }, []];
  }

  getBatchJob(params) {
    const [jobId] = params;
    const job = this.batchJobs.get(jobId);
    return [job ? [job] : [], []];
  }

  incrementBatchJobCompleted(params) {
    const [jobId] = params;
    const job = this.batchJobs.get(jobId);
    if (job) job.completed_queries += 1;
    return [{ affectedRows: job ? 1 : 0 }, []];
  }

  finishBatchJob(params) {
    const [status, jobId] = params;
    const job = this.batchJobs.get(jobId);
    if (job) {
      job.status = status;
      job.finished_at = new Date().toISOString();
    }
    return [{ affectedRows: job ? 1 : 0 }, []];
  }

  // ========== Batch queries ==========
  insertBatchQuery(params) {
    const [jobId, index, queryText, status] = params;
    if (!this.batchQueries.has(jobId)) this.batchQueries.set(jobId, new Map());
    this.batchQueries.get(jobId).set(index, {
      job_uuid: jobId,
      query_index: index,
      query_text: queryText,
      status,
      response_text: null,
      metadata_json: null,
      error: null,
      finished_at: null
    });
    return [{ affectedRows: 1 }, []];
  }

  listBatchQueries(params) {
    const [jobId] = params;
    const map = this.batchQueries.get(jobId);
    if (!map) return [[], []];
    const rows = [...map.values()].sort((a, b) => a.query_index - b.query_index);
    return [rows, []];
  }

  listBatchQueryStatuses(params) {
    const [jobId] = params;
    const map = this.batchQueries.get(jobId);
    if (!map) return [[], []];
    return [[...map.values()].map(q => ({ status: q.status })), []];
  }

  setBatchQueryStatus(params) {
    const [status, jobId, index] = params;
    const row = this.batchQueries.get(jobId)?.get(index);
    if (row) row.status = status;
    return [{ affectedRows: row ? 1 : 0 }, []];
  }

  completeBatchQuery(params) {
    const [status, response, metadata, jobId, index] = params;
    const row = this.batchQueries.get(jobId)?.get(index);
    if (row) {
      row.status = status;
      row.response_text = response;
      row.metadata_json = metadata;
      row.finished_at = new Date().toISOString();
    }
    return [{ affectedRows: row ? 1 : 0 }, []];
  }

  failBatchQuery(params) {
    const [status, errMsg, jobId, index] = params;
    const row = this.batchQueries.get(jobId)?.get(index);
    if (row) {
      row.status = status;
      row.error = errMsg;
      row.finished_at = new Date().toISOString();
    }
    return [{ affectedRows: row ? 1 : 0 }, []];
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
    console.warn(`[DB] Could not reach MySQL (${err.message}). Falling back to in-memory store.`);
    return new MemoryClient();
  }
}

module.exports = {
  createDbClient,
  MemoryClient
};
