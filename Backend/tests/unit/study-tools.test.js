'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../../src/system/aso/studyTools');

const rows = tools.withColumns([
  { gene: 'TP53', ensembl: 'ENSG_TP53', partner: 'ENSG_MDM2', score: 0.9 },
  { gene: 'TP53', ensembl: 'ENSG_TP53', partner: 'ENSG_EP300', score: 0.4 }
], ['gene', 'ensembl', 'partner', 'score']);

test('renaming a column onto an entity key re-keys the table and drops the old keys', () => {
  const out = tools.select(rows, ['partner', 'score'], { partner: 'ensembl' });
  assert.deepEqual(tools.columnsOf(out), ['ensembl', 'score']);
  assert.deepEqual(out.map(r => r.ensembl), ['ENSG_MDM2', 'ENSG_EP300']);
  assert.throws(() => tools.select(rows, ['partner', 'gene'], { partner: 'ensembl' }), /renaming onto ensembl re-keys the table, so gene would name a different entity; leave it out or rename it/);
  const kept = tools.select(rows, ['partner', 'gene'], { partner: 'ensembl', gene: 'bait' });
  assert.deepEqual(tools.columnsOf(kept), ['ensembl', 'bait']);
  assert.deepEqual(tools.columnsOf(tools.select(rows, ['score'])), ['score', 'gene', 'ensembl'], 'without re-keying the entity keys are kept');
});

test('a typed label is words: a number in it is refused by select and classify alike', () => {
  assert.throws(() => tools.select(rows, ['score'], {}, { half_life: '~19-21 days' }), /select: add\.half_life="~19-21 days" holds a number; a label is words/);
  assert.throws(() => tools.select(rows, ['score'], {}, { n: 5 }), /holds a number/);
  assert.equal(tools.select(rows, ['score'], {}, { source: 'consensus' })[0].source, 'consensus');
  assert.equal(tools.select(rows, ['score'], {}, { target: 'BRCA1' })[0].target, 'BRCA1', 'digits inside a name are not a number');
  assert.throws(() => tools.classify(rows, { name: 'tier', rules: [{ where: [{ column: 'score', op: '>', value: 0.5 }], value: 'above 0.5' }], otherwise: 'rest' }), /classify: rule 1 value="above 0\.5" holds a number/);
  assert.throws(() => tools.classify(rows, { name: 'tier', rules: [], otherwise: 0 }), /classify: otherwise=0 holds a number/);
  assert.deepEqual(tools.classify(rows, { name: 'tier', rules: [{ where: [{ column: 'score', op: '>', value: 0.5 }], value: 'strong' }], otherwise: 'weak' }).map(r => r.tier), ['strong', 'weak']);
});

test('a cross join puts two results side by side, row by row', () => {
  const total = tools.withColumns([{ count: 62 }], ['count']);
  const part = tools.withColumns([{ count: 5 }], ['count']);
  const out = tools.join(total, part, 'cross');
  assert.deepEqual(tools.columnsOf(out), ['count', 'count_2']);
  assert.deepEqual(out, [{ count: 62, count_2: 5 }]);
  assert.equal(tools.join(tools.withColumns([{ a: 1 }, { a: 2 }], ['a']), tools.withColumns([{ b: 'x' }, { b: 'y' }], ['b']), 'cross').length, 4);
});

test('a column b brings whose name is taken gets the first free numbered suffix, in any join', () => {
  const left = tools.withColumns([{ gene: 'TP53', ensembl: 'ENSG_TP53', nTPM: 1, nTPM_2: 2 }], ['gene', 'ensembl', 'nTPM', 'nTPM_2']);
  const right = tools.withColumns([{ gene: 'TP53', ensembl: 'ENSG_TP53', nTPM: 3, nTPM_2: 4 }], ['gene', 'ensembl', 'nTPM', 'nTPM_2']);
  const out = tools.join(left, right, 'inner');
  assert.deepEqual(tools.columnsOf(out), ['gene', 'ensembl', 'nTPM', 'nTPM_2', 'nTPM_3', 'nTPM_2_2']);
  assert.deepEqual(out, [{ gene: 'TP53', ensembl: 'ENSG_TP53', nTPM: 1, nTPM_2: 2, nTPM_3: 3, nTPM_2_2: 4 }]);
  assert.deepEqual(out.naming, { renamed: { nTPM: 'nTPM_3', nTPM_2: 'nTPM_2_2' }, shared: [], unkeyed: { a: 0, b: 0 }, matched: { a: 1, b: 1, rows_a: 1, rows_b: 1 } });
});

