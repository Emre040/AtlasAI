'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OperationLedger, prepareSupersession } = require('../../src/system/agents/operationSupersession');
const { createResultReducer } = require('../../src/system/agents/investigatorReduce');
const { createSavedOperations } = require('../../src/system/agents/investigatorResults');

const source = { name: 'raw', rows: [{ gene: 'ONE', ensembl: 'ID1', reading: 2 }, { gene: 'ONE', ensembl: 'ID1', reading: 4 }], columns: ['gene', 'ensembl', 'reading'], record_rows: [true, true], provenance: [], coverage: [], unresolved_inputs: 0 };
const failed = { name: 'temporary', group_by_columns: [], measures: [{ column: 'reading', metrics: ['sum'], as: { wrong: 'value' } }] };
const alternative = { name: 'answer', group_by_columns: [], measures: [{ column: 'reading', metrics: ['count', 'numeric_count', 'sum'], as: { count: 'n_rows', numeric_count: 'n_numeric', sum: 'value' } }] };
const replacement = { output: 'temporary', replacements: ['answer'], reason: 'The alternative grouped computation supplies the requested counts and sum.' };

function state() {
  const results = new Map([['raw', structuredClone(source)], ['answer', { ...structuredClone(source), name: 'answer', operations: [{ tool: 'select', inputs: { artifact: 'raw' } }] }]]);
  const ledger = new OperationLedger(); ledger.set('temporary', { requirement: 'Temporary operation', why: 'invalid argument' }, { tool: 'aggregate', arguments: { artifact: 'raw', result: 'temporary', column: 'missing' }, status: 'failed', error: 'unknown field' });
  return { results, ledger, options: { results, selected: ['answer'], ledgers: [ledger] } };
}
for (const [name, mutate] of [
  ['nonexistent table', s => s.results.delete('answer')],
  ['non-table value', s => s.results.set('answer', { name: 'answer', text: 'not a table' })],
  ['partial replacement', s => s.results.get('answer').execution = { status: 'partial' }],
  ['partial ancestor', s => s.results.get('raw').execution = { status: 'partial' }],
  ['partial immediate reduction ancestor', s => { s.results.set('middle', { ...structuredClone(source), name: 'middle', execution: { status: 'partial' } }); s.results.get('answer').reductions = [{ from: 'middle', source_result: 'raw' }]; }],
  ['absent dependency', s => s.results.get('answer').operations[0].inputs.artifact = 'missing'],
  ['cyclic dependency', s => s.results.get('answer').operations[0].inputs.artifact = 'answer'],
  ['pending dependency', s => s.results.get('answer').operations[0].inputs.artifact = 'temporary'],
  ['unresolved requirement', s => s.results.get('answer').remaining_for_aso = [{ requirement: 'Required output' }]]
]) test(`${name} cannot discharge pending operations`, () => {
  const s = state(); mutate(s); const before = s.ledger.snapshot();
  assert.throws(() => prepareSupersession([replacement], s.options), /Supersession/);
  assert.deepEqual(s.ledger.snapshot(), before);
});

test('two ledgers are preflighted atomically and unselected failures stay unresolved', () => {
  const s = state(), other = new OperationLedger();
  other.set('other', { requirement: 'Other operation', why: 'failed' }, { tool: 'select', arguments: { artifact: 'raw', result: 'other' }, error: 'bad columns', status: 'failed' });
  s.options.ledgers.push(other); const before = s.options.ledgers.map(ledger => ledger.snapshot());
  assert.throws(() => prepareSupersession([replacement, { ...replacement, output: 'missing' }], s.options), /exact pending/);
  assert.deepEqual(s.options.ledgers.map(ledger => ledger.snapshot()), before);
  const prepared = prepareSupersession([replacement], s.options); assert.equal(prepared.unfinished[0].output, 'other');
  prepared.commit(); assert.deepEqual(s.ledger.snapshot(), []); assert.equal(other.snapshot().length, 1);
});

test('changed pending state rejects commitment before any ledger mutation', () => {
  const s = state(), prepared = prepareSupersession([replacement], s.options);
  s.ledger.set('new', { requirement: 'New operation', why: 'failed' }, { tool: 'select', arguments: { result: 'new' }, status: 'failed', error: 'bad' });
  assert.throws(() => prepared.commit(), /changed before/); assert.equal(s.ledger.snapshot().length, 2);
});

test('actual saved-operation failure records exact arguments and can be explicitly replaced', async () => {
  const results = new Map([['raw', structuredClone(source)]]), saved = createSavedOperations({ results });
  const args = { artifact: 'raw', result: 'temporary', columns: ['not recorded'] };
  await assert.rejects(() => saved.execute('select', args), /no column/);
  await saved.execute('select', { artifact: 'raw', result: 'answer', columns: ['gene', 'reading'] });
  const prepared = prepareSupersession([replacement], { results, selected: ['answer'], ledgers: [saved.operationLedger] });
  assert.deepEqual(prepared.dispositions[0].failures[0].arguments, args); prepared.commit(); assert.deepEqual(saved.unfinished(), []);
});

test('same-name repaired reductions retain their existing completion path', () => {
  const results = new Map([['raw', structuredClone(source)]]), reducer = createResultReducer({ results });
  assert.equal(reducer.reduce({ from: 'raw', stages: [failed] }).status, 'partial');
  assert.equal(reducer.reduce({ from: 'raw', stages: [{ ...alternative, name: 'temporary' }] }).status, 'completed');
  const prepared = prepareSupersession(undefined, { results, selected: ['temporary'], ledgers: [reducer.operationLedger] });
  assert.deepEqual(prepared.unfinished, []); assert.deepEqual(prepared.dispositions, []);
});

test('a failed reduction repaired under the same name by a registered saved operation is complete', async () => {
  const results = new Map([['raw', structuredClone(source)]]), reducer = createResultReducer({ results }), saved = createSavedOperations({ results });
  assert.equal(reducer.reduce({ from: 'raw', stages: [failed] }).status, 'partial');
  await saved.execute('aggregate', { artifact: 'raw', result: 'temporary', group_by_columns: ['gene', 'ensembl'], column: 'reading', metrics: ['sum'] });
  assert.equal(results.get('temporary').rows[0].sum, 6);
  const prepared = prepareSupersession(undefined, { results, selected: ['temporary'], ledgers: [reducer.operationLedger, saved.operationLedger] });
  assert.deepEqual(prepared.unfinished, []); assert.deepEqual(prepared.dispositions, []);
});

test('complete immediate and raw reduction ancestors permit explicit replacement', () => {
  const s = state(); s.results.set('middle', { ...structuredClone(source), name: 'middle', reductions: [{ from: 'raw', source_result: 'raw' }] });
  s.results.get('answer').reductions = [{ from: 'raw', source_result: 'raw' }, { from: 'middle', source_result: 'raw' }];
  const prepared = prepareSupersession([replacement], s.options); prepared.commit();
  assert.deepEqual(prepared.unfinished, []); assert.equal(prepared.dispositions[0].output, 'temporary');
});
