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

const MAX_TURNS_DEFAULT = 40;     // platform_config.aso_max_steps overrides
const MAX_STALLS = 2;             // turns in a row with nothing to do before the loop ends
const WAKE_DEBOUNCE_MS = 300;     // completions this close together wake the loop once
const JOB_WAIT_MS = 15 * 60_000;  // longest the loop waits for a running agent
const SAMPLE_ROWS = 2;            // rows of each artifact shown in the context
const INSPECT_MAX = 200;          // rows open may show at once
const FINISH_ROWS = 40;           // rows of each cited artifact shown when a finish is refused
const MAX_FINISH_REFUSALS = 2;    // a summary with numbers from nowhere is sent back this many times
const CELL = 60;                  // characters per shown cell

// ---- tools of the study itself ---------------------------------------------------------------------

const A = { type: 'string', description: 'artifact id, or a dataset name' };
const S = { type: 'string' };
const N = { type: 'integer' };
const tool = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'object', properties, required } });
// One line each: the rules in the prompt do the teaching.
const STUDY_TOOLS = [
  tool('set_plan', 'Write or rewrite the plan: the next few steps, each with what it finds out (step), the tool or agent it uses (op), on what (inputs) and what it produces.', { items: { type: 'array', items: { type: 'object', properties: { step: S, op: S, inputs: S, produces: S }, required: ['step'] } } }, ['items']),
  tool('update_plan', 'Change a plan item (1-based): its status (todo, doing, done, dropped) and note, or its step, op, inputs, produces; an item number past the end appends a step.', { item: N, status: { type: 'string', enum: ['todo', 'doing', 'done', 'dropped'] }, note: S, step: S, op: S, inputs: S, produces: S }, ['item']),
  tool('note', 'Write a note to yourself. NOTES stays on the desk every turn, what you open does not: mappings, names, values, which columns hold what. replace overwrites note N; empty text with replace removes it.', { text: S, replace: N }, ['text']),
  tool('datasets', 'With about, show the files whose name or columns contain that word, with their columns (this turn). The names of all datasets are on the desk already.', { about: S }),
  tool('describe', 'The first look at a dataset (by name) or an artifact (by id): per column its kind, blank share, distinct count, example values, range and the grammar of list cells; columns narrows it. A dataset card stays on the desk.', { what: S, columns: { type: 'array', items: S } }, ['what']),
  tool('open', 'Show rows of a dataset (by name) or an artifact (by id) this turn: rows and columns choose how much. Write what you will need again in a note.', { what: S, rows: N, columns: { type: 'array', items: S } }, ['what']),
  tool('explode', 'One row per item of a list cell: "key: number" items give <as>_key and <as>_value columns, "label (number)" gives <as>_label and <as>_value, plain items <as>_item.', { artifact: A, column: S, as: S }, ['artifact', 'column']),
  tool('measure', 'Add a dataset value to every row of an artifact (the rows keep their columns; the new column comes first); with entity one row per gene, without one row per gene and entity, the entity column keeping its dataset name; "as" names the new column.', { artifact: A, table: { type: 'string', description: 'dataset name' }, value_column: S, entity_column: S, entity: S, as: S }, ['artifact', 'table', 'value_column']),
  tool('union', 'Genes in either artifact.', { a: A, b: A }, ['a', 'b']),
  tool('intersect', 'Rows of a whose gene is in b.', { a: A, b: A }, ['a', 'b']),
  tool('difference', 'Rows of a whose gene is not in b.', { a: A, b: A }, ['a', 'b']),
  tool('concat', 'All rows of a then all rows of b.', { a: A, b: A }, ['a', 'b']),
  tool('join', 'Rows of a combined with matching rows of b by gene (or "on"); clashing names of b get _2.', { a: A, b: A, how: { type: 'string', enum: ['inner', 'left'] }, on: S }, ['a', 'b']),
  tool('filter', 'Keep rows satisfying every clause; op in takes a list of values; column_b compares with another column of the same row instead of value. Streams a whole dataset.', { artifact: A, where: { type: 'array', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: ['>', '>=', '<', '<=', '=', '!=', 'contains', 'in'] }, value: { description: 'a value, or a list of values for in' }, column_b: { type: 'string', description: 'compare with this column of the same row instead of value' } }, required: ['column', 'op'] } } }, ['artifact', 'where']),
  tool('select', 'Keep columns, rename them, add constant columns.', { artifact: A, columns: { type: 'array', items: S }, rename: { type: 'object', additionalProperties: S }, add: { type: 'object', additionalProperties: {} } }, ['artifact']),
  tool('rank', 'Sort by a numeric column (adds rank); top keeps the first N.', { artifact: A, by: S, order: { type: 'string', enum: ['desc', 'asc'] }, top: N }, ['artifact', 'by']),
  tool('top_per_group', 'Keep the n highest rows per group (default group gene). Streams a whole dataset.', { artifact: A, group_by: S, by: S, n: N, order: { type: 'string', enum: ['desc', 'asc'] } }, ['artifact', 'by']),
  tool('aggregate', 'count, sum, mean, median, sd, q1, q3, min, max, missing, distinct of a column, optionally per group. Streams a whole dataset.', { artifact: A, group_by: S, column: S, metrics: { type: 'array', items: { type: 'string', enum: ['count', 'sum', 'mean', 'median', 'sd', 'q1', 'q3', 'min', 'max', 'missing', 'distinct'] } } }, ['artifact', 'metrics']),
  tool('compute', 'Add a column from an expression over columns and numbers: + - * / ( ) log2 log10 ln abs sqrt exp min max; + also joins text, as in a + " / " + b.', { artifact: A, name: S, expr: S }, ['artifact', 'name', 'expr']),
  tool('pivot', 'Long rows to a matrix: row (default gene), column and value name the columns; top and top_columns cap it.', { artifact: A, row: S, column: S, value: S, top: N, top_columns: N }, ['artifact', 'column', 'value']),
  tool('chart', 'Draw an artifact: x the label column and y the value column (bar family), both numeric for scatter; heatmap takes a pivot.', { artifact: A, type: { type: 'string', enum: ['bar', 'lollipop', 'dot_plot', 'diverging_bar', 'grouped_bar', 'scatter', 'bubble', 'heatmap', 'radar', 'line', 'volcano'] }, x: S, y: S, group: S, size: S, title: S, x_label: S, y_label: S }, ['artifact', 'type']),
  tool('correlate', 'Pearson or Spearman correlation of two numeric columns: r, p and n; group_by gives one per group.', { artifact: A, x: S, y: S, method: { type: 'string', enum: ['pearson', 'spearman'] }, group_by: S }, ['artifact', 'x', 'y']),
  tool('overlap', 'Rows two tables share by gene (or "on"), against a universe (an artifact or a dataset such as proteinatlas.tsv): shared, expected, fold and a hypergeometric p; group_by tests every group of a in one call.', { a: A, b: A, universe: A, on: S, group_by: S }, ['a', 'b', 'universe']),
  tool('standardize', 'Add a column with a numeric column rescaled: zscore, minmax or percentile.', { artifact: A, column: S, method: { type: 'string', enum: ['zscore', 'minmax', 'percentile'] }, as: S }, ['artifact', 'column', 'method']),
  tool('skip', 'Nothing to do until something running returns.', { reason: S }, ['reason']),
  tool('finish', 'The goal is met or cannot be met further; summary cites artifact ids.', { summary: S }, ['summary'])
];
const STUDY_TOOL_NAMES = new Set(STUDY_TOOLS.map(t => t.name));
const TABLE_TOOLS = new Set(['measure', 'union', 'intersect', 'difference', 'concat', 'join', 'filter', 'select', 'rank', 'top_per_group', 'aggregate', 'compute', 'pivot', 'chart', 'correlate', 'overlap', 'standardize', 'explode']);
const FOR_EACH = { type: 'object', description: 'once per value; $item stands for it', properties: { values: { type: 'array', items: S }, column: S, of: S, as: S } };
const NODE = { type: 'integer', description: 'plan item carried out' };
const MAX_FOR_EACH = 1000;
const LOOK_TOOLS = new Set(['open', 'describe', 'datasets']);
const REPLAN_AFTER = 3;           // look-only turns in a row before a turn must run a step or change the plan
const PROFILE_MAX_ROWS = 200000;  // rows a describe scans in one file
const profileCache = new Map();   // file|columns → card, for this process

