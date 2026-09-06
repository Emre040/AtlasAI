'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { createBulkTools } = require('../../src/system/agents/investigatorBulkTools');
const { LocalData, parseHeader, parseCells } = require('../../src/hpa/localData');
const { columnsOf, withColumns, applyWhere, select, rank, topPerGroup, topPerGroupStream, aggregate, aggregateStream, compute, join, setOp } = require('../../src/system/aso/studyTools');

async function load(relative, stubs) {
  const file = require.resolve(relative);
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const original = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : original(name);
  loaded._compile(await fs.readFile(file, 'utf8'), file);
  return loaded.exports;
}

function cohort(sourceRows) {
  const supplied = ['ALPHA', 'BETA', 'GAMMA', 'ABSENT', 'UNRESOLVED'];
  const resolved = supplied.map((gene, index) => index === 4 ? null : ({ gene, ensembl: `ID_${index}` }));
  const entry = { file: 'assays.tsv', columns: ['target', 'category', 'replicate', 'signal'] };
  const byGene = new Map(resolved.filter(Boolean).map(gene => [gene.ensembl, sourceRows.filter(row => row.target === gene.gene)]));
  let reads = 0;
  const adapter = { async entry() { return entry; }, async readMany() { reads++; return { entry, byGene }; } };
  const lookup = { table: entry.file, match_column: 'target', value_column: 'signal' };
  return { supplied, resolved, adapter, lookup, reads: () => reads };
}

test('bulk extrema retain all label tuples, including zero ties, missing labels and missing inputs', async () => {
  const f = cohort([
    { target: 'ALPHA', category: 'x', replicate: 'one', signal: '0' },
    { target: 'ALPHA', category: 'y', replicate: 'one', signal: 0 },
    { target: 'ALPHA', category: 'x', replicate: 'two', signal: 0 },
    { target: 'BETA', category: 'z', replicate: 'one', signal: -3 },
    { target: 'BETA', category: 'w', replicate: 'one', signal: -3 },
    { target: 'BETA', category: '', replicate: 'one', signal: 8 },
    { target: 'GAMMA', category: 'v', replicate: 'one', signal: 'NA' }
  ]);
  const result = await createBulkTools(f).applyBulk({ name: 'extrema', lookups: [
    { ...f.lookup, aggregate: 'max', as: 'maximum', labels: ['category'] },
    { ...f.lookup, aggregate: 'min', as: 'minimum', labels: ['category', 'replicate'] }
  ], sort: { by: 'maximum' } });
  const byGene = new Map(result.rows.map(row => [row.gene, row]));
  assert.deepEqual(byGene.get('ALPHA').maximum_labels, [{ category: 'x' }, { category: 'y' }]);
  assert.equal(byGene.get('ALPHA').minimum_labels.length, 3);
  assert.deepEqual(byGene.get('BETA').minimum_labels, [{ category: 'z', replicate: 'one' }, { category: 'w', replicate: 'one' }]);
  assert.deepEqual(byGene.get('BETA').maximum_labels, [{ category: null }]);
  for (const gene of ['GAMMA', 'ABSENT', 'UNRESOLVED']) { assert.equal(byGene.get(gene).maximum, null); assert.deepEqual(byGene.get(gene).maximum_labels, []); }
  assert.equal(result.rows.length, f.supplied.length);
  assert.equal(f.reads(), 1);
  assert.ok(result.created_columns.includes('maximum_labels'));
  await assert.rejects(() => createBulkTools(f).applyBulk({ name: 'bad', lookups: [{ ...f.lookup, as: 'mean', aggregate: 'mean', labels: ['category'] }] }), /labels needs min or max/);
});