test('a column both sides carry that agrees on every matched row is kept once; one that differs comes from b with a suffix', () => {
  const heart = tools.withColumns([
    { gene: 'TP53', ensembl: 'ENSG_TP53', Gene: 'TP53', Tissue: 'heart muscle', nTPM: '12.0', source_status: 'ok' },
    { gene: 'BRCA1', ensembl: 'ENSG_BRCA1', Gene: 'BRCA1', Tissue: 'heart muscle', nTPM: '3.5', source_status: 'ok' }
  ], ['gene', 'ensembl', 'Gene', 'Tissue', 'nTPM', 'source_status']);
  const skeletal = tools.withColumns([
    { gene: 'TP53', ensembl: 'ENSG_TP53', Gene: 'TP53', Tissue: 'skeletal muscle', nTPM: '1.0', source_status: 'ok' },
    { gene: 'MDM2', ensembl: 'ENSG_MDM2', Gene: 'MDM2', Tissue: 'skeletal muscle', nTPM: '2.0', source_status: 'ok' }
  ], ['gene', 'ensembl', 'Gene', 'Tissue', 'nTPM', 'source_status']);
  const out = tools.join(heart, skeletal, 'inner');
  assert.deepEqual(tools.columnsOf(out), ['gene', 'ensembl', 'Gene', 'Tissue', 'nTPM', 'source_status', 'Tissue_2', 'nTPM_2']);
  assert.deepEqual(out, [{ gene: 'TP53', ensembl: 'ENSG_TP53', Gene: 'TP53', Tissue: 'heart muscle', nTPM: '12.0', source_status: 'ok', Tissue_2: 'skeletal muscle', nTPM_2: '1.0' }]);
  assert.deepEqual(out.naming, { renamed: { Tissue: 'Tissue_2', nTPM: 'nTPM_2' }, shared: ['Gene', 'source_status'], unkeyed: { a: 0, b: 0 }, matched: { a: 1, b: 1, rows_a: 2, rows_b: 2 } }, 'one gene of each side found a partner');
  assert.deepEqual(tools.join(heart, tools.withColumns([{ gene: 'MDM2', ensembl: 'ENSG_MDM2', nTPM: '2.0' }], ['gene', 'ensembl', 'nTPM']), 'inner').naming.matched, { a: 0, b: 0, rows_a: 2, rows_b: 1 }, 'an empty intersection counts no matches on either side');
  // A full join keeps b's own rows, with the shared columns filled from b.
  const full = tools.join(heart, skeletal, 'full');
  assert.deepEqual(full.find(r => r.gene === 'MDM2'), { gene: 'MDM2', ensembl: 'ENSG_MDM2', Gene: 'MDM2', Tissue: null, nTPM: null, source_status: 'ok', Tissue_2: 'skeletal muscle', nTPM_2: '2.0' });
});

