'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const backend = path.resolve(__dirname, '../..');

// Load each agent fixture in an isolated module cache while preserving real dependency paths.
function loader(stubs = {}) {
  const cache = new Map();
  function load(relative) {
    const filename = path.join(backend, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const copy = filename;
    const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = loaded.require.bind(loaded);
    loaded.require = name => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      return original(name);
    };
    cache.set(filename, loaded);
    loaded._compile(fs.readFileSync(copy, 'utf8'), filename);
    return loaded.exports;
  }
  return load;
}

const ops = loader()('src/system/aso/studyTools.js');
const views = loader()('src/system/aso/observationViews.js');
const { StudyContext } = require(path.join(backend, 'src/system/aso/studyContext'));

test('composite full join pairs exact entity tuples and retains both unmatched sides with original keys', () => {
  const left = [{ gene: 'A', region: 'one', rna: 0 }, { gene: 'A', region: 'two', rna: 4 }, { gene: 'B', region: 'three', rna: null }];
  const right = [{ gene: 'A', region: 'one', protein: 7 }, { gene: 'A', region: 'two', protein: 8 }, { gene: 'C', region: 'four', protein: 0 }];
  const result = ops.join(left, right, 'full', null, ['gene', 'region']);
  assert.deepEqual(result, [
    { gene: 'A', region: 'one', rna: 0, protein: 7 },
    { gene: 'A', region: 'two', rna: 4, protein: 8 },
    { gene: 'B', region: 'three', rna: null, protein: null },
    { gene: 'C', region: 'four', rna: null, protein: 0 }
  ]);
  assert.equal(ops.join(left, right, 'inner', 'gene').length, 4);
});

test('typed tuple keys cannot collide through delimiters, missingness or numeric coercion', () => {
  const left = [{ group: 'a|b', cell: 'c', l: 1 }, { group: 'a', cell: 'b|c', l: 2 }, { group: null, cell: 'c', l: 3 }, { group: 'x', cell: 0, l: 4 }, { group: 'x', cell: '0', l: 5 }];
  const right = [{ group: 'a|b', cell: 'c', r: 9 }, { group: 'a', cell: 'b|c', r: 8 }, { group: null, cell: 'c', r: 7 }, { group: 'x', cell: 0, r: 6 }];
  const result = ops.join(left, right, 'full', null, ['group', 'cell']);
  assert.deepEqual(result.map(row => [row.l, row.r]), [[1, 9], [2, 8], [3, null], [4, 6], [5, null], [null, 7]]);
});

test('join multiplicity is preserved and right-only output carries canonical identities', () => {
  const a = [{ gene: 'A', ensembl: 'ID_A', region: 'x', x: 1 }, { gene: 'A', ensembl: 'ID_A', region: 'x', x: 2 }];
  const b = [{ gene: 'A', ensembl: 'ID_A', region: 'x', y: 3 }, { gene: 'A', ensembl: 'ID_A', region: 'x', y: 4 }, { gene: 'A', ensembl: 'ID_A', region: 'x', y: 5 }, { gene: 'B', ensembl: 'ID_B', region: 'y', y: 6 }];
  const result = ops.join(a, b, 'right', null, ['ensembl', 'region']);
  assert.equal(result.length, 7);
  assert.deepEqual(result.at(-1), { gene: 'B', ensembl: 'ID_B', region: 'y', x: null, gene_2: 'B', y: 6 });
  assert.deepEqual(result.slice(0, 6).map(row => [row.x, row.y]), [[1, 3], [1, 4], [1, 5], [2, 3], [2, 4], [2, 5]]);
});

