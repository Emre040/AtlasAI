'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StudyContext, bytes } = require('../../src/system/aso/studyContext');
const { StudyConversation } = require('../../src/system/aso/studyConversation');
const { executeBatch } = require('../../src/system/aso/batchOperations');
const { signature } = require('../../src/system/aso/toolHelp');

function state(turn = 1) {
  return { turn, goal: 'An unrelated research goal', plan: [{ text: 'Analyze observations', status: 'doing', artifacts: [], kind: 'table' }], notes: ['Use the original units (o1)'], artifacts: [], running: new Map() };
}

test('all native exchanges, provider signatures and original evidence survive without compaction', () => {
  const archive = new StudyContext({ budgetBytes: 4096 });
  const conversation = new StudyConversation({ goal: 'Keep the exact scientific question', budgetBytes: 4096, archive });
  const current = state();
  for (let turn = 1; turn <= 15; turn++) {
    current.turn = turn;
    const snapshot = conversation.prepare(current, 20);
    if (turn > 1) assert.match(JSON.stringify(snapshot.messages), /evidence from turn 1:/);
    assert.equal(snapshot.messages[0].content, 'GOAL\nKeep the exact scientific question');
    const calls = new Set();
    for (const message of snapshot.messages) {
      for (const call of message.tool_calls || []) { calls.add(call.id); assert.equal(call.thought_signature, 'opaque-provider-state'); }
      if (message.role === 'tool') { assert.ok(calls.has(message.tool_call_id)); calls.delete(message.tool_call_id); }
    }
    assert.equal(calls.size, 0);
    if (turn > 1) assert.match(JSON.stringify(snapshot.messages), new RegExp(`evidence from turn ${turn - 1}`));
    conversation.acknowledge(snapshot);
    const id = archive.add(`evidence from turn ${turn}: ${'測定🧬'.repeat(40)}`);
    const view = conversation.result([id], 1000);
    conversation.append({ role: 'assistant', tool_calls: [{ id: `c${turn}`, type: 'function', thought_signature: 'opaque-provider-state', function: { name: 'open', arguments: '{}' } }] }, [{ message: { role: 'tool', tool_call_id: `c${turn}`, content: view.text }, deliveries: view.deliveries }]);
  }
  assert.equal(conversation.compactions, 0);
  assert.ok(bytes(JSON.stringify(conversation.prepare(current, 20).messages)) > 4096);
  assert.equal(archive.records.size, 15);
});

test('a waiting first item does not hide other unfinished work from the current turn', () => {
  const archive = new StudyContext();
  const conversation = new StudyConversation({ goal: 'Independent evidence and calculations', archive });
  const current = state(3);
  current.plan = [
    { text: 'Await the requested search', kind: 'gene_set', status: 'doing', artifacts: [] },
    { text: 'Already calculated', kind: 'table', status: 'done', artifacts: ['a1'] },
    { text: 'Independent calculation', kind: 'table', status: 'todo', artifacts: [] }
  ];
  current.running.set('t1', { id: 't1', tool: 'deep_research_hpa', args: { goal: 'Requested search' } });
  const update = conversation.prepare(current, 10).messages.at(-1).content;
  assert.match(update, /1\. \[doing\] Await the requested search/);
  assert.match(update, /3\. \[todo\] Independent calculation/);
  assert.doesNotMatch(update, /Already calculated/);
  assert.match(update, /t1 deep_research_hpa/);
});

test('current bookkeeping is replaced while asynchronous source evidence stays in history', () => {
  const archive = new StudyContext();
  const conversation = new StudyConversation({ goal: 'Retain evidence', archive });
  archive.add('Source measurement: 37.5 mg', { source: 'artifact a1' });
  const current = state(1);
  const first = conversation.prepare(current, 10);
  conversation.acknowledge(first);
  current.turn = 2;
  current.plan[0].status = 'done';
  const second = conversation.prepare(current, 10);
  const all = JSON.stringify(second.messages);
  assert.equal(second.messages.filter(m => m.content?.startsWith('TURN ')).length, 1);
  assert.doesNotMatch(all, /TURN 1\/10/);
  assert.match(all, /TURN 2\/10/);
  assert.equal(all.match(/Source measurement: 37.5 mg/g).length, 1);
  assert.equal(conversation.compactions, 0);
});

test('compact help retains required fields, optional fields, enums and arbitrary key types', () => {
  assert.equal(signature({ name: 'operation', parameters: { type: 'object', required: ['input'], properties: {
    input: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] }, mapping: { type: 'object', additionalProperties: { type: 'string' } }
  } } }), 'operation({input: string, direction?: "asc" | "desc", mapping?: {[key: string]: string}})');
});

