'use strict';

const OpenAI = require('openai');
const path = require('path');
const deepResearch = require('./deepResearch');
const investigationAgent = require('./investigationAgentV3');
const { createWorkspace, updateWorkspace, resolveWorkspaceRoot } = require('../aso/workspaceStore');
const { registerArtifact } = require('../aso/artifactStore');
const { createLogger } = require('../aso/logger');
const { normalizeRows } = require('../aso/cleaners/normalize');
const { rankTopX } = require('../aso/cleaners/rankTopX');
const { diffSets } = require('../aso/cleaners/merge');
const { inspectSearchUrl } = require('../aso/inspectors/inspectArtifact');
const { rankArray, compareDelta, aggregate, mergeLongFormat, joinScatter, joinScatterAll, pivotMatrix } = require('../aso/ops');
const { renderCharts } = require('../aso/pipelines/renderCharts');
const { writeReport } = require('../aso/pipelines/report');
const { measureDirect } = require('../aso/directMeasure');

// DEFAULT_TOP_X: what to use when no one specifies (0 = all)
// MAX_TOP_X: hard ceiling, never exceed this (0 = no cap)
const DEFAULT_TOP_X = 0;
const MAX_TOP_X = 500;

const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
const baseURL = process.env.GEMINI_BASE_URL || process.env.OPENAI_BASE_URL;
const openai = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });
const MODEL = process.env.HPA_MODEL;
const LOG_TOOL_STEPS = process.env.HPA_ASO_LOG_TOOL_STEPS === 'true';

// =============================================================================
// TOOL DEFINITIONS — native function calling, no more freeform JSON parsing
// =============================================================================

