'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { CapabilityCatalog } = require('../../src/system/aso/capabilityCatalog');

let callId = 0;
const call = (name, args) => {
  return { id: `test_${++callId}`, type: 'function', thought_signature: 'opaque-signature', function: { name, arguments: JSON.stringify(args) } };
};
const transcript = request => request.messages.map(m => {
  if (m.role === 'tool') {
    const result = JSON.parse(m.content);
    return [result.plan, result.observations, result.error].filter(Boolean).join('\n');
  }
  return m.content || '';
}).join('\n');
const response = (...tool_calls) => ({ choices: [{ message: { tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t, decide, execute, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aso-loop-test-'));
  await fs.mkdir(path.join(directory, 'artifacts'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const events = [], updates = [], requests = [];
  const agentDone = deferred();
  const entry = options.entry || { file: 'mapping.tsv', key: 'stream', title: 'Mapping', columns: ['name', 'value'] };
  let artifact = 0;
  const stubs = {
    // Most tests isolate execution with tools already loaded. Cold-discovery tests
    // below use the real initial catalog and actual load_tools exchanges.
    '../aso/capabilityCatalog': { CapabilityCatalog: options.nativeDiscovery ? CapabilityCatalog : class extends CapabilityCatalog {
      constructor(args) { super({ ...args, coreNames: args.tools.map(tool => tool.function.name) }); }
    } },
    '../../inference/gateway': { getActiveModel: () => ({ id: 1, configKey: 'test-model' }), inference: {
      assignContext() {},
      chat: { completions: { async create(request) { requests.push(request); return decide({ request, turn: requests.length, agentDone }); } } }
    } },
    '../../policy/config': { platformConfig: () => ({ asoMaxSteps: 40, asoParallelLimit: 3, asoContextBytes: 8192 }) },
    '../../hpa/geneDataAdapter': { async catalog() { return [entry]; }, async entry(name) { return name === entry.file ? entry : null; }, definition: () => null },
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../hpa/localData': { FILES: { master: 'mapping.tsv' }, localData: { async master() { return { rows: options.rows }; }, async *rows(name) {
      if (options.onRead) await options.onRead();
      if (options.rawFile) {
        const [header, ...lines] = (await fs.readFile(path.join(directory, name), 'utf8')).trimEnd().split('\n');
        const columns = header.split('\t');
        for (const line of lines) { const cells = line.split('\t'); yield Object.fromEntries(columns.map((column, i) => [column, cells[i]])); }
        return;
      }
      if (options.rows) { yield* options.rows; return; }
      for (let i = 0; i < 17; i++) yield { name: `label ${i}`, value: i };
    } } },
    '../aso/workspaceStore': { async createWorkspace() { return { id: 1, uuid: 'test-study', workspaceDir: directory, artifactsDir: path.join(directory, 'artifacts'), logPath: path.join(directory, 'events.ndjson') }; }, async updateWorkspace(db, id, update) { updates.push(update); } },
    '../aso/artifactStore': { async registerArtifact(db, args) { const id = ++artifact; const storageUri = args.storageUriOverride || path.join(directory, 'artifacts', `${id}.json`); if (!args.skipWrite) await fs.writeFile(storageUri, JSON.stringify(args.payload)); return { artifactUuid: `artifact-${id}`, storageUri }; } },
    '../aso/pipelines/renderCharts': { renderCharts: options.renderCharts || (async (spec, renderDir) => { const image = path.join(renderDir, 'plot.png'); await fs.writeFile(image, 'rendered test image'); return { images: [image] }; }) },
    '../orchestrator': { getToolSpecs: () => [
      { type: 'function', function: { name: 'deep_research_hpa', parameters: { type: 'object', properties: { goal: { type: 'string' }, mode: { type: 'string' } }, required: ['goal'] } } },
      { type: 'function', function: { name: 'investigator_hpa', parameters: { type: 'object', properties: { gene: { type: 'string' }, question: { type: 'string' }, mode: { type: 'string' } }, required: ['gene'] } } }
    ], execute: execute || (() => { throw new Error('Unexpected agent call'); }) }
  };
  const filename = require.resolve('../../src/system/agents/asoStudy');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const run = args => loaded.exports({ goal: 'Inspect the available evidence', ...args }, { db: {}, visitorId: 1, async onStep(event) { events.push(event); if (event.stage === 'tool.failed') t.diagnostic(event.message); if (['tool.done', 'tool.failed'].includes(event.stage)) agentDone.resolve(event); } });
  return { run, events, requests, updates, directory };
}

const graphStep = (id, tool, args) => ({ id, tool, args: JSON.stringify(args) });

test('partial iteration retains exact completed rows, blocks its dependent graph branch and cannot finish a plan item', async t => {
  let partialId;
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Process every requested column', kind: 'table' }] }), call('run', {
      steps: [
        graphStep('mixed', 'compute', { artifact: 'mapping.tsv', name: 'doubled', expr: '$item * 2', for_each: { values: ['value', 'absent'], as: 'requested_column' }, node: 1 }),
        graphStep('dependent', 'aggregate', { artifact: '@mixed', column: 'doubled', metrics: ['sum'] }),
        graphStep('independent', 'aggregate', { artifact: 'mapping.tsv', column: 'value', metrics: ['sum'] })
      ], outputs: ['mixed', 'dependent', 'independent']
    }));
    if (turn === 2) {
      assert.match(transcript(request), /partial|incomplete execution/);
      const graph = request.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).find(m => m.steps);
      partialId = graph.steps[0].artifact;
      return response(call('update_plan', { item: 1, status: 'done', artifacts: [partialId] }));
    }
    assert.match(transcript(request), /update_plan refused.*incomplete execution/);
    return response(call('finish', { summary: `Only the completed source rows are available (${partialId}).` }));
  }, undefined, { rows: [{ name: 'A', value: 0 }, { name: 'B', value: 3 }] });
  const result = await f.run({ max_turns: 3 });
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.plan[0].status, 'doing');
  const payloads = await Promise.all(result.artifacts.map(a => fs.readFile(a.storage_uri, 'utf8').then(JSON.parse)));
  const saved = payloads.find(a => a.provenance.execution?.status === 'partial');
  assert.ok(saved);
  assert.deepEqual(saved.rows.map(r => [r.requested_column, r.value, r.doubled]), [['value', 0, 0], ['value', 3, 6]]);
  assert.equal(saved.rows.some(r => Object.hasOwn(r, 'error')), false);
  assert.deepEqual(saved.provenance.execution.failed.map(failure => [failure.index, failure.item]), [[1, 'absent']]);
  assert.match(saved.provenance.execution.failed[0].error, /absent/);
  assert.equal(payloads.length, 2, 'failed branch preserved alongside independent output, dependent never ran');
  const starts = f.events.filter(event => event.stage === 'tool.start').map(event => JSON.parse(event.message));
  assert.equal(starts.filter(event => event.tool === 'aggregate').length, 1);
  const graph = f.requests[1].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).find(m => m.steps);
  assert.deepEqual(graph.steps.map(step => step.status), ['failed', 'blocked', 'done']);
  assert.equal(graph.steps[0].artifact, partialId);
  assert.equal(graph.outputs.some(output => output.step === 'mixed' && output.artifact === partialId), true);
});