function systemPrompt() {
  return `You run a study over a database for a researcher, the way a careful person would at a desk. You work in turns. Each turn you see the goal, your plan, the artifacts on your desk and where each came from, what is still running, and what came back since your last turn. You act by calling tools; you never state a value, gene or count yourself: a tool produces it and it becomes an artifact.

How the turns work:
- Your first turn does one thing: call set_plan, alone. A plan is the next few steps, each saying what it finds out, the tool or agent it uses, on what, and what it produces; not the whole study, and not fifty steps. Add, rewrite or drop steps as you learn; set_plan rewrites it whole. Nothing else runs in that turn. From the second turn on, work: the NEXT STEP at the bottom of the desk is the first step not done; run it, tagging the call with node=its number so it is ticked off by itself when its artifact lands (no update_plan needed for it), or change the plan. Use update_plan only to drop a step, to mark a step done that no artifact shows, or to add or rewrite a step. A step that is the finish itself needs no ticking: finish does it.
- Call as many tools in one turn as can run independently; they run in parallel. Agents (deep_research_hpa, investigator_hpa, check_inclusion_hpa, dictionary_expert_hpa) run in the background and you are woken when each returns. Everything else returns at once.
- When nothing useful can be done until something running returns, call skip with the reason. Do not repeat a tool that is still running.
- You know nothing about the data until you look. The names of every dataset on disk are on the desk; datasets about=word shows the columns of the files matching a word. describe is the first look at a table: per column its kind, blank share, distinct count, example values, range and the grammar of list cells; a dataset's card stays on the desk. open shows rows when you need to see them, in that turn only. NOTES is what stays otherwise: write down what you will need again. A result you make shows its new columns first, with two rows, as it lands; a small result stays on the desk whole. Name only columns you have seen.
- When the same step repeats over many groups (every cancer, every tissue): aggregate, correlate, overlap and top_per_group take group_by and do every group in one call; for_each runs any table operation once per value (values, or the distinct values of column in the artifact or dataset of), "$item" in any argument standing for the value, and gives one table with an item column (as names it); explode turns list cells ("liver: 12.0; kidney: 3.1") into rows. One call, not one call per group per turn.
- A dataset name works wherever a tool takes an artifact id: filter proteinatlas.tsv directly; join, intersect or difference an artifact with a per-gene dataset to get that dataset's rows for those genes; filter, aggregate and top_per_group stream a whole dataset however large, so a study can start from every gene; the largest files (marked large) have no per-gene reads and only those three tools take them.
- deep_research_hpa finds gene sets from a description and builds the database query itself; it knows the search fields and tells you when something cannot be expressed. investigator_hpa answers one question about one gene and cites the row it rests on; when the value sits in a table column you can name, measure is exact and free, so prefer it.
- Refer to artifacts by their id. measure adds a column to the rows it is given, so measuring pancreas then liver on the same artifact leaves both columns in the result; name each with "as".
- Do the bookkeeping in the same turn as the work: update_plan alongside the tools that complete the item, and finish in the same turn as the last piece of work. A turn spent only on update_plan is a turn wasted.
- A tool that fails tells you why under SINCE YOUR LAST TURN; fix the call rather than repeating it. Table tools are exact: if a value looks wrong, the arguments were wrong (the entity, the column, the table), not the data.
- Call finish when the plan is done, with a summary that states every number in the same sentence as the id of the artifact it comes from; each number is checked against that artifact, and a report may only state what the plan shows was done. When something cannot be done, mark the item dropped with the reason, then finish saying what is missing.`;
}

// ---- context rendering -----------------------------------------------------------------------------

function columnList(columns) {
  return `${columns.slice(0, 12).join(', ')}${columns.length > 12 ? ` … ${columns.length} in all` : ''}`;
}

function cell(v) {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > CELL ? `${s.slice(0, CELL - 1)}…` : s;
}

function shownColumns(columns, pick = null) {
  if (Array.isArray(pick) && pick.length) return pick.map(p => columns.find(c => c === p) || columns.find(c => c.toLowerCase() === String(p).toLowerCase())).filter(Boolean);
  return columns.slice(0, 7);
}

function sampleLines(rows, columns, n, pick = null) {
  const cols = shownColumns(columns, pick);
  return rows.slice(0, n).map(r => cols.map(c => cell(r[c])).join(' | '));
}

