'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const BACKEND = process.env.ATLASAI_BACKEND_ROOT || path.resolve(__dirname, '../..');
const { CapabilityCatalog } = require(path.join(BACKEND, 'src/system/aso/capabilityCatalog'));
const { buildRequest } = require(path.join(BACKEND, 'src/inference/adapters/geminiGenerateContent'));
const { executeBatch, validate } = require(path.join(BACKEND, 'src/system/aso/batchOperations'));
const { decodeArguments } = require(path.join(process.env.ATLASAI_SELECT_PROPOSAL_ROOT || BACKEND, 'src/system/aso/toolArguments'));
const { select } = require(path.join(BACKEND, 'src/system/aso/studyTools'));

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

const source = [{ cohort: 'A', phase: 'first', amount: 0 }, { cohort: 'A', phase: 'first', amount: 8 }, { cohort: 'A', phase: 'second', amount: null }, { cohort: 'B', phase: 'third', amount: 2 }];
const sourceEntry = { file: 'mapping.tsv', key: 'stream', title: 'Uneven synthetic categories', columns: ['cohort', 'phase', 'amount'] };
const aggregateArgs = { group_by_columns: ['cohort', 'phase'], group_domains: [{ column: 'cohort', values: ['A', 'B'] }, { column: 'phase', values: ['first', 'second', 'third'] }], column: 'amount', metrics: ['count', 'numeric_count', 'zero', 'median', 'missing'], node: 1 };
const expectedRows = [
  { cohort: 'A', phase: 'first', count: 2, numeric_count: 2, zero: 1, median: 4, missing: 0 },
  { cohort: 'A', phase: 'second', count: 1, numeric_count: 0, zero: 0, median: null, missing: 1 },
  { cohort: 'A', phase: 'third', count: 0, numeric_count: 0, zero: 0, median: null, missing: 0 },
  { cohort: 'B', phase: 'first', count: 0, numeric_count: 0, zero: 0, median: null, missing: 0 },
  { cohort: 'B', phase: 'second', count: 0, numeric_count: 0, zero: 0, median: null, missing: 0 },
  { cohort: 'B', phase: 'third', count: 1, numeric_count: 1, zero: 0, median: 2, missing: 0 }
];
for (const pathKind of ['direct_stream', 'run_saved_table']) test(`registered ASO ${pathKind} saves complete domains and truthful empty statistics`, async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Return every joint category combination and observed statistics', kind: 'table' }] }), call('load_tools', { names: pathKind === 'direct_stream' ? ['aggregate'] : ['aggregate', 'select'] }));
    if (turn === 2) {
      const logical = request.tools.find(tool => tool.function.name === 'aggregate');
      assert.ok(logical.function.parameters.properties.group_domains);
      assert.equal(logical.function.parameters.properties.group_domains.type, 'array');
      const wire = buildRequest({ messages: [{ role: 'user', content: 'Return complete joint category counts' }], tools: [logical] }, { configKey: 'gemini-3.8-flash', modelId: 'gemini-3.8-flash', reasoningEffort: 'low' });
      const domainWire = wire.tools[0].functionDeclarations[0].parameters.properties.group_domains;
      assert.equal(domainWire.type, 'ARRAY'); assert.equal(domainWire.items.type, 'OBJECT'); assert.equal(domainWire.items.properties.values.type, 'ARRAY');
      if (pathKind === 'direct_stream') return response(call('aggregate', { artifact: 'mapping.tsv', ...aggregateArgs }));
      return response(call('run', { steps: [{ id: 'source', tool: 'select', args: JSON.stringify({ artifact: 'mapping.tsv' }) }, { id: 'groups', tool: 'aggregate', args: JSON.stringify({ artifact: '@source', ...aggregateArgs }) }], outputs: ['groups'] }));
    }
    assert.equal(turn, 3, transcript(request));
    return response(call('finish', { completed: [{ item: 1, artifacts: [pathKind === 'direct_stream' ? 'a1' : 'a2'] }], tables: [{ artifact: pathKind === 'direct_stream' ? 'a1' : 'a2', columns: ['cohort', 'phase', 'count', 'numeric_count', 'zero', 'median', 'missing'] }] }));
  }, undefined, { nativeDiscovery: true, entry: sourceEntry, rows: source });
  const result = await f.run(); assert.equal(result.outcome, 'completed', JSON.stringify(result)); assert.equal(result.failed, 0);
  const art = JSON.parse(await fs.readFile(result.artifacts.at(-1).storage_uri, 'utf8'));
  assert.deepEqual(art.rows, expectedRows); assert.deepEqual(art.args.group_domains, aggregateArgs.group_domains);
  assert.ok(result.summary.includes('| A | third | 0 | 0 | 0 | — | 0 |'), 'exact final report must retain zero-count category and undefined median');
});

