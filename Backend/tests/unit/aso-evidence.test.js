'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { unverifiedNumbers, verificationIssues } = require('../../src/system/aso/summaryEvidence');

function evidence(value) {
  const artifact = { id: 'a1', rows: [{ gene: 'TEST', value }] };
  return { goal: '', artifacts: [artifact], byId: new Map([['a1', artifact]]) };
}

test('a table may cite its source in an explicit introduction or adjacent caption', () => {
  const table = '| Gene | Value |\n| --- | --- |\n| TEST | 1.25 |';
  assert.deepEqual(unverifiedNumbers(`Measurements from a1:\n\n${table}`, evidence(1.25)), []);
  assert.deepEqual(unverifiedNumbers(`${table}\n\n*(Source: Artifact a1)*`, evidence(1.25)), []);
  assert.deepEqual(unverifiedNumbers(`A previous result mentions a1.\n\n${table}`, evidence(1.25)), ['1.25']);
});

test('wrong numbers and uncomputed unit conversions are rejected despite a valid citation', () => {
  assert.deepEqual(unverifiedNumbers('Measured 1250.0 (a1).', evidence(1.25)), ['1250.0']);
  assert.deepEqual(unverifiedNumbers('| Gene | Value |\n| TEST | 17.3 |\n\nSource: a1', evidence(1.25)), ['17.3']);
  assert.deepEqual(unverifiedNumbers('The measurement is 1.250 (a1).', evidence(1.25)), []);
});

test('repair feedback isolates the unsupported passage and names the actual cause', () => {
  const issues = verificationIssues('The measurement is 1.25 (a1).\n\nThe other result is 17.3.', evidence(1.25));
  assert.deepEqual(issues, [{ paragraph: 'The other result is 17.3.', artifacts: [], numbers: ['17.3'], reason: 'no_source_citation' }]);
});

test('figure citations support plotted values while missing heatmap cells never count as zero', () => {
  const a = { id: 'a1', figure: { data: [{ x: 12.5, y: 17.2 }], matrix: [[null, 5.3]] } };
  const state = { goal: '', artifacts: [a], byId: new Map([['a1', a]]) };
  assert.deepEqual(unverifiedNumbers('The point is at 12.5 and 17.2 (a1).', state), []);
  assert.deepEqual(unverifiedNumbers('The heatmap shows 0.0 (a1).', state), ['0.0']);
  assert.deepEqual(unverifiedNumbers('The point is at 12500.0 (a1).', state), ['12500.0']);
});

test('an explicit list introduction scopes citations to its lists, not unrelated prose', () => {
  const state = evidence(1.25);
  assert.deepEqual(unverifiedNumbers('Measurements from a1:\n\n- First: 1.25\n\n- Second: 1.25', state), []);
  assert.deepEqual(unverifiedNumbers('Measurements from a1:\n\n- First: 1.25\n\nUnrelated result: 1.25', state), ['1.25']);
});
