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
const INSPECT_MAX = 40;           // rows inspect may show
const CELL = 60;                  // characters per shown cell

// ---- tools of the study itself ---------------------------------------------------------------------

const A = { type: 'string', description: 'artifact id, or a dataset name' };
const S = { type: 'string' };
const N = { type: 'integer' };
const tool = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'object', properties, required } });
// One line each: the rules in the prompt do the teaching.
const STUDY_TOOLS = [
  tool('set_plan', 'Write or rewrite the plan: a few high-level items.', { items: { type: 'array', items: S } }, ['items']),
  tool('update_plan', 'Mark a plan item (1-based) todo, doing, done or dropped.', { item: N, status: { type: 'string', enum: ['todo', 'doing', 'done', 'dropped'] }, note: S }, ['item', 'status']),
  tool('note', 'Write a note to yourself; it stays in NOTES.', { text: S }, ['text']),
  tool('datasets', 'List the datasets on disk.'),
  tool('open', 'Read an artifact (by id) or a dataset (by name): every column name and some rows, shown this turn; columns picks which columns the rows show.', { what: S, rows: N, columns: { type: 'array', items: S } }, ['what']),
  tool('measure', 'Add a dataset value to every row of an artifact (the rows keep their columns; the new column comes first); with entity one row per gene, without one row per gene and entity, the entity column keeping its dataset name; "as" names the new column.', { artifact: A, table: { type: 'string', description: 'dataset name' }, value_column: S, entity_column: S, entity: S, as: S }, ['artifact', 'table', 'value_column']),
  tool('union', 'Genes in either artifact.', { a: A, b: A }, ['a', 'b']),
  tool('intersect', 'Rows of a whose gene is in b.', { a: A, b: A }, ['a', 'b']),
  tool('difference', 'Rows of a whose gene is not in b.', { a: A, b: A }, ['a', 'b']),
  tool('concat', 'All rows of a then all rows of b.', { a: A, b: A }, ['a', 'b']),
  tool('join', 'Rows of a combined with matching rows of b by gene (or "on"); clashing names of b get _2.', { a: A, b: A, how: { type: 'string', enum: ['inner', 'left'] }, on: S }, ['a', 'b']),
  tool('filter', 'Keep rows satisfying every clause.', { artifact: A, where: { type: 'array', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: ['>', '>=', '<', '<=', '=', '!=', 'contains', 'in'] }, value: {} }, required: ['column', 'op'] } } }, ['artifact', 'where']),
  tool('select', 'Keep columns, rename them, add constant columns.', { artifact: A, columns: { type: 'array', items: S }, rename: { type: 'object', additionalProperties: S }, add: { type: 'object', additionalProperties: {} } }, ['artifact']),
  tool('rank', 'Sort by a numeric column (adds rank); top keeps the first N.', { artifact: A, by: S, order: { type: 'string', enum: ['desc', 'asc'] }, top: N }, ['artifact', 'by']),
  tool('top_per_group', 'Keep the n highest rows per group (default group gene).', { artifact: A, group_by: S, by: S, n: N, order: { type: 'string', enum: ['desc', 'asc'] } }, ['artifact', 'by']),
  tool('aggregate', 'count, sum, mean, median, min, max of a column, optionally per group.', { artifact: A, group_by: S, column: S, metrics: { type: 'array', items: { type: 'string', enum: ['count', 'sum', 'mean', 'median', 'min', 'max'] } } }, ['artifact', 'metrics']),
  tool('compute', 'Add a column from an expression over columns and numbers: + - * / ( ) log2 log10 ln abs sqrt exp min max.', { artifact: A, name: S, expr: S }, ['artifact', 'name', 'expr']),
  tool('pivot', 'Long rows to a matrix: row (default gene), column and value name the columns; top and top_columns cap it.', { artifact: A, row: S, column: S, value: S, top: N, top_columns: N }, ['artifact', 'column', 'value']),
  tool('chart', 'Draw an artifact; heatmap takes a pivot.', { artifact: A, type: { type: 'string', enum: ['bar', 'lollipop', 'dot_plot', 'diverging_bar', 'grouped_bar', 'scatter', 'bubble', 'heatmap', 'radar', 'line', 'volcano'] }, x: S, y: S, group: S, size: S, title: S, x_label: S, y_label: S }, ['artifact', 'type']),
  tool('skip', 'Nothing to do until something running returns.', { reason: S }, ['reason']),
  tool('finish', 'The goal is met or cannot be met further; summary cites artifact ids.', { summary: S }, ['summary'])
];
const STUDY_TOOL_NAMES = new Set(STUDY_TOOLS.map(t => t.name));
const TABLE_TOOLS = new Set(['measure', 'union', 'intersect', 'difference', 'concat', 'join', 'filter', 'select', 'rank', 'top_per_group', 'aggregate', 'compute', 'pivot', 'chart']);

