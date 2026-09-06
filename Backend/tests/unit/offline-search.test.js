'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OfflineSearch } = require('../../src/hpa/offlineSearch');
const { FILES } = require('../../src/hpa/localData');

// A tiny in-memory stand-in for LocalData: a master table plus long-format expression files.
function fakeData({ master, long = {} }) {
  const byEnsembl = new Map(master.map(row => [row.Ensembl, row]));
  const byName = new Map(master.map(row => [row.Gene.toUpperCase(), row]));
  return {
    async available(files) {
      return files.every(name => name === FILES.master || name in long);
    },
    async master() {
      return { header: Object.keys(master[0]), rows: master, byEnsembl, byName };
    },
    async table(name) {
      return { header: Object.keys(long[name][0]), rows: long[name] };
    },
    async *rows(name, { where = null } = {}) {
      for (const row of long[name]) if (!where || where(row)) yield row;
    }
  };
}

function gene(overrides) {
  return {
    Gene: 'G', 'Gene synonym': '', Ensembl: 'ENSG0', Uniprot: '', Chromosome: '1', 'Protein class': '',
    Evidence: 'Evidence at protein level', Antibody: '', Interactions: '0',
    'RNA tissue specificity': 'Low tissue specificity', 'RNA tissue distribution': 'Detected in all',
    'RNA tissue specificity score': '0.2', 'RNA tissue specific nTPM': '',
    'Subcellular location': '', 'Subcellular main location': '', 'Subcellular additional location': '',
    'Secretome location': '', 'CCD Protein': 'NA', 'CCD Transcript': 'NA', 'Tissue expression cluster': '',
    'RNA tissue cell type enrichment': '',
    'Cancer prognostics - Liver Hepatocellular Carcinoma (TCGA)': '',
    'Cancer prognostics - Liver Hepatocellular Carcinoma (validation)': '',
    ...overrides
  };
}

const MASTER = [
  gene({ Gene: 'ALB', Ensembl: 'ENSG1', 'Protein class': 'Enzymes, Plasma proteins', 'RNA tissue specificity': 'Tissue enriched', 'RNA tissue distribution': 'Detected in many', 'RNA tissue specificity score': '0.95', 'RNA tissue specific nTPM': 'liver: 198523.8', 'Secretome location': 'Secreted to blood', 'Subcellular location': 'Endoplasmic reticulum,Golgi apparatus', 'Subcellular main location': 'Endoplasmic reticulum, Golgi apparatus', 'Cancer prognostics - Liver Hepatocellular Carcinoma (validation)': 'validated prognostic unfavorable (1.0e-4)', Interactions: '27', Antibody: 'HPA1' }),
  gene({ Gene: 'FXYD2', Ensembl: 'ENSG2', 'Gene synonym': 'ATP1G1, HOMG2', 'Protein class': 'Enzymes, Predicted membrane proteins', 'RNA tissue specificity': 'Tissue enriched', 'RNA tissue distribution': 'Detected in some', 'RNA tissue specific nTPM': 'kidney: 3774.6', 'Subcellular location': 'Mitochondria', 'Subcellular main location': 'Mitochondria', 'CCD Protein': 'Yes', 'Cancer prognostics - Liver Hepatocellular Carcinoma (TCGA)': 'potential prognostic favorable (2.0e-3)' }),
  gene({ Gene: 'TP53', Ensembl: 'ENSG3', 'Protein class': 'Cancer-related genes', 'RNA tissue specificity': 'Low tissue specificity', 'RNA tissue distribution': 'Detected in all', 'Subcellular location': 'Nucleoplasm,Vesicles', 'Subcellular main location': 'Nucleoplasm', 'Subcellular additional location': 'Vesicles', Interactions: '998', 'RNA tissue cell type enrichment': 'Stomach - Mitotic cells (Stomach)' }),
  gene({ Gene: 'MYH7', Ensembl: 'ENSG4', 'RNA tissue specificity': 'Group enriched', 'RNA tissue distribution': 'Detected in some', 'RNA tissue specific nTPM': 'heart muscle: 3000.0;skeletal muscle: 900.0', 'Subcellular location': 'Actin filaments,Cytosol,Nucleoplasm', 'Subcellular main location': 'Actin filaments', 'Subcellular additional location': 'Cytosol, Nucleoplasm' })
];

