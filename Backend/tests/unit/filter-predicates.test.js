'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { CapabilityCatalog } = require('../../src/system/aso/capabilityCatalog');

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
  const filename = require.resolve('../../src/system/agents/asoStudy');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const run = args => loaded.exports({ goal: 'Inspect the available evidence', ...args }, { db: {}, visitorId: 1, async onStep(event) { events.push(event); if (event.stage === 'tool.failed') t.diagnostic(event.message); if (['tool.done', 'tool.failed'].includes(event.stage)) agentDone.resolve(event); } });
  return { run, events, requests, updates, directory };
}

const ops = require('../../src/system/aso/studyTools');
const adapter = require('../../src/hpa/geneDataAdapter');
const { createBulkTools, APPLY_BULK } = require('../../src/system/agents/investigatorBulkTools');
const missingValues = [null, undefined, '', '  ', 'NA', ' na '];
const numericValues = [0, -3, '0', '-2', '1.5e2', '1,234'];
const nonnumericValues = ['null', 'Not detected', '1-2', false, { value: 2 }, [2], NaN, Infinity];
const rows = [...missingValues, ...numericValues, ...nonnumericValues].map((value, id) => ({ id, value }));

test('unary predicates separate missing, present numeric and present nonnumeric cells without dropping zero or negatives', () => {
  const ids = (start, count) => Array.from({ length: count }, (_, i) => start + i);
  const filter = op => ops.applyWhere(rows, [{ column: 'value', op }]).map(row => row.id);
  assert.deepEqual(filter('is_missing'), ids(0, missingValues.length));
  assert.deepEqual(filter('is_numeric'), ids(missingValues.length, numericValues.length));
  assert.deepEqual(filter('is_non_numeric'), ids(missingValues.length + numericValues.length, nonnumericValues.length));
  assert.deepEqual(filter('is_present'), ids(missingValues.length, numericValues.length + nonnumericValues.length));
  assert.equal(ops.num([2]), null, 'structured values are not silently coerced into numeric measurements');
  assert.equal(ops.applyWhere(rows, [{ column: 'value', op: '=', value: 'null' }]).length, 1, 'literal text null remains distinct from a missing cell');
});

test('unary predicates reject ambiguous operands and preserve declared schemas for absent rows', () => {
  for (const op of ['is_missing', 'is_present', 'is_numeric', 'is_non_numeric']) {
    for (const operand of [{ value: null }, { value: 0 }, { column_b: 'id' }]) assert.throws(() => ops.applyWhere(rows, [{ column: 'value', op, ...operand }]), /only column and op/);
    const empty = ops.applyWhere(ops.withColumns([], ['id', 'value']), [{ column: 'value', op }]);
    assert.deepEqual(empty, []);
    assert.deepEqual(ops.columnsOf(empty), ['id', 'value']);
    assert.throws(() => ops.applyWhere(rows, [{ column: 'missing_column', op }]), /no column/);
  }
  assert.deepEqual(ops.applyWhere([{ value: 0 }, { value: -2 }, { value: null }], [{ column: 'value', op: 'is_numeric' }, { column: 'value', op: '<=', value: 0 }]).map(row => row.value), [0, -2]);
});

test('bulk unary filters count actual matching source rows and do not invent missing rows for absent inputs', async () => {
  const resolved = [{ gene: 'A', ensembl: 'ID_A' }, { gene: 'B', ensembl: 'ID_B' }];
  const entry = { file: 'source.tsv', columns: ['target', 'value'] };
  const source = [null, 0, -2, 'NA', '1-2', 'Not detected'].map(value => ({ target: 'A', value }));
  let reads = 0;
  const tools = createBulkTools({ supplied: ['A', 'B'], resolved, adapter: { async entry() { return entry; }, async readMany() { reads++; return { entry, byGene: new Map([['ID_A', source]]) }; } } });
  const lookups = ['all', 'is_missing', 'is_present', 'is_numeric', 'is_non_numeric'].map(op => ({ table: entry.file, match_column: 'target', aggregate: 'count', as: op, ...(op === 'all' ? {} : { where: [{ column: 'value', op }] }) }));
  const result = await tools.applyBulk({ name: 'counts', lookups });
  assert.deepEqual(result.rows.map(row => [row.gene, row.all, row.is_missing, row.is_present, row.is_numeric, row.is_non_numeric]), [['A', 6, 2, 4, 2, 2], ['B', 0, 0, 0, 0, 0]]);
  assert.equal(reads, 1);
  const schema = APPLY_BULK.function.parameters.properties.lookups.items.properties.where.items;
  assert.deepEqual(schema.required, ['column', 'op']);
  for (const op of ['is_missing', 'is_present', 'is_numeric', 'is_non_numeric']) assert.ok(schema.properties.op.enum.includes(op));
});

test('single-source adapter uses the shared operators and renders no fake comparison value', () => {
  const entry = { file: 'source.tsv', key: 'ensembl', columns: ['value'] };
  const raw = { entry, rows: [null, 0, -2, '1-2'].map(value => ({ value })) };
  const filtered = adapter.applyWhere(raw, [{ column: 'value', op: 'is_numeric' }]);
  assert.deepEqual(filtered.reading.rows.map(row => row.value), [0, -2]);
  assert.equal(filtered.reading.unfiltered, 4);
  assert.deepEqual(filtered.clauses, [{ column: 'value', op: 'is_numeric' }]);
  const rendered = adapter.render(filtered.reading);
  assert.match(rendered.text, /2 of 4 rows match value is_numeric/);
  assert.doesNotMatch(rendered.text, /undefined/);
  assert.equal(adapter.applyWhere({ entry, rows: [] }, [{ column: 'value', op: 'is_missing' }]).reading.rows.length, 0);
});

