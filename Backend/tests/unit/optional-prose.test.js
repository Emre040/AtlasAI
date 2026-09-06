'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const BACKEND = process.env.ATLASAI_BACKEND_ROOT || path.resolve(__dirname, '../..');
const sourcePath = filename => process.env.ATLASAI_PROPOSAL_ROOT ? path.join(process.env.ATLASAI_PROPOSAL_ROOT, path.relative(BACKEND, filename)) : filename;
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
    '../../hpa/localData': { FILES: { master: 'mapping.tsv' }, localData: { async master() { return { rows: options.rows }; }, async table() { return { columns: entry.columns, rows: options.rows || [] }; }, async *rows(name) {
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
  loaded._compile(await fs.readFile(sourcePath(filename), 'utf8'), filename);
  const run = args => loaded.exports({ goal: 'Inspect the available evidence', ...args }, { db: {}, visitorId: 1, async onStep(event) { events.push(event); if (event.stage === 'tool.failed') t.diagnostic(event.message); if (['tool.done', 'tool.failed'].includes(event.stage)) agentDone.resolve(event); } });
  return { run, events, requests, updates, directory };
}


const entry = { file: 'observations.tsv', title: 'Source observations', key: 'ensembl', columns: ['Gene', 'Sample', 'Value'] };
const lookup = { table: entry.file, match_column: 'Gene', mode: 'rows', columns: ['Sample', 'Value'] };
const apply = name => ['apply_bulk', { name, lookups: [lookup] }];
const finish = ['finish', { results: ['observed'], answer: 'Source observations returned.', unavailable_requirements: [] }];

async function study({ decide, ctx = {}, onRead }) {
  const filename = require.resolve(path.join(BACKEND, 'src/system/agents/investigatorBulk'));
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireOriginal = loaded.require.bind(loaded), requests = [];
  let sourceReads = 0;
  const stubs = {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test-release' }; } },
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      const action = await decide({ request, turn: requests.length });
      const message = action ? { role: 'assistant', tool_calls: [{ type: 'function', id: `c${requests.length}`, thought_signature: 'native-signature', function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } : { role: 'assistant', content: 'Unfinished reasoning' };
      return { choices: [{ message }], usage: { prompt_tokens: 4, completion_tokens: 1 } };
    } } } } }
  };
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : requireOriginal(name);
  loaded._compile(await fs.readFile(sourcePath(filename), 'utf8'), filename);
  const gene = { gene: 'ONE', ensembl: 'ID1' };
  const rows = Array.from({ length: 12 }, (_, i) => ({ Gene: gene.ensembl, Sample: `sample-${i}`, Value: String(i) }));
  const adapter = {
    async catalog() { return [entry]; }, async entry(file) { return file === entry.file ? entry : null; },
    async resolveGenes() { return [gene]; }, async read() { return { entry, rows }; },
    async readMany() { sourceReads++; onRead?.(); return { entry, byGene: new Map([[gene.ensembl, rows]]) }; },
    definition() { return ''; }
  };
  const result = await loaded.exports({ genes: ['ONE'], question: 'Retrieve all source observations and assess the requested views.' }, ctx, adapter);
  return { result, requests, sourceReads };
}

const sampleRows = [{ name: 'RECORDED_ZERO', value: 0 }, { name: 'UNRECORDED', value: null }, { name: 'EXACT', value: 2.75 }];
const makeTable = () => response(call('set_plan', { items: [{ step: 'Return every exact source value', kind: 'table' }, { step: 'Deliver the requested output', kind: 'summary' }] }), call('select', { artifact: 'mapping.tsv', columns: ['name', 'value'], node: 1 }));
const tableRef = { artifact: 'a1', columns: ['name', 'value'] };

test('ASO finishes exact data tables without narrative or another inference', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    const finish = request.tools.find(tool => tool.function.name === 'finish').function;
    assert.ok(!finish.parameters.required.includes('summary'));
    if (turn === 1) return makeTable();
    assert.equal(turn, 2);
    return response(call('finish', { tables: [tableRef] }));
  }, undefined, { rows: sampleRows });
  const result = await f.run({ goal: 'Return the exact source values as a table.' });
  assert.equal(result.outcome, 'completed'); assert.equal(result.failed, 0); assert.equal(result.turns, 2);
  assert.match(result.summary, /RECORDED_ZERO \| 0/); assert.match(result.summary, /UNRECORDED \| —/); assert.match(result.summary, /EXACT \| 2\.75/);
  assert.deepEqual(result.unverified_numbers, []); assert.deepEqual(result.tokens, { prompt: 20, completion: 4, total: 24 });
  assert.equal(result.plan[1].status, 'done');
});

