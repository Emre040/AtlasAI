'use strict';

// Builds, from the local HPA release, the same page structures the investigator extracts from
// proteinatlas.org gene pages (bar charts of expression per entity, tables, key-value facts), and
// answers direct expression measurements without any network or model call.

const { localData, FILES } = require('./localData');

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Long-format expression files behind each HPA page, in the order proteinatlas.org shows them.
const PAGE_CHARTS = Object.freeze({
  tissue: [{ file: FILES.tissueConsensus, entity: 'Tissue', value: 'nTPM', unit: 'nTPM', id: 'tissue_consensus', section: 'RNA EXPRESSION OVERVIEW - Consensus dataset (nTPM)' }],
  brain: [{ file: FILES.brainRegion, entity: 'Brain region', value: 'nTPM', unit: 'nTPM', id: 'brain_region', section: 'RNA EXPRESSION OVERVIEW - Human brain regions (nTPM)' }],
  'single+cell': [
    { file: FILES.singleCellType, entity: 'Cell type', value: 'nCPM', unit: 'nCPM', id: 'single_cell_type', section: 'RNA SINGLE CELL TYPE SPECIFICITY - Cell types (nCPM)' },
    { file: FILES.singleCellTypeGroup, entity: 'Cell type group', value: 'nCPM', unit: 'nCPM', id: 'single_cell_type_group', section: 'RNA SINGLE CELL TYPE SPECIFICITY - Cell type groups (nCPM)' }
  ],
  blood: [{ file: FILES.immuneCell, entity: 'Immune cell', value: 'nTPM', unit: 'nTPM', id: 'immune_cell', section: 'RNA EXPRESSION OVERVIEW - Immune cells (nTPM)' }],
  'cell+line': [{ file: FILES.cellLine, entity: 'Cell line', value: 'nTPM', unit: 'nTPM', id: 'cell_line', section: 'RNA EXPRESSION OVERVIEW - Cell lines (nTPM)' }]
});

const PAGE_KEY_VALUES = Object.freeze({
  '': {
    'GENE INFORMATION': ['Gene description', 'Gene synonym', 'Ensembl', 'Uniprot', 'Chromosome', 'Position', 'Protein class', 'Biological process', 'Molecular function', 'Disease involvement', 'Evidence', 'HPA evidence', 'UniProt evidence', 'NeXtProt evidence', 'Antibody'],
    'RNA EXPRESSION SUMMARY': ['RNA tissue specificity', 'RNA tissue distribution', 'RNA tissue specific nTPM', 'RNA single cell type specificity', 'RNA single cell type specific nCPM', 'RNA brain regional specificity', 'RNA brain regional specific nTPM', 'RNA blood cell specificity', 'RNA blood cell specific nTPM', 'RNA cancer specificity', 'RNA cancer specific pTPM', 'RNA cell line specificity', 'RNA cell line specific nTPM', 'Tissue expression cluster', 'Brain expression cluster', 'Single cell expression cluster', 'Blood expression cluster', 'Cell line expression cluster'],
    'PROTEIN SUMMARY': ['Subcellular main location', 'Subcellular additional location', 'Secretome location', 'Secretome function', 'Blood concentration - Conc. blood IM [pg/L]', 'Blood concentration - Conc. blood MS [pg/L]', 'Protein tissue specificity', 'Protein tissue specific Intensity', 'Interactions']
  },
  tissue: {
    'RNA TISSUE SPECIFICITY': ['RNA tissue specificity', 'RNA tissue distribution', 'RNA tissue specificity score', 'RNA tissue specific nTPM', 'RNA tissue cell type enrichment', 'Tissue expression cluster'],
    'PROTEIN TISSUE SPECIFICITY': ['Protein tissue specificity', 'Protein tissue distribution', 'Protein tissue specific Intensity', 'Reliability (IH)']
  },
  brain: {
    'RNA BRAIN REGIONAL SPECIFICITY': ['RNA brain regional specificity', 'RNA brain regional distribution', 'RNA brain regional specificity score', 'RNA brain regional specific nTPM', 'RNA mouse brain regional specificity', 'RNA mouse brain regional specific nTPM', 'RNA pig brain regional specificity', 'RNA pig brain regional specific nTPM', 'Brain expression cluster', 'Reliability (Mouse Brain)']
  },
  'single+cell': {
    'RNA SINGLE CELL TYPE SPECIFICITY': ['RNA single cell type specificity', 'RNA single cell type distribution', 'RNA single cell type specificity score', 'RNA single cell type specific nCPM', 'RNA single cell type group specificity', 'RNA single cell type group specific nCPM', 'RNA single nuclei brain specificity', 'RNA single nuclei brain specific nCPM', 'Single cell expression cluster']
  },
  blood: {
    'RNA IMMUNE CELL SPECIFICITY': ['RNA blood cell specificity', 'RNA blood cell distribution', 'RNA blood cell specificity score', 'RNA blood cell specific nTPM', 'RNA blood lineage specificity', 'RNA blood lineage specific nTPM', 'Blood expression cluster'],
    'BLOOD PROTEIN CONCENTRATION': ['Blood concentration - Conc. blood IM [pg/L]', 'Blood concentration - Conc. blood MS [pg/L]', 'Secretome location']
  },
  'cell+line': {
    'RNA CELL LINE SPECIFICITY': ['RNA cell line specificity', 'RNA cell line distribution', 'RNA cell line specificity score', 'RNA cell line specific nTPM', 'Cell line expression cluster']
  },
  subcellular: {
    'SUBCELLULAR LOCATION SUMMARY': ['Subcellular location', 'Subcellular main location', 'Subcellular additional location', 'Reliability (IF)', 'CCD Protein', 'CCD Transcript', 'Secretome location']
  },
  cancer: {
    'RNA CANCER SPECIFICITY': ['RNA cancer specificity', 'RNA cancer distribution', 'RNA cancer specificity score', 'RNA cancer specific pTPM']
  },
  interaction: {
    'INTERACTION SUMMARY': ['Interactions']
  }
});

