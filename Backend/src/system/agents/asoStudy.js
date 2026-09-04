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
const searchAdapter = require('../../hpa/searchAdapter');
const { createWorkspace, updateWorkspace } = require('../aso/workspaceStore');
const { registerArtifact } = require('../aso/artifactStore');
const { createLogger } = require('../aso/logger');
const { renderCharts } = require('../aso/pipelines/renderCharts');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');

const MAX_TURNS_DEFAULT = 40;     // platform_config.aso_max_steps overrides
const MAX_STALLS = 2;             // turns in a row with nothing to do before the loop ends
const WAKE_DEBOUNCE_MS = 300;     // completions this close together wake the loop once
const JOB_WAIT_MS = 15 * 60_000;  // longest the loop waits for a running agent
const SAMPLE_ROWS = 2;            // rows of each artifact shown in the context
const INSPECT_MAX = 40;           // rows inspect may show
const CELL = 60;                  // characters per shown cell

// ---- tools of the study itself ---------------------------------------------------------------------

const ARTIFACT_ARG = { type: 'string', description: 'an artifact id from the ARTIFACTS block, such as a3' };
const STUDY_TOOLS = [
  { name: 'set_plan', description: 'Write or rewrite the plan: a short list of high-level items (what to find out, not which operation). Write one first when the workspace is empty and there is no plan; rewrite it when the study changes direction.',
    parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] } },
  { name: 'update_plan', description: 'Mark one plan item todo, doing, done or dropped, with an optional note on why.',
    parameters: { type: 'object', properties: { item: { type: 'integer', description: '1-based item number' }, status: { type: 'string', enum: ['todo', 'doing', 'done', 'dropped'] }, note: { type: 'string' } }, required: ['item', 'status'] } },
  { name: 'note', description: 'Write a short note to yourself; it stays in the NOTES block of every later turn.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'measure', description: 'Read a value from a named table of the database for every gene of an artifact: exact, no model. With an entity ("liver") one row per gene; without, one row per gene per entity. Name the value column with "as" (liver_nTPM) so later steps can refer to it.',
    parameters: { type: 'object', properties: { artifact: ARTIFACT_ARG, table: { type: 'string' }, value_column: { type: 'string' }, entity_column: { type: 'string' }, entity: { type: 'string' }, as: { type: 'string' } }, required: ['artifact', 'table', 'value_column'] } },
  { name: 'union', description: 'Genes in either artifact, one row per gene.', parameters: { type: 'object', properties: { a: ARTIFACT_ARG, b: ARTIFACT_ARG }, required: ['a', 'b'] } },
  { name: 'intersect', description: 'The rows of a whose gene is also in b.', parameters: { type: 'object', properties: { a: ARTIFACT_ARG, b: ARTIFACT_ARG }, required: ['a', 'b'] } },
  { name: 'difference', description: 'The rows of a whose gene is absent from b.', parameters: { type: 'object', properties: { a: ARTIFACT_ARG, b: ARTIFACT_ARG }, required: ['a', 'b'] } },
  { name: 'concat', description: 'All rows of a followed by all rows of b; no matching on gene (for tables that share no key).', parameters: { type: 'object', properties: { a: ARTIFACT_ARG, b: ARTIFACT_ARG }, required: ['a', 'b'] } },
  { name: 'join', description: 'Each row of a combined with every row of b for the same gene (or the "on" column); b\'s clashing column names get _2.',
    parameters: { type: 'object', properties: { a: ARTIFACT_ARG, b: ARTIFACT_ARG, how: { type: 'string', enum: ['inner', 'left'] }, on: { type: 'string' } }, required: ['a', 'b'] } },
  { name: 'filter', description: 'Keep the rows of an artifact that satisfy every clause. Numbers compare numerically, text by case-insensitive equality or containment.',
    parameters: { type: 'object', properties: { artifact: ARTIFACT_ARG, where: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, op: { type: 'string', enum: ['>', '>=', '<', '<=', '=', '!=', 'contains', 'in'] }, value: {} }, required: ['column', 'op'] } } }, required: ['artifact', 'where'] } },
  { name: 'select', description: 'Keep and rename columns; add a constant column to label rows.',
    parameters: { type: 'object', properties: { artifact: ARTIFACT_ARG, columns: { type: 'array', items: { type: 'string' } }, rename: { type: 'object', additionalProperties: { type: 'string' } }, add: { type: 'object', additionalProperties: {} } }, required: ['artifact'] } },
  { name: 'rank', description: 'Sort the rows by a numeric column (adds rank), optionally cut to the top N.',
    parameters: { type: 'object', properties: { artifact: ARTIFACT_ARG, by: { type: 'string' }, order: { type: 'string', enum: ['desc', 'asc'] }, top: { type: 'integer' } }, required: ['artifact', 'by'] } },
  { name: 'top_per_group', description: 'Keep the n highest (or lowest) rows within each group: for example the entity with the highest value for every gene.',
    parameters: { type: 'object', properties: { artifact: ARTIFACT_ARG, group_by: { type: 'string' }, by: { type: 'string' }, n: { type: 'integer' }, order: { type: 'string', enum: ['desc', 'asc'] } }, required: ['artifact', 'by'] } },
  { name: 'aggregate', description: 'Summarise a column (count, sum, mean, median, min, max), optionally per group.',
    parameters: { type: 'object', properties: { artifact: ARTIFACT_ARG, group_by: { type: 'string' }, column: { type: 'string' }, metrics: { type: 'array', items: { type: 'string', enum: ['count', 'sum', 'mean', 'median', 'min', 'max'] } } }, required: ['artifact', 'metrics'] } },
  { name: 'compute', description: 'Add a column computed from one or two numeric columns: "a / b", "a - b", "log2(a / b)", "a + b", "a * b", "abs(a)".',
    parameters: { type: 'object', properties: { artifact: ARTIFACT_ARG, name: { type: 'string' }, expr: { type: 'string' } }, required: ['artifact', 'name', 'expr'] } },
  { name: 'pivot', description: 'Turn long rows (gene, entity, value) into a matrix; cap rows and columns for a readable heatmap.',
    parameters: { type: 'object', properties: { artifact: ARTIFACT_ARG, row: { type: 'string' }, column: { type: 'string' }, value: { type: 'string' }, top: { type: 'integer' }, top_columns: { type: 'integer' } }, required: ['artifact'] } },
  { name: 'chart', description: 'Draw an artifact as a figure. A heatmap takes a pivot output; the other types take rows with the named columns.',
    parameters: { type: 'object', properties: { artifact: ARTIFACT_ARG, type: { type: 'string', enum: ['bar', 'lollipop', 'dot_plot', 'diverging_bar', 'grouped_bar', 'scatter', 'bubble', 'heatmap', 'radar', 'line', 'volcano'] }, x: { type: 'string' }, y: { type: 'string' }, group: { type: 'string' }, size: { type: 'string' }, title: { type: 'string' }, x_label: { type: 'string' }, y_label: { type: 'string' } }, required: ['artifact', 'type'] } },
  { name: 'inspect', description: `List more rows of an artifact (up to ${INSPECT_MAX}) under it in ARTIFACTS, where they stay for every later turn.`,
    parameters: { type: 'object', properties: { artifact: ARTIFACT_ARG, rows: { type: 'integer' } }, required: ['artifact'] } },
  { name: 'skip', description: 'Nothing useful can be done until something running returns. Say why. You are woken again when it returns.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
  { name: 'finish', description: 'The goal is met, or cannot be met further. Give the summary: the findings with the artifact ids they rest on, and what could not be done.',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }
];
const STUDY_TOOL_NAMES = new Set(STUDY_TOOLS.map(t => t.name));
const TABLE_TOOLS = new Set(['measure', 'union', 'intersect', 'difference', 'concat', 'join', 'filter', 'select', 'rank', 'top_per_group', 'aggregate', 'compute', 'pivot', 'chart']);