test('ASO exposes unary predicates and shows late predicate columns in successful and empty filter receipts', async t => {
  const columns = ['name', ...Array.from({ length: 18 }, (_, i) => `carried_${i}`), 'late_measurement'];
  const sourceRows = [null, 0, -2, '1-2'].map((value, i) => ({ name: `row_${i}`, ...Object.fromEntries(columns.filter(c => c.startsWith('carried_')).map(c => [c, 'context'])), late_measurement: value }));
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) {
      const filter = request.tools.find(tool => tool.function.name === 'filter');
      assert.ok(filter.function.parameters.properties.where.items.properties.op.enum.includes('is_numeric'));
      return response(call('set_plan', { items: [{ step: 'Retain numeric source measurements', kind: 'table' }] }), call('filter', { artifact: 'mapping.tsv', where: [{ column: 'late_measurement', op: 'is_numeric' }], node: 1 }));
    }
    if (turn === 2) {
      assert.match(transcript(request), /showing 3\/22 columns: gene, ensembl, late_measurement/);
      return response(call('filter', { artifact: 'a1', where: [{ column: 'late_measurement', op: '>', value: 10 }] }));
    }
    assert.match(transcript(request), /0 rows; predicate columns: gene, ensembl, late_measurement/);
    return response(call('finish', { summary: 'Numeric source measurements are retained in the saved result (a1).' }));
  }, undefined, { entry: { file: 'mapping.tsv', key: 'stream', columns }, rows: sourceRows });
  const result = await f.run();
  assert.equal(result.outcome, 'completed', result.error);
  const saved = JSON.parse(await fs.readFile(result.artifacts[0].storage_uri, 'utf8'));
  assert.deepEqual(saved.rows.map(row => row.late_measurement), [0, -2]);
});

test('filter receipts expose both late columns in a same-row comparison', async t => {
  const columns = ['name', ...Array.from({ length: 12 }, (_, i) => `carried_${i}`), 'late_left', 'late_right'];
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Compare source measurements', kind: 'table' }] }), call('filter', { artifact: 'mapping.tsv', where: [{ column: 'late_left', op: '>', column_b: 'late_right' }], node: 1 }));
    assert.match(transcript(request), /columns: gene, ensembl, late_left, late_right/);
    return response(call('finish', { summary: 'The matching source row is retained (a1).' }));
  }, undefined, { entry: { file: 'mapping.tsv', key: 'stream', columns }, rows: [{ name: 'A', late_left: 0, late_right: -2 }] });
  const result = await f.run();
  assert.equal(result.outcome, 'completed', result.error);
});

test('iterated filter receipts expose resolved predicate columns rather than unresolved item placeholders', async t => {
  const columns = ['name', 'left_value', 'right_value'];
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Filter each requested numeric column', kind: 'table' }] }), call('filter', { artifact: 'mapping.tsv', where: [{ column: '$item', op: 'is_numeric' }], for_each: { values: ['left_value', 'right_value'], as: 'filtered_column' }, node: 1 }));
    assert.match(transcript(request), /columns: gene, ensembl, left_value, right_value/);
    assert.doesNotMatch(transcript(request), /No column.*\$item/);
    return response(call('finish', { summary: 'The source rows matching each requested numeric filter are retained (a1).' }));
  }, undefined, { entry: { file: 'mapping.tsv', key: 'stream', columns }, rows: [{ name: 'A', left_value: 0, right_value: null }, { name: 'B', left_value: null, right_value: -2 }] });
  const result = await f.run();
  assert.equal(result.outcome, 'completed', result.error);
  const saved = JSON.parse(await fs.readFile(result.artifacts[0].storage_uri, 'utf8'));
  assert.deepEqual(saved.provenance.predicate_columns, ['left_value', 'right_value']);
  assert.deepEqual(saved.rows.map(row => row.filtered_column), ['left_value', 'right_value']);
});

test('single Investigator advertises unary filters and validates the exact filtered source-row count', async () => {
  const filename = require.resolve('../../src/system/agents/investigatorTrail');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  let calls = 0;
  loaded.require = name => name === '../../inference/jsonCall' ? { async jsonCall(system, user) {
    if (++calls === 1) {
      assert.match(system, /is_missing.*is_present.*is_numeric.*is_non_numeric/);
      return { reads: [{ table: 'source.tsv', where: [{ column: 'value', op: 'is_numeric' }] }] };
    }
    assert.match(user, /"source_rows":4,"matching_rows":2/);
    return { found: true, answer: 'Two source rows contain numeric measurements.', value: 2, table: 'source.tsv', cited_coverage: { read_id: 'r1', table: 'source.tsv', metric: 'matching_rows', value: 2 }, confidence: 'high' };
  } } : name === '../../hpa/agentMode' ? { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'fixture' }; } } : original(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const entry = { file: 'source.tsv', key: 'ensembl', columns: ['value'] };
  const result = await loaded.exports({ gene: 'A', question: 'Count recorded numeric source values.' }, {}, { ...adapter, async resolveGene() { return { gene: 'A', ensembl: 'ID_A' }; }, async overview() { return 'source.tsv value'; }, async entry() { return entry; }, async read() { return { entry, rows: [null, 0, -2, '1-2'].map(value => ({ value })) }; }, pageUrl() { return 'source'; } });
  assert.equal(result.found, true, result.error);
  assert.equal(result.grounded, true);
  assert.equal(result.coverage[0].source_rows, 4);
  assert.equal(result.coverage[0].matching_rows, 2);
  assert.equal(result.cited_coverage.value, 2);
  assert.equal(calls, 2);
});
