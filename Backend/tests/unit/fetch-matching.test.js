'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchMatching } = require('../../src/system/aso/fetchRows');

// A pair table: a point may sit on either side; matching against both columns finds every pair it is in.
test('fetch matches points against any of several columns and names the point in its own column', async () => {
  const entry = { file: 'pairs.tsv', key: 'lookup', columns: ['ensembl_gene_id_1', 'ensembl_gene_id_2', 'datasets'] };
  const table = [{ ensembl_gene_id_1: 'ENSG1', ensembl_gene_id_2: 'ENSG9', datasets: 'x' }, { ensembl_gene_id_1: 'ENSG7', ensembl_gene_id_2: 'ENSG1', datasets: 'y' }, { ensembl_gene_id_1: 'ENSG5', ensembl_gene_id_2: 'ENSG6', datasets: 'z' }];
  const adapter = { async *rows() { yield* table; }, keysOf() { return {}; } };
  const both = await fetchMatching({ adapter, entry, points: ['ENSG1', 'ENSG2'], fields: [], match: ['ensembl_gene_id_1', 'ensembl_gene_id_2'], keys: { entity: 'gene', columns: ['gene', 'ensembl'] } });
  assert.deepEqual(both.columns.slice(0, 3), ['point', 'ensembl_gene_id_1', 'ensembl_gene_id_2']);
  assert.deepEqual(both.rows.map(r => [r.point, r.ensembl_gene_id_1, r.ensembl_gene_id_2, r.source_status]), [['ENSG1', 'ENSG1', 'ENSG9', 'ok'], ['ENSG1', 'ENSG7', 'ENSG1', 'ok'], ['ENSG2', null, null, 'no rows in table']]);
  assert.equal(both.match, 'point');
  const one = await fetchMatching({ adapter, entry, points: ['ENSG1'], fields: ['datasets'], match: 'ensembl_gene_id_2', keys: { entity: 'gene', columns: ['gene', 'ensembl'] } });
  assert.deepEqual(one.rows.map(r => [r.ensembl_gene_id_2, r.datasets]), [['ENSG1', 'y']], 'one column matches one side only');
});
