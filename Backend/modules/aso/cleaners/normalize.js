'use strict';

function extractGene(row = {}) {
  if (!row || typeof row !== 'object') return null;
  return row.Gene || row.gene || row['Gene name'] || row['Gene'] || row.symbol || null;
}

function extractEnsembl(row = {}) {
  if (!row || typeof row !== 'object') return null;
  return row.Ensembl || row.ensembl || row.ensg || row['Ensembl'] || null;
}

function normalizeRows(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const gene = extractGene(row) || '';
    const ensembl = extractEnsembl(row) || '';
    const key = `${gene.toUpperCase()}::${ensembl.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ gene, ensembl, raw: row });
  }
  return out;
}

module.exports = { normalizeRows, extractGene, extractEnsembl };
