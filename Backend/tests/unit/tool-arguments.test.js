'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeArguments } = require('../../src/system/aso/toolArguments');

const schema = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
    from: { type: 'string' },
    column: { type: 'string' },
    where: { type: 'array', items: { type: 'object' } }
  },
  required: ['question']
};

test('an optional argument given empty is not given; a required one stays as written', () => {
  const args = decodeArguments({ question: 'partners of a gene', points: [], from: '', column: '', where: null }, schema, 'investigator_hpa');
  assert.deepEqual(args, { question: 'partners of a gene' });
  const required = decodeArguments({ question: '', from: 'a1' }, schema, 'investigator_hpa');
  assert.deepEqual(required, { question: '', from: 'a1' }, 'a required argument is left for the validator to report');
  const given = decodeArguments({ question: 'q', points: ['TP53'], from: 'a2', column: 'gene' }, schema, 'investigator_hpa');
  assert.deepEqual(given, { question: 'q', points: ['TP53'], from: 'a2', column: 'gene' });
});

test('keys the schema does not declare are kept for the validator', () => {
  const args = decodeArguments({ question: 'q', extra: '' }, schema, 'investigator_hpa');
  assert.deepEqual(args, { question: 'q', extra: '' });
});
