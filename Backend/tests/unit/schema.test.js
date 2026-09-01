'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRequestContext } = require('../../src/http/requestContext/cloudflare');

const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'database', 'schema.sql'), 'utf8');
const executableSchema = schema.replace(/^\s*--.*$/gm, '');

test('schema is isolated to atlasai and contains no migration ledger or generic metadata columns', () => {
  assert.doesNotMatch(executableSchema, /schema_migrations/i);
  assert.doesNotMatch(executableSchema, /^\s*`[^`]*(?:metadata|extra)[^`]*`\s+/gim);
  assert.doesNotMatch(executableSchema, /`webserver_hpa`\s*\./i);
  for (const match of executableSchema.matchAll(/CREATE TABLE\s+([^\s(]+)/gi)) {
    assert.match(match[1], /^`atlasai`\.`[^`]+`$/);
  }
});

test('messages hold text only; runs, run_events, and inference_calls carry everything else', () => {
  const tableSql = name => {
    const start = schema.indexOf(`CREATE TABLE \`atlasai\`.\`${name}\``);
    assert.notEqual(start, -1, `${name} is defined`);
    return schema.slice(start, schema.indexOf('\n) ENGINE=', start));
  };
  const columns = name => new Set([...tableSql(name).matchAll(/^\s*`([^`]+)`\s+/gm)].map(match => match[1]));

  assert.deepEqual([...columns('messages')], [
    'id', 'public_id', 'conversation_id', 'parent_message_id', 'inference_call_id',
    'role', 'content_text', 'content_sha256', 'created_unix_ms'
  ]);
  assert.match(tableSql('messages'), /`role` ENUM\('user','assistant'\) NOT NULL/);

  for (const name of ['tool_key', 'arguments_json', 'preamble_text', 'status', 'step_count', 'search_url',
    'rows_found', 'validation_passed', 'attempts', 'workspace_id', 'result_json', 'summary_md',
    'request_message_id', 'response_message_id', 'request_event_id', 'started_unix_ms', 'completed_unix_ms']) {
    assert.ok(columns('runs').has(name), `runs.${name}`);
  }
  for (const name of ['run_id', 'sequence_no', 'event_kind', 'stage', 'label', 'message', 'url', 'visual', 'detail_json']) {
    assert.ok(columns('run_events').has(name), `run_events.${name}`);
  }
  for (const name of ['purpose', 'agent_key', 'run_id', 'conversation_id', 'request_event_id', 'batch_query_id',
    'workspace_id', 'provider_request_id', 'finish_reason', 'input_tokens', 'cached_input_tokens',
    'output_tokens', 'reasoning_tokens', 'total_tokens', 'first_token_latency_ms', 'total_latency_ms',
    'output_tokens_per_second', 'request_sha256', 'response_sha256', 'error_status', 'error_code', 'error_message']) {
    assert.ok(columns('inference_calls').has(name), `inference_calls.${name}`);
  }
  assert.match(tableSql('inference_calls'), /`output_tokens_per_second` DECIMAL\(10,2\) GENERATED ALWAYS AS/);
  assert.match(executableSchema, /ADD CONSTRAINT `fk_messages_inference_call`/);
});

test('stored time columns use numeric Unix values, never SQL temporal types', () => {
  assert.doesNotMatch(
    schema,
    /^\s*`[^`]+`\s+(?:TIMESTAMP|DATETIME|DATE|TIME)\b/gim
  );
  const columns = [...schema.matchAll(/^  `([^`]+)`\s+([A-Z]+)(?:\s+UNSIGNED)?\b/gm)];
  for (const [, name, type] of columns) {
    if (name.endsWith('_unix_ms')) assert.equal(type, 'BIGINT');
    assert.doesNotMatch(name, /(?:_at|_timestamp|_datetime)$/i);
  }
});

test('every parsed request field has one explicit request_events column', () => {
  const start = schema.indexOf('CREATE TABLE `atlasai`.`request_events`');
  const end = schema.indexOf('\n) ENGINE=', start);
  const tableSql = schema.slice(start, end);
  const columns = new Set([...tableSql.matchAll(/^\s*`([^`]+)`\s+/gm)].map(match => match[1]));
  const req = {
    method: 'GET',
    protocol: 'https',
    httpVersion: '1.1',
    originalUrl: '/',
    headers: { host: 'example.test' },
    socket: { remoteAddress: '127.0.0.1' },
    res: { statusCode: 200, getHeader: () => null }
  };
  const context = extractRequestContext(req, {
    enrichedHeaders: false,
    metadataSecret: null
  }, process.hrtime.bigint());
  assert.deepEqual(
    [...Object.keys(context.values).filter(name => !columns.has(name))],
    []
  );
});
