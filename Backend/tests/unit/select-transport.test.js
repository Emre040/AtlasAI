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

const sourceRows = [{ gene: 'ONE', ensembl: 'ID1', value: 0, other: 7 }, { gene: 'TWO', ensembl: 'ID2', value: 2.5, other: null }];
const sourceEntry = { file: 'mapping.tsv', key: 'lookup', columns: ['gene', 'ensembl', 'value', 'other'] };
const planned = () => call('set_plan', { items: [{ step: 'Return the requested projection and exact constants', kind: 'table' }] });
const mapColumns = { value: '@measurement µ' };
const mapConstants = { '@label': '@literal', zero: 0, flag: false, missing: null, nested: { '$ref': '@literal', list: [0, false, null] }, json_text: '{"kept":"as text"}' };
const projection = ['gene', 'ensembl', '@measurement µ', '@label', 'zero', 'flag', 'missing', 'nested', 'json_text'];
const schemas = {
  type: 'object', properties: {
    artifact: { type: 'string', 'x-artifact-reference': true },
    rename: { type: 'object', additionalProperties: { type: 'string' } },
    add: { type: 'object', additionalProperties: {} }
  }, required: ['artifact']
};

for (const [representation, encode] of [['objects', value => value], ['JSON text', JSON.stringify]]) {
  test(`native select accepts ${representation}, preserves exact constants, and retains raw provider messages`, async t => {
    const args = { artifact: 'mapping.tsv', columns: ['gene', 'ensembl', 'value'], rename: encode(mapColumns), add: encode(mapConstants), node: 1 };
    const f = await fixture(t, ({ request, turn }) => {
      const spec = request.tools.find(tool => tool.function.name === 'select');
      assert.equal(spec.function.parameters.properties.rename.type, 'object');
      assert.equal(spec.function.parameters.properties.rename.additionalProperties.type, 'string');
      assert.equal(spec.function.parameters.properties.add.type, 'object');
      if (turn === 1) return response(planned(), call('select', args));
      assert.equal(turn, 2);
      const native = request.messages.flatMap(m => m.tool_calls || []).find(c => c.function.name === 'select');
      assert.equal(native.thought_signature, 'opaque-signature');
      assert.deepEqual(JSON.parse(native.function.arguments), args, 'transport decoding must not rewrite native history');
      return response(call('finish', { tables: [{ artifact: 'a1', columns: projection }] }));
    }, undefined, { entry: sourceEntry, rows: sourceRows });
    const result = await f.run();
    assert.equal(result.outcome, 'completed'); assert.equal(result.failed, 0); assert.equal(result.turns, 2);
    const saved = JSON.parse(await fs.readFile(result.artifacts[0].storage_uri, 'utf8'));
    assert.deepEqual(saved.rows[0], { gene: 'ONE', ensembl: 'ID1', '@measurement µ': 0, ...mapConstants });
    assert.equal(saved.rows[1]['@measurement µ'], 2.5);
  });

  test(`run select accepts ${representation} and resolves artifact handles while keeping @ map/filter values literal`, async t => {
    const first = { artifact: 'mapping.tsv', columns: ['value'], rename: encode(mapColumns), add: encode({ label: '@mapped' }) };
    const f = await fixture(t, ({ turn }) => {
      if (turn === 1) return response(planned(), call('run', { steps: [
        { id: 'mapped', tool: 'select', args: JSON.stringify(first) },
        { id: 'literal_filter', tool: 'filter', args: JSON.stringify({ artifact: '@mapped', where: [{ column: 'label', op: '=', value: '@mapped' }], node: 1 }) }
      ], outputs: ['literal_filter'] }));
      assert.equal(turn, 2); return response(call('finish', { tables: [{ artifact: 'a2', columns: ['gene', '@measurement µ', 'label'] }] }));
    }, undefined, { entry: sourceEntry, rows: sourceRows });
    const result = await f.run();
    assert.equal(result.outcome, 'completed'); assert.equal(result.failed, 0); assert.equal(result.turns, 2);
    const saved = JSON.parse(await fs.readFile(result.artifacts[1].storage_uri, 'utf8'));
    assert.equal(saved.rows.length, 2); assert.equal(saved.rows[0].label, '@mapped'); assert.equal(saved.rows[0]['@measurement µ'], 0);
    assert.equal(saved.args.artifact, 'a1'); assert.equal(saved.args.where[0].value, '@mapped');
  });

  test(`select ${representation} rejects source/target collisions and unknown fields explicitly`, async t => {
    for (const [args, expected] of [
      [{ columns: ['value', 'other'], rename: encode({ value: 'other' }) }, /distinct/],
      [{ columns: ['value'], add: encode({ gene: 'OVERWRITE' }) }, /distinct/],
      [{ columns: ['value'], rename: encode({ unknown_source: 'new' }) }, /rename source/],
      [{ columns: ['unknown_column'], rename: encode({}) }, /no column named/],
      [{ columns: ['value'], rename: encode({}), unknown_argument: 'ignored?' }, /not a declared argument/]
    ]) {
      const f = await fixture(t, () => response(planned(), call('select', { artifact: 'mapping.tsv', ...args, node: 1 })), undefined, { entry: sourceEntry, rows: sourceRows });
      const result = await f.run({ max_turns: 1 });
      assert.equal(result.outcome, 'incomplete'); assert.equal(result.artifacts.length, 0);
      assert.match(f.events.filter(event => ['tool.failed', 'call.failed'].includes(event.stage)).map(event => event.message).join('\n'), expected);
    }
  });

  test(`run select ${representation} keeps semantic and undeclared-field failures explicit`, async t => {
    for (const [args, expected] of [
      [{ columns: ['value', 'other'], rename: encode({ value: 'other' }) }, /distinct/],
      [{ columns: ['value'], add: encode({ gene: 'OVERWRITE' }) }, /distinct/],
      [{ columns: ['value'], rename: encode({ unknown_source: 'new' }) }, /rename source/],
      [{ columns: ['unknown_column'], rename: encode({}) }, /no column named/],
      [{ columns: ['value'], rename: encode({}), unknown_argument: 'ignored?' }, /not a declared argument/]
    ]) {
      const f = await fixture(t, () => response(planned(), call('run', { steps: [
        { id: 'projection', tool: 'select', args: JSON.stringify({ artifact: 'mapping.tsv', ...args, node: 1 }) }
      ], outputs: ['projection'] })), undefined, { entry: sourceEntry, rows: sourceRows });
      const result = await f.run({ max_turns: 1 });
      assert.equal(result.outcome, 'incomplete'); assert.equal(result.artifacts.length, 0);
      assert.match(JSON.stringify(f.events), expected);
    }
  });
}