const ASO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'deep_research_hpa',
      description: 'Run a broad HPA search to discover gene lists or expression datasets. Returns an artifact with rows of gene data.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What to search for in HPA (e.g. "kidney-enriched transporter genes")' },
          purpose: { type: 'string', description: 'Why this search is needed for the objective' }
        },
        required: ['goal'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'investigator_hpa',
      description: 'Look up a specific gene on HPA to answer a detailed question. Fetches the gene page and extracts data.',
      parameters: {
        type: 'object',
        properties: {
          gene: { type: 'string', description: 'Gene symbol (e.g. SLC22A6)' },
          ensembl: { type: 'string', description: 'Ensembl ID (optional)' },
          question: { type: 'string', description: 'Question to answer about this gene' }
        },
        required: ['gene', 'question'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clean_topx',
      description: 'Extract and normalize genes from a search tool_result. Omit top_x to keep ALL genes. Only set top_x if the user explicitly requests a limit.',
      parameters: {
        type: 'object',
        properties: {
          source_ids: { type: 'array', items: { type: 'string' }, description: 'Artifact UUIDs of tool_results to clean. Omit to use all available.' },
          top_x: { type: 'number', description: 'Max genes to keep. Omit to keep all. Only limit if user requests it.' },
          label: { type: 'string', description: 'Human-readable label for this dataset' }
        },
        required: ['label'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clean_diff',
      description: 'Compare two gene list datasets. Returns three lists: only-in-A, only-in-B, and overlap.',
      parameters: {
        type: 'object',
        properties: {
          dataset_a: { type: 'string', description: 'First dataset artifact UUID' },
          dataset_b: { type: 'string', description: 'Second dataset artifact UUID' },
          top_x: { type: 'number', description: 'Max genes per list (default: 20)' },
          label: { type: 'string', description: 'Label for this diff operation' }
        },
        required: ['dataset_a', 'dataset_b'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'inspect',
      description: 'Peek at rows from a tool_result to see its structure, columns, and sample data before deciding how to process it.',
      parameters: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Artifact UUID to inspect' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Specific fields to extract' },
          limit: { type: 'number', description: 'Max rows to return (default: 25, max: 100)' }
        },
        required: ['source_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'measure',
      description: 'For each gene, look up a specific value from HPA. Provide either dataset_id (gene list from prior search) OR genes (inline gene names — use when you already know the genes). FAST PATH: provide tissue + page for direct extraction (no LLM, ~20x cheaper). FULL PATH: provide only question for ad-hoc investigator queries.',
      parameters: {
        type: 'object',
        properties: {
          dataset_id: { type: 'string', description: 'Source dataset artifact UUID containing the gene list. Use this when genes come from a prior search/clean step.' },
          genes: { type: 'array', items: { type: 'string' }, description: 'Inline gene names (e.g. ["GFAP", "TP53"]). Use this when you already know the gene names — skips search entirely.' },
          tissue: { type: 'string', description: 'Tissue label to extract (e.g. "kidney", "brain", "liver"). When provided, uses fast direct extraction — no LLM calls, just page fetch + parse. Strongly preferred for RNA expression measurements.' },
          page: { type: 'string', enum: ['tissue', 'brain', 'blood', 'cancer', 'cell+line', 'single+cell', 'subcellular'], description: 'HPA page to fetch (default: "tissue"). Use "brain" for brain-region data, "tissue" for organ-level expression.' },
          question: { type: 'string', description: 'Question template with {gene} placeholder. Only needed for ad-hoc queries where tissue param is not sufficient. Example: "What is the subcellular location of {gene}?"' },
          max_genes: { type: 'number', description: 'Max genes to query (default: 20)' },
          label: { type: 'string', description: 'Label for this measurement set' },
          value_type: { type: 'string', description: 'Expected value type (e.g. nTPM, score)' },
          unit: { type: 'string', description: 'Unit of measurement' }
        },
        required: ['label'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_rank',
      description: 'Rank rows in a dataset by a numeric column. Produces a new sorted dataset.',
      parameters: {
        type: 'object',
        properties: {
          dataset_id: { type: 'string', description: 'Dataset artifact UUID to rank' },
          key: { type: 'string', description: 'Column to rank by (default: value)' },
          order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default: desc)' },
          top: { type: 'number', description: 'Keep top N results. Omit to keep ALL rows. Only set if user explicitly requests a limit.' },
          label: { type: 'string', description: 'Label for the ranked result' }
        },
        required: ['dataset_id', 'label'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_delta',
      description: 'Compute value differences between two datasets for rows present in both (matched by join_key).',
      parameters: {
        type: 'object',
        properties: {
          dataset_a: { type: 'string', description: 'First dataset artifact UUID' },
          dataset_b: { type: 'string', description: 'Second dataset artifact UUID' },
          key: { type: 'string', description: 'Value column to diff (default: value)' },
          join_key: { type: 'string', description: 'Row identity field to join on (default: gene)' },
          label: { type: 'string', description: 'Label for the delta result' }
        },
        required: ['dataset_a', 'dataset_b', 'label'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_aggregate',
      description: 'Compute an aggregate statistic (mean, median, min, max) over a dataset column.',
      parameters: {
        type: 'object',
        properties: {
          dataset_id: { type: 'string', description: 'Dataset artifact UUID' },
          key: { type: 'string', description: 'Column to aggregate (default: value)' },
          metric: { type: 'string', enum: ['mean', 'median', 'min', 'max'], description: 'Aggregation function' },
          label: { type: 'string', description: 'Label for the result' }
        },
        required: ['dataset_id', 'metric', 'label'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_merge',
      description: 'Combine N datasets into long format for grouped/stacked charts. Each dataset becomes a group. Output rows have {join_key, value, group} — feed directly to chart tool.',
      parameters: {
        type: 'object',
        properties: {
          datasets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                dataset_id: { type: 'string', description: 'Dataset artifact UUID' },
                label: { type: 'string', description: 'Group label (e.g. "Kidney", "Brain")' }
              },
              required: ['dataset_id', 'label']
            },
            description: 'Array of {dataset_id, label} to merge'
          },
          join_key: { type: 'string', description: 'Row identity field to join on (default: gene)' },
          value_key: { type: 'string', description: 'Numeric value field to extract (default: value)' },
          label: { type: 'string', description: 'Label for the merged dataset' }
        },
        required: ['datasets', 'label'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_scatter',
      description: 'Build scatter x/y data from measurement datasets. Pass ALL x-axis measurement IDs in dataset_a and ALL y-axis measurement IDs in dataset_b — single UUID or array of UUIDs. Rows are auto-concatenated per side then joined by gene name into {label, x, y}.',
      parameters: {
        type: 'object',
        properties: {
          dataset_a: { description: 'X-axis: single measurement UUID (string) or array of UUIDs. Multiple datasets are concatenated before joining.' },
          dataset_b: { description: 'Y-axis: single measurement UUID (string) or array of UUIDs. Multiple datasets are concatenated before joining.' },
          join_key: { type: 'string', description: 'Row identity field to match on (default: gene)' },
          value_key: { type: 'string', description: 'Numeric value field (default: value)' },
          mode: { type: 'string', enum: ['overlap', 'all'], description: 'overlap (default): only genes present in both sides. all: all genes, missing side gets 0.' },
          label: { type: 'string', description: 'Label for the scatter dataset' }
        },
        required: ['dataset_a', 'dataset_b', 'label'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_matrix',
      description: 'Pivot a merged long-format dataset into a matrix for heatmaps. Rows=entities (genes), columns=groups (tissues). Use top_n to keep only the top N rows ranked by max value across columns. Feed directly to chart type=heatmap.',
      parameters: {
        type: 'object',
        properties: {
          dataset_id: { type: 'string', description: 'Merged dataset artifact UUID (from analyze_merge)' },
          row_key: { type: 'string', description: 'Field for row labels (default: gene)' },
          col_key: { type: 'string', description: 'Field for column labels (default: group)' },
          value_key: { type: 'string', description: 'Numeric value field (default: value)' },
          top_n: { type: 'number', description: 'Keep only top N rows by max value (e.g. 20-30 for readable heatmaps). ALWAYS use this for heatmaps.' },
          rank_by_col: { type: 'string', description: 'Rank rows by value in this specific column/group (e.g. "Spleen"). If omitted, ranks by max across all columns.' },
          label: { type: 'string', description: 'Label for the matrix dataset' }
        },
        required: ['dataset_id', 'label'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_concat',
      description: 'Concatenate rows from multiple datasets into one. Use when you need to combine results from separate pipelines before charting (e.g. two scatter results, two ranked lists, measurements from different gene sets). Rows are appended in order; all columns are preserved.',
      parameters: {
        type: 'object',
        properties: {
          dataset_ids: { type: 'array', items: { type: 'string' }, description: 'Array of dataset artifact UUIDs to concatenate' },
          label: { type: 'string', description: 'Label for the combined dataset' }
        },
        required: ['dataset_ids', 'label'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'chart',
      description: 'Render a chart from a dataset. Data must already be in chart-ready shape. ALWAYS provide x_label and y_label for readable axes.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['bar', 'lollipop', 'diverging_bar', 'dot_plot', 'scatter', 'bubble', 'line', 'grouped_bar', 'stacked_bar', 'box', 'heatmap', 'radar', 'waterfall', 'volcano', 'ridge'], description: 'Chart type. lollipop=ranked horizontal stems+dots (better than bar for 15+ items). diverging_bar=bars left/right from zero (fold change, enrichment). bubble=scatter with size dimension. radar=polygon profiles across axes. waterfall=cascading changes. volcano=fold-change vs significance. ridge=overlapping distributions.' },
          source_dataset: { type: 'string', description: 'Dataset artifact UUID to visualize' },
          title: { type: 'string', description: 'Chart title' },
          x: { type: 'string', description: 'X-axis column (default: gene)' },
          y: { type: 'string', description: 'Y-axis column (default: value)' },
          x_label: { type: 'string', description: 'X-axis label (e.g. "Gene", "Kidney nTPM")' },
          y_label: { type: 'string', description: 'Y-axis label (e.g. "Expression (nTPM)", "Delta")' },
          series: { type: 'string', description: 'Series column (for scatter/line)' },
          group: { type: 'string', description: 'Group column (for grouped_bar/stacked_bar/box/ridge)' },
          size: { type: 'string', description: 'Size column for bubble charts' },
          color: { type: 'string', description: 'Color column for bubble charts' },
          color_label: { type: 'string', description: 'Label for the color legend (bubble charts)' },
          fc_threshold: { type: 'number', description: 'Fold-change threshold for volcano plots (default: 1.0)' },
          sig_threshold: { type: 'number', description: 'Significance threshold (-log10 p) for volcano plots (default: 1.3)' },
        },
        required: ['type', 'source_dataset', 'title'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Complete the analysis and generate the final report. The summary MUST include specific gene names, values, and rankings — not a description of what tools were called.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Specific findings with concrete data: gene names, numeric values, rankings, and comparisons. Example: "FXYD2 showed the largest kidney-liver delta (3,751 nTPM). 18 of 20 kidney-enriched genes had near-zero liver expression."' }
        },
        required: ['summary'],
        additionalProperties: false
      }
    }
  }
];

const SYSTEM_PROMPT = [
  'You are ASO (Autonomous Scientific Orchestrator), an AI agent that performs biological data analysis using the Human Protein Atlas (HPA).',
  '',
  'You work step-by-step toward a research objective. At each step, EXPLAIN YOUR REASONING, then call tools.',
  '',
  'Typical pipeline:',
  '1. Search: deep_research_hpa to find gene lists',
  '2. Clean: clean_topx to extract genes — keep ALL results by default, or use top_x if user specifies a limit',
  '3. Measure: measure ALL genes (direct mode is cheap — 1 LLM call + N page fetches)',
  '4. Rank: analyze_rank to select the actual top N by measured expression value',
  '5. Analyze: analyze_merge / analyze_scatter / analyze_matrix to shape data for charts',
  '6. Chart: chart to render (data must already be chart-ready)',
  '7. Finish: finish with SPECIFIC findings — gene names, values, rankings',
  '',
  'KEY PRINCIPLE — measure broadly, rank after:',
  '- Do NOT limit clean_topx arbitrarily. HPA search results are often alphabetical, so top 20 = first 20 alphabetically, NOT most relevant.',
  '- Instead: clean_topx (keep all) → measure all → analyze_rank to sort by measured expression. If user asks for "top 40", use analyze_rank(top=40). If user does NOT specify a number, do NOT set top — omitting top keeps ALL rows.',
  '- Direct measure is cheap: 1 LLM call for the first gene (scout), then pure HTTP+parse for the rest. 500 genes ≈ same cost as 20.',
  '',
  'ANALYSIS PIPELINES — pick the right one for your visualization:',
  '',
  'Grouped bar (tissue A vs B): measure A → measure B → analyze_merge(labels=["Tissue A","Tissue B"]) → chart(type=grouped_bar, group="group")',
  'Scatter (compare condition A vs condition B): for EVERY gene set, measure condition A AND condition B. Then: analyze_scatter(dataset_a=[all condition-A measurement IDs], dataset_b=[all condition-B measurement IDs]) → chart(type=scatter). dataset_a/dataset_b accept a single UUID or array — rows are auto-concatenated per side then inner-joined by gene. IMPORTANT: pass raw MEASUREMENT datasets only, NOT ranked/merged/analysis outputs.',
  'Heatmap (genes × tissues matrix): measure all genes per tissue → analyze_merge → analyze_matrix(top_n=20, rank_by_col="Spleen") → chart(type=heatmap)',
  '  analyze_matrix has top_n to keep only the top N rows for a readable heatmap. ALWAYS use top_n=20-30.',
  '  Use rank_by_col to rank by the primary tissue of interest (e.g. rank_by_col="Spleen" to find spleen-enriched genes).',
  'Bar/Lollipop (single ranked list): measure ALL → analyze_rank(top=N) → chart(type=lollipop) — use lollipop for 15+ items, bar for fewer. ONLY set top if user explicitly asked for a limit. If user did not specify a number, do NOT pass top — show ALL.',
  'Diverging bar (enrichment/fold change): measure tissue A → measure tissue B → analyze_delta → chart(type=diverging_bar) — positive=enriched in A, negative=enriched in B',
  'Radar (tissue profile): measure gene in N tissues → analyze_merge → chart(type=radar, group="group") — polygon shows expression shape',
  'Bubble (3D scatter): analyze_scatter with extra columns → chart(type=bubble, size="col", color="col")',
  'Scatter with multiple gene sets: if genes come from different searches, measure EACH gene set in BOTH conditions, then pass ALL condition-A measurements as dataset_a and ALL condition-B measurements as dataset_b. Example: liver_of_set1, liver_of_set2 → dataset_a=[liver_of_set1, liver_of_set2]; kidney_of_set1, kidney_of_set2 → dataset_b=[kidney_of_set1, kidney_of_set2]. No need for separate scatter calls or analyze_concat.',
  '',
  'MERGE labels — use SHORT tissue/condition names as group labels (e.g. "Kidney", "Liver"), NOT dataset descriptions.',
  '',
  'CHART — the chart tool is a dumb renderer:',
  '- ALWAYS provide x_label and y_label so the reader knows what the axes mean.',
  '- For bar/dot_plot: data needs x and y fields.',
  '- For grouped_bar/stacked_bar: data needs x, y, and group fields. Use analyze_merge first.',
  '- For scatter: data needs x, y, and label fields. Use analyze_scatter first.',
  '- For heatmap: data needs matrix + row_labels + col_labels. Use analyze_matrix first.',
  '- Always specify x, y, and group params explicitly.',
  '',
  'CHART TYPE SELECTION — pick the chart that best tells the story:',
  '- bar: simple ranking (5-12 items). Use for small ranked lists.',
  '- lollipop: ranked data with 15+ items — horizontal stems + dots with value labels. Much cleaner than bar for long lists. PREFER over bar when >12 items.',
  '- diverging_bar: bars go left/right from zero — ideal for fold change, enrichment ratios, or any signed values (positive vs negative).',
  '- grouped_bar: comparing 2-4 conditions side by side for the same genes.',
  '- scatter: correlating two measurements (e.g. tissue A vs tissue B, RNA vs protein).',
  '- bubble: scatter with a size dimension — 3 variables at once (e.g. x=expression, y=specificity, size=significance).',
  '- heatmap: expression patterns across many genes × many tissues. Classic matrix view.',
  '- radar: expression profile across multiple tissues for 1-3 genes — polygon shape shows the "signature".',
  '- waterfall: cascading bars showing cumulative changes or step-by-step contributions.',
  '- volcano: fold-change (x) vs significance (y) — classic for differential expression. Needs log2FC and -log10(p) columns.',
  '- ridge: overlapping distribution histograms per group — dramatic way to show expression distributions.',
  '- dot_plot: like bar but horizontal, for items with long labels.',
  '- PREFER flashy chart types over basic ones. A lollipop is always better than a bar. A radar is more interesting than a grouped bar for tissue profiles.',
  '- Do NOT default to bar for everything. Choose the chart type that tells the most interesting visual story.',
  '',
  'SEARCH — do not waste steps on repeated failures:',
  '- If deep_research returns 0 rows, try ONE different search term.',
  '- If still 0 rows after 2 attempts, move on with whatever results you have or try a fundamentally different approach.',
  '- Do NOT repeat the same search 5-10 times with minor rewording.',
  '',
  'MEASUREMENT — two modes:',
  '- FAST (preferred): provide tissue param (e.g. tissue="kidney", page="tissue"). Direct page fetch + parse, zero LLM calls.',
  '- FULL: provide question param with {gene} placeholder. Uses investigator agent with LLM reasoning. Use ONLY for complex queries.',
  '',
  'Fast mode is ~20x cheaper. Always prefer it for expression measurements.',
  'One page fetch per gene covers ALL tissues — so measuring kidney + brain for the same genes costs only N page fetches (cached), not 2N.',
  'Only measure what the objective actually requires. Do not measure "nice to have" datasets.',
  '',
  'ANALYSIS TOOLS are field-agnostic:',
  '- analyze_delta: specify join_key to match rows. Works for any entity.',
  '- analyze_rank: specify key to rank by. Works on any numeric column.',
  '- analyze_merge: specify join_key and value_key. Produces long-format {join_key, value, group}.',
  '- analyze_scatter: joins measurement datasets into {label, x, y} for scatter plots. Accepts arrays of dataset IDs per axis (auto-concatenated). Use mode="all" to include genes missing from one side (plotted at 0).',
  '- analyze_concat: appends rows from multiple datasets into one. Use to combine results from separate pipelines before charting (e.g. ranked lists from different gene sets). NOT needed for scatter — analyze_scatter handles arrays natively.',
  '- analyze_matrix: pivots long-format into {matrix, row_labels, col_labels} for heatmaps.',
  '',
  'FINISH — your summary must contain:',
  '- Specific gene names (or entity names) from the results',
  '- Actual numeric values and rankings',
  '- Concrete comparisons (e.g. "X had 3x higher expression than Y")',
  '- Do NOT say "analysis was performed" — say WHAT was found',
  '',
  'You can call multiple tools in parallel when they are independent.',
  'Reference artifact UUIDs from previous results to chain operations.',
  'Always generate charts before calling finish. The report must include figures.',
  'Be concise in reasoning. Focus on what you know, what you need, and what to do next.'
].join('\n');

// =============================================================================
// UTILITIES
// =============================================================================

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseNumber(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const match = String(val).match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

async function runWithLimit(tasks, limit = 3) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function buildQuestion(template, gene, goal) {
  let q = template || '';
  q = q.replace(/\{gene\}/gi, gene).replace(/\{goal\}/gi, goal || '');
  if (!q.trim()) return `For gene ${gene}, find evidence in HPA relevant to the objective "${goal}".`;
  if (!q.toLowerCase().includes('gene') && !q.includes(gene)) return `For gene ${gene}, ${q}`;
  return q;
}

function datasetColumns(rows) {
  if (!rows || !rows.length) return [];
  return Object.keys(rows[0]);
}

function stripWorkspaceRoot(p) {
  if (!p || typeof p !== 'string') return p;
  const root = resolveWorkspaceRoot();
  return p.startsWith(root) ? p.slice(root.length).replace(/^\//, '') : p;
}

function sanitizeSummary(summary) {
  if (!summary || typeof summary !== 'object') return summary;
  const out = {};
  for (const [k, v] of Object.entries(summary)) {
    out[k] = typeof v === 'string' ? stripWorkspaceRoot(v) : v;
  }
  return out;
}

function summarizeArtifact(artifact) {
  return {
    artifact_uuid: artifact.artifact_uuid,
    kind: artifact.kind,
    tool: artifact.tool || null,
    summary: sanitizeSummary(artifact.summary),
    storage_uri: stripWorkspaceRoot(artifact.storage_uri)
  };
}

// =============================================================================
// PRETTY LOG FORMATTER — full visibility into thinking, actions, tokens
// =============================================================================


// =============================================================================
// STATE MANAGEMENT
// =============================================================================

function buildStateSummary(state) {
  return {
    counts: {
      tool_results: state.toolResults.length,
      datasets: state.datasets.length,
      measurements: state.datasets.filter(d => d.kind === 'measurement').length,
      analyses: state.analyses.length,
      charts: state.chartSpecs.length
    },
    tool_results: state.toolResults.map(t => ({
      id: t.artifact_uuid,
      tool: t.tool,
      rows_found: t.summary?.rows_found ?? null,
      search_url: t.summary?.search_url ?? null,
      purpose: t.purpose || null
    })),
    datasets: state.datasets.map(d => ({
      id: d.artifact_uuid,
      kind: d.kind,
      label: d.label || null,
      row_count: d.row_count || 0,
      columns: d.columns || []
    })),
    analyses: state.analyses.map(a => ({
      id: a.artifact_uuid,
      label: a.label || null,
      summary: a.summary || null
    })),
    charts: state.chartSpecs.map(c => ({
      id: c.artifact_uuid,
      chart_count: c.chart_count || 0
    }))
  };
}

// =============================================================================
// CHART SPEC BUILDER
// =============================================================================

function buildChartSpec(request, dataset) {
  const hasRows = dataset && dataset.rows && dataset.rows.length;
  const type = request.type;

  // Common base — always include axis labels if provided
  const base = { type, title: request.title || '' };
  if (request.x_label) base.x_label = request.x_label;
  if (request.y_label) base.y_label = request.y_label;

  // Heatmap reads from dataset.matrix, not rows
  if (type === 'heatmap') {
    if (!dataset || !Array.isArray(dataset.matrix)) return null;
    return { ...base, matrix: dataset.matrix, row_labels: dataset.row_labels || [], col_labels: dataset.col_labels || [] };
  }

  if (!hasRows) return null;
  const xKey = request.x || 'gene';
  const yKey = request.y || 'value';
  let rows = dataset.rows;


  if (type === 'bar' || type === 'dot_plot' || type === 'lollipop' || type === 'diverging_bar' || type === 'waterfall') {
    return { ...base, data: rows.map(r => ({ label: String(r[xKey] ?? ''), value: parseNumber(r[yKey]) ?? 0 })) };
  }
  if (type === 'scatter') {
    return { ...base, data: rows.map(r => ({ x: parseNumber(r[xKey]) ?? r[xKey], y: parseNumber(r[yKey]) ?? r[yKey], label: r.label || r[request.x === 'x' ? 'label' : xKey] || '', series: request.series ? r[request.series] : undefined })) };
  }
  if (type === 'bubble') {
    const sizeKey = request.size || 'size';
    const colorKey = request.color || null;
    return { ...base,
      color_label: request.color_label || '',
      data: rows.map(r => ({
        x: parseNumber(r[xKey]) ?? r[xKey], y: parseNumber(r[yKey]) ?? r[yKey],
        size: parseNumber(r[sizeKey]) ?? 10,
        color: colorKey ? (parseNumber(r[colorKey]) ?? 0) : null,
        label: r.label || r[request.x === 'x' ? 'label' : xKey] || ''
      }))
    };
  }
  if (type === 'volcano') {
    return { ...base,
      fc_threshold: request.fc_threshold || 1.0,
      sig_threshold: request.sig_threshold || 1.3,
      data: rows.map(r => ({
        x: parseNumber(r[xKey]) ?? 0, y: parseNumber(r[yKey]) ?? 0,
        label: r.label || r.gene || ''
      }))
    };
  }
  if (type === 'line') {
    return { ...base, data: rows.map(r => ({ x: r[xKey], y: r[yKey], series: request.series ? r[request.series] : undefined })) };
  }
  if (type === 'grouped_bar') {
    const groupKey = request.group;
    if (!groupKey) return null;
    return { ...base, data: rows.map(r => ({ label: String(r[xKey] ?? ''), value: parseNumber(r[yKey]) ?? 0, group: String(r[groupKey] ?? '') })) };
  }
  if (type === 'stacked_bar') {
    const stackKey = request.group;
    if (!stackKey) return null;
    return { ...base, data: rows.map(r => ({ label: String(r[xKey] ?? ''), value: parseNumber(r[yKey]) ?? 0, stack: String(r[stackKey] ?? '') })) };
  }
  if (type === 'radar') {
    // Radar: axes = categories around the circle, series = polygons.
    const groupKey = request.group || request.series;
    if (!groupKey) {
      // Single series — axes from x, values from y
      const axes = rows.map(r => String(r[xKey] ?? ''));
      const values = rows.map(r => parseNumber(r[yKey]) ?? 0);
      return { ...base, axes, series: [{ label: request.title || 'Expression', values }] };
    }
    // Auto-detect: if xKey has fewer unique values than groupKey, swap them.
    // e.g. x=gene (1 unique "GFAP") vs group (5 brain regions) → axes should be brain regions
    const uniqueX = new Set(rows.map(r => String(r[xKey] ?? '')));
    const uniqueG = new Set(rows.map(r => String(r[groupKey] ?? '')));
    const axisSource = uniqueX.size < uniqueG.size ? groupKey : xKey;
    const seriesSource = uniqueX.size < uniqueG.size ? xKey : groupKey;
    const seriesMap = new Map();
    const axesSet = [];
    for (const r of rows) {
      const key = String(r[seriesSource] ?? '');
      const axis = String(r[axisSource] ?? '');
      if (!axesSet.includes(axis)) axesSet.push(axis);
      if (!seriesMap.has(key)) seriesMap.set(key, new Map());
      seriesMap.get(key).set(axis, parseNumber(r[yKey]) ?? 0);
    }
    const seriesList = Array.from(seriesMap.entries()).map(([label, axisMap]) => ({
      label, values: axesSet.map(a => axisMap.get(a) || 0)
    }));
    return { ...base, axes: axesSet, series: seriesList };
  }
  if (type === 'box' || type === 'ridge') {
    const groupKey = request.group;
    if (!groupKey) return null;
    const seriesMap = new Map();
    for (const r of rows) {
      const key = String(r[groupKey] ?? '');
      const val = parseNumber(r[yKey]);
      if (val === null) continue;
      if (!seriesMap.has(key)) seriesMap.set(key, []);
      seriesMap.get(key).push(val);
    }
    return { ...base, series: Array.from(seriesMap.entries()).map(([label, values]) => ({ label, values })) };
  }
  return null;
}

// =============================================================================
// CONCLUSION HELPERS
// =============================================================================

function buildConclusionFallback(goal, state) {
  const lines = [];
  const geneList = state.datasets.find(d => d.kind === 'analysis_delta')
    || state.datasets.find(d => d.kind === 'analysis_rank')
    || state.datasets.find(d => d.kind === 'measurement')
    || state.datasets.find(d => d.kind === 'gene_list');

  if (!geneList || !geneList.rows || geneList.rows.length === 0) {
    lines.push('No matching genes found with the current constraints.');
    return lines;
  }
  const topGenes = geneList.rows.map(r => r.gene || r.ensembl).filter(Boolean).slice(0, 5);
  lines.push(`Objective: ${goal}`);
  lines.push(`Result set size: ${geneList.row_count || geneList.rows.length}`);
  if (topGenes.length) lines.push(`Top genes: ${topGenes.join(', ')}`);
  return lines;
}

// =============================================================================
// TOOL HANDLERS — each returns a compact result for the LLM conversation
// =============================================================================

async function execDeepResearch(args, ctx) {
  const { state, workspace, db, log, step } = ctx;
  const onStep = LOG_TOOL_STEPS ? async (payload) => log('tool_step', 'deep_research_hpa', payload, step) : undefined;

  const result = await deepResearch(args, { onStep });
  const summary = result?.result || {};
  const compact = {
    tool: 'deep_research_hpa',
    rows_found: summary.rows_found ?? null,
    search_url: summary.search_urls?.[0] || null,
    validation_passed: summary.validation_passed ?? null,
    attempts: summary.attempts ?? null
  };

  const artifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'tool_result', format: 'json',
    schemaJson: { tool: 'deep_research_hpa' },
    metadataJson: { tool: 'deep_research_hpa', args, purpose: args.purpose },
    payload: { compact, result }
  });

  state.toolResults.push({ artifact_uuid: artifact.artifactUuid, tool: 'deep_research_hpa', summary: compact, storage_uri: artifact.storageUri, args, purpose: args.purpose });
  state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'tool_result', tool: 'deep_research_hpa', summary: compact, storage_uri: artifact.storageUri });

  return { ok: true, artifact_id: artifact.artifactUuid, rows_found: compact.rows_found, search_url: compact.search_url, validation_passed: compact.validation_passed };
}

async function execInvestigator(args, ctx) {
  const { state, workspace, db, log, step } = ctx;
  const onStep = LOG_TOOL_STEPS ? async (payload) => log('tool_step', 'investigator_hpa', payload, step) : undefined;

  const result = await investigationAgent(args, { onStep });
  const answer = String(result?.answer || '').trim();
  const compact = {
    tool: 'investigator_hpa', gene: result?.gene || args.gene, ensembl: result?.ensembl || args.ensembl || null,
    found: result?.found === true, answer_snippet: answer ? answer.slice(0, 320) : null,
    extracted_value: result?.extracted_value || null, confidence: result?.confidence || null
  };

  const artifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'tool_result', format: 'json',
    schemaJson: { tool: 'investigator_hpa' },
    metadataJson: { tool: 'investigator_hpa', args, purpose: args.purpose },
    payload: { compact, result }
  });

  state.toolResults.push({ artifact_uuid: artifact.artifactUuid, tool: 'investigator_hpa', summary: compact, storage_uri: artifact.storageUri, args });
  state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'tool_result', tool: 'investigator_hpa', summary: compact, storage_uri: artifact.storageUri });

  return { ok: true, artifact_id: artifact.artifactUuid, gene: compact.gene, found: compact.found, answer_snippet: compact.answer_snippet, extracted_value: compact.extracted_value };
}

async function execCleanTopX(args, ctx) {
  const { state, workspace, db, log, step, top_x: defaultTopX } = ctx;
  let topX = args.top_x || defaultTopX || DEFAULT_TOP_X;
  if (MAX_TOP_X > 0 && (topX <= 0 || topX > MAX_TOP_X)) topX = MAX_TOP_X;
  const sourceIds = (args.source_ids && args.source_ids.length) ? args.source_ids : state.toolResults.map(t => t.artifact_uuid);
  const created = [];

  for (const toolId of sourceIds) {
    const toolArtifact = state.toolResults.find(t => t.artifact_uuid === toolId);
    const searchUrl = toolArtifact?.summary?.search_url;
    if (!searchUrl) continue;

    const inspection = await inspectSearchUrl(searchUrl, { limit: 100000 });
    const normalized = normalizeRows(inspection.rows || []);
    const top = rankTopX(normalized, topX);
    const label = args.label || toolArtifact?.purpose || `Top ${topX} genes`;

    const artifact = await registerArtifact(db, {
      workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
      kind: 'dataset', format: 'json',
      schemaJson: { type: 'gene_list' }, metadataJson: { source: toolId, top_x: topX },
      payload: { label, source_tool: toolId, search_url: searchUrl, row_count: normalized.length, rows: top }
    });

    const dataset = { artifact_uuid: artifact.artifactUuid, kind: 'gene_list', label, rows: top, row_count: top.length, columns: datasetColumns(top), storage_uri: artifact.storageUri };
    state.datasets.push(dataset);
    state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'dataset', summary: { label, row_count: top.length }, storage_uri: artifact.storageUri });
    created.push({ artifact_id: artifact.artifactUuid, label, row_count: top.length, sample_genes: top.slice(0, 5).map(r => r.gene).filter(Boolean) });
  }

  if (!created.length) return { ok: false, error: 'No tool results with search_url found to clean' };
  return { ok: true, datasets: created };
}

async function execCleanDiff(args, ctx) {
  const { state, workspace, db, log, step, top_x: defaultTopX } = ctx;
  let topX = args.top_x || defaultTopX || DEFAULT_TOP_X;
  if (MAX_TOP_X > 0 && (topX <= 0 || topX > MAX_TOP_X)) topX = MAX_TOP_X;
  const datasetA = state.datasets.find(d => d.artifact_uuid === args.dataset_a);
  const datasetB = state.datasets.find(d => d.artifact_uuid === args.dataset_b);
  if (!datasetA || !datasetB) return { ok: false, error: `Dataset not found: ${!datasetA ? args.dataset_a : args.dataset_b}` };

  const diff = diffSets(datasetA.rows || [], datasetB.rows || [], topX);
  const lists = [
    { key: 'onlyA', label: `${datasetA.label || 'A'} only`, rows: diff.top.onlyA },
    { key: 'onlyB', label: `${datasetB.label || 'B'} only`, rows: diff.top.onlyB },
    { key: 'overlap', label: `Overlap`, rows: diff.top.overlap }
  ];

  const created = [];
  for (const list of lists) {
    const artifact = await registerArtifact(db, {
      workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
      kind: 'dataset', format: 'json',
      schemaJson: { type: 'diff_list', list: list.key },
      metadataJson: { sources: [datasetA.artifact_uuid, datasetB.artifact_uuid] },
      payload: { label: list.label, source_datasets: [datasetA.artifact_uuid, datasetB.artifact_uuid], row_count: list.rows.length, rows: list.rows }
    });
    state.datasets.push({ artifact_uuid: artifact.artifactUuid, kind: `diff_${list.key}`, label: list.label, rows: list.rows, row_count: list.rows.length, columns: datasetColumns(list.rows), storage_uri: artifact.storageUri });
    state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'dataset', summary: { label: list.label, row_count: list.rows.length }, storage_uri: artifact.storageUri });
    created.push({ artifact_id: artifact.artifactUuid, label: list.label, row_count: list.rows.length });
  }

  return { ok: true, datasets: created, counts: diff.counts, overlap_count: diff.counts.overlap };
}

async function execInspect(args, ctx) {
  const { state, log, step } = ctx;
  const artifactId = args.source_id;
  let toolArtifact = state.toolResults.find(t => t.artifact_uuid === artifactId);
  if (!toolArtifact && state.toolResults.length) toolArtifact = state.toolResults[state.toolResults.length - 1];
  const searchUrl = toolArtifact?.summary?.search_url;
  if (!searchUrl) return { ok: false, error: 'No search_url found for this artifact' };

  const inspection = await inspectSearchUrl(searchUrl, {
    fields: args.fields || [], filters: {},
    limit: Math.min(args.limit || 25, 100)
  });

  return { ok: true, total: inspection.total, limit: inspection.limit, sample_count: inspection.rows.length, columns: inspection.columns || Object.keys(inspection.rows[0] || {}), sample_rows: inspection.rows.slice(0, 5) };
}

async function execMeasure(args, ctx) {
  const { state, workspace, db, log, step, goal, parallel_limit, top_x: defaultTopX, pageCache } = ctx;

  // Accept either dataset_id (from prior search) or inline genes array
  let rows;
  if (args.genes && Array.isArray(args.genes) && args.genes.length > 0) {
    // Inline genes — no dataset needed
    rows = args.genes.map(g => ({ gene: g }));
  } else if (args.dataset_id) {
    const dataset = state.datasets.find(d => d.artifact_uuid === args.dataset_id);
    if (!dataset) return { ok: false, error: `Dataset not found: ${args.dataset_id}` };
    rows = (dataset.rows || []);
  } else {
    return { ok: false, error: 'Provide either dataset_id or genes array' };
  }

  let maxGenes = args.max_genes || defaultTopX || DEFAULT_TOP_X;
  if (MAX_TOP_X > 0 && (maxGenes <= 0 || maxGenes > MAX_TOP_X)) maxGenes = MAX_TOP_X;
  if (maxGenes > 0) rows = rows.slice(0, maxGenes);
  const useDirect = Boolean(args.tissue);
  const mode = useDirect ? 'direct' : 'investigator';

  await log('measure', 'batch', { count: rows.length, dataset_id: args.dataset_id || null, genes_inline: !args.dataset_id, label: args.label, mode, tissue: args.tissue || null }, step);

  // ---- Scout phase: when using direct mode, run investigator on first gene ----
  // to discover chart_id + exact_label for precise extraction on the rest.
  let scoutInfo = null;
  let scoutResult = null;
  if (useDirect && rows.length > 0) {
    const scoutGene = rows[0].gene || rows[0].ensembl;
    if (scoutGene) {
      await log('measure', 'scout', { gene: scoutGene, tissue: args.tissue, page: args.page || 'tissue' }, step);
      try {
        const pageName = args.page || 'tissue';
        const question = `On the "${pageName}" page of HPA, what is the organ-level "${args.tissue}" RNA expression (nTPM) for ${scoutGene}? Look at the tissue overview bar chart on the "${pageName}" page. Do NOT navigate to a sub-region page.`;
        const sResult = await investigationAgent(
          { gene: scoutGene, ensembl: rows[0].ensembl, question },
          {}
        );
        scoutResult = {
          gene: scoutGene, ensembl: rows[0].ensembl || sResult.ensembl || null,
          value: parseNumber(sResult.extracted_value ?? sResult.answer ?? sResult.value),
          value_raw: sResult.extracted_value || null,
          found: sResult.found === true,
          confidence: sResult.confidence || null,
          answer_snippet: String(sResult.answer || '').slice(0, 280) || null,
        };
        if (sResult.chart_id || sResult.exact_label) {
          // Sanitize: LLM sometimes returns multiple IDs or label with value — take first ID, strip value from label
          let chartId = sResult.chart_id || null;
          if (chartId && /\s+(and|,|or)\s+/i.test(chartId)) {
            chartId = chartId.split(/\s+(?:and|,|or)\s+/i)[0].trim();
          }
          let exactLabel = sResult.exact_label || null;
          if (exactLabel) {
            // Strip trailing ": value" or "(nTPM: ...)" patterns — we only want the label text
            exactLabel = exactLabel.replace(/\s*[:]\s*[\d.]+.*$/, '').replace(/\s*\(.*$/, '').trim();
          }
          scoutInfo = { chart_id: chartId, exact_label: exactLabel };
          await log('measure', 'scout_result', { gene: scoutGene, chart_id: scoutInfo.chart_id, exact_label: scoutInfo.exact_label, value: scoutResult.value }, step);
        } else {
          await log('measure', 'scout_result', { gene: scoutGene, chart_id: null, exact_label: null, note: 'investigator did not return chart_id/exact_label, falling back to unguided direct' }, step);
        }
      } catch (err) {
        await log('measure', 'scout_error', { gene: scoutGene, message: err.message }, step);
        // Scout failed — proceed without scout info, direct will use fuzzy matching
      }
    }
  }

  // Remaining genes (skip first if scout already measured it)
  const remainingRows = (useDirect && scoutResult) ? rows.slice(1) : rows;

  const tasks = remainingRows.map((row) => async () => {
    const gene = row.gene || row.ensembl;
    if (!gene) return null;
    await log('measure', 'invoke', { gene, mode: useDirect ? (scoutInfo ? 'direct+scout' : 'direct') : 'investigator' }, step);

    try {
      if (useDirect) {
        // FAST PATH: direct page fetch + cheerio parse, zero LLM calls
        // Uses scoutInfo from investigator scout when available for precise matching
        const result = await measureDirect({
          gene, ensembl: row.ensembl,
          tissue: args.tissue,
          page: args.page || 'tissue',
          cache: pageCache,
          scoutInfo,
        });
        return {
          gene, ensembl: row.ensembl || result.ensembl || null,
          value: parseNumber(result.extracted_value ?? result.value),
          value_raw: result.extracted_value || null,
          found: result.found === true,
          confidence: result.confidence || null,
          answer_snippet: result.answer || null
        };
      } else {
        // FULL PATH: investigator agent with LLM reasoning
        const question = buildQuestion(args.question, gene, goal);
        const result = await investigationAgent({ gene, ensembl: row.ensembl, question }, {});
        return {
          gene, ensembl: row.ensembl || null,
          value: parseNumber(result.extracted_value ?? result.answer ?? result.value),
          value_raw: result.extracted_value || null,
          found: result.found === true,
          confidence: result.confidence || null,
          answer_snippet: String(result.answer || '').slice(0, 280) || null
        };
      }
    } catch (err) {
      await log('measure', 'error', { gene, message: err.message, mode }, step);
      return null;
    }
  });

  const results = await runWithLimit(tasks, Math.min(parallel_limit, useDirect ? 6 : 4));
  // Prepend scout result if we have one
  if (scoutResult) results.unshift(scoutResult);
  const rowsOut = results.filter(Boolean);
  const numericCount = rowsOut.filter(r => typeof r.value === 'number' && Number.isFinite(r.value)).length;

  const artifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'measurement', format: 'json',
    schemaJson: { type: 'measurement' }, metadataJson: { source_dataset: args.dataset_id || null },
    payload: { label: args.label, tissue: args.tissue || null, mode, source_dataset: args.dataset_id || null, value_type: args.value_type, unit: args.unit, row_count: rowsOut.length, numeric_count: numericCount, rows: rowsOut }
  });

  state.datasets.push({ artifact_uuid: artifact.artifactUuid, kind: 'measurement', label: args.label, rows: rowsOut, row_count: rowsOut.length, columns: datasetColumns(rowsOut), storage_uri: artifact.storageUri });
  state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'measurement', summary: { label: args.label, row_count: rowsOut.length, numeric_count: numericCount }, storage_uri: artifact.storageUri });

  return { ok: true, artifact_id: artifact.artifactUuid, label: args.label, mode: scoutInfo ? 'scout+direct' : mode, row_count: rowsOut.length, numeric_count: numericCount, investigator_calls: useDirect ? (scoutResult ? 1 : 0) : rowsOut.length, page_fetches: useDirect ? remainingRows.length : 0, scout: scoutInfo || null, sample: rowsOut.slice(0, 3).map(r => ({ gene: r.gene, value: r.value })) };
}

