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

const source = { file: 'observations.tsv', key: 'ensembl', title: 'Recorded observations', columns: ['Gene', 'Value', 'Category'] };
const genes = ['ZERO', 'EMPTY', 'NO_RECORD'];
const observed = new Map([
  ['ID0', [{ Gene: 'ID0', Value: '0', Category: 'recorded' }]],
  ['ID1', [{ Gene: 'ID1', Value: '', Category: '' }]],
  ['ID2', []]
]);
const retrieve = () => call('apply_bulk', { name: 'observations', lookups: [{ table: source.file, mode: 'rows', match_column: 'Gene', columns: ['Value', 'Category'] }] });

async function bulkFixture(decide) {
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
    async catalog() { return [source]; }, async entry(file) { return file === source.file ? source : null; },
    async resolveGenes(names) { return names.map(gene => ({ gene, ensembl: `ID${genes.indexOf(gene)}` })); },
    async read(gene) { return { entry: source, rows: observed.get(gene.ensembl) }; },
    async readMany() { reads.push(source.file); return { entry: source, byGene: observed }; }
  };
  return { requests, reads, run: (args = {}, ctx = {}) => loaded.exports({ genes, question: 'Report recorded observations and source coverage', ...args }, ctx, adapter) };
}

function assertObservations(table) {
  assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows.map(row => row.gene), genes);
  assert.equal(Number(table.rows[0].Value), 0);
  assert.ok(table.rows[1].Value === '' || table.rows[1].Value === null);
  assert.equal(table.rows[2].Value, null);
  assert.deepEqual(table.rows.map(row => row.source_rows), [1, 1, 0]);
  assert.deepEqual(table.record_rows, [true, true, false]);
  assert.equal(table.coverage[0].genes_without_matching_rows, 1);
  assert.equal(table.coverage[0].matched_source_rows, 2);
}

for (const unavailable of [undefined, []]) test(`requested zero, blank and no-record observations complete bulk and ASO (${unavailable === undefined ? 'omitted' : 'empty'} unavailable requirements)`, async t => {
  const question = 'Return the source observations for all three supplied inputs, including recorded zero, empty fields and genes with no record. Explain only what the source coverage establishes.';
  const interpretation = 'NO_RECORD has no record in observations.tsv in release fixture. This establishes only source coverage; neither a biological absence nor an experimental history is established.';
  const bulk = await bulkFixture(({ request, turn }) => {
    const finish = request.tools.find(tool => tool.function.name === 'finish').function.parameters;
    assert.deepEqual(finish.required, ['results']);
    assert.ok(Object.hasOwn(finish.properties, 'unavailable_requirements'));
    assert.ok(!Object.hasOwn(finish.properties, 'not_in_release'));
    assert.match(finish.properties.unavailable_requirements.description, /no-record coverage.*answered evidence/);
    assert.match(request.messages[0].content, /Missing records and missing values are valid answers about source coverage/);
    if (turn === 1) return [retrieve()];
    assert.equal(turn, 2);
    return [call('finish', { results: ['observations'], answer: interpretation, ...(unavailable === undefined ? {} : { unavailable_requirements: unavailable }) })];
  });
  let specialist;
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: question, kind: 'table' }] }), call('investigator_hpa', { genes, question, node: 1 }));
    assert.equal(turn, 2);
    assert.doesNotMatch(transcript(request), /unfinished requirements:/);
    return response(call('finish', { completed: [{ item: 1, artifacts: ['a1'] }], tables: [{ artifact: 'a1', columns: ['gene', 'Value', 'Category', 'source_rows'] }] }));
  }, async (name, args, ctx) => { specialist = await bulk.run(args, ctx); return { result: specialist }; }, { nativeDiscovery: true });
  const result = await f.run({ goal: question });
  assert.equal(specialist.status, 'ok'); assert.equal(specialist.answer, interpretation);
  assert.deepEqual(specialist.not_in_release, []); assert.deepEqual(specialist.remaining_for_aso, []);
  assert.ok(!Object.hasOwn(specialist, 'unavailable_requirements'), 'public result shape stays unchanged');
  assertObservations(specialist.tables[0]);
  assert.equal(result.outcome, 'completed'); assert.equal(result.plan[0].status, 'done');
  assert.equal(bulk.requests.length, 2); assert.equal(f.requests.length, 2); assert.equal(bulk.reads.length, 1);
  const saved = JSON.parse(await fs.readFile(result.artifacts.find(artifact => artifact.summary.id === 'a1').storage_uri, 'utf8'));
  assert.deepEqual(saved.rows, specialist.tables[0].rows);
  assert.deepEqual(saved.provenance.not_in_release, []);
});