test('a row without a key value matches nothing and is counted; a side without the key column is refused', () => {
  const left = tools.withColumns([{ gene: 'TP53', ensembl: 'ENSG_TP53', score: 1 }], ['gene', 'ensembl', 'score']);
  const right = tools.withColumns([{ gene: 'TP53', ensembl: 'ENSG_TP53', location: 'Nucleus' }, { gene: null, ensembl: 'ENSG_NOVEL', location: 'Cytosol' }], ['gene', 'ensembl', 'location']);
  const out = tools.join(left, right, 'inner', 'gene');
  assert.equal(out.length, 1);
  assert.deepEqual(out.naming.unkeyed, { a: 0, b: 1 });
  assert.throws(() => tools.join(left, tools.withColumns([{ location: 'x' }], ['location']), 'inner', 'gene'), /join: no column "gene" on right \(columns: location\)/);
  assert.throws(() => tools.join(left, tools.withColumns([{ location: 'x' }], ['location']), 'inner'), /join: no gene or ensembl column to match on \(columns: location; use concat/);
  assert.throws(() => tools.join(left, tools.withColumns([{ gene: null, location: 'x' }], ['gene', 'location']), 'inner', 'gene'), /join: no row has a "gene" value to match on/);
});

test('a profile lists the keys or labels inside structured cells', () => {
  const cells = [
    { spec: 'liver: 12.5;kidney: 3.0', prog: 'potential prognostic favorable (1.5e-4)' },
    { spec: 'testis: 900.1', prog: 'unprognostic (1.1e-1)' },
    { spec: 'liver: 2.0;brain: 4.4', prog: 'validated prognostic unfavorable (2.0e-6)' }
  ];
  const [spec, prog] = tools.profile(cells, ['spec', 'prog']);
  assert.deepEqual(spec.parts, { kind: 'keys', values: ['liver', 'kidney', 'testis', 'brain'] });
  assert.deepEqual(prog.parts, { kind: 'labels', values: ['potential prognostic favorable', 'unprognostic', 'validated prognostic unfavorable'] });
});

test('compute chooses per row with if(condition, then, else); a condition that cannot be decided takes the else branch', () => {
  const ranked = tools.withColumns([
    { gene: 'TP53', rank: 1, Tissue: 'liver', nTPM: 12 },
    { gene: 'MDM2', rank: null, Tissue: 'lung', nTPM: 0.5 },
    { gene: 'EP300', rank: 3, Tissue: 'liver', nTPM: 'x' }
  ], ['gene', 'rank', 'Tissue', 'nTPM']);
  assert.deepEqual(tools.compute(ranked, 'label', 'if(rank > 0, gene, "")').map(r => r.label), ['TP53', '', 'EP300']);
  assert.deepEqual(tools.compute(ranked, 'liver', 'if(Tissue = "liver", nTPM, 0)').map(r => r.liver), [12, 0, 'x'], 'the chosen branch is evaluated as usual, text passing through');
  assert.deepEqual(tools.compute(ranked, 'high', 'if(nTPM >= 1, "high", "low")').map(r => r.high), ['high', 'low', 'low']);
  assert.deepEqual(tools.compute(ranked, 'x', 'if(gene == "TP53", 1, 0)').map(r => r.x), [1, 0, 0], '== reads as =');
  assert.throws(() => tools.compute(ranked, 'flag', 'rank > 0'), /a comparison goes inside if\(condition, then, else\)/);
  assert.throws(() => tools.compute(ranked, 'flag', 'if(rank > 0, gene)'), /if takes a condition, a then value and an else value/);
});

test('rank sorts a text column alphabetically and a numeric column by value', () => {
  const genes = tools.withColumns([
    { gene: 'ABCB11', ensembl: 'E1', nTPM: '75.3' }, { gene: 'A1CF', ensembl: 'E2', nTPM: '12' }, { gene: 'a1bg', ensembl: 'E3', nTPM: null }, { gene: 'ACOX2', ensembl: 'E4', nTPM: '165.8' }
  ], ['gene', 'ensembl', 'nTPM']);
  assert.deepEqual(tools.rank(genes, 'gene', 'asc', 3).map(r => [r.gene, r.rank]), [['a1bg', 1], ['A1CF', 2], ['ABCB11', 3]], 'digits sort before letters, case does not matter');
  assert.deepEqual(tools.rank(genes, 'gene', 'desc').map(r => r.gene), ['ACOX2', 'ABCB11', 'A1CF', 'a1bg']);
  assert.deepEqual(tools.rank(genes, 'nTPM', 'desc').map(r => [r.gene, r.rank]), [['ACOX2', 1], ['ABCB11', 2], ['A1CF', 3], ['a1bg', null]], 'a numeric column still sorts by value, the row without a number last');
});

test('an in list may be an array, a JSON list, or values separated by | or commas', () => {
  assert.deepEqual(tools.inList(['a', 'b']), ['a', 'b']);
  assert.deepEqual(tools.inList('["a", "b"]'), ['a', 'b']);
  assert.deepEqual(tools.inList('a | b, c'), ['a', 'b', 'c']);
  assert.equal(tools.applyWhere(rows, [{ column: 'partner', op: 'in', value: 'ENSG_MDM2, ENSG_X' }]).length, 1);
});

test('compute flags rows with contains(column, text) inside if, and a share comes from aggregate mean', () => {
  const rows = [{ gene: 'A', 'Protein class': 'Enzymes, Transporters' }, { gene: 'B', 'Protein class': 'Transcription factors' }, { gene: 'C', 'Protein class': null }];
  const flagged = tools.compute(rows, 'is_enzyme', 'if(contains("Protein class", "enzymes"), 1, 0)');
  assert.deepEqual(flagged.map(r => r.is_enzyme), [1, 0, 0], 'case aside; a missing cell takes the else branch');
  assert.throws(() => tools.compute(rows, 'x', 'contains("Protein class", "Enzymes")'), /a comparison goes inside if/);
  assert.throws(() => tools.compute(rows, 'x', 'if(contains("Protein class"), 1, 0)'), /contains takes a column and a text/);
});

test('join takes a key the two sides name differently as left=right', () => {
  const seeds = tools.withColumns([{ gene: 'ALB', ensembl: 'ENSG1', nTPM: 5 }, { gene: 'HP', ensembl: 'ENSG2', nTPM: 3 }], ['gene', 'ensembl', 'nTPM']);
  const pairs = tools.withColumns([{ ensembl_gene_id_1: 'ENSG2', ensembl_gene_id_2: 'ENSG9', datasets: 'x' }, { ensembl_gene_id_1: 'ENSG7', ensembl_gene_id_2: 'ENSG1', datasets: 'y' }], ['ensembl_gene_id_1', 'ensembl_gene_id_2', 'datasets']);
  const joined = tools.join(seeds, pairs, 'inner', 'ensembl=ensembl_gene_id_1');
  assert.deepEqual(joined.map(r => [r.gene, r.ensembl_gene_id_2]), [['HP', 'ENSG9']]);
  assert.throws(() => tools.join(seeds, pairs, 'inner', 'ensembl'), /no column "ensembl" on right .* left=right/);
  const composite = tools.join(seeds, pairs, 'inner', null, ['ensembl=ensembl_gene_id_2']);
  assert.deepEqual(composite.map(r => [r.gene, r.datasets]), [['ALB', 'y']]);
});

test('a profile lists the items of a list column as a vocabulary, but not free text', () => {
  const cells = Array.from({ length: 30 }, (_, i) => ({ cls: ['Enzymes, Transporters', 'Transcription factors', 'Enzymes'][i % 3], syn: Array.from({ length: 10 }, (_, j) => `SYN${i}_${j}`).join(', ') }));
  const [cls, syn] = tools.profile(cells, ['cls', 'syn']);
  assert.deepEqual(cls.parts, { kind: 'items', values: ['Enzymes', 'Transcription factors', 'Transporters'] });
  assert.equal(syn.parts, null, 'three hundred distinct synonyms are not a vocabulary');
});

test('aggregate recorded counts the rows whose cell holds a value, so a left join counts matches and zeros', () => {
  const rows = tools.withColumns([{ seed: 'ALB', partner: null }, { seed: 'HP', partner: 'ENSG2' }, { seed: 'APOA1', partner: 'ENSG3' }, { seed: 'APOA1', partner: 'ENSG4' }], ['seed', 'partner']);
  const out = tools.aggregate(rows, { column: 'partner', metrics: ['count', 'recorded', 'missing'], group_by: 'seed' });
  assert.deepEqual(out.map(r => [r.seed, r.count, r.recorded, r.missing]), [['ALB', 1, 0, 1], ['HP', 1, 1, 0], ['APOA1', 2, 2, 0]]);
});
