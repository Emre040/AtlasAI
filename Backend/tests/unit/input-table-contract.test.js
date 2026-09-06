'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const BACKEND = path.resolve(__dirname, '../..');
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

const data = {
  "rows": [
    {
      "gene": "ALPHA",
      "ensembl": "ID-A",
      "region": "west",
      "reading": "0",
      "flag": false,
      "details": {
        "label": "α",
        "values": [
          0,
          "0"
        ]
      },
      "unused": null
    },
    {
      "gene": "BETA",
      "ensembl": "ID-B",
      "region": "east",
      "reading": "-2",
      "flag": true,
      "details": null,
      "unused": null
    },
    {
      "gene": "ALPHA",
      "ensembl": "ID-A",
      "region": "north",
      "reading": null,
      "flag": false,
      "details": {
        "label": "β",
        "values": []
      },
      "unused": null
    },
    {
      "gene": "ALPHA",
      "ensembl": "ID-A",
      "region": "west",
      "reading": "0",
      "flag": false,
      "details": {
        "label": "α",
        "values": [
          0,
          "0"
        ]
      },
      "unused": null
    },
    {
      "gene": "ABSENT",
      "ensembl": "ID-C",
      "region": null,
      "reading": null,
      "flag": null,
      "details": null,
      "unused": null
    }
  ],
  "columns": [
    "gene",
    "ensembl",
    "region",
    "reading",
    "flag",
    "details",
    "unused"
  ],
  "record_rows": [
    true,
    true,
    true,
    true,
    false
  ],
  "unique_rows": [
    {
      "gene": "ALPHA",
      "ensembl": "ID-A",
      "region": "west",
      "reading": "0",
      "flag": false,
      "details": {
        "label": "α",
        "values": [
          0,
          "0"
        ]
      },
      "unused": null
    },
    {
      "gene": "BETA",
      "ensembl": "ID-B",
      "region": "east",
      "reading": "-2",
      "flag": true,
      "details": null,
      "unused": null
    }
  ],
  "source_cohort": [
    "ID-A",
    "ID-B",
    "ID-C"
  ],
  "expected_real_row_count": 4,
  "expected_all_row_count": 5,
  "expected_numeric_count": 3,
  "expected_sum": -2
};
const bulkFile = path.join(BACKEND, 'src/system/agents/investigatorBulk.js');
const clone = value => structuredClone(value);
const uniqueGenes = rows => [...new Set(rows.map(row => row.ensembl))];
const originalMetadata = { status: 'ok', operations: [{ tool: 'select', inputs: { artifact: 'older_namespace_result' }, args: { columns: ['reading'] } }], source_note: 'Preserve the original external ancestry.' };
function inputTable(rows = data.rows, mask = data.record_rows) {
  return { source: { id: 'prior_artifact', uuid: 'prior-artifact-uuid', inputs: ['external_parent'], meta: clone(originalMetadata) }, rows: clone(rows), columns: [...data.columns], record_rows: [...mask], row_kind: 'source_record' };
}
async function bulk(ctx, decide, args = {}) {
  const loaded = new Module(bulkFile, module); loaded.filename = bulkFile; loaded.paths = Module._nodeModulePaths(path.dirname(bulkFile));
  const actual = loaded.require.bind(loaded), requests = [], reads = [], resolutions = [];
  loaded.require = name => name === '../../hpa/agentMode' ? { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'fixture' }; } } : name === '../../inference/gateway' ? { inference: { chat: { completions: { async create(request) { requests.push(clone(request)); return response(...decide({ request, turn: requests.length }).map(([name, args]) => call(name, args))); } } } } } : actual(name);
  loaded._compile(await fs.readFile(bulkFile, 'utf8'), bulkFile);
  const ids = new Map([['ID-A', 'ALPHA'], ['ID-B', 'BETA'], ['ID-C', 'ABSENT'], ['ALPHA', 'ALPHA'], ['ALPHA_ALIAS', 'ALPHA'], ['BETA', 'BETA'], ['ABSENT', 'ABSENT']]);
  const entry = { file: 'new-source.tsv', key: 'ensembl', columns: ['Gene', 'new_reading'] };
  const adapter = {
    async catalog() { return [entry]; }, async entry() { return entry; },
    async resolveGenes(names) { resolutions.push([...names]); return names.map(name => { const gene = ids.get(name); return gene ? { gene, ensembl: { ALPHA: 'ID-A', BETA: 'ID-B', ABSENT: 'ID-C' }[gene] } : null; }); },
    async readMany(genes, file) { reads.push({ genes: clone(genes), file }); return { entry, byGene: new Map(genes.map(gene => [gene.ensembl, gene.ensembl === 'ID-C' ? [] : [{ Gene: gene.ensembl, new_reading: gene.ensembl === 'ID-A' ? '7' : '8' }]])) }; },
    async read() { throw new Error('Saved input operations must not reopen a source'); }
  };
  const genes = ctx.inputTable ? uniqueGenes(ctx.inputTable.rows) : ['ALPHA', 'BETA'];
  const result = await loaded.exports({ genes, question: 'Operate on the existing input table.', ...args }, ctx, adapter);
  return { result, requests, reads, resolutions };
}
const inputHandle = 'input';
for (const repeated of [false, true]) test(`saved ${repeated ? 'multirow' : 'unique-identity'} input remains inspectable with exact rows/order/schema/mask and zero source reads`, async () => {
  const table = inputTable(repeated ? data.rows : data.unique_rows, repeated ? data.record_rows : [true, true]), before = clone(table);
  const run = await bulk({ inputTable: table }, ({ request, turn }) => {
    if (turn === 1) return [['open_result', { name: inputHandle, schema: true }]];
    assert.equal(turn, 2);
    assert.deepEqual(JSON.parse(request.messages.at(-1).content).columns, data.columns);
    return [['finish', { results: [inputHandle] }]];
  });
  assert.equal(run.result.status, 'ok', run.result.error); assert.equal(run.reads.length, 0);
  const preserved = run.result.tables[0];
  assert.deepEqual(preserved.rows, before.rows); assert.deepEqual(preserved.columns, before.columns); assert.deepEqual(preserved.record_rows, before.record_rows);
  assert.deepEqual(preserved.input_source, before.source);
  assert.equal(preserved.operations?.length || 0, 0, 'Foreign ancestry must not become current local predecessor names');
  assert.deepEqual(table, before, 'Input table is immutable');
});

