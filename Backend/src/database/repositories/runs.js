'use strict';

const {
  createUuidV7,
  uuidBufferToString,
  uuidStringToBuffer
} = require('../../shared/ids');

const RUNS = '`atlasai`.`runs`';
const EVENTS = '`atlasai`.`run_events`';
const WORKSPACES = '`atlasai`.`aso_workspaces`';

const TOOL_KEYS = new Set([
  'deep_research_hpa',
  'investigator_hpa',
  'dictionary_expert_hpa',
  'aso_hpa',
  'clarify_hpa'
]);
const EVENT_KINDS = new Set(['started', 'progress', 'completed', 'failed']);

function jsonColumn(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function asNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function truncate(value, maximum) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > maximum ? text.slice(0, maximum) : text;
}

function toRun(row, events = []) {
  return {
    id: row.id,
    publicId: uuidBufferToString(row.public_id),
    conversationId: row.conversation_id,
    requestMessageId: row.request_message_id,
    responseMessageId: row.response_message_id ?? null,
    inferenceModelId: row.inference_model_id,
    modelConfigKey: row.model_config_key ?? null,
    toolKey: row.tool_key,
    toolCallId: row.tool_call_id ?? null,
    arguments: parseJsonColumn(row.arguments_json),
    preambleText: row.preamble_text ?? null,
    status: row.status,
    stepCount: Number(row.step_count),
    searchUrl: row.search_url ?? null,
    rowsFound: asNumber(row.rows_found),
    validationPassed: row.validation_passed === null || row.validation_passed === undefined
      ? null
      : Number(row.validation_passed) === 1,
    attempts: asNumber(row.attempts),
    workspaceId: row.workspace_id ?? null,
    workspacePublicId: row.workspace_public_id ? uuidBufferToString(row.workspace_public_id) : null,
    result: parseJsonColumn(row.result_json),
    summaryMd: row.summary_md ?? null,
    errorMessage: row.error_message ?? null,
    startedUnixMs: Number(row.started_unix_ms),
    completedUnixMs: asNumber(row.completed_unix_ms),
    events
  };
}

function toEvent(row) {
  return {
    id: row.id,
    sequenceNo: Number(row.sequence_no),
    eventKind: row.event_kind,
    stage: row.stage,
    label: row.label ?? null,
    message: row.message ?? null,
    url: row.url ?? null,
    visual: row.visual ?? null,
    detail: parseJsonColumn(row.detail_json),
    createdUnixMs: Number(row.created_unix_ms)
  };
}

class RunRepository {
  constructor(db) {
    this.db = db;
  }

  async create({
    conversationId,
    visitorId,
    requestMessageId,
    requestEventId = null,
    inferenceModelId,
    toolKey,
    toolCallId = null,
    argumentsJson,
    preambleText = null
  }) {
    if (!TOOL_KEYS.has(toolKey)) throw new TypeError(`Unknown tool key '${toolKey}'.`);
    if (argumentsJson === undefined || argumentsJson === null || typeof argumentsJson !== 'object') {
      throw new TypeError('Run arguments must be an object.');
    }
    const publicId = createUuidV7();
    const now = Date.now();
    const [result] = await this.db.execute(
      `INSERT INTO ${RUNS} (
         public_id, conversation_id, visitor_id, request_message_id, request_event_id,
         inference_model_id, tool_key, tool_call_id, arguments_json, preamble_text,
         status, started_unix_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      [
        publicId.bytes,
        conversationId,
        visitorId,
        requestMessageId,
        requestEventId,
        inferenceModelId,
        toolKey,
        truncate(toolCallId, 255),
        JSON.stringify(argumentsJson),
        preambleText ? String(preambleText) : null,
        now
      ]
    );
    return { id: result.insertId, publicId: publicId.text, startedUnixMs: now };
  }

  async addEvent(runId, sequenceNo, {
    eventKind,
    stage,
    label = null,
    message = null,
    url = null,
    visual = null,
    detail = null
  }) {
    if (!EVENT_KINDS.has(eventKind)) throw new TypeError(`Unknown run event kind '${eventKind}'.`);
    if (!Number.isInteger(sequenceNo) || sequenceNo < 0) throw new TypeError('Run event sequence must be a non-negative integer.');
    const stageText = truncate(stage || 'info', 64);
    const now = Date.now();
    const [result] = await this.db.execute(
      `INSERT INTO ${EVENTS} (
         run_id, sequence_no, event_kind, stage, label, message, url, visual, detail_json, created_unix_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        sequenceNo,
        eventKind,
        stageText,
        truncate(label, 255),
        message === null || message === undefined ? null : String(message),
        truncate(url, 2048),
        truncate(visual, 32),
        jsonColumn(detail),
        now
      ]
    );
    return { id: result.insertId, createdUnixMs: now };
  }