async function execAnalyzeRank(args, ctx) {
  const { state, workspace, db } = ctx;
  const dataset = state.datasets.find(d => d.artifact_uuid === args.dataset_id);
  if (!dataset) return { ok: false, error: `Dataset not found: ${args.dataset_id}` };

  let top = args.top || 0;  // 0 = all
  if (MAX_TOP_X > 0 && (top <= 0 || top > MAX_TOP_X)) top = MAX_TOP_X;
  const ranked = rankArray(dataset.rows || [], { key: args.key || 'value', top, order: args.order || 'desc' });
  const label = args.label;

  const artifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'analysis', format: 'json',
    schemaJson: { type: 'rank' }, metadataJson: { source_dataset: args.dataset_id },
    payload: { label, source_dataset: args.dataset_id, key: args.key || 'value', rows: ranked }
  });

  state.datasets.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis_rank', label, rows: ranked, row_count: ranked.length, columns: datasetColumns(ranked), storage_uri: artifact.storageUri });
  state.analyses.push({ artifact_uuid: artifact.artifactUuid, label, summary: { label, row_count: ranked.length }, storage_uri: artifact.storageUri });
  state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis', summary: { label, row_count: ranked.length }, storage_uri: artifact.storageUri });

  return { ok: true, artifact_id: artifact.artifactUuid, label, row_count: ranked.length, top_3: ranked.slice(0, 3).map(r => ({ gene: r.gene, value: r.__v ?? r.value, rank: r.rank })) };
}