test('native decoding rejects malformed and nonobject map representations before source operations', async t => {
  const invalidMaps = ['not json', 'null', '[]', '42', 'true', '"text"', JSON.stringify(JSON.stringify({ value: 'renamed' })), null, [], 42, false];
  for (const args of [...invalidMaps.map(rename => ({ rename })), ...invalidMaps.map(add => ({ add })), { rename: { value: 42 } }]) {
    let reads = 0;
    const f = await fixture(t, () => response(planned(), call('select', { artifact: 'mapping.tsv', ...args, node: 1 })), undefined, { entry: sourceEntry, rows: sourceRows, onRead: () => reads++ });
    const result = await f.run({ max_turns: 1 });
    assert.equal(result.outcome, 'incomplete'); assert.equal(result.artifacts.length, 0); assert.equal(reads, 0);
  }
});

test('batch decoding validates every map before any operation executes', async () => {
  for (const rename of ['bad JSON', '[]', 'null', null, 42, { value: 7 }]) {
    let executions = 0;
    await assert.rejects(() => executeBatch({ steps: [
      { id: 'good', tool: 'select', args: JSON.stringify({ artifact: 'source', rename: {} }) },
      { id: 'bad', tool: 'select', args: JSON.stringify({ artifact: '@good', rename }) }
    ], outputs: ['bad'] }, { specifications: new Map([['select', { parameters: schemas }]]), concurrency: 2, execute: () => { executions++; } }));
    assert.equal(executions, 0);
  }
});

