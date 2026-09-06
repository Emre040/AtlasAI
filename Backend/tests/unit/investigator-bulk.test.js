'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { createBulkTools } = require('../../src/system/agents/investigatorBulkTools');

async function load(relative, stubs) {
  const file = require.resolve(relative);
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const realRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name);
  loaded._compile(await fs.readFile(file, 'utf8'), file);
  return loaded.exports;
}

function fixture(n = 600) {
  const supplied = Array.from({ length: n }, (_, i) => `SPECIMEN_GENE_${i}`);
  const resolved = supplied.map((gene, i) => ({ gene, ensembl: `TEST_ID_${i}` }));
  const entry = { file: 'release_measurements.tsv', key: 'name', columns: ['Target', 'Organ', 'Reading [units]'], description: 'Measurements by organ' };
  const byGene = new Map(resolved.map((gene, i) => [gene.ensembl, [
    { Target: gene.gene, Organ: 'organ A', 'Reading [units]': String(i * 2) },
    { Target: gene.gene, Organ: 'organ B', 'Reading [units]': i === 1 ? '' : String(i) }
  ]]));
  let reads = 0;
  const adapter = {
    async entry(file) { return file === entry.file ? entry : null; },
    async catalog() { return [entry]; },
    definition() { return ''; },
    async overview() { return `${entry.file}: ${entry.columns.join(', ')}`; },
    async resolveGenes(names) { assert.deepEqual(names, supplied); return resolved; },
    async readMany() { reads++; return { entry, byGene }; }
  };
  const lookup = (organ, as) => ({ table: entry.file, match_column: 'Target', value_column: 'Reading [units]', as, where: [{ column: 'Organ', op: '=', value: organ }] });
  return { supplied, resolved, entry, byGene, adapter, lookup, reads: () => reads };
}

test('600 supplied genes share one source read, with exact values and zero/missing denominators', async () => {
  const f = fixture();
  const ops = createBulkTools({ ...f, inputRows: f.resolved.map(gene => ({ ...gene, prior: 17 })) });
  const result = await ops.applyBulk({ name: 'comparison', lookups: [f.lookup('organ A', 'a_units'), f.lookup('organ B', 'b_units')], derive: [{ name: 'ratio', expr: 'a_units / b_units' }] });
  assert.equal(result.rows.length, 600);
  assert.equal(f.reads(), 1);
  for (let i = 0; i < 600; i++) {
    assert.equal(result.rows[i].gene, f.supplied[i]);
    assert.equal(result.rows[i].a_units, i * 2);
    assert.equal(result.rows[i].b_units, i === 1 ? null : i);
    assert.equal(result.rows[i].ratio, i < 2 ? null : 2);
    assert.equal(result.rows[i].prior, 17);
  }
  assert.equal(result.rows[1].b_units_missing_rows, 1);
  assert.equal(result.provenance[1].value_column, 'Reading [units]');
});

test('bulk lookup rejects ambiguous measurements and uses an explicit median when supplied', async () => {
  const f = fixture(1);
  f.byGene.set('TEST_ID_0', [1, 9, 5, ''].map(value => ({ Target: f.supplied[0], Organ: 'organ A', 'Reading [units]': String(value) })));
  const ops = createBulkTools(f);
  await assert.rejects(() => ops.applyBulk({ name: 'ambiguous', lookups: [f.lookup('organ A', 'value')] }), /4 matching source rows/);
  const result = await ops.applyBulk({ name: 'median', lookups: [{ ...f.lookup('organ A', 'median_units'), aggregate: 'median' }] });
  assert.equal(result.rows[0].median_units, 5);
  assert.equal(result.rows[0].median_units_source_rows, 4);
  assert.equal(result.rows[0].median_units_missing_rows, 1);
  assert.equal(f.reads(), 1);
});

