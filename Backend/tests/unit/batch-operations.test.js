'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeBatch } = require('../../src/system/aso/batchOperations');

const specifications = new Map([['compute', { parameters: { type: 'object', properties: { artifact: { type: 'string', 'x-artifact-reference': true } }, required: ['artifact'] } }]]);
const step = (id, artifact) => ({ id, tool: 'compute', args: JSON.stringify({ artifact }) });

test('a productive dependency graph has no private operation-count ceiling', async () => {
  const steps = Array.from({ length: 71 }, (_, i) => step(`step_${i}`, i ? `@step_${i - 1}` : 'source'));
  const calls = [];
  const result = await executeBatch({ steps, outputs: ['step_70'] }, { specifications, concurrency: 3, execute: async (name, args) => {
    assert.equal(args.artifact, calls.length ? `a${calls.length}` : 'source');
    calls.push(args);
    return { ok: true, artifact: { id: `a${calls.length}` } };
  } });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps.length, 71);
  assert.equal(result.outputs[0].artifact.id, 'a71');
});

test('invalid graphs and non-data capabilities fail before any operation executes', async () => {
  let calls = 0;
  const context = { specifications, concurrency: 2, execute: () => { calls++; } };
  await assert.rejects(() => executeBatch({ steps: [step('one', '@two'), step('two', '@one')], outputs: ['two'] }, context), /cycle/);
  await assert.rejects(() => executeBatch({ steps: [{ id: 'agent', tool: 'aso_hpa', args: '{}' }], outputs: ['agent'] }, context), /aso_hpa is not a table operation, so it cannot be a run step \(steps hold /);
  await assert.rejects(() => executeBatch({ steps: [step('one', 'source'), { id: 'two', tool: 'compute', args: '{"artifact":9}' }], outputs: ['one'] }, context), /must be string/);
  assert.equal(calls, 0);
});

test('a failed graph branch preserves independent results and blocks dependent work', async () => {
  const called = [];
  const result = await executeBatch({ steps: [step('bad', 'invalid'), step('good', 'source'), step('child', '@bad')], outputs: ['good', 'child'] }, {
    specifications, concurrency: 2, execute: async (name, args) => {
      called.push(args.artifact);
      if (args.artifact === 'invalid') throw new Error('source unavailable');
      return { ok: true, artifact: { id: 'good_result' } };
    }
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.steps.map(item => item.status), ['failed', 'done', 'blocked']);
  assert.deepEqual(called.sort(), ['invalid', 'source']);
  assert.equal(result.outputs[0].artifact.id, 'good_result');
});

test('a bare step id in an artifact argument means that step; an @id of an existing artifact is used as is', async () => {
  const calls = [];
  const execute = async (name, args) => { calls.push(args.artifact); return { ok: true, artifact: { id: `a${calls.length + 10}` } }; };
  const result = await executeBatch({ steps: [step('first', 'a1'), step('second', 'first'), step('third', '@a2')], outputs: ['second', 'third'] }, { specifications, concurrency: 2, execute, external: id => (['a1', 'a2'].includes(id) ? id : null) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.sort(), ['a1', 'a11', 'a2'], 'second read the artifact first made; third read the existing artifact a2');
  await assert.rejects(() => executeBatch({ steps: [step('only', '@nowhere')], outputs: ['only'] }, { specifications, concurrency: 1, execute, external: () => null }), /references unknown step nowhere/);
});