async function execAnalyzeDelta(args, ctx) {
  const { state, workspace, db } = ctx;
  const datasetA = state.datasets.find(d => d.artifact_uuid === args.dataset_a);
  const datasetB = state.datasets.find(d => d.artifact_uuid === args.dataset_b);
  if (!datasetA || !datasetB) return { ok: false, error: `Dataset not found` };

  const joinKey = args.join_key || 'gene';
  const out = compareDelta(datasetA.rows || [], datasetB.rows || [], { key: args.key || 'value', outKey: 'delta', joinKey });
  const label = args.label;

  const artifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'analysis', format: 'json',
    schemaJson: { type: 'delta' }, metadataJson: { sources: [datasetA.artifact_uuid, datasetB.artifact_uuid], joinKey },
    payload: { label, sources: [datasetA.artifact_uuid, datasetB.artifact_uuid], rows: out }
  });

  state.datasets.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis_delta', label, rows: out, row_count: out.length, columns: datasetColumns(out), storage_uri: artifact.storageUri });
  state.analyses.push({ artifact_uuid: artifact.artifactUuid, label, summary: { label, row_count: out.length }, storage_uri: artifact.storageUri });
  state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis', summary: { label, row_count: out.length }, storage_uri: artifact.storageUri });

  return { ok: true, artifact_id: artifact.artifactUuid, label, row_count: out.length, top_3: out.slice(0, 3).map(r => ({ [joinKey]: r[joinKey], delta: r.delta, a_value: r.a_value, b_value: r.b_value })) };
}