test('bulk rows retain entity labels, unknown genes, absent data, and explicit source counts', async () => {
  const f = fixture(3);
  f.resolved[1] = null;
  f.byGene.delete('TEST_ID_2');
  const ops = createBulkTools(f);
  const result = await ops.applyBulk({ name: 'top', lookups: [{ table: f.entry.file, match_column: 'Target', mode: 'rows', columns: ['Organ', 'Reading [units]'], top_by: 'Reading [units]', top: 1, ties: 'truncate' }] });
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].Organ, 'organ A');
  assert.equal(result.rows[0].source_rows, 2);
  assert.equal(result.rows[1].gene, f.supplied[1]);
  assert.equal(result.rows[1].lookup_status, 'gene_not_in_release');
  assert.equal(result.rows[2].lookup_status, 'no_matching_rows');
  assert.equal(result.rows[2]['Reading [units]'], null);
  assert.equal(result.coverage[0].genes_without_matching_rows, 2);
});

test('bulk lookup fails explicitly for incorrect columns and never broadens a no-match filter', async () => {
  const f = fixture(2); const ops = createBulkTools(f);
  await assert.rejects(() => ops.applyBulk({ name: 'wrong', lookups: [{ ...f.lookup('organ A', 'value'), match_column: 'Organ' }] }), /does not match/);
  await assert.rejects(() => ops.applyBulk({ name: 'wrong', lookups: [{ ...f.lookup('organ A', 'value'), value_column: 'guess' }] }), /no column/);
  const result = await ops.applyBulk({ name: 'missing', lookups: [f.lookup('not present', 'value')] });
  assert.deepEqual(result.rows.map(row => row.value), [null, null]);
  assert.equal(result.coverage[0].matched_source_rows, 0);
});

test('a source category is retained as text and is not counted as a missing value', async () => {
  const f = fixture(1);
  f.byGene.get('TEST_ID_0')[0]['Reading [units]'] = 'potential prognostic';
  const result = await createBulkTools(f).applyBulk({ name: 'category', lookups: [f.lookup('organ A', 'annotation')] });
  assert.equal(result.rows[0].annotation, 'potential prognostic');
  assert.equal(result.rows[0].annotation_missing_rows, 0);
  assert.equal(result.coverage[0].missing_output_values, 0);
});

test('requested result ranking uses computed values and keeps undefined ratios missing', async () => {
  const f = fixture(4);
  f.byGene.get('TEST_ID_3')[0]['Reading [units]'] = '30';
  const result = await createBulkTools(f).applyBulk({ name: 'ranked', lookups: [f.lookup('organ A', 'a'), f.lookup('organ B', 'b')], derive: [{ name: 'ratio', expr: 'a / b' }], sort: { by: 'ratio', order: 'desc' } });
  assert.deepEqual(result.rows.map(row => row.gene), [f.supplied[3], f.supplied[2], f.supplied[0], f.supplied[1]]);
  assert.deepEqual(result.rows.map(row => row.ratio), [10, 2, null, null]);
  assert.deepEqual(result.rows.map(row => row.rank), [1, 2, null, null]);
  assert.equal(result.sort.by, 'ratio');
  assert.equal(f.reads(), 1);
});

test('concurrent readers build one raw-file index, preserve exact rows and invalidate after a file change', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bulk-reader-test-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const source = path.join(directory, 'measurements.tsv');
  await fs.writeFile(source, 'id\tvalue\nFIRST\t2\nFIRST\t4\nSECOND\t9\n');
  const realFs = require('node:fs'); let scans = 0;
  const { LocalData } = await load('../../src/hpa/localData', { 'node:fs': { ...realFs, createReadStream(...args) { scans++; return realFs.createReadStream(...args); } } });
  const reader = new LocalData(); reader.root = directory;
  reader.registry.set('measurements.tsv', { localPath: 'measurements.tsv' });
  const [first, second, same] = await Promise.all([reader.geneRows('measurements.tsv', 'FIRST'), reader.geneRows('measurements.tsv', 'SECOND'), reader.geneRows('measurements.tsv', 'FIRST')]);
  assert.equal(scans, 1); assert.deepEqual(first, same);
  assert.deepEqual(first.map(row => row.value), ['2', '4']); assert.deepEqual(second, [{ id: 'SECOND', value: '9' }]);
  await fs.appendFile(source, 'THIRD\t11\n');
  assert.deepEqual(await reader.geneRows('measurements.tsv', 'THIRD'), [{ id: 'THIRD', value: '11' }]);
  assert.equal(scans, 2); assert.equal(reader.indexLoads.size, 0);
});

