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
  assert.match(wrong[0], /states 40\.1, not among the cells it is bound to in a1 \(rows 0; columns nTPM\): 40\.1 is in no saved artifact/);
  const elsewhere = reportIssues({ claims: [{ text: 'EGFR lung is 14.1 nTPM', artifact: 'a1', rows: [0], columns: ['nTPM'] }] }, state);
  assert.match(elsewhere[0], /14\.1 is at a1 row 1 nTPM/, 'a refusal says where the number lives');
  const a4 = { id: 'a4', kind: 'data', label: 'top', rows: [{ gene: 'EGFR', rank: 1 }], columns: ['gene', 'rank'], tool: 'rank', args: { artifact: 'a1', by: 'nTPM', top: 5 }, inputs: ['a1'] };
  state.byId.set('a4', a4); state.artifacts.push(a4);
  assert.deepEqual(reportIssues({ claims: [{ text: 'EGFR is among the top 5', artifact: 'a4', rows: [0] }] }, state), [], 'a number the artifact was made with counts as bound');
  assert.deepEqual(reportIssues({ claims: [{ text: '2 of the 3 rows have a value', artifact: 'a1', rows: [0, 1], columns: ['nTPM'] }] }, state), [], 'whole numbers may be counts of bound rows or of the artifact');
  assert.match(reportIssues({ claims: [{ text: 'liver is higher', artifact: 'a1', rows: [] }] }, state)[0], /must name the rows it rests on/);
  assert.match(reportIssues({ claims: [{ text: 'x', artifact: 'a9', rows: [0] }] }, state)[0], /a9.*not a saved artifact/);
  assert.match(reportIssues({ claims: [{ text: 'x', artifact: 'a1', rows: [7] }] }, state)[0], /between 0 and 2/);
  assert.match(reportIssues({ claims: [{ text: 'x', artifact: 'a1', rows: [0], columns: ['expression'] }] }, state)[0], /no column "expression"/);
});

test('tables, figures and limitations are checked structurally', () => {
  assert.deepEqual(reportIssues({ tables: [{ artifact: 'a1', columns: ['gene', 'nTPM'] }], figures: ['a2'] }, state), []);
  assert.match(reportIssues({ tables: [{ artifact: 'a2' }] }, state)[0], /a2 is a figure, not a row table/);
  assert.match(reportIssues({ figures: ['a3'] }, state)[0], /a3 was not rendered/);
  assert.match(reportIssues({ figures: ['a1'] }, state)[0], /"a1" is not a saved figure/);
  assert.match(reportIssues({ tables: [{ artifact: 'a1' }], limitations: ['3 genes had no record'] }, state)[0], /limitations\[0\] states 3; numbers belong in a claim/);
  assert.match(reportIssues({ tables: [{ artifact: 'a1' }], not_done: [{ item: 4, why: 'x' }] }, state)[0], /between 1 and 1/);
  assert.match(reportIssues({ figures: [] }, state)[0], /needs at least one table, figure or claim/);
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