function systemPrompt() {
  return `You run a study over a database for a researcher, the way a careful person would at a desk. You work in turns. Each turn you see the goal, your plan, the artifacts on your desk and where each came from, what is still running, and what came back since your last turn. You act by calling tools; you never state a value, gene or count yourself: a tool produces it and it becomes an artifact.

How the turns work:
- Your first turn does one thing: call set_plan, alone, with a few high-level items (what to find out, not which operation). Nothing else runs in that turn; agents and tools come in the turns after, once the plan exists. Do not write the plan again unless the study changes direction; from the second turn on, work. Keep the plan honest: mark items done when an artifact shows they are, drop items that turn out wrong, rewrite the plan when the study changes direction.
- Call as many tools in one turn as can run independently; they run in parallel. Agents (deep_research_hpa, investigator_hpa, check_inclusion_hpa, dictionary_expert_hpa) run in the background and you are woken when each returns. Everything else returns at once.
- When nothing useful can be done until something running returns, call skip with the reason. Do not repeat a tool that is still running.
- You know nothing about the data until you look. datasets shows what is on disk; open reads a dataset or an artifact and shows every column name and some rows, in that turn (columns picks which columns the rows show). A result you make shows its new columns first, with two rows, as it lands; a dataset or artifact you opened keeps a short column line on the desk. Rows you must remember, open again or write in a note. Name only columns you have seen.
- A dataset name works wherever a tool takes an artifact id: filter proteinatlas.tsv directly, or join, intersect or difference an artifact with a per-gene dataset to get that dataset's rows for those genes.
- deep_research_hpa finds gene sets from a description and builds the database query itself; it knows the search fields and tells you when something cannot be expressed. investigator_hpa answers one question about one gene and cites the row it rests on; when the value sits in a table column you can name, measure is exact and free, so prefer it.
- Refer to artifacts by their id. measure adds a column to the rows it is given, so measuring pancreas then liver on the same artifact leaves both columns in the result; name each with "as".
- Do the bookkeeping in the same turn as the work: update_plan alongside the tools that complete the item, and finish in the same turn as the last piece of work. A turn spent only on update_plan is a turn wasted.
- A tool that fails tells you why under SINCE YOUR LAST TURN; fix the call rather than repeating it. Table tools are exact: if a value looks wrong, the arguments were wrong (the entity, the column, the table), not the data.
- Call finish when the goal is met, with a summary that cites artifact ids; also finish, saying what is missing, when the database cannot express what is left.`;
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

const MAX_DATASET_ROWS = 200000;

// Gene and ensembl keys for a row read straight from a dataset, so set operations and joins work.
function geneKeys(entry, row) {
  const isEnsembl = v => /^ENSG\d{5,}$/.test(String(v || ''));
  if (entry.key === 'name') return { gene: row[entry.columns[0]] || null, ensembl: row[entry.columns[1]] || null };
  const column = entry.geneColumn || entry.columns.find(c => isEnsembl(row[c]));
  const name = row['Gene name'] ?? (isEnsembl(row.Gene) ? null : row.Gene) ?? null;
  return { gene: name || null, ensembl: column ? row[column] || null : null };
}

// A dataset used where an artifact goes. Gene-level files come whole; a per-gene file comes
// restricted to the genes of the other input, or filtered while it streams, since whole it
// would not fit on any desk.
async function datasetRows(entry, { genes = null, where = null, limit = 3 } = {}) {
  if (entry.key === 'master') {
    const master = await localData.master();
    return master.rows.map(r => { const { Gene, Ensembl, ...rest } = r; return { gene: Gene, ensembl: Ensembl, ...rest }; });
  }
  if (entry.key === 'lookup' || entry.key === 'scan') return (await localData.table(entry.file)).rows.map(r => ({ ...geneKeys(entry, r), ...r }));
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
        if (out.length > MAX_DATASET_ROWS) throw new Error(`${entry.file} gives more than ${MAX_DATASET_ROWS} rows for these genes; filter it or use fewer genes`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, queue.length)) }, worker));
    return out;
  }
  if (where) {
    const keep = tools.wherePredicate(entry.columns, where);
    const out = [];
    for await (const row of localData.rows(entry.file, { where: keep })) {
      out.push({ ...geneKeys(entry, row), ...row });
      if (out.length > MAX_DATASET_ROWS) throw new Error(`filter on ${entry.file} keeps more than ${MAX_DATASET_ROWS} rows; make it stricter`);
    }
    return out;
  }
  throw new Error(`${entry.file} has a row per gene and entity, too many to take whole: filter it, or use it with an artifact (join, intersect, difference) so it is read for those genes`);
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
  if (a.text) lines.push(`    ${cell(a.text).slice(0, 300)}`);
  return lines.join('\n');
}