test('a failed index build is reported to every reader and a later read can retry', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bulk-index-failure-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  await fs.writeFile(path.join(directory, 'measurements.tsv'), 'id\tvalue\nFIRST\t2\n');
  const realFs = require('node:fs'); let fail = true;
  const { LocalData } = await load('../../src/hpa/localData', { 'node:fs': { ...realFs, createReadStream(...args) {
    if (!fail) return realFs.createReadStream(...args);
    const { Readable } = require('node:stream');
    return new Readable({ read() { this.destroy(new Error('source read failed')); } });
  } } });
  const reader = new LocalData(); reader.root = directory; reader.registry.set('measurements.tsv', {});
  const reads = await Promise.allSettled([reader.geneIndex('measurements.tsv'), reader.geneIndex('measurements.tsv')]);
  assert.ok(reads.every(result => result.status === 'rejected' && result.reason.message === 'source read failed'));
  assert.equal(reader.indexLoads.size, 0); assert.equal(reader.indexes.size, 0);
  fail = false;
  assert.deepEqual(await reader.geneRows('measurements.tsv', 'FIRST'), [{ id: 'FIRST', value: '2' }]);
});

test('Investigator can inspect an unshown saved result page without repeating the source read', async () => {
  const f = fixture(); let calls = 0;
  const bulk = await load('../../src/system/agents/investigatorBulk', {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) {
      calls++;
      const actions = [
        ['apply_bulk', { name: 'values', lookups: [f.lookup('organ A', 'a_units')] }],
        ['open_result', { name: 'values', offset: 598, rows: 2, columns: ['gene', 'a_units'] }],
        ['finish', { results: ['values'], answer: 'Complete source measurements returned.', not_in_release: [] }]
      ];
      if (calls === 2) assert.doesNotMatch(JSON.stringify(request), /SPECIMEN_GENE_599/);
      if (calls === 3) {
        const page = JSON.parse(request.messages.at(-1).content);
        assert.deepEqual(page.rows, [[f.supplied[598], 1196], [f.supplied[599], 1198]]);
        assert.equal(page.total, 600); assert.equal(page.more, false);
      }
      const [name, args] = actions[calls - 1];
      return { choices: [{ message: { tool_calls: [{ id: `call_${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
    } } } } }
  });
  const result = await bulk({ genes: f.supplied, question: 'Read the supplied measurements.' }, {}, f.adapter);
  assert.equal(result.status, 'ok'); assert.equal(result.tables[0].rows.length, 600);
  assert.equal(calls, 3); assert.equal(f.reads(), 1);
});

test('a repeated completed view stops with an explicit partial result and unfinished task', async () => {
  const f = fixture(); let calls = 0;
  const bulk = await load('../../src/system/agents/investigatorBulk', {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../inference/gateway': { inference: { chat: { completions: { async create() {
      calls++;
      const name = calls === 1 ? 'apply_bulk' : 'open_result';
      const args = calls === 1 ? { name: 'values', lookups: [f.lookup('organ A', 'a_units')] } : { name: 'values', rows: 1 };
      return { choices: [{ message: { tool_calls: [{ id: `call_${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
    } } } } }
  });
  const result = await bulk({ genes: f.supplied, question: 'Read measurements and compare cohorts.' }, { studyTask: 'Compare the cohorts' }, f.adapter);
  assert.equal(calls, 4); assert.equal(result.status, 'partial');
  assert.equal(result.stop_reason, 'no_progress_cycle'); assert.equal(result.incomplete, true);
  assert.match(result.error, /repeated a completed operation/);
  assert.equal(result.tables[0].rows.length, 600); assert.equal(result.tables[0].rows[599].a_units, 1198);
  assert.equal(result.remaining_for_aso[0].requirement, 'Compare the cohorts');
  assert.equal(f.reads(), 1);
});

test('bulk Investigator uses two model turns for 600 genes and never sends the full list to inference', async () => {
  const f = fixture(); const requests = [];
  const functionCall = (name, args, id) => ({ id, type: 'function', thought_signature: 'provider-signature', function: { name, arguments: JSON.stringify(args) } });
  const bulk = await load('../../src/system/agents/investigatorBulk', {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      assert.equal(request.reasoning_effort, 'low');
      assert.doesNotMatch(JSON.stringify(request), /SPECIMEN_GENE_599/);
      assert.match(request.messages[1].content, /Assigned plan result: Compare measurements with the earlier result/);
      assert.match(request.messages[1].content, /gene and ensembl identifiers plus 1 inherited columns retained/);
      assert.doesNotMatch(request.messages[1].content, /"prior"/);
      assert.match(request.messages[1].content, /Original study context \(constraints only; not additional assigned deliverables\):\nUNRELATED_STUDY_TASK/);
      const tool = requests.length === 1
        ? functionCall('apply_bulk', { name: 'values', lookups: [f.lookup('organ A', 'a_units'), f.lookup('organ B', 'b_units')] }, 'read')
        : functionCall('finish', { results: ['values'], answer: 'Source measurements returned. Mechanistic interpretation is unavailable.', not_in_release: [{ requirement: 'mechanism', why: 'No mechanism evidence in these source tables' }] }, 'done');
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [tool] } }], usage: { prompt_tokens: 11, completion_tokens: 3 } };
    } } } } }
  });
  const result = await bulk({ genes: f.supplied, question: 'Read both organs and assess mechanism.' }, { reasoningEffort: 'low', studyTask: 'Compare measurements with the earlier result', studyGoal: 'UNRELATED_STUDY_TASK', inputRows: f.resolved.map(gene => ({ ...gene, prior: 17 })) }, f.adapter);
  assert.equal(requests.length, 2);
  assert.equal(result.tables[0].rows.length, 600);
  assert.equal(result.status, 'partial');
  assert.equal(result.not_in_release[0].requirement, 'mechanism');
  assert.equal(result.tokens.total.total, 28);
  assert.equal(requests[1].messages[2].tool_calls[0].thought_signature, 'provider-signature');
  assert.equal(requests[1].messages[3].tool_call_id, 'read');
});