test('source rows, numeric measurements, distinct entities, zero and missing cells have separate exact counts', async () => {
  const f = cohort([
    { target: 'ALPHA', category: 'x', replicate: 1, signal: '0' },
    { target: 'ALPHA', category: 'x', replicate: 2, signal: 2 },
    { target: 'ALPHA', category: 'y', replicate: 1, signal: '' },
    { target: 'ALPHA', category: 'z', replicate: 1, signal: 'NA' },
    { target: 'ALPHA', category: null, replicate: 1, signal: 'category text' },
    { target: 'BETA', category: 'x', replicate: 1, signal: 'NA' }
  ]);
  const result = await createBulkTools(f).applyBulk({ name: 'counts', lookups: [
    { table: 'assays.tsv', match_column: 'target', aggregate: 'count', as: 'source_count' },
    { ...f.lookup, aggregate: 'numeric_count', as: 'measured_count' },
    { table: 'assays.tsv', match_column: 'target', aggregate: 'distinct_count', distinct_columns: ['category'], as: 'entity_count' },
    { ...f.lookup, aggregate: 'distinct_count', distinct_columns: ['category'], where: [{ column: 'signal', op: '>=', value: 0 }], as: 'observed_entities' },
    { ...f.lookup, aggregate: 'missing', as: 'missing_count' },
    { ...f.lookup, aggregate: 'zero', as: 'zero_count' },
    { ...f.lookup, aggregate: 'sum', as: 'sum_signal' }
  ] });
  const row = result.rows[0];
  assert.deepEqual([row.source_count, row.measured_count, row.entity_count, row.observed_entities, row.missing_count, row.zero_count], [5, 2, 3, 1, 2, 1]);
  assert.equal(row.sum_signal, 2);
  assert.equal(result.rows[1].sum_signal, null);
  assert.equal(result.rows[3].source_count, 0);
  assert.equal(result.rows[3].sum_signal, null);
  assert.equal(f.reads(), 1);
});

test('ranking and grouped top selection include exact boundary ties and retain unranked inputs', async () => {
  const rows = [{ group: 'g', id: 'a', value: 9 }, { group: 'g', id: 'b', value: 0 }, { group: 'g', id: 'c', value: 0 }, { group: 'g', id: 'd', value: null }, { group: 'h', id: 'e', value: 'NA' }];
  assert.deepEqual(rank(rows, 'value', 'desc', 2).map(row => [row.id, row.rank]), [['a', 1], ['b', 2], ['c', 2]]);
  assert.deepEqual(rank(rows, 'value', 'desc', 2, 'truncate').map(row => row.id), ['a', 'b']);
  assert.deepEqual(rank(rows, 'value').map(row => row.rank), [1, 2, 2, null, null]);
  const args = { group_by: 'group', by: 'value', n: 2 };
  const grouped = topPerGroup(rows, args);
  assert.deepEqual(grouped.map(row => [row.id, row.rank]), [['a', 1], ['b', 2], ['c', 2], ['e', null]]);
  assert.deepEqual(await topPerGroupStream((async function* () { yield* rows; })(), args, columnsOf(rows)), grouped);
  assert.throws(() => rank(rows, 'value', 'desc', -1), /nonnegative/);
  assert.throws(() => topPerGroup(rows, { ...args, n: 1.5 }), /positive integer/);
});

test('bulk rows retain all tied maxima without a second query or a per-input limit', async () => {
  const f = cohort(Array.from({ length: 257 }, (_, index) => ({ target: 'ALPHA', category: `category ${index}`, replicate: 1, signal: 0 })));
  const result = await createBulkTools(f).applyBulk({ name: 'top', lookups: [{ table: 'assays.tsv', match_column: 'target', mode: 'rows', columns: ['category', 'signal'], top_by: 'signal', top: 1 }] });
  assert.equal(result.rows.filter(row => row.gene === 'ALPHA').length, 257);
  assert.equal(result.rows.length, 261);
  assert.ok(result.rows.filter(row => row.gene === 'ALPHA').every(row => row.rank === 1));
});

test('declared and late columns survive empty filters, joins, selection and computation', () => {
  const rows = withColumns([...Array.from({ length: 205 }, (_, index) => ({ gene: `G${index}`, value: index })), { gene: 'LATE', value: 7, annotation: 'present' }], ['gene', 'value', 'unrecorded']);
  assert.deepEqual(columnsOf(rows), ['gene', 'value', 'unrecorded', 'annotation']);
  const none = applyWhere(rows, [{ column: 'annotation', op: '=', value: 'absent' }]);
  assert.deepEqual(columnsOf(none), columnsOf(rows));
  assert.deepEqual(columnsOf(select(none, ['unrecorded', 'annotation'])), ['unrecorded', 'annotation', 'gene']);
  assert.deepEqual(columnsOf(compute(none, 'comparison', 'value / 2')), [...columnsOf(rows), 'comparison']);
  assert.deepEqual(columnsOf(rank(none, 'value')), [...columnsOf(rows), 'rank']);
  const right = withColumns([], ['gene', 'measurement']);
  const joined = join([{ gene: 'A' }], right, 'left');
  assert.deepEqual(joined, [{ gene: 'A', measurement: null }]);
  assert.deepEqual(columnsOf(setOp('difference', right, [{ gene: 'A' }])), ['gene', 'measurement']);
  assert.throws(() => applyWhere(none, [{ column: 'nonexistent', op: '=', value: 1 }]), /no column/);
});

