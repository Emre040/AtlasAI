'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const desk = require('../../src/system/aso/desk');

test('a table card lists every column with the values it takes and sample rows', () => {
  const card = desk.tableCard({ name: 't.tsv', title: 'Table', description: 'desc', access: 'rows per gene', columns: ['Gene', 'Tissue', 'nTPM'], scanned: 6, capped: false,
    profile: [{ column: 'Tissue', kind: 'text', blank_pct: 0, distinct: '3', observed_values: ['liver', 'lung', 'heart'] }, { column: 'nTPM', kind: 'number', blank_pct: 17, distinct: '5', min: 0, max: 34.1 }],
    sample: [{ Gene: 'ENSG1', Tissue: 'liver', nTPM: '32.2' }] });
  assert.match(card, /t\.tsv — Table\. desc \[rows per gene\]; 3 columns \(values from 6 rows\)/);
  assert.match(card, /Tissue: 3 values: liver \| lung \| heart/);
  assert.match(card, /nTPM: number 0 to 34\.1; 17% blank; 5 distinct/);
  assert.match(card, /  Gene\n/, 'a column without a profile is still listed');
  assert.match(card, /rows: ENSG1 \| liver \| 32\.2/);
});

test('a small result is shown whole with row indices, a large one with two rows; figures and matrices say what they are', () => {
  const rows = [{ gene: 'EGFR', nTPM: 32.2 }, { gene: 'ERBB2', nTPM: 30.7 }, { gene: 'MET', nTPM: null }];
  const card = desk.resultCard({ id: 'a1', label: '', origin: 'investigator_hpa t1 "liver nTPM"', rows, columns: ['gene', 'nTPM'] });
  assert.match(card, /^a1 \(3 rows\) ← investigator_hpa t1 "liver nTPM": gene, nTPM\n  0: EGFR \| 32\.2\n  1: ERBB2 \| 30\.7\n  2: MET \| $/);
  const big = desk.resultCard({ id: 'a5', origin: 'filter of a1', rows: Array.from({ length: 70 }, (_, i) => ({ gene: `G${i}`, nTPM: i / 3 })), columns: ['gene', 'nTPM'] });
  assert.match(big, /^a5 \(70 rows\) ← filter of a1: gene, nTPM\n  G0 \| 0\n  G1 \| 0\.333333\n  … 68 more rows \(open a5 to see them\)$/, 'numbers display with six significant digits');
  assert.match(desk.resultCard({ id: 'a6', origin: 'x', rows: [{ gene: 'A', v: 1 }], columns: ['gene', 'v'], folded: ['a7', 'a8'] }), /^a6 \(1 rows\) ← x: gene, v \[used by a7, a8; open a6 for its rows\]$/);
  assert.match(desk.resultCard({ id: 'a2', origin: 'chart(x=gene)', rows: [], columns: [], figure: { type: 'bar', title: 'T' }, images: ['a2.png'] }), /^a2 figure bar "T" ← chart\(x=gene\) \(rendered\)$/);
  assert.match(desk.resultCard({ id: 'a3', origin: 'pivot of a1', rows: [], columns: [], matrix: { row_labels: ['EGFR'], col_labels: ['liver', 'lung'], matrix: [[1, null]] } }), /^a3 matrix 1 × 2 ← pivot of a1 \(a heatmap input; not a row table\)\n   \| liver \| lung\n  EGFR \| 1 \| $/);
});

