'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const BACKEND = process.env.ATLASAI_BACKEND_ROOT || path.resolve(__dirname, '../..');
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
  const entry = options.entry || { file: 'mapping.tsv', key: 'lookup', title: 'Mapping', columns: ['name', 'value'] };
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
    '../../hpa/localData': { FILES: { master: 'mapping.tsv' }, localData: { async master() { return { rows: options.rows }; }, async table() { if (options.onRead) await options.onRead(); return { columns: entry.columns, rows: options.rows || [] }; }, async *rows(name) {
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
      { type: 'function', function: { name: 'investigator_hpa', parameters: { type: 'object', properties: { gene: { type: 'string' }, question: { type: 'string' }, mode: { type: 'string' } }, required: ['gene'] } } },
      ...(options.extraAgentSpecs || [])
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

const original = 'Return two exact source tables for ONE; exclude subregions. Then correlate and draw one figure.\r\nDo not claim matched samples.  ';
const assigned = 'Retrieve both source measurement tables with exact labels, zeros and missingness';
const sourceEntries = [
  { file: 'first.tsv', key: 'ensembl', title: 'First source', columns: ['Gene', 'Region', 'Value'] },
  { file: 'second.tsv', key: 'ensembl', title: 'Second source', columns: ['Gene', 'Region', 'Value'] }
];
const observed = [
  { Gene: 'ID1', Region: 'first region', Value: '0' },
  { Gene: 'ID1', Region: 'second region', Value: '' },
  { Gene: 'ID1', Region: 'third region', Value: '7' }
];
const retrieve = () => sourceEntries.map((entry, i) => call('apply_bulk', { name: `source_${i}`, lookups: [{ table: entry.file, mode: 'rows', match_column: 'Gene', columns: ['Region', 'Value'] }] }));
const finished = extra => call('finish', { results: ['source_0', 'source_1'], unavailable_requirements: [], ...extra });

async function bulkFixture(decide, onRead) {
  const filename = require.resolve(path.join(BACKEND, 'src/system/agents/investigatorBulk'));
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded), requests = [], reads = [];
  const stubs = {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'fixture' }; } },
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      return { choices: [{ message: { role: 'assistant', tool_calls: await decide({ request, turn: requests.length }) } }], usage: { prompt_tokens: 4, completion_tokens: 1 } };
    } } } } }
  };
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : originalRequire(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const adapter = {
    async catalog() { return sourceEntries; }, async entry(file) { return sourceEntries.find(entry => entry.file === file); },
    async resolveGenes(genes) { return genes.map(gene => ({ gene, ensembl: 'ID1' })); },
    async read(gene, file) { return { entry: sourceEntries.find(entry => entry.file === file), rows: observed }; },
    async readMany(genes, file) { reads.push(file); onRead?.(); return { entry: sourceEntries.find(entry => entry.file === file), byGene: new Map([['ID1', observed]]) }; }
  };
  return { requests, reads, run: (args = {}, ctx = {}) => loaded.exports({ genes: ['ONE'], question: assigned, ...args }, { studyGoal: original, studyTask: assigned, ...ctx }, adapter) };
}

for (const requirements of [undefined, []]) test(`completed narrow assignment returns public ok through bulk and ASO (${requirements === undefined ? 'omitted' : 'empty'} unfinished requirements)`, async t => {
  const bulk = await bulkFixture(({ request, turn }) => {
    const native = request.tools.find(tool => tool.function.name === 'finish').function;
    assert.ok(Object.hasOwn(native.parameters.properties, 'unfinished_requirements'));
    assert.ok(!Object.hasOwn(native.parameters.properties, 'remaining_for_aso'));
    const user = request.messages.find(message => message.role === 'user').content;
    const context = `Original study context (constraints only; not additional assigned deliverables):\n${original}\nEnd of original study context.\n\nASSIGNMENT\nQuestion: ${assigned}\nAssigned plan result: ${assigned}`;
    assert.ok(user.endsWith(context), 'exact original context precedes the final authoritative assignment');
    assert.equal(user.split(original).length - 1, 1);
    if (turn === 1) return retrieve();
    assert.equal(turn, 2); assert.equal(request.messages[2].tool_calls[0].thought_signature, 'opaque-signature');
    return [finished(requirements === undefined ? {} : { unfinished_requirements: requirements })];
  });
  let bulkResult, invocations = 0;
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: assigned, kind: 'table' }] }), call('investigator_hpa', { genes: ['ONE'], question: assigned, node: 1 }));
    assert.equal(turn, 2); assert.doesNotMatch(transcript(request), /Unfinished work for ASO|unfinished requirements:/);
    return response(call('finish', { completed: [{ item: 1, artifacts: ['a1', 'a2'] }], tables: [{ artifact: 'a1', columns: ['gene', 'Region', 'Value'] }, { artifact: 'a2', columns: ['gene', 'Region', 'Value'] }] }));
  }, async (name, args, ctx) => { invocations++; bulkResult = await bulk.run(args, ctx); return { result: bulkResult }; }, { nativeDiscovery: true });
  const result = await f.run({ goal: original });
  assert.equal(bulkResult.status, 'ok'); assert.deepEqual(bulkResult.remaining_for_aso, []);
  assert.ok(!Object.hasOwn(bulkResult, 'unfinished_requirements'), 'public result API remains unchanged');
  assert.equal(result.outcome, 'completed', JSON.stringify(result)); assert.equal(result.plan[0].status, 'done');
  assert.equal(invocations, 1); assert.equal(f.requests.length, 2); assert.equal(bulk.requests.length, 2);
  assert.deepEqual(bulk.reads, ['first.tsv', 'second.tsv']); assert.equal(result.token_breakdown.investigator_hpa.total, 10);
  assert.equal(result.tokens.total, 34);
  for (const artifact of result.artifacts) {
    const saved = JSON.parse(await fs.readFile(artifact.storage_uri, 'utf8'));
    assert.equal(saved.rows.length, 3); assert.equal(Number(saved.rows[0].Value), 0);
    assert.ok(saved.rows[1].Value === null || saved.rows[1].Value === '');
    assert.deepEqual(saved.provenance.remaining_for_aso, []);
  }
});

