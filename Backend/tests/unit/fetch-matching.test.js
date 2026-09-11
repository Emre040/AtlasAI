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
  assert.deepEqual(both.columns, ['point', 'other', 'datasets', 'source_rows', 'source_status'], 'the sides are point and other; which side held the point is not repeated');
  assert.deepEqual(both.rows.map(r => [r.point, r.other]), [['ENSG1', 'ENSG9'], ['ENSG1', 'ENSG7'], ['ENSG2', null]], 'the side that is not the point is named other');
  assert.deepEqual(both.rows.map(r => [r.point, r.datasets, r.source_status]), [['ENSG1', 'x', 'ok'], ['ENSG1', 'y', 'ok'], ['ENSG2', null, 'no rows in table']]);
  assert.equal(both.match, 'point');
  const one = await fetchMatching({ adapter, entry, points: ['ENSG1'], fields: ['datasets'], match: 'ensembl_gene_id_2', keys: { entity: 'gene', columns: ['gene', 'ensembl'] } });
  assert.deepEqual(one.rows.map(r => [r.ensembl_gene_id_2, r.datasets]), [['ENSG1', 'y']], 'one column matches one side only');
});

// A list column holds a point as one of its items; the source is asked for such rows by the
// column's separator.
test('fetch matches a point against the items of a list column', async () => {
  const entry = { file: 'locations.tsv', key: 'lookup', columns: ['Gene', 'Main location', 'Reliability'] };
  const table = [{ Gene: 'ENSG1', 'Main location': 'Nucleoplasm;Cytosol', Reliability: 'Enhanced' }, { Gene: 'ENSG2', 'Main location': 'Cytosol', Reliability: 'Approved' }, { Gene: 'ENSG3', 'Main location': 'Nucleoplasm', Reliability: 'Supported' }];
  const asked = [];
  const adapter = {
    async *rows(e, { where }) { asked.push(where); yield* table; },
    keysOf() { return {}; },
    async profile() { return { columns: [{ column: 'Main location', kind: 'text', list: "list of 'item' items separated by ';'", parts: { kind: 'items', values: ['Cytosol', 'Nucleoplasm'] } }] }; }
  };
  const found = await fetchMatching({ adapter, entry, points: ['nucleoplasm'], fields: ['Gene', 'Reliability'], match: 'Main location', keys: { entity: 'gene', columns: ['gene', 'ensembl'] } });
  assert.deepEqual(asked[0], [{ columns: ['Main location'], values: ['nucleoplasm'], separators: { 'Main location': ';' } }], 'the source is told the separator');
  assert.deepEqual(found.rows.map(r => [r['Main location'], r.Gene, r.Reliability]), [['nucleoplasm', 'ENSG1', 'Enhanced'], ['nucleoplasm', 'ENSG3', 'Supported']]);
});