function keyValues(row, section, keys) {
  const out = [];
  for (const key of keys) {
    const value = String(row[key] ?? '').trim();
    if (value && value !== 'NA') out.push({ section, key, value });
  }
  return out;
}

function table(section, headers, fullRows) {
  const rows = fullRows.map(cells => Object.fromEntries(headers.map((h, i) => [h, cells[i]])));
  return { section, headers, rowCount: rows.length, sample: rows.slice(0, 10), fullRows: rows };
}

async function chartFor(spec, ensembl) {
  if (!(await localData.available([spec.file]))) return null;
  const rows = await localData.geneRows(spec.file, ensembl);
  const data = rows
    .map(row => ({ label: row[spec.entity], value: number(row[spec.value]), unit: spec.unit }))
    .filter(point => point.label && point.value !== null)
    .sort((a, b) => b.value - a.value);
  return { id: spec.id, section: spec.section, type: 'barChart', data };
}

async function prognosticsTable(masterRow, ensembl) {
  const rows = [];
  for (const [column, value] of Object.entries(masterRow)) {
    if (!column.startsWith('Cancer prognostics - ') || !value) continue;
    const match = /^Cancer prognostics - (.+) \((TCGA|validation)\)$/.exec(column);
    if (match) rows.push([match[1], match[2], value]);
  }
  if (await localData.available([FILES.cancerPrognostics])) {
    const detail = await localData.geneRows(FILES.cancerPrognostics, ensembl);
    const headers = ['Cancer', 'Potential prognostic favorable p', 'Unprognostic favorable p', 'Potential prognostic unfavorable p', 'Unprognostic unfavorable p', 'Validated favorable p', 'Validated unfavorable p'];
    const detailRows = detail.map(row => [row.Cancer, row['potential prognostic - favorable'], row['unprognostic - favorable'], row['potential prognostic - unfavorable'], row['unprognostic - unfavorable'], row['validated prognostic - favorable'], row['validated prognostic - unfavorable']]);
    return [table('CANCER PROGNOSTICS - Summary', ['Cancer', 'Cohort', 'Prognosis'], rows), table('CANCER PROGNOSTICS - Survival analysis p-values', headers, detailRows)];
  }
  return [table('CANCER PROGNOSTICS - Summary', ['Cancer', 'Cohort', 'Prognosis'], rows)];
}

async function interactionTable(ensembl) {
  if (!(await localData.available([FILES.interactions]))) return null;
  const consensus = await localData.table(FILES.interactions);
  const master = await localData.master();
  const rows = [];
  for (const row of consensus.rows) {
    const partner = row.ensembl_gene_id_1 === ensembl ? row.ensembl_gene_id_2 : row.ensembl_gene_id_2 === ensembl ? row.ensembl_gene_id_1 : null;
    if (!partner) continue;
    rows.push([partner, master.byEnsembl.get(partner)?.Gene || '', row.datasets]);
  }
  return table('PROTEIN INTERACTIONS - Consensus partners', ['Partner Ensembl', 'Partner gene', 'Datasets'], rows);
}

