'use strict';

/**
 * Study agent (ASO v2). The model plans a graph of operations once; independent nodes run in
 * parallel; each node's output becomes an artifact whose derived_from links are the graph's edges,
 * so the provenance drawing is the study itself. A bounded number of reflection rounds may add
 * nodes after seeing the results, and a report cites nodes by id. The model only chooses operations
 * and their arguments: every value, gene list and figure is produced by a tool.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const { inference, getActiveModel } = require('../../inference/gateway');
const { jsonCall } = require('../../inference/jsonCall');
const { platformConfig } = require('../../policy/config');
const deepResearchTrail = require('./deepResearchTrail');
const investigatorTrail = require('./investigatorTrail');
const tools = require('../aso/studyTools');
const geneData = require('../../hpa/geneDataAdapter');
const searchAdapter = require('../../hpa/searchAdapter');
const { createWorkspace, updateWorkspace } = require('../aso/workspaceStore');
const { registerArtifact } = require('../aso/artifactStore');
const { createLogger } = require('../aso/logger');
const { renderCharts } = require('../aso/pipelines/renderCharts');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');

const MAX_REFLECTIONS = 2;      // rounds in which the model may add nodes after seeing results
const MAX_NODES = 60;           // graph size cap
const MAX_LOOKUP_GENES = 200;   // genes one lookup node may ask about
const FULL_ROWS = 30;           // a node with at most this many rows is shown whole to the model
const SAMPLE_ROWS = 8;          // otherwise this many
const SAMPLE_CELL = 80;         // characters per shown cell

const REQUIRED_ARGS = { search: ['question'], lookup: ['question'], measure: ['table', 'value_column'], filter: ['where'], rank: ['by'], top_per_group: ['by'], compute: ['name', 'expr'], chart: ['type'] };
const KIND_FOR_OP = { search: 'gene_list', lookup: 'measurement', measure: 'measurement', pivot: 'analysis_matrix', rank: 'analysis_rank', aggregate: 'analysis_aggregate' };

function planSystem(allowSearch, dataOverview, searchOverview, masterEntry) {
  const catalog = tools.TOOL_CATALOG.filter(t => allowSearch || t.name !== 'search');
  return `You design a study as a graph of operations that answers a research goal from a database. You never compute, guess or state a value yourself: every number, gene list and figure comes from an operation applied to earlier nodes.

Operations:
${catalog.map(t => `- ${t.name}: ${t.description} Inputs: ${t.inputs}. Args: ${JSON.stringify(t.args)}. Produces: ${t.produces}.`).join('\n')}

Row shapes: search rows carry gene, ensembl and every non-empty column of the "${masterEntry?.title || 'summary'}" table below; measure rows carry gene, ensembl, entity and the value under the name given in "as" (default value); lookup rows carry gene, ensembl, found, answer, the value under "as" (default value), entity, table. A join keeps the first input's columns and adds the second's, suffixing a clashing name with _2; give each measure its own "as" name (liver_nTPM, pancreas_nTPM) so later steps can name columns that exist. Every later step's column names are checked against its real input before it runs.

What "search" can express (the database's search fields; the search agent fills them in itself):
${searchOverview}

Tables that "measure" can read, with their columns:
${dataOverview}

Return JSON:
{"understanding": "the goal in your own words",
 "nodes": [{"id": "n1", "op": "search", "inputs": [], "args": {}, "label": "short name for this node", "why": "one line"}],
 "cannot": [{"requirement": "a requirement no operation can express", "why": "..."}]}

Rules:
- inputs are ids of earlier nodes; their number must match the operation's input count.
- search finds gene sets; combine sets with union, intersect, difference; take exact values with measure; ask judgement questions with lookup; derive with compute, aggregate, rank, filter, pivot; draw with chart.
- Use measure when the value sits in a table column you can name; use lookup only when the question needs reading and judgement.
- Column names in args must be columns the input actually has.
- Independent nodes run in parallel: make the graph as wide as the goal allows, one specific question per search.
- Every figure is its own chart node fed by the node holding exactly the rows to draw (rank or filter first when a chart would be too crowded).
- Put anything the operations cannot express in "cannot" instead of approximating it.`;
}

const REFLECT_SUFFIX = `

You are now reviewing the study in progress: the graph and what each node produced. Decide whether the goal is answered or more nodes are needed: to repair a failed node (a different table, column, question or argument), to follow what the results show, or to add a missing figure. Return JSON {"done": true|false, "assessment": "what the results show so far and what is missing", "nodes": [new nodes with fresh ids; inputs may reference any existing node]}. Do not repeat a node that succeeded and do not add nodes that only restate what exists; return done: true with no nodes when the goal is answered.`;

const REPAIR_SYSTEM = `One operation of a study names columns its input does not have. Return JSON {"args": {...}} with the corrected arguments: keep the operation's intent, name only columns from the list given, and change nothing else.`;

const REPORT_SYSTEM = `Write the report of a completed study in Markdown. You are given the goal and every node with what it produced: row counts, columns, its rows or a sample of them, or its error. Every statement of fact ends with the id of the node it comes from, like [n4]. Use only values that appear in the node outputs; when only a sample of a node is shown, say so and point to the node for the rest. Sections: "Summary" (answers the goal in a few sentences), "Findings" (one bullet per line of evidence, each with its node), "Methods" (how the graph answered the goal, in words, naming the operations), "Limitations" (failed or blocked nodes, requirements the database could not express, sampling). Do not invent numbers or genes. Return JSON {"title": "a short title", "report_md": "the report"}.`;

// ---- plan validation -----------------------------------------------------------------------------

function validateNodes(rawNodes, existingIds, allowSearch) {
  const errors = [];
  const ids = new Set(existingIds);
  const nodes = [];
  if (!Array.isArray(rawNodes)) return { errors: ['"nodes" must be a list'], nodes };
  for (const raw of rawNodes) {
    const n = {
      id: String(raw?.id || '').trim(), op: String(raw?.op || raw?.tool || '').trim(),
      inputs: Array.isArray(raw?.inputs) ? raw.inputs.map(String) : [],
      args: raw?.args && typeof raw.args === 'object' ? raw.args : {},
      label: String(raw?.label || raw?.id || '').slice(0, 80), why: String(raw?.why || '')
    };
    const tool = tools.TOOL_CATALOG.find(t => t.name === n.op);
    if (!n.id) { errors.push('a node has no id'); continue; }
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(n.id)) errors.push(`${n.id}: ids are letters, digits, _ . - (at most 40)`);
    if (ids.has(n.id)) errors.push(`duplicate id ${n.id}`);
    if (!tool) errors.push(`${n.id}: unknown operation "${n.op}"`);
    else {
      if (!allowSearch && n.op === 'search') errors.push(`${n.id}: search is not allowed in this study`);
      if (n.inputs.length !== tool.inputs) errors.push(`${n.id}: ${n.op} takes ${tool.inputs} input(s), got ${n.inputs.length}`);
      for (const a of REQUIRED_ARGS[n.op] || []) if (n.args[a] === undefined || n.args[a] === '') errors.push(`${n.id}: ${n.op} needs args.${a}`);
    }
    for (const i of n.inputs) if (!ids.has(i)) errors.push(`${n.id}: input ${i} is not an earlier node`);
    ids.add(n.id);
    nodes.push(n);
  }
  if (ids.size > MAX_NODES) errors.push(`too many nodes (limit ${MAX_NODES})`);
  return { errors, nodes };
}

// ---- node execution ------------------------------------------------------------------------------

function normalizeSearchRow(r) {
  const out = { gene: r.Gene ?? r.gene ?? null, ensembl: r.Ensembl ?? r.ensembl ?? null };
  for (const [k, v] of Object.entries(r)) {
    if (['Gene', 'Ensembl', 'gene', 'ensembl'].includes(k) || v === null || v === undefined || v === 'NA' || String(v).trim() === '') continue;
    out[k] = v;
  }
  return out;
}

function rowsOf(input, nodeId) {
  if (input?.output?.rows) return input.output.rows;
  if (input?.output?.matrix) throw new Error(`${nodeId}: input ${input.id} is a matrix; only a heatmap chart can take it`);
  if (input?.output?.figure) throw new Error(`${nodeId}: input ${input.id} is a figure and has no rows`);
  throw new Error(`${nodeId}: input ${input?.id} has no rows`);
}

async function parallelMap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// The columns an operation's arguments name, checked against the real input before it runs.
function columnRefs(op, args) {
  switch (op) {
    case 'filter': return (Array.isArray(args.where) ? args.where : []).map(w => w?.column);
    case 'select': return [...(Array.isArray(args.columns) ? args.columns : []), ...Object.keys(args.rename || {})];
    case 'rank': return [args.by];
    case 'top_per_group': return [args.group_by || 'gene', args.by];
    case 'aggregate': return [args.group_by, args.column];
    case 'compute': return String(args.expr || '').replace(/log2|abs/g, '').split(/[-+*/()]/).map(s => s.trim()).filter(s => s && !/^[\d.]+$/.test(s));
    case 'pivot': return [args.row || 'gene', args.column || 'entity', args.value || 'value'];
    case 'chart': return args.type === 'heatmap' ? [] : [args.x, args.y, args.group, args.size];
    case 'join': return args.on ? [args.on] : [];
    default: return [];
  }
}

