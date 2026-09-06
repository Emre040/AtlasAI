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
    '../aso/artifactStore': { async registerArtifact(db, args) { if (options.failWrite?.(args)) throw new Error("Synthetic archive write failure"); const id = ++artifact; const storageUri = args.storageUriOverride || path.join(directory, 'artifacts', `${id}.json`); if (!args.skipWrite) await fs.writeFile(storageUri, JSON.stringify(args.payload)); return { artifactUuid: `artifact-${id}`, storageUri }; } },
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
  loaded._compile(await fs.readFile(process.env.ASO_SOURCE_HANDOFF_FILE || filename, 'utf8'), filename);
  const run = args => loaded.exports({ goal: 'Inspect the available evidence', ...args }, { db: {}, visitorId: 1, async onStep(event) { events.push(event); if (event.stage === 'tool.failed') t.diagnostic(event.message); if (['tool.done', 'tool.failed'].includes(event.stage)) agentDone.resolve(event); } });
  return { run, events, requests, updates, directory };
}

const { createBulkTools } = require('../../src/system/agents/investigatorBulkTools');
const { prepareBulkArchive } = require('../../src/system/aso/bulkArchive');
const sourceRows = [
  { Gene: 'ID1', Value: '0', Reliability: 'UNOPENED_CATEGORY', 'Unused field': 'RAW_ONLY_VALUE' },
  { Gene: 'ID1', Value: '0', Reliability: 'UNOPENED_CATEGORY', 'Unused field': 'RAW_ONLY_VALUE' },
  { Gene: 'ID1', Value: '-2', Reliability: '', 'Unused field': null }
];
async function nativeBulk() {
  const file = require.resolve('../../src/system/agents/investigatorBulk'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const real = loaded.require.bind(loaded); let calls = 0, reads = 0;
  const actions = [
    ['apply_bulk', { name: 'projected', lookups: [{ table: 'exact.tsv', match_column: 'Gene', mode: 'rows', columns: ['Value', 'Reliability'] }] }],
    ['apply_bulk', { name: 'summary', lookups: [
      { table: 'exact.tsv', match_column: 'Gene', value_column: 'Value', aggregate: 'sum', as: 'sum' },
      { table: 'exact.tsv', match_column: 'Gene', aggregate: 'count', as: 'count' }
    ] }],
    ['finish', { results: ['summary'] }]
  ];
  loaded.require = name => name === '../../hpa/agentMode' ? { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'fixture' }; } } : name === '../../inference/gateway' ? { inference: { chat: { completions: { async create() { const [name, args] = actions[calls++]; return response(call(name, args)); } } } } } : real(name);
  loaded._compile(await fs.readFile(file, 'utf8'), file);
  const entry = { file: 'exact.tsv', key: 'ensembl', columns: ['Gene', 'Value', 'Reliability', 'Unused field'] };
  const adapter = { async entry() { return entry; }, async catalog() { return [entry]; }, async resolveGenes() { return [{ gene: 'ONE', ensembl: 'ID1' }, { gene: 'MISSING', ensembl: 'ID2' }]; }, async readMany() { reads++; return { entry, byGene: new Map([['ID1', structuredClone(sourceRows)], ['ID2', []]]) }; } };
  const result = await loaded.exports({ genes: ['ONE', 'MISSING'], question: 'Return the sum and count. Retain other work.' }, {}, adapter);
  assert.equal(result.status, 'ok', result.error); return { result, calls, reads };
}