test('streaming and materialized aggregates share missingness and all-missing sum semantics', async () => {
  const rows = [{ group: 'empty', v: null }, { group: 'empty', v: 'NA' }, { group: 'mixed', v: 'category' }, { group: 'mixed', v: 0 }, { group: 'mixed', v: 2 }];
  const args = { group_by: 'group', column: 'v', metrics: ['count', 'numeric_count', 'zero', 'missing', 'distinct', 'sum', 'mean'] };
  const expected = [
    { group: 'empty', count: 2, numeric_count: 0, zero: 0, missing: 2, distinct: 0, sum: null, mean: null },
    { group: 'mixed', count: 3, numeric_count: 2, zero: 1, missing: 0, distinct: 3, sum: 2, mean: 1 }
  ];
  assert.deepEqual(aggregate(rows, args), expected);
  assert.deepEqual(await aggregateStream((async function* () { yield* rows; })(), args, columnsOf(rows)), expected);
  assert.deepEqual(aggregate(withColumns([], ['v']), { column: 'v', metrics: ['count', 'numeric_count', 'sum'] }), [{ count: 0, numeric_count: 0, sum: null }]);
});

test('raw indexed reads match streaming reads across order, EOF, CRLF, UTF8 and quoted fields', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-raw-fidelity-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const realFs = require('node:fs');
  const { LocalData: ChunkedData } = await load('../../src/hpa/localData', { 'node:fs': { ...realFs, createReadStream(file, options = {}) { return realFs.createReadStream(file, { ...options, highWaterMark: 3 }); } } });
  const reader = new ChunkedData(); reader.root = directory;
  const lines = ['"A"\t"label\twith tab"\t0', 'B\tplain\t2', '"A"\t"a ""quote"""\t3', 'Å\tunicode\t4'];
  let index = 0;
  for (const ending of ['\n', '\r\n']) for (const terminal of ['', ending]) for (const order of [lines, [...lines].reverse(), [lines[0], lines[2], lines[1], lines[3]]]) {
    const name = `records-${index++}.tsv`;
    await fs.writeFile(path.join(directory, name), ['\uFEFFid\tlabel\tvalue', ...order].join(ending) + terminal);
    reader.registry.set(name, {});
    const streamed = [];
    for await (const row of reader.rows(name)) streamed.push(row);
    for (const id of ['A', 'B', 'Å', 'ABSENT']) assert.deepEqual(await reader.geneRows(name, id), streamed.filter(row => row.id === id));
  }
  await fs.writeFile(path.join(directory, 'empty.tsv'), 'id\tvalue'); reader.registry.set('empty.tsv', {});
  assert.deepEqual((await reader.table('empty.tsv')).header, ['id', 'value']);
  assert.deepEqual(columnsOf(await reader.geneRows('empty.tsv', 'A')), ['id', 'value']);
});

test('adapter reads complete wide headers, streams later gene keys and retains blank master evidence', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-adapter-fidelity-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const extra = Array.from({ length: 2200 }, (_, i) => `sample_column_${i}`);
  const names = ['wide.tsv', 'later.tsv', 'proteinatlas.tsv'];
  await fs.writeFile(path.join(directory, names[0]), ['Gene', ...extra].join('\t') + '\n' + ['ENSG00000000001', ...extra.map(() => '0')].join('\t') + '\n');
  await fs.writeFile(path.join(directory, names[1]), 'sample\tGene\tvalue\na\tENSG00000000001\t2\nb\tENSG00000000002\t4\na\tENSG00000000001\t6');
  await fs.writeFile(path.join(directory, names[2]), 'Gene\tEnsembl\tLocation\nALPHA\tENSG00000000001\t\n');
  const reader = new LocalData(); reader.root = directory;
  names.forEach(name => reader.registry.set(name, { localPath: name, unpackedBytes: 4e9 }));
  reader.refreshRegistry = async () => reader.registry;
  const adapter = await load('../../src/hpa/geneDataAdapter', { './localData': { localData: reader, FILES: { master: 'proteinatlas.tsv' }, parseHeader, parseCells } });
  assert.equal((await adapter.entry('wide.tsv')).columns.length, 2201);
  assert.equal((await adapter.entry('wide.tsv')).key, 'ensembl');
  assert.equal((await adapter.entry('later.tsv')).key, 'scan');
  const genes = [{ gene: 'ALPHA', ensembl: 'ENSG00000000001' }, { gene: 'BETA', ensembl: 'ENSG00000000002' }];
  const originalTable = reader.table.bind(reader);
  reader.table = async file => { assert.equal(file, 'proteinatlas.tsv', 'later gene keys must stream instead of materializing source'); return originalTable(file); };
  const result = await adapter.readMany(genes, 'later.tsv');
  assert.deepEqual(result.byGene.get(genes[0].ensembl).map(row => row.value), ['2', '6']);
  const master = await adapter.read(genes[0], 'proteinatlas.tsv');
  assert.equal(master.rows[0].Location, '');
  assert.equal(adapter.cited(master, 'invented evidence'), false);
  assert.equal(adapter.cited(master, 'Gene: ALPHA'), false, 'unshown rows are not citation evidence');
  assert.match(adapter.render(master).text, /Location: \[not recorded\]/);
  assert.equal(adapter.cited(master, 'Gene: ALPHA'), true);
  assert.throws(() => adapter.applyWhere(master, [{ column: 'misspelled', op: '=', value: 1 }]), /no column/);
  const absent = adapter.applyWhere(master, [{ column: 'Gene', op: '=', value: 'BETA' }]);
  assert.equal(absent.reading.rows.length, 0);
});