test('join empty schemas, legacy calls and invalid selectors are explicit', () => {
  const left = ops.withColumns([], ['gene', 'region', 'x']);
  const right = ops.withColumns([], ['gene', 'region', 'y']);
  assert.deepEqual(ops.columnsOf(ops.join(left, right, 'full', null, ['gene', 'region'])), ['gene', 'region', 'x', 'y']);
  assert.deepEqual(ops.join(left, [{ gene: 'A', region: 'x', y: 3 }], 'full', null, ['gene', 'region']), [{ gene: 'A', region: 'x', x: null, y: 3 }]);
  assert.deepEqual(ops.join([{ gene: 'A', x: 0 }, { gene: 'B', x: 2 }], [{ gene: 'A', y: 3 }], 'left', 'gene'), [{ gene: 'A', x: 0, y: 3 }, { gene: 'B', x: 2, y: null }]);
  assert.throws(() => ops.join(left, right, 'full', 'gene', ['gene']), /not both/);
  assert.throws(() => ops.join(left, right, 'full', null, []), /nonempty/);
  assert.throws(() => ops.join(left, right, 'full', null, ['gene', 'Gene']), /distinct/);
  assert.throws(() => ops.join(left, right, 'full', null, ['missing']), /no column/);
  assert.throws(() => ops.join(left, right, 'fuzzy', null, ['gene']), /how/);
  assert.throws(() => ops.join([{ gene: 'A', x: 1, x_2: 2 }], [{ gene: 'A', x: 3 }], 'full', null, ['gene']), /collision/);
});

test('row selection has no arbitrary ceiling and still rejects invalid requests', () => {
  for (const rows of [1, 7, 200, 257, 600, 1023, Number.MAX_SAFE_INTEGER]) assert.deepEqual(views.rowPageOptions({ rows }), { rows, offset: 0 });
  for (const rows of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => views.rowPageOptions({ rows }), /positive safe integer/);
  for (const offset of [-1, 0.5, Infinity]) assert.throws(() => views.rowPageOptions({ offset }), /nonnegative/);
});

test('large typed values page exactly with advancing Unicode-safe cursors and bounded envelopes', () => {
  const value = { columns: ['value'], rows: [[[{ name: '🧬β-cell\tgroup', zero: 0, missing: null, empty: '', flag: false }, ...Array.from({ length: 300 }, (_, i) => ({ label: `quoted "value" ${i}`, path: 'a/b~c', value: i }))]]] };
  const reader = views.createViewReader({ budgetBytes: 512 });
  let response = reader.open(value), reconstructed = '';
  const id = response.view;
  assert.ok(id);
  for (;;) {
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 512);
    assert.ok(response.next_text_offset > response.text_offset);
    assert.ok(!/[\uD800-\uDBFF]$/.test(response.text));
    reconstructed += response.text;
    if (response.complete) break;
    response = reader.read({ view: id, text_offset: response.next_text_offset });
  }
  assert.deepEqual(JSON.parse(reconstructed), value);
  assert.equal(reader.archive.records.get(id).record.text, JSON.stringify(value));
  const emoji = JSON.stringify(value).indexOf('🧬');
  assert.throws(() => reader.read({ view: id, text_offset: emoji + 1 }), /Unicode/);
  assert.throws(() => reader.read({ view: 'other', text_offset: 0 }), /No saved/);
});

test('tiny delivery budgets fail explicitly and persisted immutable views can resume', async t => {
  const archive = new StudyContext();
  const tiny = views.createViewReader({ budgetBytes: 1, archive });
  let failure;
  try { tiny.open({ value: '🧬'.repeat(300) }); } catch (error) { failure = error; }
  assert.equal(failure.code, 'view_delivery_budget_exceeded');
  assert.ok(failure.minimum_bytes > 1); assert.ok(failure.view);
  const usable = views.createViewReader({ budgetBytes: failure.minimum_bytes, archive, views: tiny.ids() });
  assert.ok(usable.read({ view: failure.view }).next_text_offset > 0);
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'atlas-view-proposal-'));
  t.after(() => fsp.rm(directory, { recursive: true }));
  await archive.flush(directory);
  const restored = new StudyContext();
  for (const file of await fsp.readdir(directory)) { const record = JSON.parse(await fsp.readFile(path.join(directory, file), 'utf8')); restored.records.set(record.id, { record, delivered: false, touched: 0 }); }
  const resumed = views.createViewReader({ budgetBytes: 512, archive: restored, views: tiny.ids() });
  assert.deepEqual(resumed.read({ view: failure.view }), views.createViewReader({ budgetBytes: 512, archive, views: tiny.ids() }).read({ view: failure.view }));
});

