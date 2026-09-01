'use strict';

// Executes direct ASO measurements against HPA data.

/**
 * Direct HPA Tissue Measurement — zero LLM calls.
 *
 * Fetches an HPA gene page, parses embedded bar-chart data with cheerio,
 * and returns the numeric value for a requested tissue label.
 *
 * One page fetch gives us ALL tissues, so a per-run cache means each gene
 * page is fetched at most once regardless of how many tissues are queried.
 */

const cheerio = require('cheerio');

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function fetchHtml(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HPAAgent/direct', 'Accept': 'text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HPAAgent/direct', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Resolve gene name → ensembl ID via HPA search API (only if needed)
// ---------------------------------------------------------------------------
async function resolveGene(gene) {
  const url = `https://www.proteinatlas.org/search/${encodeURIComponent(gene)}?format=json&download=yes`;
  const data = await fetchJson(url);
  if (!Array.isArray(data) || !data.length) return null;
  const row = data.find(g => (g.Gene || '').toUpperCase() === gene.toUpperCase()) || data[0];
  return { gene: row.Gene, ensembl: row.Ensembl };
}

// ---------------------------------------------------------------------------
// Extract bar-chart data from HPA page HTML
// Mirrors the investigator's extraction logic but without LLM reasoning.
// ---------------------------------------------------------------------------
function extractBarCharts(html) {
  const $ = cheerio.load(html);
  const charts = [];

  $('script[src], link, meta, style, noscript, nav, footer, header').remove();

  $('script:not([src])').each((_, el) => {
    const txt = $(el).html() || '';
    if (txt.length < 50) return;

    // Map variable assignments: var div = $('#id')
    const varAssignments = {};
    const varRegex = /var\s+(\w+)\s*=\s*\$\(['"]#([^'"]+)['"]\)/g;
    let m;
    while ((m = varRegex.exec(txt)) !== null) {
      varAssignments[m[1]] = m[2];
    }

    // Direct barChart calls: $('#id').barChart([...],
    const directRe = /\$\(['"]#([^'"]+)['"]\)\.barChart\s*\(\s*(\[[\s\S]*?\])\s*,/g;
    while ((m = directRe.exec(txt)) !== null) processChart(m[1], m[2]);

    // Variable-based: varName.barChart([...],
    const varRe = /(\w+)\.barChart\s*\(\s*(\[[\s\S]*?\])\s*,/g;
    while ((m = varRe.exec(txt)) !== null) {
      const chartId = varAssignments[m[1]];
      if (chartId) processChart(chartId, m[2]);
    }

    function processChart(chartId, dataStr) {
      const data = safeJsonParse(dataStr);
      if (!Array.isArray(data)) return;

      // Find nearest section header in raw HTML
      let section = chartId;
      const chartPos = html.indexOf(`id="${chartId}"`);
      if (chartPos > 0) {
        const before = html.slice(Math.max(0, chartPos - 6000), chartPos);
        const headers = [...before.matchAll(/<th[^>]*class="[^"]*head[^"]*"[^>]*>([\s\S]*?)<\/th>/gi)];
        if (headers.length > 0) {
          let clean = headers[headers.length - 1][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          const titleMatch = clean.match(/^([A-Z][A-Z &\-]+)i\s/);
          if (titleMatch) clean = titleMatch[1].trim();
          if (clean.length >= 2 && clean.length <= 80) section = clean;
        }
      }

      const dataPoints = data.map(item => ({
        label: (item.label || item.name || '').trim(),
        value: item.value ?? item.y ?? null,
      })).filter(p => p.label);

      charts.push({ id: chartId, section, data: dataPoints });
    }
  });

  return charts;
}

// ---------------------------------------------------------------------------
// Find a tissue value in parsed charts.
// When scoutInfo is provided (chart_id and/or exact_label from investigator
// scout), we use those concrete selectors for a precise lookup.
// Falls back to fuzzy matching only if no scoutInfo is given.
// ---------------------------------------------------------------------------
function findValue(charts, tissueLabel, scoutInfo) {
  // --- Scout-guided lookup (precise) ---
  if (scoutInfo) {
    const targetCharts = scoutInfo.chart_id
      ? charts.filter(c => c.id === scoutInfo.chart_id)
      : charts;

    if (scoutInfo.exact_label) {
      const exact = scoutInfo.exact_label.toLowerCase().trim();
      for (const chart of targetCharts) {
        for (const point of chart.data) {
          if (point.label.toLowerCase().trim() === exact) {
            return { value: point.value, section: chart.section, chartId: chart.id };
          }
        }
      }
    }
    // If scout had chart_id but no exact_label, search within that chart
    if (scoutInfo.chart_id && targetCharts.length) {
      const needle = tissueLabel.toLowerCase().trim();
      for (const chart of targetCharts) {
        for (const point of chart.data) {
          if (point.label.toLowerCase().trim() === needle) {
            return { value: point.value, section: chart.section, chartId: chart.id };
          }
        }
      }
    }
  }

  // --- Unguided lookup (original behavior) ---
  const needle = tissueLabel.toLowerCase().trim();

  // Exact match across all charts
  for (const chart of charts) {
    for (const point of chart.data) {
      if (point.label.toLowerCase().trim() === needle) {
        return { value: point.value, section: chart.section, chartId: chart.id };
      }
    }
  }

  // Contains match (fuzzy fallback)
  for (const chart of charts) {
    for (const point of chart.data) {
      const lbl = point.label.toLowerCase();
      if (lbl.includes(needle) || needle.includes(lbl)) {
        return { value: point.value, section: chart.section, chartId: chart.id, fuzzy: true };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public: measure one gene/tissue directly — uses cache
// ---------------------------------------------------------------------------
const PAGE_PATHS = {
  tissue: '/tissue',
  brain: '/brain',
  blood: '/blood',
  cancer: '/cancer',
  'cell+line': '/cell+line',
  'single+cell': '/single+cell',
  subcellular: '/subcellular',
};

/**
 * @param {Object} opts
 * @param {string} opts.gene        - Gene symbol (e.g. "FXYD2")
 * @param {string} opts.ensembl     - Ensembl ID (e.g. "ENSG00000137731") — optional if gene is provided
 * @param {string} opts.tissue      - Tissue label to extract (e.g. "kidney")
 * @param {string} [opts.page]      - HPA page type (default: "tissue")
 * @param {Map}    [opts.cache]     - Per-run page cache (key: "ensembl:page" → charts[])
 * @param {Object} [opts.scoutInfo] - From investigator scout: { chart_id, exact_label }
 */
async function measureDirect({ gene, ensembl, tissue, page = 'tissue', cache, scoutInfo }) {
  // Resolve ensembl if missing
  if (!ensembl && gene) {
    const resolved = await resolveGene(gene);
    if (!resolved) return { found: false, gene, error: `Gene "${gene}" not found in HPA` };
    ensembl = resolved.ensembl;
    gene = resolved.gene;
  }

  const pagePath = PAGE_PATHS[page] || '/tissue';
  const cacheKey = `${ensembl}:${page}`;

  let charts;
  if (cache && cache.has(cacheKey)) {
    charts = cache.get(cacheKey);
  } else {
    const url = `https://www.proteinatlas.org/${ensembl}-${gene}${pagePath}`;
    const html = await fetchHtml(url);
    charts = extractBarCharts(html);
    if (cache) cache.set(cacheKey, charts);
  }

  const match = findValue(charts, tissue, scoutInfo || null);
  if (!match) {
    // Collect available labels for debugging
    const available = charts.flatMap(c => c.data.map(d => d.label)).slice(0, 30);
    return {
      found: false, value: null, gene, ensembl,
      error: `No value for "${tissue}" on ${page} page`,
      available_labels: available,
    };
  }

  return {
    found: true,
    value: match.value,
    gene, ensembl,
    source_section: match.section,
    chart_id: match.chartId,
    confidence: match.fuzzy ? 'medium' : 'high',
    extracted_value: match.value,
    answer: `${gene} ${tissue} expression: ${match.value}`,
  };
}

module.exports = { measureDirect, extractBarCharts, resolveGene };
