'use strict';

/**
 * HPA Investigation Agent V3 - Structured Data + LLM Reasoning
 *
 * Philosophy:
 * - Extract ALL embedded data with section context
 * - Present structured, labeled data to LLM
 * - LLM reasons about what matches the question
 * - No hardcoded heuristics, no fallback chains
 */

const OpenAI = require('openai');
const cheerio = require('cheerio');

const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
const baseURL = process.env.GEMINI_BASE_URL || process.env.OPENAI_BASE_URL;
const openai = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });
const MODEL = process.env.HPA_MODEL;

// =============================================================================
// UTILITIES
// =============================================================================

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function fetchHtml(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HPAAgent/v3', 'Accept': 'text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HPAAgent/v3', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function callLLM(messages, jsonMode = true) {
  const params = {
    model: MODEL,
    messages,
    temperature: 0,
  };
  if (jsonMode) {
    params.response_format = { type: 'json_object' };
  }
  const res = await openai.chat.completions.create(params);
  const content = res.choices?.[0]?.message?.content || '';
  const usage = res.usage || {};

  const result = jsonMode ? (safeJsonParse(content) || { raw: content }) : { raw: content };
  result._tokens = {
    prompt: usage.prompt_tokens || 0,
    completion: usage.completion_tokens || 0,
    total: usage.total_tokens || 0,
  };
  return result;
}

// =============================================================================
// PAGE STRUCTURE EXTRACTION
// =============================================================================

/**
 * Extract structured data from HPA page HTML
 * Returns labeled sections with their embedded data
 */
