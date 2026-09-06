'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { withColumns, fillMissing } = require('../../src/system/aso/studyTools');
const { TABLE_OPERATIONS } = require('../../src/system/aso/tableOperations');
const { SAVED_TOOLS, createSavedOperations } = require('../../src/system/agents/investigatorResults');
const { buildRequest } = require('../../src/inference/adapters/geminiGenerateContent');
const { fixture, call, response, transcript } = require('../helpers/nativeStudyFixture');

function table(name, rows, columns, mask = rows.map(() => true)) {
  return { name, rows: withColumns(rows, columns), columns, created_columns: columns.filter(column => !['gene', 'ensembl'].includes(column)), record_rows: mask,
    provenance: [{ table: `${name}.tsv`, unit: `${name}-raw-unit` }], coverage: [{ table: `${name}.tsv`, inputs: 2, matched_source_rows: mask.filter(Boolean).length }], unresolved_inputs: 0 };
}
function setup(tables) {
  const results = new Map(tables.map(table => [table.name, table]));
  return { results, ops: createSavedOperations({ results, release: 'synthetic', inputColumns: ['gene', 'ensembl'] }) };
}
test('explicit fill affects only selected missing cells and records exact typed value and cell counts', () => {
  const rows = withColumns([null, undefined, '', ' NA ', 0, '0', -2, false, '0-2', 'word'].map((value, i) => ({ value, other: null, source: { index: i } })), ['value', 'other', 'source']);
  const before = structuredClone(rows);
  const out = fillMissing(rows, { columns: ['value'], value: 0 });
  assert.deepEqual(out.map(row => row.value), [0, 0, 0, 0, 0, '0', -2, false, '0-2', 'word']);
  assert.ok(out.every(row => row.other === null)); assert.deepEqual(rows, before);
  assert.deepEqual(out.fill.affected_cells, { value: 4 }); assert.equal(out.fill.total_affected_cells, 4);
  for (const value of [false, '0', null]) assert.strictEqual(fillMissing([{ x: null }], { columns: ['x'], value })[0].x, value);
});
test('fill validates exact columns and explicit scalar values even for an empty result', () => {
  const rows = withColumns([], ['value']);
  const out = fillMissing(rows, { columns: ['value'], value: false });
  assert.deepEqual(out.columns, ['value']); assert.equal(out.fill.total_affected_cells, 0);
  for (const args of [{ columns: [] }, { columns: ['value'] }, { columns: ['wrong'], value: 0 }, { columns: ['value', 'Value'], value: 0 }, { columns: ['value'], value: {} }, { columns: ['value'], value: Infinity }]) assert.throws(() => fillMissing(rows, args), /fill_missing/);
});
test('saved select/filter/classify/compute/rank retain aligned record sidecars and raw source objects', async () => {
  const raw = table('raw', [{ gene: 'B', ensembl: 'b', v: 0 }, { gene: 'A', ensembl: 'a', v: 0 }, { gene: 'C', ensembl: 'c', v: null }], ['gene', 'ensembl', 'v'], [true, true, false]);
  const before = JSON.stringify(raw); const f = setup([raw]);
  await f.ops.execute('select', { artifact: 'raw', columns: ['gene', 'v'], rename: { v: 'value' }, result: 'selected' });
  await f.ops.execute('compute', { artifact: 'selected', name: 'score', expr: 'value + 1', result: 'computed' });
  await f.ops.execute('classify', { artifact: 'computed', name: 'kind', rules: [{ where: [{ column: 'score', op: 'is_numeric' }], value: 'recorded' }], otherwise: 'absent', result: 'classified' });
  const ranked = await f.ops.execute('rank', { artifact: 'classified', by: 'score', then_by: [{ column: 'gene', type: 'text', order: 'asc' }], result: 'ranked' });
  assert.deepEqual(ranked.rows.map(row => row.gene), ['A', 'B', 'C']); assert.deepEqual(ranked.record_rows, [true, true, false]);
  const absent = await f.ops.execute('filter', { artifact: 'ranked', where: [{ column: 'score', op: 'is_missing' }], result: 'absent' });
  assert.deepEqual(absent.record_rows, [false]); assert.equal(absent.rows[0].gene, 'C');
  assert.equal(JSON.stringify(raw), before); assert.equal(f.results.size, 6);
  assert.deepEqual(ranked.operations.map(op => op.tool), ['select', 'compute', 'classify', 'rank']);
  assert.deepEqual(ranked.provenance, raw.provenance); assert.equal(ranked.classifications[0].name, 'kind');
});
test('full joins retain exact tuple keys, private-name-like source columns, source-only rows and mask lineage', async () => {
  const left = table('left', [{ gene: 'A', site: 0, x: '0', __saved_left_row: 'original' }, { gene: 'A', site: '0', x: '-2', __saved_left_row: 'other' }, { gene: 'B', site: null, x: null }], ['gene', 'site', 'x', '__saved_left_row'], [true, true, false]);
  const right = table('right', [{ gene: 'A', site: 0, y: '4' }, { gene: 'A', site: false, y: '3' }, { gene: 'B', site: null, y: null }], ['gene', 'site', 'y'], [true, true, false]);
  const f = setup([left, right]); const before = [JSON.stringify(left), JSON.stringify(right)];
  const joined = await f.ops.execute('join', { a: 'left', b: 'right', on_columns: ['gene', 'site'], how: 'full', result: 'joined' });
  assert.equal(joined.rows.length, 5); assert.deepEqual(joined.record_rows, [true, true, false, true, false]);
  assert.deepEqual(joined.columns, ['gene', 'site', 'x', '__saved_left_row', 'y']);
  assert.equal(joined.rows[0].__saved_left_row, 'original'); assert.strictEqual(joined.rows[0].site, 0); assert.strictEqual(joined.rows[1].site, '0');
  assert.deepEqual([JSON.stringify(left), JSON.stringify(right)], before);
});
test('batch dependencies use saved handles while scalar literals and map values remain literal', async () => {
  const f = setup([table('raw', [{ gene: 'A', x: 0 }, { gene: 'B', x: null }], ['gene', 'x'])]);
  const result = await f.ops.run({ steps: [
    { id: 'filled', tool: 'fill_missing', args: JSON.stringify({ artifact: 'raw', columns: ['x'], value: 0, result: 'filled' }) },
    { id: 'selected', tool: 'select', args: { artifact: '@filled', add: { literal: '@not_a_reference' }, result: 'selected' } },
    { id: 'ranked', tool: 'rank', args: { artifact: '@selected', by: 'x', then_by: [{ column: 'gene', type: 'text' }], result: 'ranked' } }
  ], outputs: ['ranked'] });
  assert.equal(result.status, 'completed'); assert.equal(result.outputs[0].table.name, 'ranked');
  assert.ok(result.outputs[0].table.rows.every(row => row.literal === '@not_a_reference'));
  assert.deepEqual(result.outputs[0].table.fills[0].affected_cells, { x: 1 });
  assert.equal(f.results.size, 4);
});
test('failed batch dependencies preserve completed rows, explicit pending names and independent results', async () => {
  const f = setup([table('raw', [{ gene: 'A', x: 0 }], ['gene', 'x'])]);
  const failed = await f.ops.run({ steps: [
    { id: 'first', tool: 'select', args: { artifact: 'raw', columns: ['gene', 'x'], result: 'first' } },
    { id: 'bad', tool: 'rank', args: { artifact: '@first', by: 'wrong', result: 'second' } },
    { id: 'blocked', tool: 'select', args: { artifact: '@bad', result: 'third' } }
  ], outputs: ['first', 'blocked'] });
  assert.equal(failed.status, 'partial'); assert.deepEqual(failed.steps.map(step => step.status), ['done', 'failed', 'blocked']);
  assert.equal(f.results.size, 2); assert.equal(f.ops.unfinished().length, 2);
  await f.ops.execute('rank', { artifact: 'first', by: 'x', result: 'second' });
  await f.ops.execute('select', { artifact: 'second', result: 'third' });
  assert.deepEqual(f.ops.unfinished(), []);
  await assert.rejects(() => f.ops.execute('select', { artifact: 'raw', result: 'third' }), /already exists/);
  assert.equal(f.results.size, 4);
});
test('saved operations never resolve unknown source names and refuse explicitly partial execution', async () => {
  const raw = table('raw', [{ gene: 'A', x: null }], ['gene', 'x']); raw.execution = { status: 'partial' };
  const f = setup([raw]);
  await assert.rejects(() => f.ops.execute('fill_missing', { artifact: 'not-read.tsv', columns: ['x'], value: 0, result: 'missing' }), /No saved result/);
  await assert.rejects(() => f.ops.execute('fill_missing', { artifact: 'raw', columns: ['x'], value: 0, result: 'partial' }), /partially executed/);
  assert.equal(f.results.size, 1); assert.equal(raw.rows[0].x, null);
});
test('native Gemini saved-operation schemas reuse scalar types, tuple arrays and map transport', () => {
  const payload = buildRequest({ messages: [{ role: 'user', content: 'synthetic' }], tools: SAVED_TOOLS, reasoning_effort: 'low' }, { modelId: 'synthetic' });
  const specs = payload.tools.flatMap(tool => tool.functionDeclarations || []);
  const fill = specs.find(spec => spec.name === 'fill_missing');
  assert.deepEqual(fill.parameters.properties.value.anyOf.map(schema => schema.type), ['STRING', 'NUMBER', 'BOOLEAN', 'NULL']);
  assert.equal(specs.find(spec => spec.name === 'join').parameters.properties.on_columns.type, 'ARRAY');
  assert.equal(specs.find(spec => spec.name === 'select').parameters.properties.rename.type, 'STRING');
  assert.deepEqual(payload.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});
test('native ASO loads the shared fill schema and preserves fill provenance through run and for_each', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) { assert.ok(!request.tools.some(tool => tool.function.name === 'fill_missing')); return response(call('set_plan', { items: [{ step: 'Fill selected missing source values', kind: 'table' }] }), call('load_tools', { names: ['fill_missing'] })); }
    if (turn === 2) {
      const spec = request.tools.find(tool => tool.function.name === 'fill_missing').function;
      const { node, for_each, ...properties } = spec.parameters.properties;
      assert.deepEqual(properties, TABLE_OPERATIONS.get('fill_missing').parameters.properties);
      return response(call('run', { steps: [{ id: 'fill', tool: 'fill_missing', args: { artifact: 'mapping.tsv', columns: ['value'], value: 0, node: 1, for_each: { values: ['first', 'second'] } } }], outputs: ['fill'] }));
    }
    assert.equal(turn, 3); assert.match(transcript(request), /a1/);
    return response(call('finish', { tables: [{ artifact: 'a1', columns: ['item', 'name', 'value'] }] }));
  }, null, { nativeDiscovery: true, rows: [{ name: 'observed', value: 0 }, { name: 'missing', value: null }] });
  const result = await f.run({ max_turns: 5 }); assert.equal(result.outcome, 'completed', JSON.stringify(result));
  const files = await fs.readdir(path.join(f.directory, 'artifacts'));
  const saved = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await fs.readFile(path.join(f.directory, 'artifacts', name), 'utf8'))));
  const output = saved.find(artifact => artifact.node_id === 'a1');
  assert.equal(output.rows.length, 4); assert.equal(output.provenance.fills.length, 2);
  assert.deepEqual(output.provenance.fills.map(fill => fill.affected_cells.value), [1, 1]);
});

