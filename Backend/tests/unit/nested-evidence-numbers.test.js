'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { unverifiedNumbers, verificationIssues } = require('../../src/system/aso/summaryEvidence');

function state(metadata, other) {
  const a1 = { id: 'a1', rows: [{ gene: 'EXAMPLE', metadata }] };
  const artifacts = [a1];
  if (other !== undefined) artifacts.push({ id: 'a2', rows: [{ metadata: other }] });
  return { goal: '', artifacts, byId: new Map(artifacts.map(a => [a.id, a])) };
}

test('nested object and array source values support exact rendered facts', () => {
  const evidence = state({ threshold: 97.125, records: [{ score: '18.625' }, { nested: [[-2048.5, { intensity: 6312.75 }]] }] });
  assert.deepEqual(unverifiedNumbers('Source thresholds and observations are 97.125, 18.625, -2048.5 and 6312.75 (a1).', evidence), []);
  assert.deepEqual(unverifiedNumbers('The unrecorded value is 97.875 (a1).', evidence), ['97.875']);
});

test('nested source text retains exponent, multiplication and superscript notation semantics', () => {
  const evidence = state({ values: ['1.25e6', { description: 'Recorded concentration: 2.05 × 10⁹', other: ['−3.75 × 10^−4', '9,876.5'] }] });
  assert.deepEqual(unverifiedNumbers('Values are 1.25 × 10⁶, 2.05e9, -0.000375 and 9876.5 (a1).', evidence), []);
  assert.deepEqual(unverifiedNumbers('Value is 2.05 (a1).', evidence), ['2.05'], 'scientific mantissas must not become standalone observations');
});

test('nested null, blanks, booleans and nonfinite cells never manufacture zero', () => {
  const evidence = state({ nullValue: null, empty: '', whitespace: '  ', absent: undefined, values: [false, true, NaN, Infinity, -Infinity, 'NaN', 'Infinity', '1e309', [], {}] });
  evidence.artifacts[0].rows.push({ gene: 'OTHER' });
  assert.deepEqual(unverifiedNumbers('The recorded value is 0.0 (a1).', evidence), ['0.0']);
  assert.deepEqual(unverifiedNumbers('The recorded value is 1.0 (a1).', evidence), ['1.0'], 'booleans must not become numeric observations');
  const zeros = state({ values: [0, '0', '0.00'] });
  assert.deepEqual(unverifiedNumbers('The recorded zero is 0.0 (a1).', zeros), []);
});

test('object keys and array indexes are not treated as recorded numeric values', () => {
  const evidence = state({ '9876.5': 'category label', nested: { '2.05 × 10⁹': null }, values: ['unmeasured', 'absent'] });
  assert.deepEqual(unverifiedNumbers('Measured values were 9876.5 and 2.05e9 (a1).', evidence), ['9876.5', '2.05e9']);
});

test('nested values still require the correct explicit artifact citation', () => {
  const evidence = state({ recorded: 17.25 }, { recorded: 97.125 });
  assert.deepEqual(unverifiedNumbers('The value is 97.125 (a1).', evidence), ['97.125']);
  assert.deepEqual(unverifiedNumbers('The value is 97.125 (a2).', evidence), []);
  assert.equal(verificationIssues('The value is 97.125.', evidence)[0].reason, 'no_source_citation');
});

test('recursive numeric screening does not claim to verify row identity or scientific interpretation', () => {
  const evidence = state({ gene: 'SOURCE_ENTITY', value: 17.25 });
  assert.deepEqual(unverifiedNumbers('Another entity measured 17.25 and this proves its cause (a1).', evidence), [], 'numeric screening alone cannot establish entity binding or causal semantics');
});
