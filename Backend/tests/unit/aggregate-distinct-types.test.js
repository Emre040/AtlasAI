'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../../src/system/aso/studyTools');
async function* stream(rows) { yield* rows; }
async function both(values, args = { column: 'value', metrics: ['distinct'] }) {
  const rows = values.map(value => ({ value }));
  const result = tools.aggregate(rows, args);
  assert.deepEqual(await tools.aggregateStream(stream(rows), args, ['value']), result);
  return result;
}

test('row and streaming distinct retain scalar types while keeping numeric and missing semantics', async () => {
  const values = [0, '0', false, 'false', true, 'true', -0, 1, '1', ' 1 ', null, undefined, '', ' \t', 'NA', 'na'];
  assert.deepEqual(await both(values, { column: 'value', metrics: ['count', 'numeric_count', 'sum', 'zero', 'missing', 'distinct'] }), [
    { count: 16, numeric_count: 6, sum: 3, zero: 3, missing: 6, distinct: 9 }
  ]);
});

test('structured cells compare exact recursive content with order-independent object keys', async () => {
  const plain = Object.assign(Object.create(null), { a: 0, b: [false, '0', null, 'NA'] });
  const values = [
    { a: 0, b: [false, '0', null, 'NA'] },
    { b: [false, '0', null, 'NA'], a: 0 },
    plain,
    { a: '0', b: [false, '0', null, 'NA'] },
    { a: 0, b: ['0', false, null, 'NA'] }
  ];
  const before = JSON.stringify(values);
  assert.deepEqual(await both(values), [{ distinct: 3 }]);
  assert.equal(JSON.stringify(values), before, 'comparison does not reorder or mutate source objects');
});

test('arrays preserve order, multiplicity, nested missing literals and distinction from objects', async () => {
  const values = [[0, '0'], [0, '0'], ['0', 0], [0], [0, 0], [], {}, { 0: 0 }, [null], ['NA'], [''], '[]', '[object Object]'];
  assert.deepEqual(await both(values), [{ distinct: 12 }]);
});

test('structured keys and repeated shared children do not collide or count as cycles', async () => {
  const child = { value: false };
  const values = [
    { a: child, b: child },
    { b: { value: false }, a: { value: false } },
    { 'a:b': 'c' }, { a: 'b:c' },
    JSON.parse('{"__proto__":{"value":0}}'), { value: 0 }
  ];
  assert.deepEqual(await both(values), [{ distinct: 5 }]);
});

test('typed distinct works in grouped row and streaming outputs and retains empty declared domains', async () => {
  const rows = [{ group: 'observed', value: 0 }, { group: 'observed', value: '0' }, { group: 'observed', value: false }, { group: 'observed', value: 'false' }, { group: 'missing', value: null }];
  const args = { group_by: 'group', group_domains: [{ column: 'group', values: ['observed', 'missing', 'empty'] }], column: 'value', metrics: ['count', 'missing', 'distinct'] };
  const expected = [{ group: 'observed', count: 4, missing: 0, distinct: 4 }, { group: 'missing', count: 1, missing: 1, distinct: 0 }, { group: 'empty', count: 0, missing: 0, distinct: 0 }];
  assert.deepEqual(tools.aggregate(rows, args), expected);
  assert.deepEqual(await tools.aggregateStream(stream(rows), args, ['group', 'value']), expected);
  assert.deepEqual(await tools.aggregateStream(stream([...rows].reverse()), args, ['group', 'value']), expected);
});

test('non-JSON values reject explicitly in both distinct pathways instead of collapsing', async () => {
  const cycle = {}; cycle.self = cycle;
  const symbolKey = { [Symbol('x')]: 1 };
  const extraArray = []; extraArray.extra = 1;
  const invalid = [NaN, Infinity, -Infinity, 1n, Symbol('x'), () => 1, new Date(0), new Map(), { a: undefined }, { a: NaN }, { a: Infinity }, [undefined], Array(1), extraArray, symbolKey, cycle];
  for (const value of invalid) {
    const rows = [{ value }], args = { column: 'value', metrics: ['distinct'] };
    assert.throws(() => tools.aggregate(rows, args), /aggregate: distinct/);
    await assert.rejects(() => tools.aggregateStream(stream(rows), args, ['value']), /aggregate: distinct/);
  }
});

test('metrics other than distinct retain existing handling of nonnumeric cells', async () => {
  const cycle = {}; cycle.self = cycle;
  assert.deepEqual(await both([cycle, { a: undefined }, Infinity, () => 1, 2], { column: 'value', metrics: ['count', 'numeric_count', 'sum', 'missing'] }), [{ count: 5, numeric_count: 1, sum: 2, missing: 0 }]);
});