// A sample with its header line: the names of the columns the rows show.
function sampleBlock(rows, columns, n, pick = null) {
  const cols = shownColumns(columns, pick);
  return [cols.join(' | '), ...sampleLines(rows, columns, n, pick)].join('\n  ');
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
    return master.rows.map(r => { const { Gene, Ensembl, ...rest } = r; return { gene: Gene, ensembl: Ensembl, ...rest }; });
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
    const keep = tools.wherePredicate(entry.columns, where);
    const out = [];
    for await (const row of localData.rows(entry.file, { where: keep })) out.push({ ...geneKeys(entry, row), ...row });
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
// once turned as=pancreas_nTPM into as=pancreas, and the study chased a column that never existed.
function describeArgs(args, max = 160) {
  const parts = Object.entries(args || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => { const text = typeof v === 'string' ? v : JSON.stringify(v); return `${k}=${text.length > 80 ? `${text.slice(0, 79)}…` : text}`; });
  let out = '';
  for (const part of parts) {
    if (out && out.length + part.length + 2 > max) { out += ', …'; break; }
    out += (out ? ', ' : '') + part;
  }
  return out;
}

// An artifact as it sits on the desk: what it is and where it came from. Its columns appear
// once the model has opened it; rows are shown only in the turn it read them.
function artifactLine(a) {
  const lines = [`${a.id}  ${a.kind.padEnd(7)} "${a.label}"  ${a.size}  from turn ${a.turn}: ${a.tool}(${describeArgs(a.args)})`];
  if (a.meta?.query) lines.push(`    ${a.meta.query}`);
  if (a.meta?.not_expressible?.length) lines.push(`    not expressible: ${a.meta.not_expressible.join('; ')}`);
  if (a.opened && a.columns?.length) lines.push(`    columns ${columnList(a.columns)}`);
  // A small result is its own card: a handful of rows and columns stay on the desk whole.
  if (a.rows && a.rows.length && a.rows.length <= 40 && a.columns.length <= 3) lines.push(`    ${a.columns.join(' | ')}`, ...a.rows.map(r => `    ${a.columns.map(c => cell(r[c])).join(' | ')}`));
  if (a.text) lines.push(`    ${cell(a.text).slice(0, 300)}`);
  return lines.join('\n');
}

function planLine(p) {
  return `${p.text}${p.op ? `  — ${p.op}${p.inputs ? `(${p.inputs})` : ''}` : ''}${p.produces ? ` → ${p.produces}` : ''}${p.note ? `  (${p.note})` : ''}`;
}

function renderContext(state, turn, startedAt) {
  const plan = state.plan.length
    ? state.plan.map((p, i) => `${i + 1}. [${p.status === 'done' ? 'done' : p.status === 'doing' ? 'doing' : p.status === 'dropped' ? 'dropped' : ' '}]  ${planLine(p)}`).join('\n')
    : 'No plan yet. The workspace is empty. Start by writing one with set_plan.';
  const artifacts = state.artifacts.length ? state.artifacts.map(artifactLine).join('\n') : '(none)';
  const running = state.running.size
    ? [...state.running.values()].map(j => `${j.id}  ${j.tool}(${describeArgs(j.args)})  ${Math.round((Date.now() - j.startedAt) / 1000)} s`).join('\n')
    : '(nothing)';
  const recent = state.recent.length ? state.recent.map(r => `- ${r}`).join('\n') : '(nothing new)';
  const clip = (items, max) => { const text = items.map(r => `- ${r}`).join('\n'); return text.length > max ? `${text.slice(0, max)}\n  …` : text; };
  const earlier = (state.recentPast || []).map((items, i) => (items.length ? `${i === 0 ? 'TWO' : 'THREE'} TURNS AGO\n${clip(items, 2500)}` : null)).filter(Boolean).join('\n\n');
  const next = state.plan.find(p => p.status !== 'done' && p.status !== 'dropped');
  const nextStep = next ? `NEXT STEP  (the first step not done: run it, tagging the call with node=${state.plan.indexOf(next) + 1}, or change the plan)\n${state.plan.indexOf(next) + 1}. ${planLine(next)}` : (state.plan.length ? 'NEXT STEP\nEvery step is done or dropped: finish, or add steps.' : '');
  const notes = state.notes.length ? state.notes.map(n => `- ${n}`).join('\n') : '(none)';
  const seen = state.tablesSeen.size ? `\nDATASETS YOU HAVE LOOKED AT  (first columns; open one to see all of them, or rows)\n${[...state.tablesSeen.values()].join('\n')}` : '';
  const tables = state.tableNames ? `DATASETS ON DISK  (open one to see its columns and rows; datasets about=word shows columns of the files matching a word)\n${state.tableNames.join('  ')}${seen}` : (seen.trim() || null);
  const history = state.history.length ? state.history.map(h => `turn ${h.turn}: ${h.items.join('; ')}`).join('\n') : '(nothing yet)';
  return `GOAL
${state.goal}

PLAN  (yours; high level; cross items off with update_plan; rewrite with set_plan)
${plan}

ARTIFACTS  (everything in the workspace; refer to them by id)
${artifacts}

RUNNING  (started by you, not back yet; you are woken when each returns)
${running}

HISTORY  (what you did each turn and what came of it)
${history}

SINCE YOUR LAST TURN
${recent}
${earlier ? `\n${earlier}\n` : ''}${tables ? `\n${tables}\n` : ''}
NOTES
${notes}
${nextStep ? `\n${nextStep}\n` : ''}
turn ${turn} · ${Math.round((Date.now() - startedAt) / 1000)} s elapsed · ${state.toolCalls} tools called · ${state.failed} failed`;
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
    return { kind: 'answer', label: `${result.gene || args.gene}: ${String(args.question || '').slice(0, 60)}`, rows: [{ gene: result.gene || args.gene, ensembl: result.ensembl || null, question: args.question || '', found: result.found === true, answer: result.answer || '', value: result.extracted_value ?? null, entity: result.exact_label ?? null, table: result.source_section || null, cited_row: result.cited_row || null }], meta: {} };
  }
  if (tool === 'check_inclusion_hpa') {
    return { kind: 'answer', label: `${args.gene} in search result?`, rows: [scalarRow(result)], meta: {} };
  }
  const text = [result?.summary, result?.answer, result?.content, result?.text].find(v => typeof v === 'string') || JSON.stringify(scalarRow(result));
  return { kind: 'note', label: String(args.topic || args.question || tool).slice(0, 80), rows: [], text: String(text).slice(0, 4000), meta: { images: Array.isArray(result?.images) ? result.images.length : 0 } };
}