test('cell and JSON-Pointer selection preserves null, zero and literal escaped keys', () => {
  const rows = [{ value: { 'a/b': { '~key': [0, null, false, ''] } } }];
  for (const [i, expected] of [0, null, false, ''].entries()) assert.equal(views.cellValue(rows, ['value'], { row: 0, column: 'value', path: `/a~1b/~0key/${i}` }), expected);
  assert.deepEqual(views.cellValue(rows, ['value'], { row: 0, column: 'value' }), rows[0].value);
  for (const pointer of ['/missing', '/a~1b/~0key/99', '/__proto__', '/a~2b', 'no-slash']) assert.throws(() => views.cellValue(rows, ['value'], { row: 0, column: 'value', path: pointer }));
  assert.throws(() => views.cellValue(rows, ['value'], { row: 1, column: 'value' }), /existing result row/);
  assert.throws(() => views.cellValue(rows, ['value'], { row: 0, column: 'missing' }), /No result column/);
});

function response(name, args, id) { return { choices: [{ message: { role: 'assistant', tool_calls: [{ id, type: 'function', thought_signature: 'retained-signature', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; }

test('native bulk open can request257 rows and recover an oversized source cell without another lookup', async () => {
  const count = 257;
  const names = Array.from({ length: count }, (_, i) => `INPUT_${i}`);
  const resolved = names.map((gene, i) => ({ gene, ensembl: `ID_${i}` }));
  const long = '🧬β'.repeat(900);
  const entry = { file: 'records.tsv', key: 'name', columns: ['target', 'value'] };
  const byGene = new Map(resolved.map((gene, i) => [gene.ensembl, [{ target: gene.gene, value: i === 0 ? long : i }]]));
  let reads = 0, turn = 0, fragments = '', rowPage = null;
  const run = loader({
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'fixture' }; } },
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) {
      turn++;
      if (turn === 1) return response('apply_bulk', { name: 'values', lookups: [{ table: entry.file, match_column: 'target', value_column: 'value', as: 'measurement' }] }, `call-${turn}`);
      if (turn === 2) return response('open_result', { name: 'values', rows: 257, columns: ['gene'] }, `call-${turn}`);
      const previous = JSON.parse(request.messages.at(-1).content);
      if (turn === 3) { rowPage = previous; return response('open_result', { name: 'values', cell: { row: 0, column: 'measurement' } }, `call-${turn}`); }
      assert.equal(previous.delivery, 'text_fragment');
      fragments += previous.text;
      if (!previous.complete) return response('open_result', { view: previous.view, text_offset: previous.next_text_offset }, `call-${turn}`);
      return response('finish', { results: ['values'], answer: 'Source data retained exactly.', unavailable_requirements: [] }, `call-${turn}`);
    } } } } }
  })('src/system/agents/investigatorBulk.js');
  const result = await run({ genes: names, question: 'Read the source values.' }, { reasoningEffort: 'low' }, { async resolveGenes() { return resolved; }, async catalog() { return [entry]; }, async entry() { return entry; }, async readMany() { reads++; return { entry, byGene }; } });
  assert.equal(result.status, 'ok'); assert.equal(reads, 1);
  assert.equal(rowPage.rows.length, 257); assert.equal(rowPage.more, false);
  assert.equal(JSON.parse(fragments).value, long);
  assert.equal(result.tables[0].rows[0].measurement, long);
});

test('native bulk view and row/cell selectors cannot be combined ambiguously', async () => {
  let turn = 0, rejection;
  const entry = { file: 'records.tsv', key: 'name', columns: ['target', 'value'] };
  const run = loader({ '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'fixture' }; } }, '../../inference/gateway': { inference: { chat: { completions: { async create(request) {
    turn++;
    if (turn === 1) return response('open_result', { view: 'o1', name: 'values' }, `call-${turn}`);
    rejection = JSON.parse(request.messages.at(-1).content);
    return response('finish', { results: [], answer: 'No source requested.', unavailable_requirements: [{ requirement: 'not requested', why: 'fixture' }] }, `call-${turn}`);
  } } } } } })('src/system/agents/investigatorBulk.js');
  await run({ genes: ['A'], question: 'Fixture.' }, {}, { async resolveGenes() { return [{ gene: 'A', ensembl: 'ID_A' }]; }, async catalog() { return [entry]; } });
  assert.match(rejection.error, /only view and text_offset/);
});

