'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reportIssues, renderReport, statedNumbers } = require('../../src/system/aso/studyReport');

const rows = [{ gene: 'EGFR', ensembl: 'ENSG1', Tissue: 'liver', nTPM: '32.2' }, { gene: 'EGFR', ensembl: 'ENSG1', Tissue: 'lung', nTPM: '14.1' }, { gene: 'MET', ensembl: 'ENSG3', Tissue: 'liver', nTPM: null }];
const a1 = { id: 'a1', kind: 'data', label: 'consensus', rows, columns: ['gene', 'ensembl', 'Tissue', 'nTPM'], tool: 'investigator_hpa', inputs: [] };
const a2 = { id: 'a2', kind: 'figure', label: 'bars', figure: { type: 'grouped_bar', title: 'Lung vs liver', data: [] }, images: ['a2.png'], columns: [], tool: 'chart', inputs: ['a1'] };
const a3 = { id: 'a3', kind: 'figure', label: 'unrendered', figure: { type: 'scatter', data: [] }, images: [], columns: [], tool: 'chart', inputs: ['a1'] };
const state = { artifacts: [a1, a2, a3], byId: new Map([['a1', a1], ['a2', a2], ['a3', a3]]), plan: [{ text: 'table', kind: 'table' }] };

test('a claim is accepted only when every number it states is among its bound cells or their counts', () => {
  assert.deepEqual(reportIssues({ claims: [{ text: 'EGFR liver is 32.2 nTPM against 14.1 in lung', artifact: 'a1', rows: [0, 1], columns: ['gene', 'Tissue', 'nTPM'] }] }, state), []);
  const wrong = reportIssues({ claims: [{ text: 'EGFR liver is 40.1 nTPM', artifact: 'a1', rows: [0], columns: ['nTPM'] }] }, state);
  assert.equal(wrong.length, 1);
  assert.match(wrong[0], /states 40\.1, not among the cells it is bound to \(a1 rows 0 columns nTPM\): 40\.1 is in no saved artifact/);
  const elsewhere = reportIssues({ claims: [{ text: 'EGFR lung is 14.1 nTPM', artifact: 'a1', rows: [0], columns: ['nTPM'] }] }, state);
  assert.match(elsewhere[0], /14\.1 is at a1 row 1 nTPM/, 'a refusal says where the number lives');
  const unnamed = { text: 'EGFR liver is 32.2 nTPM', artifact: 'a1', rows: [0], columns: ['gene', 'Tissue'] };
  assert.deepEqual(reportIssues({ claims: [unnamed] }, state), [], 'a number in a bound row but an unnamed column gets the column named by the binder');
  assert.deepEqual(unnamed.columns, ['gene', 'Tissue', 'nTPM']);
  const a4 = { id: 'a4', kind: 'data', label: 'top', rows: [{ gene: 'EGFR', rank: 1 }], columns: ['gene', 'rank'], tool: 'rank', args: { artifact: 'a1', by: 'nTPM', top: 5 }, inputs: ['a1'] };
  state.byId.set('a4', a4); state.artifacts.push(a4);
  assert.deepEqual(reportIssues({ claims: [{ text: 'EGFR is among the top 5', artifact: 'a4', rows: [0] }] }, state), [], 'a number the artifact was made with counts as bound');
  assert.deepEqual(reportIssues({ claims: [{ text: '2 of the 3 rows have a value', artifact: 'a1', rows: [0, 1], columns: ['nTPM'] }] }, state), [], 'whole numbers may be counts of bound rows or of the artifact');
  const wholeSmall = { text: 'liver is higher', artifact: 'a1', rows: [] };
  assert.deepEqual(reportIssues({ claims: [wholeSmall] }, state), [], 'a claim on a small table that names no rows rests on all of them');
  assert.deepEqual(wholeSmall.rows, [0, 1, 2]);
  // tables and figures have no numbers: a claim that says "Table 2" is told to name the artifact
  assert.match(reportIssues({ claims: [{ text: 'The ten genes are listed in Table 2.', artifact: 'a1', rows: [0], columns: ['gene'] }] }, state)[0], /says "Table 2", which names nothing: tables and figures are artifacts, name them by id \(a1\)/);
  assert.match(reportIssues({ claims: [{ text: 'x', artifact: 'a9', rows: [0] }] }, state)[0], /a9.*not a saved artifact/);
  assert.match(reportIssues({ claims: [{ text: 'x', artifact: 'a1', rows: [7] }] }, state)[0], /between 0 and 2/);
  assert.match(reportIssues({ claims: [{ text: 'x', artifact: 'a1', rows: [0], columns: ['expression'] }] }, state)[0], /no column "expression"/);
});