test('Investigator retains raw and unselected lookups while ASO performs the grouped analysis without another specialist', async t => {
  let invocations = 0, native;
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Get measurements', kind: 'table' }, { step: 'Count source records by reliability', kind: 'table' }] }), call('investigator_hpa', { genes: ['ONE', 'MISSING'], question: 'Get measurements', node: 1 }));
    if (turn === 2) {
      const text = transcript(request);
      assert.match(text, /"id":"a2","label":"projected"/);
      assert.match(text, /"id":"a3","label":"Raw source rows for supplied cohort: exact.tsv"/);
      assert.doesNotMatch(text, /RAW_ONLY_VALUE|UNOPENED_CATEGORY/);
      return response(call('aggregate', { artifact: 'a2', column: 'Value', metrics: ['count'], group_by: 'Reliability', row_scope: 'records', node: 2 }));
    }
    if (turn === 3) return response(call('open', { what: 'a3', provenance: true }), call('open', { what: 'a5', provenance: true }));
    assert.equal(turn, 4); assert.match(transcript(request), /RAW_ONLY_VALUE|UNOPENED_CATEGORY/);
    return response(call('finish', { tables: [{ artifact: 'a1', columns: ['gene', 'sum', 'count'] }, { artifact: 'a5', columns: ['Reliability', 'count'] }] }));
  }, async () => { invocations++; native = await nativeBulk(); return { result: native.result }; });
  const result = await f.run({ max_turns: 4 });
  assert.equal(result.outcome, 'completed'); assert.equal(invocations, 1); assert.equal(native.reads, 1);
  assert.deepEqual(native.result.tables.map(t => t.name), ['summary']);
  assert.deepEqual(native.result.retained_tables.map(t => t.name), ['projected']);
  const saved = await Promise.all(result.artifacts.map(async a => JSON.parse(await fs.readFile(a.storage_uri, 'utf8'))));
  const raw = saved.find(a => a.provenance.saved_result?.kind === 'raw_source');
  assert.deepEqual(raw.rows, sourceRows); assert.deepEqual(raw.columns, ['Gene', 'Value', 'Reliability', 'Unused field']);
  assert.deepEqual(raw.provenance.record_rows, [true, true, true]);
  assert.equal(raw.provenance.source_scope.cohort[1].source_rows, 0);
  const index = saved.find(a => a.provenance.evidence_kind === 'saved_result_archive');
  assert.equal(index.rows.length, 3); assert.equal(index.provenance.execution.status, 'completed');
  const projection = saved.find(a => a.label === 'projected'), distribution = saved.find(a => a.node_id === 'a5');
  assert.equal(projection.rows.length, 4); assert.deepEqual(projection.provenance.record_rows, [true, true, true, false]);
  assert.deepEqual(distribution.rows.map(row => [row.Reliability, row.count]), [['UNOPENED_CATEGORY', 2], ['', 1]]);
  assert.deepEqual(distribution.provenance.sources, [index.rows.find(row => row.name === 'projected').artifact_uuid]);
  assert.deepEqual(result.plan[0].artifacts, ['a1']);
});

test('failed archive persistence keeps completed files but cannot complete a plan with an unpublished archive', async t => {
  const f = await fixture(t, ({ turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Get measurements', kind: 'table' }] }), call('investigator_hpa', { genes: ['ONE'], question: 'Get measurements', node: 1 }));
    return response(call('finish', { completed: [{ item: 1, artifacts: ['a1'] }], tables: [{ artifact: 'a1', columns: ['gene', 'sum', 'count'] }] }));
  }, async () => ({ result: (await nativeBulk()).result }), { failWrite: args => args.payload?.provenance?.evidence_kind === 'saved_result_archive' });
  const result = await f.run({ max_turns: 2 });
  assert.equal(result.outcome, 'incomplete'); assert.equal(result.failed, 2); // Archive failure plus the rejected finish binding.
  assert.notEqual(result.plan[0].status, 'done'); assert.equal(result.artifacts.length, 3);
  assert.ok(f.events.some(event => event.stage === 'tool.failed' && event.message.includes('Synthetic archive write failure')));
  assert.match(transcript(f.requests.at(-1)), /Synthetic archive write failure/);
});

test('archive preflight rejects missing or cyclic local ancestry before persistence', () => {
  const raw = { name: 'raw', columns: ['value'], rows: [{ value: 0 }] };
  assert.throws(() => prepareBulkArchive({ tables: [{ ...raw, operations: [{ inputs: { artifact: 'missing' } }] }] }), /missing predecessor/);
  assert.throws(() => prepareBulkArchive({ tables: [{ ...raw, reductions: [{ from: 'raw', source_result: 'raw' }] }] }), /cycle/);
  const partial = { ...raw, execution: { status: 'partial', failures: [{ item: 'arbitrary', error: 'exact failure' }] } };
  assert.deepEqual(prepareBulkArchive({ tables: [partial] }).nodes[0].table.execution, partial.execution);
});