test('from-table source lookups use each canonical identity once while original measurements remain retained for ASO', async () => {
  const source = inputTable(), before = clone(source);
  const run = await bulk({ inputTable: source }, ({ turn }) => turn === 1 ? [
    ['apply_bulk', { name: 'lookup', lookups: [{ table: 'new-source.tsv', match_column: 'Gene', value_column: 'new_reading', as: 'added_reading' }] }]
  ] : [['finish', { results: ['lookup'] }]]);
  assert.equal(run.result.status, 'ok', run.result.error); assert.equal(run.reads.length, 1);
  assert.deepEqual(run.reads[0].genes.map(gene => gene.ensembl), data.source_cohort);
  const lookup = run.result.tables[0], retained = run.result.retained_tables.find(table => table.name === inputHandle);
  assert.equal(lookup.rows.length, 3); assert.ok(!lookup.columns.includes('region'), 'Multirow observations are not copied into a one-row-per-gene lookup base');
  assert.deepEqual(lookup.rows.map(row => row.added_reading), ['7', '8', null]);
  assert.deepEqual(retained.rows, before.rows); assert.deepEqual(retained.record_rows, before.record_rows);
  assert.deepEqual(source, before);
});

test('explicit genes list keeps per-supplied-item compatibility including duplicate identities', async () => {
  const run = await bulk({}, ({ turn }) => turn === 1 ? [['apply_bulk', { name: 'lookup', lookups: [{ table: 'new-source.tsv', match_column: 'Gene', value_column: 'new_reading', as: 'value' }] }]] : [['finish', { results: ['lookup'] }]], { genes: ['ALPHA', 'ALPHA', 'BETA'] });
  assert.equal(run.result.status, 'ok', run.result.error);
  assert.deepEqual(run.result.tables[0].rows.map(row => [row.gene, row.value]), [['ALPHA', '7'], ['ALPHA', '7'], ['BETA', '8']]);
});

