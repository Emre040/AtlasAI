'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');

const entry = { file: 'observations.tsv', title: 'Source observations', key: 'ensembl', columns: ['Gene', 'Sample', 'Value'] };
const lookup = { table: entry.file, match_column: 'Gene', mode: 'rows', columns: ['Sample', 'Value'] };
const apply = name => ['apply_bulk', { name, lookups: [lookup] }];
const finish = ['finish', { results: ['observed'], answer: 'Source observations returned.', not_in_release: [] }];

async function study({ decide, ctx = {}, onRead }) {
  const filename = require.resolve('../../src/system/agents/investigatorBulk');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireOriginal = loaded.require.bind(loaded), requests = [];
  let sourceReads = 0;
  const stubs = {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test-release' }; } },
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      const action = await decide({ request, turn: requests.length });
      const message = action ? { role: 'assistant', tool_calls: [{ type: 'function', id: `c${requests.length}`, thought_signature: 'native-signature', function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } : { role: 'assistant', content: 'Unfinished reasoning' };
      return { choices: [{ message }], usage: { prompt_tokens: 4, completion_tokens: 1 } };
    } } } } }
  };
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : requireOriginal(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const gene = { gene: 'ONE', ensembl: 'ID1' };
  const rows = Array.from({ length: 12 }, (_, i) => ({ Gene: gene.ensembl, Sample: `sample-${i}`, Value: String(i) }));
  const adapter = {
    async catalog() { return [entry]; }, async entry(file) { return file === entry.file ? entry : null; },
    async resolveGenes() { return [gene]; }, async read() { return { entry, rows }; },
    async readMany() { sourceReads++; onRead?.(); return { entry, byGene: new Map([[gene.ensembl, rows]]) }; },
    definition() { return ''; }
  };
  const result = await loaded.exports({ genes: ['ONE'], question: 'Retrieve all source observations and assess the requested views.' }, ctx, adapter);
  return { result, requests, sourceReads };
}

test('productive bulk result views can exceed eight native inference turns', async () => {
  const { result, requests, sourceReads } = await study({ decide: ({ request, turn }) => {
    assert.doesNotMatch(JSON.stringify(request.messages), /model turns remain|eight turns/);
    if (turn === 1) return apply('observed');
    if (turn <= 11) return ['open_result', { name: 'observed', rows: 1, offset: turn - 2, columns: ['Sample', 'Value'] }];
    assert.equal(request.messages[2].tool_calls[0].thought_signature, 'native-signature');
    assert.equal(request.messages[3].tool_call_id, 'c1');
    return finish;
  } });
  assert.equal(requests.length, 12); assert.equal(sourceReads, 1);
  assert.equal(result.status, 'ok'); assert.equal(result.tables[0].rows.length, 12);
  assert.deepEqual(result.tokens.total, { prompt: 48, completion: 12, total: 60 });
});

test('new result names do not rerun an identical bulk computation or manufacture progress', async () => {
  const { result, requests, sourceReads } = await study({ decide: ({ request, turn }) => {
    if (turn === 3) {
      const receipt = JSON.parse(request.messages.at(-1).content);
      assert.equal(receipt.already_available, true); assert.equal(receipt.name, 'observed');
      assert.equal(receipt.previous_call_id, 'c1');
    }
    return apply(turn === 1 ? 'observed' : `renamed-${turn}`);
  } });
  assert.equal(requests.length, 3); assert.equal(sourceReads, 1);
  assert.equal(result.stop_reason, 'no_progress_cycle'); assert.equal(result.status, 'partial');
  assert.equal(result.tables.length, 1); assert.equal(result.tables[0].name, 'observed');
  assert.equal(result.remaining_for_aso.length, 1);
});

test('a repeated rejected finish stays incomplete without inferred success', async () => {
  const { result, requests } = await study({ decide: () => ['finish', { results: [], answer: 'Complete!', not_in_release: [] }] });
  assert.equal(requests.length, 2); assert.equal(result.stop_reason, 'no_progress_cycle');
  assert.equal(result.status, 'incomplete'); assert.equal(result.found, false);
  assert.notEqual(result.answer, 'Complete!');
});

test('repeated text-only decisions stop without a hidden inference retry ceiling', async () => {
  const { result, requests } = await study({ decide: () => null });
  assert.equal(requests.length, 2); assert.equal(result.stop_reason, 'no_progress_cycle');
  assert.equal(result.found, false); assert.equal(result.tokens.total.total, 10);
});

test('the caller token budget retains a completed bulk result and its actual usage', async () => {
  const { result, requests, sourceReads } = await study({ ctx: { budget: { total_tokens: 5 } }, decide: () => apply('observed') });
  assert.equal(requests.length, 1); assert.equal(sourceReads, 1);
  assert.equal(result.status, 'partial'); assert.equal(result.stop_reason, 'token_budget_exhausted');
  assert.equal(result.tables[0].rows.length, 12); assert.equal(result.tokens.total.total, 5);
});

test('cancellation during a source operation preserves its completed table without another inference', async () => {
  const controller = new AbortController();
  const { result, requests } = await study({ ctx: { signal: controller.signal }, onRead: () => controller.abort(), decide: () => apply('observed') });
  assert.equal(requests.length, 1); assert.equal(result.stop_reason, 'cancelled');
  assert.equal(result.status, 'partial'); assert.equal(result.tables[0].rows.length, 12);
});

test('a bad shared admission decision for a tool fails explicitly without a model repair call', async () => {
  const { result, requests, sourceReads } = await study({ ctx: { runControl: { async checkpoint(event) { return event.phase === 'Bulk tool' ? undefined : { allowed: true }; } } }, decide: () => apply('observed') });
  assert.equal(requests.length, 1); assert.equal(sourceReads, 0); assert.equal(result.found, false);
  assert.match(result.error, /allowed: true or allowed: false/);
});

test('an explicit shared stop or expired deadline prevents inference and reports its exact reason', async () => {
  for (const [ctx, reason] of [[{ budget: { deadline_unix_ms: 0 } }, 'deadline_reached'], [{ runControl: { async checkpoint() { return { allowed: false, reason: 'shared_exhausted' }; } } }, 'shared_exhausted']]) {
    const { result, requests, sourceReads } = await study({ ctx, decide: () => { throw new Error('No admitted model call'); } });
    assert.equal(requests.length, 0); assert.equal(sourceReads, 0); assert.equal(result.stop_reason, reason);
  }
});