const ROW_OPS = new Set(['filter', 'select', 'rank', 'top_per_group', 'aggregate', 'compute', 'pivot', 'chart', 'join', 'measure', 'lookup']);

// Arguments that name columns the input does not have are repaired once, from the real columns.
async function checkColumns(node, args, rows, ctx) {
  const missing = [...new Set(columnRefs(node.op, args).filter(c => c && !tools.findColumn(rows, c)))];
  if (!missing.length) return args;
  const columns = tools.columnsOf(rows);
  const repaired = await ctx.repairArgs(node, args, missing, columns, rows.slice(0, 2));
  const still = [...new Set(columnRefs(node.op, repaired).filter(c => c && !tools.findColumn(rows, c)))];
  if (still.length) throw new Error(`${node.op}: no column named "${still[0]}" (columns: ${columns.slice(0, 20).join(', ')})`);
  return repaired;
}

async function runNode(node, inputs, ctx) {
  let args = node.args || {};
  const first = inputs[0];
  if (node.op === 'search') {
    const r = await deepResearchTrail({ goal: String(args.question), mode: ctx.mode }, { onStep: ctx.forward(node.id), includeRows: true });
    ctx.addTokens(r.tokens);
    if (r.status !== 'ok') throw new Error(r.error || 'search failed');
    return { rows: (r.result.rows || []).map(normalizeSearchRow), meta: { search_url: r.result.search_urls[0], query: r.result.plan, trail: r.result.trail, not_expressible: r.result.not_expressible, mode: r.result.mode, hpa_version: r.result.hpa_version } };
  }
  const rows = ROW_OPS.has(node.op) && !(node.op === 'chart' && first?.output?.matrix) ? rowsOf(first, node.id) : null;
  // An empty input yields an empty output rather than a failure over columns that never existed.
  if (rows && !rows.length) {
    if (node.op === 'chart') throw new Error(`${node.id}: nothing to draw, ${first.id} has no rows`);
    if (node.op === 'pivot') return { matrix: { matrix: [], row_labels: [], col_labels: [] }, meta: { note: `${first.id} had no rows` } };
    return { rows: [], meta: { note: `${first.id} had no rows` } };
  }
  if (rows) args = await checkColumns(node, args, rows, ctx);
  switch (node.op) {
    case 'lookup': {
      const cap = Math.min(MAX_LOOKUP_GENES, Number(args.max_genes) > 0 ? Number(args.max_genes) : MAX_LOOKUP_GENES);
      const valueName = String(args.as || '').trim() || 'value';
      const genes = rows.slice(0, cap);
      const out = await parallelMap(genes, ctx.parallel, async g => {
        const question = String(args.question).replace(/\{gene\}/g, g.gene || g.ensembl);
        const r = await investigatorTrail({ gene: g.ensembl || g.gene, question, mode: ctx.mode }, { onStep: ctx.forward(`${node.id}:${g.gene || g.ensembl}`) });
        ctx.addTokens(r.tokens);
        return { gene: r.gene || g.gene, ensembl: r.ensembl || g.ensembl || null, found: r.found === true, answer: r.answer || '', [valueName]: r.extracted_value ?? null, entity: r.exact_label ?? null, table: r.source_section || null, cited_row: r.cited_row || null, confidence: r.confidence || null, ...(r.error ? { error: r.error } : {}) };
      });
      return { rows: out, meta: { question: args.question, asked: genes.length, found: out.filter(r => r.found).length } };
    }
    case 'measure': return { rows: await tools.measure(rows, args, ctx.parallel), meta: { table: args.table, value_column: args.value_column, entity_column: args.entity_column || null, entity: args.entity || null } };
    case 'union': case 'intersect': case 'difference': case 'concat': return { rows: tools.setOp(node.op, rowsOf(inputs[0], node.id), rowsOf(inputs[1], node.id), args.on || null) };
    case 'join': return { rows: tools.join(rows, rowsOf(inputs[1], node.id), args.how, args.on || null) };
    case 'filter': return { rows: tools.applyWhere(rows, args.where) };
    case 'select': return { rows: tools.select(rows, args.columns, args.rename || {}, args.add || {}) };
    case 'rank': return { rows: tools.rank(rows, args.by, args.order, Number(args.top) || 0) };
    case 'top_per_group': return { rows: tools.topPerGroup(rows, args) };
    case 'aggregate': return { rows: tools.aggregate(rows, args) };
    case 'compute': return { rows: tools.compute(rows, String(args.name), String(args.expr)) };
    case 'pivot': return { matrix: tools.pivot(rows, args) };
    case 'chart': return { figure: tools.chartSpec(args, first?.output?.matrix ? first.output.matrix : rows) };
    default: throw new Error(`${node.id}: unknown operation ${node.op}`);
  }
}