test('a table opened for particular columns details those and names the rest', () => {
  const card = desk.tableCard({ name: 'wide.tsv', title: 'Wide', columns: ['Gene', 'Tissue', 'nTPM', 'Note'], scanned: 6, focus: ['nTPM', 'Tissue'],
    profile: [{ column: 'Tissue', kind: 'text', blank_pct: 0, distinct: '3', observed_values: ['liver', 'lung', 'heart'] }, { column: 'nTPM', kind: 'number', blank_pct: 0, distinct: '5', min: 0, max: 34.1 }, { column: 'Note', kind: 'text', distinct: '6', observed_values: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    sample: [{ Gene: 'ENSG1', Tissue: 'liver', nTPM: '32.2', Note: 'a' }] });
  assert.match(card, /^wide\.tsv — Wide; 4 columns \(values from 6 rows\)\n  columns: Gene \| Tissue \| nTPM \| Note\n  Tissue: 3 values: liver \| lung \| heart\n  nTPM: number 0 to 34\.1; 5 distinct\n  rows \(Tissue \| nTPM\): liver \| 32\.2$/);
  assert.doesNotMatch(card, /Note: 6 values/, 'a column not asked for is named, not detailed');
});

test('a wide table opened whole shows a few values per column, and every value for the columns asked for', () => {
  const columns = Array.from({ length: 30 }, (_, i) => `c${i}`);
  const values = Array.from({ length: 20 }, (_, i) => `v${i}`);
  const profile = columns.map(c => ({ column: c, kind: 'text', distinct: '20', observed_values: values, examples: values.slice(0, 6), full_examples: values.slice(0, 6) }));
  const whole = desk.tableCard({ name: 'w.tsv', title: 'Wide', columns, profile, sample: [], focus: ['c7'], whole: true });
  assert.match(whole, /30 columns \(wide: a few values per column; open it with columns for every value of a column\)\n  c0: text, 20 distinct \(e\.g\. v0 \| v1 \| v2\)\n/);
  assert.match(whole, /\n  c7: 20 values: v0 \| v1 \| v2 \| v3 \| v4 \| v5 \| v6 \| v7 \| v8 \| v9 \| v10 \| v11 \| v12 \| v13 \| v14 \| v15 \| v16 \| v17 \| v18 \| v19\n  c8: text, 20 distinct/);
  const narrow = desk.tableCard({ name: 'n.tsv', title: 'Narrow', columns: columns.slice(0, 3), profile: profile.slice(0, 3), sample: [], whole: true });
  assert.match(narrow, /\n  c0: 20 values: v0 \| v1/, 'a narrow table lists every value of every column');
});

test('a result card shows the entity keys and the columns its operation named first', () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ gene: `G${i}`, ensembl: `E${i}`, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, Score: i, Tissue: 'liver' }));
  const columns = ['gene', 'ensembl', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'Score', 'Tissue'];
  const card = desk.resultCard({ id: 'a9', origin: 'filter of x', rows, columns, first: ['gene', 'ensembl', 'Tissue', 'Score'], profile: [{ column: 'Score', kind: 'number', min: 0, max: 69, distinct: '70' }, { column: 'a', kind: 'number', min: 1, max: 1, distinct: '1' }] });
  assert.match(card, /\n  Score: number 0 to 69; 70 distinct\n  a: number 1; 1 distinct\n  G0 \| E0 \| liver \| 0 \| 1 \| 2 \| 3 \| 4 \| … \+3 columns\n/);
  assert.match(card, /^a9 \(70 rows\) ← filter of x: gene, ensembl, a, b, c, d, e, f, g, Score, Tissue\n/, 'the header keeps the real column order');
});

test('history keeps recent lines whole and folds only the oldest', () => {
  const lines = Array.from({ length: 45 }, (_, i) => `turn ${i + 1}: step`);
  const text = desk.historyText(lines);
  assert.match(text, /^\(5 earlier steps\)\nturn 6: step/);
  assert.match(text, /turn 45: step$/);
  assert.equal(desk.historyText([]), '(nothing yet)');
});

test('arguments are cut only between arguments, never inside a value', () => {
  const line = desk.argsLine({ artifact: 'a1', as: 'pancreas_nTPM_ratio_over_liver', where: [{ column: 'Tissue', op: '=', value: 'liver' }] }, 60);
  assert.match(line, /as=pancreas_nTPM_ratio_over_liver/);
  assert.match(line, /, …$/);
});
