'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StudyContext, ContextBudgetError, bytes } = require('../../src/system/aso/studyContext');
const { readPage, rowPageOptions, formatPage } = require('../../src/system/aso/observationViews');
const { profile } = require('../../src/system/aso/studyTools');

function brief(overrides = {}) {
  return { goal: 'Compare observations', plan: [], notes: [], running: new Map(), artifacts: [], turn: 1, maxTurns: 40, ...overrides };
}

test('an asynchronous result arriving during inference is delivered on the next request', () => {
  const memory = new StudyContext({ budgetBytes: 16384 });
  const first = memory.add('first result');
  const sent = memory.render(brief());
  const late = memory.add('agent completed while model was thinking');
  memory.acknowledge(sent);
  assert.ok(!memory.pending.has(first));
  assert.ok(memory.pending.has(late));
  const next = memory.render(brief({ turn: 2 }));
  assert.ok(next.deliveries.some(d => d.id === late));
  assert.match(next.text, /agent completed while model was thinking/);
});

test('large observations survive multiple bounded pages, including Unicode and long cells', async () => {
  const memory = new StudyContext({ budgetBytes: 2400 });
  const raw = 'A long cell: ' + '🧬β1234'.repeat(2000) + ' LAST VALUE 987.654';
  const id = memory.add(raw, { source: 'open mapping.tsv' });
  let recovered = '', iterations = 0;
  while (memory.pending.has(id)) {
    const snapshot = memory.render(brief());
    assert.ok(bytes(snapshot.text) <= 2400);
    const delivered = snapshot.deliveries.find(d => d.id === id);
    assert.ok(delivered && delivered.end > delivered.offset);
    recovered += raw.slice(delivered.offset, delivered.end);
    assert.ok(!/[\uD800-\uDBFF]$/.test(raw.slice(delivered.offset, delivered.end)));
    memory.acknowledge(snapshot);
    if (delivered.end < raw.length) memory.recall({ id, offset: delivered.end });
    assert.ok(++iterations < 100);
  }
  assert.equal(recovered, raw);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aso-context-test-'));
  try {
    await memory.flush(dir);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8')).text, raw);
    await memory.flush(dir); // already persisted observations are not rewritten
  } finally { await fs.rm(dir, { recursive: true }); }
});

test('old observations remain searchable and recoverable after the working set fills', () => {
  const memory = new StudyContext({ budgetBytes: 3000 });
  const mapping = memory.add('Rare mapping: entity Y corresponds to label Z\n' + 'detail '.repeat(90), { source: 'describe mapping.tsv' });
  memory.acknowledge(memory.render(brief()));
  for (let i = 0; i < 80; i++) {
    memory.add(`result ${i}: ${'x'.repeat(300)}`, { source: `describe dataset${i}.tsv`, refs: [`dataset${i}.tsv`] });
    memory.acknowledge(memory.render(brief()));
  }
  assert.ok(memory.render(brief()).manifest.omitted.includes(mapping));
  memory.recall({ query: 'Rare mapping' });
  assert.match(memory.render(brief()).text, /o1.*Rare mapping/);
  memory.recall({ id: mapping, keep: true });
  assert.match(memory.render(brief()).text, /entity Y corresponds to label Z/);
  assert.ok(memory.pinned.has(mapping));
  memory.recall({ id: mapping, keep: false });
  assert.ok(!memory.pinned.has(mapping));
});

test('mandatory goal and decisions are never silently truncated to meet a budget', () => {
  const memory = new StudyContext({ budgetBytes: 2000 });
  assert.throws(() => memory.render(brief({ notes: ['A'.repeat(4000)] })), ContextBudgetError);
  for (const budgetBytes of [0, -1, 1.5, NaN, '4096']) assert.throws(() => new StudyContext({ budgetBytes }), /positive integer/);
});