async function persistNode(node, out, inputs, ctx) {
  const { workspace, register } = ctx;
  const sources = inputs.map(i => i.artifact_uuid).filter(Boolean);
  const base = { workspaceId: workspace.id, artifactsDir: workspace.artifactsDir };
  if (out.figure) {
    const spec = await register({ ...base, kind: 'figure', format: 'json', schemaJson: { type: 'chart_spec' }, provenance: { tool: 'chart', sources, purpose: node.label },
      payload: { charts: [out.figure], node_id: node.id, label: node.label, args: node.args, provenance: { tool: 'chart', purpose: node.label, sources } } });
    // Each node renders in its own directory and the image takes the node's name, so parallel
    // chart nodes never race for a file name.
    const renderDir = path.join(workspace.workspaceDir, 'render', node.id);
    await fs.mkdir(renderDir, { recursive: true });
    const rendered = await renderCharts(spec.storageUri, renderDir);
    const images = [];
    for (const [i, img] of (rendered?.images || []).entries()) {
      const target = path.join(workspace.artifactsDir, `${node.id}${i ? `_${i + 1}` : ''}.png`);
      await fs.rename(img, target);
      const a = await register({ ...base, kind: 'figure', format: 'png', schemaJson: { type: 'image' }, provenance: { tool: 'chart', source: spec.artifactUuid, purpose: node.label }, payload: null, storageUriOverride: target, skipWrite: true });
      images.push({ artifact_uuid: a.artifactUuid, path: target });
    }
    if (!images.length) throw new Error(`${node.id}: the chart did not render`);
    return { artifact_uuid: spec.artifactUuid, storage_uri: spec.storageUri, images };
  }
  const provenance = { tool: node.op, purpose: node.label, sources, ...(out.meta || {}) };
  const payload = out.matrix
    ? { node_id: node.id, op: node.op, label: node.label, args: node.args, row_count: out.matrix.row_labels.length, column_count: out.matrix.col_labels.length, ...out.matrix, provenance }
    : { node_id: node.id, op: node.op, label: node.label, args: node.args, row_count: out.rows.length, columns: tools.columnsOf(out.rows), rows: out.rows, provenance };
  const a = await register({ ...base, kind: KIND_FOR_OP[node.op] || `analysis_${node.op}`, format: 'json', schemaJson: { type: node.op, columns: payload.columns || null }, provenance: { tool: node.op, sources, purpose: node.label }, payload });
  return { artifact_uuid: a.artifactUuid, storage_uri: a.storageUri, images: [] };
}

