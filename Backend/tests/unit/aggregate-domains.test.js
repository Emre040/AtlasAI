'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../../src/system/aso/studyTools');
const metrics = tools.AGGREGATE_METRICS;
const columns = ['cohort', 'phase', 'value'];
const rows = [
  { cohort: 'A', phase: 'first', value: 0 },
  { cohort: 'A', phase: 'first', value: 10 },
  { cohort: 'A', phase: 'first', value: null },
  { cohort: 'A', phase: 'second', value: 'NA' },
  { cohort: 'B', phase: 'third', value: 6 },
  { cohort: 'B', phase: 'third', value: 2 }
];
const domains = [{ column: 'phase', values: ['first', 'second', 'third'] }, { column: 'cohort', values: ['A', 'B'] }];
const args = { group_by_columns: ['cohort', 'phase'], group_domains: domains, column: 'value', metrics };

test('full uneven 2x3 domains retain all observations and add zero-count combinations on table and stream paths', async () => {
  const before = JSON.stringify(rows);
  const result = tools.aggregate(rows, args);
  assert.deepEqual(result.map(r => [r.cohort, r.phase, r.count]), [['A', 'first', 3], ['A', 'second', 1], ['A', 'third', 0], ['B', 'first', 0], ['B', 'second', 0], ['B', 'third', 2]]);
  assert.deepEqual(result[0], { cohort: 'A', phase: 'first', count: 3, recorded: 2, numeric_count: 2, zero: 1, sum: 10, mean: 5, median: 5, sd: Math.sqrt(50), q1: 2.5, q3: 7.5, min: 0, max: 10, missing: 1, distinct: 2 });
  assert.equal(result[1].count, 1); assert.equal(result[1].missing, 1); assert.equal(result[1].numeric_count, 0); assert.equal(result[1].sum, null);
  assert.equal(result[5].median, 4); assert.equal(result[5].count, 2);
  const observed = tools.aggregate(rows, { ...args, group_domains: undefined });
  assert.equal(observed.length, 3);
  assert.deepEqual(result.filter(r => r.count > 0), observed, 'existing observed-group metric semantics must be unchanged');
  assert.equal(JSON.stringify(rows), before, 'source values and counts are not mutated');
});

test('empty groups use the existing empty aggregate statistics and preserve schema', async () => {
  const source = tools.withColumns([], columns);
  const result = tools.aggregate(source, args);
  assert.equal(result.length, 6); assert.deepEqual(result.columns, ['cohort', 'phase', ...metrics]);
  const emptyStats = tools.aggregate(tools.withColumns([], ['value']), { column: 'value', metrics })[0];
  for (const { cohort, phase, ...stats } of result) assert.deepEqual(stats, emptyStats);
  for (const metric of ['count', 'recorded', 'numeric_count', 'zero', 'missing', 'distinct']) assert.equal(emptyStats[metric], 0);
  for (const metric of ['sum', 'mean', 'median', 'sd', 'q1', 'q3', 'min', 'max']) assert.equal(emptyStats[metric], null);
  assert.deepEqual(tools.aggregate(source, { ...args, group_domains: undefined }), []);
  const noCombinations = { ...args, group_domains: [{ column: 'cohort', values: [] }, domains[0]] };
  assert.deepEqual(tools.aggregate(source, noCombinations), []);
  assert.throws(() => tools.aggregate(rows, noCombinations), /outside declared domain/);
});

test('typed grouping labels retain zero, text, boolean, null, blank and NA as separate exact categories', async () => {
  const labels = [0, '0', false, 'false', null, '', 'NA', 'na', ' A ', 'A'];
  const source = labels.map(key => ({ key, value: 0 })); source.push({ value: null });
  const options = { group_by: 'key', group_domains: [{ column: 'key', values: labels }], column: 'value', metrics: ['count', 'numeric_count', 'zero', 'missing'] };
  const result = tools.aggregate(source, options);
  assert.deepEqual(result.map(r => r.key), labels);
  assert.deepEqual(result.map(r => r.count), labels.map(k => k === null ? 2 : 1));
  assert.deepEqual(result.map(r => r.numeric_count), labels.map(() => 1));
  assert.equal(result.find(r => r.key === null).missing, 1, 'undefined grouping keys retain existing null normalization');
  assert.throws(() => tools.aggregate([{ key: '0', value: 0 }], { ...options, group_domains: [{ column: 'key', values: [0] }] }), /outside declared domain/);
  assert.throws(() => tools.aggregate([{ key: ' A ', value: 0 }], { ...options, group_domains: [{ column: 'key', values: ['A'] }] }), /outside declared domain/);
});

test('invalid or incomplete domain declarations reject explicitly without silently dropping observations', async () => {
  for (const group_domains of [null, {}, [], [{ column: 'cohort', values: ['A', 'B'] }], [...domains, { column: 'value', values: [0] }], [...domains, { column: 'COHORT', values: ['A', 'B'] }], [{ column: 'phase', values: ['first', 'first'] }, domains[1]], [{ column: 'phase', values: [{}] }, domains[1]], [{ column: 'phase', values: [[]] }, domains[1]], [{ column: 'phase', values: [undefined] }, domains[1]], [{ column: 'phase', values: [Infinity] }, domains[1]], [{ column: 'phase', values: [NaN] }, domains[1]], [{ column: 'phase', values: ['first'], unexpected: true }, domains[1]]]) {
    assert.throws(() => tools.aggregate(rows, { ...args, group_domains }), /aggregate:/);
  }
  assert.throws(() => tools.aggregate(rows, { group_domains: domains, metrics: ['count'] }), /requires group_by/);
  const outside = [...rows, { cohort: 'C', phase: 'first', value: 99 }];
  assert.throws(() => tools.aggregate(outside, args), /outside declared domain for "cohort"/);
});

test('declared Cartesian products have no private group-count ceiling', () => {
  const left = Array.from({ length: 41 }, (_, i) => i); const right = Array.from({ length: 43 }, (_, i) => `label ${i}`);
  const result = tools.aggregate(tools.withColumns([], ['left', 'right']), { group_by_columns: ['left', 'right'], group_domains: [{ column: 'left', values: left }, { column: 'right', values: right }], metrics: ['count'] });
  assert.equal(result.length, 41 * 43); assert.equal(result.reduce((sum, r) => sum + r.count, 0), 0);
  assert.deepEqual(result.at(-1), { left: 40, right: 'label 42', count: 0 });
});