function systemPrompt(dataOverview, searchOverview) {
  return `You run a study over a database for a researcher. You work in turns. Each turn you see the goal, your plan, every artifact in the workspace with where it came from, what is still running, and what came back since your last turn. You act by calling tools; you never state a value, gene or count yourself: a tool produces it and it becomes an artifact.

How the turns work:
- If the workspace is empty and there is no plan, write the plan first with set_plan: a few high-level items, what to find out, not which operation. Keep it honest: mark items done when an artifact shows they are, drop items that turn out wrong, rewrite the plan when the study changes direction.
- Call as many tools in one turn as can run independently; they run in parallel. Agents (deep_research_hpa, investigator_hpa, check_inclusion_hpa, dictionary_expert_hpa) run in the background and you are woken when each returns. Table tools return at once.
- When nothing useful can be done until something running returns, call skip with the reason. Do not repeat a tool that is still running.
- Refer to artifacts by their id. Use only column names an artifact actually has (they are listed). Name measure outputs with "as".
- deep_research_hpa finds gene sets from a description and builds the database query itself. investigator_hpa answers one question about one gene and cites the row it rests on; use measure instead when the value sits in a table column you can name, it is exact and free.
- A tool that fails tells you why under SINCE YOUR LAST TURN; fix the call rather than repeating it.
- inspect lists more rows of an artifact under it in ARTIFACTS, where they stay; one inspect per artifact is enough. Two rows are always shown.
- Do not verify a table tool's output with an agent; table tools are exact. If a value looks wrong, check the arguments (the entity, the column, the table) and call the tool again.
- Call finish when the goal is met, with a summary that cites artifact ids; also finish, saying what is missing, when the database cannot express what is left.

What a search can express (the search agent fills the fields in itself):
${searchOverview}

Tables that measure can read, with their columns:
${dataOverview}`;
}