test('ASO may deliver a rendered requested figure without inventing a paragraph', async t => {
  const f = await fixture(t, ({ turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Render the requested scatter', kind: 'scatter' }] }), call('select', { artifact: 'mapping.tsv' }));
    if (turn === 2) return response(call('chart', { artifact: 'a1', type: 'scatter', x: 'x', y: 'y', label: 'name', node: 1 }));
    assert.equal(turn, 3); return response(call('finish', {}));
  }, undefined, { entry: { file: 'mapping.tsv', key: 'lookup', columns: ['name', 'x', 'y'] }, rows: [{ name: 'A', x: 0, y: 2 }, { name: 'B', x: 3, y: 4 }] });
  const result = await f.run({ goal: 'Make a scatter plot of x versus y.' });
  assert.equal(result.outcome, 'completed'); assert.equal(result.failed, 0); assert.equal(result.summary, '');
  assert.ok(result.artifacts.some(a => a.kind === 'figure'));
});

test('optional prose cannot turn an empty report into a completed study', async t => {
  const f = await fixture(t, ({ turn }) => turn === 1 ? response(call('set_plan', { items: [{ step: 'Deliver results', kind: 'summary' }] })) : response(call('finish', {})));
  const result = await f.run({ max_turns: 3 });
  assert.equal(result.outcome, 'incomplete'); assert.equal(result.artifacts.length, 0);
  assert.ok(f.events.some(event => event.stage === 'call.failed' && event.message.includes('empty report')));
});

test('ASO preserves source-cited requested narrative alongside exact tables', async t => {
  const narrative = 'EXACT has the recorded value 2.75 (a1).';
  const f = await fixture(t, ({ turn }) => turn === 1 ? makeTable() : response(call('finish', { summary: narrative, tables: [tableRef] })), undefined, { rows: sampleRows });
  const result = await f.run({ goal: 'Return all values and describe the EXACT entry.' });
  assert.equal(result.outcome, 'completed'); assert.ok(result.summary.startsWith(narrative)); assert.match(result.summary, /RECORDED_ZERO \| 0/);
});

test('source verification still rejects an unsupported narrative when prose is supplied', async t => {
  const f = await fixture(t, ({ turn }) => turn === 1 ? makeTable() : response(call('finish', { summary: 'EXACT has the recorded value 98765.432 (a1).', tables: [tableRef] })), undefined, { rows: sampleRows });
  const result = await f.run();
  assert.equal(result.outcome, 'incomplete'); assert.equal(result.incomplete_reason, 'unresolved_finish_evidence');
  assert.doesNotMatch(result.summary, /recorded value 98765/);
});

test('a source-scoped empty result is still an exact report table without prose', async t => {
  const f = await fixture(t, ({ turn }) => turn === 1 ? makeTable() : response(call('finish', { tables: [tableRef] })), undefined, { rows: [] });
  const result = await f.run();
  assert.equal(result.outcome, 'completed'); assert.match(result.summary, /No matching rows \(a1\)/);
});

test('bulk Investigator finishes complete result tables without retyping measurements', async () => {
  const { result, requests, sourceReads } = await study({ decide: ({ request, turn }) => {
    const finish = request.tools.find(tool => tool.function.name === 'finish').function;
    assert.ok(!finish.parameters.required.includes('answer'));
    if (turn === 1) return apply('observed');
    assert.equal(turn, 2); return ['finish', { results: ['observed'], unavailable_requirements: [] }];
  } });
  assert.equal(result.status, 'ok'); assert.equal(result.answer, ''); assert.equal(result.tables[0].rows.length, 12);
  assert.equal(result.tables[0].rows[0].Value, '0'); assert.equal(requests.length, 2); assert.equal(sourceReads, 1);
  assert.deepEqual(result.tokens.total, { prompt: 8, completion: 2, total: 10 });
});

test('bulk Investigator preserves the existing answer field when source interpretation is supplied', async () => {
  const narrative = 'The returned table contains source observations; specimen identities are retained.';
  const { result } = await study({ decide: ({ turn }) => turn === 1 ? apply('observed') : ['finish', { results: ['observed'], answer: narrative, unavailable_requirements: [] }] });
  assert.equal(result.status, 'ok'); assert.equal(result.answer, narrative); assert.equal(result.tables[0].rows.length, 12);
});

test('bulk structured unanswered requirements remain partial without mandatory prose', async () => {
  const requirement = { requirement: 'Requested source comparison', why: 'The second source is unavailable in this release.' };
  const { result } = await study({ decide: ({ turn }) => turn === 1 ? apply('observed') : ['finish', { results: ['observed'], unavailable_requirements: [requirement] }] });
  assert.equal(result.status, 'partial'); assert.equal(result.answer, ''); assert.deepEqual(result.not_in_release, [requirement]);
});

test('bulk optional prose does not permit empty completion without evidence or unresolved requirements', async () => {
  const { result, requests } = await study({ decide: () => ['finish', { results: [], unavailable_requirements: [] }] });
  assert.equal(result.status, 'incomplete'); assert.equal(result.found, false); assert.equal(requests.length, 2);
  assert.match(result.error, /repeated a rejected operation/);
});
