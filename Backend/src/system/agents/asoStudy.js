'use strict';

/**
 * The study loop (aso_hpa). One prompt, one loop. Every turn the model sees the goal, its own plan,
 * every artifact in the workspace and where it came from, what is still running and what came
 * back since its last turn; then it calls tools: the same agents the chat offers (taken from the
 * orchestrator), table operations on artifacts, plan and note updates, skip (wait) and finish.
 * Every tool result is an artifact linked to its inputs. A tool that returns wakes the loop.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
const { inference, getActiveModel } = require('../../inference/gateway');
const { platformConfig } = require('../../policy/config');
const tools = require('../aso/studyTools');
const geneData = require('../../hpa/geneDataAdapter');
const { createWorkspace, updateWorkspace } = require('../aso/workspaceStore');
const { registerArtifact } = require('../aso/artifactStore');
const { createLogger } = require('../aso/logger');
const { renderCharts } = require('../aso/pipelines/renderCharts');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { localData, FILES } = require('../../hpa/localData');
const { StudyContext, bytes } = require('../aso/studyContext');
const { StudyConversation, planText } = require('../aso/studyConversation');
const { validate } = require('../aso/batchOperations');
const studyPlan = require('../aso/studyPlan');
const { renderReport } = require('../aso/studyReport');
const { rowPageOptions, readPage, formatPage, previewRows } = require('../aso/observationViews');
const { unverifiedNumbers, verificationIssues } = require('../aso/summaryEvidence');

const MAX_TURNS_DEFAULT = 40;     // platform_config.aso_max_steps overrides
const MAX_STALLS = 2;             // turns in a row with nothing to do before the loop ends
const WAKE_DEBOUNCE_MS = 300;     // completions this close together wake the loop once
const JOB_WAIT_MS = 15 * 60_000;  // longest the loop waits for a running agent
const FINISH_ROWS = 40;           // rows of each cited artifact shown when a finish is refused
const MAX_FINISH_REFUSALS = 2;    // a summary with numbers from nowhere is sent back this many times
const CELL = 60;                  // characters per shown cell
const RESULT_BYTES = 8192;        // one delivery page; never a conversation limit
const PREVIEW_BYTES = 2048;       // a receipt; full rows stay in the artifact

// ---- tools of the study itself ---------------------------------------------------------------------

const A = { type: 'string', description: 'artifact id, or a dataset name' };
const S = { type: 'string' };
const N = { type: 'integer' };
const RESULT_KIND = { type: 'string', enum: studyPlan.KINDS, description: 'gene_set for a biological selection question; table for measurements/calculations; a chart type such as heatmap/bar/scatter for one figure; interpretation for gene-specific evidence; summary for the final report.' };
const CHART_TYPE = { type: 'string', enum: studyPlan.CHART_KINDS };
const tool = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'object', properties, required } });
// One line each: the rules in the prompt do the teaching.
const STUDY_TOOLS = [
  tool('set_plan', 'Plan requested results: Deep Research selects cohorts; Investigator retrieves measurements and statistics for the supplied list; ASO combines results and draws figures. Describe outcomes without choosing low-level operations or guessing columns. Use a separate gene_set step for each selection and a separate step for each chart. Include interpretation only when requested.', { items: { type: 'array', items: { type: 'object', properties: { step: { type: 'string', description: 'Describe the requested result in words; item numbers are assigned automatically.' }, kind: RESULT_KIND, inputs: S }, required: ['step', 'kind'] } } }, ['items']),
  tool('update_plan', 'Revise a plan item (1-based), or append at the next number. artifacts lists evidence for done. A gene_set needs Deep Research, interpretation needs Investigator, and a chart kind needs a rendered figure of that type. Tag completing calls with node to avoid bookkeeping turns.', { item: N, status: { type: 'string', enum: ['todo', 'doing', 'done', 'dropped'] }, note: S, step: S, kind: RESULT_KIND, inputs: S, artifacts: { type: 'array', items: S } }, ['item']),
  tool('note', 'Record a decision or unresolved question. replace overwrites note N; empty text with replace removes it. Cite observation/artifact IDs for evidence.', { text: S, replace: N }, ['text']),
  tool('recall', 'Read the rest of a paged observation by id and offset, or search saved source evidence with query. limit caps search matches (default 12, max 30). The conversation already retains earlier results and corrections.', { id: S, query: S, offset: N, limit: N }),
  tool('datasets', 'Discover source files when investigating a gap reported by a specialist. Investigator already has the source catalog for measurement questions. about matches a word in names, titles or columns; omitted about lists all names.', { about: S }),
  tool('schema', 'Inspect saved result columns, or a source schema for a reported specialist gap. Investigator discovers measurement sources itself. about restricts both names and samples to matching columns; omit it for all names. Use describe for categories or distributions.', { what: S, about: S }, ['what']),
  tool('describe', 'Profile a dataset or artifact: column kinds, blanks, distinct values, examples, ranges and list grammar. columns narrows the profile; the result is saved for recall.', { what: S, columns: { type: 'array', items: S } }, ['what']),
  tool('open', 'Read dataset or artifact rows and full artifact provenance. rows (1–200) and columns select a page; offset is the zero-based row offset. Cells are never shortened. Saved observations can be recalled.', { what: S, rows: N, offset: N, columns: { type: 'array', items: S } }, ['what']),
  tool('explode', 'One row per item of a list cell: "key: number" items give <as>_key and <as>_value columns, "label (number)" gives <as>_label and <as>_value, plain items <as>_item.', { artifact: A, column: S, as: S }, ['artifact', 'column']),
  tool('measure', 'Direct source read for a gap reported by Investigator; delegate ordinary measurement questions to investigator_hpa with genes or from. Existing columns are retained; with entity one row per gene, otherwise one row per gene and entity, retaining the source entity column name. as names the new column. An entity requires entity_column. Multiple matching rows require an explicit aggregate, or read all raw rows with intersect.', { artifact: A, table: { type: 'string', description: 'dataset name' }, value_column: S, entity_column: S, entity: S, as: S, aggregate: { type: 'string', enum: ['min', 'max', 'mean', 'median'] } }, ['artifact', 'table', 'value_column', 'as']),
  tool('union', 'Genes in either artifact.', { a: A, b: A }, ['a', 'b']),
  tool('intersect', 'Rows of a whose gene is in b.', { a: A, b: A }, ['a', 'b']),
  tool('difference', 'Rows of a whose gene is not in b.', { a: A, b: A }, ['a', 'b']),
  tool('concat', 'All rows of a then all rows of b.', { a: A, b: A }, ['a', 'b']),
  tool('join', 'Rows of a combined with matching rows of b by gene (or "on"); clashing names of b get _2.', { a: A, b: A, how: { type: 'string', enum: ['inner', 'left'] }, on: S }, ['a', 'b']),
  tool('filter', 'Filter returned result rows by exact values or numeric thresholds; every clause must hold. Use Deep Research to select biological cohorts and Investigator to retrieve measurements for supplied names. op in takes a list; column_b compares columns. Can stream a raw dataset when addressing a reported specialist gap.', { artifact: A, where: { type: 'array', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: ['>', '>=', '<', '<=', '=', '!=', 'contains', 'in'] }, value: { description: 'a value, or a list of values for in' }, column_b: { type: 'string', description: 'compare with this column of the same row instead of value' } }, required: ['column', 'op'] } } }, ['artifact', 'where']),
  tool('select', 'Keep columns, rename them, add constant columns. Preserve gene and ensembl for subsequent gene operations.', { artifact: A, columns: { type: 'array', items: S }, rename: { type: 'string', description: 'JSON object from original column names to new names' }, add: { type: 'string', description: 'JSON object from new column names to constant values' } }, ['artifact']),
  tool('rank', 'Sort by a numeric column (adds rank); top keeps the first N.', { artifact: A, by: S, order: { type: 'string', enum: ['desc', 'asc'] }, top: N }, ['artifact', 'by']),
  tool('top_per_group', 'Keep the n highest rows per group (default group gene). Streams a whole dataset.', { artifact: A, group_by: S, by: S, n: N, order: { type: 'string', enum: ['desc', 'asc'] } }, ['artifact', 'by']),
  tool('aggregate', 'count, sum, mean, median, sd, q1, q3, min, max, missing, distinct of a column. group_by groups by one column; group_by_columns groups by several columns in one operation and retains each group label separately for grouped charts. Streams a whole dataset.', { artifact: A, group_by: S, group_by_columns: { type: 'array', items: S, description: 'Group by this combination of columns, keeping each label in its own output column. Use instead of group_by.' }, column: S, metrics: { type: 'array', items: { type: 'string', enum: ['count', 'sum', 'mean', 'median', 'sd', 'q1', 'q3', 'min', 'max', 'missing', 'distinct'] } } }, ['artifact', 'metrics']),
  tool('compute', 'Add a column from an expression over columns and numbers: + - * / ( ) log2 log10 ln abs sqrt exp min max; + also joins text, as in a + " / " + b.', { artifact: A, name: S, expr: { type: 'string', description: 'Exact column names; backticks quote names containing spaces. Double-quoted strings are literal text.' } }, ['artifact', 'name', 'expr']),
  tool('pivot', 'Reshape long rows into a matrix, retaining all input row and column labels. row defaults to gene. When the question requests a subset, select it with the table tools before pivoting.', { artifact: A, row: S, column: S, value: S }, ['artifact', 'column', 'value']),
  tool('chart', 'Draw an artifact: x the label column and y the value column (bar family), both numeric for scatter; heatmap takes a pivot. Missing numeric values fail unless missing=omit; omissions are recorded.', { artifact: A, type: CHART_TYPE, x: { type: 'string', description: 'X column; required except for a matrix heatmap' }, y: { type: 'string', description: 'Numeric Y/value column; required except for a matrix heatmap' }, group: S, size: S, label: S, title: S, x_label: S, y_label: S, missing: { type: 'string', enum: ['error', 'omit'] } }, ['artifact', 'type']),
  tool('correlate', 'Pearson or Spearman correlation of two numeric columns: r, p and n; group_by gives one per group.', { artifact: A, x: S, y: S, method: { type: 'string', enum: ['pearson', 'spearman'] }, group_by: S }, ['artifact', 'x', 'y']),
  tool('overlap', 'Rows two tables share by gene (or "on"), against a universe (an artifact or a dataset such as proteinatlas.tsv): shared, expected, fold and a hypergeometric p; group_by tests every group of a in one call.', { a: A, b: A, universe: A, on: S, group_by: S }, ['a', 'b', 'universe']),
  tool('standardize', 'Add a column with a numeric column rescaled: zscore, minmax or percentile.', { artifact: A, column: S, method: { type: 'string', enum: ['zscore', 'minmax', 'percentile'] }, as: S }, ['artifact', 'column', 'method']),
  tool('skip', 'Nothing to do until something running returns.', { reason: S }, ['reason']),
  tool('finish', 'Submit the study. tables inserts exact saved measurements automatically. Each table needs artifact and exact columns; rows defaults to 40 (maximum 200). Missing work must be stated.', { summary: { type: 'string', description: 'Concise interpretation with an artifact citation in every factual paragraph, including Investigator evidence when used. Put numerical result lists in tables instead of retyping them here. Preserve the source evidence classification and qualifiers; a cohort or dataset name does not establish evidence strength. State supported conclusions and limitations without upgrading associations to validated applications.' }, tables: { type: 'array', items: { type: 'object', properties: { artifact: S, columns: { type: 'array', items: S }, title: S, rows: N }, required: ['artifact', 'columns'] } } }, ['summary'])
];
const TABLE_TOOLS = new Set(['measure', 'union', 'intersect', 'difference', 'concat', 'join', 'filter', 'select', 'rank', 'top_per_group', 'aggregate', 'compute', 'pivot', 'chart', 'correlate', 'overlap', 'standardize', 'explode']);
const FOR_EACH = { type: 'object', description: 'once per value; $item stands for it', properties: { values: { type: 'array', items: S }, column: S, of: S, as: S } };
const NODE = { type: 'integer', description: 'plan item carried out' };
const MAX_FOR_EACH = 1000;
const PROFILE_MAX_ROWS = 200000;  // rows a describe scans in one file
const profileCache = new Map();   // file|columns → card, for this process

function systemPrompt() {
  return `Coordinate the researcher's requested study using the existing HPA agents and table tools. Work from imported raw datasets and saved artifacts. Every measurement, gene set and figure must come from a tool. Complete the requested deliverables without adding unrelated analyses.

Delegate source measurements to investigator_hpa. If the user supplies gene names, start investigator_hpa with genes=[those names] and the whole measurement question in your first response, alongside set_plan. When a cohort arrives from Deep Research, pass from=<its result ID>. Investigator discovers the source tables/columns and retrieves the data in bulk. Do not bootstrap a supplied list by filtering raw datasets, or inspect source schemas on Investigator's behalf. Your table operations work on returned results for comparisons, ranking, set operations and charts. Direct source reads remain available for a specific gap that Investigator reports; ordinary measurement retrieval belongs to Investigator.

Use the specialists throughout the study:
- deep_research_hpa owns biological gene-set selection and constructs the database search. Delegate each distinct selection question with the user's exact inclusion/exclusion criteria; do not weaken the categories, merge different questions, or reconstruct biological definitions with raw category-string filters. Start independent searches together, including later selections that do not depend on the first results. Keep distinct cohorts in separate artifacts, then use set tools to combine them. Inspect returned queries and any criteria the agent could not express.
- investigator_hpa handles source discovery and measurements for a supplied list as well as its existing single-gene investigations. Delegate the complete measurement question once using from=<saved result ID>, or genes=[the names already supplied by the user]. Include the requested per-gene statistics, missing/zero counts, top source entities and simple ratios in that question, so Investigator returns the required tables together. The runtime supplies the list; no gene-column selection or copying is needed. Investigator finds the sources and uses apply_bulk for these operations. Use kind=table for the complete measurement result. Keep single-gene interpretation calls when the study asks to investigate particular genes individually. Start them while independent work proceeds.
- Coordinate the scientific questions, combine cohorts and draw the requested figures. Use returned bulk tables directly. Apply an additional numerical transformation only when the question requests it, and avoid making extra tables just to rename or reorder displayed columns. finish.tables selects the columns to show. Avoid duplicating a delegated lookup with schema/filter/measure calls while it runs. Existing table tools remain available for requested calculations, transformations and inspection. Pass artifact IDs instead of copying gene lists from previews. Do not write custom code or database queries.

Plan the requested outcomes: gene_set for each biological selection, table for a complete measurement question including requested statistics and simple derived comparisons, the chart type (heatmap, scatter, bar, etc.) for each individual figure, interpretation for requested gene-level evidence, summary for the final report. Use these result kinds rather than guessing low-level operations. Revise steps as evidence arrives. Tag the call that completes a step with node=N; its saved result marks the step automatically. Preparatory calls need no node. Update the plan alongside useful work. Finish all requested work or explicitly drop an impossible step with its reason.

Call independent tools together. Agents return in the background. Do not duplicate a question already assigned to a running agent by starting another search or reconstructing it with raw filters. Work on independent returned results while waiting, or skip if all useful work depends on the pending result. Use returned artifact IDs in subsequent turns. A failed call reports its error: correct the arguments using that feedback.

The original goal and every tool exchange remain in the conversation. Results show their source arguments and newly created columns with a small row preview. All rows remain in the artifact. schema shows column names and samples; about restricts it to relevant fields. describe scans a column's values only when a profile is needed. open selects exact rows/columns; recall reads a longer saved observation. Reuse what is already known.

A dataset name works wherever a table tool takes an artifact. Gene operations require gene/ensembl: preserve those identifiers when selecting columns. measure adds its named column to the input, so successive measurements retain earlier values. Keep source units and missing values; choose an aggregation explicitly for multiple source measurements. Undefined ratios remain missing; do not introduce pseudocounts. Use rank for a global top list, top_per_group for maxima within each group, and aggregate for grouped counts/statistics. When grouping by multiple attributes, use aggregate.group_by_columns to retain separate labels for a grouped chart; do not encode the groups into a combined string. for_each repeats an operation across discovered values using $item. A heatmap uses pivot; grouped_bar uses group. Missing chart values require missing=omit and recorded omissions.

Before finish, check the original requested outputs, cohort selection, units, sources and scientific interpretation. Inspect returned agent evidence. finish.tables inserts exact saved values; summary cites artifacts for interpretation, figures and limitations. Preserve source qualifiers in prose, headings and figures, and describe differing cohort results separately. Label calculated quantities from the actual expression, with the numerator and denominator in that order; ratios of matching units and their logarithms are dimensionless. Measurements retain their source units. Keep alternative assays distinct. Report absent matches and missing measurements explicitly. Plan completion verifies execution, not scientific correctness. Never claim unfinished work succeeded.`;
}

// ---- context rendering -----------------------------------------------------------------------------

function cell(v) {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > CELL ? `${s.slice(0, CELL - 1)}…` : s;
}

function shownColumns(columns, pick = null) {
  if (Array.isArray(pick) && pick.length) return pick.map(p => {
    const column = columns.find(c => c === p) || columns.find(c => c.toLowerCase() === String(p).toLowerCase());
    if (!column) throw new Error(`No column ${JSON.stringify(p)}; available: ${columns.join(', ')}`);
    return column;
  });
  return columns.slice(0, 7);
}

function sampleLines(rows, columns, n, pick = null) {
  const cols = shownColumns(columns, pick);
  return rows.slice(0, n).map(r => cols.map(c => cell(r[c])).join(' | '));
}

const MAX_HELD_ROWS = 5000000;    // rows held in memory at once; streaming tools have no limit

// Gene and ensembl keys for a row read straight from a dataset, so set operations and joins work.
function geneKeys(entry, row) {
  const isEnsembl = v => /^ENSG\d{5,}$/.test(String(v || ''));
  if (entry.key === 'name') return { gene: row[entry.columns[0]] || null, ensembl: row[entry.columns[1]] || null };
  const column = entry.geneColumn || entry.columns.find(c => isEnsembl(row[c]));
  const name = row['Gene name'] ?? (isEnsembl(row.Gene) ? null : row.Gene) ?? null;
  return { gene: name || null, ensembl: column ? row[column] || null : null };
}

// Every row of a dataset, keyed, as they stream from disk.
async function* datasetStream(entry) {
  for await (const row of localData.rows(entry.file)) yield { ...geneKeys(entry, row), ...row };
}

// A dataset used where an artifact goes. Gene-level files come whole; a per-gene file comes
// restricted to the genes of the other input, filtered while it streams, or whole when it fits.
async function datasetRows(entry, { genes = null, where = null, limit = 3 } = {}) {
  if (entry.key === 'master') {
    const master = await localData.master();
    return master.rows.map(r => ({ ...geneKeys(entry, r), ...r }));
  }
  if (entry.key === 'lookup' || entry.key === 'scan') return (await localData.table(entry.file)).rows.map(r => ({ ...geneKeys(entry, r), ...r }));
  if (genes && entry.key === 'stream') {
    const wanted = new Set(genes.flatMap(r => [r.ensembl, r.gene].filter(Boolean).map(v => String(v).toLowerCase())));
    const out = [];
    for await (const row of datasetStream(entry)) {
      const k = geneKeys(entry, row);
      if ((k.ensembl && wanted.has(String(k.ensembl).toLowerCase())) || (k.gene && wanted.has(String(k.gene).toLowerCase()))) out.push(row);
    }
    return out;
  }
  if (genes) {
    const seen = new Set();
    const queue = [];
    for (const r of genes) { const k = r.ensembl || r.gene; if (k && !seen.has(k)) { seen.add(k); queue.push(k); } }
    const out = [];
    const worker = async () => {
      while (queue.length) {
        const gene = await geneData.resolveGene(queue.shift());
        if (!gene) continue;
        const reading = await geneData.read(gene, entry.file);
        for (const row of reading.rows) out.push({ gene: gene.gene, ensembl: gene.ensembl, ...row });
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, queue.length)) }, worker));
    return out;
  }
  if (where) {
    const keep = tools.wherePredicate(['gene', 'ensembl', ...entry.columns], where);
    const out = [];
    for await (const row of datasetStream(entry)) if (keep(row)) out.push(row);
    return out;
  }
  const out = [];
  for await (const row of datasetStream(entry)) {
    out.push(row);
    if (out.length > MAX_HELD_ROWS) throw new Error(`${entry.file} has more than ${MAX_HELD_ROWS} rows, more than fits in memory at once: filter, aggregate or top_per_group stream it, or use it with an artifact (join, intersect, difference) so only those genes are read`);
  }
  return out;
}

// Arguments as they appear on the desk: whole, cut only between arguments. A cut inside a value
// can otherwise change an output column name and make later steps refer to a nonexistent column.
function describeArgs(args, max = 160) {
  const parts = Object.entries(args || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => { const text = typeof v === 'string' ? v : JSON.stringify(v); return `${k}=${text.length > 80 ? `${text.slice(0, 79)}…` : text}`; });
  let out = '';
  for (const part of parts) {
    if (out && out.length + part.length + 2 > max) { out += ', …'; break; }
    out += (out ? ', ' : '') + part;
  }
  return out;
}

// ---- artifacts from tool results ---------------------------------------------------------------------

function normalizeSearchRow(r) {
  const out = { gene: r.Gene ?? r.gene ?? null, ensembl: r.Ensembl ?? r.ensembl ?? null };
  for (const [k, v] of Object.entries(r)) {
    if (['Gene', 'Ensembl', 'gene', 'ensembl'].includes(k) || v === null || v === undefined || v === 'NA' || String(v).trim() === '') continue;
    out[k] = v;
  }
  return out;
}

function scalarRow(obj) {
  const row = {};
  for (const [k, v] of Object.entries(obj || {})) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) row[k] = v;
  return row;
}

// What an agent's result becomes: rows for a gene set or an answer, text for a lookup.
function agentArtifact(tool, args, result) {
  if (tool === 'deep_research_hpa') {
    if (result?.status !== 'ok') throw new Error(result?.error || 'search failed');
    const r = result.result || {};
    return { kind: 'data', label: String(args.goal || 'search').slice(0, 80), rows: (r.rows || []).map(normalizeSearchRow), meta: { search_url: r.search_urls?.[0] || null, query: r.plan || null, not_expressible: (r.not_expressible || []).map(c => c.requirement), mode: r.mode || null } };
  }
  if (tool === 'investigator_hpa') {
    if (result?.error && result.found !== true) throw new Error(result.error);
    return { kind: 'answer', label: `${result.gene || args.gene}: ${String(args.question || '').slice(0, 60)}`, rows: [{ gene: result.gene || args.gene, ensembl: result.ensembl || null, question: args.question || '', found: result.found === true, answer: result.answer || '', value: result.extracted_value ?? null, entity: result.exact_label ?? null, table: result.source_section || null, cited_row: result.cited_row || null }], meta: { not_in_release: result.not_in_release || [], notes: result.notes || [], citations: result.citations || [], grounded: result.grounded } };
  }
  if (tool === 'check_inclusion_hpa') {
    return { kind: 'answer', label: `${args.gene} in search result?`, rows: [scalarRow(result)], meta: {} };
  }
  const text = [result?.summary, result?.answer, result?.content, result?.text].find(v => typeof v === 'string') || JSON.stringify(scalarRow(result));
  return { kind: 'note', label: String(args.topic || args.question || tool).slice(0, 80), rows: [], text: String(text), meta: { images: Array.isArray(result?.images) ? result.images.length : 0 } };
}

// ---- the loop --------------------------------------------------------------------------------------

async function asoStudy({ goal, mode: requestedMode, max_turns, reasoning_effort, context_budget_bytes }, ctx = {}) {
  const effort = reasoning_effort || ctx.reasoning_effort || null;
  const db = ctx.db;
  if (!db) throw new Error('The study requires db in context.');
  getActiveModel();
  const orchestrator = require('../orchestrator'); // at call time: the orchestrator requires this module too
  const config = platformConfig();
  if (context_budget_bytes !== undefined) throw new Error('context_budget_bytes is no longer supported: ASO preserves its conversation without automatic compaction.');
  const maxTurns = Number(max_turns) > 0 ? Number(max_turns) : (config.asoMaxSteps || MAX_TURNS_DEFAULT);
  const agentMode = await resolveAgentMode(requestedMode ?? 'offline', [FILES.master]);
  const mode = agentMode.mode;
  const startedAt = Date.now();
  const tokens = { prompt: 0, completion: 0, total: 0 };
  const addUsage = usage => { tokens.prompt += usage?.prompt_tokens || 0; tokens.completion += usage?.completion_tokens || 0; tokens.total += (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0); };

  const workspace = await createWorkspace(db, { visitorId: ctx.visitorId, inferenceModelId: getActiveModel().id, requestText: goal, planJson: { goal, mode, hpa_version: agentMode.hpaVersion, version: 'native-study' } });
  inference.assignContext({ workspaceId: workspace.id });
  const logger = createLogger(workspace.logPath);
  const log = async (event, data, step) => {
    if (ctx.onStep) await ctx.onStep({ stage: event, label: event, message: typeof data === 'string' ? data : JSON.stringify(data), step });
    return logger.logEvent({ event, data, step });
  };
  let registrations = Promise.resolve();
  const register = args => { const next = registrations.then(() => registerArtifact(db, args)); registrations = next.catch(() => {}); return next; };

  const contextMemory = new StudyContext();
  const state = { goal, plan: [], artifacts: [], byId: new Map(), running: new Map(), notes: [], history: [], turn: 0, toolCalls: 0, failed: 0, ids: { a: 0, t: 0 } };
  const observationScope = new AsyncLocalStorage();
  const capture = id => { const scope = observationScope.getStore(); if (scope?.open) scope.ids.push(id); return id; };
  const observe = (text, options = {}) => {
    const kind = /feedback|decision/.test(options.source || '') ? 'control' : 'evidence';
    const id = contextMemory.add(text, { turn: state.turn, kind, ...options });
    if (options.announce !== false) capture(id);
    return id;
  };
  const conversation = new StudyConversation({ goal, archive: contextMemory, resultBytes: RESULT_BYTES });
  // Control feedback also uses the durable observation path. There is no turn-based clearing.
  state.recent = { push: (...messages) => messages.map(text => observe(text, { source: 'control feedback' })) };
  // History collapses a repeated action within a turn ("opened a3 ×4"), so a repeat is not a pattern to copy.
  const remember = (text) => {
    const entry = state.history[state.history.length - 1];
    if (entry && entry.turn === state.turn) {
      const last = entry.items[entry.items.length - 1] || '';
      const m = last.match(/^(.*) ×(\d+)$/);
      if (last === text) entry.items[entry.items.length - 1] = `${text} ×2`;
      else if (m && m[1] === text) entry.items[entry.items.length - 1] = `${text} ×${Number(m[2]) + 1}`;
      else entry.items.push(text);
    } else state.history.push({ turn: state.turn, items: [text] });
  };
  const planItem = studyPlan.createItem;
  const completionIssue = item => studyPlan.completionIssue(item, state.byId);
  // A preparatory operation may advance a step without completing its promised output.
  const markNode = async (n, artifactId, expectedItem) => {
    const item = state.plan[n - 1];
    if (expectedItem && item !== expectedItem) {
      observe(`Job for a previous plan item ${n} returned ${artifactId}; the rewritten plan was not marked done.`, { source: 'control feedback', refs: [artifactId] });
      return;
    }
    if (!item) return;
    item.artifacts = [...new Set([...item.artifacts, artifactId])];
    const issue = completionIssue(item);
    item.status = issue ? 'doing' : 'done';
    item.note = `→ ${item.artifacts.join(', ')}`;
    if (issue) observe(`Plan item ${n} remains doing: ${issue}. ${artifactId} is supporting work; complete the output or revise the plan explicitly.`, { source: 'control feedback', refs: item.artifacts });
    planTouched = true;
    remember(`plan item ${n} ${item.status} (${artifactId})`);
    await log('plan', { items: state.plan, changed: n });
  };
  const wake = { resolve: null };
  const wakeUp = () => { if (wake.resolve) { const r = wake.resolve; wake.resolve = null; r(); } };
  const artifactsSummary = () => state.artifacts.map(a => ({ artifact_uuid: a.uuid, kind: a.kind === 'figure' ? 'figure' : a.kind === 'note' ? 'inspection' : a.kind === 'answer' ? 'measurement' : 'dataset', tool: a.tool, summary: { id: a.id, label: a.label, row_count: a.rows?.length }, storage_uri: a.storageUri }));

  const agentSpecs = orchestrator.getToolSpecs().filter(t => t.function.name !== 'aso_hpa').map(t => {
    if (t.function.name !== 'investigator_hpa') return t;
    return { ...t, function: { ...t.function, description: 'Delegate the complete source measurement question for a supplied list: raw values, per-gene statistics, missing/zero counts, top source entities and simple ratios. Pass genes for user-supplied names or from for a saved cohort. Investigator discovers sources and returns ready-to-use tables for all requested outputs together. Existing single-gene investigation remains available through gene. No list preparation, raw filtering or source-schema inspection is needed before calling.', parameters: { ...t.function.parameters, required: [], properties: {
      ...t.function.parameters.properties,
      genes: { type: 'array', items: S, description: 'Supplied gene names for a bulk question. Use from when the list is already saved.' },
      from: { type: 'string', description: 'Saved result ID containing the supplied list. The runtime passes its genes and existing values to Investigator. No column selection or list copying is needed. Supply one of gene, genes or from.' }
    } } } };
  });
  const agentNames = new Set(agentSpecs.map(t => t.function.name));
  const toolSpecs = [...agentSpecs, ...STUDY_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))]
    .map(t => {
      const name = t.function.name;
      if (!TABLE_TOOLS.has(name) && !agentNames.has(name)) return t;
      const properties = { ...t.function.parameters.properties, node: NODE, ...(TABLE_TOOLS.has(name) && !['chart', 'pivot'].includes(name) ? { for_each: FOR_EACH } : {}) };
      return { ...t, function: { ...t.function, parameters: { ...t.function.parameters, properties } } };
    });
  const system = systemPrompt();

  const get = id => {
    const key = String(id || '').trim();
    const a = state.byId.get(key);
    if (!a) throw new Error(`no artifact "${id}" (have ${state.artifacts.map(x => x.id).join(', ') || 'none'})`);
    return a;
  };

  // Stores a tool's output as an artifact, linked to the artifacts it read.
  async function addArtifact({ kind, label, rows, matrix, text, tool, args, inputs, meta, figure, toolId, columns: suppliedColumns }) {
    const id = `a${++state.ids.a}`;
    const sources = inputs.map(i => state.byId.get(i)?.uuid).filter(Boolean);
    const base = { workspaceId: workspace.id, artifactsDir: workspace.artifactsDir };
    let reg;
    let images = [];
    if (kind === 'figure') {
      reg = await register({ ...base, kind: 'figure', format: 'json', schemaJson: { type: 'chart_spec' }, provenance: { tool: 'chart', sources, purpose: label }, payload: { charts: [figure], node_id: id, label, args, provenance: { tool: 'chart', purpose: label, sources } } });
      const renderDir = path.join(workspace.workspaceDir, 'render', id);
      await fs.mkdir(renderDir, { recursive: true });
      try {
        const rendered = await renderCharts(reg.storageUri, renderDir);
        for (const [i, img] of (rendered?.images || []).entries()) {
          const target = path.join(workspace.artifactsDir, `${id}${i ? `_${i + 1}` : ''}.png`);
          await fs.rename(img, target);
          await register({ ...base, kind: 'figure', format: 'png', schemaJson: { type: 'image' }, provenance: { tool: 'chart', source: reg.artifactUuid, purpose: label }, payload: null, storageUriOverride: target, skipWrite: true });
          images.push(path.basename(target));
        }
      } catch (err) {
        await log('render.failed', { artifact: id, error: err.message });
      }
    } else {
      const columns = suppliedColumns || (rows ? tools.columnsOf(rows) : []);
      const artifactKind = kind === 'answer' ? 'answer' : kind === 'note' ? 'note' : tool === 'deep_research_hpa' ? 'gene_list' : tool === 'measure' ? 'measurement' : `analysis_${tool}`;
      const payload = matrix
        ? { node_id: id, op: tool, label, args, row_count: matrix.row_labels.length, column_count: matrix.col_labels.length, ...matrix, provenance: { tool, purpose: label, sources, ...(meta || {}) } }
        : { node_id: id, op: tool, label, args, row_count: rows ? rows.length : 0, columns, rows: rows || [], text: text || undefined, provenance: { tool, purpose: label, sources, ...(meta || {}) } };
      reg = await register({ ...base, kind: artifactKind, format: 'json', schemaJson: { type: tool, columns }, provenance: { tool, sources, purpose: label }, payload });
    }
    const columns = suppliedColumns || (rows ? tools.columnsOf(rows) : []);
    const size = kind === 'figure' ? 'figure' : matrix ? `${matrix.row_labels.length} × ${matrix.col_labels.length} matrix` : kind === 'note' ? 'note' : `${rows.length} rows`;
    const a = { id, uuid: reg.artifactUuid, storageUri: reg.storageUri, kind, label, size, rows: rows || null, matrix: matrix || null, figure: figure || null, text: text || null, columns, tool, args, inputs, meta: meta || {}, images, toolId, turn: state.turn };
    state.artifacts.push(a);
    state.byId.set(id, a);
    return a;
  }

// Small results can fit in the receipt; large results show a sample. Both have a byte limit.
const receipt = a => {
  if (a.kind === 'figure') return `${a.id} (${a.size}; ${a.images.length} rendered images; ${a.meta.omitted_rows || 0} rows omitted for missing values)`;
  if (a.matrix) return `${a.id} (${a.size}; rows ${a.matrix.row_labels.slice(0, 8).join(', ')}${a.matrix.row_labels.length > 8 ? ', …' : ''}; columns ${a.matrix.col_labels.slice(0, 8).join(', ')}${a.matrix.col_labels.length > 8 ? ', …' : ''})`;
  if (a.text) return `${a.id}: ${a.text}`;
  if (!a.rows || !a.rows.length) return `${a.id} (${a.size})`;
  const columns = a.meta.bulk
    ? shownColumns(a.columns, a.columns.filter(key => !/_source_rows$|_missing_rows$/.test(key)).slice(0, 12))
    : shownColumns(a.columns);
  return `${a.id} (${a.size}; showing ${columns.length}/${a.columns.length} columns: ${columns.join(', ')}; describe/open for other columns):\n${formatPage(previewRows(a.rows, columns, PREVIEW_BYTES, a.rows.length <= 40 ? 40 : 2), columns)}`;
};
const artifactEvent = a => ({ id: a.id, kind: a.kind, label: a.label, size: a.size, rows: a.rows ? a.rows.length : undefined, columns: a.columns.slice(0, 12), sample: a.rows ? sampleLines(a.rows, a.columns, 3).map(l => l.split(' | ')) : undefined, sample_columns: a.columns.slice(0, 7), text: a.text ? a.text.slice(0, 600) : undefined, images: a.images, artifact_uuid: a.uuid, search_url: a.meta?.search_url, query: a.meta?.query, inputs: a.inputs });

  // An agent runs in the background through the orchestrator, exactly as a chat message would.
  function startAgent(tool, args) {
    const node = Number(args?.node) || 0;
    const plannedItem = node ? state.plan[node - 1] : null;
    if (node) { args = { ...args }; delete args.node; }
    const executionArgs = { ...args, mode: args.mode || mode };
    let inputRows;
    const inputs = [];
    if (tool === 'investigator_hpa' && args.from !== undefined) {
      if (args.gene !== undefined || args.genes !== undefined) throw new Error('Use one of gene, genes or from');
      const input = get(args.from);
      if (!Array.isArray(input.rows) || input.rows.some(row => !row.ensembl && !row.gene)) throw new Error(`${args.from} must contain gene rows`);
      inputRows = input.rows;
      inputs.push(input.id);
      delete executionArgs.from;
      executionArgs.genes = inputRows.map(row => row.ensembl || row.gene);
    }
    const id = `t${++state.ids.t}`;
    const job = { id, tool, args, startedAt: Date.now(), kind: 'agent' };
    state.running.set(id, job);
    state.toolCalls++;
    const label = String(args.goal || args.question || args.topic || args.gene || tool).slice(0, 80);
    log('tool.start', { id, tool, kind: 'agent', label, args, inputs }, id);
    const forward = async s => log(`agent.${s.stage}`, { id, label: s.label, message: s.message }, id);
    job.promise = orchestrator.execute(tool, executionArgs, { db, visitorId: ctx.visitorId, rawQuery: '', includeRows: true, onStep: forward, inputRows, studyGoal: goal, studyTask: plannedItem?.text, reasoningEffort: effort })
      .then(async ({ result }) => {
        if (result?.bulk && result.error && !result.tables?.length) throw new Error(result.error);
        const outputs = result?.bulk ? result.tables.map(table => ({
          kind: 'data', label: table.name, rows: table.rows, columns: table.columns,
          meta: { bulk: true, status: result.status, error: result.error, answer: result.answer, lookups: table.provenance, coverage: table.coverage, calculations: table.calculations, sort: table.sort, input_count: result.input_count, unresolved_inputs: result.unresolved_inputs, not_in_release: result.not_in_release, remaining_for_aso: result.remaining_for_aso || [] }
        })) : [agentArtifact(tool, args, result)];
        if (!outputs.length) throw new Error(`Investigator returned no table: ${JSON.stringify(result.not_in_release)}`);
        for (const built of outputs) {
          const a = await addArtifact({ ...built, tool, args: node ? { ...args, node } : args, inputs, toolId: id });
          if (node) await markNode(node, a.id, plannedItem);
          observe(`${id} ${tool} returned ${result?.bulk ? a.label + ': ' : ''}${receipt(a)}${result?.remaining_for_aso?.length ? `\nUnfinished work for ASO: ${JSON.stringify(result.remaining_for_aso)}` : ''}${result?.bulk && inputs.length ? `\nIncludes the input columns from ${inputs.join(', ')}; use this result directly.` : ''}\nProvenance: ${JSON.stringify({ args, meta: a.meta })}`, { source: `artifact ${a.id}`, refs: [a.id, ...inputs] });
          remember(`${tool} → ${a.id} (${a.size})`);
          await log('tool.done', { id, tool, kind: 'agent', artifact: artifactEvent(a), ms: Date.now() - job.startedAt }, id);
        }
      })
      .catch(async err => {
        state.failed++;
        state.recent.push(`${id} ${tool} failed: ${err.message}`);
        remember(`${tool} failed: ${err.message.slice(0, 90)}`);
        await log('tool.failed', { id, tool, kind: 'agent', error: err.message, ms: Date.now() - job.startedAt }, id);
      })
      .finally(() => { state.running.delete(id); wakeUp(); });
    return { job: id, agent: tool, status: 'running' };
  }

  // Table tools run at once on the artifacts named in the call.
  // One table operation: inputs resolved (artifacts, datasets, streams), the operation applied.
  async function computeOut(tool, args) {
      const parallel = config.asoParallelLimit || 3;
      const inputColumns = new Set();
      let streamed = false;
      // An input is an artifact on the desk or a dataset on disk; a per-gene dataset is read for
      // the genes of the other input (join, set operations) or filtered as it streams.
      const rowsOf = async (key, other = null) => {
        const ref = String(args[key] ?? '').trim();
        if (state.byId.has(ref)) {
          const a = get(ref);
          if (a.matrix) throw new Error(`${a.id} is a matrix; only a heatmap chart can take it`);
          if (!a.rows) throw new Error(`${a.id} has no rows`);
          for (const c of a.columns) inputColumns.add(c);
          return a.rows;
        }
        const entry = ref ? await geneData.entry(ref) : null;
        if (!entry || entry.key === 'unreadable') throw new Error(`nothing called "${ref || '(no name)'}" on the desk or on disk (artifacts: ${[...state.byId.keys()].join(', ') || 'none'}; datasets lists what is on disk)`);
        const otherRef = other ? String(args[other] ?? '').trim() : '';
        const genes = otherRef && state.byId.has(otherRef) ? get(otherRef).rows || null : null;
        const rows = await datasetRows(entry, { genes, where: tool === 'filter' ? args.where : null, limit: parallel });
        streamed = tool === 'filter' && !genes && !['master', 'lookup', 'scan'].includes(entry.key);
        for (const c of ['gene', 'ensembl', ...entry.columns]) inputColumns.add(c);
        return rows;
      };
      // A whole per-gene dataset named as the input of a streaming tool.
      const wholeDataset = async key => {
        const ref = String(args[key] ?? '').trim();
        if (!ref || state.byId.has(ref)) return null;
        const entry = await geneData.entry(ref);
        if (!entry || !['ensembl', 'name', 'scan', 'stream'].includes(entry.key)) return null;
        for (const c of ['gene', 'ensembl', ...entry.columns]) inputColumns.add(c);
        return entry;
      };
      let out;
      switch (tool) {
        case 'measure': out = { rows: await tools.measure(await rowsOf('artifact'), args, parallel) }; break;
        case 'union': case 'intersect': case 'difference': case 'concat': out = { rows: tools.setOp(tool, await rowsOf('a', 'b'), await rowsOf('b', 'a'), args.on || null) }; break;
        case 'join': out = { rows: tools.join(await rowsOf('a', 'b'), await rowsOf('b', 'a'), args.how, args.on || null) }; break;
        case 'filter': { const rows = await rowsOf('artifact'); out = { rows: streamed ? rows : tools.applyWhere(rows, args.where) }; break; }
        case 'select': { const obj = v => (typeof v === 'string' ? (JSON.parse(v || '{}') || {}) : (v || {})); out = { rows: tools.select(await rowsOf('artifact'), args.columns, obj(args.rename), obj(args.add)) }; break; }
        case 'rank': out = { rows: tools.rank(await rowsOf('artifact'), args.by, args.order, Number(args.top) || 0) }; break;
        case 'top_per_group': { const entry = await wholeDataset('artifact'); out = { rows: entry ? await tools.topPerGroupStream(datasetStream(entry), args, ['gene', 'ensembl', ...entry.columns]) : tools.topPerGroup(await rowsOf('artifact'), args) }; break; }
        case 'aggregate': { const entry = await wholeDataset('artifact'); out = { rows: entry ? await tools.aggregateStream(datasetStream(entry), args, ['gene', 'ensembl', ...entry.columns]) : tools.aggregate(await rowsOf('artifact'), args) }; break; }
        case 'correlate': out = { rows: tools.correlate(await rowsOf('artifact'), args) }; break;
        case 'overlap': out = { rows: tools.overlap(await rowsOf('a', 'b'), await rowsOf('b', 'a'), await rowsOf('universe'), args.on || null, args.group_by || null) }; break;
        case 'standardize': out = { rows: tools.standardize(await rowsOf('artifact'), args) }; break;
        case 'explode': out = { rows: tools.explode(await rowsOf('artifact'), args.column, args.as) }; break;
        case 'compute': out = { rows: tools.compute(await rowsOf('artifact'), String(args.name), String(args.expr)) }; break;
        case 'pivot': out = { matrix: tools.pivot(await rowsOf('artifact'), args) }; break;
        case 'chart': { const a = get(args.artifact); const input = a.matrix || (args.type === 'heatmap' && args.value ? tools.pivot(a.rows, { row: args.y, column: args.x, value: args.value }) : a.rows); out = { figure: tools.chartSpec(args, input) }; break; }
        default: throw new Error(`unknown tool ${tool}`);
      }
    return { out, inputColumns };
  }

  // The same operation once per value, "$item" standing for the value; one table results.
  async function forEach(tool, args) {
    if (['chart', 'pivot'].includes(tool)) throw new Error(`${tool} cannot run for_each; run it on the combined result`);
    const spec = args.for_each && typeof args.for_each === 'object' ? args.for_each : {};
    let values = Array.isArray(spec.values) ? spec.values.map(String) : (typeof spec.values === 'string' && spec.values.trim() ? spec.values.split(/\s*[|,]\s*/) : null);
    if (!values && spec.column) {
      const ref = String(spec.of ?? args.artifact ?? args.a ?? '').trim();
      let rows;
      if (state.byId.has(ref)) rows = get(ref).rows || [];
      else {
        const entry = await geneData.entry(ref);
        if (!entry || entry.key === 'unreadable') throw new Error(`for_each: nothing called "${ref}" to take ${spec.column} from`);
        const seen = new Set();
        for await (const row of datasetStream(entry)) { const v = String(row[spec.column] ?? '').trim(); if (v) seen.add(v); if (seen.size > MAX_FOR_EACH) break; }
        rows = [...seen].map(v => ({ [spec.column]: v }));
      }
      const col = tools.findColumn(rows, spec.column);
      if (!col) throw new Error(`for_each: no column named "${spec.column}" in ${ref}`);
      values = [...new Set(rows.map(r => String(r[col] ?? '').trim()).filter(Boolean))];
    }
    if (!values || !values.length) throw new Error('for_each: give values, or column (and of) to take the distinct values of a column');
    if (values.length > MAX_FOR_EACH) throw new Error(`for_each over ${values.length} values would run the operation ${values.length} times; use a group_by tool, or narrow the values`);
    const itemCol = String(spec.as || 'item');
    const { for_each: _spec, ...rest } = args;
    const sub = (v, x) => (typeof x === 'string' ? x.split('$item').join(v).split('${item}').join(v) : Array.isArray(x) ? x.map(y => sub(v, y)) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, sub(v, y)])) : x);
    const rows = [];
    const failed = [];
    const inputColumns = new Set();
    for (const v of values) {
      try {
        const r = await computeOut(tool, sub(v, rest));
        if (!r.out.rows) throw new Error('the operation gave no rows');
        for (const row of r.out.rows) rows.push({ [itemCol]: v, ...row });
        for (const c of r.inputColumns) inputColumns.add(c);
      } catch (err) { failed.push(`${v}: ${err.message.slice(0, 80)}`); }
    }
    if (failed.length === values.length) throw new Error(`for_each: every value failed; first: ${failed[0]}`);
    if (failed.length) state.recent.push(`for_each: ${failed.length} of ${values.length} values failed: ${failed.slice(0, 5).join('; ')}`);
    return { out: { rows }, inputColumns };
  }

  async function runTableTool(tool, args, { announce = true } = {}) {
    args = { ...args };
    // A two-table tool called with artifact instead of a: read it as a.
    if (['union', 'intersect', 'difference', 'concat', 'join', 'overlap'].includes(tool) && args && args.a === undefined && args.artifact !== undefined) args = { ...args, a: args.artifact };
    const node = Number(args?.node) || 0;
    if (node) { args = { ...args }; delete args.node; }
    const id = `t${++state.ids.t}`;
    const t0 = Date.now();
    state.toolCalls++;
    const inputs = ['artifact', 'a', 'b', 'universe'].map(k => args[k]).filter(Boolean).map(String);
    const label = tool === 'chart' ? String(args.title || 'figure').slice(0, 80) : `${tool}(${describeArgs(args, 100)})`;
    await log('tool.start', { id, tool, kind: tool === 'chart' ? 'chart' : 'tool', label, args, inputs }, id);
    try {
      const { out, inputColumns } = args.for_each ? await forEach(tool, args) : await computeOut(tool, args);
      if (out.rows) out.rows = tools.freshFirst(out.rows, [...inputColumns]);
      const a = await addArtifact({ kind: out.figure ? 'figure' : 'data', label: tool === 'chart' ? label : `${tool} of ${inputs.join(', ')}`, rows: out.rows, matrix: out.matrix, figure: out.figure, meta: out.figure ? { omitted_rows: out.figure.omitted_rows || 0 } : undefined, tool, args: node ? { ...args, node } : args, inputs, toolId: id });
      const observation = observe(`${id} ${tool} -> ${receipt(a)}\nProvenance: ${JSON.stringify(args)}`, { source: `artifact ${a.id}`, refs: [a.id, ...inputs], announce });
      remember(`${tool}(${inputs.join(', ')}) → ${a.id} (${a.size})`);
      if (node) await markNode(node, a.id);
      await log('tool.done', { id, tool, kind: out.figure ? 'chart' : 'tool', artifact: artifactEvent(a), ms: Date.now() - t0 }, id);
      return { ok: true, artifact: a, observation };
    } catch (err) {
      state.failed++;
      state.recent.push(`${id} ${tool}(${describeArgs(args).slice(0, 120)}) failed: ${err.message}`);
      remember(`${tool}(${inputs.join(', ')}) failed: ${err.message.slice(0, 90)}`);
      await log('tool.failed', { id, tool, kind: tool === 'chart' ? 'chart' : 'tool', error: err.message, ms: Date.now() - t0 }, id);
      return { ok: false, error: err.message };
    }
  }

  const waitForCompletion = () => new Promise(resolve => {
    const timer = setTimeout(resolve, JOB_WAIT_MS);
    wake.resolve = () => { clearTimeout(timer); setTimeout(resolve, WAKE_DEBOUNCE_MS); };
  });

  let finishSummary = null;
  let finishRefusals = 0;
  let unverified = [];
  let planTouched = false;
  let turn = 0;
  let stalls = 0;
  try {
    await log('start', { workspace_uuid: workspace.uuid, mode, hpa_version: agentMode.hpaVersion, model: getActiveModel().configKey, goal });
    await updateWorkspace(db, workspace.id, { status: 'running' });
    while (turn < maxTurns) {
      turn++;
      state.turn = turn;
      const offered = toolSpecs;
      const artifactsBefore = state.artifacts.length;
      planTouched = false;
      const snapshot = conversation.prepare(state, maxTurns);
      const context = JSON.stringify(snapshot.messages, null, 2);
      // The exact text the model saw this turn, kept as a file in the workspace (the event log
      // truncates long strings); the log keeps only its size.
      await fs.mkdir(path.join(workspace.workspaceDir, 'context'), { recursive: true });
      await fs.writeFile(path.join(workspace.workspaceDir, 'context', `turn-${String(turn).padStart(2, '0')}.txt`), context, { mode: 0o600 });
      await contextMemory.flush(path.join(workspace.workspaceDir, 'observations'));
      const request = { messages: [{ role: 'system', content: system }, ...snapshot.messages], tools: offered, temperature: 0, prompt_cache: { key: `study ${workspace.uuid}` }, ...(effort ? { reasoning_effort: effort } : {}) };
      await fs.writeFile(path.join(workspace.workspaceDir, 'context', `turn-${String(turn).padStart(2, '0')}.request.json`), JSON.stringify(request), { mode: 0o600 });
      const manifest = { turn, ...snapshot.manifest, system_bytes: bytes(system), tool_schema_bytes: bytes(JSON.stringify(offered)), request_bytes: bytes(JSON.stringify(request)), tools: offered.map(t => t.function.name) };
      const manifestPath = path.join(workspace.workspaceDir, 'context', `turn-${String(turn).padStart(2, '0')}.json`);
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await log('context', { turn, bytes: manifest.bytes, budget_bytes: manifest.budget_bytes, system_bytes: manifest.system_bytes, tool_schema_bytes: manifest.tool_schema_bytes, included: manifest.included.length, omitted: manifest.omitted.length });
      const res = await inference.chat.completions.create(request);
      await fs.writeFile(path.join(workspace.workspaceDir, 'context', `turn-${String(turn).padStart(2, '0')}.response.json`), JSON.stringify(res), { mode: 0o600 });
      addUsage(res.usage);
      conversation.acknowledge(snapshot);
      await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, usage: res.usage }, null, 2), { mode: 0o600 });
      const original = res.choices?.[0]?.message || {};
      const message = { ...original, role: 'assistant', tool_calls: (original.tool_calls || []).map((c, i) => ({ ...c, id: c.id || `study_${turn}_${i}`, type: 'function' })) };
      const calls = message.tool_calls.map(c => {
        try {
          const args = JSON.parse(c.function.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
          return { id: c.id, name: c.function.name, args };
        } catch (err) { return { id: c.id, name: c.function?.name, args: {}, error: err.message }; }
      });
      await log('turn', { turn, text: message.content ? String(message.content).slice(0, 600) : null, calls: calls.map(c => ({ tool: c.name, args: c.args })), offered: offered.length });
      let sync = 0;
      let waiting = false;
      async function executeCall(call) {
        if (call.error) throw new Error(`Invalid arguments: ${call.error}`);
        if (finishSummary !== null) throw new Error('Not run: this response already finished the study');
        const spec = offered.find(t => t.function.name === call.name);
        if (!spec) throw new Error(`Unknown tool ${call.name}; use a declared tool`);
        validate(call.args, spec.function.parameters, call.name);
        if (call.name === 'finish') {
          if (!state.plan.length) throw new Error('finish requires a plan: record the requested results with set_plan first.');
          const unseen = state.artifacts.slice(artifactsBefore).filter(a => a.kind !== 'figure');
          if (state.running.size || unseen.length) {
            observe(`finish refused: ${state.running.size ? `${state.running.size} agent jobs are still running. ` : ''}${unseen.length ? `New results ${unseen.map(a => a.id).join(', ')} arrived after your request snapshot; inspect them before concluding.` : 'Wait for their results or revise the plan.'}`, { source: 'control feedback', refs: unseen.map(a => a.id) });
            await log('finish.refused', { reason: 'results_pending', running: [...state.running.keys()], unseen: unseen.map(a => a.id) });
            sync++; return;
          }
          const summary = renderReport(call.args, state);
          const missing = unverifiedNumbers(summary, state);
          const isFinishStep = studyPlan.isReport;
          const undone = state.plan.map((p, i) => ({ ...p, n: i + 1 })).filter(p => p.status !== 'done' && p.status !== 'dropped' && !isFinishStep(p));
          if (undone.length && finishRefusals < MAX_FINISH_REFUSALS) {
            finishRefusals++;
            state.recent.push(`finish refused: the plan says ${undone.map(p => `item ${p.n}`).join(', ')} ${undone.length === 1 ? 'is' : 'are'} not done. A report can only state what was done. Do the work, mark an item dropped with a note saying why, or mark it done only if an artifact shows it is; then finish again.`);
            remember('finish refused: plan items not done');
            await log('finish.refused', { plan_items: undone.map(p => p.n), attempt: finishRefusals });
            sync++;
            return;
          }
          if (missing.length && finishRefusals < MAX_FINISH_REFUSALS) {
            finishRefusals++;
            const issues = verificationIssues(summary, state);
            const cited = [...new Set(issues.flatMap(issue => issue.artifacts))];
            observe(`finish refused. Repair these specific passages:\n${issues.map(issue => `${issue.reason}: ${JSON.stringify(issue.paragraph)}\nUnmatched numbers: ${issue.numbers.join(', ')}; cited sources: ${issue.artifacts.join(', ') || 'none'}`).join('\n\n')}\nFor no_source_citation, add the correct artifact ID in that paragraph (a reference elsewhere does not cover it). For number_not_in_cited_artifacts, check the source or compute the quantity. Counts and absence claims need a count/filter result; an empty filter is evidence of zero matches. Keep already supported passages.`, { source: 'finish feedback' });
            for (const id of cited) {
              const a = get(id);
              if (a.rows) observe(`${a.id} (${a.size}) columns: ${a.columns.join(', ')}\n${formatPage({ rows: a.rows.slice(0, FINISH_ROWS), offset: 0, total: a.rows.length, more: a.rows.length > FINISH_ROWS }, shownColumns(a.columns))}`, { source: `open ${a.id}`, refs: [a.id] });
              else if (a.matrix) state.recent.push(`${a.id} is a ${a.size}; rows ${a.matrix.row_labels.slice(0, 12).join(', ')}${a.matrix.row_labels.length > 12 ? ', …' : ''}; columns ${a.matrix.col_labels.slice(0, 12).join(', ')}${a.matrix.col_labels.length > 12 ? ', …' : ''}`);
              else if (a.text) observe(`${a.id}: ${a.text}`, { source: `open ${a.id}`, refs: [a.id] });
            }
            remember('finish refused: numbers not in any artifact');
            await log('finish.refused', { numbers: missing, issues, attempt: finishRefusals });
            sync++;
            return;
          }
          for (const p of state.plan) if (isFinishStep(p) && p.status !== 'done' && p.status !== 'dropped') { p.status = 'done'; p.note = 'finished'; }
          finishSummary = undone.length ? `Not done according to the plan: ${undone.map(p => `${p.n}. ${p.text}`).join('; ')}.\n\n${summary}` : summary;
          unverified = missing;
          return;
        }
        if (call.name === 'skip') { waiting = true; remember(`waited: ${String(call.args.reason || '').slice(0, 80)}`); await log('skip', { reason: call.args.reason || '' }); return; }
        if (call.name === 'set_plan') { sync++;  state.plan = (call.args.items || []).map(planItem); planTouched = true; remember('rewrote the plan'); await log('plan', { items: state.plan }); return; }
        if (call.name === 'update_plan') {
          sync++;
          const n = Number(call.args.item);
          let item = state.plan[n - 1];
          if (!item && n === state.plan.length + 1 && call.args.step) { item = planItem(call.args); state.plan.push(item); remember(`added plan item ${n}`); }
          if (item) {
            const next = { ...item };
            if (call.args.status) next.status = call.args.status;
            if (call.args.note) next.note = String(call.args.note);
            if (Object.hasOwn(call.args, 'artifacts')) next.artifacts = call.args.artifacts;
            for (const k of ['step', 'kind', 'inputs']) if (call.args[k]) next[k === 'step' ? 'text' : k] = String(call.args[k]);
            studyPlan.validateItem(next);
            const issue = next.status === 'done' ? completionIssue(next) : (!Array.isArray(next.artifacts) || next.artifacts.some(id => !state.byId.has(id))) ? 'artifacts must list existing artifact IDs' : null;
            if (issue) {
              observe(`update_plan refused for item ${n}: ${issue}. The item was not changed.`, { source: 'control feedback' });
              sync++; return;
            }
            Object.assign(item, next);
            planTouched = true;
            remember(`plan item ${n} ${call.args.status || 'edited'}`);
          } else state.recent.push(`update_plan failed: there is no item ${call.args.item} (add the next one with item=${state.plan.length + 1} and a step)`);
          await log('plan', { items: state.plan, changed: n }); return;
        }
        if (call.name === 'note') {
          sync++;
          const text = String(call.args.text || '').trim();
          const at = Number(call.args.replace) || 0;
          if (at >= 1 && at <= state.notes.length) { if (text) state.notes[at - 1] = text; else state.notes.splice(at - 1, 1); remember(text ? `rewrote note ${at}` : `removed note ${at}`); }
          else if (text) { state.notes.push(text); remember('wrote a note'); }
          await log('note', { text, replace: at || undefined });
          return;
        }
        if (call.name === 'recall') {
          try { capture(contextMemory.recall(call.args)); }
          catch (err) { state.recent.push(`recall failed: ${err.message}`); }
          sync++; return;
        }
        if (call.name === 'schema') {
          const { about } = call.args;
          const what = call.args.what;
          const target = state.byId.has(what) ? get(what) : await geneData.entry(what);
          if (!target || !target.columns) throw new Error(`No dataset or artifact ${what}`);
          const allColumns = target.columns;
          const columns = about ? allColumns.filter(c => c.toLowerCase().includes(about.toLowerCase())) : allColumns;
          const sample = state.byId.has(what) ? (target.rows || []).slice(0, 2) : (await readPage(localData.rows(target.file), { rows: 2, offset: 0 })).rows;
          const sampleColumns = [...new Set([...allColumns.slice(0, 2), ...(columns.length <= 16 || about ? columns : columns.slice(0, 8))])];
          const examples = sampleColumns.map(column => `${JSON.stringify(column)}: ${JSON.stringify([...new Set(sample.map(r => r[column]))].map(v => typeof v === 'string' && v.length > 100 ? v.slice(0, 100) + '… [open for full cell]' : v))}`);
          const header = `${what}: ${allColumns.length} total columns${about ? `; ${columns.length} matching ${JSON.stringify(about)}` : ''}\nColumns: ${JSON.stringify(columns)}`;
          const samples = `Raw sample values (${sampleColumns.length}/${allColumns.length} columns${about ? `; sample filter ${JSON.stringify(about)} matches ${columns.length}` : ''}; describe selected columns for categories). Use the exact source columns.\n${examples.join('\n')}`;
          const content = `${header}\n${samples}`;
          observe(content, { source: `schema ${what}`, refs: [what], projection: columns });
          sync++; return;
        }
        if (TABLE_TOOLS.has(call.name)) {
          const result = await runTableTool(call.name, call.args);
          sync++;
          return result.ok ? { status: 'completed', artifact: result.artifact.id } : { status: 'error', error: result.error };
        }
        if (agentNames.has(call.name)) return observationScope.run(null, () => startAgent(call.name, call.args));
        if (call.name === 'datasets') {
          const about = String(call.args.about || '').trim().toLowerCase();
          const all = (await geneData.catalog()).filter(e => e.key !== 'unreadable');
          const entries = about ? all.filter(e => e.file.toLowerCase().includes(about) || String(e.title || '').toLowerCase().includes(about) || e.columns.some(c => c.toLowerCase().includes(about))) : all;
          const large = e => (e.key === 'stream' ? '  (large: filter, aggregate or top_per_group stream it; no per-gene reads)' : '');
          if (!entries.length) state.recent.push(`no dataset has "${about}" in its name, title or columns; datasets with no word lists them all`);
          else observe(`datasets${about ? ` matching "${about}"` : ''} (${entries.length}):\n${entries.map(e => {
            const columns = about ? e.columns.filter(c => c.toLowerCase().includes(about)) : [];
            return about ? `  ${e.file} — ${e.title}${large(e)}${columns.length ? `; matching columns: ${columns.join(', ')}` : ''}` : e.file;
          }).join('\n')}`, { source: `datasets ${about}` });
          remember(about ? `browsed the datasets about ${about}` : 'listed the datasets'); sync++; return;
        }
        if (call.name === 'describe') {
          const requested = String(call.args.what ?? call.args.artifact ?? call.args.dataset ?? call.args.name ?? '').trim();
          const what = requested;
          const pick = Array.isArray(call.args.columns) ? call.args.columns.map(String) : (typeof call.args.columns === 'string' && call.args.columns.trim() ? call.args.columns.split(/\s*[|,]\s*/) : null);
          const cardLine = (c, columnCount) => {
            const values = c.observed_values && bytes(JSON.stringify(c.observed_values)) <= Math.floor(RESULT_BYTES / (2 * columnCount))
              ? `; all observed nonblank values: ${JSON.stringify(c.observed_values)}`
              : c.full_examples.length ? `; examples only: ${JSON.stringify(c.full_examples)}; aggregate group_by=${JSON.stringify(c.column)} metrics=["count"] lists every value` : '';
            return `${c.column} — ${c.kind}; ${c.blank_pct}% blank; distinct ${c.distinct}${values}${c.min !== undefined ? `; ${c.min} to ${c.max}` : ''}${c.list ? `; ${c.list}` : ''}`;
          };
          try {
            if (state.byId.has(what)) {
              const a = get(what);
              if (!a.rows) throw new Error(`${a.id} has no rows to describe`);
              const cols = pick ? shownColumns(a.columns, pick) : a.columns.slice(0, 40);
              observe(`${a.id} (${a.size}) described:\n  ${tools.profile(a.rows, cols).map(c => cardLine(c, cols.length)).join('\n  ')}${a.columns.length > cols.length ? `\n  … ${a.columns.length - cols.length} more columns (describe with columns)` : ''}`, { source: `describe ${a.id}`, refs: [a.id], projection: cols });
              remember(`described ${a.id}`);
            } else {
              const entry = await geneData.entry(what);
              if (!entry || entry.key === 'unreadable') throw new Error(`nothing called "${what}" on the desk or on disk; datasets lists what is on disk`);
              const cols = pick ? shownColumns(entry.columns, pick) : entry.columns.slice(0, 40);
              const key = `${agentMode.hpaVersion}|${entry.file}|${cols.join('|')}`;
              let card = profileCache.get(key);
              if (!card) { card = await tools.profileStream(datasetStream(entry), cols, PROFILE_MAX_ROWS); profileCache.set(key, card); }
              const scanned = card.rows >= PROFILE_MAX_ROWS ? ` (first ${PROFILE_MAX_ROWS.toLocaleString('en-US')} rows)` : ` (${card.rows.toLocaleString('en-US')} rows)`;
              const lines = card.profile.map(c => cardLine(c, cols.length));
              const text = `${entry.file} — ${entry.title}. ${entry.description || ''}${scanned}\n  ${lines.join('\n  ')}${entry.columns.length > cols.length ? `\n  … ${entry.columns.length - cols.length} more columns (describe with columns)` : ''}`;
              observe(text, { source: `describe ${entry.file}`, refs: [entry.file], projection: cols });
              remember(`described ${entry.file}`);
            }
          } catch (err) { state.recent.push(`describe failed: ${err.message}`); remember(`describe ${what || '(no name)'} failed`); }
          sync++; return;
        }
        if (call.name === 'open') {
          const requested = String(call.args.what || '').trim();
          const what = requested;
          try {
            const options = rowPageOptions(call.args);
            const pick = call.args.columns;
            if (state.byId.has(what)) {
              const a = get(what);
              const provenance = JSON.stringify({ tool: a.tool, args: a.args, inputs: a.inputs, meta: a.meta });
              let content;
              if (a.figure) content = JSON.stringify(a.figure);
              else if (a.matrix) content = JSON.stringify(a.matrix);
              else if (a.text) content = a.text;
              else {
                const view = { rows: a.rows.slice(options.offset, options.offset + options.rows), offset: options.offset, total: a.rows.length, more: options.offset + options.rows < a.rows.length };
                content = formatPage(view, shownColumns(a.columns, pick));
              }
              observe(`${a.id} (${a.size}); ${a.columns.length} total columns\nProvenance: ${provenance}\n${content}`, { source: `open ${a.id}`, refs: [a.id, ...a.inputs] });
              remember(`opened ${a.id}`);
            } else {
              const entry = await geneData.entry(what);
              if (!entry || entry.key === 'unreadable') throw new Error(`No readable dataset ${JSON.stringify(what)}; use datasets to discover files`);
              const columns = shownColumns(entry.columns, pick);
              const view = await readPage(localData.rows(entry.file), options);
              const terms = new Map();
              for (const row of view.rows) for (const column of columns) for (const term of String(row[column] ?? '').split(/\s*[;,]\s*/)) {
                const definition = term && geneData.definition(term);
                if (definition) terms.set(term, definition);
              }
              const content = `${entry.file} — ${entry.title}. ${entry.description || ''}\nShowing ${columns.length}/${entry.columns.length} columns: ${columns.join(', ')}; describe for profiles of other columns\n${formatPage(view, columns)}${terms.size ? `\nTerms: ${JSON.stringify(Object.fromEntries(terms))}` : ''}`;
              observe(content, { source: `open ${entry.file}`, refs: [entry.file] });
              remember(`opened ${entry.file}`);
            }
          } catch (err) { state.recent.push(`open failed: ${err.message}`); remember(`open ${what || '(no name)'} failed`); }
          sync++; return;
        }
        state.recent.push(`unknown tool ${call.name}`);
      }
      const completedCalls = [];
      const executeObservedCall = async call => {
        const scope = { ids: [], open: true };
        let data;
        const planBefore = planText(state.plan);
        try { data = await observationScope.run(scope, () => executeCall(call)); }
        catch (error) {
          state.failed++;
          await log('call.failed', { tool: call.name, error: error.message, turn });
          data = { status: 'error', error: error.message }; sync++;
        }
        finally { scope.open = false; }
        const planAfter = planText(state.plan);
        const previousLines = planBefore.split('\n');
        const changedPlan = call.name === 'set_plan' ? planAfter : planAfter.split('\n').filter((line, i) => line !== previousLines[i]).join('\n');
        return { call, ids: scope.ids, data: { ...(data || { status: 'ok' }), ...(planAfter !== planBefore ? { plan: changedPlan } : {}), ...(call.name === 'note' ? { notes: [...state.notes] } : {}) } };
      };
      // Independent native calls share the existing concurrency limit. Plan mutations and
      // finish are ordered barriers so they cannot race work submitted in the same turn.
      let parallelCalls = [];
      const drain = async () => {
        if (parallelCalls.length) completedCalls.push(...await Promise.all(parallelCalls.map(executeObservedCall)));
        parallelCalls = [];
      };
      for (const call of calls) {
        if (['set_plan', 'update_plan', 'note', 'skip', 'finish'].includes(call.name)) {
          await drain();
          completedCalls.push(await executeObservedCall(call));
        } else {
          parallelCalls.push(call);
          if (parallelCalls.length >= config.asoParallelLimit) await drain();
        }
      }
      await drain();
      const results = completedCalls.map(c => {
        const view = conversation.result(c.ids);
        return { message: { role: 'tool', tool_call_id: c.call.id, content: JSON.stringify({ ...c.data, ...(view.text ? { observations: view.text } : {}) }) }, deliveries: view.deliveries };
      });
      conversation.append(message, results);
      if (finishSummary !== null) break;
      if (!calls.length) {
        stalls++;
        state.recent.push('You called no tool. Call tools, skip while waiting, or finish.');
        if (stalls > MAX_STALLS) break;
        continue;
      }
      if (waiting && state.running.size) {
        stalls = 0;
        await waitForCompletion();
        continue;
      }
      if (sync > 0) { stalls = 0; continue; }
      if (state.running.size === 0) {
        state.recent.push(waiting
          ? 'Nothing is running, so there is nothing to wait for. Act or finish.'
          : `That turn did no work${state.artifacts.length ? '' : ' and there are no artifacts yet'}: the plan exists, nothing is running. Summon agents or call tools for the open items now, or finish.`);
        stalls++;
        if (stalls > MAX_STALLS) break;
        continue;
      }
      stalls = 0;
      await waitForCompletion();
    }
    // Finish recording jobs already started before closing the workspace. Their inference
    // calls have provider timeouts; no background callback may mutate a finalized report.
    if (state.running.size) await Promise.allSettled([...state.running.values()].map(job => job.promise));
    // A study that runs out of turns writes no summary: nothing is estimated into the gap.
    const budgetExhausted = finishSummary === null && turn >= maxTurns;
    const incompleteReason = budgetExhausted ? 'turn_budget_exhausted' : finishSummary === null ? 'stalled' : state.running.size ? 'agents_pending' : unverified.length ? 'unverified_numbers' : state.plan.some(p => p.status !== 'done') ? 'unfinished_or_dropped_steps' : null;
    const outcome = incompleteReason ? 'incomplete' : 'completed';
    if (finishSummary === null) finishSummary = budgetExhausted
      ? `The study stopped at its budget of ${maxTurns} turns before it finished. No summary was written, so nothing here is estimated: the plan shows what was done and what was not, and the artifacts hold everything it made.`
      : 'The study stopped with nothing left to do.';
    // Numbers still unverified when the study ends are marked where the reader sees them.
    for (const raw of unverified) finishSummary = finishSummary.replace(new RegExp(`(?<![\\w.,])${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.,]*\\d)(?! \\[unverified\\])`, 'g'), `${raw} [unverified]`);

    const seconds = (Date.now() - startedAt) / 1000;
    const summaryMd = [`# Study`, '', `**Goal:** ${goal}`, '', finishSummary, '', '## Artifacts', '', ...state.artifacts.map(a => `- ${a.id} ${a.kind} "${a.label}" (${a.size}) from ${a.tool}${a.inputs.length ? ` of ${a.inputs.join(', ')}` : ''}`), '', '## Plan', '', ...state.plan.map((p, i) => `${i + 1}. [${p.status}] ${p.text}`)].join('\n');
    const reportPath = path.join(workspace.workspaceDir, 'report.md');
    await fs.writeFile(reportPath, summaryMd, { mode: 0o600 });
    await register({ workspaceId: workspace.id, artifactsDir: workspace.artifactsDir, kind: 'summary', format: 'md', schemaJson: { type: 'report' }, provenance: { tool: 'report', sources: state.artifacts.map(a => a.uuid), purpose: 'Study summary' }, payload: null, storageUriOverride: reportPath, skipWrite: true });
    await log('finish', { summary: finishSummary, outcome, incomplete_reason: incompleteReason, turns: turn, tool_calls: state.toolCalls, failed: state.failed, artifacts: state.artifacts.length, seconds, tokens, unverified_numbers: unverified, budget_exhausted: budgetExhausted });
    await updateWorkspace(db, workspace.id, { status: 'completed', message: outcome === 'completed' ? 'Study completed' : `Study incomplete: ${incompleteReason}`, finishedUnixMs: Date.now(), planJson: { goal, mode, hpa_version: agentMode.hpaVersion, version: 'native-study', compactions: 0, outcome, incomplete_reason: incompleteReason, plan: state.plan, turns: turn } });
    await contextMemory.flush(path.join(workspace.workspaceDir, 'observations'));
    await logger.close();
    return { status: 'ok', outcome, incomplete_reason: incompleteReason, workspace_uuid: workspace.uuid, summary: finishSummary, summary_md: summaryMd, artifacts: artifactsSummary(), plan: state.plan, turns: turn, tool_calls: state.toolCalls, failed: state.failed, unverified_numbers: unverified, budget_exhausted: budgetExhausted, compactions: 0, tokens, seconds, mode, hpa_version: agentMode.hpaVersion };
  } catch (err) {
    if (state.running.size) await Promise.allSettled([...state.running.values()].map(job => job.promise));
    await log('error', { message: err.message });
    await updateWorkspace(db, workspace.id, { status: 'failed', finishedUnixMs: Date.now(), errorCode: 'study_failed', errorMessage: err.message });
    await contextMemory.flush(path.join(workspace.workspaceDir, 'observations'));
    await logger.close();
    return { status: 'error', error: err.message, workspace_uuid: workspace.uuid, artifacts: artifactsSummary(), tokens };
  }
}

module.exports = asoStudy;
