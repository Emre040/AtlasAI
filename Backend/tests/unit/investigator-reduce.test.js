'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { createResultReducer, REDUCE_RESULT } = require('../../src/system/agents/investigatorReduce');
const { withColumns, aggregate, AGGREGATE_METRICS } = require('../../src/system/aso/studyTools');

const stages = () => [
  { name: 'observations', group_by_columns: ['location', 'observation'], measures: [{ column: 'reading', metrics: ['median', 'count', 'numeric_count'], as: { median: 'observation_value', count: 'record_count', numeric_count: 'numeric_record_count' } }] },
  { name: 'entities', group_by_columns: ['location'], measures: [
    { column: 'observation_value', metrics: ['median', 'count', 'numeric_count'], as: { median: 'entity_value', count: 'observation_count', numeric_count: 'numeric_observation_count' } },
    { column: 'record_count', metrics: ['sum'], as: { sum: 'record_count' } },
    { column: 'numeric_record_count', metrics: ['sum'], as: { sum: 'numeric_record_count' } }
  ] }
];
function table(rows, name = 'raw') {
  const columns = ['gene', 'ensembl', 'location', 'observation', 'reading'];
  return { name, rows: withColumns(rows.map(row => { const { real, ...values } = row; return values; }), columns), columns, created_columns: columns.slice(2),
    record_rows: rows.map(row => row.real !== false), provenance: [{ table: 'unseen-source.tsv', mode: 'rows', columns: columns.slice(2), source_hash: 'fixture-hash', unit: 'source-unit' }],
    coverage: [{ table: 'unseen-source.tsv', matched_source_rows: rows.filter(row => row.real !== false).length }], unresolved_inputs: 0 };
}
const records = (gene = 'ONE', ensembl = 'ID1', location = 'site') => [0, 0, 0, 10, 20].map((reading, i) => ({ gene, ensembl, location, observation: i < 3 ? 'A' : i === 3 ? 'B' : 'C', reading: String(reading) }));
function fixture(rows) { const raw = table(rows), results = new Map([[raw.name, raw]]); return { raw, results, reducer: createResultReducer({ results, release: 'fixture-release' }) }; }

test('nested group medians preserve unbalanced records and exact raw evidence', () => {
  const f = fixture(records()); const before = JSON.stringify(f.raw);
  const out = f.reducer.reduce({ from: 'raw', stages: stages() });
  assert.equal(out.status, 'completed'); assert.deepEqual(out.completed.map(row => row.name), ['observations', 'entities']);
  const row = f.results.get('entities').rows[0];
  assert.equal(row.entity_value, 10); assert.equal(aggregate(f.raw.rows, { column: 'reading', metrics: ['median'] })[0].median, 0);
  assert.equal(row.observation_count, 3); assert.equal(row.record_count, 5); assert.equal(row.numeric_record_count, 5);
  assert.equal(JSON.stringify(f.raw), before); assert.equal(f.results.size, 3);
  const reduction = f.results.get('entities').reductions.at(-1);
  assert.equal(reduction.input_rows, 3); assert.equal(reduction.input_row_kind, 'reduced_group');
  assert.equal(reduction.hpa_version, 'fixture-release'); assert.equal(reduction.source_result, 'raw');
  assert.deepEqual(f.results.get('entities').coverage, f.raw.coverage); assert.deepEqual(f.results.get('entities').provenance, f.raw.provenance);
});

test('identity and exact tuple grouping resist delimiter and Unicode collisions', () => {
  const rows = [
    ...records('A|B', 'ID1', 'C'), ...records('A', 'ID2', 'B|C'),
    ...records('A|B', 'ID1', 'β/\u001f雪'), ...records('A|B', 'ID3', 'C')
  ];
  const f = fixture(rows); const result = f.reducer.reduce({ from: 'raw', stages: stages() });
  assert.equal(result.status, 'completed'); const final = f.results.get('entities').rows;
  assert.equal(final.length, 4); assert.equal(new Set(final.map(row => JSON.stringify([row.gene, row.ensembl, row.location]))).size, 4);
  assert.ok(final.every(row => row.entity_value === 10 && row.record_count === 5));
});

test('missing measurements and unknown grouping identifiers remain distinct from absent source records', () => {
  const f = fixture([
    { gene: 'ONE', ensembl: 'ID1', location: 'mixed', observation: 'A', reading: '-4' },
    { gene: 'ONE', ensembl: 'ID1', location: 'mixed', observation: 'B', reading: '0' },
    ...['', 'NA', null, 'unmeasured'].map(reading => ({ gene: 'ONE', ensembl: 'ID1', location: 'all-missing', observation: null, reading })),
    { gene: 'ABSENT', ensembl: 'ID2', location: null, observation: null, reading: null, real: false }
  ]);
  const result = f.reducer.reduce({ from: 'raw', stages: stages() }); assert.equal(result.status, 'completed');
  const final = f.results.get('entities'), mixed = final.rows.find(row => row.location === 'mixed'), missing = final.rows.find(row => row.location === 'all-missing'), absent = final.rows.find(row => row.gene === 'ABSENT');
  assert.equal(mixed.entity_value, -2); assert.equal(mixed.observation_count, 2);
  assert.equal(missing.entity_value, null); assert.equal(missing.observation_count, 1); assert.equal(missing.numeric_observation_count, 0); assert.equal(missing.record_count, 4); assert.equal(missing.numeric_record_count, 0);
  assert.equal(final.reductions[0].missing_grouping_key_rows.observation, 4);
  assert.match(final.reductions[1].count_semantics, /not proof of identifiable independent samples/);
  assert.equal(absent.entity_value, null); assert.equal(absent.observation_count, 0); assert.equal(absent.record_count, 0); assert.equal(absent.numeric_record_count, 0);
  assert.equal(final.record_rows[final.rows.indexOf(absent)], false); assert.equal(final.reductions[1].input_placeholders, 1);
});