// Runs every node whose inputs are complete, up to the parallel limit, until nothing can run.
async function runGraph(nodes, state, ctx) {
  const pending = nodes.filter(n => !state.outputs[n.id] && !state.failed[n.id]);
  const running = new Map();
  const execute = async n => {
    const inputs = n.inputs.map(i => ({ id: i, output: state.outputs[i].output, artifact_uuid: state.outputs[i].artifact_uuid }));
    const t0 = Date.now();
    await ctx.log('node.start', { node: n.id, op: n.op, label: n.label, inputs: n.inputs, args: n.args }, n.id);
    try {
      const out = await runNode(n, inputs, ctx);
      const reg = await persistNode(n, out, inputs, ctx);
      state.outputs[n.id] = { output: out, meta: out.meta || null, artifact_uuid: reg.artifact_uuid, storage_uri: reg.storage_uri, images: reg.images, ms: Date.now() - t0 };
      state.artifacts.push({ artifact_uuid: reg.artifact_uuid, kind: KIND_FOR_OP[n.op] === 'gene_list' ? 'dataset' : n.op === 'chart' ? 'figure' : ['lookup', 'measure'].includes(n.op) ? 'measurement' : 'analysis', tool: n.op, summary: { node: n.id, label: n.label, row_count: out.rows ? out.rows.length : out.matrix ? out.matrix.row_labels.length : undefined }, storage_uri: reg.storage_uri });
      for (const img of reg.images) state.artifacts.push({ artifact_uuid: img.artifact_uuid, kind: 'figure', tool: 'chart', summary: { node: n.id, label: n.label, image: img.path }, storage_uri: img.path });
      // What the live view shows for a finished node: counts, a few columns and rows, the figure names.
      const sample = out.rows ? compactRows(out.rows.slice(0, 3)) : null;
      await ctx.log('node.done', {
        node: n.id, op: n.op, label: n.label, ms: Date.now() - t0, artifact_uuid: reg.artifact_uuid,
        rows: out.rows ? out.rows.length : undefined,
        columns: out.rows ? tools.columnsOf(out.rows).slice(0, 12) : undefined,
        sample: sample ? sample.lines.map(l => l.split(' | ')) : undefined,
        sample_columns: sample ? sample.columns : undefined,
        matrix: out.matrix ? [out.matrix.row_labels.length, out.matrix.col_labels.length] : undefined,
        images: reg.images.map(img => path.basename(img.path)),
        ...(out.meta?.search_url ? { search_url: out.meta.search_url, query: out.meta.query } : {}),
        ...(out.meta?.question ? { asked: out.meta.asked, found: out.meta.found } : {})
      }, n.id);
    } catch (err) {
      state.failed[n.id] = err.message;
      await ctx.log('node.failed', { node: n.id, op: n.op, label: n.label, error: err.message, ms: Date.now() - t0 }, n.id);
    }
  };
  while (pending.length || running.size) {
    for (const n of [...pending]) {
      if (running.size >= ctx.parallel) break;
      const failedInput = n.inputs.find(i => state.failed[i]);
      if (failedInput) { state.failed[n.id] = `blocked: input ${failedInput} failed`; pending.splice(pending.indexOf(n), 1); await ctx.log('node.blocked', { node: n.id, input: failedInput }, n.id); continue; }
      if (n.inputs.every(i => state.outputs[i])) {
        pending.splice(pending.indexOf(n), 1);
        const p = execute(n).finally(() => running.delete(n.id));
        running.set(n.id, p);
      }
    }
    if (!running.size) {
      for (const n of pending) { state.failed[n.id] = 'blocked: an input never completed'; await ctx.log('node.blocked', { node: n.id }, n.id); }
      break;
    }
    await Promise.race(running.values());
  }
}

