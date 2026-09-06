'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const modulePath = process.env.ATLASAI_NUMERIC_MODULE || path.resolve(__dirname, '../../src/system/aso/summaryEvidence');
const { statedNumbers, unverifiedNumbers, verificationIssues } = require(modulePath);
const state = (value, goal = '') => { const artifact = { id: 'a1', rows: [{ gene: 'SYNTHETIC', value }] }; return { goal, artifacts: [artifact], byId: new Map([['a1', artifact]]) }; };

test('Unicode and caret scientific notation are one exact numeric mention, preserving displayed precision', () => {
  for (const raw of ['3.75 × 10⁸', '3.75⋅10⁸', '3.75 · 10^8', '3.75 * 10 ^ +8']) {
    assert.deepEqual(statedNumbers(raw), [{ raw, value: 375000000, tolerance: 500000 }]);
  }
  for (const raw of ['-6.20 × 10⁻³', '-6.20 × 10^-3', '-6.20 × 10^−3']) {
    assert.deepEqual(statedNumbers(raw), [{ raw, value: -0.0062, tolerance: statedNumbers('-6.20e-3')[0].tolerance }]);
  }
});

test('ordinary decimals and e notation keep their existing values, ordering and raw spelling', () => {
  const text = '1.25; 3.75 × 10⁸; -2.6e-3; 1,200.50; 7';
  const actual = statedNumbers(text);
  assert.deepEqual(actual.map(x => x.raw), ['1.25','3.75 × 10⁸','-2.6e-3','1,200.50']);
  assert.deepEqual(actual.map(x => x.value), [1.25,375000000,-0.0026,1200.5]);
});

test('finish verification accepts a correctly formatted source quantity without accepting its isolated mantissa', () => {
  assert.deepEqual(unverifiedNumbers('Recorded concentration: 3.75 × 10⁸ (a1).', state(375000000)), []);
  assert.deepEqual(unverifiedNumbers('Recorded concentration: 3.75 × 10⁸ (a1).', state(3.75)), ['3.75 × 10⁸']);
  assert.deepEqual(unverifiedNumbers('Recorded concentration: 8.50 × 10⁸ (a1).', state(375000000)), ['8.50 × 10⁸']);
  assert.equal(verificationIssues('Recorded concentration: 3.75 × 10⁸.', state(375000000))[0].reason, 'no_source_citation');
});

test('scientific quantities embedded in source text are screened as the full value', () => {
  assert.deepEqual(unverifiedNumbers('The source value is 2.34e6 (a1).', state('Observed 2.34 × 10⁶ in the source')), []);
  assert.deepEqual(unverifiedNumbers('The source value is 2.34 (a1).', state('Observed 2.34 × 10⁶ in the source')), ['2.34']);
});

test('positive and negative exponent renderings match e notation across different scales', () => {
  const encode = n => [...String(n)].map(c => c === '-' ? '⁻' : '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(c)]).join('');
  for (const mantissa of ['1.37', '-9.125', '24.50']) for (const exponent of [-9,-3,3,9]) {
    const expected = statedNumbers(`${mantissa}e${exponent}`)[0];
    const actual = statedNumbers(`${mantissa} × 10${encode(exponent)}`)[0];
    assert.equal(actual.value, expected.value); assert.equal(actual.tolerance, expected.tolerance);
  }
});


test('Unicode minus preserves sign and terminal punctuation does not split the exponent', () => {
  const mention = statedNumbers('−6.20 × 10⁻³.')[0];
  assert.equal(mention.raw, '−6.20 × 10⁻³'); assert.equal(mention.value, -0.0062);
  assert.equal(statedNumbers('−3.25')[0].value, -3.25);
  assert.deepEqual(unverifiedNumbers('The source quantity is −6.20 × 10⁻³ (a1).', state(0.0062)), ['−6.20 × 10⁻³']);
});
