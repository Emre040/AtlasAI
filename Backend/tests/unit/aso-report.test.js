'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReport } = require('../../src/system/aso/studyReport');
const { unverifiedNumbers } = require('../../src/system/aso/summaryEvidence');

test('reports insert exact artifact values, preserve zeros and missing values, and declare partial tables', () => {
  const a = { id: 'a1', label: 'Measurements', rows: [{ identifier: 'A|B', value: 12.125 }, { identifier: 'C', value: 0 }, { identifier: 'D', value: null }], columns: ['identifier', 'value'] };
  const state = { byId: new Map([['a1', a]]), artifacts: [a] };
  const full = renderReport({ summary: 'Evidence (a1).', tables: [{ artifact: 'a1', columns: ['identifier', 'value'] }] }, state);
  assert.match(full, /A\\\|B \| 12\.125/); assert.match(full, /C \| 0/); assert.match(full, /D \| —/);
  assert.deepEqual(unverifiedNumbers(full, state), []);
  assert.match(renderReport({ tables: [{ artifact: 'a1', columns: ['value'], rows: 1 }] }, state), /Showing 1 of 3 rows/);
  assert.throws(() => renderReport({ tables: [{ artifact: 'a1', columns: ['wrong'] }] }, state), /exact columns/);
  assert.throws(() => renderReport({ tables: [{ artifact: 'missing', columns: ['value'] }] }, state), /saved row artifact/);
});
