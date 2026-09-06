'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const BACKEND = path.resolve(__dirname, '../..');
const { CapabilityCatalog } = require(path.join(BACKEND, 'src/system/aso/capabilityCatalog'));

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
  const filename = require.resolve(path.join(BACKEND, 'src/system/agents/asoStudy'));
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

// These exercise the real ASO loop with deterministic gateway/tool stubs only.
// No model/API requests, real data reads, database writes or runtime changes.
const partialCall = () => call('compute', { artifact: 'mapping.tsv', name: 'doubled', expr: '$item * 2', for_each: { values: ['value', 'absent'], as: 'requested_column' } });
const sourceRows = [{ name: 'A', value: 0 }, { name: 'B', value: 3 }];
const sourceSummary = () => call('aggregate', { artifact: 'mapping.tsv', column: 'value', metrics: ['sum'] });
const finishTable = (artifact, columns) => call('finish', { completed: [{ item: 1, artifacts: [artifact] }], tables: [{ artifact, columns }] });

test('finish.completed follows a partial for_each.of selector and permits independent complete evidence', async t => {
  let sawRejection = false;
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Deliver a complete source summary', kind: 'table' }] }), partialCall());
    if (turn === 2) return response(call('compute', { artifact: 'mapping.tsv', name: 'rescaled', expr: '$item * 3', for_each: { column: 'requested_column', of: 'a1', as: 'selected_column' } }));
    if (turn === 3) return response(finishTable('a2', ['name', 'rescaled']));
    if (turn === 4) {
      assert.match(transcript(request), /finish.completed item 1: incomplete execution in selected evidence ancestry: a1/);
      sawRejection = true;
      return response(sourceSummary());
    }
    assert.equal(turn, 5);
    return response(finishTable('a3', ['sum']));
  }, undefined, { rows: sourceRows });
  const result = await f.run({ max_turns: 6 });
  assert.equal(sawRejection, true, 'the selector source must prevent premature completion');
  assert.equal(result.outcome, 'completed', result.error);
  assert.deepEqual(result.plan[0].artifacts, ['a3']);
  const saved = await Promise.all(result.artifacts.map(a => fs.readFile(a.storage_uri,'utf8').then(JSON.parse)));
  assert.equal(saved[0].provenance.execution.status,'partial');
  assert.equal(saved[1].provenance.execution.status,'completed', 'local iterations complete even though selector ancestry is partial');
  assert.ok(saved[1].provenance.sources.includes('artifact-1'), 'record the artifact used to enumerate items');
  assert.deepEqual(saved[2].provenance.sources, [], 'independent raw-source summary has no partial ancestry');
});

test('finish.completed follows actual substituted artifact inputs and permits independent complete evidence', async t => {
  let sawRejection = false;
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Deliver a complete source summary', kind: 'table' }] }), partialCall(), call('select', { artifact: 'mapping.tsv', columns: ['name','value'] }));
    if (turn === 2) return response(call('select', { artifact: '$item', columns: ['name','value'], for_each: { values: ['a1','a2'], as: 'source_artifact' } }));
    if (turn === 3) return response(finishTable('a3', ['source_artifact','name','value']));
    if (turn === 4) {
      assert.match(transcript(request), /finish.completed item 1: incomplete execution in selected evidence ancestry: a1/);
      sawRejection = true;
      return response(sourceSummary());
    }
    assert.equal(turn, 5);
    return response(finishTable('a4',['sum']));
  }, undefined, { rows: sourceRows });
  const result = await f.run({ max_turns: 6 });
  assert.equal(sawRejection,true,'resolved partial artifact must prevent premature completion');
  assert.equal(result.outcome,'completed',result.error);
  assert.deepEqual(result.plan[0].artifacts,['a4']);
  const saved = await Promise.all(result.artifacts.map(a => fs.readFile(a.storage_uri,'utf8').then(JSON.parse)));
  assert.equal(saved[0].provenance.execution.status,'partial');
  assert.equal(saved[2].provenance.execution.status,'completed');
  assert.ok(saved[2].provenance.sources.includes('artifact-1'));
  assert.ok(saved[2].provenance.sources.includes('artifact-2'));
  assert.deepEqual(saved[3].provenance.sources, []);
});
