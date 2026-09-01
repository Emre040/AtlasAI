'use strict';

const { createUuidV7 } = require('../../shared/ids');

const CALLS = '`atlasai`.`inference_calls`';

const COLUMNS = [
  'inference_model_id',
  'visitor_id',
  'request_event_id',
  'conversation_id',
  'run_id',
  'batch_query_id',
  'workspace_id',
  'credential_source',
  'model_selection',
  'cost_microusd',
  'purpose',
  'agent_key',
  'status',
  'streamed',
  'message_count',
  'tool_count',
  'response_format',
  'provider_request_id',
  'finish_reason',
  'tool_call_count',
  'response_characters',
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'total_tokens',
  'first_token_latency_ms',
  'total_latency_ms',
  'error_status',
  'error_code',
  'error_message',
  'request_sha256',
  'response_sha256',
  'started_unix_ms',
  'finished_unix_ms'
];

class InferenceCallRepository {
  constructor(db) {
    this.db = db;
  }

  async record(fields) {
    const unknown = Object.keys(fields).filter(name => !COLUMNS.includes(name));
    if (unknown.length > 0) throw new TypeError(`Unknown inference call field(s): ${unknown.join(', ')}.`);
    const publicId = createUuidV7();
    const entries = [['public_id', publicId.bytes], ...COLUMNS.map(name => [name, fields[name] ?? null])];
    const [result] = await this.db.execute(
      `INSERT INTO ${CALLS} (${entries.map(([name]) => `\`${name}\``).join(', ')})
       VALUES (${entries.map(() => '?').join(', ')})`,
      entries.map(([, value]) => value)
    );
    return { id: result.insertId, publicId: publicId.text };
  }
}

module.exports = { InferenceCallRepository, INFERENCE_CALL_COLUMNS: COLUMNS };