function renderContext(state, turn, startedAt) {
  const plan = state.plan.length
    ? state.plan.map((p, i) => `${i + 1}. [${p.status === 'done' ? 'done' : p.status === 'doing' ? 'doing' : p.status === 'dropped' ? 'dropped' : ' '}]  ${p.text}${p.note ? `  (${p.note})` : ''}`).join('\n')
    : 'No plan yet. The workspace is empty. Start by writing one with set_plan.';
  const artifacts = state.artifacts.length ? state.artifacts.map(artifactLine).join('\n') : '(none)';
  const running = state.running.size
    ? [...state.running.values()].map(j => `${j.id}  ${j.tool}(${describeArgs(j.args)})  ${Math.round((Date.now() - j.startedAt) / 1000)} s`).join('\n')
    : '(nothing)';
  const recent = state.recent.length ? state.recent.map(r => `- ${r}`).join('\n') : '(nothing new)';
  const notes = state.notes.length ? state.notes.map(n => `- ${n}`).join('\n') : '(none)';
  const opened = state.tablesSeen.size ? `\nDATASETS YOU HAVE OPENED  (first columns; open one again to see all of them, or rows)\n${[...state.tablesSeen.values()].join('\n')}` : '';
  const tables = state.tableList ? `DATASETS ON DISK  (open one to see what it holds)\n${state.tableList.join('  ')}${opened}` : (opened ? opened.trim() : null);
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
${tables ? `\n${tables}\n` : ''}
NOTES
${notes}

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

async function asoStudy({ goal, mode: requestedMode, max_turns }, ctx = {}) {
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

  const state = { goal, plan: [], artifacts: [], byId: new Map(), running: new Map(), recent: [], notes: [], tableList: null, tablesSeen: new Map(), history: [], turn: 0, toolCalls: 0, failed: 0, ids: { a: 0, t: 0 } };
  const remember = (text) => { const entry = state.history[state.history.length - 1]; if (entry && entry.turn === state.turn) entry.items.push(text); else state.history.push({ turn: state.turn, items: [text] }); };
  const wake = { resolve: null };
  const wakeUp = () => { if (wake.resolve) { const r = wake.resolve; wake.resolve = null; r(); } };
  const artifactsSummary = () => state.artifacts.map(a => ({ artifact_uuid: a.uuid, kind: a.kind === 'figure' ? 'figure' : a.kind === 'note' ? 'inspection' : a.kind === 'answer' ? 'measurement' : 'dataset', tool: a.tool, summary: { id: a.id, label: a.label, row_count: a.rows?.length }, storage_uri: a.storageUri }));

  const agentSpecs = orchestrator.getToolSpecs().filter(t => t.function.name !== 'aso_hpa');
  const agentNames = new Set(agentSpecs.map(t => t.function.name));
  const toolSpecs = [...agentSpecs, ...STUDY_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))];
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
  async function runTableTool(tool, args) {
    const id = `t${++state.ids.t}`;
    const t0 = Date.now();
    state.toolCalls++;
    const inputs = ['artifact', 'a', 'b'].map(k => args[k]).filter(Boolean).map(String);
    const label = tool === 'chart' ? String(args.title || 'figure').slice(0, 80) : `${tool}(${describeArgs(args, 100)})`;
    await log('tool.start', { id, tool, kind: tool === 'chart' ? 'chart' : 'tool', label, args, inputs }, id);
    try {
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
      let out;
      switch (tool) {
        case 'measure': out = { rows: await tools.measure(await rowsOf('artifact'), args, parallel) }; break;
        case 'union': case 'intersect': case 'difference': case 'concat': out = { rows: tools.setOp(tool, await rowsOf('a', 'b'), await rowsOf('b', 'a'), args.on || null) }; break;
        case 'join': out = { rows: tools.join(await rowsOf('a', 'b'), await rowsOf('b', 'a'), args.how, args.on || null) }; break;
        case 'filter': { const rows = await rowsOf('artifact'); out = { rows: streamed ? rows : tools.applyWhere(rows, args.where) }; break; }
        case 'select': { const obj = v => (typeof v === 'string' ? (JSON.parse(v || '{}') || {}) : (v || {})); out = { rows: tools.select(await rowsOf('artifact'), args.columns, obj(args.rename), obj(args.add)) }; break; }
        case 'rank': out = { rows: tools.rank(await rowsOf('artifact'), args.by, args.order, Number(args.top) || 0) }; break;
        case 'top_per_group': out = { rows: tools.topPerGroup(await rowsOf('artifact'), args) }; break;
        case 'aggregate': out = { rows: tools.aggregate(await rowsOf('artifact'), args) }; break;
        case 'compute': out = { rows: tools.compute(await rowsOf('artifact'), String(args.name), String(args.expr)) }; break;
        case 'pivot': out = { matrix: tools.pivot(await rowsOf('artifact'), args) }; break;
        case 'chart': { const a = state.byId.get(String(args.artifact ?? '').trim()); out = { figure: tools.chartSpec(args, a?.matrix ? a.matrix : await rowsOf('artifact')) }; break; }
        default: throw new Error(`unknown tool ${tool}`);
      }
      if (out.rows) out.rows = tools.freshFirst(out.rows, [...inputColumns]);
      const a = await addArtifact({ kind: out.figure ? 'figure' : 'data', label: tool === 'chart' ? label : `${tool} of ${inputs.join(', ')}`, rows: out.rows, matrix: out.matrix, figure: out.figure, tool, args, inputs, toolId: id });
      state.recent.push(`${id} ${tool} -> ${receipt(a)}`);
      remember(`${tool}(${inputs.join(', ')}) → ${a.id} (${a.size})`);
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
      // Until a plan exists the only tool on offer is set_plan: the first turn plans, alone.
      const lastTurn = turn >= maxTurns;
      if (lastTurn) state.recent.push('This is your last turn: call finish now with the summary of what the artifacts show and what is missing.');
      const offered = lastTurn ? toolSpecs.filter(t => t.function.name === 'finish') : state.plan.length ? toolSpecs : toolSpecs.filter(t => t.function.name === 'set_plan');
      const res = await inference.chat.completions.create({ messages: [{ role: 'system', content: system }, { role: 'user', content: context }], tools: offered, temperature: 0, prompt_cache: { key: `study ${workspace.uuid}` } });
      addUsage(res.usage);
      const message = res.choices?.[0]?.message || {};
      const calls = (message.tool_calls || []).map(c => { let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = {}; } return { name: c.function?.name, args }; });
      await log('turn', { turn, text: message.content ? String(message.content).slice(0, 600) : null, calls: calls.map(c => ({ tool: c.name, args: c.args })), offered: offered.length });
      state.recent = [];
      let sync = 0;
      let waiting = false;
      if (!state.plan.length) {
        // The planning turn: set_plan and nothing else; anything else waits for the next turn.
        const plan = calls.find(c => c.name === 'set_plan');
        const others = calls.filter(c => c.name !== 'set_plan').map(c => c.name);
        if (plan) { state.plan = (plan.args.items || []).map(text => ({ text: String(text), status: 'todo', note: '' })); remember('wrote the plan'); await log('plan', { items: state.plan }); }
        if (others.length) state.recent.push(`Not run: ${others.join(', ')}. The first turn writes the plan alone; call tools from the next turn on.`);
        if (!plan) { stalls++; state.recent.push('Write the plan first with set_plan, alone.'); if (stalls > MAX_STALLS) break; }
        else stalls = 0;
        continue;
      }
      for (const call of calls) {
        if (call.name === 'finish') { finishSummary = String(call.args.summary || ''); break; }
        if (call.name === 'skip') { waiting = true; remember(`waited: ${String(call.args.reason || '').slice(0, 80)}`); await log('skip', { reason: call.args.reason || '' }); continue; }
        if (call.name === 'set_plan') { state.plan = (call.args.items || []).map(text => ({ text: String(text), status: 'todo', note: '' })); remember('rewrote the plan'); await log('plan', { items: state.plan }); continue; }
        if (call.name === 'update_plan') {
          const item = state.plan[Number(call.args.item) - 1];
          if (item) { item.status = call.args.status || item.status; if (call.args.note) item.note = String(call.args.note); remember(`plan item ${call.args.item} ${item.status}`); }
          else state.recent.push(`update_plan failed: there is no item ${call.args.item}`);
          await log('plan', { items: state.plan, changed: Number(call.args.item) }); continue;
        }
        if (call.name === 'note') { state.notes.push(String(call.args.text || '')); remember('wrote a note'); await log('note', { text: String(call.args.text || '') }); continue; }
        if (call.name === 'datasets') {
          const entries = (await geneData.catalog()).filter(e => e.key !== 'unreadable');
          state.tableList = entries.map(e => e.file);
          state.recent.push(`${entries.length} datasets are now listed under DATASETS ON DISK for every later turn`);
          remember('listed the datasets'); sync++; continue;
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
              // Rows come from a gene already on the desk, so the model sees real entities.
              const sampleGene = state.artifacts.flatMap(a => a.rows || []).map(r => r.ensembl || r.gene).find(Boolean);
              let rows = [];
              if (entry.key === 'lookup') rows = (await geneData.read({ gene: '', ensembl: '' }, entry.file)).rows;
              else if (sampleGene) { const gene = await geneData.resolveGene(sampleGene); if (gene) rows = (await geneData.read(gene, entry.file)).rows; }
              const terms = entry.columns.map(c => geneData.definition(c)).filter(Boolean);
              state.tablesSeen.set(entry.file, `${entry.file}: ${columnList(entry.columns)}`);
              remember(`opened ${entry.file}`);
              state.recent.push(`${entry.file} — ${entry.title} columns: ${entry.columns.join(' | ')}${terms.length ? `\n  terms: ${terms.slice(0, 4).join('; ')}` : ''}${rows.length ? `\n  ${sampleBlock(rows, entry.columns, n, pick)}${rows.length > n ? `\n  … ${rows.length - n} more rows for this gene` : ''}` : '\n  (no rows to show yet; nothing on the desk names a gene)'}`);
            }
          } catch (err) { state.recent.push(`open failed: ${err.message}`); remember(`open ${what || '(no name)'} failed`); }
          sync++; continue;
        }
        if (agentNames.has(call.name)) { startAgent(call.name, call.args); continue; }
        if (TABLE_TOOLS.has(call.name)) { await runTableTool(call.name, call.args); sync++; continue; }
        state.recent.push(`unknown tool ${call.name}`);
      }
      if (finishSummary !== null) break;
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
    if (finishSummary === null) finishSummary = turn >= maxTurns ? `The study stopped after ${turn} turns without calling finish.` : 'The study stopped with nothing left to do.';

    const seconds = (Date.now() - startedAt) / 1000;
    const summaryMd = [`# Study`, '', `**Goal:** ${goal}`, '', finishSummary, '', '## Artifacts', '', ...state.artifacts.map(a => `- ${a.id} ${a.kind} "${a.label}" (${a.size}) from ${a.tool}${a.inputs.length ? ` of ${a.inputs.join(', ')}` : ''}`), '', '## Plan', '', ...state.plan.map((p, i) => `${i + 1}. [${p.status}] ${p.text}`)].join('\n');
    const reportPath = path.join(workspace.workspaceDir, 'report.md');
    await fs.writeFile(reportPath, summaryMd, { mode: 0o600 });
    await register({ workspaceId: workspace.id, artifactsDir: workspace.artifactsDir, kind: 'summary', format: 'md', schemaJson: { type: 'report' }, provenance: { tool: 'report', sources: state.artifacts.map(a => a.uuid), purpose: 'Study summary' }, payload: null, storageUriOverride: reportPath, skipWrite: true });
    await log('finish', { summary: finishSummary, turns: turn, tool_calls: state.toolCalls, failed: state.failed, artifacts: state.artifacts.length, seconds, tokens });
    await updateWorkspace(db, workspace.id, { status: 'completed', finishedUnixMs: Date.now(), planJson: { goal, mode, hpa_version: agentMode.hpaVersion, version: 'loop', plan: state.plan, turns: turn } });
    await logger.close();
    return { status: 'ok', workspace_uuid: workspace.uuid, summary: finishSummary, summary_md: summaryMd, artifacts: artifactsSummary(), plan: state.plan, turns: turn, tool_calls: state.toolCalls, failed: state.failed, tokens, seconds, mode, hpa_version: agentMode.hpaVersion };
  } catch (err) {
    await log('error', { message: err.message });
    await updateWorkspace(db, workspace.id, { status: 'failed', finishedUnixMs: Date.now(), errorCode: 'study_failed', errorMessage: err.message });
    await logger.close();
    return { status: 'error', error: err.message, workspace_uuid: workspace.uuid, artifacts: artifactsSummary(), tokens };
  }
}

module.exports = asoStudy;
