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

const noise = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`context_${i}`, `retained_${i}`]));
const sourceRows = [
  { gene: 'ONE', ensembl: 'ID1', ...noise, 'Observed strength': 0, 'Other strength': 7, 'Batch label': 'batch A', 'Exact label': 'sample A' },
  { gene: 'TWO', ensembl: 'ID2', ...noise, 'Observed strength': 4, 'Other strength': 2, 'Batch label': 'batch A', 'Exact label': 'sample B' },
  { gene: 'THREE', ensembl: 'ID3', ...noise, 'Observed strength': null, 'Other strength': 0, 'Batch label': 'batch B', 'Exact label': 'sample C' }
];
const columns = Object.keys(sourceRows[0]);
const entry = { file: 'mapping.tsv', key: 'lookup', columns };
const plan = () => call('set_plan', { items: [{ step: 'Return the requested exact evidence', kind: 'table' }] });
const latestObservation = request => JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content).observations;
const tableFromObservation = observation => {
  const line = observation.split('\n').find(line => line.startsWith('{"columns":'));
  assert.ok(line, 'expected a complete compact row table'); return JSON.parse(line);
};

for (const target of ['a1', 'mapping.tsv']) {
  for (const pick of [undefined, ['Exact label', 'Observed strength']]) {
    test(`open ${target} returns ${pick?.length ? 'the exact requested projection' : 'every column without an implicit seven-column cut'}`, async t => {
      const f = await fixture(t, ({ request, turn }) => {
        if (turn === 1) return response(plan(), call('select', { artifact: 'mapping.tsv', node: 1 }));
        if (turn === 2) return response(call('open', { what: target, ...(pick === undefined ? {} : { columns: pick }) }));
        assert.equal(turn, 3);
        const table = tableFromObservation(latestObservation(request));
        assert.deepEqual(table.columns, pick?.length ? pick : columns);
        assert.equal(table.rows[0][table.columns.indexOf('Observed strength')], 0);
        assert.equal(table.rows[2][table.columns.indexOf('Observed strength')], null);
        assert.equal(table.rows[0][table.columns.indexOf('Exact label')], 'sample A');
        return response(call('finish', { tables: [{ artifact: 'a1', columns: ['gene', 'Observed strength'] }] }));
      }, undefined, { entry, rows: sourceRows });
      const result = await f.run(); assert.equal(result.outcome, 'completed'); assert.equal(result.failed, 0);
      const event = f.events.filter(event => event.stage === 'tool.done').map(event => JSON.parse(event.message)).find(event => event.artifact?.sample);
      assert.ok(event, 'the existing frontend artifact sample must be emitted');
      assert.equal(event.artifact.sample_columns.length, 7); assert.equal(event.artifact.sample[0].length, 7);
    });
  }
}

for (const tool of ['rank', 'top_per_group']) test(`${tool} receipt shows the real decisive keys beyond column seven`, async t => {
  const args = { artifact: 'mapping.tsv', by: 'observed strength', then_by: [{ column: 'exact label', order: 'asc', type: 'text' }], ...(tool === 'top_per_group' ? { group_by: 'batch label', n: 1 } : {}), node: 1 };
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(plan(), call(tool, args));
    assert.equal(turn, 2);
    const table = tableFromObservation(latestObservation(request));
    const expected = ['gene', 'ensembl', 'Observed strength', ...(tool === 'top_per_group' ? ['Batch label'] : []), 'Exact label', 'rank'];
    assert.deepEqual(table.columns, expected);
    assert.equal(table.rows[0][table.columns.indexOf('Observed strength')], 4);
    assert.equal(table.rows[0][table.columns.indexOf('Exact label')], 'sample B');
    assert.equal(table.rows[0][table.columns.indexOf('rank')], 1);
    assert.ok(!table.columns.some(column => column.startsWith('context_')));
    return response(call('finish', { tables: [{ artifact: 'a1', columns: expected }] }));
  }, undefined, { entry, rows: sourceRows });
  const result = await f.run(); assert.equal(result.outcome, 'completed'); assert.equal(result.turns, 2);
});