test('observation allocation spends available space on large results without clipping small ones', () => {
  const archive = new StudyContext({ budgetBytes: 8192 });
  const conversation = new StudyConversation({ goal: 'question', budgetBytes: 8192, archive });
  const large = archive.add('field: '.repeat(200));
  const small = archive.add('one exact value');
  const result = conversation.result([large, small], 2300);
  assert.match(result.text, /one exact value/);
  assert.equal(result.deliveries[0].end, archive.records.get(large).record.text.length);
  assert.equal(result.deliveries[1].end, archive.records.get(small).record.text.length);
});

test('late asynchronous evidence is neither acknowledged early nor duplicated alongside a native result', () => {
  const archive = new StudyContext({ budgetBytes: 8192 });
  const conversation = new StudyConversation({ goal: 'question', budgetBytes: 8192, archive });
  const id = archive.add('native evidence');
  const view = conversation.result([id], 2048);
  conversation.append({ role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'open', arguments: '{}' } }] }, [{ message: { role: 'tool', tool_call_id: 'c', content: view.text }, deliveries: view.deliveries }]);
  const sent = conversation.prepare(state(), 5);
  const late = archive.add('asynchronous completion');
  conversation.acknowledge(sent);
  assert.ok(archive.pending.has(late));
  assert.ok(!archive.pending.has(id));
  assert.equal(JSON.stringify(sent.messages).match(/native evidence/g).length, 1);
  const next = conversation.prepare(state(2), 5);
  assert.ok(next.deliveries.some(d => d.id === late));
  assert.equal(JSON.stringify(next.messages).match(/asynchronous completion/g).length, 1);
});

test('search excludes model drafts, control feedback and previous searches and returns bounded evidence snippets', () => {
  const archive = new StudyContext({ budgetBytes: 8192 });
  archive.add('marker WRONG DRAFT', { kind: 'decision' });
  archive.add('marker UNSUPPORTED', { kind: 'control' });
  const ids = Array.from({ length: 40 }, (_, i) => archive.add(`${'prefix '.repeat(200)}marker measured observation ${i} ${' detail'.repeat(1000)}`));
  for (let round = 0; round < 20; round++) {
    const id = archive.recall({ query: 'marker', limit: 3, offset: 3 });
    const text = archive.records.get(id).record.text;
    assert.match(text, /40 evidence observations match/);
    assert.doesNotMatch(text, /WRONG DRAFT|UNSUPPORTED|recall search/);
    assert.ok(bytes(text) < 1600);
    assert.match(text, new RegExp(`${ids.at(-4)} `));
    assert.match(text, /Next search offset=6/);
  }
});

const specifications = new Map([['transform', { parameters: { type: 'object', properties: { artifact: { type: 'string' }, factor: { type: 'number' } }, required: ['artifact'] } }]]);
const step = (id, artifact, extra = {}) => ({ id, tool: 'transform', args: JSON.stringify({ artifact, ...extra }) });

test('batch executes arbitrary dependency graphs and passes actual generated artifact IDs', async () => {
  let active = 0, peak = 0;
  const executed = [];
  const result = await executeBatch({ steps: [step('left', 'source-x'), step('right', 'source-y'), step('child', '@left', { factor: 7 })], outputs: ['child', 'right'] }, {
    specifications, concurrency: 2, execute: async (name, args) => {
      active++; peak = Math.max(active, peak); executed.push(args);
      await new Promise(resolve => setImmediate(resolve));
      active--; return { ok: true, artifact: { id: `${args.artifact}-result` }, observation: `o${executed.length}` };
    }
  });
  assert.equal(peak, 2);
  assert.equal(result.status, 'completed');
  assert.deepEqual(executed[2], { artifact: 'source-x-result', factor: 7 });
  assert.deepEqual(result.outputs.map(r => r.artifact.id), ['source-x-result-result', 'source-y-result']);
});

test('invalid batch shapes and cycles fail before any operation; runtime failures block only descendants', async () => {
  let calls = 0;
  const engine = { specifications, concurrency: 2, execute: async (name, args) => { calls++; if (args.artifact === 'broken') throw new Error('source missing'); return { ok: true, artifact: { id: 'valid-result' } }; } };
  for (const steps of [[step('a', '@b'), step('b', '@a')], [step('a', 'valid'), step('b', 'valid', { typo: 7 })], [step('a', '@unknown')]]) {
    await assert.rejects(() => executeBatch({ steps, outputs: ['a'] }, engine));
    assert.equal(calls, 0);
  }
  const result = await executeBatch({ steps: [step('a', 'broken'), step('b', '@a'), step('c', 'valid')], outputs: ['b', 'c'] }, engine);
  assert.equal(calls, 2);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.steps.map(s => s.status), ['failed', 'blocked', 'done']);
  assert.deepEqual(result.outputs.map(s => s.id), ['c']);
});