async function execAnalyzeAggregate(args, ctx) {
  const { state, workspace, db } = ctx;
  const dataset = state.datasets.find(d => d.artifact_uuid === args.dataset_id);
  if (!dataset) return { ok: false, error: `Dataset not found: ${args.dataset_id}` };

  const value = aggregate(dataset.rows || [], { key: args.key || 'value', metric: args.metric || 'mean' });
  const label = args.label;

  const artifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'analysis', format: 'json',
    schemaJson: { type: 'aggregate' }, metadataJson: { source_dataset: args.dataset_id },
    payload: { label, metric: args.metric, value, source_dataset: args.dataset_id }
  });

  state.analyses.push({ artifact_uuid: artifact.artifactUuid, label, summary: { label, value }, storage_uri: artifact.storageUri });
  state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis', summary: { label, value }, storage_uri: artifact.storageUri });

  return { ok: true, artifact_id: artifact.artifactUuid, label, metric: args.metric, value };
}

async function execAnalyzeMerge(args, ctx) {
  const { state, workspace, db } = ctx;
  const joinKey = args.join_key || 'gene';
  const valueKey = args.value_key || 'value';

  const resolvedDatasets = [];
  for (const entry of (args.datasets || [])) {
    const ds = state.datasets.find(d => d.artifact_uuid === entry.dataset_id);
    if (!ds) return { ok: false, error: `Dataset not found: ${entry.dataset_id}` };
    resolvedDatasets.push({ rows: ds.rows || [], label: entry.label });
  }

  if (resolvedDatasets.length < 2) return { ok: false, error: 'analyze_merge requires at least 2 datasets' };

  const merged = mergeLongFormat(resolvedDatasets, { joinKey, valueKey });
  const label = args.label;

  const artifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'analysis', format: 'json',
    schemaJson: { type: 'merge' }, metadataJson: { sources: args.datasets.map(d => d.dataset_id), joinKey, valueKey },
    payload: { label, rows: merged, row_count: merged.length }
  });

  const columns = merged.length ? Object.keys(merged[0]) : [];
  state.datasets.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis_merge', label, rows: merged, row_count: merged.length, columns, storage_uri: artifact.storageUri });
  state.analyses.push({ artifact_uuid: artifact.artifactUuid, label, summary: { label, row_count: merged.length, groups: resolvedDatasets.map(d => d.label) }, storage_uri: artifact.storageUri });
  state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis', summary: { label, row_count: merged.length }, storage_uri: artifact.storageUri });

  return { ok: true, artifact_id: artifact.artifactUuid, label, row_count: merged.length, groups: resolvedDatasets.map(d => d.label), sample: merged.slice(0, 4) };
}