test('stored derived values keep precision needed for thresholds and ranking', () => {
  const rows = compute([{ gene: 'A', n: 1000001, d: 1000000 }, { gene: 'B', n: 1000004, d: 1000000 }], 'ratio', 'n / d');
  assert.deepEqual(rank(rows, 'ratio').map(row => row.gene), ['B', 'A']);
  assert.deepEqual(applyWhere(rows, [{ column: 'ratio', op: '>', value: 1.000002 }]).map(row => row.gene), ['B']);
  assert.equal(rows[0].ratio, 1.000001);
});

test('source views use explicit pages and citations cannot borrow an unseen row or another row value', () => {
  const adapter = require('../../src/hpa/geneDataAdapter');
  const reading = { entry: { file: 'evidence.tsv', columns: ['Gene', 'category', 'value'] }, rows: [{ Gene: 'A', category: 'first', value: 0 }, { Gene: 'A', category: 'second', value: 7 }] };
  const page = adapter.render(reading, [], { rows: 1 });
  assert.equal(page.complete, false); assert.equal(page.next_offset, 1);
  assert.equal(adapter.cited(reading, 'first | 0', 0), true);
  assert.equal(adapter.cited(reading, 'first | 0', 7), false);
  assert.equal(adapter.cited(reading, 'second | 7', 7), false);
  assert.equal(adapter.cited(reading, 'first'), false);
  assert.equal(adapter.render(reading, ['not present']).shown, 0);
  assert.equal(adapter.cited(reading, 'first | 0'), false);
  const complete = adapter.render(reading);
  assert.equal(complete.shown, 2); assert.equal(complete.complete, true);
  assert.equal(adapter.cited(reading, 'second | 7', 7), true);
});

test('grouping preserves distinct null, empty, numeric and text labels', () => {
  const rows = [{ label: null }, { label: '' }, { label: 0 }, { label: '0' }];
  assert.deepEqual(aggregate(rows, { group_by: 'label', metrics: ['count'] }), rows.map(row => ({ ...row, count: 1 })));
});

test('table output collisions fail explicitly instead of replacing earlier evidence', async () => {
  assert.throws(() => join([{ gene: 'A', value: 1, value_2: 2 }], [{ gene: 'A', value: 3 }]), /column collision/);
  assert.throws(() => select([{ gene: 'A', value: 1, other: 2 }], ['value', 'other'], { value: 'same', other: 'same' }), /distinct/);
  assert.throws(() => select([{ gene: 'A', value: 1 }], ['value'], { value: 'gene' }), /gene identifiers/);
  const f = cohort([{ target: 'ALPHA', category: 'x', signal: 3 }]);
  const inputRows = f.supplied.map(gene => ({ gene, signal: 7 }));
  await assert.rejects(() => createBulkTools({ ...f, inputRows }).applyBulk({ name: 'raw', lookups: [{ table: 'assays.tsv', match_column: 'target', mode: 'rows', columns: ['category', 'signal'] }] }), /conflicts with an input value/);
});


test('compute never turns structured records into fabricated text or numeric measurements', () => {
  const data = [{ gene: 'EXAMPLE', labels: [{ category: 'recorded', score: 2 }], values: [2] }];
  assert.throws(() => compute(data, 'copied', 'labels'), /structured values.*select/);
  assert.throws(() => compute(data, 'doubled', 'values * 2'), /structured values.*select/);
  const selected = select(data, ['gene', 'labels'], { labels: 'recorded_labels' });
  assert.deepEqual(selected[0].recorded_labels, [{ category: 'recorded', score: 2 }]);
  assert.deepEqual(data[0].values, [2]);
});
