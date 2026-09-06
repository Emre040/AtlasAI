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
  const big = desk.resultCard({ id: 'a5', origin: 'filter of a1', rows: Array.from({ length: 30 }, (_, i) => ({ gene: `G${i}`, nTPM: i })), columns: ['gene', 'nTPM'] });
  assert.match(big, /^a5 \(30 rows\) ← filter of a1: gene, nTPM\n  G0 \| 0\n  G1 \| 1\n  … 28 more rows \(open a5 to see them\)$/);
  assert.match(desk.resultCard({ id: 'a2', origin: 'chart(x=gene)', rows: [], columns: [], figure: { type: 'bar', title: 'T' }, images: ['a2.png'] }), /^a2 figure bar "T" ← chart\(x=gene\) \(rendered\)$/);
  assert.match(desk.resultCard({ id: 'a3', origin: 'pivot of a1', rows: [], columns: [], matrix: { row_labels: ['EGFR'], col_labels: ['liver', 'lung'], matrix: [[1, null]] } }), /^a3 matrix 1 × 2 ← pivot of a1 \(a heatmap input; not a row table\)\n   \| liver \| lung\n  EGFR \| 1 \| $/);
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