test('ASO forwards the exact saved multirow table contract and unique lookup IDs to Investigator', async t => {
  let invocations = 0, sourceReads = 0;
  const f = await fixture(t, ({ turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Retrieve measurements', kind: 'table' }, { step: 'Retrieve additional source measurements', kind: 'table' }] }), call('investigator_hpa', { genes: ['ALPHA', 'BETA', 'ABSENT'], question: 'Retrieve measurements', node: 1 }));
    if (turn === 2) return response(call('investigator_hpa', { from: 'a1', question: 'Retrieve additional source measurements', node: 2 }));
    return response(call('finish', { completed: [{ item: 2, artifacts: ['a2'] }], tables: [{ artifact: 'a2', columns: ['gene', 'added_reading'] }] }));
  }, async (name, args, ctx) => {
    invocations++;
    if (invocations === 1) return { result: { bulk: true, status: 'ok', tables: [{ name: 'measurements', rows: clone(data.rows), columns: data.columns, record_rows: data.record_rows, row_kind: 'source_record', provenance: [], coverage: [] }], remaining_for_aso: [], not_in_release: [] } };
    assert.deepEqual(args.genes, data.source_cohort); assert.ok(ctx.inputTable);
    assert.deepEqual(ctx.inputTable.rows, data.rows); assert.deepEqual(ctx.inputTable.columns, data.columns); assert.deepEqual(ctx.inputTable.record_rows, data.record_rows);
    assert.equal(ctx.inputTable.source.id, 'a1'); assert.equal(ctx.inputTable.source.uuid, 'artifact-1');
    const run = await bulk(ctx, ({ turn }) => turn === 1 ? [['apply_bulk', { name: 'lookup', lookups: [{ table: 'new-source.tsv', match_column: 'Gene', value_column: 'new_reading', as: 'added_reading' }] }]] : [['finish', { results: ['lookup'] }]], args);
    sourceReads += run.reads.length; return { result: run.result };
  });
  const result = await f.run({ max_turns: 3 }); assert.equal(result.outcome, 'completed', result.error);
  assert.equal(invocations, 2); assert.equal(sourceReads, 1); assert.equal(result.plan[1].status, 'done');
});

test('different aliases resolving to one canonical gene do not amplify from-table source lookups or overwrite original identities', async () => {
  const source = inputTable([{ ...data.rows[0], gene: 'ALPHA', ensembl: null }, { ...data.rows[2], gene: 'ALPHA_ALIAS', ensembl: null }, data.rows[1]], [true, true, true]);
  const before = clone(source);
  const run = await bulk({ inputTable: source }, ({ turn }) => turn === 1 ? [['apply_bulk', { name: 'lookup', lookups: [{ table: 'new-source.tsv', match_column: 'Gene', value_column: 'new_reading', as: 'value' }] }]] : [['finish', { results: ['lookup'] }]], { genes: ['ALPHA', 'ALPHA_ALIAS', 'BETA'] });
  assert.equal(run.result.status, 'ok', run.result.error); assert.equal(run.reads.length, 1);
  assert.deepEqual(run.reads[0].genes.map(gene => gene.ensembl), ['ID-A', 'ID-B']);
  assert.deepEqual(run.result.tables[0].rows.map(row => row.ensembl), ['ID-A', 'ID-B']);
  assert.deepEqual(run.result.retained_tables.find(table => table.name === inputHandle).rows, before.rows);
  assert.deepEqual(source, before);
});

test('single-gene Investigator retains its distinct one-gene resolution path', async () => {
  const file = path.join(BACKEND, 'src/system/agents/investigatorTrail.js'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file)); const actual = loaded.require.bind(loaded); let resolved = [];
  loaded.require = name => name === '../../inference/jsonCall' ? { async jsonCall() { throw new Error('Unexpected inference for an unresolved single gene'); } } : name === './investigatorBulk' ? () => { throw new Error('Unexpected bulk dispatch'); } : name === '../../hpa/agentMode' ? { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'fixture' }; } } : actual(name);
  loaded._compile(await fs.readFile(file, 'utf8'), file);
  const result = await loaded.exports({ gene: 'UNLISTED', question: 'Read the requested source record' }, {}, { async resolveGene(name) { resolved.push(name); return null; } });
  assert.deepEqual(resolved, ['UNLISTED']); assert.equal(result.evidence_status, 'gene_not_in_release');
});

test('returning a partially executed input cannot claim completion and preserves its exact original state', async () => {
  const table = inputTable();
  table.execution = { status: 'partial', completed_items: 4, failed_items: 1, failures: [{ item: 5, message: 'Source unavailable' }] };
  const before = clone(table);
  const run = await bulk({ inputTable: table }, () => [['finish', { results: [inputHandle] }]]);
  assert.equal(run.result.status, 'partial'); assert.equal(run.reads.length, 0);
  assert.deepEqual(run.result.tables.map(table => table.name), ['input']);
  assert.equal(run.result.remaining_for_aso.length, 1);
  assert.match(run.result.remaining_for_aso[0].why, /incomplete execution/);
  assert.deepEqual(run.result.tables[0].execution, before.execution);
  assert.deepEqual(run.result.tables[0].rows, before.rows); assert.deepEqual(table, before);
});

test('an empty saved input preserves its declared schema and needs no source reads', async () => {
  const table = inputTable([], []);
  const run = await bulk({ inputTable: table }, ({ request, turn }) => {
    if (turn === 1) return [['open_result', { name: 'input', schema: true }]];
    assert.equal(turn, 2);
    const toolReply = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content);
    assert.ok(!toolReply.error, JSON.stringify(toolReply));
    return [['finish', { results: ['input'] }]];
  });
  assert.equal(run.result.status, 'ok', run.result.error); assert.equal(run.result.input_count, 0); assert.equal(run.reads.length, 0);
  assert.deepEqual(run.result.tables[0].columns, data.columns); assert.deepEqual(run.result.tables[0].rows, []); assert.deepEqual(run.result.tables[0].record_rows, []);
  assert.deepEqual(run.result.tables[0].input_source, table.source);
});

test('an empty explicit genes list still rejects before inference', async () => {
  const run = await bulk({}, () => { throw new Error('No inference should run for an empty explicit genes list'); }, { genes: [] });
  assert.equal(run.result.status, 'incomplete'); assert.match(run.result.error, /nonempty array/);
  assert.equal(run.requests.length, 0); assert.equal(run.reads.length, 0);
});