test('tables, figures and limitations are checked structurally', () => {
  assert.deepEqual(reportIssues({ tables: [{ artifact: 'a1', columns: ['gene', 'nTPM'] }], figures: ['a2'] }, state), []);
  assert.match(reportIssues({ tables: [{ artifact: 'a2' }] }, state)[0], /a2 is a figure, not a table/);
  assert.match(reportIssues({ figures: ['a3'] }, state)[0], /a3 was not rendered/);
  assert.match(reportIssues({ figures: ['a1'] }, state)[0], /"a1" is not a saved figure/);
  assert.match(reportIssues({ tables: [{ artifact: 'a1' }], limitations: ['3 genes had no record'] }, state)[0], /limitations\[0\] states 3, which no saved artifact holds/);
  // a number a saved artifact holds in a cell (a universe size, a threshold) may stand in a limitation
  assert.equal(reportIssues({ tables: [{ artifact: 'a1' }], limitations: ['Values above 32.2 nTPM were not checked further'] }, state).some(i => /limitations/.test(i)), false);
  assert.match(reportIssues({ tables: [{ artifact: 'a1' }], not_done: [{ item: 4, why: 'x' }] }, state)[0], /between 1 and 1/);
  assert.match(reportIssues({ figures: [] }, state)[0], /needs at least one table, figure or claim/);
});

test('a pivot matrix is a report table: row labels down the side, column labels across', () => {
  const a5 = { id: 'a5', kind: 'data', label: 'heat matrix', matrix: { matrix: [[32.2, 14.1], [null, 3]], row_labels: ['EGFR', 'MET'], col_labels: ['liver', 'lung'] }, columns: [], tool: 'pivot', inputs: ['a1'] };
  const withMatrix = { ...state, artifacts: [...state.artifacts, a5], byId: new Map([...state.byId, ['a5', a5]]) };
  assert.deepEqual(reportIssues({ tables: [{ artifact: 'a5', columns: ['lung'] }] }, withMatrix), []);
  assert.match(reportIssues({ tables: [{ artifact: 'a5', columns: ['lung', 'skin'] }] }, withMatrix)[0], /a5 has no column "skin"; its columns: liver, lung/);
  const md = renderReport({ tables: [{ artifact: 'a5', title: 'Heat' }] }, withMatrix, []);
  assert.match(md, /\*\*Heat\*\* \(a5, 2 × 2\)\n\n\|  \| liver \| lung \|\n\| --- \| --- \| --- \|\n\| EGFR \| 32\.2 \| 14\.1 \|\n\| MET \| — \| 3 \|/);
});

test('the rendered report prints tables from the data and the bound cells beside every claim', () => {
  const md = renderReport({ tables: [{ artifact: 'a1', columns: ['gene', 'Tissue', 'nTPM'], title: 'Consensus' }], claims: [{ text: 'EGFR is higher in liver (32.2) than lung (14.1).', artifact: 'a1', rows: [0, 1], columns: ['Tissue', 'nTPM'] }], limitations: ['MET has no recorded liver value.'], not_done: [{ item: 1, why: 'no source' }] }, state, [a2]);
  assert.match(md, /\*\*Consensus\*\* \(a1, 3 rows\)\n\n\| gene \| Tissue \| nTPM \|\n\| --- \| --- \| --- \|\n\| EGFR \| liver \| 32\.2 \|/);
  assert.match(md, /\| MET \| liver \| — \|/, 'a missing value prints as a dash, not zero');
  assert.match(md, /Figure a2: grouped_bar "Lung vs liver" from a1/);
  assert.match(md, /- EGFR is higher in liver \(32\.2\) than lung \(14\.1\)\. \(evidence: a1 row 0: Tissue=liver, nTPM=32\.2; row 1: Tissue=lung, nTPM=14\.1\)/);
  assert.match(md, /\*\*Limitations\*\*\n\n- MET has no recorded liver value\./);
  assert.match(md, /\*\*Not done\*\*\n\n- Plan item 1: no source/);
});

test('stated numbers keep the precision they were written at', () => {
  assert.deepEqual(statedNumbers('32.2 nTPM, 1,234 rows and 1.6E11 pg/L').map(n => [n.value, n.tolerance]), [[32.2, 0.05], [1234, 0.5], [1.6e11, 5e9]]);
});

test('a claim may bind cells from several tables through evidence, and the report prints each binding', () => {
  const a5 = { id: 'a5', kind: 'data', label: 'means', rows: [{ gene: 'EGFR', mean: 23.15 }], columns: ['gene', 'mean'], tool: 'aggregate', args: {}, inputs: ['a1'] };
  const s = { artifacts: [...state.artifacts, a5], byId: new Map([...state.byId, ['a5', a5]]), plan: state.plan };
  const claim = { text: 'EGFR is 32.2 in liver and averages 23.2 across tissues.', evidence: [{ artifact: 'a1', rows: [0], columns: ['Tissue', 'nTPM'] }, { artifact: 'a5', rows: [0], columns: ['mean'] }] };
  assert.deepEqual(reportIssues({ claims: [claim] }, s), []);
  assert.match(renderReport({ claims: [claim] }, s, []), /\(evidence: a1 row 0: Tissue=liver, nTPM=32\.2 \| a5 row 0: mean=23\.15\)/);
  const refused = reportIssues({ claims: [{ text: 'EGFR is 32.2 in liver and averages 23.2', artifact: 'a1', rows: [0], columns: ['nTPM'] }] }, s);
  assert.match(refused[0], /23\.2, not among the cells it is bound to \(a1 rows 0 columns nTPM\): 23\.2 is at a5 row 0 mean/);
  assert.match(reportIssues({ claims: [{ text: 'no binding' }] }, s)[0], /needs artifact and rows, or evidence/);
});