async function execAnalyzeScatter(args, ctx) {
  const { state, workspace, db } = ctx;

  // Normalize to arrays
  const idsA = Array.isArray(args.dataset_a) ? args.dataset_a : [args.dataset_a];
  const idsB = Array.isArray(args.dataset_b) ? args.dataset_b : [args.dataset_b];

  // Reject trivial self-join (single same ID on both sides)
  if (idsA.length === 1 && idsB.length === 1 && idsA[0] === idsB[0])
    return { ok: false, error: 'dataset_a and dataset_b must be different. Pass separate x-axis and y-axis measurements.' };

  // Validate: only accept raw measurement datasets, not analysis/ranked outputs
  const allIds = [...idsA, ...idsB];
  for (const id of allIds) {
    const ds = state.datasets.find(d => d.artifact_uuid === id);
    if (ds && ds.kind && ds.kind !== 'measurement') {
      return { ok: false, error: `Dataset "${ds.label}" (${id}) is kind="${ds.kind}", not a raw measurement. analyze_scatter requires raw measurement datasets. Pass the measurement dataset IDs, not analyze_rank/merge/delta outputs.` };
    }
  }

  // Collect and concat rows per side
  const collectRows = (ids, side) => {
    const allRows = [];
    for (const id of ids) {
      const ds = state.datasets.find(d => d.artifact_uuid === id);
      if (!ds) return { ok: false, error: `${side}: dataset ${id} not found` };
      allRows.push(...(ds.rows || []));
    }
    return allRows;
  };

  const rowsA = collectRows(idsA, 'dataset_a');
  if (rowsA.ok === false) return rowsA;
  const rowsB = collectRows(idsB, 'dataset_b');
  if (rowsB.ok === false) return rowsB;

  const joinKey = args.join_key || 'gene';
  const valueKey = args.value_key || 'value';
  const mode = args.mode || 'overlap';

  const points = mode === 'all'
    ? joinScatterAll(rowsA, rowsB, { joinKey, valueKey })
    : joinScatter(rowsA, rowsB, { joinKey, valueKey });

  if (points.length === 0)
    return { ok: false, error: `0 matching genes between dataset_a and dataset_b. The gene sets do not overlap. To scatter genes from different searches, pass ALL raw measurement datasets as arrays: dataset_a=[condA_set1, condA_set2], dataset_b=[condB_set1, condB_set2]. Or use mode="all" to include non-overlapping genes (missing side = 0).` };

  const label = args.label;

  const allSourceIds = [...idsA, ...idsB];
  const artifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'analysis', format: 'json',
    schemaJson: { type: 'scatter' }, metadataJson: { sources: allSourceIds, joinKey, valueKey, mode },
    payload: { label, rows: points, row_count: points.length }
  });

  state.datasets.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis_scatter', label, rows: points, row_count: points.length, columns: ['label', 'x', 'y'], storage_uri: artifact.storageUri });
  state.analyses.push({ artifact_uuid: artifact.artifactUuid, label, summary: { label, row_count: points.length }, storage_uri: artifact.storageUri });
  state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis', summary: { label, row_count: points.length }, storage_uri: artifact.storageUri });

  return { ok: true, artifact_id: artifact.artifactUuid, label, row_count: points.length, sample: points.slice(0, 3) };
}