// ---- the loop --------------------------------------------------------------------------------------

async function asoStudy({ goal, mode: requestedMode, max_turns, reasoning_effort }, ctx = {}) {
  const effort = reasoning_effort || ctx.reasoning_effort || null;
  const db = ctx.db;
  if (!db) throw new Error('The study requires db in context.');
  getActiveModel();
  const orchestrator = require('../orchestrator'); // at call time: the orchestrator requires this module too
  const config = platformConfig();
  const maxTurns = Number(max_turns) > 0 ? Number(max_turns) : (config.asoMaxSteps || MAX_TURNS_DEFAULT);
  const agentMode = await resolveAgentMode(requestedMode ?? 'offline', [FILES.master]);
  const mode = agentMode.mode;
  const startedAt = Date.now();
  const tokens = { prompt: 0, completion: 0, total: 0 };
  const addUsage = usage => { tokens.prompt += usage?.prompt_tokens || 0; tokens.completion += usage?.completion_tokens || 0; tokens.total += (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0); };

  const workspace = await createWorkspace(db, { visitorId: ctx.visitorId, inferenceModelId: getActiveModel().id, requestText: goal, planJson: { goal, mode, hpa_version: agentMode.hpaVersion, version: 'loop' } });
  inference.assignContext({ workspaceId: workspace.id });
  const logger = createLogger(workspace.logPath);
  const log = async (event, data, step) => {
    if (ctx.onStep) await ctx.onStep({ stage: event, label: event, message: typeof data === 'string' ? data : JSON.stringify(data), step });
    return logger.logEvent({ event, data, step });
  };
  let registrations = Promise.resolve();
  const register = args => { const next = registrations.then(() => registerArtifact(db, args)); registrations = next.catch(() => {}); return next; };

  const state = { goal, plan: [], artifacts: [], byId: new Map(), running: new Map(), recent: [], notes: [], tablesSeen: new Map(), tableNames: null, recentPast: [], history: [], turn: 0, toolCalls: 0, failed: 0, ids: { a: 0, t: 0 } };
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
  const planItem = x => (typeof x === 'string' ? { text: x, status: 'todo', note: '' } : { text: String(x.step || x.text || ''), op: x.op ? String(x.op) : undefined, inputs: x.inputs ? String(x.inputs) : undefined, produces: x.produces ? String(x.produces) : undefined, status: 'todo', note: '' });
  // A plan item is ticked off when the call that carries it out lands its artifact.
  const markNode = async (n, artifactId) => {
    const item = state.plan[n - 1];
    if (!item || item.status === 'done') return;
    item.status = 'done';
    item.note = `→ ${artifactId}`;
    planTouched = true;
    remember(`plan item ${n} done (${artifactId})`);
    await log('plan', { items: state.plan, changed: n });
  };
  const wake = { resolve: null };
  const wakeUp = () => { if (wake.resolve) { const r = wake.resolve; wake.resolve = null; r(); } };
  const artifactsSummary = () => state.artifacts.map(a => ({ artifact_uuid: a.uuid, kind: a.kind === 'figure' ? 'figure' : a.kind === 'note' ? 'inspection' : a.kind === 'answer' ? 'measurement' : 'dataset', tool: a.tool, summary: { id: a.id, label: a.label, row_count: a.rows?.length }, storage_uri: a.storageUri }));

  const agentSpecs = orchestrator.getToolSpecs().filter(t => t.function.name !== 'aso_hpa');
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
    const a = state.byId.get(String(id || '').trim());
    if (!a) throw new Error(`no artifact "${id}" (have ${state.artifacts.map(x => x.id).join(', ') || 'none'})`);
    return a;
  };

  // Stores a tool's output as an artifact, linked to the artifacts it read.
  async function addArtifact({ kind, label, rows, matrix, text, tool, args, inputs, meta, figure, toolId }) {
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
      const columns = rows ? tools.columnsOf(rows) : [];
      const artifactKind = kind === 'answer' ? 'answer' : kind === 'note' ? 'note' : tool === 'deep_research_hpa' ? 'gene_list' : tool === 'measure' ? 'measurement' : `analysis_${tool}`;
      const payload = matrix
        ? { node_id: id, op: tool, label, args, row_count: matrix.row_labels.length, column_count: matrix.col_labels.length, ...matrix, provenance: { tool, purpose: label, sources, ...(meta || {}) } }
        : { node_id: id, op: tool, label, args, row_count: rows ? rows.length : 0, columns, rows: rows || [], text: text || undefined, provenance: { tool, purpose: label, sources, ...(meta || {}) } };
      reg = await register({ ...base, kind: artifactKind, format: 'json', schemaJson: { type: tool, columns }, provenance: { tool, sources, purpose: label }, payload });
    }
    const columns = rows ? tools.columnsOf(rows) : [];
    const size = kind === 'figure' ? 'figure' : matrix ? `${matrix.row_labels.length} × ${matrix.col_labels.length} matrix` : kind === 'note' ? 'note' : `${rows.length} rows`;
    const a = { id, uuid: reg.artifactUuid, storageUri: reg.storageUri, kind, label, size, rows: rows || null, matrix: matrix || null, text: text || null, columns, tool, args, inputs, meta: meta || {}, images, toolId, turn: state.turn };
    state.artifacts.push(a);
    state.byId.set(id, a);
    return a;
  }

  // Numbers a summary states, with the precision they were written at: a decimal, a number of a
// thousand or more, or scientific notation. Small whole numbers (counts, ranks, list markers)
// are too ambiguous to check.
const NUMBER = /(?<![\w.])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?(?![\w])/g;
function statedNumbers(text) {
  const out = [];
  for (const m of String(text || '').matchAll(NUMBER)) {
    const raw = m[0];
    const clean = raw.replace(/,/g, '');
    const value = Number(clean);
    if (!Number.isFinite(value)) continue;
    const mantissa = clean.split(/[eE]/)[0];
    const exponent = /[eE]/.test(clean) ? Number(clean.split(/[eE]/)[1]) : 0;
    const decimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
    if (!mantissa.includes('.') && !exponent && Math.abs(value) < 1000) continue;
    out.push({ raw, value, tolerance: 0.5 * 10 ** (exponent - decimals) });
  }
  return out;
}