test('empty count sums retain zero only through recorded metric lineage, never an alias', () => {
  const f = fixture([...records(), { gene: 'ABSENT', ensembl: 'ID2', location: null, observation: null, reading: null, real: false }]);
  const chain = stages(); chain[1].measures.push({ column: 'observation_value', metrics: ['sum'], as: { sum: 'misleading_count_alias' } });
  chain.push({ name: 'third', group_by_columns: [], measures: [
    { column: 'record_count', metrics: ['sum'], as: { sum: 'arbitrary_output' } },
    { column: 'misleading_count_alias', metrics: ['sum'], as: { sum: 'other_count_alias' } }
  ] });
  const outcome = f.reducer.reduce({ from: 'raw', stages: chain }); assert.equal(outcome.status, 'completed');
  const row = f.results.get('third').rows.find(row => row.gene === 'ABSENT');
  assert.equal(row.arbitrary_output, 0); assert.equal(row.other_count_alias, null);
  const lineage = f.results.get('third').reductions.at(-1).outputs;
  assert.equal(lineage.find(output => output.column === 'arbitrary_output').quantity, 'count');
  assert.equal(lineage.find(output => output.column === 'other_count_alias').quantity, 'measurement');
});

test('an explicitly selected identifiable observation count excludes missing identifiers', () => {
  const f = fixture([{ gene: 'ONE', ensembl: 'ID1', location: 'site', observation: null, reading: '9' }, ...records()]);
  const chain = stages(); chain[1].measures.push({ column: 'observation', metrics: ['distinct'], as: { distinct: 'identified_observations' } });
  const result = f.reducer.reduce({ from: 'raw', stages: chain }); assert.equal(result.status, 'completed');
  const row = f.results.get('entities').rows[0]; assert.equal(row.observation_count, 4); assert.equal(row.identified_observations, 3);
});

test('grouping fields named like metrics and arbitrary output aliases do not collide internally', () => {
  const raw = table(records()); raw.rows = withColumns(raw.rows.map(row => ({ ...row, count: row.location })), [...raw.columns, 'count']); raw.columns = [...raw.columns, 'count'];
  const results = new Map([['raw', raw]]), reducer = createResultReducer({ results });
  const outcome = reducer.reduce({ from: 'raw', stages: [{ name: 'grouped', group_by_columns: ['count'], measures: [{ column: 'reading', metrics: ['count', 'median'], as: { count: '__proto__', median: 'constructor' } }] }] });
  assert.equal(outcome.status, 'completed'); const row = results.get('grouped').rows[0];
  assert.equal(row.count, 'site'); assert.ok(Object.hasOwn(row, '__proto__')); assert.equal(row.__proto__, 5); assert.equal(row.constructor, 0);
});

test('unknown fields, conflicting aliases and unsupported metrics fail explicitly', () => {
  for (const bad of [
    { column: 'guessed', metrics: ['mean'] },
    { column: 'reading', metrics: ['mean'], as: { mean: 'gene' } },
    { column: 'reading', metrics: ['mean'], as: { median: 'unexpected' } }
  ]) {
    const f = fixture(records()), out = f.reducer.reduce({ from: 'raw', stages: [{ name: 'bad', group_by_columns: [], measures: [bad] }] });
    assert.equal(out.status, 'partial'); assert.equal(f.results.size, 1); assert.equal(f.reducer.unfinished().length, 1);
  }
  const f = fixture(records()); assert.throws(() => f.reducer.reduce({ from: 'raw', stages: [{ name: 'bad', group_by_columns: [], measures: [{ column: 'reading', metrics: ['guess'] }] }] }), /must be one of/);
  const noMask = { ...f.raw }; delete noMask.record_rows; f.results.set('no-mask', noMask);
  assert.throws(() => f.reducer.reduce({ from: 'no-mask', stages: stages() }), /authoritative record_rows/);
  assert.deepEqual(REDUCE_RESULT.function.parameters.properties.stages.items.properties.measures.items.properties.metrics.items.enum, AGGREGATE_METRICS);
});