async function execAnalyzeConcat(args, ctx) {
  const { state, workspace, db } = ctx;
  const ids = args.dataset_ids || [];
  if (ids.length < 2) return { ok: false, error: 'Need at least 2 dataset_ids to concatenate' };
  const datasets = ids.map(id => state.datasets.find(d => d.artifact_uuid === id));
  const missing = ids.filter((id, i) => !datasets[i]);
  if (missing.length) return { ok: false, error: `Datasets not found: ${missing.join(', ')}` };

  const allRows = [];
  const colSet = new Set();
  for (const ds of datasets) {
    for (const row of (ds.rows || [])) {
      allRows.push(row);
      Object.keys(row).forEach(k => colSet.add(k));
    }
  }
  const columns = [...colSet];
  const label = args.label;

  const artifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'analysis', format: 'json',
    schemaJson: { type: 'concat' }, metadataJson: { sources: ids },
    payload: { label, rows: allRows, row_count: allRows.length }
  });

  state.datasets.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis_concat', label, rows: allRows, row_count: allRows.length, columns, storage_uri: artifact.storageUri });
  state.analyses.push({ artifact_uuid: artifact.artifactUuid, label, summary: { label, row_count: allRows.length }, storage_uri: artifact.storageUri });
  state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis', summary: { label, row_count: allRows.length }, storage_uri: artifact.storageUri });

  return { ok: true, artifact_id: artifact.artifactUuid, label, row_count: allRows.length, columns, sample: allRows.slice(0, 3) };
}

async function execAnalyzeMatrix(args, ctx) {
  const { state, workspace, db } = ctx;
  const dataset = state.datasets.find(d => d.artifact_uuid === args.dataset_id);
  if (!dataset) return { ok: false, error: `Dataset not found: ${args.dataset_id}` };

  const rowKey = args.row_key || 'gene';
  const colKey = args.col_key || 'group';
  const valueKey = args.value_key || 'value';
  const topN = args.top_n || 0;
  const rankByCol = args.rank_by_col || '';
  const { matrix, row_labels, col_labels } = pivotMatrix(dataset.rows || [], { rowKey, colKey, valueKey, topN, rankByCol });
  const label = args.label;

  const artifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'analysis', format: 'json',
    schemaJson: { type: 'matrix' }, metadataJson: { source: args.dataset_id, rowKey, colKey, valueKey },
    payload: { label, matrix, row_labels, col_labels, row_count: row_labels.length, col_count: col_labels.length }
  });

  // Store with matrix fields so buildChartSpec can pick them up for heatmap
  state.datasets.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis_matrix', label, rows: [], matrix, row_labels, col_labels, row_count: row_labels.length, storage_uri: artifact.storageUri });
  state.analyses.push({ artifact_uuid: artifact.artifactUuid, label, summary: { label, rows: row_labels.length, cols: col_labels.length, col_labels }, storage_uri: artifact.storageUri });
  state.artifacts.push({ artifact_uuid: artifact.artifactUuid, kind: 'analysis', summary: { label, rows: row_labels.length, cols: col_labels.length }, storage_uri: artifact.storageUri });

  return { ok: true, artifact_id: artifact.artifactUuid, label, rows: row_labels.length, cols: col_labels.length, row_labels: row_labels.slice(0, 5), col_labels };
}

async function execChart(args, ctx) {
  const { state, workspace, db } = ctx;
  const dataset = state.datasets.find(d => d.artifact_uuid === args.source_dataset);
  if (!dataset) return { ok: false, error: `Dataset not found: ${args.source_dataset}` };

  // Heatmap uses matrix, not rows
  const isHeatmap = args.type === 'heatmap';
  if (!isHeatmap && (dataset.rows || []).length < 2) return { ok: false, error: `Insufficient rows (${dataset.rows?.length || 0}) for chart` };
  if (isHeatmap && !Array.isArray(dataset.matrix)) return { ok: false, error: 'Heatmap requires a matrix dataset (use analyze_matrix first)' };

  const spec = buildChartSpec(args, dataset);
  if (!spec) return { ok: false, error: `Failed to build ${args.type} chart spec` };

  const chartArtifact = await registerArtifact(db, {
    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
    kind: 'figure', format: 'json',
    schemaJson: { type: 'chart_spec' }, metadataJson: { source: 'aso' },
    payload: { charts: [spec] }
  });

  state.chartSpecs.push({ artifact_uuid: chartArtifact.artifactUuid, chart_count: 1, storage_uri: chartArtifact.storageUri });
  state.artifacts.push({ artifact_uuid: chartArtifact.artifactUuid, kind: 'figure', summary: { chart_count: 1 }, storage_uri: chartArtifact.storageUri });

  // Try to render to image
  const images = [];
  try {
    const renderOut = await renderCharts(chartArtifact.storageUri, path.join(workspace.workspaceDir, 'artifacts'));
    if (renderOut?.images?.length) {
      for (const imgPath of renderOut.images) {
        const imgArtifact = await registerArtifact(db, {
          workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
          kind: 'figure', format: 'png',
          schemaJson: { type: 'image' }, metadataJson: { source: chartArtifact.artifactUuid },
          payload: null, storageUriOverride: imgPath, skipWrite: true
        });
        state.chartImages.push(imgArtifact.storageUri);
        state.artifacts.push({ artifact_uuid: imgArtifact.artifactUuid, kind: 'figure', summary: { image: imgArtifact.storageUri }, storage_uri: imgArtifact.storageUri });
        images.push(imgArtifact.storageUri);
      }
    }
  } catch (err) {
    // chart rendering is optional — log but don't fail
  }

  return { ok: true, artifact_id: chartArtifact.artifactUuid, chart_count: 1, type: args.type, title: args.title, images_rendered: images.length };
}

const TOOL_HANDLERS = {
  deep_research_hpa: execDeepResearch,
  investigator_hpa: execInvestigator,
  clean_topx: execCleanTopX,
  clean_diff: execCleanDiff,
  inspect: execInspect,
  measure: execMeasure,
  analyze_rank: execAnalyzeRank,
  analyze_delta: execAnalyzeDelta,
  analyze_aggregate: execAnalyzeAggregate,
  analyze_merge: execAnalyzeMerge,
  analyze_scatter: execAnalyzeScatter,
  analyze_concat: execAnalyzeConcat,
  analyze_matrix: execAnalyzeMatrix,
  chart: execChart
  // finish is handled inline in the main loop
};

// =============================================================================
// MAIN ORCHESTRATOR
// =============================================================================