test('native ASO preserves source masks through select/fill/rank and requires explicit aggregate scope', async t => {
  const raw = table('raw', [{ gene: 'A', ensembl: 'a', value: 2 }, { gene: 'B', ensembl: 'b', value: null }], ['gene', 'ensembl', 'value'], [true, false]);
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Count source records and retained cohort rows separately', kind: 'table' }] }), call('investigator_hpa', { genes: ['A', 'B'], question: 'Return the raw rows with source absence preserved', node: 1 }));
    if (turn === 2) {
      assert.match(request.messages.at(-1).content, /"id":"a1".*"rows":2.*"record_rows":1/);
      return response(call('load_tools', { names: ['select', 'fill_missing', 'rank', 'aggregate'] }));
    }
    if (turn === 3) return response(call('run', { steps: [
      { id: 'selected', tool: 'select', args: { artifact: 'a1', columns: ['gene', 'value'] } },
      { id: 'filled', tool: 'fill_missing', args: { artifact: '@selected', columns: ['value'], value: 0 } },
      { id: 'ranked', tool: 'rank', args: { artifact: '@filled', by: 'value' } }
    ], outputs: ['ranked'] }));
    const args = { artifact: 'a4', group_by: 'gene', metrics: ['count'], group_domains: [{ column: 'gene', values: ['A', 'B'] }] };
    if (turn === 4) return response(call('aggregate', args));
    if (turn === 5) {
      assert.match(transcript(request), /choose row_scope records/);
      return response(call('aggregate', { ...args, row_scope: 'records' }), call('aggregate', { ...args, row_scope: 'all' }));
    }
    assert.equal(turn, 6);
    return response(call('finish', { completed: [{ item: 1, artifacts: ['a5', 'a6'] }], tables: [{ artifact: 'a5', columns: ['gene', 'count'] }, { artifact: 'a6', columns: ['gene', 'count'] }] }));
  }, async () => ({ result: { bulk: true, status: 'ok', found: true, tables: [raw], not_in_release: [], remaining_for_aso: [], input_count: 2, unresolved_inputs: 0 } }), { nativeDiscovery: true });
  const result = await f.run({ max_turns: 8 }); assert.equal(result.outcome, 'completed', JSON.stringify(result));
  const files = await fs.readdir(path.join(f.directory, 'artifacts'));
  const saved = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await fs.readFile(path.join(f.directory, 'artifacts', name), 'utf8'))));
  assert.deepEqual(saved.find(row => row.node_id === 'a4').provenance.record_rows, [true, false]);
  assert.deepEqual(saved.find(row => row.node_id === 'a5').rows.map(row => row.count), [1, 0]);
  assert.deepEqual(saved.find(row => row.node_id === 'a6').rows.map(row => row.count), [1, 1]);
});

