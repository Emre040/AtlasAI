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