// Every number an artifact holds, sorted, computed once: numeric cells, numbers inside text
// cells, matrix cells.
function artifactNumbers(a) {
  if (a.numbersSorted) return a.numbersSorted;
  const values = [];
  const push = v => { if (Number.isFinite(v)) values.push(v); };
  if (a.rows) for (const r of a.rows) for (const v of Object.values(r)) {
    if (typeof v === 'number') push(v);
    else if (typeof v === 'string' && v && /\d/.test(v)) { const n = Number(v.replace(/,/g, '')); if (Number.isFinite(n)) push(n); else for (const m of v.matchAll(NUMBER)) push(Number(m[0].replace(/,/g, ''))); }
  }
  if (a.matrix) for (const row of a.matrix.matrix) for (const v of row) push(Number(v));
  a.numbersSorted = Float64Array.from(values).sort();
  return a.numbersSorted;
}

const SCALES = [0, 3, -3, 6, -6, 9, -9, 12, -12].map(k => 10 ** k);  // a change of unit prefix

function nearIn(sorted, x, tol) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x - tol) lo = mid + 1; else hi = mid; }
  return lo < sorted.length && sorted[lo] <= x + tol + 1e-9 * Math.abs(x);
}
const holds = (sorted, value, tolerance) => SCALES.some(scale => nearIn(sorted, value * scale, tolerance * scale));