async function aso_hpa({ goal, max_steps = 20, top_x = DEFAULT_TOP_X, parallel_limit = 3, chart_requests = [], allow_search = true }, ctx = {}) {
  const db = ctx.db;
  if (!db) throw new Error('ASO requires db in context.');
  if (!MODEL) throw new Error('HPA_MODEL not set');

  const requestText = goal || ctx.rawQuery || '';
  const outerOnStep = ctx.onStep;  // Forward progress to the outer query.js SSE stream

  const workspace = await createWorkspace(db, {
    cookieValue: ctx.cookieId || null,
    requestText,
    planJson: { goal, max_steps, top_x, allow_search }
  });

  const logger = createLogger(workspace.logPath);
  const log = (phase, event, data, step) => {
    const name = phase ? (event ? `${phase}.${event}` : phase) : (event || 'log');
    // Push every log event to the frontend SSE stream
    if (outerOnStep) outerOnStep({ stage: name, label: name, message: typeof data === 'string' ? data : JSON.stringify(data), step });
    return logger.logEvent({ event: name, data, step });
  };

  await log('start', 'workspace_created', { workspace_uuid: workspace.uuid, allow_search });
  await log('understand', 'objective', { objective: goal });

  const state = {
    toolResults: [], datasets: [], analyses: [], inspections: [],
    chartSpecs: [], chartImages: [], artifacts: [], notes: []
  };

  const tokens = { cumulative: { prompt: 0, completion: 0, total: 0 } };
  const pageCache = new Map(); // Per-run cache: "ensembl:page" → charts[] — avoids re-fetching same gene page

  // Filter tools based on allow_search
  const tools = allow_search ? ASO_TOOLS : ASO_TOOLS.filter(t => t.function.name !== 'deep_research_hpa');

  // Conversational message history — the LLM sees its own reasoning + all tool results
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Objective: ${goal}\n\nWorkspace is empty. No data yet.${!allow_search ? '\n\nNote: Search is disabled. Use only investigator_hpa and existing datasets.' : ''}` }
  ];

  const handlerCtx = { state, workspace, db, log, goal, parallel_limit, top_x, pageCache };

  try {
    for (let step = 0; step < max_steps; step++) {
      // Log state snapshot
      await log('state', 'snapshot', { step, counts: buildStateSummary(state).counts });

      // Call LLM with tools
      let response;
      try {
        response = await openai.chat.completions.create({
          model: MODEL, messages, tools, temperature: 0
        });
      } catch (err) {
        await log('error', 'exception', { message: `LLM call failed: ${err.message}` }, step);
        await updateWorkspace(db, workspace.uuid, { status: 'failed', finishedAt: new Date(), message: `LLM call failed: ${err.message}` });
        await logger.close();
        return { status: 'error', error: `LLM call failed: ${err.message}`, workspace_uuid: workspace.uuid };
      }

      const choice = response.choices[0];
      const usage = response.usage || {};

      // Track tokens
      const stepTokens = { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, total: usage.total_tokens || 0 };
      tokens.cumulative.prompt += stepTokens.prompt;
      tokens.cumulative.completion += stepTokens.completion;
      tokens.cumulative.total += stepTokens.total;
      await log('tokens', null, { step, ...stepTokens, cumulative_total: tokens.cumulative.total });

      // Log reasoning (the LLM's thinking)
      const reasoning = choice.message.content;
      if (reasoning) {
        await log('think', null, { text: reasoning, step });
      }

      const toolCalls = choice.message.tool_calls || [];

      // No tool calls → LLM is done (implicit finish)
      if (!toolCalls.length) {
        await log('final', 'complete', { summary: reasoning || 'LLM finished without calling tools' });
        break;
      }

      // Add assistant message to conversation (includes tool_calls)
      messages.push(choice.message);

      // Execute each tool call
      let finished = false;
      for (const toolCall of toolCalls) {
        const name = toolCall.function.name;
        const args = safeJsonParse(toolCall.function.arguments) || {};

        await log('tool', 'invoke', { name, args }, step);

        // Handle finish inline
        if (name === 'finish') {
          // Render any explicit chart_requests
          if (chart_requests && chart_requests.length) {
            try {
              const specArtifact = await registerArtifact(db, {
                workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
                kind: 'figure', format: 'json',
                schemaJson: { type: 'chart_spec' }, metadataJson: { source: 'explicit_request' },
                payload: { charts: chart_requests }
              });
              const renderOut = await renderCharts(specArtifact.storageUri, path.join(workspace.workspaceDir, 'artifacts'));
              if (renderOut?.images?.length) {
                for (const imgPath of renderOut.images) {
                  const imgArtifact = await registerArtifact(db, {
                    workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
                    kind: 'figure', format: 'png', schemaJson: { type: 'image' },
                    metadataJson: { source: specArtifact.artifactUuid },
                    payload: null, storageUriOverride: imgPath, skipWrite: true
                  });
                  state.chartImages.push(imgArtifact.storageUri);
                }
              }
            } catch (err) { /* chart rendering is optional */ }
          }

          // Write report
          const conclusion = args.summary ? [args.summary] : buildConclusionFallback(goal, state);
          const reportPath = await writeReport({
            workspaceDir: workspace.workspaceDir, goal, workspaceUuid: workspace.uuid,
            artifacts: state.artifacts, charts: state.chartImages, conclusion
          });
          const reportArtifact = await registerArtifact(db, {
            workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
            kind: 'summary', format: 'md', schemaJson: { type: 'report' },
            metadataJson: { source: 'report' },
            payload: null, storageUriOverride: reportPath, skipWrite: true
          });
          state.artifacts.push({ artifact_uuid: reportArtifact.artifactUuid, kind: 'summary', summary: { report: reportArtifact.storageUri }, storage_uri: reportArtifact.storageUri });

          const toolResult = { ok: true, report_written: true };
          await log('tool', 'result', { name: 'finish', ...toolResult }, step);
          await log('final', 'report', { report_written: true }, step);
          await log('final', 'complete', { summary: args.summary || 'ASO completed.' });
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(toolResult) });

          await updateWorkspace(db, workspace.uuid, { status: 'completed', finishedAt: new Date() });
          await logger.close();
          return {
            status: 'ok', workspace_uuid: workspace.uuid,
            artifacts: state.artifacts.map(summarizeArtifact),
            summary: args.summary || 'ASO completed.',
            tokens: tokens.cumulative
          };
        }

        // Execute tool handler
        const handler = TOOL_HANDLERS[name];
        let toolResult;
        if (!handler) {
          toolResult = { ok: false, error: `Unknown tool: ${name}` };
          await log('tool', 'error', { name, error: toolResult.error }, step);
        } else {
          try {
            toolResult = await handler(args, { ...handlerCtx, step });
          } catch (err) {
            toolResult = { ok: false, error: err.message };
            await log('tool', 'error', { name, error: err.message }, step);
          }
        }

        await log('tool', 'result', { name, ...toolResult }, step);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(toolResult) });
      }

      if (finished) break;
    }

    // Max steps reached — write report anyway
    const conclusion = buildConclusionFallback(goal, state);
    const reportPath = await writeReport({
      workspaceDir: workspace.workspaceDir, goal, workspaceUuid: workspace.uuid,
      artifacts: state.artifacts, charts: state.chartImages, conclusion
    });
    const reportArtifact = await registerArtifact(db, {
      workspaceUuid: workspace.uuid, artifactsDir: workspace.artifactsDir,
      kind: 'summary', format: 'md', schemaJson: { type: 'report' },
      metadataJson: { source: 'report' },
      payload: null, storageUriOverride: reportPath, skipWrite: true
    });
    state.artifacts.push({ artifact_uuid: reportArtifact.artifactUuid, kind: 'summary', summary: { report: reportArtifact.storageUri }, storage_uri: reportArtifact.storageUri });

    await log('final', 'report', { report_written: true }, max_steps);
    await log('final', 'max_steps', { max_steps, tokens: tokens.cumulative });
    await updateWorkspace(db, workspace.uuid, { status: 'completed', finishedAt: new Date(), message: 'Max steps reached' });
    await logger.close();
    return {
      status: 'ok', workspace_uuid: workspace.uuid,
      artifacts: state.artifacts.map(summarizeArtifact),
      summary: 'ASO completed (max steps reached).',
      tokens: tokens.cumulative
    };

  } catch (err) {
    await log('error', 'exception', { message: err.message });
    await updateWorkspace(db, workspace.uuid, { status: 'failed', finishedAt: new Date(), message: err.message });
    await logger.close();
    return { status: 'error', error: err.message, workspace_uuid: workspace.uuid, tokens: tokens.cumulative };
  }
}

module.exports = aso_hpa;