// ---- what the model sees of the results ----------------------------------------------------------

function cell(v) {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > SAMPLE_CELL ? `${s.slice(0, SAMPLE_CELL)}…` : s;
}

function compactRows(rows) {
  const cols = tools.columnsOf(rows);
  const preferred = ['gene', 'ensembl', 'entity', 'value', 'answer', 'found', 'table', 'rank', 'count', 'mean', 'median', 'min', 'max', 'sum'];
  const shown = [...preferred.filter(c => cols.includes(c)), ...cols.filter(c => !preferred.includes(c))].slice(0, 12);
  const sampled = rows.length > FULL_ROWS;
  const pick = sampled ? rows.slice(0, SAMPLE_ROWS) : rows;
  return { columns: shown, lines: pick.map(r => shown.map(c => cell(r[c])).join(' | ')), sampled };
}

function outcomesText(state) {
  return state.nodes.map(n => {
    const o = state.outputs[n.id];
    const head = `[${n.id}] ${n.op} "${n.label}" inputs=${n.inputs.join(',') || 'none'} args=${JSON.stringify(n.args)}`;
    if (!o) return `${head}\n  FAILED: ${state.failed[n.id] || 'not run'}`;
    if (o.output.figure) return `${head}\n  figure rendered (${o.images.length} image): ${o.output.figure.type}, "${o.output.figure.title}"`;
    if (o.output.matrix) return `${head}\n  matrix ${o.output.matrix.row_labels.length} rows × ${o.output.matrix.col_labels.length} columns; rows: ${o.output.matrix.row_labels.slice(0, 12).join(', ')}${o.output.matrix.row_labels.length > 12 ? ', …' : ''}; columns: ${o.output.matrix.col_labels.slice(0, 12).join(', ')}${o.output.matrix.col_labels.length > 12 ? ', …' : ''}`;
    const rows = o.output.rows;
    const c = compactRows(rows);
    const meta = o.meta?.search_url ? `\n  query: ${o.meta.query}\n  url: ${o.meta.search_url}${o.meta.not_expressible?.length ? `\n  not expressible: ${o.meta.not_expressible.map(x => x.requirement).join('; ')}` : ''}` : o.meta?.question ? `\n  asked ${o.meta.asked} genes, ${o.meta.found} answered with a cited row` : '';
    const cols = tools.columnsOf(rows);
    return `${head}${meta}\n  ${rows.length} rows; columns: ${cols.slice(0, 30).join(', ')}${cols.length > 30 ? `, … (${cols.length})` : ''}\n  ${c.sampled ? `first ${SAMPLE_ROWS} rows` : 'all rows'} (${c.columns.join(' | ')}):\n  ${c.lines.join('\n  ') || '(none)'}`;
  }).join('\n\n');
}