test('native ASO aggregate records retains actual raw streaming behavior in one source pass', async t => {
  let reads = 0;
  const f = await fixture(t, ({ turn }) => turn === 1
    ? response(call('set_plan', { items: [{ step: 'Count actual imported records', kind: 'table' }] }), call('aggregate', { artifact: 'stream.tsv', group_by: 'gene', row_scope: 'records', column: 'value', metrics: ['count', 'numeric_count'], node: 1 }))
    : response(call('finish', { tables: [{ artifact: 'a1', columns: ['gene', 'count', 'numeric_count'] }] })), null,
  { entry: { file: 'stream.tsv', key: 'stream', columns: ['gene', 'value'] }, rows: [{ gene: 'A', value: 0 }, { gene: 'A', value: null }], onRead: () => reads++ });
  const result = await f.run(); assert.equal(result.outcome, 'completed', JSON.stringify(result)); assert.equal(reads, 1);
  const saved = JSON.parse(await fs.readFile(result.artifacts.find(artifact => artifact.summary.id === 'a1').storage_uri, 'utf8'));
  assert.equal(saved.rows[0].count, 2); assert.equal(saved.rows[0].numeric_count, 1);
  assert.equal(saved.provenance.aggregation_rows.record_rows, 2); assert.equal(saved.provenance.aggregation_rows.placeholder_rows, 0);
});


