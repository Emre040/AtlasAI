'use strict';

// Resolves inclusion checks used by the system orchestrator.

const https = require('https');
const http = require('http');

/**
 * Check if a gene is included in an HPA search result
 * Fetches the JSON from the search URL and checks for the gene
 */

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function normalizeGene(gene) {
  return String(gene || '').trim().toUpperCase();
}

async function checkInclusion({ search_url, gene }, { onStep } = {}) {
  const normalizedGene = normalizeGene(gene);

  if (!search_url || !normalizedGene) {
    return {
      status: 'error',
      error: 'Both search_url and gene are required',
      included: false
    };
  }

  await onStep?.({ stage: 'start', message: `Checking if ${normalizedGene} is in the search results` });
  await onStep?.({ stage: 'execution_step', label: 'URL', message: search_url, url: search_url });

  // Ensure we have the JSON format URL
  let jsonUrl = search_url;
  if (!jsonUrl.includes('format=json')) {
    jsonUrl += (jsonUrl.includes('?') ? '&' : '?') + 'format=json&download=yes';
  }

  await onStep?.({ stage: 'execution_step', label: 'Fetch', message: `Fetching results from search URL` });

  try {
    const results = await httpGetJson(jsonUrl);
    const rows = Array.isArray(results) ? results : (results?.rows || []);

    await onStep?.({ stage: 'reasoning_step', label: 'Results', message: `Got ${rows.length} genes in the search results` });

    // Search for the gene - check both Gene name and ENSG ID columns
    const isEnsg = normalizedGene.startsWith('ENSG');

    let found = null;
    for (const row of rows) {
      // Handle both array format and object format
      if (Array.isArray(row)) {
        // Array format: [Gene, Ensembl, ...]
        if (normalizeGene(row[0]) === normalizedGene || normalizeGene(row[1]) === normalizedGene) {
          found = { gene: row[0], ensembl: row[1], description: row[2] || '' };
          break;
        }
      } else if (typeof row === 'object') {
        // Object format with keys
        const rowGene = normalizeGene(row.Gene || row.gene || row.name || '');
        const rowEnsg = normalizeGene(row.Ensembl || row.ensembl || row.ensg || '');
        if (rowGene === normalizedGene || rowEnsg === normalizedGene) {
          found = {
            gene: row.Gene || row.gene || row.name,
            ensembl: row.Ensembl || row.ensembl || row.ensg,
            description: row['Gene description'] || row.description || ''
          };
          break;
        }
      }
    }

    if (found) {
      await onStep?.({ stage: 'complete', label: 'Found', message: `Yes, ${found.gene} (${found.ensembl}) is included in these results` });
      return {
        status: 'ok',
        included: true,
        gene: found.gene,
        ensembl: found.ensembl,
        description: found.description,
        total_results: rows.length,
        search_url
      };
    } else {
      await onStep?.({ stage: 'complete', label: 'Not Found', message: `No, ${normalizedGene} is not in these ${rows.length} results` });
      return {
        status: 'ok',
        included: false,
        gene: normalizedGene,
        total_results: rows.length,
        search_url
      };
    }

  } catch (err) {
    await onStep?.({ stage: 'error', label: 'Error', message: err.message });
    return {
      status: 'error',
      error: err.message,
      included: false,
      gene: normalizedGene
    };
  }
}

module.exports = checkInclusion;