test('a derived artifact replaces intermediate detail without deleting its evidence', () => {
  const memory = new StudyContext({ budgetBytes: 16384 });
  const old = memory.add('raw result: old value 12', { source: 'artifact a1', refs: ['a1'] });
  const a1 = { id: 'a1', kind: 'data', size: '8 rows', tool: 'filter', inputs: [], columns: ['gene'] };
  memory.acknowledge(memory.render(brief({ artifacts: [a1] })));
  memory.add('derived result: new value 24', { source: 'artifact a2', refs: ['a2', 'a1'] });
  const a2 = { ...a1, id: 'a2', tool: 'compute', inputs: ['a1'] };
  const rendered = memory.render(brief({ artifacts: [a1, a2] }));
  assert.doesNotMatch(rendered.text, /old value 12/);
  assert.match(rendered.text, /new value 24/);
  assert.ok(rendered.manifest.omitted.includes(old));
  memory.recall({ id: old });
  assert.match(memory.render(brief({ artifacts: [a1, a2] })).text, /old value 12/);
});

test('describing different columns does not erase the earlier schema observation', () => {
  const memory = new StudyContext({ budgetBytes: 16384 });
  memory.add('Known field: abundance', { source: 'describe data.tsv', refs: ['data.tsv'], projection: ['abundance'] });
  memory.acknowledge(memory.render(brief()));
  memory.add('Known field: category', { source: 'describe data.tsv', refs: ['data.tsv'], projection: ['category'] });
  memory.acknowledge(memory.render(brief()));
  const text = memory.render(brief()).text;
  assert.match(text, /Known field: abundance/);
  assert.match(text, /Known field: category/);
});

test('a profile preserves rare category values and complete example strings', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ category: `common ${i % 5}` }));
  const rare = 'rare category with a label longer than forty characters';
  rows.push({ category: rare });
  const [card] = profile(rows, ['category']);
  assert.ok(card.observed_values.includes(rare));
  assert.equal(card.observed_values.length, 6);
  const [long] = profile([{ category: rare }], ['category']);
  assert.equal(long.full_examples[0], rare);
});

test('control restrictions are in the exact request snapshot with their explanation', () => {
  const snapshot = new StudyContext({ budgetBytes: 16384 }).render(brief({ notice: 'open is unavailable this turn: revise the plan', notes: ['mapping o1'], running: new Map([['t1', { id: 't1', tool: 'agent', args: { goal: 'working' } }]]) }));
  assert.match(snapshot.text, /open is unavailable this turn: revise the plan/);
  assert.match(snapshot.text, /1\. mapping o1/);
  assert.match(snapshot.text, /t1 agent/);
});

test('lookup inspection uses an extra row to distinguish a page from a complete table', async () => {
  async function* rows(count) { for (let i = 0; i < count; i++) yield { label: `label ${i}`, long: 'z'.repeat(300) }; }
  const first = await readPage(rows(17), rowPageOptions({ rows: 10 }));
  assert.equal(first.more, true);
  assert.equal(first.total, null);
  assert.match(formatPage(first, ['label', 'long']), /total not counted; more rows: open offset=10/);
  assert.match(formatPage(first, ['long']), new RegExp('z'.repeat(300)));
  const last = await readPage(rows(17), rowPageOptions({ rows: 10, offset: 10 }));
  assert.equal(last.total, 17);
  assert.equal(last.more, false);
  assert.equal(last.rows.length, 7);
  const exact = await readPage(rows(10), rowPageOptions({ rows: 10 }));
  assert.equal(exact.total, 10);
  assert.equal(exact.more, false);
  assert.deepEqual(rowPageOptions({ rows: 257 }), { rows: 257, offset: 0 });
  for (const options of [{ rows: 0 }, { rows: 1.5 }, { rows: Number.MAX_SAFE_INTEGER + 1 }, { offset: -1 }, { offset: 1.5 }]) assert.throws(() => rowPageOptions(options));
});

test('compact pages preserve exact column ordering, special characters, zeros and nulls', () => {
  const columns = ['original measurement name', 'identifier', 'flag'];
  const rows = [{ identifier: 'line\nquoted "雪"', 'original measurement name': 0, flag: false }, { identifier: '', 'original measurement name': null, flag: true }];
  const text = formatPage({ rows, offset: 0, total: 2, more: false }, columns);
  const encoded = JSON.parse(text.slice(text.indexOf('\n') + 1));
  const decoded = encoded.rows.map(values => Object.fromEntries(encoded.columns.map((column, i) => [column, values[i]])));
  assert.deepEqual(decoded, rows);
});
