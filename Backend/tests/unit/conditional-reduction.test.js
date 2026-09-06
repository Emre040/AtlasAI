'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateMany, aggregateStream, withColumns } = require('../../src/system/aso/studyTools');
const { createResultReducer, REDUCE_RESULT } = require('../../src/system/agents/investigatorReduce');
const { buildRequest } = require('../../src/inference/adapters/geminiGenerateContent');

const rows = () => [
  { gene: 'A', ensembl: 'a', site: 'mixed', state: 'ready', item: 'x', measurement: 0 },
  { gene: 'A', ensembl: 'a', site: 'mixed', state: 'rejected', item: 'x', measurement: -2 },
  { gene: 'A', ensembl: 'a', site: 'mixed', state: '', item: 'y', measurement: null },
  { gene: 'A', ensembl: 'a', site: 'mixed', state: null, item: 'y', measurement: 'NA' },
  { gene: 'A', ensembl: 'a', site: 'all rejected', state: 'rejected', item: 'p', measurement: 2 },
  { gene: 'A', ensembl: 'a', site: 'all rejected', state: 'rejected', item: 'q', measurement: 4 },
  { gene: 'B', ensembl: 'b', site: 'blank only', state: '', item: 'r', measurement: 0 },
  { gene: 'C', ensembl: 'c', site: null, state: null, item: null, measurement: null }
];
const stages = () => [
  { name: 'sites', group_by_columns: ['site'], measures: [
    { metrics: ['count'], as: { count: 'records' } },
    { column: 'state', metrics: ['missing'], as: { missing: 'blank_records' } },
    { metrics: ['count'], where: [{ column: 'state', op: '=', value: 'ready' }], as: { count: 'ready_records' } },
    { metrics: ['count'], where: [{ column: 'state', op: '=', value: 'rejected' }], as: { count: 'rejected_records' } },
    { column: 'item', metrics: ['distinct'], where: [{ column: 'state', op: '=', value: 'ready' }], as: { distinct: 'ready_items' } },
    { column: 'measurement', metrics: ['numeric_count', 'median', 'sum'], where: [{ column: 'state', op: '=', value: 'ready' }], as: { numeric_count: 'ready_values', median: 'ready_median', sum: 'ready_sum' } }
  ] },
  { name: 'genes', group_by_columns: [], measures: [
    { column: 'records', metrics: ['sum', 'count'], as: { sum: 'source_records', count: 'represented_sites' } },
    { metrics: ['count'], where: [{ column: 'ready_records', op: '>', value: 0 }], as: { count: 'ready_sites' } },
    { metrics: ['count'], where: [{ column: 'rejected_records', op: '=', column_b: 'records' }, { column: 'records', op: '>', value: 0 }], as: { count: 'all_rejected_sites' } },
    { metrics: ['count'], where: [{ column: 'blank_records', op: '>', value: 0 }], as: { count: 'blank_sites' } }
  ] }
];
function fixture(input = rows()) {
  const columns = ['gene', 'ensembl', 'site', 'state', 'item', 'measurement'];
  const raw = { name: 'raw', rows: withColumns(input, columns), columns, record_rows: input.map(row => row.gene !== 'C'), provenance: [{ table: 'independent.tsv' }], coverage: [{ matched_source_rows: 7 }], unresolved_inputs: 0 };
  const results = new Map([['raw', raw]]); return { raw, results, reducer: createResultReducer({ results, release: 'fixture' }) };
}
function sorted(input) { return [...input].sort((a, b) => a.gene.localeCompare(b.gene)); }