const CONSENSUS = [
  { Gene: 'ENSG1', 'Gene name': 'ALB', Tissue: 'liver', nTPM: '198523.8' },
  { Gene: 'ENSG1', 'Gene name': 'ALB', Tissue: 'kidney', nTPM: '3.1' },
  { Gene: 'ENSG2', 'Gene name': 'FXYD2', Tissue: 'liver', nTPM: '0.2' },
  { Gene: 'ENSG2', 'Gene name': 'FXYD2', Tissue: 'kidney', nTPM: '3774.6' },
  { Gene: 'ENSG3', 'Gene name': 'TP53', Tissue: 'liver', nTPM: '40.0' },
  { Gene: 'ENSG3', 'Gene name': 'TP53', Tissue: 'kidney', nTPM: '55.0' },
  { Gene: 'ENSG4', 'Gene name': 'MYH7', Tissue: 'liver', nTPM: '0.0' },
  { Gene: 'ENSG4', 'Gene name': 'MYH7', Tissue: 'kidney', nTPM: '0.0' }
];

const IHC = [
  { Gene: 'ENSG1', 'Gene name': 'ALB', Tissue: 'Liver', 'IHC tissue name': 'Liver', 'Cell type': 'hepatocytes', Level: 'High', Reliability: 'Enhanced' },
  { Gene: 'ENSG3', 'Gene name': 'TP53', Tissue: 'Liver', 'IHC tissue name': 'Liver', 'Cell type': 'hepatocytes', Level: 'Not detected', Reliability: 'Approved' }
];

const search = new OfflineSearch(fakeData({ master: MASTER, long: { [FILES.tissueConsensus]: CONSENSUS, [FILES.tissueIhc]: IHC } }));
const genes = result => result.rows.map(r => r.Gene).sort();

test('tissue categories follow the specificity, distribution, and per-tissue expression semantics', async () => {
  assert.deepEqual(genes(await search.evaluate([{ field: 'Tissue category (RNA)', class: 'Liver', subclass: 'Tissue enriched' }])), ['ALB']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Tissue category (RNA)', class: 'Heart muscle', subclass: ['Tissue enriched', 'Group enriched'] }])), ['MYH7']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Tissue category (RNA)', class: 'Any', subclass: 'Low tissue specificity' }])), ['TP53']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Tissue category (RNA)', class: 'Liver', subclass: 'Not detected' }])), ['FXYD2', 'MYH7']);
  // MYH7 has measured zero in both synthetic tissues, so both tie for its maximum.
  assert.deepEqual(genes(await search.evaluate([{ field: 'Tissue category (RNA)', class: 'Kidney', subclass: 'Is highest expressed' }])), ['FXYD2', 'MYH7', 'TP53']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Tissue category (RNA)', class: 'Kidney', subclass: 'Detected in some' }])), ['FXYD2']);
});

test('exclusions, protein classes, subcellular searches, and prognostics combine like the online query', async () => {
  assert.deepEqual(genes(await search.evaluate(
    [{ field: 'Protein class', class: 'Enzymes' }],
    [{ field: 'Secretome annotation', class: 'Secreted to blood' }]
  )), ['FXYD2']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Subcellular location (ICC)', class: 'Nucleoplasm', subclass: 'Main location' }])), ['TP53']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Subcellular location (ICC)', class: 'Nucleoplasm', subclass: 'Additional location' }])), ['MYH7']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Subcellular location (ICC)', class: 'Any', subclass: 'Localizing 3' }])), ['MYH7']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Subcellular location (ICC)', class: 'Mitochondria', subclass: 'Cell cycle dependent protein' }])), ['FXYD2']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Prognostic cancer', class: 'Liver Hepatocellular Carcinoma', subclass: 'Unfavorable - validated prognostic' }])), ['ALB']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Prognostic cancer', class: 'Liver Hepatocellular Carcinoma', subclass: 'Favorable - potential prognostic' }])), ['FXYD2']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Protein interaction count', class: 'Consensus', subclass: '>200' }])), ['TP53']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Gene name', class: 'atp1g1' }])), ['FXYD2']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Tissue expression (IHC)', class: 'Liver', subclass: 'hepatocytes', levels: ['High'] }])), ['ALB']);
  assert.deepEqual(genes(await search.evaluate([{ field: 'Cell type enrichment (RNA)', class: 'Stomach', subclass: 'Mitotic cells (Stomach)' }])), ['TP53']);
});

test('fields the bulk export cannot answer are reported instead of guessed', async () => {
  const result = await search.evaluate([
    { field: 'Tissue category (RNA)', class: 'Liver', subclass: 'Tissue enriched' },
    { field: 'Metabolic pathway', class: 'Glycolysis' }
  ]);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.unsupported, [{ field: 'Metabolic pathway', class: 'Glycolysis', subclass: null, operator: 'AND' }]);

  const noValues = await search.evaluate([{ field: 'Cancer category (RNA)', class: 'Glioblastoma Multiforme', subclass: 'Not detected' }]);
  assert.equal(noValues.unsupported.length, 1);
});