for (const kind of ['source-dependent conclusion', 'unsupported assigned operation']) test(`returned observations do not complete a genuinely unavailable ${kind}`, async t => {
  const requirement = kind === 'source-dependent conclusion' ? 'Explain the experimental reason why NO_RECORD has no observation' : 'Render the requested external visualization';
  const why = kind === 'source-dependent conclusion' ? 'This release records measurements and coverage, but contains no experimental-history evidence for this absence' : 'No registered Investigator operation renders this assigned visualization';
  const field = kind === 'source-dependent conclusion' ? 'unavailable_requirements' : 'unfinished_requirements';
  const obligation = { requirement, why };
  const bulk = await bulkFixture(({ request, turn }) => {
    assert.match(request.messages[0].content, /ASO owns study planning, calculations across saved tables/);
    assert.match(request.messages[0].content, /return its underlying measurements and name the unfinished calculation once/);
    return turn === 1 ? [retrieve()] : [call('finish', { results: ['observations'], [field]: [obligation] })];
  });
  let specialist;
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: requirement, kind: 'table' }] }), call('investigator_hpa', { genes, question: requirement, node: 1 }));
    if (turn === 2) return response(call('finish', { completed: [{ item: 1, artifacts: ['a1'] }], tables: [{ artifact: 'a1', columns: ['gene', 'Value', 'Category', 'source_rows'] }] }));
    if (turn === 3) {
      assert.match(transcript(request), /finish.completed item 1: Investigator returned supporting data with unfinished requirements/);
      return response(call('update_plan', { item: 1, status: 'done', artifacts: ['a1'] }));
    }
    assert.equal(turn, 4); assert.match(transcript(request), /update_plan refused for item 1/);
    return response(call('finish', { tables: [{ artifact: 'a1', columns: ['gene', 'Value', 'Category', 'source_rows'] }] }));
  }, async (name, args, ctx) => { specialist = await bulk.run(args, ctx); return { result: specialist }; });
  const result = await f.run({ goal: requirement, max_turns: 4 });
  assert.equal(specialist.status, 'partial'); assertObservations(specialist.tables[0]);
  assert.deepEqual(kind === 'source-dependent conclusion' ? specialist.not_in_release : specialist.remaining_for_aso, [obligation]);
  assert.equal(result.outcome, 'incomplete'); assert.notEqual(result.plan[0].status, 'done');
  assert.equal(bulk.requests.length, 2); assert.equal(bulk.reads.length, 1); assert.equal(f.requests.length, 4);
});

test('unavailable required source can finish with no tables and retains the public not_in_release shape', async () => {
  const obligation = { requirement: 'Return the requested independent reference measurement', why: 'No imported source contains this measurement' };
  const bulk = await bulkFixture(() => [call('finish', { results: [], unavailable_requirements: [obligation] })]);
  const result = await bulk.run();
  assert.equal(result.status, 'partial'); assert.equal(result.found, false);
  assert.deepEqual(result.tables, []); assert.deepEqual(result.not_in_release, [obligation]);
  assert.deepEqual(result.remaining_for_aso, []); assert.equal(bulk.reads.length, 0);
});

test('omitting optional requirement lists cannot silently complete an empty answer', async () => {
  const bulk = await bulkFixture(() => [call('finish', { results: [] })]);
  const result = await bulk.run();
  assert.equal(result.status, 'incomplete'); assert.equal(result.stop_reason, 'no_progress_cycle');
  assert.match(result.error, /repeated a rejected operation/);
  assert.match(bulk.requests[1].messages.at(-1).content, /Return result tables or explain which requirements remain unanswered/);
});

test('obsolete native not_in_release is rejected rather than silently aliased; public result compatibility is explicit', async () => {
  const obligation = { requirement: 'Requested interpretation', why: 'Necessary evidence is unavailable' };
  const bulk = await bulkFixture(({ request, turn }) => {
    if (turn === 1) return [retrieve()];
    if (turn === 2) return [call('finish', { results: ['observations'], not_in_release: [obligation] })];
    assert.equal(turn, 3); assert.match(request.messages.at(-1).content, /finish.not_in_release is not a declared argument/);
    return [call('finish', { results: ['observations'], unavailable_requirements: [obligation] })];
  });
  const result = await bulk.run();
  assert.equal(result.status, 'partial'); assert.deepEqual(result.not_in_release, [obligation]);
  assert.equal(bulk.reads.length, 1); assertObservations(result.tables[0]);
});