function extractPageStructure(html, pageUrl) {
  const $ = cheerio.load(html);
  const structure = {
    url: pageUrl,
    sections: [],
    charts: [],
    tables: [],
    keyValues: [],
  };

  const normalizeNumericArray = (values) => {
    if (!Array.isArray(values)) return [];
    return values
      .map(v => (typeof v === 'number' ? v : Number(v)))
      .filter(v => Number.isFinite(v));
  };

  // Remove noise
  $('script[src], link, meta, style, noscript, nav, footer, header').remove();

  // ==========================================================================
  // 1. EXTRACT EMBEDDED CHART DATA FROM INLINE SCRIPTS
  // ==========================================================================
  const scriptTexts = [];
  $('script:not([src])').each((_, el) => {
    const txt = $(el).html() || '';
    if (txt.length > 50) scriptTexts.push({ el, txt });
  });

  // For section detection via raw HTML context
  const htmlLower = html.toLowerCase();

  for (const { el, txt } of scriptTexts) {
    // Extract barChart calls with their IDs
    // Pattern 1: Direct - $('#id').barChart([...],
    // Pattern 2: Variable - var div = $('#id'); ... div.barChart([...],

    // First, find all variable assignments like: var div = $('#cell_line_49');
    const varAssignments = {};
    const varRegex = /var\s+(\w+)\s*=\s*\$\(['"]#([^'"]+)['"]\)/g;
    let varMatch;
    while ((varMatch = varRegex.exec(txt)) !== null) {
      varAssignments[varMatch[1]] = varMatch[2]; // varName -> chartId
    }

    // Pattern 1: Direct calls
    const barChartRegex = /\$\(['"]#([^'"]+)['"]\)\.barChart\s*\(\s*(\[[\s\S]*?\])\s*,/g;
    let match;
    while ((match = barChartRegex.exec(txt)) !== null) {
      const chartId = match[1];
      const dataStr = match[2];
      processChartData(chartId, dataStr);
    }

    // Pattern 2: Variable-based calls (var div = $('#id'); div.barChart([...])
    const varBarChartRegex = /(\w+)\.barChart\s*\(\s*(\[[\s\S]*?\])\s*,/g;
    while ((match = varBarChartRegex.exec(txt)) !== null) {
      const varName = match[1];
      const dataStr = match[2];
      const chartId = varAssignments[varName];
      if (chartId) {
        processChartData(chartId, dataStr);
      }
    }

    function processChartData(chartId, dataStr) {

      // Try to parse the data array
      const data = safeJsonParse(dataStr);
      if (!Array.isArray(data)) return;

      // Find section context by searching raw HTML around the chart div
      let section = chartId; // Default to chart ID
      const chartDivPattern = `id="${chartId}"`;
      const chartPos = html.indexOf(chartDivPattern);

      if (chartPos > 0) {
        const before = html.slice(Math.max(0, chartPos - 6000), chartPos);

        // Find the nearest section header - extract text from th.head elements
        // Use permissive capture to handle nested tags, then strip HTML
        const headers = [...before.matchAll(/<th[^>]*class="[^"]*head[^"]*"[^>]*>([\s\S]*?)<\/th>/gi)];
        if (headers.length > 0) {
          // Use the last (closest) header, strip any nested HTML tags
          const rawHeader = headers[headers.length - 1][1];
          let cleanHeader = rawHeader.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

          // HPA headers often have format "TITLEi description..." - extract just the title
          // The 'i' is a help icon indicator followed by description text
          const titleMatch = cleanHeader.match(/^([A-Z][A-Z &\-]+)i\s/);
          if (titleMatch) {
            cleanHeader = titleMatch[1].trim();
          }

          if (cleanHeader.length >= 2 && cleanHeader.length <= 80) {
            section = cleanHeader;
          }
        }

        // Also check for bold section titles like <b>SECTION NAME</b>
        if (section === chartId) {
          const boldHeaders = [...before.matchAll(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi)];
          for (let i = boldHeaders.length - 1; i >= 0; i--) {
            const clean = boldHeaders[i][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            // Only accept all-caps headers (like "MOUSE", "HUMAN")
            if (clean.length >= 2 && clean.length <= 50 && /^[A-Z][A-Z\s]+$/.test(clean)) {
              section = clean;
              break;
            }
          }
        }
      }

      // Extract clean data points
      const dataPoints = data.map(item => {
        const point = {
          label: item.label || item.name || '',
          value: item.value ?? item.y ?? null,
        };

        // Parse tooltip for additional fields
        if (item.tooltip) {
          const tooltipFields = parseTooltip(item.tooltip);
          Object.assign(point, tooltipFields);
        }

        return point;
      }).filter(p => p.label);

      // Sort by value descending so highest values come first
      dataPoints.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

      structure.charts.push({
        id: chartId,
        section,
        type: 'barChart',
        data: dataPoints,
      });
    }

    // Note: we skip generic JSON array extraction for now - barChart is the main source

    // Pattern 3: boxData objects (cancer expression data with box plots)
    // Format: let boxData = {"Cancer Name": {"url": ..., "data": [values]}, ...}
    const boxDataMatch = txt.match(/let\s+boxData\s*=\s*(\{[\s\S]*?\});/);
    if (boxDataMatch) {
      const boxData = safeJsonParse(boxDataMatch[1]);
      if (boxData && typeof boxData === 'object') {
        // Find section header near boxData in the HTML
        const boxDataPos = html.indexOf('let boxData');
        let section = 'boxplot_data';
        if (boxDataPos > 0) {
          const before = html.slice(Math.max(0, boxDataPos - 3000), boxDataPos);
          const headers = [...before.matchAll(/<th[^>]*class="[^"]*head[^"]*"[^>]*>([\s\S]*?)<\/th>/gi)];
          if (headers.length > 0) {
            let cleanHeader = headers[headers.length - 1][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            const titleMatch = cleanHeader.match(/^([A-Z][A-Z &\-]+)i\s/);
            if (titleMatch) cleanHeader = titleMatch[1].trim();
            if (cleanHeader.length >= 2 && cleanHeader.length <= 80) {
              section = cleanHeader;
            }
          }
        }

        // Helper to compute median
        const median = (arr) => {
          const sorted = [...arr].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        };

        const dataPoints = [];
        for (const [cancerName, info] of Object.entries(boxData)) {
          const numericData = normalizeNumericArray(info?.data);
          if (numericData.length > 0) {
            const med = median(numericData);
            dataPoints.push({
              label: cancerName,
              value: parseFloat(med.toFixed(2)),
              samples: numericData.length,
              unit: 'FPKM',
            });
          }
        }

        if (dataPoints.length > 0) {
          // Sort by median value descending
          dataPoints.sort((a, b) => b.value - a.value);
          structure.charts.push({
            id: `boxplot_${structure.charts.length}`,
            section,
            type: 'boxPlot',
            data: dataPoints,
          });
        }
      }
    }

    // Pattern 4: Inline .boxPlot({...}) calls (blood page SOMAscan data)
    // Format: $('#chartId').boxPlot({"Category": {"label": ..., "data": [values]}, ...}, opts)
    const inlineBoxPlotRegex = /\$\(['"]#([^'"]+)['"]\)\.boxPlot\s*\(\s*(\{[\s\S]*?\})\s*,\s*\{/g;
    let boxPlotMatch;
    while ((boxPlotMatch = inlineBoxPlotRegex.exec(txt)) !== null) {
      const chartId = boxPlotMatch[1];
      const dataStr = boxPlotMatch[2];
      const boxData = safeJsonParse(dataStr);

      if (boxData && typeof boxData === 'object') {
        // Find section header
        const chartPos = html.indexOf(`id="${chartId}"`);
        let section = 'boxplot_data';
        if (chartPos > 0) {
          const before = html.slice(Math.max(0, chartPos - 3000), chartPos);
          const headers = [...before.matchAll(/<th[^>]*class="[^"]*head[^"]*"[^>]*>([\s\S]*?)<\/th>/gi)];
          if (headers.length > 0) {
            let cleanHeader = headers[headers.length - 1][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            const titleMatch = cleanHeader.match(/^([A-Z][A-Z &\-]+)i\s/);
            if (titleMatch) cleanHeader = titleMatch[1].trim();
            if (cleanHeader.length >= 2 && cleanHeader.length <= 80) {
              section = cleanHeader;
            }
          }
        }

        // Helper to compute median
        const median = (arr) => {
          const sorted = [...arr].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        };

        const dataPoints = [];
        for (const [categoryName, info] of Object.entries(boxData)) {
          const numericData = normalizeNumericArray(info?.data);
          if (numericData.length > 0) {
            const med = median(numericData);
            dataPoints.push({
              label: categoryName,
              value: parseFloat(med.toFixed(2)),
              median: parseFloat(med.toFixed(2)),
              samples: numericData.length,
            });
          }
        }

        if (dataPoints.length > 0) {
          // Sort by median value descending
          dataPoints.sort((a, b) => b.value - a.value);
          structure.charts.push({
            id: chartId,
            section,
            type: 'boxPlot',
            data: dataPoints,
          });
        }
      }
    }
  }

  // ==========================================================================
  // 1b. EXTRACT LINK DATA (links with descriptive title attributes)
  // ==========================================================================
  // Group links by their nearest section header
  const linksBySection = new Map();
  const allTitledLinks = html.match(/<a[^>]*title="[^"]{10,}"[^>]*>/gi) || [];

  for (const link of allTitledLinks) {
    const titleMatch = link.match(/title="([^"]+)"/i);
    if (!titleMatch) continue;

    const title = titleMatch[1]
      .replace(/<br\s*\/?>/gi, ' - ')
      .replace(/<[^>]+>/g, '')
      .trim();

    // Skip very short or very long titles (noise)
    if (title.length < 10 || title.length > 300) continue;

    // Find section header by locating this link in the HTML
    const linkPos = html.indexOf(link);
    let section = 'link_data';
    if (linkPos > 0) {
      const before = html.slice(Math.max(0, linkPos - 3000), linkPos);
      const headers = [...before.matchAll(/<th[^>]*class="[^"]*head[^"]*"[^>]*>([\s\S]*?)<\/th>/gi)];
      if (headers.length > 0) {
        let cleanHeader = headers[headers.length - 1][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const headerTitleMatch = cleanHeader.match(/^([A-Z][A-Z &\-]+)i\s/);
        if (headerTitleMatch) cleanHeader = headerTitleMatch[1].trim();
        if (cleanHeader.length >= 2 && cleanHeader.length <= 80) {
          section = cleanHeader;
        }
      }
    }

    if (!linksBySection.has(section)) {
      linksBySection.set(section, []);
    }
    linksBySection.get(section).push({ label: title, value: 'present' });
  }

  // Add each section's links as a separate chart entry
  let linkGroupIdx = 0;
  for (const [section, links] of linksBySection) {
    if (links.length > 0) {
      structure.charts.push({
        id: `link_group_${linkGroupIdx++}`,
        section,
        type: 'links',
        data: links,
      });
    }
  }

  // ==========================================================================
  // 2. EXTRACT TABLES WITH SECTION CONTEXT
  // ==========================================================================
  $('table').each((idx, el) => {
    const $table = $(el);

    // Skip wrapper tables (tables containing other tables)
    if ($table.find('table').length > 0) {
      return; // Skip - this is a layout wrapper
    }

    // Find section context
    let heading = $table.prevAll('h1,h2,h3,h4,h5,h6,th.head').first().text().trim() ||
                    $table.closest('div[id],section').find('h1,h2,h3,h4,h5').first().text().trim() ||
                    $table.find('th.head').first().text().trim();

    const caption = $table.find('caption').first().text().trim();

    // Clean up heading (remove long tooltip text)
    if (heading) {
      heading = heading.split('\n')[0].trim().slice(0, 60);
    }

    let section = caption || heading || `table_${idx}`;

    // Extract headers
    const headers = [];
    const $headerRow = $table.find('thead tr').first().length
      ? $table.find('thead tr').first()
      : $table.find('tr').first();

    $headerRow.find('th, td').each((_, cell) => {
      let headerText = $(cell).text().replace(/\s+/g, ' ').trim();
      // Clean up header (take first line only, limit length)
      headerText = headerText.split('\n')[0].trim().slice(0, 40);
      headers.push(headerText);
    });

    // Extract rows
    const rows = [];
    const $bodyRows = $table.find('tbody tr').length
      ? $table.find('tbody tr')
      : $table.find('tr').slice(1);

    $bodyRows.each((_, tr) => {
      const row = {};
      $(tr).find('th, td').each((i, cell) => {
        const key = headers[i] || `col_${i}`;
        row[key] = $(cell).text().replace(/\s+/g, ' ').trim();
      });
      if (Object.keys(row).length > 0) {
        rows.push(row);
      }
    });

    // Key-value tables (2 columns, first is label)
    if (headers.length === 2 || (headers.length === 0 && rows.length > 0)) {
      const isKeyValue = rows.every(r => Object.keys(r).length === 2);
      if (isKeyValue && rows.length >= 2 && rows.length <= 30) {
        for (const row of rows) {
          const keys = Object.keys(row);
          const key = row[keys[0]] || '';
          const value = row[keys[1]] || '';
          // Include if value is present (key can be empty for descriptive rows)
          if (value && value.length > 3 && (key.length === 0 || key.length < 100)) {
            structure.keyValues.push({ section, key: key || '(info)', value });
          }
        }
      }
    }

    if (rows.length > 0 && headers.length > 0) {
      structure.tables.push({
        section,
        headers: headers.slice(0, 20),
        rowCount: rows.length,
        sample: rows.slice(0, 15), // Show more rows initially
        fullRows: rows.slice(0, 50), // Store more rows for expansion
      });
    }
  });

  // ==========================================================================
  // 2b. EXTRACT SUMMARY TEXT FROM COLSPAN CELLS
  // ==========================================================================
  // These cells often contain important summary text
  $('td[colspan]').each((_, el) => {
    const $td = $(el);
    const text = $td.text().replace(/\s+/g, ' ').trim();
    // Look for cells with meaningful content (not too short, not too long)
    if (text.length > 50 && text.length < 800) {
      // Find section context from nearest header
      let section = 'summary_text';
      const $section = $td.closest('table').prevAll('th.head, h3, h4').first();
      if ($section.length) {
        section = $section.text().replace(/\s+/g, ' ').trim().slice(0, 50);
      }
      // Also check for bold header in same table
      const boldHeader = $td.closest('table').find('td.bold').first().text().trim();
      if (boldHeader) {
        section = boldHeader.slice(0, 50);
      }

      // Store full text content - let LLM extract relevant info
      structure.keyValues.push({
        section,
        key: 'description',
        value: text
      });
    }
  });

  // ==========================================================================
  // 3. EXTRACT SECTION HEADINGS AND THEIR CONTENT
  // ==========================================================================
  $('h1, h2, h3, h4, th.head').each((_, el) => {
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text.length > 3 && text.length < 200) {
      structure.sections.push(text);
    }
  });

  return structure;
}

/**
 * Find the section heading for a chart by its ID
 */
function findChartSection($, chartId) {
  // Look for the chart container and find its section heading
  const $container = $(`#${chartId}`).closest('div[class], td, section');
  if (!$container.length) return null;

  // Check parent containers for section headings
  let $parent = $container;
  for (let i = 0; i < 10; i++) {
    // Look for bold text, headings, or section markers
    const heading = $parent.find('div[style*="font-weight:bold"], b, strong, h3, h4, h5')
      .first().text().replace(/\s+/g, ' ').trim();
    if (heading && heading.length > 3 && heading.length < 100) {
      return heading;
    }

    // Look for preceding heading
    const prevHeading = $parent.prev('h1,h2,h3,h4,h5,th.head,div[style*="bold"]')
      .text().replace(/\s+/g, ' ').trim();
    if (prevHeading && prevHeading.length > 3) {
      return prevHeading;
    }

    $parent = $parent.parent();
    if (!$parent.length) break;
  }

  return null;
}

function findNearestHeading($, $el) {
  let $parent = $el.parent();
  for (let i = 0; i < 15; i++) {
    const h = $parent.prevAll('h1,h2,h3,h4,h5').first().text().trim();
    if (h && h.length > 2 && h.length < 150) return h;
    $parent = $parent.parent();
    if (!$parent.length) break;
  }
  return null;
}

function findNearestSection($, $el) {
  let $parent = $el.parent();
  for (let i = 0; i < 15; i++) {
    // Look for section markers
    const bold = $parent.find('div[style*="bold"], b, strong').first().text().trim();
    if (bold && bold.length > 3 && bold.length < 100) return bold;

    const thHead = $parent.find('th.head').first().text().trim();
    if (thHead && thHead.length > 2) return thHead;

    $parent = $parent.parent();
    if (!$parent.length) break;
  }
  return null;
}

function parseTooltip(tooltipHtml) {
  if (!tooltipHtml) return {};
  const text = String(tooltipHtml)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

  const fields = {};
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([^:]{1,30}):\s*(.+)$/);
    if (match) {
      fields[match[1].trim()] = match[2].trim();
    }
  }
  return fields;
}

// =============================================================================
// FORMAT STRUCTURED DATA FOR LLM
// =============================================================================

function formatStructureForLLM(structure, maxChars = 12000) {
  const parts = [];

  parts.push(`PAGE: ${structure.url}\n`);

  // Format charts with their section context
  // IMPORTANT: Sort charts so meaningfully labeled sections come FIRST
  // A chart is "labeled" if its section is different from its chart ID
  if (structure.charts.length > 0) {
    const sortedCharts = [...structure.charts].sort((a, b) => {
      // A section is meaningful if it's not just the chart ID
      const aLabeled = a.section && a.section !== a.id && a.section !== 'unknown' ? 1 : 0;
      const bLabeled = b.section && b.section !== b.id && b.section !== 'unknown' ? 1 : 0;
      return bLabeled - aLabeled; // Meaningful labels first
    });

    parts.push('\n=== CHART DATA ===');
    for (const chart of sortedCharts) {
      parts.push(`\n[${chart.section || 'Unknown Section'}] (${chart.id})`);
      for (const point of chart.data.slice(0, 50)) {
        const extras = [];
        if (point.nTPM) extras.push(`nTPM: ${point.nTPM}`);
        if (point.Organ) extras.push(`Organ: ${point.Organ}`);
        if (point.Samples) extras.push(`Samples: ${point.Samples}`);
        const extraStr = extras.length ? ` (${extras.join(', ')})` : '';
        parts.push(`  - ${point.label}: ${point.value}${extraStr}`);
      }
      if (chart.data.length > 50) {
        parts.push(`  ... and ${chart.data.length - 50} more`);
      }
    }
  }

  // Format key-value data
  if (structure.keyValues.length > 0) {
    parts.push('\n=== KEY-VALUE DATA ===');
    const bySection = {};
    for (const kv of structure.keyValues) {
      const sec = kv.section || 'General';
      if (!bySection[sec]) bySection[sec] = [];
      bySection[sec].push(kv);
    }
    for (const [section, kvs] of Object.entries(bySection)) {
      parts.push(`\n[${section}]`);
      for (const kv of kvs.slice(0, 20)) {
        parts.push(`  ${kv.key}: ${kv.value}`);
      }
    }
  }

  // Format tables
  if (structure.tables.length > 0) {
    parts.push('\n=== TABLES ===');
    for (const table of structure.tables.slice(0, 10)) {
      parts.push(`\n[${table.section}] (${table.rowCount} rows)`);
      parts.push(`  Headers: ${table.headers.join(' | ')}`);
      if (table.sample.length > 0) {
        parts.push('  Sample rows:');
        for (const row of table.sample.slice(0, 10)) {
          const vals = Object.values(row).slice(0, 6).join(' | ');
          parts.push(`    ${vals}`);
        }
        if (table.rowCount > 10) {
          parts.push(`    ... (${table.rowCount - 10} more rows available)`);
        }
      }
    }
  }

  let result = parts.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n...(truncated)';
  }
  return result;
}

// =============================================================================
// MAIN AGENT
// =============================================================================

const PAGES = {
  '': '',
  tissue: '/tissue',
  brain: '/brain',
  'single+cell': '/single+cell',
  subcellular: '/subcellular',
  cancer: '/cancer',
  blood: '/blood',
  'cell+line': '/cell+line',
  structure: '/structure',
  interaction: '/interaction',
};

async function investigationAgentV3(args, ctx = {}) {
  const { gene, question } = args;
  const onStep = ctx.onStep || (() => {});

  if (!gene) return { found: false, error: 'No gene provided' };

  const q = question || `Tell me about ${gene}`;

  // Token tracking
  const tokenUsage = {
    pageSelection: { prompt: 0, completion: 0, total: 0 },
    reasoning: { prompt: 0, completion: 0, total: 0 },
    total: { prompt: 0, completion: 0, total: 0 },
  };

  // ==========================================================================
  // 1. RESOLVE GENE
  // ==========================================================================
  let geneData;
  try {
    const searchUrl = `https://www.proteinatlas.org/search/${encodeURIComponent(gene)}?format=json&download=yes`;
    const searchData = await fetchJson(searchUrl);
    if (!Array.isArray(searchData) || !searchData.length) {
      return { found: false, error: 'Gene not found in HPA' };
    }
    const geneRow = searchData.find(g => (g.Gene || '').toUpperCase() === gene.toUpperCase()) || searchData[0];
    geneData = {
      name: geneRow.Gene,
      ensembl: geneRow.Ensembl,
      baseUrl: `https://www.proteinatlas.org/${geneRow.Ensembl}-${geneRow.Gene}`,
    };
  } catch (err) {
    return { found: false, error: `Gene search failed: ${err.message}` };
  }

  onStep({ stage: 'selection_step', label: 'Resolved', message: `${geneData.name} (${geneData.ensembl})` });

  // ==========================================================================
  // 2. ASK LLM: WHICH PAGE(S) TO FETCH?
  // ==========================================================================
  const pageSelectionPrompt = `You are analyzing a question about gene ${geneData.name} on the Human Protein Atlas.

QUESTION: "${q}"

Available HPA pages:
- "" (main/summary): Gene overview, protein class, basic info
- tissue: Tissue expression (nTPM values across tissues)
- brain: Brain expression (Human brain, Mouse brain, Pig brain datasets)
- blood: Blood protein assays (SomaScan, Olink) - NOT for cell type clusters
- cell+line: Cell line expression (cancer cell lines, HeLa, etc.)
- subcellular: Subcellular location (nucleus, cytoplasm, etc.)
- cancer: Cancer/tumor data, prognostic markers
- interaction: Protein-protein interactions (BioPlex, IntAct, BioGrid)
- structure: Protein structure, domains, variants
- single+cell: Single cell type expression, IMMUNE CELL expression clusters, expression clustering (cluster membership, genes in cluster)

Which page(s) should I fetch to answer this question? Return 1-2 most relevant pages.

Return JSON: { "pages": ["page1", "page2"], "reasoning": "why these pages" }`;

  onStep({ stage: 'planning_step', label: 'Selecting', message: 'Determining which pages to fetch...' });

  const pageSelection = await callLLM([
    { role: 'user', content: pageSelectionPrompt }
  ]);

  // Track tokens
  if (pageSelection._tokens) {
    tokenUsage.pageSelection = pageSelection._tokens;
    tokenUsage.total.prompt += pageSelection._tokens.prompt;
    tokenUsage.total.completion += pageSelection._tokens.completion;
    tokenUsage.total.total += pageSelection._tokens.total;
  }

  const pagesToFetch = Array.isArray(pageSelection.pages)
    ? pageSelection.pages.filter(p => p in PAGES).slice(0, 2)
    : [''];

  if (pagesToFetch.length === 0) pagesToFetch.push('');

  onStep({ stage: 'planning_step', label: 'Pages', message: pagesToFetch.join(', ') || 'main' });
  onStep({ stage: 'tokens', label: 'Page Select', message: `${tokenUsage.pageSelection.total} (${tokenUsage.pageSelection.prompt} in + ${tokenUsage.pageSelection.completion} out)` });

  // ==========================================================================
  // 3. FETCH AND EXTRACT STRUCTURED DATA
  // ==========================================================================
  const allStructures = [];

  for (const pageKey of pagesToFetch) {
    const pageUrl = geneData.baseUrl + PAGES[pageKey];
    onStep({ stage: 'execution_step', label: 'Fetching', message: pageKey || 'main' });

    try {
      const html = await fetchHtml(pageUrl);
      onStep({ stage: 'fetch', label: 'Downloaded', message: `${(html.length / 1024).toFixed(0)}KB HTML` });

      const structure = extractPageStructure(html, pageUrl);
      allStructures.push({ pageKey: pageKey || 'main', structure });

      // Show what was found
      onStep({ stage: 'extract', label: 'Charts', message: `${structure.charts.length} found` });
      onStep({ stage: 'extract', label: 'Tables', message: `${structure.tables.length} found` });
    } catch (err) {
      onStep({ stage: 'error', label: 'Fetch Error', message: err.message });
    }
  }

  if (allStructures.length === 0) {
    return { found: false, error: 'Failed to fetch any pages' };
  }

  // ==========================================================================
  // 4. FORMAT DATA AND ASK LLM TO ANSWER
  // ==========================================================================
  let structuredData = '';
  for (const { pageKey, structure } of allStructures) {
    structuredData += `\n\n========== ${pageKey.toUpperCase() || 'MAIN'} PAGE ==========\n`;
    structuredData += formatStructureForLLM(structure, 12000);
  }

  // Build list of available tables for the LLM to request
  const availableTables = [];
  for (const { pageKey, structure } of allStructures) {
    for (const table of structure.tables) {
      availableTables.push({
        page: pageKey,
        section: table.section,
        headers: table.headers.slice(0, 5),
        rowCount: table.rowCount,
      });
    }
  }

  const tableListStr = availableTables.length > 0
    ? `\n\nAVAILABLE TABLES (you can request more rows):\n${availableTables.map((t, i) =>
        `  [${i}] ${t.page}/${t.section} (${t.rowCount} rows) - Headers: ${t.headers.slice(0, 3).join(', ')}`
      ).join('\n')}`
    : '';

  const answerPrompt = `You are answering a question about gene ${geneData.name} using structured data extracted from the Human Protein Atlas.

QUESTION: "${q}"

EXTRACTED DATA:
${structuredData}${tableListStr}

CRITICAL RULES:
- ONLY use data that is EXPLICITLY present in the EXTRACTED DATA above
- NEVER use prior knowledge, training data, or assumptions to fill in missing values
- If you cannot find the EXACT answer in the extracted data, set found: false
- Do NOT guess, estimate, or infer values that are not explicitly stated

INSTRUCTIONS:
1. Find the data that answers the question IN THE EXTRACTED DATA ABOVE
2. Section labels in [BRACKETS] come from the page headers - match keywords in section names to the question
3. Be precise - return the exact value from the data
4. If you see a relevant table but need MORE ROWS from it, set need_more_table to the table index number
5. If you cannot find the answer in the data, set found: false and explain what's missing

Return JSON:
{
  "found": true/false,
  "answer": "your answer with the specific value",
  "source_section": "which section the data came from",
  "confidence": "high/medium/low",
  "notes": ["observation 1", "observation 2", "..."],  // What you noticed while scanning the data
  "extracted_value": "the exact value/number extracted (if applicable)",
  "reasoning": "brief explanation of how you found it",
  "need_more_table": null or table index number if you need more rows from a specific table,
  "chart_id": "SINGLE chart container ID where you found the value — the parenthesised id next to the section name, e.g. 'tissue_49'. Return ONLY ONE id, never multiple.",
  "exact_label": "the EXACT label text (left of the colon) of the data point you read, copied verbatim. e.g. 'kidney', 'cerebral cortex'. Do NOT include the value or units — ONLY the label."
}`;

  onStep({ stage: 'llm', label: 'Analyzing', message: `${(structuredData.length / 1024).toFixed(1)}KB data, ${availableTables.length} tables` });

  let answer = await callLLM([
    { role: 'user', content: answerPrompt }
  ]);

  // Show what the LLM observed/noted
  if (Array.isArray(answer.notes) && answer.notes.length > 0) {
    for (const note of answer.notes.slice(0, 5)) {
      onStep({ stage: 'note', label: 'Observed', message: note });
    }
  }

  // Show the extracted value if any
  if (answer.extracted_value) {
    onStep({ stage: 'extract', label: 'Value Found', message: answer.extracted_value });
  }

  // Show source
  if (answer.source_section) {
    onStep({ stage: 'source', label: 'From Section', message: answer.source_section });
  }

  // Show reasoning
  if (answer.reasoning) {
    onStep({ stage: 'reasoning', label: 'Logic', message: answer.reasoning });
  }

  // If LLM needs more data from a specific table, expand it and retry
  if (answer.need_more_table !== null && answer.need_more_table !== undefined && !answer.found) {
    const tableIdx = parseInt(answer.need_more_table, 10);
    if (tableIdx >= 0 && tableIdx < availableTables.length) {
      const targetTable = availableTables[tableIdx];
      onStep({ stage: 'expansion', label: 'Expanding', message: `Table ${tableIdx}: ${targetTable.section}` });

      // Find and expand this table with full rows
      let expandedData = structuredData;
      for (const { pageKey, structure } of allStructures) {
        if (pageKey === targetTable.page) {
          const table = structure.tables.find(t => t.section === targetTable.section);
          if (table && table.fullRows) {
            // Add full table data
            expandedData += `\n\n=== EXPANDED TABLE: ${targetTable.section} (${table.fullRows.length} rows) ===\n`;
            expandedData += `Headers: ${table.headers.join(' | ')}\n`;
            for (const row of table.fullRows) {
              expandedData += Object.values(row).join(' | ') + '\n';
            }
          }
        }
      }

      // Retry with expanded data
      const retryPrompt = `You are answering a question about gene ${geneData.name}. Here is the data with the requested table expanded:

QUESTION: "${q}"

${expandedData}

Return JSON:
{
  "found": true/false,
  "answer": "your answer with the specific value",
  "source_section": "which section the data came from",
  "confidence": "high/medium/low",
  "reasoning": "brief explanation of how you found it"
}`;

      const retryAnswer = await callLLM([{ role: 'user', content: retryPrompt }]);

      // Track tokens
      if (retryAnswer._tokens) {
        tokenUsage.reasoning.prompt += retryAnswer._tokens.prompt;
        tokenUsage.reasoning.completion += retryAnswer._tokens.completion;
        tokenUsage.reasoning.total += retryAnswer._tokens.total;
        tokenUsage.total.prompt += retryAnswer._tokens.prompt;
        tokenUsage.total.completion += retryAnswer._tokens.completion;
        tokenUsage.total.total += retryAnswer._tokens.total;
      }

      answer = retryAnswer;
      onStep({ stage: 'tokens', label: 'Retry', message: `+${retryAnswer._tokens?.total || 0} (${retryAnswer._tokens?.prompt || 0} in + ${retryAnswer._tokens?.completion || 0} out)` });
    }
  }

  // Track tokens
  if (answer._tokens) {
    tokenUsage.reasoning = answer._tokens;
    tokenUsage.total.prompt += answer._tokens.prompt;
    tokenUsage.total.completion += answer._tokens.completion;
    tokenUsage.total.total += answer._tokens.total;
  }

  onStep({ stage: 'tokens', label: 'Reasoning', message: `${tokenUsage.reasoning.total} (${tokenUsage.reasoning.prompt} in + ${tokenUsage.reasoning.completion} out)` });
  onStep({ stage: 'tokens', label: 'Total', message: `${tokenUsage.total.total} (${tokenUsage.total.prompt} in + ${tokenUsage.total.completion} out)` });

  // Build citations
  const citations = [];
  for (const { pageKey, structure } of allStructures) {
    citations.push({
      page: pageKey || 'main',
      url: structure.url,
      charts: structure.charts.length,
      tables: structure.tables.length,
    });
  }

  // ==========================================================================
  // 5. VALIDATION STEP - Transparent check before completing
  // ==========================================================================
  onStep({ stage: 'validation', label: 'Checking', message: 'Validating answer quality...' });

  const validationChecks = [];

  // Check 1: Did we find something?
  if (answer.found) {
    validationChecks.push({ check: 'Answer found', pass: true });
  } else {
    validationChecks.push({ check: 'Answer found', pass: false, reason: 'No matching data in extracted content' });
  }

  // Check 2: Do we have a source?
  if (answer.source_section) {
    validationChecks.push({ check: 'Source identified', pass: true, detail: answer.source_section });
  } else if (answer.found) {
    validationChecks.push({ check: 'Source identified', pass: false, reason: 'No source section specified' });
  }

  // Check 3: Confidence level
  const confidence = answer.confidence || 'unknown';
  if (confidence === 'high') {
    validationChecks.push({ check: 'Confidence', pass: true, detail: 'HIGH' });
  } else if (confidence === 'medium') {
    validationChecks.push({ check: 'Confidence', pass: true, detail: 'MEDIUM' });
  } else {
    validationChecks.push({ check: 'Confidence', pass: false, detail: confidence.toUpperCase() });
  }

  // Check 4: Does the answer contain a value (for numeric queries)?
  const hasNumericValue = /\d+\.?\d*/.test(answer.answer || '');
  const questionWantsNumber = /ntpm|value|expression|how many|count/i.test(q);
  if (questionWantsNumber) {
    if (hasNumericValue) {
      validationChecks.push({ check: 'Numeric value', pass: true, detail: 'Contains number' });
    } else if (answer.found) {
      validationChecks.push({ check: 'Numeric value', pass: false, reason: 'Question expects number but none found' });
    }
  }

  // Emit validation results
  for (const v of validationChecks) {
    const status = v.pass ? '✓' : '✗';
    const detail = v.detail || v.reason || '';
    onStep({ stage: 'validation', label: `${status} ${v.check}`, message: detail });
  }

  const passedChecks = validationChecks.filter(v => v.pass).length;
  const totalChecks = validationChecks.length;
  onStep({ stage: 'validation', label: 'Result', message: `${passedChecks}/${totalChecks} checks passed` });

  const result = {
    found: answer.found === true,
    answer: answer.answer || '',
    source_section: answer.source_section || null,
    confidence: answer.confidence || 'unknown',
    reasoning: answer.reasoning || '',
    extracted_value: answer.extracted_value || null,
    notes: answer.notes || [],
    chart_id: answer.chart_id || null,
    exact_label: answer.exact_label || null,
    gene: geneData.name,
    ensembl: geneData.ensembl,
    baseUrl: geneData.baseUrl,
    pages_fetched: pagesToFetch,
    citations,
    tokens: tokenUsage,
    validation: { passed: passedChecks, total: totalChecks, checks: validationChecks },
  };

  onStep({
    stage: result.found ? 'complete' : 'not_found',
    label: result.found ? 'Answer' : 'Not Found',
    message: result.answer || 'Could not find answer in extracted data'
  });

  // Emit citation step
  if (citations.length > 0) {
    const citationStr = citations.map(c => `${c.url}`).join(', ');
    onStep({ stage: 'citation', label: 'Sources', message: citationStr });
  }

  return result;
}

module.exports = investigationAgentV3;
