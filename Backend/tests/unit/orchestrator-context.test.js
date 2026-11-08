'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

test('concurrent specialist dispatch retains caller context and records each exact agent identity', async () => {
  const context = new AsyncLocalStorage();
  const handler = async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    return { ...context.getStore() };
  };
  const filename = require.resolve('../../src/system/orchestrator');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => {
    if (name === '../inference/gateway') return { inference: { withContext: (fields, run) => context.run({ ...context.getStore(), ...fields }, run) } };
    if (name.startsWith('./agents/')) return handler;
    throw new Error(`Unexpected import ${name}`);
  };
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  await context.run({ visitorId: 42, workspaceId: 7, purpose: 'manual' }, async () => {
    const results = await Promise.all(['investigator_hpa', 'deep_research_hpa'].map(name => loaded.exports.execute(name, {})));
    assert.deepEqual(results.map(({ result }) => result.agentKey), ['investigator_hpa', 'deep_research_hpa']);
    assert.ok(results.every(({ result }) => result.visitorId === 42 && result.workspaceId === 7 && result.purpose === 'manual'));
    assert.equal(context.getStore().agentKey, undefined);
  });
});

test('a search that stops on criteria it cannot express becomes a study carrying the user\'s words and what the search could not express', async () => {
  const filename = require.resolve('../../src/system/orchestrator');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => (name === '../inference/gateway' ? { inference: {} } : async () => ({}));
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const { studyForUnexpressible } = loaded.exports;
  const stop = { status: 'error', stop_reason: 'unexpressible_requirements', result: { not_expressible: [{ requirement: 'the top ones', why: 'no field ranks genes' }] } };
  const study = studyForUnexpressible('deep_research_hpa', stop, { userText: 'find the top ECM proteins', searchGoal: 'proteins secreted to the extracellular matrix' });
  assert.equal(study.name, 'aso_hpa');
  assert.equal(study.args.goal, 'find the top ECM proteins\n\nThe request as the search read it: proteins secreted to the extracellular matrix\n\nThe atlas search alone cannot express: the top ones (no field ranks genes).');
  assert.equal(studyForUnexpressible('deep_research_hpa', { ...stop, stop_reason: 'unresolved_requirements' }, { userText: 'x' }), null, 'only a stop on unexpressible criteria hands over');
  assert.equal(studyForUnexpressible('deep_research_hpa', { status: 'ok' }, { userText: 'x' }), null);
  assert.equal(studyForUnexpressible('investigator_hpa', stop, { userText: 'x' }), null);
  assert.match(loaded.exports.OUT_OF_SCOPE_REPLY, /^I can only help with questions about the Human Protein Atlas/);
});