test('all-empty successful iterations preserve exact declared columns and complete normally', async t => {
  const f = await fixture(t, ({ turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Filter requested groups', kind: 'table' }] }), call('filter', { artifact: 'mapping.tsv', where: [{ column: 'name', op: '=', value: '$item' }], for_each: { values: ['unmatched_A', 'unmatched_B'], as: 'requested_group' }, node: 1 }));
    return response(call('finish', { summary: 'No rows matched the requested filters (a1).' }));
  }, undefined, { rows: [{ name: 'A', value: null }] });
  const result = await f.run();
  assert.equal(result.outcome, 'completed');
  const saved = JSON.parse(await fs.readFile(result.artifacts[0].storage_uri, 'utf8'));
  assert.deepEqual(saved.rows, []);
  assert.ok(saved.columns.includes('name'));
  assert.ok(saved.columns.includes('value'));
  assert.ok(saved.columns.includes('requested_group'));
  assert.deepEqual(saved.provenance.execution, { status: 'completed', requested: 2, completed: 2, failed: [] });
});

test('all failed iterations save no fabricated measurements and retain every failure in execution metadata', async t => {
  const names = ['missing_one', 'missing_two', 'missing_three'];
  const f = await fixture(t, ({ turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Process requested columns', kind: 'table' }] }), call('compute', { artifact: 'mapping.tsv', name: 'derived', expr: '$item * 2', for_each: { values: names, as: 'requested_column' }, node: 1 }));
    return response(call('finish', { summary: 'Requested operations remain incomplete (a1).' }));
  }, undefined, { rows: [{ name: 'A', value: 1 }] });
  const result = await f.run({ max_turns: 2 });
  assert.equal(result.outcome, 'incomplete');
  const saved = JSON.parse(await fs.readFile(result.artifacts[0].storage_uri, 'utf8'));
  assert.deepEqual(saved.rows, []);
  assert.deepEqual(saved.columns, ['requested_column']);
  assert.equal(saved.provenance.execution.completed, 0);
  assert.deepEqual(saved.provenance.execution.failed.map(failure => failure.item), names);
});

test('selecting a derived descendant cannot hide partial ancestry, while an independent complete output can finish', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Produce the selected complete source summary', kind: 'table' }] }), call('compute', { artifact: 'mapping.tsv', name: 'doubled', expr: '$item * 2', for_each: { values: ['value', 'absent'], as: 'requested_column' } }));
    if (turn === 2) return response(call('compute', { artifact: 'a1', name: 'offset_value', expr: 'doubled + 1' }));
    if (turn === 3) return response(call('select', { artifact: 'a2', columns: ['offset_value'] }));
    if (turn === 4) return response(call('update_plan', { item: 1, status: 'done', artifacts: ['a3'] }));
    if (turn === 5) {
      assert.match(transcript(request), /update_plan refused.*incomplete execution in selected evidence ancestry: a1/);
      return response(call('aggregate', { artifact: 'mapping.tsv', column: 'value', metrics: ['sum'] }));
    }
    if (turn === 6) return response(call('update_plan', { item: 1, status: 'done', artifacts: ['a4'] }));
    assert.equal(turn, 7);
    return response(call('finish', { summary: 'The independent complete source summary is available (a4).' }));
  }, undefined, { rows: [{ name: 'A', value: 0 }, { name: 'B', value: 3 }] });
  const result = await f.run();
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.plan[0].artifacts, ['a4']);
  assert.equal(result.plan[0].status, 'done');
  assert.equal(result.failed, 1, 'unrelated failed work does not make complete selected evidence incomplete');
  const saved = await Promise.all(result.artifacts.map(a => fs.readFile(a.storage_uri, 'utf8').then(JSON.parse)));
  assert.equal(saved[0].provenance.execution.status, 'partial');
  assert.equal(saved[1].args.artifact, 'a1');
  assert.equal(saved[2].args.artifact, 'a2');
  assert.equal(saved[2].provenance.execution, undefined, 'the rejection follows lineage even after local partial metadata is absent');
  assert.equal(saved[3].args.artifact, 'mapping.tsv');
});