test('rank receipt includes associated extrema labels only when producer metadata establishes the relation', async t => {
  for (const declared of [true, false]) {
    const bulkRows = sourceRows.map(row => ({ ...row, 'Observed strength_labels': [{ entity: row['Exact label'] }] }));
    const bulkColumns = Object.keys(bulkRows[0]);
    const f = await fixture(t, ({ request, turn }) => {
      if (turn === 1) return response(plan(), call('investigator_hpa', { genes: ['ONE', 'TWO', 'THREE'], question: 'Retrieve exact maxima and labels', node: 1 }));
      if (turn === 2) return response(call('rank', { artifact: 'a1', by: 'Observed strength', node: 1 }));
      assert.equal(turn, 3);
      const table = tableFromObservation(latestObservation(request));
      assert.equal(table.columns.includes('Observed strength_labels'), declared);
      if (declared) assert.deepEqual(table.rows[0][table.columns.indexOf('Observed strength_labels')], [{ entity: 'sample B' }]);
      return response(call('finish', { tables: [{ artifact: 'a2', columns: ['gene', 'Observed strength', 'rank'] }] }));
    }, async () => ({ result: { bulk: true, found: true, status: 'ok', tables: [{ name: 'source_results', rows: bulkRows, columns: bulkColumns, created_columns: bulkColumns.slice(2), provenance: declared ? [{ table: 'arbitrary-source.tsv', as: 'Observed strength', aggregate: 'max', labels: ['entity'] }] : [], coverage: [] }], input_count: 3, not_in_release: [], remaining_for_aso: [] }, steps: [] }), { entry, rows: sourceRows });
    const result = await f.run(); assert.equal(result.outcome, 'completed'); assert.equal(result.failed, 0);
  }
});

test('for_each rank receipts carry actual substituted keys and the iteration label', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(plan(), call('rank', { artifact: 'mapping.tsv', by: '$item', for_each: { values: ['Observed strength', 'Other strength'], as: 'metric' }, node: 1 }));
    assert.equal(turn, 2);
    const table = tableFromObservation(latestObservation(request));
    assert.deepEqual(table.columns, ['gene', 'ensembl', 'metric', 'Observed strength', 'rank', 'Other strength']);
    assert.ok(table.rows.some(row => row[table.columns.indexOf('metric')] === 'Other strength'));
    assert.doesNotMatch(JSON.stringify(table.columns), /\$item/);
    return response(call('finish', { tables: [{ artifact: 'a1', columns: table.columns }] }));
  }, undefined, { entry, rows: sourceRows });
  const result = await f.run(); assert.equal(result.outcome, 'completed'); assert.equal(result.failed, 0);
});

test('open rejects an explicit empty projection before reading the source', async t => {
  let reads = 0;
  const f = await fixture(t, () => response(plan(), call('open', { what: 'mapping.tsv', columns: [] })), undefined, { entry, rows: sourceRows, onRead: () => reads++ });
  const result = await f.run({ max_turns: 1 });
  assert.equal(reads, 0); assert.equal(result.artifacts.length, 0); assert.equal(result.outcome, 'incomplete');
  assert.match(f.events.filter(event => event.stage === 'call.failed').map(event => event.message).join('\n'), /open.columns must be a nonempty selection/);
});

test('streamed top_per_group receipt retains exact group and secondary keys', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(plan(), call('top_per_group', { artifact: 'mapping.tsv', group_by: 'batch label', by: 'observed strength', then_by: [{ column: 'exact label', type: 'text' }], n: 1, node: 1 }));
    assert.equal(turn, 2);
    const table = tableFromObservation(latestObservation(request));
    assert.deepEqual(table.columns, ['gene', 'ensembl', 'Observed strength', 'Batch label', 'Exact label', 'rank']);
    assert.equal(table.rows[0][table.columns.indexOf('Batch label')], 'batch A');
    assert.equal(table.rows[0][table.columns.indexOf('Exact label')], 'sample B');
    assert.ok(table.rows.some(row => row[table.columns.indexOf('Batch label')] === 'batch B' && row[table.columns.indexOf('Observed strength')] === null));
    return response(call('finish', { tables: [{ artifact: 'a1', columns: table.columns }] }));
  }, undefined, { entry: { ...entry, key: 'stream' }, rows: sourceRows });
  const result = await f.run(); assert.equal(result.outcome, 'completed'); assert.equal(result.failed, 0);
});

test('default open keeps a large late column exact in its archive while transport stays bounded', async t => {
  const complete = 'exact🙂'.repeat(2500) + ' END_OF_EXACT_CELL';
  const rows = [{ ...sourceRows[0], 'Complete payload': complete }];
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(plan(), call('select', { artifact: 'mapping.tsv', node: 1 }));
    if (turn === 2) return response(call('open', { what: 'a1' }));
    assert.equal(turn, 3);
    const observation = latestObservation(request);
    assert.match(observation, /next_offset=\d+; recall id to continue/);
    assert.ok(Buffer.byteLength(observation) < 9000, 'the existing result transport budget still bounds the delivered fragment');
    return response(call('finish', { tables: [{ artifact: 'a1', columns: ['gene', 'Observed strength'] }] }));
  }, undefined, { entry: { ...entry, columns: Object.keys(rows[0]) }, rows });
  const result = await f.run(); assert.equal(result.outcome, 'completed');
  const records = await Promise.all((await fs.readdir(path.join(f.directory, 'observations'))).map(async file => JSON.parse(await fs.readFile(path.join(f.directory, 'observations', file), 'utf8'))));
  const record = records.find(record => record.source === 'open a1'); assert.ok(record);
  const table = tableFromObservation(record.text);
  assert.equal(table.rows[0][table.columns.indexOf('Complete payload')], complete);
});