  async complete(runId, {
    status,
    stepCount,
    searchUrl = null,
    rowsFound = null,
    validationPassed = null,
    attempts = null,
    workspaceId = null,
    result = null,
    summaryMd = null,
    errorMessage = null
  }) {
    if (status !== 'completed' && status !== 'failed') throw new TypeError('Run completion status must be completed or failed.');
    if (status === 'failed' && !errorMessage) throw new TypeError('A failed run requires an error message.');
    const now = Date.now();
    const [update] = await this.db.execute(
      `UPDATE ${RUNS}
          SET status = ?, step_count = ?, search_url = ?, rows_found = ?, validation_passed = ?,
              attempts = ?, workspace_id = ?, result_json = ?, summary_md = ?, error_message = ?,
              completed_unix_ms = ?
        WHERE id = ? AND status = 'running'`,
      [
        status,
        Number.isInteger(stepCount) ? stepCount : 0,
        truncate(searchUrl, 2048),
        Number.isInteger(rowsFound) ? rowsFound : null,
        validationPassed === null || validationPassed === undefined ? null : (validationPassed ? 1 : 0),
        Number.isInteger(attempts) ? attempts : null,
        workspaceId,
        jsonColumn(result),
        summaryMd === null || summaryMd === undefined ? null : String(summaryMd),
        errorMessage === null || errorMessage === undefined ? null : truncate(errorMessage, 65535),
        now,
        runId
      ]
    );
    if (update.affectedRows !== 1) throw new Error('Run was not running.');
    return { completedUnixMs: now };
  }

  async setResponseMessage(runId, messageId) {
    const [update] = await this.db.execute(
      `UPDATE ${RUNS} SET response_message_id = ? WHERE id = ? AND response_message_id IS NULL`,
      [messageId, runId]
    );
    if (update.affectedRows !== 1) throw new Error('Run response message was already set.');
  }

  async findWorkspaceId(workspacePublicId) {
    if (!workspacePublicId) return null;
    const [rows] = await this.db.execute(
      `SELECT id FROM ${WORKSPACES} WHERE public_id = ? LIMIT 1`,
      [uuidStringToBuffer(workspacePublicId)]
    );
    return rows[0]?.id ?? null;
  }

  async listForConversation(conversationId) {
    const [runRows] = await this.db.execute(
      `SELECT r.*, m.config_key AS model_config_key, w.public_id AS workspace_public_id
         FROM ${RUNS} r
         JOIN \`atlasai\`.\`inference_models\` m ON m.id = r.inference_model_id
         LEFT JOIN ${WORKSPACES} w ON w.id = r.workspace_id
        WHERE r.conversation_id = ?
        ORDER BY r.id`,
      [conversationId]
    );
    if (runRows.length === 0) return [];
    const ids = runRows.map(row => row.id);
    const [eventRows] = await this.db.query(
      `SELECT * FROM ${EVENTS} WHERE run_id IN (?) ORDER BY run_id, sequence_no`,
      [ids]
    );
    const eventsByRun = new Map();
    for (const row of eventRows) {
      const list = eventsByRun.get(row.run_id) || [];
      list.push(toEvent(row));
      eventsByRun.set(row.run_id, list);
    }
    return runRows.map(row => toRun(row, eventsByRun.get(row.id) || []));
  }
}

module.exports = { RunRepository };
