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
