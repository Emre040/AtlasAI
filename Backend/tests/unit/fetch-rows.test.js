'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchRows } = require('../../src/system/aso/fetchRows');
const { fakeAdapter, CONSENSUS, TISSUES, GENES } = require('../helpers/deskStudyFixture');

const keys = { entity: 'gene', columns: ['gene', 'ensembl'] };

test('fetch returns one row per matching source row, keeps blanks, and explains empty rows', async () => {
  const adapter = fakeAdapter();
  const supplied = ['EGFR', 'egfr', 'ERBB2', 'MET', 'NOPE'];
  const resolved = await adapter.resolveGenes(supplied);
  const result = await fetchRows({ adapter, entry: CONSENSUS, supplied, resolved, fields: ['Tissue', 'ntpm'], where: [], keys });
  assert.deepEqual(result.columns, ['gene', 'ensembl', 'Tissue', 'nTPM', 'source_rows', 'source_status']);
  assert.equal(result.rows.filter(r => r.gene === 'EGFR').length, 3, 'a name supplied twice is one entity');
  assert.equal(result.rows.find(r => r.gene === 'EGFR' && r.Tissue === 'heart').nTPM, '0.0', 'a recorded zero stays a value');
  assert.equal(result.rows.find(r => r.gene === 'MET').nTPM, null, 'a blank cell is null, not zero');
  const nope = result.rows.find(r => r.gene === 'NOPE');
  assert.equal(nope.source_status, 'not in release');
  assert.equal(nope.ensembl, null);
  assert.deepEqual(result.coverage, { supplied: 5, entities: 4, resolved: 3, with_rows: 3, no_rows: 0, no_match: 0, not_in_release: 1, rows: 6 });
  assert.deepEqual(result.fields, ['Tissue', 'nTPM'], 'field names resolve case-insensitively to the exact column');
  const echoed = await fetchRows({ adapter, entry: CONSENSUS, supplied, resolved, fields: ['Gene', 'Tissue', 'ntpm'], where: [], keys });
  assert.deepEqual(echoed.columns, ['gene', 'ensembl', 'Tissue', 'nTPM', 'source_rows', 'source_status'], 'a named column that only repeats the entity keys is not echoed');
});

test('a filter selects source rows; an entity with no matching row keeps one empty row saying so', async () => {
  const adapter = fakeAdapter();
  const supplied = ['EGFR', 'MET'];
  const resolved = await adapter.resolveGenes(supplied);
  const result = await fetchRows({ adapter, entry: CONSENSUS, supplied, resolved, fields: ['nTPM'], where: [{ column: 'Tissue', op: '=', value: 'lung' }], keys });
  assert.deepEqual(result.rows.map(r => [r.gene, r.nTPM, r.source_rows, r.source_status]), [['EGFR', '14.1', 1, 'ok'], ['MET', null, 0, 'no rows match filter']]);
});

test('unknown fields, reference tables and bad filters fail with the columns the model needs', async () => {
  const adapter = fakeAdapter();
  const resolved = await adapter.resolveGenes(['EGFR']);
  await assert.rejects(fetchRows({ adapter, entry: CONSENSUS, supplied: ['EGFR'], resolved, fields: ['Tissue', 'expression'], keys }), /no column "expression"; its columns: Gene, Gene name, Tissue, nTPM/);
  await assert.rejects(fetchRows({ adapter, entry: TISSUES, supplied: ['EGFR'], resolved, fields: ['Organ'], keys }), /has no per-gene reads \(reference table\); match the points against one of its columns, or fetch without a list/);
  await assert.rejects(fetchRows({ adapter, entry: CONSENSUS, supplied: ['EGFR'], resolved, fields: ['nTPM'], where: [{ column: 'Organ', op: '=', value: 'x' }], keys }), /no column named "Organ"/);
});

test('omitting fields returns every column except the ones that only repeat the entity keys', async () => {
  const adapter = fakeAdapter();
  const resolved = await adapter.resolveGenes(['ERBB2']);
  const result = await fetchRows({ adapter, entry: CONSENSUS, supplied: ['ERBB2'], resolved, keys });
  assert.deepEqual(result.fields, ['Tissue', 'nTPM']);
  assert.deepEqual(result.identity_columns, ['Gene', 'Gene name']);
  assert.equal(GENES.length, 3);
});