test('the existing single-gene Investigator path retains its response and source evidence', async () => {
  let calls = 0;
  const trail = await load('../../src/system/agents/investigatorTrail', {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../inference/jsonCall': { async jsonCall() {
      calls++;
      return calls === 1 ? { understanding: 'Single-gene question', reads: [{ table: 'one.tsv' }], cannot: [] }
        : { found: true, answer: 'Observed 12 units.', value: '12', entity: 'sample', table: 'one.tsv', cited_row: 'sample | 12', confidence: 'high', notes: ['Source note'] };
    } }
  });
  const entry = { file: 'one.tsv', title: 'One source', columns: ['sample', 'value'] };
  const adapter = { async resolveGene() { return { gene: 'ONE', ensembl: 'ID1' }; }, async overview() { return 'one.tsv'; }, async entry() { return entry; }, async read() { return { entry, rows: [{ sample: 'sample', value: 12 }] }; }, applyWhere(raw) { return { reading: raw, clauses: [] }; }, render(reading) { reading.shownRows = reading.rows; reading.shownColumns = entry.columns; return { text: 'sample | 12', total: 1, shown: 1 }; }, cited: () => true, pageUrl: () => 'source' };
  const result = await trail({ gene: 'ONE', question: 'Read its value' }, {}, adapter);
  assert.equal(calls, 2); assert.equal(result.found, true); assert.equal(result.extracted_value, '12');
  assert.equal(result.cited_row, 'sample | 12'); assert.deepEqual(result.notes, ['Source note']);
  assert.equal(result.bulk, undefined);
});
