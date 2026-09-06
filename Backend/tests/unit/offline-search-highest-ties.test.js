'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const BACKEND = process.env.ATLASAI_BACKEND_ROOT || path.resolve(__dirname, '../..');
const filename = path.join(BACKEND, 'src/hpa/offlineSearch.js');
const source = process.env.ATLASAI_PROPOSAL_ROOT ? path.join(process.env.ATLASAI_PROPOSAL_ROOT, 'src/hpa/offlineSearch.js') : filename;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(source, 'utf8'), filename);
const { OfflineSearch } = loaded.exports;
const { FILES } = require(path.join(BACKEND, 'src/hpa/localData'));
const { hpaSchema } = require(path.join(BACKEND, 'src/hpa/hpaSchema'));

// Each source keeps its own actual entity column and RNA unit; no HPA rows are read.
const modalities = [
  ['tissue_category_rna', FILES.tissueConsensus, 'Tissue', 'nTPM'],
  ['brain_category_rna', FILES.brainRegion, 'Brain region', 'nTPM'],
  ['cell_type_category_rna', FILES.singleCellType, 'Cell type', 'nCPM'],
  ['cell_type_group_category_rna', FILES.singleCellTypeGroup, 'Cell type group', 'nCPM'],
  ['sc_brain_region_category_rna', FILES.singleNucleiBrain, 'Cluster type', 'nCPM'],
  ['immune_cell_category_rna', FILES.immuneCell, 'Immune cell', 'nTPM']
].map(([key, file, entity, value]) => ({ key, file, entity, value,
  field: Object.values(hpaSchema).flatMap(fields => Object.entries(fields)).find(([, spec]) => spec.urlKey === key)[0]
}));

function fixture(modality, entries) {
  const master = [...new Set(entries.map(([gene]) => gene))].map(id => ({ Gene: id, Ensembl: `SYNTHETIC_${id}`, 'Protein class': 'Synthetic fixture' }));
  const rows = entries.map(([gene, entity, value]) => ({ Gene: `SYNTHETIC_${gene}`, [modality.entity]: entity, [modality.value]: value }));
  let scans = 0;
  const data = {
    async master() { return { rows: master }; },
    async available(files) { return files.every(file => file === modality.file); },
    async describe(file) { assert.equal(file, modality.file); return { unpackedBytes: rows.length, downloadedUnixMs: 1 }; },
    async *rows(file) { assert.equal(file, modality.file); scans++; yield* rows; }
  };
  const search = new OfflineSearch(data);
  const axis = (entity, subclass = 'Is highest expressed') => ({ field: modality.field, class: entity, subclass });
  const query = async (include = [], exclude = []) => {
    const result = await search.evaluate(include, exclude);
    assert.deepEqual(result.unsupported, []);
    return result.rows.map(row => row.Gene).sort();
  };
  return { search, axis, query, scans: () => scans };
}

function permutations(rows) {
  return [rows, [...rows].reverse(), [...rows.slice(2), ...rows.slice(0, 2)], [...rows].sort((a, b) => String(a[1]).localeCompare(String(b[1])) || String(a[0]).localeCompare(String(b[0])))];
}

test('highest-expression include, NOT and intersection retain every positive tied maximum independent of row order', async () => {
  const entries = [
    ['TIED', 'Alpha', '5'], ['TIED', 'Beta', '5.0'], ['TIED', 'Gamma', '4'],
    ['UNIQUE', 'Alpha', '6'], ['UNIQUE', 'Beta', '5'],
    ['LATER_MAX', 'Alpha', '4'], ['LATER_MAX', 'Beta', '4'], ['LATER_MAX', 'Gamma', '9']
  ];
  for (const modality of modalities) for (const rows of permutations(entries)) {
    const f = fixture(modality, rows);
    assert.deepEqual(await f.query([f.axis('Alpha')]), ['TIED', 'UNIQUE'], modality.key);
    assert.deepEqual(await f.query([f.axis('Beta')]), ['TIED'], modality.key);
    assert.deepEqual(await f.query([f.axis('Gamma')]), ['LATER_MAX'], 'A later larger maximum replaces every previous lower tie');
    assert.deepEqual(await f.query([], [f.axis('Beta')]), ['LATER_MAX', 'UNIQUE'], 'NOT must exclude the tied-highest gene');
    assert.deepEqual(await f.query([f.axis('Alpha'), f.axis('Beta')]), ['TIED'], 'Separate include axes form an intersection');
    assert.deepEqual(await f.query([f.axis(['Alpha', 'Beta'])]), ['TIED', 'UNIQUE'], 'Entity choices within one axis form a union');
    assert.equal(f.scans(), 1, 'Repeated queries use the same one-pass index');
  }
});

test('measured-zero maxima retain all ties while missing-only inputs create no highest or below-threshold evidence', async () => {
  const entries = [
    ['ZERO', 'Alpha', '0'], ['ZERO', 'Beta', '0.0'],
    ['MISSING', 'Alpha', ''], ['MISSING', 'Beta', '   '], ['MISSING', 'Gamma', null],
    ['MISSING', 'Delta', undefined], ['MISSING', 'Epsilon', 'NA'], ['MISSING', 'Zeta', 'N/A'], ['MISSING', 'Eta', 'Infinity']
  ];
  for (const modality of modalities) for (const rows of permutations(entries)) {
    const f = fixture(modality, rows);
    assert.deepEqual(await f.query([f.axis('Alpha')]), ['ZERO'], modality.key);
    assert.deepEqual(await f.query([f.axis('Beta')]), ['ZERO'], modality.key);
    assert.deepEqual(await f.query([], [f.axis('Beta')]), ['MISSING'], 'An absent measurement is not a measured maximum');
    assert.deepEqual(await f.query([f.axis('Alpha', 'Not detected')]), ['ZERO'], 'Missing source values must not be coerced to measured zero');
    for (const entity of ['Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta']) assert.deepEqual(await f.query([f.axis(entity)]), []);
    assert.equal(f.scans(), 1);
  }
});
