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
const { classify, columnsOf, withColumns, CLASSIFY_SCHEMA } = require(path.join(BACKEND, 'src/system/aso/studyTools'));
const { createBulkTools, APPLY_BULK } = require(path.join(BACKEND, 'src/system/agents/investigatorBulkTools'));

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

const rule = (where, value) => ({ where, value });
const classification = { name: 'category', rules: [
  rule([{ column: 'value', op: 'is_missing' }], 'unrecorded'),
  rule([{ column: 'value', op: '<', value: 0 }], 'negative'),
  rule([{ column: 'value', op: '=', value: 0 }], 'zero'),
  rule([{ column: 'value', op: 'is_numeric' }], 'positive')
], otherwise: 'other recorded' };

test('ordered classification preserves source values and distinguishes missing, zero, negative and text', () => {
  const values = [undefined, null, '', 'NA', 0, '0', -3, '-1.2', 2, '3', 'text', '2-4'];
  const rows = values.map((value, i) => ({ gene: `S${i}`, value, prior: { immutable: [i] } }));
  const before = structuredClone(rows);
  const result = classify(rows, classification);
  assert.deepEqual(result.map(row => row.category), ['unrecorded', 'unrecorded', 'unrecorded', 'unrecorded', 'zero', 'zero', 'negative', 'negative', 'positive', 'positive', 'other recorded', 'other recorded']);
  assert.deepEqual(rows, before); assert.equal(result.length, rows.length);
  result.forEach((row, i) => { const { category, ...original } = row; assert.deepEqual(original, before[i]); });
  assert.deepEqual(result.classification.matched_rows, [4, 2, 2, 2]);
  assert.equal(result.classification.otherwise_rows, 2);
  assert.deepEqual(result.classification.domain, ['unrecorded', 'negative', 'zero', 'positive', 'other recorded']);
  assert.deepEqual(columnsOf(result), ['gene', 'value', 'prior', 'category']);
});

test('the first matching rule wins and later categories remain in the explicit domain', () => {
  const args = { name: 'category', rules: [rule([{ column: 'value', op: '>=', value: 0 }], 'broad'), rule([{ column: 'value', op: '>', value: 5 }], 'narrow')], otherwise: null };
  const result = classify([{ value: 10 }, { value: -1 }], args);
  assert.deepEqual(result.map(row => row.category), ['broad', null]);
  assert.deepEqual(result.classification.domain, ['broad', 'narrow', null]);
  assert.deepEqual(result.classification.matched_rows, [1, 0]);
  args.rules[0].where[0].value = 100;
  assert.equal(result.classification.rules[0].where[0].value, 0, 'provenance is a snapshot');
});

test('all scalar label types remain exact, including null, booleans and text resembling artifact handles', () => {
  const labels = [null, false, true, 0, -2.5, '0', 'null', '@another_step'];
  const rows = labels.map((_, i) => ({ index: i }));
  const result = classify(rows, { name: 'typed', rules: labels.map((value, i) => rule([{ column: 'index', op: '=', value: i }], value)), otherwise: '@unmatched' });
  assert.deepEqual(result.map(row => row.typed), labels);
  assert.deepEqual(result.classification.domain, [...labels, '@unmatched']);
});

test('classification reuses conjunction and column comparison semantics from registered filtering', () => {
  const result = classify([{ a: 2, b: 1, kind: 'x' }, { a: 0, b: 2, kind: 'x' }, { a: 5, b: null, kind: 'x' }, { a: 3, b: 1, kind: 'y' }], { name: 'included', rules: [rule([{ column: 'a', op: '>', column_b: 'b' }, { column: 'kind', op: 'in', value: ['x'] }], true)], otherwise: false });
  assert.deepEqual(result.map(row => row.included), [true, false, false, false]);
  assert.deepEqual(result.classification.predicate_columns, ['a', 'b', 'kind']);
});

test('empty tables retain schema and the complete declared category domain', () => {
  const rows = withColumns([], ['gene', 'value']);
  const result = classify(rows, classification);
  assert.deepEqual([...result], []); assert.deepEqual(columnsOf(result), ['gene', 'value', 'category']);
  assert.deepEqual(result.classification.matched_rows, [0, 0, 0, 0]); assert.equal(result.classification.otherwise_rows, 0);
  assert.equal(result.classification.domain.length, 5);
  const defaults = classify([{ value: 1 }], { name: 'constant', rules: [], otherwise: null });
  assert.equal(defaults[0].constant, null);
});