test('failed later stages retain raw and completed outputs, and a corrected saved stage resolves the exact pending output', () => {
  const f = fixture(records()), chain = stages(); chain[1].measures[0].column = 'incorrect';
  const failed = f.reducer.reduce({ from: 'raw', stages: chain }); assert.equal(failed.status, 'partial');
  assert.equal(failed.resume_from, 'observations'); assert.equal(f.results.size, 2); assert.equal(f.reducer.unfinished().length, 1);
  const repaired = f.reducer.reduce({ from: 'observations', stages: [stages()[1]] });
  assert.equal(repaired.status, 'completed'); assert.deepEqual(f.reducer.unfinished(), []); assert.equal(f.results.get('entities').rows[0].entity_value, 10);
});

for (const size of [1, 7, 600, 1023]) test(`three declared stages preserve ${size} supplied identities`, () => {
  const f = fixture(Array.from({ length: size }, (_, i) => records(`ID_${i}`, `REF_${i}`, 'α|β')).flat());
  const chain = [...stages(), { name: 'per_input', group_by_columns: [], measures: [{ column: 'entity_value', metrics: ['mean'], as: { mean: 'final_reading' } }] }];
  const out = f.reducer.reduce({ from: 'raw', stages: chain }); assert.equal(out.status, 'completed');
  const result = f.results.get('per_input'); assert.equal(result.rows.length, size); assert.ok(result.rows.every(row => row.final_reading === 10));
  assert.equal(f.results.size, 4);
});

async function runBulk(decide) {
  const filename = require.resolve('../../src/system/agents/investigatorBulk'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded), requests = []; let reads = 0;
  const stubs = {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'fixture' }; } },
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) {
      requests.push(JSON.parse(JSON.stringify(request))); const actions = decide({ request, turn: requests.length });
      return { choices: [{ message: { role: 'assistant', tool_calls: actions.map(([name, args], i) => ({ id: `${requests.length}_${i}`, type: 'function', thought_signature: 'native-thought', function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 4, completion_tokens: 1 } };
    } } } } }
  };
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : originalRequire(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const entry = { file: 'unseen-source.tsv', key: 'ensembl', columns: ['Gene', 'location', 'observation', 'reading'] };
  const raw = records().map(row => ({ Gene: 'ID1', location: row.location, observation: row.observation, reading: row.reading }));
  const adapter = { async resolveGenes() { return [{ gene: 'ONE', ensembl: 'ID1' }]; }, async catalog() { return [entry]; }, async entry() { return entry; }, async readMany() { reads++; return { entry, byGene: new Map([['ID1', raw]]) }; } };
  const result = await loaded.exports({ genes: ['ONE'], question: 'Return raw records, per-observation medians and per-location median of those medians with record and observation counts' }, {}, adapter);
  return { result, requests, reads };
}
const rawCall = ['apply_bulk', { name: 'raw', lookups: [{ table: 'unseen-source.tsv', match_column: 'Gene', mode: 'rows', columns: ['location', 'observation', 'reading'] }] }];

test('the actual native bulk loop returns raw and nested results without source rereads', async () => {
  const { result, requests, reads } = await runBulk(({ request, turn }) => {
    assert.ok(request.tools.some(tool => tool.function.name === 'reduce_result'));
    if (turn === 1) return [rawCall];
    if (turn === 2) { const chain = stages(); chain[0].measures[0].as = JSON.stringify(chain[0].measures[0].as); return [['reduce_result', { from: 'raw', stages: chain }]]; }
    if (turn === 3) {
      const receipt = JSON.parse(request.messages.at(-1).content); assert.equal(receipt.status, 'completed'); assert.equal(receipt.completed[1].reduction.input_rows, 3);
      return [['open_result', { name: 'entities', columns: ['gene', 'entity_value', 'record_count', 'observation_count'] }]];
    }
    assert.equal(turn, 4); assert.deepEqual(JSON.parse(request.messages.at(-1).content).rows, [['ONE', 10, 5, 3]]);
    return [['finish', { results: ['raw', 'observations', 'entities'], not_in_release: [] }]];
  });
  assert.equal(result.status, 'ok', result.error); assert.equal(result.tables.length, 3); assert.equal(reads, 1); assert.equal(requests.length, 4);
  assert.deepEqual(result.tables.map(table => table.rows.length), [5, 3, 1]); assert.equal(result.tokens.total.total, 20);
});

for (const repair of [false, true]) test(`the actual loop ${repair ? 'repairs' : 'retains'} a failed reduction obligation at finish`, async () => {
  const { result, reads } = await runBulk(({ request, turn }) => {
    if (turn === 1) return [rawCall];
    if (turn === 2) { const chain = stages(); chain[1].measures[0].column = 'wrong'; return [['reduce_result', { from: 'raw', stages: chain }]]; }
    if (turn === 3) {
      const receipt = JSON.parse(request.messages.at(-1).content); assert.equal(receipt.status, 'partial'); assert.equal(receipt.resume_from, 'observations');
      if (repair) return [['reduce_result', { from: 'observations', stages: [stages()[1]] }]];
    }
    return [['finish', { results: repair ? ['raw', 'observations', 'entities'] : ['raw', 'observations'], not_in_release: [] }]];
  });
  assert.equal(reads, 1); assert.equal(result.status, repair ? 'ok' : 'partial', result.error);
  assert.equal(result.remaining_for_aso.length, repair ? 0 : 1); assert.equal(result.tables.length, repair ? 3 : 2);
});
