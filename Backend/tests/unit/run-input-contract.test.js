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

const { ARGUMENTS_SCHEMA } = require(path.join(BACKEND, 'src/system/aso/batchOperations'));
const sourceRows = [{ gene: 'ONE', ensembl: 'ID1', region: 'region A', value: 0 }, { gene: 'TWO', ensembl: 'ID2', region: 'region B', value: 2.5 }];
const entry = { file: 'mapping.tsv', key: 'lookup', columns: ['gene', 'ensembl', 'region', 'value'] };
const plan = () => call('set_plan', { items: [{ step: 'Return aligned exact measurements', kind: 'table' }] });

for (const [outerName, outer] of [['object', x => x], ['JSON text', JSON.stringify]]) {
  for (const [innerName, inner] of [['object', x => x], ['JSON text', JSON.stringify]]) {
    test(`run accepts ${outerName} arguments with ${innerName} maps without a repair turn`, async t => {
      const steps = [
        { id: 'left', tool: 'select', args: outer({ artifact: 'mapping.tsv', columns: ['gene', 'region', 'value'], rename: inner({ value: 'left_value' }), add: inner({ label: '@not_a_reference' }) }) },
        { id: 'right', tool: 'select', args: outer({ artifact: 'mapping.tsv', columns: ['gene', 'region', 'value'], rename: inner({ value: 'right_value' }) }) },
        { id: 'paired', tool: 'join', args: outer({ a: '@left', b: '@right', how: 'full', on_columns: ['gene', 'region'], node: 1 }) }
      ];
      const f = await fixture(t, ({ request, turn }) => {
        const logical = request.tools.find(tool => tool.function.name === 'run');
        assert.deepEqual(logical.function.parameters.properties.steps.items.properties.args, ARGUMENTS_SCHEMA);
        const wire = buildRequest({ messages: [{ role: 'user', content: 'Align the requested values' }], tools: [logical] }, { configKey: 'gemini-3.8-flash', modelId: 'gemini-3.8-flash', reasoningEffort: 'low' });
        const wireArgs = wire.tools[0].functionDeclarations[0].parameters.properties.steps.items.properties.args;
        assert.equal(wireArgs.type, 'STRING'); assert.match(wireArgs.description, /JSON object written as text/);
        if (turn === 1) return response(plan(), call('run', { steps, outputs: ['paired'] }));
        assert.equal(turn, 2);
        const native = request.messages.flatMap(m => m.tool_calls || []).find(c => c.function.name === 'run');
        assert.equal(native.thought_signature, 'opaque-signature');
        assert.deepEqual(JSON.parse(native.function.arguments).steps, steps, 'decoding must preserve native history');
        return response(call('finish', { tables: [{ artifact: 'a3', columns: ['gene', 'region', 'left_value', 'right_value', 'label'] }] }));
      }, undefined, { entry, rows: sourceRows });
      const result = await f.run();
      assert.equal(result.outcome, 'completed'); assert.equal(result.turns, 2); assert.equal(result.failed, 0);
      const paired = JSON.parse(await fs.readFile(result.artifacts[2].storage_uri, 'utf8'));
      assert.equal(paired.rows.length, 2); assert.equal(paired.rows[0].left_value, 0); assert.equal(paired.rows[0].right_value, 0); assert.equal(paired.rows[1].right_value, 2.5);
      assert.equal(paired.rows[0].label, '@not_a_reference'); assert.equal(paired.args.a, 'a1'); assert.equal(paired.args.b, 'a2');
    });
  }
}

test('invalid run transport and registered arguments are rejected before source operations', async t => {
  for (const args of ['invalid json', 'null', '[]', '42', 'true', '"text"', JSON.stringify(JSON.stringify({ artifact: 'mapping.tsv' })), null, [], 42, false, { artifact: 'mapping.tsv', unexpected: true }, { artifact: 'mapping.tsv', rename: '[]' }]) {
    let reads = 0;
    const f = await fixture(t, () => response(plan(), call('run', { steps: [
      { id: 'valid', tool: 'select', args: { artifact: 'mapping.tsv' } },
      { id: 'invalid', tool: 'select', args }
    ], outputs: ['valid', 'invalid'] })), undefined, { entry, rows: sourceRows, onRead: () => reads++ });
    const result = await f.run({ max_turns: 1 });
    assert.equal(result.outcome, 'incomplete'); assert.equal(result.artifacts.length, 0); assert.equal(reads, 0);
    assert.ok(f.events.some(event => event.stage === 'call.failed'));
  }
});

test('object and encoded direct batches retain complete registered preflight and graph validation', async () => {
  const parameters = { type: 'object', properties: { artifact: { type: 'string', 'x-artifact-reference': true } }, required: ['artifact'] };
  const specs = new Map([['operation', { parameters }]]);
  for (const encode of [x => x, JSON.stringify]) {
    let calls = 0;
    const ctx = { specifications: specs, concurrency: 2, execute: async () => { calls++; return { ok: true, artifact: { id: 'saved' } }; } };
    for (const steps of [
      [{ id: 'first', tool: 'operation', args: encode({ artifact: '@missing' }) }],
      [{ id: 'first', tool: 'operation', args: encode({ artifact: '@second' }) }, { id: 'second', tool: 'operation', args: encode({ artifact: '@first' }) }],
      [{ id: 'first', tool: 'operation', args: encode({ artifact: 'source', unknown: 'value' }) }],
      [{ id: 'first', tool: 'investigator_hpa', args: encode({ artifact: 'source' }) }]
    ]) await assert.rejects(() => executeBatch({ steps, outputs: ['first'] }, ctx));
    assert.equal(calls, 0);
    const result = await executeBatch({ steps: [{ id: 'first', tool: 'operation', args: encode({ artifact: 'source' }) }], outputs: ['first'] }, ctx);
    assert.equal(result.status, 'completed'); assert.equal(calls, 1);
  }
});

test('ASO includes actual dictionary inference in all-agent totals exactly once', async t => {
  const { dictionaryFixture, dictionaryResponse } = require('../helpers/dictionaryFixture');
  const dictionary = await dictionaryFixture({ responses: [dictionaryResponse('["liver"]', 17, 3), dictionaryResponse('["kidney"]', 31, 5)] });
  const f = await fixture(t, ({ turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Return the requested dictionary source description', kind: 'summary' }] }), call('dictionary_expert_hpa', { topic: 'requested topics', node: 1 }));
    assert.equal(turn, 2); return response(call('finish', { summary: 'The requested dictionary source description is recorded in artifact a1.' }));
  }, async () => ({ result: await dictionary.run({ topics: ['first topic', 'second topic'] }), steps: [] }), {
    extraAgentSpecs: [{ type: 'function', function: { name: 'dictionary_expert_hpa', parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } } }]
  });
  const result = await f.run();
  assert.equal(result.outcome, 'completed'); assert.equal(dictionary.requests.length, 2);
  assert.deepEqual(result.token_breakdown.dictionary_expert_hpa, { prompt: 48, completion: 8, total: 56 });
  assert.deepEqual(result.token_breakdown.aso_hpa, { prompt: 20, completion: 4, total: 24 });
  assert.deepEqual(result.tokens, { prompt: 68, completion: 12, total: 80 });
});
