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

test('a result is one line: id, title, size, columns, origin, then its description; a few rows show whole', () => {
  const rows = [{ gene: 'EGFR', nTPM: 32.2 }, { gene: 'ERBB2', nTPM: 30.7 }, { gene: 'MET', nTPM: null }];
  const line = desk.resultLine({ id: 'a1', title: 'Liver nTPM', description: 'Consensus liver nTPM of the three genes', origin: 'investigator_hpa t1 "liver nTPM"', rows, columns: ['gene', 'nTPM'] });
  assert.equal(line, 'a1 "Liver nTPM" (3 rows: gene, nTPM) ← investigator_hpa t1 "liver nTPM"\n  Consensus liver nTPM of the three genes\n  0: EGFR | 32.2\n  1: ERBB2 | 30.7\n  2: MET | ');
  const big = desk.resultLine({ id: 'a5', title: 'All', description: 'Every gene', origin: 'filter of a1', rows: Array.from({ length: 70 }, (_, i) => ({ gene: `G${i}`, nTPM: i / 3 })), columns: ['gene', 'nTPM'] });
  assert.equal(big, 'a5 "All" (70 rows: gene, nTPM) ← filter of a1\n  Every gene', 'a larger result shows no rows until opened');
  assert.match(desk.resultLine({ id: 'a2', title: 'T', origin: 'chart(x=gene)', rows: [], columns: [], figure: { type: 'bar', title: 'T' }, images: ['a2.png'] }), /^a2 "T" figure bar ← chart\(x=gene\) \(rendered\)$/);
  assert.match(desk.resultLine({ id: 'a3', title: 'Heat', origin: 'pivot of a1', rows: [], columns: [], matrix: { row_labels: ['EGFR'], col_labels: ['liver', 'lung'], matrix: [[1, null]] } }), /^a3 "Heat" matrix 1 × 2 \(rows: EGFR; columns: liver, lung\) ← pivot of a1; a heatmap input$/);
  const wide = desk.resultLine({ id: 'a9', title: 'Wide', origin: 'x', rows: Array.from({ length: 12 }, () => ({})), columns: Array.from({ length: 30 }, (_, i) => `c${i}`) });
  assert.match(wide, /^a9 "Wide" \(12 rows: c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, … \+18 more columns\) ← x$/);
});

test('a table opened for particular columns details those and names the rest', () => {
  const card = desk.tableCard({ name: 'wide.tsv', title: 'Wide', columns: ['Gene', 'Tissue', 'nTPM', 'Note'], scanned: 6, focus: ['nTPM', 'Tissue'],
    profile: [{ column: 'Tissue', kind: 'text', blank_pct: 0, distinct: '3', observed_values: ['liver', 'lung', 'heart'] }, { column: 'nTPM', kind: 'number', blank_pct: 0, distinct: '5', min: 0, max: 34.1 }, { column: 'Note', kind: 'text', distinct: '6', observed_values: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    sample: [{ Gene: 'ENSG1', Tissue: 'liver', nTPM: '32.2', Note: 'a' }] });
  assert.match(card, /^wide\.tsv — Wide; 4 columns \(values from 6 rows\)\n  columns: Gene, Tissue, nTPM, Note\n  Tissue: 3 values: liver \| lung \| heart\n  nTPM: number 0 to 34\.1; 5 distinct\n  rows \(Tissue \| nTPM\): liver \| 32\.2$/);
  assert.doesNotMatch(card, /Note: 6 values/, 'a column not asked for is named, not detailed');
  const names = desk.tableCard({ name: 'wide.tsv', title: 'Wide', columns: ['Gene', 'Tissue'], focus: [], whole: false });
  assert.equal(names, 'wide.tsv — Wide; 2 columns\n  columns: Gene, Tissue', 'opened without values, a table is its column names');
  const many = desk.tableCard({ name: 'm.tsv', title: 'Many', columns: Array.from({ length: 119 }, (_, i) => `c${i}`), focus: [], whole: false });
  assert.equal(many, 'm.tsv — Many; 119 columns\n  columns: c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, … +107 more columns', 'a wide table names its first columns; the rest are found by a word');
});

test('a wide table opened whole shows what each column holds, and every value for the columns asked for', () => {
  const columns = Array.from({ length: 30 }, (_, i) => `c${i}`);
  const values = Array.from({ length: 20 }, (_, i) => `v${i}`);
  const profile = columns.map(c => ({ column: c, kind: 'text', distinct: '20', observed_values: values, examples: values.slice(0, 6), full_examples: values.slice(0, 6) }));
  const whole = desk.tableCard({ name: 'w.tsv', title: 'Wide', columns, profile, sample: [], focus: ['c7'], whole: true });
  assert.match(whole, /30 columns \(wide: what each column holds; open it with columns for the values of a column\)\n  c0: text, 20 distinct\n/);
  assert.match(whole, /\n  c7: 20 values: v0 \| v1 \| v2 \| v3 \| v4 \| v5 \| v6 \| v7 \| v8 \| v9 \| v10 \| v11 \| v12 \| v13 \| v14 \| v15 \| v16 \| v17 \| v18 \| v19\n  c8: text, 20 distinct/);
  const narrow = desk.tableCard({ name: 'n.tsv', title: 'Narrow', columns: columns.slice(0, 3), profile: profile.slice(0, 3), sample: [], whole: true });
  assert.match(narrow, /\n  c0: 20 values: v0 \| v1/, 'a narrow table lists every value of every column');
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