for (const transport of ['direct', 'run']) test(`registered ASO ${transport} retains numeric, string, boolean and null category types`, async t => {
  const input = [{ label: 0, amount: 0 }, { label: '0', amount: 3 }, { label: false, amount: null }, { label: null, amount: 5 }];
  const args = { artifact: 'mapping.tsv', group_by: 'label', group_domains: [{ column: 'label', values: [0, '0', false, null, 'missing'] }], column: 'amount', metrics: ['count', 'numeric_count', 'median'], node: 1 };
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) {
      const logical = request.tools.find(tool => tool.function.name === 'aggregate');
      const wire = buildRequest({ messages: [{ role: 'user', content: 'Preserve typed categories' }], tools: [logical] }, { configKey: 'gemini-3.8-flash', modelId: 'gemini-3.8-flash', reasoningEffort: 'low' });
      const scalar = wire.tools[0].functionDeclarations[0].parameters.properties.group_domains.items.properties.values.items;
      assert.deepEqual(scalar.anyOf.map(branch => branch.type), ['STRING', 'NUMBER', 'BOOLEAN', 'NULL']);
      return response(call('set_plan', { items: [{ step: 'Return distinct typed category counts', kind: 'table' }] }), transport === 'direct' ? call('aggregate', args) : call('run', { steps: [{ id: 'groups', tool: 'aggregate', args: JSON.stringify(args) }], outputs: ['groups'] }));
    }
    assert.equal(turn, 2, transcript(request)); return response(call('finish', { tables: [{ artifact: 'a1', columns: ['label', 'count', 'numeric_count', 'median'] }] }));
  }, undefined, { entry: { file: 'mapping.tsv', key: 'stream', title: 'Typed categories', columns: ['label', 'amount'] }, rows: input });
  const result = await f.run(); assert.equal(result.outcome, 'completed', JSON.stringify(result)); assert.equal(result.failed, 0);
  const artifact = JSON.parse(await fs.readFile(result.artifacts[0].storage_uri, 'utf8'));
  assert.deepEqual(artifact.rows.map(row => [row.label, row.count, row.numeric_count, row.median]), [[0, 1, 1, 0], ['0', 1, 1, 3], [false, 1, 0, null], [null, 1, 1, 5], ['missing', 0, 0, null]]);
});

test('ASO rejects an observed out-of-domain row instead of saving a silently restricted table', async t => {
  const f = await fixture(t, ({ turn }) => {
    assert.equal(turn, 1);
    return response(call('set_plan', { items: [{ step: 'Return the full observation counts', kind: 'table' }] }), call('aggregate', { artifact: 'mapping.tsv', ...aggregateArgs, group_domains: [{ column: 'cohort', values: ['A'] }, aggregateArgs.group_domains[1]] }));
  }, undefined, { entry: sourceEntry, rows: source });
  const result = await f.run({ max_turns: 1 });
  assert.equal(result.outcome, 'incomplete'); assert.equal(result.artifacts.length, 0);
  assert.ok(f.events.some(event => ['call.failed', 'tool.failed'].includes(event.stage) && /outside declared domain/.test(event.message)));
});