test('secondary ordering sorts actual rows while tied primary scores retain competition ranks', () => {
  const rows = [{ gene: 'Z', score: 0 }, { gene: 'C', score: 8 }, { gene: 'B', score: 8 }, { gene: 'A', score: 8 }, { gene: 'Y', score: null }, { gene: 'X', score: null }];
  const then = [{ column: 'gene', order: 'asc', type: 'text' }];
  const ordered = ops.rank(rows, 'score', 'desc', 0, 'include', then);
  assert.deepEqual(ordered.map(r => [r.gene, r.rank]), [['A', 1], ['B', 1], ['C', 1], ['Z', 4], ['X', null], ['Y', null]]);
  assert.deepEqual(ops.rank(rows, 'score', 'desc', 1, 'include', then).map(r => r.gene), ['A', 'B', 'C']);
  assert.deepEqual(ops.rank(rows, 'score', 'desc', 1, 'truncate', then).map(r => r.gene), ['A']);
});

test('secondary ordering distinguishes numeric and text keys and puts missing values last', () => {
  const rows = [{ score: 1, batch: '2', name: 'z' }, { score: 1, batch: '10', name: 'a' }, { score: 1, batch: null, name: 'b' }, { score: 1, batch: '2', name: 'a' }];
  const sorted = ops.rank(rows, 'score', 'desc', 0, 'include', [{ column: 'batch', type: 'number' }, { column: 'name', type: 'text' }]);
  assert.deepEqual(sorted.map(r => [r.batch, r.name]), [['2', 'a'], ['2', 'z'], ['10', 'a'], [null, 'b']]);
  assert.deepEqual(ops.rank(rows, 'score', 'desc', 0, 'include', [{ column: 'batch', type: 'text' }]).map(r => r.batch), ['10', '2', '2', null]);
  assert.deepEqual(ops.rank(rows, 'score', 'desc', 0, 'include', [{ column: 'batch', type: 'number', order: 'desc' }]).map(r => r.batch), ['10', '2', '2', null]);
  for (const then of [[{ column: 'absent' }], [{ column: 'name', type: 'number' }], [{ column: 'name', type: 'locale' }], [{ column: 'name', order: 'up' }], [{ column: 'name' }, { column: 'Name' }], {}]) assert.throws(() => ops.rank(rows, 'score', 'desc', 0, 'include', then), /then_by/);
});

test('streaming grouped ranking admits later better secondary keys and matches complete ranking', async () => {
  const rows = [{ group: 'q', name: 'z', value: 5 }, { group: 'q', name: 'b', value: 5 }, { group: 'q', name: 'a', value: 5 }, { group: 'r', name: 'z', value: null }, { group: 'r', name: 'a', value: null }];
  const options = { group_by: 'group', by: 'value', n: 1, ties: 'truncate', then_by: [{ column: 'name', type: 'text' }] };
  const expected = [{ group: 'q', name: 'a', value: 5, rank: 1 }, { group: 'r', name: 'a', value: null, rank: null }, { group: 'r', name: 'z', value: null, rank: null }];
  assert.deepEqual(ops.topPerGroup(rows, options), expected);
  assert.deepEqual(await ops.topPerGroupStream((async function* () { yield* rows; })(), options, ops.columnsOf(rows)), expected);
  assert.deepEqual(ops.topPerGroup(rows, { ...options, ties: 'include' }).map(r => r.name), ['a', 'b', 'z', 'a', 'z']);
});

test('bulk global and per-input rankings expose and apply secondary ordering', async () => {
  const { createBulkTools, APPLY_BULK } = loader()('src/system/agents/investigatorBulkTools.js');
  const supplied = ['Z', 'A'], resolved = supplied.map(gene => ({ gene, ensembl: `ID_${gene}` }));
  const entry = { file: 'values.tsv', columns: ['target', 'place', 'value'] };
  const byGene = new Map(resolved.map(gene => [gene.ensembl, [{ target: gene.gene, place: 'z', value: 5 }, { target: gene.gene, place: 'a', value: 5 }, { target: gene.gene, place: 'n', value: null }]]));
  const bulk = createBulkTools({ supplied, resolved, adapter: { async entry() { return entry; }, async readMany() { return { entry, byGene }; } } });
  const summary = await bulk.applyBulk({ name: 'summary', lookups: [{ table: entry.file, match_column: 'target', value_column: 'value', aggregate: 'max', as: 'peak' }], sort: { by: 'peak', then_by: [{ column: 'gene', type: 'text' }] } });
  assert.deepEqual(summary.rows.map(r => [r.gene, r.rank]), [['A', 1], ['Z', 1]]);
  const lookup = { mode: 'rows', table: entry.file, match_column: 'target', columns: ['place', 'value'], top_by: 'value', then_by: [{ column: 'place', type: 'text' }] };
  const all = await bulk.applyBulk({ name: 'all', lookups: [lookup] });
  assert.deepEqual(all.rows.map(r => [r.gene, r.place, r.rank]), [['Z', 'a', 1], ['Z', 'z', 1], ['Z', 'n', null], ['A', 'a', 1], ['A', 'z', 1], ['A', 'n', null]]);
  const top = await bulk.applyBulk({ name: 'top', lookups: [{ ...lookup, top: 1, ties: 'truncate' }] });
  assert.deepEqual(top.rows.map(r => r.place), ['a', 'a']);
  await assert.rejects(() => bulk.applyBulk({ name: 'invalid', lookups: [{ ...lookup, top_by: undefined }] }), /primary top_by/);
  assert.ok(APPLY_BULK.function.parameters.properties.sort.properties.then_by);
  assert.ok(APPLY_BULK.function.parameters.properties.lookups.items.properties.then_by);
});