// ---- the study -----------------------------------------------------------------------------------

async function asoStudy({ goal, allow_search = true, mode: requestedMode, parallel_limit }, ctx = {}) {
  const db = ctx.db;
  if (!db) throw new Error('The study agent requires db in context.');
  getActiveModel();
  const config = platformConfig();
  const parallel = Number(parallel_limit) > 0 ? Number(parallel_limit) : (config.asoParallelLimit || 3);
  const agentMode = await resolveAgentMode(requestedMode ?? 'offline', [FILES.master]);
  const mode = agentMode.mode;
  const startedAt = Date.now();
  const tokens = { prompt: 0, completion: 0, total: 0 };
  const stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, perStep: {} };
  // Agents report {prompt, completion, total} or {total: {prompt, completion, total}, steps}.
  const addTokens = t => {
    const c = t && typeof t.total === 'object' ? t.total : t;
    if (!c) return;
    tokens.prompt += Number(c.prompt) || 0; tokens.completion += Number(c.completion) || 0; tokens.total += Number(c.total) || 0;
  };

  const workspace = await createWorkspace(db, { visitorId: ctx.visitorId, inferenceModelId: getActiveModel().id, requestText: goal, planJson: { goal, mode, hpa_version: agentMode.hpaVersion, allow_search, parallel, version: 'study' } });
  inference.assignContext({ workspaceId: workspace.id });
  const logger = createLogger(workspace.logPath);
  const log = async (event, data, step) => {
    if (ctx.onStep) await ctx.onStep({ stage: event, label: event, message: typeof data === 'string' ? data : JSON.stringify(data), step });
    return logger.logEvent({ event, data, step });
  };
  const forward = prefix => s => log(`agent.${s.stage}`, { node: prefix, label: s.label, message: s.message }, prefix);
  const state = { nodes: [], outputs: {}, failed: {}, artifacts: [], cannot: [] };
  // Artifact rows of one workspace are written one at a time: parallel nodes registering at once
  // deadlock on the workspace's artifact counter.
  let registrations = Promise.resolve();
  const register = args => { const next = registrations.then(() => registerArtifact(db, args)); registrations = next.catch(() => {}); return next; };
  const repairArgs = async (node, args, missing, columns, sample) => {
    const user = `Operation: ${node.op}\nArguments: ${JSON.stringify(args)}\nMissing columns: ${missing.join(', ')}\nColumns the input has: ${columns.join(', ')}\nFirst rows: ${JSON.stringify(sample)}`;
    const fixed = await jsonCall(REPAIR_SYSTEM, user, ctx.onStep, 'repair', stats);
    const next = fixed && fixed.args && typeof fixed.args === 'object' ? fixed.args : args;
    await log('node.repair', { node: node.id, op: node.op, missing, columns: columns.slice(0, 20), args_before: args, args_after: next }, node.id);
    return next;
  };
  const nodeCtx = { db, workspace, mode, parallel, log, forward, addTokens, register, repairArgs };

  const finish = async (status, fields) => { await updateWorkspace(db, workspace.id, { status, finishedUnixMs: Date.now(), ...fields }); await logger.close(); };
  const graphSummary = () => state.nodes.map(n => ({ id: n.id, op: n.op, label: n.label, inputs: n.inputs, status: state.outputs[n.id] ? 'done' : state.failed[n.id] ? 'failed' : 'pending', rows: state.outputs[n.id]?.output?.rows?.length, artifact_uuid: state.outputs[n.id]?.artifact_uuid || null, error: state.failed[n.id] || null, ms: state.outputs[n.id]?.ms }));

  try {
    await log('start', { workspace_uuid: workspace.uuid, mode, hpa_version: agentMode.hpaVersion, parallel, allow_search });
    const [dataOverview, catalog] = await Promise.all([geneData.overview(), geneData.catalog()]);
    const system = planSystem(allow_search, dataOverview, searchAdapter.overview(), catalog.find(e => e.key === 'master'));

    // Plan: one call, one correction round if the graph is not valid.
    await log('plan.start', { goal });
    let plan = await jsonCall(system, `Goal: ${goal}`, ctx.onStep, 'plan', stats);
    let checked = validateNodes(plan.nodes, [], allow_search);
    if (checked.errors.length) {
      await log('plan.invalid', { errors: checked.errors });
      plan = await jsonCall(system, `Goal: ${goal}\n\nYour previous plan had these problems; return a corrected plan:\n- ${checked.errors.join('\n- ')}\n\nPrevious plan:\n${JSON.stringify(plan)}`, ctx.onStep, 'plan', stats);
      checked = validateNodes(plan.nodes, [], allow_search);
      if (checked.errors.length) throw new Error(`The plan is not valid: ${checked.errors.join('; ')}`);
    }
    if (!checked.nodes.length) throw new Error(plan.cannot?.length ? `Nothing in the goal can be expressed: ${plan.cannot.map(c => c.requirement).join('; ')}` : 'The plan has no nodes.');
    state.nodes.push(...checked.nodes);
    state.cannot = Array.isArray(plan.cannot) ? plan.cannot : [];
    await updateWorkspace(db, workspace.id, { status: 'running', planJson: { goal, mode, hpa_version: agentMode.hpaVersion, allow_search, parallel, version: 'study', understanding: plan.understanding, graph: graphSummary(), cannot: state.cannot } });
    await log('plan.graph', { understanding: plan.understanding, nodes: state.nodes.map(n => ({ id: n.id, op: n.op, label: n.label, inputs: n.inputs, why: n.why, args: n.args })), cannot: state.cannot });
    await runGraph(state.nodes, state, nodeCtx);

    // Reflect: the model may add nodes after seeing the results, a bounded number of times.
    for (let round = 1; round <= MAX_REFLECTIONS; round++) {
      await log('reflect.start', { round });
      const review = await jsonCall(system + REFLECT_SUFFIX, `Goal: ${goal}\n\nGraph and outcomes so far:\n${outcomesText(state)}`, ctx.onStep, 'reflect', stats);
      const added = validateNodes(review.nodes || [], state.nodes.map(n => n.id), allow_search);
      await log('reflect', { round, done: review.done === true, assessment: review.assessment, added: added.nodes.map(n => ({ id: n.id, op: n.op, label: n.label, inputs: n.inputs, why: n.why, args: n.args })), errors: added.errors });
      if (review.done === true || !added.nodes.length) break;
      if (added.errors.length) { const bad = new Set(added.errors.map(e => e.split(':')[0])); added.nodes = added.nodes.filter(n => !bad.has(n.id) && n.inputs.every(i => state.outputs[i] || state.failed[i] || added.nodes.some(m => m.id === i))); }
      if (!added.nodes.length) break;
      state.nodes.push(...added.nodes);
      await runGraph(added.nodes, state, nodeCtx);
    }

    // Report: the model writes from node outcomes and cites nodes; code adds figures and the node table.
    await log('report.start', { nodes: state.nodes.length });
    const rep = await jsonCall(REPORT_SYSTEM, `Goal: ${goal}\n\nNodes:\n${outcomesText(state)}${state.cannot.length ? `\n\nNot expressible: ${state.cannot.map(c => `${c.requirement} (${c.why || ''})`).join('; ')}` : ''}`, ctx.onStep, 'report', stats);
    const title = String(rep.title || 'Study report').slice(0, 120);
    const images = state.nodes.flatMap(n => (state.outputs[n.id]?.images || []).map(img => ({ node: n.id, label: n.label, path: img.path })));
    const nodeTable = ['| node | operation | label | rows | status | time |', '|---|---|---|---|---|---|', ...graphSummary().map(n => `| ${n.id} | ${n.op} | ${n.label} | ${n.rows ?? ''} | ${n.status}${n.error ? `: ${n.error}` : ''} | ${n.ms ? `${(n.ms / 1000).toFixed(1)}s` : ''} |`)];
    const reportMd = [`# ${title}`, '', `**Goal:** ${goal}`, '', `**Workspace:** ${workspace.uuid}`, '', String(rep.report_md || ''), '',
      ...(images.length ? ['## Figures', '', ...images.map(i => `**${i.node}** ${i.label}\n\n![${i.label}](artifacts/${path.basename(i.path)})\n`)] : []),
      '## Graph', '', ...nodeTable, ''].join('\n');
    const reportPath = path.join(workspace.workspaceDir, 'report.md');
    await fs.writeFile(reportPath, reportMd, { mode: 0o600 });
    const reportArtifact = await register({ workspaceId: workspace.id, artifactsDir: workspace.artifactsDir, kind: 'summary', format: 'md', schemaJson: { type: 'report' },
      provenance: { tool: 'report', sources: state.nodes.map(n => state.outputs[n.id]?.artifact_uuid).filter(Boolean), purpose: title }, payload: null, storageUriOverride: reportPath, skipWrite: true });
    state.artifacts.push({ artifact_uuid: reportArtifact.artifactUuid, kind: 'summary', tool: 'report', summary: { report: reportPath, title }, storage_uri: reportPath });
    await log('report.written', { title, report_md: reportMd, artifact_uuid: reportArtifact.artifactUuid });

    addTokens({ prompt: stats.promptTokens, completion: stats.completionTokens, total: stats.totalTokens });
    const seconds = (Date.now() - startedAt) / 1000;
    await log('final', { title, nodes: state.nodes.length, failed: Object.keys(state.failed).length, seconds, tokens, study_calls: stats.perStep });
    await updateWorkspace(db, workspace.id, { planJson: { goal, mode, hpa_version: agentMode.hpaVersion, allow_search, parallel, version: 'study', understanding: plan.understanding, graph: graphSummary(), cannot: state.cannot } });
    await finish('completed', {});
    return { status: 'ok', workspace_uuid: workspace.uuid, title, summary: reportMd, summary_md: reportMd, report_uri: reportPath, artifacts: state.artifacts, nodes: graphSummary(), not_expressible: state.cannot, tokens, seconds, mode, hpa_version: agentMode.hpaVersion };
  } catch (err) {
    await log('error', { message: err.message });
    addTokens({ prompt: stats.promptTokens, completion: stats.completionTokens, total: stats.totalTokens });
    await finish('failed', { errorCode: 'study_failed', errorMessage: err.message });
    return { status: 'error', error: err.message, workspace_uuid: workspace.uuid, nodes: graphSummary(), tokens };
  }
}

module.exports = asoStudy;
