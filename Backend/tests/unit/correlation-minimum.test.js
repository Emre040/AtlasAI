'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../../src/system/aso/studyTools');
const options = { x: 'left', y: 'right' };

for (const method of ['pearson', 'spearman']) {
  for (const direction of [1, -1]) {
    test(`${method}: two complete nonconstant pairs retain direction ${direction} with valid inference semantics`, () => {
      const rows = [{ left: 0, right: 5 }, { left: 3, right: 5 + direction * 7 }];
      const [result] = tools.correlate(rows, { ...options, method });
      assert.equal(result.n, 2);
      assert.equal(result.r, direction);
      assert.equal(result.p_value, method === 'pearson' ? 1 : null);
      if (method === 'spearman') assert.match(result.note, /asymptotic p-value is undefined for 2 pairs/);
      else assert.equal(result.note, undefined);
      assert.deepEqual(tools.correlate([...rows].reverse(), { ...options, method }), [result]);
    });
  }

  test(`${method}: two-pair constant vectors remain undefined on both axes`, () => {
    for (const rows of [[{ left: 0, right: 1 }, { left: 0, right: 2 }], [{ left: 1, right: 0 }, { left: 2, right: 0 }]]) {
      const [result] = tools.correlate(rows, { ...options, method });
      assert.equal(result.n, 2); assert.equal(result.r, null); assert.equal(result.p_value, null);
      assert.match(result.note, /no variation/);
    }
  });

  test(`${method}: missing observations do not increase pair counts and numeric zero remains recorded`, () => {
    const rows = [{ left: '0', right: '5' }, { left: '3', right: '9' }, { left: '', right: 20 }, { left: 50, right: null }, { left: false, right: 10 }, { left: 'NA', right: 8 }, { left: Infinity, right: 3 }];
    const before = structuredClone(rows);
    const [result] = tools.correlate(rows, { ...options, method });
    assert.equal(result.n, 2); assert.equal(result.r, 1);
    assert.deepEqual(rows, before);
    assert.throws(() => tools.correlate(rows.slice(1), { ...options, method }), /only 1 rows.*at least 2 are needed/);
  });

  test(`${method}: grouped output distinguishes zero, one, two, constant and three complete pairs`, () => {
    const rows = [
      { entity: 'zero', left: null, right: 9 },
      { entity: 'one', left: 3, right: 5 },
      { entity: 'two', left: 3, right: 9 }, { entity: 'two', left: 6, right: 0 },
      { entity: 'constant', left: 0, right: 2 }, { entity: 'constant', left: 0, right: 3 },
      { entity: 'three', left: 1, right: 4 }, { entity: 'three', left: 2, right: 5 }, { entity: 'three', left: 3, right: 6 }
    ];
    const result = tools.correlate(rows, { ...options, method, group_by: 'entity' });
    assert.deepEqual(result.map(r => [r.entity, r.n, r.r]), [['zero', 0, null], ['one', 1, null], ['two', 2, -1], ['constant', 2, null], ['three', 3, 1]]);
    for (const item of result.slice(0, 2)) assert.match(item.note, /fewer than 2 rows/);
    assert.match(result[3].note, /no variation/);
    assert.equal(result[4].p_value, 0);
  });
}

test('existing larger-sample Pearson and tied-rank Spearman results remain unchanged', () => {
  const rows = [[1, 3], [2, 1], [2, 4], [4, 2], [5, 2]].map(([left, right]) => ({ left, right }));
  // Independently checked against scipy.stats.pearsonr and spearmanr.
  assert.deepEqual(tools.correlate(rows, options), [{ x: 'left', y: 'right', method: 'pearson', n: 5, r: -0.3469, p_value: 0.567 }]);
  assert.deepEqual(tools.correlate(rows, { ...options, method: 'spearman' }), [{ x: 'left', y: 'right', method: 'spearman', n: 5, r: -0.3684, p_value: 0.542 }]);
});

test('finite two-pair inputs do not become undefined from variance underflow or overflow', () => {
  for (const rows of [[{ left: 0, right: 0 }, { left: 1e-200, right: 2e-200 }], [{ left: -1e308, right: 1e308 }, { left: 1e308, right: -1e308 }]]) {
    const [result] = tools.correlate(rows, options);
    assert.equal(Math.abs(result.r), 1); assert.equal(result.p_value, 1);
  }
});