test('fresh result schemas never invent canonical identifiers', () => {
  const rows = ops.freshFirst([{ tissue: 'sample', mean: 0 }], ['tissue']);
  assert.deepEqual(ops.columnsOf(rows), ['mean', 'tissue']);
  assert.deepEqual(rows, [{ mean: 0, tissue: 'sample' }]);
  const empty = ops.withColumns([], ['tissue', 'mean']);
  assert.deepEqual(ops.columnsOf(ops.freshFirst(empty, ['tissue'])), ['tissue', 'mean']);
  assert.deepEqual(ops.columnsOf(ops.freshFirst([{ gene: 'A', value: 1 }], ['gene'])), ['gene', 'value']);
});

test('chart domains preserve exact explicit bounds and reject clipping, including zero baselines', () => {
  const rows = [{ name: 'A', value: 0.25 }, { name: 'B', value: 0.8 }];
  const args = { type: 'bar', x: 'name', y: 'value' };
  assert.deepEqual(ops.chartSpec({ ...args, y_domain: [0, 1] }, rows).y_domain, [0, 1]);
  assert.equal(Object.hasOwn(ops.chartSpec(args, rows), 'y_domain'), false);
  for (const domain of [[1, 0], [0, 0], [0, Infinity], ['0', 1], [0], null]) assert.throws(() => ops.chartSpec({ ...args, y_domain: domain }, rows), /two finite increasing/);
  assert.throws(() => ops.chartSpec({ ...args, y_domain: [0, 0.5] }, rows), /clip/);
  assert.throws(() => ops.chartSpec({ ...args, y_domain: [0.2, 1] }, rows), /baseline/);
  assert.throws(() => ops.chartSpec({ ...args, x_domain: [0, 1] }, rows), /numeric displayed x axis/);
});

test('chart domains use displayed axes for horizontal, numeric and categorical charts', () => {
  const rows = [{ name: 'A', value: 0.25 }, { name: 'B', value: 0.8 }];
  for (const type of ['dot_plot', 'lollipop', 'diverging_bar']) {
    assert.deepEqual(ops.chartSpec({ type, x: 'name', y: 'value', x_domain: [0, 1] }, rows).x_domain, [0, 1]);
    assert.throws(() => ops.chartSpec({ type, x: 'name', y: 'value', y_domain: [0, 1] }, rows), /numeric displayed y axis/);
  }
  const scatter = ops.chartSpec({ type: 'scatter', x: 'a', y: 'b', x_domain: [-1, 1], y_domain: [0, 2] }, [{ a: 0, b: 1 }]);
  assert.deepEqual([scatter.x_domain, scatter.y_domain], [[-1, 1], [0, 2]]);
  assert.throws(() => ops.chartSpec({ type: 'heatmap', x_domain: [0, 1] }, { matrix: [[0]], row_labels: ['A'], col_labels: ['B'] }), /numeric displayed x axis/);
  const line = ops.chartSpec({ type: 'line', x: 'time', y: 'value', x_domain: [0, 10], y_domain: [0, 1] }, [{ time: '2', value: 0.5 }, { time: '8', value: 1 }]);
  assert.deepEqual(line.data.map(r => r.x), [2, 8]);
  assert.throws(() => ops.chartSpec({ type: 'line', x: 'name', y: 'value', x_domain: [0, 1] }, rows), /numeric displayed x axis/);
});