// ---- context rendering -----------------------------------------------------------------------------

function cell(v) {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > CELL ? `${s.slice(0, CELL - 1)}…` : s;
}

function sampleLines(rows, columns, n) {
  const cols = columns.slice(0, 7);
  return rows.slice(0, n).map(r => cols.map(c => cell(r[c])).join(' | '));
}

function describeArgs(args) {
  return Object.entries(args || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

function artifactLine(a) {
  const lines = [`${a.id}  ${a.kind.padEnd(7)} "${a.label}"  ${a.size}`];
  lines.push(`    from ${a.tool}(${describeArgs(a.args)})${a.inputs.length ? `  reads ${a.inputs.join(', ')}` : ''}`);
  if (a.meta?.search_url) lines.push(`    ${a.meta.query ? a.meta.query + '  ' : ''}${a.meta.search_url}`);
  if (a.meta?.not_expressible?.length) lines.push(`    not expressible: ${a.meta.not_expressible.join('; ')}`);
  if (a.columns?.length) lines.push(`    columns ${a.columns.slice(0, 14).join(', ')}${a.columns.length > 14 ? `, … (${a.columns.length})` : ''}`);
  if (a.rows?.length) for (const l of sampleLines(a.rows, a.columns, a.shown || SAMPLE_ROWS)) lines.push(`    ${l}`);
  if (a.shown && a.rows && a.rows.length > a.shown) lines.push(`    … ${a.rows.length - a.shown} more rows`);
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
  return `GOAL
${state.goal}

PLAN  (yours; high level; cross items off with update_plan; rewrite with set_plan)
${plan}

ARTIFACTS  (everything in the workspace; refer to them by id)
${artifacts}

RUNNING  (started by you, not back yet; you are woken when each returns)
${running}

SINCE YOUR LAST TURN
${recent}

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

  const state = { goal, plan: [], artifacts: [], byId: new Map(), running: new Map(), recent: [], notes: [], toolCalls: 0, failed: 0, ids: { a: 0, t: 0 } };
  const wake = { resolve: null };
  const wakeUp = () => { if (wake.resolve) { const r = wake.resolve; wake.resolve = null; r(); } };
  const artifactsSummary = () => state.artifacts.map(a => ({ artifact_uuid: a.uuid, kind: a.kind === 'figure' ? 'figure' : a.kind === 'note' ? 'inspection' : a.kind === 'answer' ? 'measurement' : 'dataset', tool: a.tool, summary: { id: a.id, label: a.label, row_count: a.rows?.length }, storage_uri: a.storageUri }));

  const agentSpecs = orchestrator.getToolSpecs().filter(t => t.function.name !== 'aso_hpa');
  const agentNames = new Set(agentSpecs.map(t => t.function.name));
  const toolSpecs = [...agentSpecs, ...STUDY_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))];
  const [dataOverview] = await Promise.all([geneData.overview()]);
  const system = systemPrompt(dataOverview, searchAdapter.overview());

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
    const size = kind === 'figure' ? 'figure' : matrix ? `${matrix.row_labels.length} × ${matrix.col_labels.length} matrix` : kind === 'note' ? 'note' : tool === 'deep_research_hpa' ? `${rows.length} genes` : `${rows.length} rows`;
    const a = { id, uuid: reg.artifactUuid, storageUri: reg.storageUri, kind, label, size, rows: rows || null, matrix: matrix || null, text: text || null, columns, tool, args, inputs, meta: meta || {}, images, toolId };
    state.artifacts.push(a);
    state.byId.set(id, a);
    return a;
  }

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
        state.recent.push(`${id} ${tool} returned: ${a.id} (${a.size})${a.meta?.search_url ? `, ${a.meta.search_url}` : ''}${a.meta?.not_expressible?.length ? `, not expressible: ${a.meta.not_expressible.join('; ')}` : ''}`);
        await log('tool.done', { id, tool, kind: 'agent', artifact: artifactEvent(a), ms: Date.now() - job.startedAt }, id);
      })
      .catch(async err => {
        state.failed++;
        state.recent.push(`${id} ${tool} failed: ${err.message}`);
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
    const label = tool === 'chart' ? String(args.title || 'figure').slice(0, 80) : `${tool}(${describeArgs(args).slice(0, 60)})`;
    await log('tool.start', { id, tool, kind: tool === 'chart' ? 'chart' : 'tool', label, args, inputs }, id);
    try {
      const rowsOf = key => { const a = get(args[key]); if (a.matrix) throw new Error(`${a.id} is a matrix; only a heatmap chart can take it`); if (!a.rows) throw new Error(`${a.id} has no rows`); return a.rows; };
      let out;
      switch (tool) {
        case 'measure': out = { rows: await tools.measure(rowsOf('artifact'), args, config.asoParallelLimit || 3) }; break;
        case 'union': case 'intersect': case 'difference': case 'concat': out = { rows: tools.setOp(tool, rowsOf('a'), rowsOf('b'), args.on || null) }; break;
        case 'join': out = { rows: tools.join(rowsOf('a'), rowsOf('b'), args.how, args.on || null) }; break;
        case 'filter': out = { rows: tools.applyWhere(rowsOf('artifact'), args.where) }; break;
        case 'select': out = { rows: tools.select(rowsOf('artifact'), args.columns, args.rename || {}, args.add || {}) }; break;
        case 'rank': out = { rows: tools.rank(rowsOf('artifact'), args.by, args.order, Number(args.top) || 0) }; break;
        case 'top_per_group': out = { rows: tools.topPerGroup(rowsOf('artifact'), args) }; break;
        case 'aggregate': out = { rows: tools.aggregate(rowsOf('artifact'), args) }; break;
        case 'compute': out = { rows: tools.compute(rowsOf('artifact'), String(args.name), String(args.expr)) }; break;
        case 'pivot': out = { matrix: tools.pivot(rowsOf('artifact'), args) }; break;
        case 'chart': { const a = get(args.artifact); out = { figure: tools.chartSpec(args, a.matrix ? a.matrix : rowsOf('artifact')) }; break; }
        default: throw new Error(`unknown tool ${tool}`);
      }
      const a = await addArtifact({ kind: out.figure ? 'figure' : 'data', label: tool === 'chart' ? label : `${tool} of ${inputs.join(', ')}`, rows: out.rows, matrix: out.matrix, figure: out.figure, tool, args, inputs, toolId: id });
      state.recent.push(`${id} ${tool} -> ${a.id} (${a.size})`);
      await log('tool.done', { id, tool, kind: out.figure ? 'chart' : 'tool', artifact: artifactEvent(a), ms: Date.now() - t0 }, id);
    } catch (err) {
      state.failed++;
      state.recent.push(`${id} ${tool}(${describeArgs(args).slice(0, 120)}) failed: ${err.message}`);
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
      const context = renderContext(state, turn, startedAt);
      const res = await inference.chat.completions.create({ messages: [{ role: 'system', content: system }, { role: 'user', content: context }], tools: toolSpecs, temperature: 0 });
      addUsage(res.usage);
      const message = res.choices?.[0]?.message || {};
      const calls = (message.tool_calls || []).map(c => { let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = {}; } return { name: c.function?.name, args }; });
      await log('turn', { turn, text: message.content ? String(message.content).slice(0, 600) : null, calls: calls.map(c => ({ tool: c.name, args: c.args })) });
      state.recent = [];
      let sync = 0;
      let waiting = false;
      for (const call of calls) {
        if (call.name === 'finish') { finishSummary = String(call.args.summary || ''); break; }
        if (call.name === 'skip') { waiting = true; await log('skip', { reason: call.args.reason || '' }); continue; }
        if (call.name === 'set_plan') { state.plan = (call.args.items || []).map(text => ({ text: String(text), status: 'todo', note: '' })); await log('plan', { items: state.plan }); continue; }
        if (call.name === 'update_plan') {
          const item = state.plan[Number(call.args.item) - 1];
          if (item) { item.status = call.args.status || item.status; if (call.args.note) item.note = String(call.args.note); }
          else state.recent.push(`update_plan failed: there is no item ${call.args.item}`);
          await log('plan', { items: state.plan, changed: Number(call.args.item) }); continue;
        }
        if (call.name === 'note') { state.notes.push(String(call.args.text || '')); await log('note', { text: String(call.args.text || '') }); continue; }
        if (call.name === 'inspect') {
          // The rows stay listed under the artifact from now on, so one look is enough.
          try { const a = get(call.args.artifact); const n = Math.min(INSPECT_MAX, Number(call.args.rows) || 20); a.shown = Math.max(a.shown || 0, n); state.recent.push(`${a.id}: ${Math.min(n, (a.rows || []).length)} rows now listed under it in ARTIFACTS`); }
          catch (err) { state.recent.push(`inspect failed: ${err.message}`); }
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
        if (waiting) state.recent.push('Nothing is running, so there is nothing to wait for. Act or finish.');
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