test('only explicitly marked artifact fields become dependencies, including universe and for_each.of', async () => {
  const handle = { type: 'string', 'x-artifact-reference': true };
  const parameters = { type: 'object', properties: { artifact: handle, a: handle, b: handle, universe: handle,
    for_each: { type: 'object', properties: { of: handle, values: { type: 'array', items: { type: 'string' } } } },
    add: { type: 'object', additionalProperties: {} }, value: {} }, required: ['artifact'] };
  const seen = [];
  const result = await executeBatch({ steps: [
    { id: 'second', tool: 'operation', args: JSON.stringify({ artifact: '@first', a: '@first', b: '@first', universe: '@first', for_each: { of: '@first', values: ['@first', '@not_a_dependency'] }, add: { literal: '@not_a_dependency', '$ref': '@literal' }, value: '@first' }) },
    { id: 'first', tool: 'operation', args: JSON.stringify({ artifact: 'source' }) }
  ], outputs: ['second'] }, { specifications: new Map([['operation', { parameters }]]), concurrency: 2, execute: async (name, args) => { seen.push(args); return { ok: true, artifact: { id: seen.length === 1 ? 'saved-first' : 'saved-second' } }; } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(seen[1], { artifact: 'saved-first', a: 'saved-first', b: 'saved-first', universe: 'saved-first', for_each: { of: 'saved-first', values: ['@first', '@not_a_dependency'] }, add: { literal: '@not_a_dependency', '$ref': '@literal' }, value: '@first' });
});

test('schema-guided decoding preserves arbitrary untyped constants and rejects unknown prototype-shaped arguments', () => {
  const args = JSON.parse('{"artifact":"source","rename":"{\\"value\\":\\"new name\\"}","add":{"constructor":"literal","__proto__":{"kept":true},"json":"{\\"x\\":1}"}}');
  const decoded = decodeArguments(args, schemas, 'select'); validate(decoded, schemas, 'select');
  assert.deepEqual(decoded.rename, { value: 'new name' }); assert.equal(decoded.add.json, '{"x":1}');
  const rows = select(sourceRows, ['value'], decoded.rename, decoded.add);
  assert.equal(Object.hasOwn(rows[0], '__proto__'), true); assert.deepEqual(rows[0].__proto__, { kept: true });
  assert.equal(rows[0].constructor, 'literal'); assert.equal(rows[0].gene, 'ONE');
  assert.throws(() => validate(JSON.parse('{"artifact":"source","constructor":{}}'), schemas, 'select'), /not a declared argument/);
});

test('Gemini keeps free logical maps as explicit JSON text on wire and drops internal artifact markers', async t => {
  const f = await fixture(t, ({ request }) => {
    const logical = request.tools.find(tool => tool.function.name === 'select');
    const wire = buildRequest({ messages: [{ role: 'user', content: 'Project the requested fields' }], tools: [logical] }, { configKey: 'gemini-3.8-flash', modelId: 'gemini-3.8-flash', reasoningEffort: 'low' });
    const parameters = wire.tools[0].functionDeclarations[0].parameters;
    assert.equal(parameters.properties.rename.type, 'STRING'); assert.match(parameters.properties.rename.description, /JSON object written as text/);
    assert.equal(parameters.properties.add.type, 'STRING'); assert.match(parameters.properties.add.description, /JSON object written as text/);
    assert.doesNotMatch(JSON.stringify(parameters), /additionalProperties|x-artifact-reference/);
    return response(planned(), call('select', { artifact: 'mapping.tsv', rename: JSON.stringify({ value: 'new' }), node: 1 }));
  }, undefined, { entry: sourceEntry, rows: sourceRows });
  const result = await f.run({ max_turns: 1 });
  assert.equal(result.artifacts.length, 1); assert.equal(result.failed, 0);
});