for (const reverse of [false, true]) test(`conditional stages preserve pre-filter groups, missing/zero distinction and cohort absence; reverse=${reverse}`, () => {
  const f = fixture(reverse ? rows().reverse() : rows()), before = JSON.stringify(f.raw), spec = stages();
  const out = f.reducer.reduce({ from: 'raw', stages: spec }); assert.equal(out.status, 'completed', JSON.stringify(out));
  assert.deepEqual(sorted(out.completed[1].rows), [
    { gene: 'A', ensembl: 'a', source_records: 6, represented_sites: 2, ready_sites: 1, all_rejected_sites: 1, blank_sites: 1 },
    { gene: 'B', ensembl: 'b', source_records: 1, represented_sites: 1, ready_sites: 0, all_rejected_sites: 0, blank_sites: 1 },
    { gene: 'C', ensembl: 'c', source_records: 0, represented_sites: 0, ready_sites: 0, all_rejected_sites: 0, blank_sites: 0 }
  ]);
  const site = out.completed[0].rows.find(row => row.site === 'all rejected');
  assert.equal(site.records, 2); assert.equal(site.ready_records, 0); assert.equal(site.ready_items, 0); assert.equal(site.ready_values, 0); assert.equal(site.ready_median, null); assert.equal(site.ready_sum, null);
  const observed = out.completed[0].rows.find(row => row.site === 'mixed'); assert.equal(observed.ready_median, 0); assert.equal(observed.ready_sum, 0);
  assert.equal(out.completed[0].record_rows.filter(Boolean).length, 3); assert.equal(out.completed[0].record_rows.filter(value => !value).length, 1);
  assert.deepEqual(out.completed[1].reductions.at(-1).measures, spec[1].measures); assert.equal(JSON.stringify(f.raw), before);
});

test('conditional distinct preserves exact JSON cell types and metric-named grouping predicates', () => {
  const input = [0, '0', false, 'false', { x: 1, y: 2 }, { y: 2, x: 1 }].map(item => ({ gene: 'X', ensembl: 'x', count: 'same', expected: 'same', item, status: 'include' }));
  input.push({ gene: 'Y', ensembl: 'y', count: 'other', expected: 'same', item: '0', status: 'exclude' });
  const columns = [...new Set(input.flatMap(Object.keys))], raw = { name: 'raw', columns, rows: withColumns(input, columns), record_rows: input.map(() => true), provenance: [], coverage: [] };
  const results = new Map([['raw', raw]]), reducer = createResultReducer({ results });
  const out = reducer.reduce({ from: 'raw', stages: [{ name: 'typed', group_by_columns: ['count'], measures: [{ column: 'item', metrics: ['count', 'distinct'], where: [{ column: 'COUNT', op: '=', column_b: 'expected' }], as: { count: 'matched', distinct: 'distinct_items' } }] }] });
  assert.equal(out.status, 'completed', JSON.stringify(out));
  assert.deepEqual(out.completed[0].rows.map(row => [row.gene, row.count, row.matched, row.distinct_items]), [['X', 'same', 6, 5], ['Y', 'other', 0, 0]]);
});

test('shared metric engine retains declared domains and validates every conditional metric before traversing rows', async () => {
  const data = withColumns([{ group: 'seen', value: 0 }], ['group', 'value']);
  const args = { group_by: 'group', group_domains: [{ column: 'group', values: ['seen', 'absent'] }], column: 'value', metrics: ['count', 'numeric_count', 'sum'], where: [{ column: 'value', op: '<', value: 0 }] };
  assert.deepEqual(aggregateMany(data, [args])[0], withColumns([{ group: 'seen', count: 0, numeric_count: 0, sum: null }, { group: 'absent', count: 0, numeric_count: 0, sum: null }], ['group', 'count', 'numeric_count', 'sum']));
  assert.deepEqual(await aggregateStream((async function* () { yield data[0]; })(), args, data.columns), aggregateMany(data, [args])[0]);
  let iterated = 0; const iterable = withColumns([], data.columns); iterable[Symbol.iterator] = function* () { iterated++; yield data[0]; };
  assert.throws(() => aggregateMany(iterable, [args, { ...args, where: [{ column: 'unknown', op: 'is_present' }] }]), /unknown|no column/i); assert.equal(iterated, 1); // Schema discovery only; no measure accumulated rows.
  iterated = 0; aggregateMany(iterable, [args, { ...args, where: [] }]); assert.equal(iterated, 2); // One schema traversal and one shared accumulation traversal.
});

test('native schema reuses exact classifier predicates and preserves column comparisons through Gemini conversion', () => {
  const payload = buildRequest({ messages: [{ role: 'user', content: 'schema' }], tools: [REDUCE_RESULT], reasoning_effort: 'low' }, { modelId: 'fixture' });
  const spec = payload.tools[0].functionDeclarations[0].parameters.properties.stages.items.properties.measures.items.properties;
  assert.equal(spec.where.type, 'ARRAY'); assert.equal(spec.where.items.properties.column_b.type, 'STRING');
  assert.ok(spec.where.items.properties.op.enum.includes('is_missing')); assert.equal(spec.as.type, 'STRING');
});