async function ihcTable(ensembl) {
  if (!(await localData.available([FILES.tissueIhc]))) return null;
  const rows = await localData.geneRows(FILES.tissueIhc, ensembl);
  return table('PROTEIN EXPRESSION - Immunohistochemistry (tissue, cell type, level, reliability)', ['Tissue', 'Cell type', 'Level', 'Reliability'],
    rows.map(row => [row.Tissue, row['Cell type'], row.Level, row.Reliability]));
}

async function subcellularKeyValues(ensembl) {
  if (!(await localData.available([FILES.subcellular]))) return [];
  const rows = await localData.geneRows(FILES.subcellular, ensembl);
  if (!rows[0]) return [];
  const row = rows[0];
  return keyValues(row, 'SUBCELLULAR LOCATION - Immunofluorescence annotation', ['Reliability', 'Main location', 'Additional location', 'Extracellular location', 'Enhanced', 'Supported', 'Approved', 'Uncertain', 'Single-cell variation intensity', 'Single-cell variation spatial', 'Cell cycle dependency', 'GO id']);
}

// The structure for one investigator page, or null when the release has nothing for it (the
// structure page, whose content is not part of the bulk export). `pageUrl` is the page the same
// data lives on at proteinatlas.org, kept so citations stay clickable.
async function buildLocalPageStructure(pageKey, gene, pageUrl) {
  const key = pageKey || '';
  const charts = PAGE_CHARTS[key] || null;
  const facts = PAGE_KEY_VALUES[key] || null;
  if (!charts && !facts && key !== 'cancer' && key !== 'interaction') return null;

  const master = await localData.master();
  const masterRow = master.byEnsembl.get(gene.ensembl);
  if (!masterRow) return null;
  const structure = {
    url: pageUrl,
    sections: [],
    charts: [],
    tables: [],
    keyValues: []
  };
  for (const spec of charts || []) {
    const chart = await chartFor(spec, gene.ensembl);
    if (chart && chart.data.length > 0) structure.charts.push(chart);
  }
  for (const [section, keys] of Object.entries(facts || {})) {
    structure.keyValues.push(...keyValues(masterRow, section, keys));
  }
  if (key === 'tissue') {
    const ihc = await ihcTable(gene.ensembl);
    if (ihc && ihc.rowCount > 0) structure.tables.push(ihc);
  }
  if (key === 'subcellular') structure.keyValues.push(...await subcellularKeyValues(gene.ensembl));
  if (key === 'cancer') structure.tables.push(...await prognosticsTable(masterRow, gene.ensembl));
  if (key === 'interaction') {
    const partners = await interactionTable(gene.ensembl);
    if (partners) structure.tables.push(partners);
  }
  structure.sections = [...new Set([...structure.charts.map(c => c.section), ...structure.keyValues.map(k => k.section), ...structure.tables.map(t => t.section)])];
  return structure;
}

// Direct measurement of one gene in one entity from the local release; same result shape as
// measureDirect so ASO can use either.
async function measureLocal({ gene, ensembl, tissue, page = 'tissue' }) {
  let name = gene;
  if (!ensembl) {
    const resolved = await localData.resolveGene(gene);
    if (!resolved) return { found: false, gene, error: `Gene "${gene}" not found in the local HPA release` };
    ensembl = resolved.ensembl;
    name = resolved.gene;
  }
  const specs = PAGE_CHARTS[page] || PAGE_CHARTS.tissue;
  const needle = lower(tissue);
  const available = [];
  for (const spec of specs) {
    const chart = await chartFor(spec, ensembl);
    if (!chart) continue;
    const exact = chart.data.find(point => lower(point.label) === needle);
    const fuzzy = exact || chart.data.find(point => lower(point.label).includes(needle) || needle.includes(lower(point.label)));
    if (fuzzy) {
      return {
        found: true,
        value: fuzzy.value,
        gene: name,
        ensembl,
        source_section: chart.section,
        chart_id: chart.id,
        confidence: exact ? 'high' : 'medium',
        extracted_value: fuzzy.value,
        answer: `${name} ${tissue} expression: ${fuzzy.value} ${spec.unit}`
      };
    }
    available.push(...chart.data.map(point => point.label));
  }
  return { found: false, value: null, gene: name, ensembl, error: `No value for "${tissue}" on the local ${page} data`, available_labels: available.slice(0, 30) };
}

module.exports = { buildLocalPageStructure, measureLocal, PAGE_CHARTS };