test('invalid rules/defaults/columns and overwrite attempts fail before changing any rows', () => {
  const rows = withColumns([{ value: 0 }], ['value']); const before = structuredClone(rows);
  for (const args of [
    { ...classification, name: 'value' }, { ...classification, name: 'VALUE' }, { ...classification, name: '' },
    { name: 'x', rules: [] }, { name: 'x', rules: [], otherwise: undefined },
    { name: 'x', rules: [], otherwise: {} }, { name: 'x', rules: [], otherwise: NaN },
    { name: 'x', rules: [rule([], [])], otherwise: null },
    { name: 'x', rules: [{ value: 'x' }], otherwise: null },
    { name: 'x', rules: [rule([{ column: 'value' }], 1)], otherwise: null },
    { name: 'x', rules: [rule([{ column: 'typo', op: '>' , value: 1 }], 1)], otherwise: null },
    { name: 'x', rules: [rule([{ column: 'value', op: 'is_numeric', value: 1 }], 1)], otherwise: null }
  ]) assert.throws(() => classify(rows, args));
  assert.deepEqual(rows, before);
  assert.throws(() => classify(withColumns([], ['value']), { ...classification, name: 'value' }), /already exists/);
});

test('bulk classification runs after arithmetic, before sorting, retaining raw-record sidecar alignment', async () => {
  const supplied = ['ONE', 'TWO']; const resolved = supplied.map((gene, i) => ({ gene, ensembl: `ID${i}` }));
  const entry = { file: 'measurements.tsv', columns: ['Identifier', 'raw'], key: 'ensembl' };
  let reads = 0;
  const adapter = { async entry() { return entry; }, async readMany() { reads++; return { byGene: new Map([['ID0', [{ Identifier: 'ID0', raw: '0' }, { Identifier: 'ID0', raw: '-4' }]], ['ID1', []]]) }; } };
  const ops = createBulkTools({ supplied, resolved, adapter });
  const result = await ops.applyBulk({ name: 'summary', lookups: [{ table: entry.file, match_column: 'Identifier', mode: 'rows', columns: ['raw'] }], derive: [{ name: 'magnitude', expr: 'abs(raw)' }], classify: [{ name: 'recorded', rules: [rule([{ column: 'magnitude', op: 'is_numeric' }], true)], otherwise: false }, { name: 'kind', rules: [rule([{ column: 'recorded', op: '=', value: true }], 'present')], otherwise: 'unrecorded' }], sort: { by: 'magnitude', order: 'desc' } });
  assert.equal(reads, 1); assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map(row => [row.raw, row.recorded, row.kind]), [['-4', true, 'present'], ['0', true, 'present'], [null, false, 'unrecorded']]);
  assert.deepEqual(result.record_rows, [true, true, false]);
  assert.equal(result.classifications.length, 2); assert.deepEqual(result.classifications[0].domain, [true, false]);
  assert.ok(result.created_columns.includes('kind')); assert.ok(!JSON.stringify(result).includes('source_record'));
  assert.deepEqual(APPLY_BULK.function.parameters.properties.classify.items, CLASSIFY_SCHEMA);
});

test('native ASO discovers and executes classify in a registered batch without resolving literal labels as references', async t => {
  const rows = [{ gene: 'ONE', value: 0 }, { gene: 'TWO', value: null }]; const entry = { file: 'mapping.tsv', key: 'lookup', columns: ['gene', 'value'] };
  const f = await fixture(t, ({ turn, request }) => {
    if (turn === 1) {
      assert.match(transcript(request), /classify: Add a categorical column/);
      assert.ok(!request.tools.some(tool => tool.function.name === 'classify'));
      return response(call('set_plan', { items: [{ step: 'Classify the source values', kind: 'table' }] }), call('load_tools', { names: ['classify'] }));
    }
    if (turn === 2) {
      const schema = request.tools.find(tool => tool.function.name === 'classify').function.parameters;
      assert.deepEqual(schema.properties.rules, CLASSIFY_SCHEMA.properties.rules);
      return response(call('run', { steps: [{ id: 'classified', tool: 'classify', args: { artifact: 'mapping.tsv', name: 'label', rules: [rule([{ column: 'value', op: 'is_numeric' }], '@data')], otherwise: '@missing', node: 1 } }], outputs: ['classified'] }));
    }
    assert.match(transcript(request), /@data/); assert.match(transcript(request), /@missing/);
    return response(call('finish', { completed: [{ item: 1, artifacts: ['a1'] }], tables: [{ artifact: 'a1', columns: ['gene', 'value', 'label'] }] }));
  }, null, { nativeDiscovery: true, rows, entry });
  const result = await f.run(); assert.equal(result.outcome, 'completed');
  const artifact = JSON.parse(await fs.readFile(result.artifacts[0].storage_uri, 'utf8'));
  assert.deepEqual(artifact.rows.map(row => row.label), ['@data', '@missing']);
  assert.deepEqual(artifact.provenance.classifications[0].domain, ['@data', '@missing']);
  assert.deepEqual(artifact.provenance.classifications[0].matched_rows, [1]);
});

