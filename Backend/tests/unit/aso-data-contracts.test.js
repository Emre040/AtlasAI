'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const { chartSpec, pivot, aggregate, aggregateStream } = require('../../src/system/aso/studyTools');

test('multi-column aggregation retains separate group labels without delimiter collisions', async () => {
  const rows = [{ cohort: 'A|B', category: 'C', value: 2 }, { cohort: 'A|B', category: 'C', value: null }, { cohort: 'A', category: 'B|C', value: 0 }];
  const args = { group_by_columns: ['cohort', 'category'], column: 'value', metrics: ['count', 'sum', 'mean', 'missing'] };
  const expected = [{ cohort: 'A|B', category: 'C', count: 2, sum: 2, mean: 2, missing: 1 }, { cohort: 'A', category: 'B|C', count: 1, sum: 0, mean: 0, missing: 0 }];
  assert.deepEqual(aggregate(rows, args), expected);
  assert.deepEqual(await aggregateStream((async function* () { yield* rows; })(), args, ['cohort', 'category', 'value']), expected);
  assert.throws(() => aggregate(rows, { ...args, group_by: 'cohort' }), /not both/);
  assert.throws(() => aggregate(rows, { ...args, group_by_columns: [] }), /nonempty array/);
  assert.throws(() => aggregate(rows, { ...args, group_by_columns: ['cohort', 'unknown'] }), /no grouping column/);
  assert.deepEqual(aggregate(rows, { group_by: 'cohort', metrics: ['count'] }), [{ cohort: 'A|B', count: 2 }, { cohort: 'A', count: 1 }]);
  const chart = chartSpec({ type: 'grouped_bar', x: 'category', group: 'cohort', y: 'count' }, aggregate(rows, args));
  assert.deepEqual(chart.data.map(point => [point.group, point.label, point.value]), [['A|B', 'C', 2], ['A', 'B|C', 1]]);
});

test('charts reject unknown columns and report explicit missing-value omissions', () => {
  const rows = [{ label: 'observed zero', x: 0, y: 0 }, { label: 'unobserved', x: 2, y: null }];
  assert.throws(() => chartSpec({ type: 'scatter', x: 'x', y: 'y' }, rows), /missing numeric values/);
  const spec = chartSpec({ type: 'scatter', x: 'x', y: 'y', missing: 'omit' }, rows);
  assert.equal(spec.omitted_rows, 1); assert.equal(spec.data.length, 1);
  assert.equal(spec.data[0].y, 0);
  assert.throws(() => chartSpec({ type: 'bar', x: 'typo', y: 'y' }, rows), /columns not found/);
  assert.equal(chartSpec({ type: 'scatter', x: 'x', y: 'y' }, [rows[0]]).data[0].label, '');
  assert.equal(chartSpec({ type: 'scatter', x: 'x', y: 'y', label: 'label' }, [rows[0]]).data[0].label, 'observed zero');
  assert.throws(() => chartSpec({ type: 'scatter', x: 'x', y: 'y', label: 'typo' }, [rows[0]]), /no label column/);
});

test('pivot preserves missing cells and refuses ambiguous repeated measurements', () => {
  const rows = [{ id: 'one', group: 'A', n: 0 }, { id: 'two', group: 'B', n: 7 }];
  assert.deepEqual(pivot(rows, { row: 'id', column: 'group', value: 'n' }).matrix, [[0, null], [null, 7]]);
  assert.throws(() => pivot([...rows, { ...rows[0], n: 3 }], { row: 'id', column: 'group', value: 'n' }), /duplicate cell/);
});

test('measurement never silently chooses the first source row or hides read errors', async () => {
  const filename = require.resolve('../../src/system/aso/studyTools');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(require('node:path').dirname(filename));
  const original = loaded.require.bind(loaded);
  const adapter = {
    async entry() { return { file: 'raw.tsv', columns: ['ID', 'unit', 'reading'] }; },
    async resolveGene() { return { gene: 'EXAMPLE', ensembl: 'ENSG00000000001' }; },
    async read() { return { rows: [{ ID: 'ENSG00000000001', unit: 'A', reading: '3' }, { ID: 'ENSG00000000001', unit: 'A', reading: '9' }] }; }
  };
  loaded.require = name => name === '../../hpa/geneDataAdapter' ? adapter : original(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const args = { table: 'raw.tsv', value_column: 'reading', as: 'result' };
  await assert.rejects(() => loaded.exports.measure([{ gene: 'EXAMPLE' }], args), /2 matching rows/);
  await assert.rejects(() => loaded.exports.measure([{ gene: 'EXAMPLE' }], { ...args, entity: 'A' }), /explicit entity_column/);
  const rows = await loaded.exports.measure([{ gene: 'EXAMPLE' }], { ...args, aggregate: 'median' });
  assert.equal(rows[0].result, 6); assert.equal(rows[0].result_source_rows, 2);
  adapter.read = async () => { throw new Error('source unavailable'); };
  await assert.rejects(() => loaded.exports.measure([{ gene: 'EXAMPLE' }], args), /source unavailable/);
});
