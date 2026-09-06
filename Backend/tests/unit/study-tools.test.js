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
  assert.deepEqual(out.naming, { renamed: { nTPM: 'nTPM_3', nTPM_2: 'nTPM_2_2' }, shared: [], unkeyed: { a: 0, b: 0 } });
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
  assert.deepEqual(out.naming, { renamed: { Tissue: 'Tissue_2', nTPM: 'nTPM_2' }, shared: ['Gene', 'source_status'], unkeyed: { a: 0, b: 0 } });
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
  assert.throws(() => tools.compute(ranked, 'flag', 'rank > 0'), /a comparison goes inside if\(condition, then, else\)/);
  assert.throws(() => tools.compute(ranked, 'flag', 'if(rank > 0, gene)'), /if takes a condition, a then value and an else value/);
});

test('an in list may be an array, a JSON list, or values separated by | or commas', () => {
  assert.deepEqual(tools.inList(['a', 'b']), ['a', 'b']);
  assert.deepEqual(tools.inList('["a", "b"]'), ['a', 'b']);
  assert.deepEqual(tools.inList('a | b, c'), ['a', 'b', 'c']);
  assert.equal(tools.applyWhere(rows, [{ column: 'partner', op: 'in', value: 'ENSG_MDM2, ENSG_X' }]).length, 1);
});