// A number a summary states is traced to an artifact cited in the same sentence. Artifact sizes
// and the goal's own numbers count everywhere. A sentence that cites nothing verifies nothing.
function unverifiedNumbers(summary, state) {
  const text = String(summary || '');
  const common = Float64Array.from([
    ...state.artifacts.filter(a => a.rows).map(a => a.rows.length),
    ...[...String(state.goal || '').matchAll(NUMBER)].map(m => Number(m[0].replace(/,/g, '')))
  ].filter(Number.isFinite)).sort();
  const missing = [];
  for (const segment of text.split(/\n+|(?<=[.;:])\s+(?=[A-Z(*\-–•\d])/)) {
    const here = [...new Set(segment.match(/\ba\d+\b/g) || [])].filter(id => state.byId.has(id));
    const sources = here.map(id => state.byId.get(id));
    for (const { raw, value, tolerance } of statedNumbers(segment)) {
      const ok = holds(common, value, tolerance) || sources.some(a => holds(artifactNumbers(a), value, tolerance));
      if (!ok && !missing.includes(raw)) missing.push(raw);
    }
  }
  return missing;
}

// What a person sees when a result lands: its shape and a couple of rows, once.
const receipt = a => {
  if (a.matrix) return `${a.id} (${a.size}; rows ${a.matrix.row_labels.slice(0, 8).join(', ')}${a.matrix.row_labels.length > 8 ? ', …' : ''}; columns ${a.matrix.col_labels.slice(0, 8).join(', ')}${a.matrix.col_labels.length > 8 ? ', …' : ''})`;
  if (a.text) return `${a.id}: ${a.text.slice(0, 300)}`;
  if (!a.rows || !a.rows.length) return `${a.id} (${a.size})`;
  return `${a.id} (${a.size}; columns ${columnList(a.columns)}):\n  ${sampleBlock(a.rows, a.columns, 2)}`;
};
const artifactEvent = a => ({ id: a.id, kind: a.kind, label: a.label, size: a.size, rows: a.rows ? a.rows.length : undefined, columns: a.columns.slice(0, 12), sample: a.rows ? sampleLines(a.rows, a.columns, 3).map(l => l.split(' | ')) : undefined, sample_columns: a.columns.slice(0, 7), text: a.text ? a.text.slice(0, 600) : undefined, images: a.images, artifact_uuid: a.uuid, search_url: a.meta?.search_url, query: a.meta?.query, inputs: a.inputs });

  // An agent runs in the background through the orchestrator, exactly as a chat message would.
  function startAgent(tool, args) {
    const node = Number(args?.node) || 0;
    if (node) { args = { ...args }; delete args.node; }
    const id = `t${++state.ids.t}`;
    const job = { id, tool, args, startedAt: Date.now(), kind: 'agent' };
    state.running.set(id, job);
    state.toolCalls++;
    const label = String(args.goal || args.question || args.topic || args.gene || tool).slice(0, 80);
    log('tool.start', { id, tool, kind: 'agent', label, args, inputs: [] }, id);
    const forward = async s => log(`agent.${s.stage}`, { id, label: s.label, message: s.message }, id);
    orchestrator.execute(tool, { ...args, mode: args.mode || mode }, { db, visitorId: ctx.visitorId, rawQuery: '', includeRows: true, onStep: forward })
      .then(async ({ result }) => {
        const built = agentArtifact(tool, args, result);
        const a = await addArtifact({ ...built, tool, args, inputs: [], toolId: id });
        if (node) await markNode(node, a.id);
        state.recent.push(`${id} ${tool} returned ${receipt(a)}${a.meta?.search_url ? `\n  ${a.meta.search_url}` : ''}${a.meta?.not_expressible?.length ? `\n  not expressible: ${a.meta.not_expressible.join('; ')}` : ''}`);
        remember(`${tool} → ${a.id} (${a.size})`);
        await log('tool.done', { id, tool, kind: 'agent', artifact: artifactEvent(a), ms: Date.now() - job.startedAt }, id);
      })
      .catch(async err => {
        state.failed++;
        state.recent.push(`${id} ${tool} failed: ${err.message}`);
        remember(`${tool} failed: ${err.message.slice(0, 90)}`);
        await log('tool.failed', { id, tool, kind: 'agent', error: err.message, ms: Date.now() - job.startedAt }, id);
      })
      .finally(() => { state.running.delete(id); wakeUp(); });
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
        case 'chart': { const a = state.byId.get(String(args.artifact ?? '').trim()); out = { figure: tools.chartSpec(args, a?.matrix ? a.matrix : await rowsOf('artifact')) }; break; }
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

  async function runTableTool(tool, args) {
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
      const a = await addArtifact({ kind: out.figure ? 'figure' : 'data', label: tool === 'chart' ? label : `${tool} of ${inputs.join(', ')}`, rows: out.rows, matrix: out.matrix, figure: out.figure, tool, args, inputs, toolId: id });
      state.recent.push(`${id} ${tool} -> ${receipt(a)}`);
      remember(`${tool}(${inputs.join(', ')}) → ${a.id} (${a.size})`);
      if (node) await markNode(node, a.id);
      await log('tool.done', { id, tool, kind: out.figure ? 'chart' : 'tool', artifact: artifactEvent(a), ms: Date.now() - t0 }, id);
    } catch (err) {
      state.failed++;
      state.recent.push(`${id} ${tool}(${describeArgs(args).slice(0, 120)}) failed: ${err.message}`);
      remember(`${tool}(${inputs.join(', ')}) failed: ${err.message.slice(0, 90)}`);
      await log('tool.failed', { id, tool, kind: tool === 'chart' ? 'chart' : 'tool', error: err.message, ms: Date.now() - t0 }, id);
    }
  }

  const waitForCompletion = () => new Promise(resolve => {
    const timer = setTimeout(resolve, JOB_WAIT_MS);
    wake.resolve = () => { clearTimeout(timer); setTimeout(resolve, WAKE_DEBOUNCE_MS); };
  });

  let finishSummary = null;
  state.tableNames = (await geneData.catalog()).filter(e => e.key !== 'unreadable').map(e => e.file);
  let finishRefusals = 0;
  let unverified = [];
  let lookOnly = 0;
  let planTouched = false;
  let turn = 0;
  let stalls = 0;
  try {
    await log('start', { workspace_uuid: workspace.uuid, mode, hpa_version: agentMode.hpaVersion, model: getActiveModel().configKey, goal });
    await updateWorkspace(db, workspace.id, { status: 'running' });
    while (turn < maxTurns) {
      turn++;
      state.turn = turn;
      const context = renderContext(state, turn, startedAt);
      // The exact text the model saw this turn, kept as a file in the workspace (the event log
      // truncates long strings); the log keeps only its size.
      await fs.mkdir(path.join(workspace.workspaceDir, 'context'), { recursive: true });
      await fs.writeFile(path.join(workspace.workspaceDir, 'context', `turn-${String(turn).padStart(2, '0')}.txt`), context, { mode: 0o600 });
      await logger.logEvent({ event: 'context', data: { turn, chars: context.length } });
      // Until a plan exists the only tool on offer is set_plan: the first turn plans, alone. After
      // several turns that only looked, a turn must run a step or change the plan: looking is off.
      const replan = state.plan.length > 0 && lookOnly >= REPLAN_AFTER;
      if (replan) state.recent.push(`${lookOnly} turns in a row looked without making anything or changing the plan. This turn looking is off: run the NEXT STEP (tag it node=N), run another step, or change the plan.`);
      const offered = state.plan.length ? (replan ? toolSpecs.filter(t => !LOOK_TOOLS.has(t.function.name)) : toolSpecs) : toolSpecs.filter(t => t.function.name === 'set_plan');
      const artifactsBefore = state.artifacts.length;
      planTouched = false;
      const res = await inference.chat.completions.create({ messages: [{ role: 'system', content: system }, { role: 'user', content: context }], tools: offered, temperature: 0, prompt_cache: { key: `study ${workspace.uuid}` }, ...(effort ? { reasoning_effort: effort } : {}) });
      addUsage(res.usage);
      const message = res.choices?.[0]?.message || {};
      const calls = (message.tool_calls || []).map(c => { let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = {}; } return { name: c.function?.name, args }; });
      await log('turn', { turn, text: message.content ? String(message.content).slice(0, 600) : null, calls: calls.map(c => ({ tool: c.name, args: c.args })), offered: offered.length });
      state.recentPast = [state.recent, ...(state.recentPast || [])].slice(0, 2);
      state.recent = [];
      let sync = 0;
      let waiting = false;
      if (!state.plan.length) {
        // The planning turn: set_plan and nothing else; anything else waits for the next turn.
        const plan = calls.find(c => c.name === 'set_plan');
        const others = calls.filter(c => c.name !== 'set_plan').map(c => c.name);
        if (plan) { state.plan = (plan.args.items || []).map(planItem); remember('wrote the plan'); await log('plan', { items: state.plan }); }
        if (others.length) state.recent.push(`Not run: ${others.join(', ')}. The first turn writes the plan alone; call tools from the next turn on.`);
        if (!plan) { stalls++; state.recent.push('Write the plan first with set_plan, alone.'); if (stalls > MAX_STALLS) break; }
        else stalls = 0;
        continue;
      }
      for (const call of calls) {
        if (call.name === 'finish') {
          const summary = String(call.args.summary || '');
          const missing = unverifiedNumbers(summary, state);
          const isFinishStep = p => /^(finish|summari[sz]e|report|write[- ]?up)/i.test(String(p.op || '')) || /^(finish|summari[sz]e|report|write[- ]?up)\b/i.test(String(p.text || ''));
          const undone = state.plan.map((p, i) => ({ ...p, n: i + 1 })).filter(p => p.status !== 'done' && p.status !== 'dropped' && !isFinishStep(p));
          if (undone.length && finishRefusals < MAX_FINISH_REFUSALS) {
            finishRefusals++;
            state.recent.push(`finish refused: the plan says ${undone.map(p => `item ${p.n}`).join(', ')} ${undone.length === 1 ? 'is' : 'are'} not done. A report can only state what was done. Do the work, mark an item dropped with a note saying why, or mark it done only if an artifact shows it is; then finish again.`);
            remember('finish refused: plan items not done');
            await log('finish.refused', { plan_items: undone.map(p => p.n), attempt: finishRefusals });
            sync++;
            continue;
          }
          if (missing.length && finishRefusals < MAX_FINISH_REFUSALS) {
            finishRefusals++;
            const cited = [...new Set(summary.match(/\ba\d+\b/g) || [])].filter(id => state.byId.has(id));
            state.recent.push(`finish refused: these numbers are not in the artifact cited beside them${cited.length ? '' : ' (the summary cites no artifact at all)'}: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}. State each number beside the id of the artifact it comes from; it is checked against that artifact. The artifacts you cite are shown below; take the numbers from them (aggregate or compute for derived numbers), or leave them out, then finish again.`);
            for (const id of cited) {
              const a = get(id);
              if (a.rows) state.recent.push(`${a.id} (${a.size}) columns: ${a.columns.join(' | ')}\n  ${sampleBlock(a.rows, a.columns, FINISH_ROWS)}${a.rows.length > FINISH_ROWS ? `\n  … ${a.rows.length - FINISH_ROWS} more rows` : ''}`);
              else if (a.matrix) state.recent.push(`${a.id} is a ${a.size}; rows ${a.matrix.row_labels.slice(0, 12).join(', ')}${a.matrix.row_labels.length > 12 ? ', …' : ''}; columns ${a.matrix.col_labels.slice(0, 12).join(', ')}${a.matrix.col_labels.length > 12 ? ', …' : ''}`);
              else if (a.text) state.recent.push(`${a.id}: ${a.text.slice(0, 1500)}`);
            }
            remember('finish refused: numbers not in any artifact');
            await log('finish.refused', { numbers: missing, attempt: finishRefusals });
            sync++;
            continue;
          }
          for (const p of state.plan) if (isFinishStep(p) && p.status !== 'done' && p.status !== 'dropped') { p.status = 'done'; p.note = 'finished'; }
          finishSummary = undone.length ? `Not done according to the plan: ${undone.map(p => `${p.n}. ${p.text}`).join('; ')}.\n\n${summary}` : summary;
          unverified = missing;
          break;
        }
        if (call.name === 'skip') { waiting = true; remember(`waited: ${String(call.args.reason || '').slice(0, 80)}`); await log('skip', { reason: call.args.reason || '' }); continue; }
        if (call.name === 'set_plan') { state.plan = (call.args.items || []).map(planItem); planTouched = true; remember('rewrote the plan'); await log('plan', { items: state.plan }); continue; }
        if (call.name === 'update_plan') {
          const n = Number(call.args.item);
          let item = state.plan[n - 1];
          if (!item && n === state.plan.length + 1 && call.args.step) { item = planItem(call.args); state.plan.push(item); remember(`added plan item ${n}`); }
          if (item) {
            if (call.args.status) item.status = call.args.status;
            if (call.args.note) item.note = String(call.args.note);
            for (const k of ['step', 'op', 'inputs', 'produces']) if (call.args[k]) item[k === 'step' ? 'text' : k] = String(call.args[k]);
            planTouched = true;
            remember(`plan item ${n} ${call.args.status || 'edited'}`);
          } else state.recent.push(`update_plan failed: there is no item ${call.args.item} (add the next one with item=${state.plan.length + 1} and a step)`);
          await log('plan', { items: state.plan, changed: n }); continue;
        }
        if (call.name === 'note') {
          const text = String(call.args.text || '').trim();
          const at = Number(call.args.replace) || 0;
          if (at >= 1 && at <= state.notes.length) { if (text) state.notes[at - 1] = text; else state.notes.splice(at - 1, 1); remember(text ? `rewrote note ${at}` : `removed note ${at}`); }
          else if (text) { state.notes.push(text); remember('wrote a note'); }
          await log('note', { text, replace: at || undefined });
          continue;
        }
        if (call.name === 'datasets') {
          const about = String(call.args.about || '').trim().toLowerCase();
          const all = (await geneData.catalog()).filter(e => e.key !== 'unreadable');
          const entries = about ? all.filter(e => e.file.toLowerCase().includes(about) || String(e.title || '').toLowerCase().includes(about) || e.columns.some(c => c.toLowerCase().includes(about))) : all;
          const large = e => (e.key === 'stream' ? '  (large: filter, aggregate or top_per_group stream it; no per-gene reads)' : '');
          if (!entries.length) state.recent.push(`no dataset has "${about}" in its name, title or columns; datasets with no word lists them all`);
          else if (!about) state.recent.push(`the ${entries.length} datasets on disk are listed under DATASETS ON DISK every turn; datasets with about=word shows the matching files with their columns`);
          else state.recent.push(`datasets matching "${about}" (${entries.length}):\n${entries.slice(0, 40).map(e => `  ${e.file} — ${e.title}${large(e)}: ${columnList(e.columns)}`).join('\n')}${entries.length > 40 ? `\n  … ${entries.length - 40} more; narrow the word` : ''}`);
          remember(about ? `browsed the datasets about ${about}` : 'listed the datasets'); sync++; continue;
        }
        if (call.name === 'describe') {
          const what = String(call.args.what ?? call.args.artifact ?? call.args.dataset ?? call.args.name ?? '').trim();
          const pick = Array.isArray(call.args.columns) ? call.args.columns.map(String) : (typeof call.args.columns === 'string' && call.args.columns.trim() ? call.args.columns.split(/\s*[|,]\s*/) : null);
          const cardLine = c => `${c.column} — ${c.kind}; ${c.blank_pct}% blank; distinct ${c.distinct}${c.examples.length ? `; e.g. ${c.examples.join(' | ')}` : ''}${c.min !== undefined ? `; ${c.min} to ${c.max}` : ''}${c.list ? `; ${c.list}` : ''}`;
          try {
            if (state.byId.has(what)) {
              const a = get(what);
              if (!a.rows) throw new Error(`${a.id} has no rows to describe`);
              const cols = pick ? shownColumns(a.columns, pick) : a.columns.slice(0, 40);
              state.recent.push(`${a.id} (${a.size}) described:\n  ${tools.profile(a.rows, cols).map(cardLine).join('\n  ')}${a.columns.length > cols.length ? `\n  … ${a.columns.length - cols.length} more columns (describe with columns)` : ''}`);
              remember(`described ${a.id}`);
            } else {
              const entry = await geneData.entry(what);
              if (!entry || entry.key === 'unreadable') throw new Error(`nothing called "${what}" on the desk or on disk; datasets lists what is on disk`);
              const cols = pick ? shownColumns(entry.columns, pick) : entry.columns.slice(0, 40);
              const key = `${entry.file}|${cols.join('|')}`;
              let card = profileCache.get(key);
              if (!card) { card = await tools.profileStream(datasetStream(entry), cols, PROFILE_MAX_ROWS); profileCache.set(key, card); }
              const scanned = card.rows >= PROFILE_MAX_ROWS ? ` (first ${PROFILE_MAX_ROWS.toLocaleString('en-US')} rows)` : ` (${card.rows.toLocaleString('en-US')} rows)`;
              const lines = card.profile.map(cardLine);
              const text = `${entry.file} — ${entry.title}. ${entry.description || ''}${scanned}\n  ${lines.join('\n  ')}${entry.columns.length > cols.length ? `\n  … ${entry.columns.length - cols.length} more columns (describe with columns)` : ''}`;
              state.tablesSeen.set(entry.file, `${entry.file}${scanned}:\n  ${lines.slice(0, 12).join('\n  ')}${lines.length > 12 ? `\n  … ${lines.length - 12} more described` : ''}`);
              state.recent.push(text);
              remember(`described ${entry.file}`);
            }
          } catch (err) { state.recent.push(`describe failed: ${err.message}`); remember(`describe ${what || '(no name)'} failed`); }
          sync++; continue;
        }
        if (call.name === 'open') {
          const n = Math.min(INSPECT_MAX, Number(call.args.rows) || 10);
          const what = String(call.args.what ?? call.args.artifact ?? call.args.dataset ?? call.args.name ?? call.args.id ?? call.args.file ?? '').trim();
          const pick = Array.isArray(call.args.columns) ? call.args.columns.map(String) : (typeof call.args.columns === 'string' && call.args.columns.trim() ? call.args.columns.split(/\s*[|,]\s*/) : null);
          try {
            if (state.byId.has(what)) {
              const a = get(what);
              a.opened = true;
              remember(`opened ${a.id}`);
              if (a.matrix) state.recent.push(`${a.id} is a ${a.size}; rows ${a.matrix.row_labels.slice(0, 12).join(', ')}${a.matrix.row_labels.length > 12 ? ', …' : ''}; columns ${a.matrix.col_labels.slice(0, 12).join(', ')}${a.matrix.col_labels.length > 12 ? ', …' : ''}`);
              else if (a.text) state.recent.push(`${a.id}: ${a.text.slice(0, 1500)}`);
              else state.recent.push(`${a.id} (${a.size}) columns: ${a.columns.join(' | ')}\n  ${sampleBlock(a.rows || [], a.columns, n, pick)}${(a.rows || []).length > n ? `\n  … ${a.rows.length - n} more rows` : ''}`);
            } else {
              const entry = await geneData.entry(what);
              if (!entry || entry.key === 'unreadable') throw new Error(`nothing called "${what}" on the desk or on disk; datasets lists what is on disk`);
              // The head of the file, as a person sees it, plus the rows of a gene already on the
              // desk when the file has one row per gene and entity.
              const head = [];
              for await (const row of localData.rows(entry.file)) { head.push(row); if (head.length >= n) break; }
              const sampleGene = state.artifacts.flatMap(a => a.rows || []).map(r => r.ensembl || r.gene).find(Boolean);
              let geneRows = [];
              if (['ensembl', 'name', 'scan'].includes(entry.key) && sampleGene) { const gene = await geneData.resolveGene(sampleGene); if (gene) geneRows = (await geneData.read(gene, entry.file)).rows; }
              // The atlas defines its category terms; the ones that appear in the rows shown are explained.
              const shown = shownColumns(entry.columns, pick);
              const seenTerms = new Map();
              for (const row of [...head, ...geneRows]) for (const c of shown) for (const term of String(row[c] ?? '').split(/\s*[;,]\s*/)) { const d = term && geneData.definition(term); if (d && !seenTerms.has(term)) seenTerms.set(term, d); }
              if (entry.key === 'lookup' && head.length <= 40) state.tablesSeen.set(entry.file, `${entry.file} (${head.length} rows, whole):\n  ${sampleBlock(head, entry.columns, 40, pick)}`);
              else if (!state.tablesSeen.has(entry.file)) state.tablesSeen.set(entry.file, `${entry.file}: ${columnList(entry.columns)}`);
              remember(`opened ${entry.file}`);
              const parts = [`${entry.file} — ${entry.title}. ${entry.description || ''} columns: ${entry.columns.join(' | ')}`];
              if (seenTerms.size) parts.push(`  terms: ${[...seenTerms].slice(0, 8).map(([t, d]) => `${t}: ${d}`).join('; ')}`);
              if (entry.key === 'stream') parts.push('  (large file, no per-gene reads: filter, aggregate or top_per_group stream it whole)');
              parts.push(`  first ${head.length} rows:\n  ${sampleBlock(head, entry.columns, n, pick)}`);
              if (geneRows.length) { const g = geneRows[0]; parts.push(`  rows for ${g['Gene name'] || g.Gene || sampleGene} (${geneRows.length}):\n  ${sampleBlock(geneRows, entry.columns, n, pick)}${geneRows.length > n ? `\n  … ${geneRows.length - n} more` : ''}`); }
              state.recent.push(parts.join('\n'));
            }
          } catch (err) { state.recent.push(`open failed: ${err.message}`); remember(`open ${what || '(no name)'} failed`); }
          sync++; continue;
        }
        if (agentNames.has(call.name)) { startAgent(call.name, call.args); continue; }
        if (TABLE_TOOLS.has(call.name)) { await runTableTool(call.name, call.args); sync++; continue; }
        state.recent.push(`unknown tool ${call.name}`);
      }
      if (finishSummary !== null) break;
      lookOnly = state.artifacts.length > artifactsBefore || planTouched || state.running.size ? 0 : lookOnly + 1;
      if (!calls.length) {
        stalls++;
        state.recent.push('You called no tool. Call tools, skip while waiting, or finish.');
        if (stalls > MAX_STALLS) break;
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
    // Agents still out when the loop ends are given a moment to land their artifacts.
    if (state.running.size) await Promise.race([new Promise(r => { wake.resolve = r; }), new Promise(r => setTimeout(r, 30_000))]);
    // A study that runs out of turns writes no summary: nothing is estimated into the gap.
    const budgetExhausted = finishSummary === null && turn >= maxTurns;
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
    await log('finish', { summary: finishSummary, turns: turn, tool_calls: state.toolCalls, failed: state.failed, artifacts: state.artifacts.length, seconds, tokens, unverified_numbers: unverified, budget_exhausted: budgetExhausted });
    await updateWorkspace(db, workspace.id, { status: 'completed', finishedUnixMs: Date.now(), planJson: { goal, mode, hpa_version: agentMode.hpaVersion, version: 'loop', plan: state.plan, turns: turn } });
    await logger.close();
    return { status: 'ok', workspace_uuid: workspace.uuid, summary: finishSummary, summary_md: summaryMd, artifacts: artifactsSummary(), plan: state.plan, turns: turn, tool_calls: state.toolCalls, failed: state.failed, unverified_numbers: unverified, budget_exhausted: budgetExhausted, tokens, seconds, mode, hpa_version: agentMode.hpaVersion };
  } catch (err) {
    await log('error', { message: err.message });
    await updateWorkspace(db, workspace.id, { status: 'failed', finishedUnixMs: Date.now(), errorCode: 'study_failed', errorMessage: err.message });
    await logger.close();
    return { status: 'error', error: err.message, workspace_uuid: workspace.uuid, artifacts: artifactsSummary(), tokens };
  }
}

module.exports = asoStudy;
