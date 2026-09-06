'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chartSpec, pivot, aggregate } = require('../../src/system/aso/studyTools');

test('multi-column aggregation retains separate group labels without delimiter collisions', async () => {
  const rows = [{ cohort: 'A|B', category: 'C', value: 2 }, { cohort: 'A|B', category: 'C', value: null }, { cohort: 'A', category: 'B|C', value: 0 }];
  const args = { group_by_columns: ['cohort', 'category'], column: 'value', metrics: ['count', 'sum', 'mean', 'missing'] };
  const expected = [{ cohort: 'A|B', category: 'C', count: 2, sum: 2, mean: 2, missing: 1 }, { cohort: 'A', category: 'B|C', count: 1, sum: 0, mean: 0, missing: 0 }];
  assert.deepEqual(aggregate(rows, args), expected);
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

test('a log scale follows the x and y columns of a chart, and colours the cells of a heatmap', () => {
  const rows = [{ gene: 'A', x: 1, y: 10 }, { gene: 'B', x: 100, y: 0 }];
  const scatter = chartSpec({ type: 'scatter', x: 'x', y: 'y', x_scale: 'log', y_scale: 'linear' }, rows);
  assert.equal(scatter.x_scale, 'log'); assert.equal('y_scale' in scatter, false, 'linear is the default and is not recorded');
  assert.equal(chartSpec({ type: 'lollipop', x: 'gene', y: 'y', y_scale: 'log' }, rows).y_scale, 'log');
  assert.throws(() => chartSpec({ type: 'lollipop', x: 'gene', y: 'y', x_scale: 'log' }, rows), /x of lollipop holds labels; y_scale scales the values/);
  assert.throws(() => chartSpec({ type: 'scatter', x: 'x', y: 'y', scale: 'log' }, rows), /scale colours heatmap cells; scatter takes x_scale or y_scale/);
  const matrix = pivot([{ id: 'one', group: 'A', n: 1 }, { id: 'two', group: 'B', n: 1000 }], { row: 'id', column: 'group', value: 'n' });
  assert.equal(chartSpec({ type: 'heatmap', scale: 'log' }, matrix).scale, 'log');
  assert.throws(() => chartSpec({ type: 'heatmap', y_scale: 'log' }, matrix), /a heatmap colours its cells; scale sets that, not y_scale/);
});
