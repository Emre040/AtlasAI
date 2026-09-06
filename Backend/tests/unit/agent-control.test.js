'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentStop, RepairProgress, createAgentControl } = require('../../src/system/aso/agentControl');
const control = (ctx = {}, stats = { totalTokens: 0 }) => createAgentControl({ ctx, stats, agentKey: 'test-agent' });

test('productive repair states have no private iteration ceiling; exact cycles stop', () => {
  const progress = new RepairProgress();
  for (let evidence = 0; evidence < 50; evidence++) progress.record({ evidence, issues: ['unverified'] }, 'stalled');
  assert.throws(() => progress.record({ issues: ['unverified'], evidence: 10 }, 'stalled'), err => err instanceof AgentStop && err.reason === 'no_progress_cycle');
});

test('the shared controller must explicitly return allowed true or false', async () => {
  for (const decision of [undefined, null, {}, true, false, { allowed: 1 }, { allowed: 'true' }, []]) {
    await assert.rejects(control({ runControl: { async checkpoint() { return decision; } } }).checkpoint('Answer', true), /allowed: true or allowed: false/);
  }
  await control({ runControl: { async checkpoint() { return { allowed: true }; } } }).checkpoint('Answer', true);
  await assert.rejects(control({ runControl: { async checkpoint() { return { allowed: false, reason: 'shared_exhausted', message: 'No allocation remains' }; } } }).checkpoint('Answer', true), err => err.reason === 'shared_exhausted' && err.message === 'No allocation remains');
});

test('all checkpoints preserve exact agent identity and inference admission intent', async () => {
  const calls = [], stats = { totalTokens: 25 };
  const instance = control({ runControl: { async checkpoint(event) { calls.push(event); return { allowed: true }; } } }, stats);
  await instance.checkpoint('Read source'); await instance.checkpoint('Answer', true);
  assert.deepEqual(calls, [{ agentKey: 'test-agent', phase: 'Read source', beforeInference: false }, { agentKey: 'test-agent', phase: 'Answer', beforeInference: true }]);
  assert.equal(stats.totalTokens, 25, 'agent aggregates must not be charged again');
});

test('only explicit caller budgets restrict actual token usage and deadline', async () => {
  const stats = { totalTokens: 10 };
  await control({}, stats).checkpoint('Answer', true);
  const instance = control({ budget: { total_tokens: 10 } }, stats);
  await instance.checkpoint('Consume the completed result');
  await assert.rejects(instance.checkpoint('Next inference', true), err => err.reason === 'token_budget_exhausted');
  await assert.rejects(control({ budget: { deadline_unix_ms: 0 } }).checkpoint('Read source'), err => err.reason === 'deadline_reached');
  for (const budget of [null, { max_turns: 3 }, { total_tokens: -1 }, { total_tokens: 0.5 }, { deadline_unix_ms: 'today' }]) assert.throws(() => control({ budget }), /budget/);
  await assert.rejects(control({ budget: { total_tokens: 20 } }, { totalTokens: NaN }).checkpoint('Answer', true), /actual nonnegative integer usage/);
});

test('cancellation is checked before actions and after a shared asynchronous decision', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(control({ signal: controller.signal }).checkpoint('Read source'), err => err.reason === 'cancelled');
  const later = new AbortController();
  await assert.rejects(control({ signal: later.signal, runControl: { async checkpoint() { later.abort(); return { allowed: true }; } } }).checkpoint('Answer', true), err => err.reason === 'cancelled');
});

test('malformed controller or checkpoint configuration fails explicitly', async () => {
  for (const runControl of [null, false, {}, { checkpoint: true }]) assert.throws(() => control({ runControl }), /runControl.checkpoint/);
  await assert.rejects(control().checkpoint('Answer', 'yes'), /boolean/);
});
