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
  assert.equal(aggregate(rows, { ...args, group_by_columns: [] }).length, 1, 'an empty group_by_columns is no grouping: the whole table is one group');
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

test('a grouped bar takes several value columns as series, one series per column', () => {
  const rows = [{ Cancer: 'KIRC', favorable: 1638, unfavorable: 264 }, { Cancer: 'LIHC', favorable: 113, unfavorable: 939 }];
  const spec = chartSpec({ type: 'grouped_bar', x: 'Cancer', series: ['favorable', 'unfavorable'] }, rows);
  assert.deepEqual(spec.data, [
    { label: 'KIRC', value: 1638, group: 'favorable' }, { label: 'KIRC', value: 264, group: 'unfavorable' },
    { label: 'LIHC', value: 113, group: 'favorable' }, { label: 'LIHC', value: 939, group: 'unfavorable' }
  ]);
  assert.throws(() => chartSpec({ type: 'grouped_bar', x: 'Cancer', y: 'favorable' }, rows), /needs group \(a column of series names\) or series \(value columns, one series each\)/);
  assert.throws(() => chartSpec({ type: 'dot_plot', x: 'favorable', y: 'Cancer' }, rows), /chart: Cancer holds no numbers; x names the labels and y the values, for a sideways chart \(dot_plot\) too/);
  assert.throws(() => chartSpec({ type: 'grouped_bar', x: 'Cancer', series: ['favorable', 'typo'] }, rows), /no series column typo/);
  assert.throws(() => chartSpec({ type: 'scatter', x: 'favorable', series: ['unfavorable'] }, rows), /series lists value columns for the bar family; scatter takes y/);
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

test('pca and umap place the rows of a pivot, and leave out a row with a missing value only when told to', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) for (const tissue of ['liver', 'kidney', 'brain']) rows.push({ gene: `G${i}`, tissue, ntpm: i === 3 && tissue === 'brain' ? null : (i + 1) * (tissue === 'liver' ? 3 : 1) });
  const matrix = pivot(rows, { row: 'gene', column: 'tissue', value: 'ntpm' });
  assert.throws(() => chartSpec({ type: 'pca' }, matrix), /1 rows of the pivot have a missing value; inspect them, then use missing=omit/);
  const pca = chartSpec({ type: 'pca', missing: 'omit', scale: 'log' }, matrix);
  assert.equal(pca.omitted_rows, 1); assert.equal(pca.row_labels.length, 11); assert.equal(pca.row_labels.includes('G3'), false); assert.equal(pca.scale, 'log');
  assert.deepEqual(pca.col_labels, ['liver', 'kidney', 'brain']);
  assert.throws(() => chartSpec({ type: 'umap', missing: 'omit', y_scale: 'log' }, matrix), /umap places the rows of a pivot by their values; scale sets that, not y_scale/);
  assert.throws(() => chartSpec({ type: 'umap', missing: 'omit' }, pivot(rows.slice(0, 15), { row: 'gene', column: 'tissue', value: 'ntpm' })), /umap needs at least 10 rows with a value in every column; pca places fewer/);
  assert.throws(() => chartSpec({ type: 'pca', x: 'gene', y: 'ntpm' }, rows), /pca needs a pivot output/);
});

test('box and ridge draw one distribution per group of x from the y column', () => {
  const rows = [{ tissue: 'liver', ntpm: 1 }, { tissue: 'kidney', ntpm: 5 }, { tissue: 'liver', ntpm: 3 }, { tissue: 'kidney', ntpm: null }];
  assert.deepEqual(chartSpec({ type: 'box', x: 'tissue', y: 'ntpm', missing: 'omit' }, rows).series, [{ label: 'liver', values: [1, 3] }, { label: 'kidney', values: [5] }]);
  assert.deepEqual(chartSpec({ type: 'ridge', x: 'tissue', y: 'ntpm', missing: 'omit' }, rows).series.map(s => s.label), ['liver', 'kidney']);
  assert.throws(() => chartSpec({ type: 'box', x: 'tissue', y: 'ntpm', group: 'tissue', missing: 'omit' }, rows), /box draws one distribution per value of x from the y column; it takes no series or group/);
  assert.throws(() => chartSpec({ type: 'ridge', x: 'tissue', y: 'ntpm', y_scale: 'log', missing: 'omit' }, rows), /a ridge plot draws the values as they are/);
});