test('a number an artifact or any artifact it was made from was made with is part of its evidence', () => {
  const a6 = { id: 'a6', kind: 'data', label: 'positive', rows: [{ gene: 'EGFR', nTPM: 32.2 }], columns: ['gene', 'nTPM'], tool: 'filter', args: { artifact: 'a1', where: [{ column: 'nTPM', op: '>', value: 10 }] }, inputs: ['a1'] };
  const a7 = { id: 'a7', kind: 'data', label: 'ranked', rows: [{ gene: 'EGFR', nTPM: 32.2, rank: 1 }], columns: ['gene', 'nTPM', 'rank'], tool: 'rank', args: { artifact: 'a6', by: 'nTPM' }, inputs: ['a6'] };
  const s = { artifacts: [...state.artifacts, a6, a7], byId: new Map([...state.byId, ['a6', a6], ['a7', a7]]), plan: state.plan };
  assert.deepEqual(reportIssues({ claims: [{ text: 'EGFR is the only gene above 10 nTPM, at 32.2', artifact: 'a7', rows: [0], columns: ['nTPM'] }] }, s), []);
  assert.match(reportIssues({ claims: [{ text: 'EGFR is above 15 nTPM', artifact: 'a7', rows: [0], columns: ['nTPM'] }] }, s)[0], /states 15/);
});

test('a percent in a claim binds to the cell that holds the fraction, within its written precision', () => {
  const a6 = { id: 'a6', kind: 'data', label: 'share', rows: [{ count: 86, fraction: 0.699187 }], columns: ['count', 'fraction'], tool: 'compute', args: {}, inputs: ['a1'] };
  const s = { artifacts: [a6], byId: new Map([['a6', a6]]), plan: [] };
  assert.deepEqual(reportIssues({ claims: [{ text: '86 partners, about 70% of them, are nuclear.', artifact: 'a6', rows: [0], columns: ['count', 'fraction'] }] }, s), []);
  assert.deepEqual(reportIssues({ claims: [{ text: '69.9 percent are nuclear.', artifact: 'a6', rows: [0], columns: ['fraction'] }] }, s), []);
  assert.match(reportIssues({ claims: [{ text: '75% are nuclear.', artifact: 'a6', rows: [0], columns: ['fraction'] }] }, s)[0], /states 75, not among the cells/);
  assert.equal(reportIssues({ tables: [{ artifact: 'a6' }], limitations: ['The nuclear share of 70% depends on the main-location field'] }, s).some(i => /limitations/.test(i)), false);
});

test('the binder does the naming it can do itself: a column it locates, all rows of a small table, the row count of any artifact', () => {
  const a7 = { id: 'a7', kind: 'data', label: 'nuclear', rows: [{ nuclear_count: 86, nuclear_fraction: 0.699187 }], columns: ['nuclear_count', 'nuclear_fraction'], tool: 'compute', args: {}, inputs: ['a1'] };
  const a8 = { id: 'a8', kind: 'data', label: 'partners', rows: Array.from({ length: 123 }, (_, i) => ({ gene: `G${i}` })), columns: ['gene'], tool: 'investigator_hpa', args: {}, inputs: [] };
  const s = { artifacts: [a7, a8], byId: new Map([['a7', a7], ['a8', a8]]), plan: [] };
  // a number in a bound row but an unnamed column: the column is added and the claim stands
  const claim = { text: '86 partners (70%) are nuclear.', artifact: 'a7', rows: [0], columns: ['nuclear_fraction'] };
  assert.deepEqual(reportIssues({ claims: [claim] }, s), []);
  assert.deepEqual(claim.columns, ['nuclear_fraction', 'nuclear_count']);
  // a small table needs no row indices: all its rows are the evidence
  const whole = { text: 'The nuclear share is 0.699187.', artifact: 'a7', columns: ['nuclear_fraction'] };
  assert.deepEqual(reportIssues({ claims: [whole] }, s), []);
  assert.deepEqual(whole.rows, [0]);
  // the row count of another saved artifact is a bound number
  assert.deepEqual(reportIssues({ claims: [{ text: 'Of the 123 partners, 86 are nuclear.', artifact: 'a7', rows: [0], columns: ['nuclear_count'] }] }, s), []);
  assert.match(reportIssues({ claims: [{ text: 'Of the 124 partners, 86 are nuclear.', artifact: 'a7', rows: [0], columns: ['nuclear_count'] }] }, s)[0], /states 124/);
  assert.match(reportIssues({ claims: [{ text: 'all of them', artifact: 'a8' }] }, s)[0], /must name the rows/);
});