for (const field of ['unfinished_requirements', 'unavailable_requirements']) test(`true ${field} remains partial through both finish.completed and update_plan`, async t => {
  const obligation = { requirement: 'Compute the requested per-entity uncertainty from the original replicate measurements', why: field === 'unavailable_requirements' ? 'The imported release contains no replicate uncertainty source' : 'The assigned uncertainty calculation is not represented by these raw tables' };
  const bulk = await bulkFixture(({ turn }) => turn === 1 ? retrieve() : [finished({ [field]: [obligation] })]);
  let bulkResult;
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: obligation.requirement, kind: 'table' }] }), call('investigator_hpa', { genes: ['ONE'], question: obligation.requirement, node: 1 }));
    if (turn === 2) return response(call('finish', { completed: [{ item: 1, artifacts: ['a1', 'a2'] }], tables: [{ artifact: 'a1', columns: ['gene', 'Region', 'Value'] }] }));
    if (turn === 3) {
      assert.match(transcript(request), /finish.completed item 1: Investigator returned supporting data with unfinished requirements/);
      return response(call('update_plan', { item: 1, status: 'done', artifacts: ['a1', 'a2'] }));
    }
    assert.equal(turn, 4); assert.match(transcript(request), /update_plan refused for item 1/);
    return response(call('finish', { tables: [{ artifact: 'a1', columns: ['gene', 'Region', 'Value'] }] }));
  }, async (name, args, ctx) => { bulkResult = await bulk.run(args, ctx); return { result: bulkResult }; });
  const result = await f.run({ goal: original, max_turns: 4 });
  assert.equal(bulkResult.status, 'partial');
  assert.deepEqual(field === 'unfinished_requirements' ? bulkResult.remaining_for_aso : bulkResult.not_in_release, [obligation]);
  assert.equal(result.outcome, 'incomplete', JSON.stringify(result)); assert.notEqual(result.plan[0].status, 'done');
  assert.equal(result.artifacts.length, 2); assert.equal(bulk.requests.length, 2);
  assert.equal(f.requests.length, 4);
});

test('the obsolete native field is rejected explicitly and can be repaired without an implicit alias', async () => {
  const obligation = { requirement: assigned, why: 'One assigned output remains unfulfilled' };
  const bulk = await bulkFixture(({ request, turn }) => {
    if (turn === 1) return retrieve();
    if (turn === 2) return [finished({ remaining_for_aso: [obligation] })];
    assert.equal(turn, 3); assert.match(request.messages.at(-1).content, /finish.remaining_for_aso is not a declared argument/);
    return [finished({ unfinished_requirements: [obligation] })];
  });
  const result = await bulk.run(); assert.equal(result.status, 'partial');
  assert.deepEqual(result.remaining_for_aso, [obligation]); assert.equal(bulk.reads.length, 2);
});

test('a source gap can finish without tables and preserves its exact public evidence status', async () => {
  const gap = { requirement: 'Retrieve requested source records', why: 'No source in this imported release provides the requested measurement' };
  const bulk = await bulkFixture(() => [call('finish', { results: [], unavailable_requirements: [gap] })]);
  const result = await bulk.run(); assert.equal(result.status, 'partial'); assert.equal(result.found, false);
  assert.deepEqual(result.not_in_release, [gap]); assert.deepEqual(result.remaining_for_aso, []); assert.equal(bulk.reads.length, 0);
});

for (const stop of ['cancelled', 'token_budget_exhausted', 'no_progress_cycle']) test(`${stop} retains only the actual assignment as unfinished`, async () => {
  const controller = new AbortController();
  const bulk = await bulkFixture(() => [retrieve()[0]], stop === 'cancelled' ? () => controller.abort() : undefined);
  const ctx = stop === 'cancelled' ? { signal: controller.signal } : stop === 'token_budget_exhausted' ? { budget: { total_tokens: 5 } } : {};
  const result = await bulk.run({}, ctx);
  assert.equal(result.status, 'partial'); assert.equal(result.stop_reason, stop); assert.equal(result.tables.length, 1);
  assert.equal(result.remaining_for_aso.length, 1); assert.equal(result.remaining_for_aso[0].requirement, assigned);
  assert.notEqual(result.remaining_for_aso[0].requirement, original); assert.equal(bulk.reads.length, 1);
});