test('native classify for_each retains every row and records each substituted rule and domain', async t => {
  const rows = [{ gene: 'ONE', a: 0, b: null }, { gene: 'TWO', a: -1, b: 2 }]; const entry = { file: 'mapping.tsv', key: 'lookup', columns: ['gene', 'a', 'b'] };
  const f = await fixture(t, ({ turn }) => turn === 1
    ? response(call('set_plan', { items: [{ step: 'Classify each requested source measure', kind: 'table' }] }), call('classify', { artifact: 'mapping.tsv', name: 'label', rules: [rule([{ column: '$item', op: 'is_numeric' }], 'recorded')], otherwise: 'missing', for_each: { values: ['a', 'b'], as: 'measure' }, node: 1 }))
    : response(call('finish', { tables: [{ artifact: 'a1', columns: ['gene', 'measure', 'label'] }] })), null, { rows, entry });
  const result = await f.run(); assert.equal(result.outcome, 'completed');
  const artifact = JSON.parse(await fs.readFile(result.artifacts[0].storage_uri, 'utf8'));
  assert.equal(artifact.rows.length, 4); assert.equal(artifact.provenance.classifications.length, 2);
  assert.deepEqual(artifact.provenance.classifications.map(item => item.for_each.value), ['a', 'b']);
  assert.deepEqual(artifact.provenance.classifications.map(item => item.rules[0].where[0].column), ['a', 'b']);
  assert.equal(artifact.provenance.execution.status, 'completed');
});

test('Gemini native classify and bulk schemas preserve scalar alternatives including null', () => {
  const native = { type: 'function', function: { name: 'classify', parameters: { type: 'object', properties: { artifact: { type: 'string' }, ...CLASSIFY_SCHEMA.properties }, required: ['artifact', ...CLASSIFY_SCHEMA.required] } } };
  const built = buildRequest({ messages: [{ role: 'user', content: 'Classify these values.' }], tools: [native, APPLY_BULK], reasoning_effort: 'low' }, { modelId: 'gemini-3.8-flash', reasoningEffort: 'low', defaultOutputTokens: 1000 });
  const declarations = built.tools[0].functionDeclarations;
  const scalar = { anyOf: [{ type: 'STRING' }, { type: 'NUMBER' }, { type: 'BOOLEAN' }, { type: 'NULL' }] };
  for (const parameters of [declarations[0].parameters, declarations[1].parameters.properties.classify.items]) {
    assert.deepEqual(parameters.properties.otherwise.anyOf, scalar.anyOf);
    assert.deepEqual(parameters.properties.rules.items.properties.value.anyOf, scalar.anyOf);
    assert.ok(parameters.required.includes('otherwise'));
  }
  assert.deepEqual(built.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

test('scalar union validation and decoding preserve native types and reject structured labels', async () => {
  for (const value of [null, 0, false, true, 2.5, '0', 'null', 'false', '@literal', '{"x":1}']) {
    const args = { name: 'typed', rules: [rule([], value)], otherwise: value };
    const decoded = decodeArguments(args, CLASSIFY_SCHEMA, 'classify');
    validate(decoded, CLASSIFY_SCHEMA, 'classify');
    assert.deepEqual(decoded.rules[0].value, value); assert.deepEqual(decoded.otherwise, value);
  }
  for (const value of [[], {}, undefined, Infinity, NaN]) assert.throws(() => validate({ name: 'x', rules: [], otherwise: value }, CLASSIFY_SCHEMA, 'classify'), /declared value types/);
  const specification = { parameters: { type: 'object', properties: { artifact: { type: 'string', 'x-artifact-reference': true }, ...CLASSIFY_SCHEMA.properties }, required: ['artifact', ...CLASSIFY_SCHEMA.required] } };
  const results = [];
  await executeBatch({ steps: [{ id: 'one', tool: 'classify', args: { artifact: 'data', name: 'typed', rules: [rule([], false)], otherwise: null } }], outputs: ['one'] }, { specifications: new Map([['classify', specification]]), concurrency: 1, async execute(tool, args) { results.push(args); return { id: 'a1' }; } });
  assert.equal(results[0].rules[0].value, false); assert.equal(results[0].otherwise, null);
});