test('ASO receives artifact cards without operation recipes and retains complete provenance in storage', async t => {
  const literal = 'exact-fill-literal-' + '界'.repeat(1200);
  const output = table('derived', [{ gene: 'A', value: 2 }], ['gene', 'value']);
  output.operations = [{ tool: 'fill_missing', args: { artifact: 'prior', columns: ['description'], value: literal }, inputs: { artifact: 'prior' }, input_rows: { artifact: 1 }, output_rows: 1, result_kind: 'table' }];
  output.fills = [{ columns: ['description'], value: literal, affected_cells: { description: 0 }, total_affected_cells: 0, input_rows: 1 }];
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Return the saved measurement', kind: 'table' }] }), call('investigator_hpa', { genes: ['A'], question: 'Return the saved measurement', node: 1 }));
    assert.equal(turn, 2); assert.doesNotMatch(transcript(request), /exact-fill-literal/);
    assert.doesNotMatch(transcript(request), /affected_cells/);
    assert.match(request.messages.at(-1).content, /"id":"a1","label":"derived".*"inputs":\["a2"\]/);
    return response(call('finish', { tables: [{ artifact: 'a1', columns: ['gene', 'value'] }] }));
  }, async () => ({ result: { bulk: true, status: 'ok', found: true, tables: [output], retained_tables: [table('prior', [{ gene: 'A', value: 2 }], ['gene', 'value'])], not_in_release: [], remaining_for_aso: [], input_count: 1, unresolved_inputs: 0 } }), { nativeDiscovery: true });
  const result = await f.run(); assert.equal(result.outcome, 'completed', JSON.stringify(result));
  const saved = JSON.parse(await fs.readFile(result.artifacts.find(artifact => artifact.summary.id === 'a1').storage_uri, 'utf8'));
  assert.equal(saved.provenance.operations[0].args.value, literal); assert.equal(saved.provenance.fills[0].value, literal);
});
