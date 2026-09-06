'use strict';

/**
 * The study loop (aso_hpa). One model, one desk, one loop.
 *
 * Every turn the model sees its whole working set, rebuilt from state: the goal, the plan, every
 * table it opened, every artifact (columns and two rows), what is running, its own history and
 * notes. It calls tools: the agents the chat offers (from the orchestrator), the registered table
 * operations, plan/note/open/run/skip and finish. Every tool result is an artifact linked to its
 * inputs; an agent that returns wakes the loop. The report is bound to the data: tables and
 * figures by id, findings as claims tied to the rows they rest on. The model never carries values.
 * Nothing about the database is written here: its name, entity and tables come from the adapter.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const { inference, getActiveModel } = require('../../inference/gateway');
const { platformConfig } = require('../../policy/config');
const tools = require('../aso/studyTools');
const { TABLE_OPERATIONS, executeTableOperation, THEN_BY } = require('../aso/tableOperations');
const geneData = require('../../hpa/geneDataAdapter');
const { createWorkspace, updateWorkspace } = require('../aso/workspaceStore');
const { registerArtifact } = require('../aso/artifactStore');
const { createLogger } = require('../aso/logger');
const { renderCharts } = require('../aso/pipelines/renderCharts');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { localData, FILES } = require('../../hpa/localData');
const { validate, executeBatch, ARGUMENTS_SCHEMA } = require('../aso/batchOperations');
const { decodeArguments } = require('../aso/toolArguments');
const studyPlan = require('../aso/studyPlan');
const { FINISH_SCHEMA, reportIssues, renderReport } = require('../aso/studyReport');
const { selectFigures } = require('../aso/reportFigures');
const desk = require('../aso/desk');

const MAX_STALLS = 2;             // turns in a row with nothing to do before the loop ends
const WAKE_DEBOUNCE_MS = 300;     // completions this close together wake the loop once
const JOB_WAIT_MS = 15 * 60_000;  // longest the loop waits for a running agent
const MAX_HELD_ROWS = 5000000;    // rows held in memory at once; streaming tools have no limit
const VIEW_ROWS = 10;             // rows an open shows by default

// ---- tools of the study itself ---------------------------------------------------------------------

const A = { type: 'string', description: 'artifact id, or a dataset name', 'x-artifact-reference': true };
const S = { type: 'string' };
const N = { type: 'integer' };
const tool = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'object', properties, required } });
const STUDY_TOOLS = [
  tool('plan', 'The deliverables the study owes: one item per requested table, figure (its chart type), cohort (gene_set) or interpretation. Replaces the plan.', { items: { type: 'array', items: { type: 'object', properties: { step: S, kind: { type: 'string', enum: studyPlan.KINDS } }, required: ['step', 'kind'] } } }, ['items']),
  tool('note', 'Keep a decision or open question on the desk; replace overwrites note N.', { text: S, replace: N }, ['text']),
  tool('open', 'Show rows of a large artifact (rows and offset page it, columns narrow it), or put a dataset on the desk with its columns, values and sample rows.', { what: { type: 'string', description: 'artifact id or dataset name' }, rows: N, offset: N, columns: { type: 'array', items: S } }),
  tool('run', 'Run dependent operations together; a step names an operation and its args, and refers to an earlier step as @id.', { steps: { type: 'array', items: { type: 'object', properties: { id: S, tool: S, args: ARGUMENTS_SCHEMA }, required: ['id', 'tool', 'args'] } } }, ['steps']),
  tool('combine', 'Rows of a and b as one table: union (either, one row per entity), intersect (rows of a whose entity is in b), difference (rows of a whose entity is not in b) or concat (all rows of a, then all of b). on matches by a column instead of the entity.', { a: A, b: A, how: { type: 'string', enum: ['union', 'intersect', 'difference', 'concat'] }, on: S }, ['a', 'b', 'how']),
  TABLE_OPERATIONS.get('join'),
  TABLE_OPERATIONS.get('filter'),
  TABLE_OPERATIONS.get('select'),
  TABLE_OPERATIONS.get('rank'),
  tool('top_per_group', 'The n highest (or lowest) rows of by per group; group_by defaults to the entity. Works on a whole dataset.', { artifact: A, group_by: S, by: S, n: N, order: { type: 'string', enum: ['desc', 'asc'] }, ties: { type: 'string', enum: ['include', 'truncate'] }, then_by: THEN_BY }, ['artifact', 'by']),
  TABLE_OPERATIONS.get('aggregate'),
  TABLE_OPERATIONS.get('classify'),
  TABLE_OPERATIONS.get('compute'),
  TABLE_OPERATIONS.get('fill_missing'),
  tool('pivot', 'A matrix for a heatmap: rows from row, columns from column, cells from value (aggregate duplicates first).', { artifact: A, row: S, column: S, value: S }, ['artifact', 'column', 'value']),
  tool('chart', 'Draw an artifact. Bar family: x labels, y values, group for series (grouped_bar needs it). scatter/bubble: numeric x and y, label names points, group colours them. heatmap takes a pivot. missing=omit skips rows with a missing number.', { artifact: A, type: { type: 'string', enum: studyPlan.CHART_KINDS }, x: S, y: S, group: S, size: S, label: S, title: S, x_label: S, y_label: S, missing: { type: 'string', enum: ['error', 'omit'] } }, ['artifact', 'type']),
  TABLE_OPERATIONS.get('correlate'),
  tool('overlap', 'Entities a and b share against a universe (artifact or dataset): shared, expected, fold, hypergeometric p; group_by tests each group of a.', { a: A, b: A, universe: A, on: S, group_by: S }, ['a', 'b', 'universe']),
  tool('standardize', 'Add a rescaled copy of a numeric column: zscore, minmax or percentile.', { artifact: A, column: S, method: { type: 'string', enum: ['zscore', 'minmax', 'percentile'] }, as: S }, ['artifact', 'column', 'method']),
  tool('explode', 'One row per item of a list cell; "key: number" items become <as>_key and <as>_value, "label (number)" <as>_label and <as>_value, others <as>_item.', { artifact: A, column: S, as: S }, ['artifact', 'column']),
  tool('skip', 'Nothing to do until a running agent returns.', { reason: S }, ['reason']),
  tool('finish', 'Deliver the report: tables and figures by id, findings as claims bound to their cells, limitations, not_done.', FINISH_SCHEMA)
];
const TABLE_TOOLS = new Set(['combine', 'join', 'filter', 'select', 'rank', 'top_per_group', 'aggregate', 'classify', 'compute', 'fill_missing', 'pivot', 'chart', 'correlate', 'overlap', 'standardize', 'explode']);
const SYNC_TOOLS = new Set(['plan', 'note', 'open', 'skip', 'finish']);

function systemPrompt(db, datasets, agentNames) {
  const entity = db.entity;
  const search = agentNames.includes('deep_research_hpa') ? 'deep_research_hpa' : 'the search agent';
  return `You run a study over the ${db.database} for a scientist. Agents and operations produce every value; you choose what to ask and how to combine the results. ${search} finds the ${entity}s matching a description (a cohort). investigator_hpa takes a list (genes=[names], gene=<name> or from=<artifact id>) and a complete question (fields, row filters, units), finds the tables that hold the answer and fetches the raw records for the whole list at once, returning tables. The operations compute over saved tables. Every result is an artifact with an id (a1, a2, …); the artifacts are the evidence of the study, and the report cites them by id.

The desk in the message is your whole working set and stays in front of you every turn: the plan, the tables you opened, every artifact with its columns and rows (whole with row indices up to ${desk.WHOLE_ROWS} rows; larger ones show two rows and what each column holds), what is running, your history and your notes. open shows more rows of a large artifact, or puts a dataset on the desk with its columns and values.

How a study goes:
1. plan lists the deliverables, one item per requested table, figure of a given type, cohort or interpretation; independent work starts in the same turn.
2. Cohorts come from ${search}, records from investigator_hpa; their tables are used as they are.
3. Operations compute on artifact ids, and a dataset name can stand in for an artifact. Dependent steps chain in one run call with @id references (pivot then heatmap; filter, rank, chart); independent calls go in the same turn.
4. finish delivers the report from the data: tables and figures by id, and findings as claims, each bound to the rows and columns it rests on. The report prints those cells beside the claim, so every number a claim states is among them or was computed into an artifact the claim cites. Limitations state what the evidence cannot establish, in words. A plan item that cannot be delivered goes in not_done with the reason.
Values are reported as recorded: units, zeros, blanks, repeated rows and ties. A missing record is absence from this source.

DATASETS ON DISK (open one for its columns and values; investigator_hpa reads them for a supplied list)
${datasets.join(', ')}`;
}

// ---- data access for the operations -----------------------------------------------------------------

// Entity keys for a row read straight from a dataset, so set operations and joins work.
function geneKeys(entry, row) {
  const isEnsembl = v => /^ENSG\d{5,}$/.test(String(v || ''));
  if (entry.key === 'name') return { gene: row[entry.columns[0]] || null, ensembl: row[entry.columns[1]] || null };
  const column = entry.geneColumn || entry.columns.find(c => isEnsembl(row[c]));
  const name = row['Gene name'] ?? (isEnsembl(row.Gene) ? null : row.Gene) ?? null;
  return { gene: name || null, ensembl: column ? row[column] || null : null };
}

// The dataset columns that hold the entity keys, as geneKeys reads them, lower-cased.
function keyColumns(entry) {
  const names = ['gene', 'ensembl'];
  if (entry.key === 'name') names.push(entry.columns[0], entry.columns[1]);
  else if (entry.key === 'ensembl') names.push(entry.columns[0]);
  else if (entry.geneColumn) names.push(entry.geneColumn);
  for (const c of entry.columns) if (/^gene( name)?$/i.test(c)) names.push(c);
  return new Set(names.filter(Boolean).map(c => String(c).toLowerCase()));
}

// The entities a filter pins with = or in on a key column, so they can be read by index
// instead of streaming the whole table; null when no clause pins the key.
function pinnedEntities(entry, where) {
  const keys = keyColumns(entry);
  for (const clause of Array.isArray(where) ? where : []) {
    if (!clause || !['=', 'in'].includes(clause.op) || !keys.has(String(clause.column || '').toLowerCase())) continue;
    const listed = clause.op === 'in' ? tools.inList(clause.value) : clause.value;
    const values = Array.isArray(listed) ? listed : [listed];
    if (values.every(v => typeof v === 'string' || typeof v === 'number')) return values.map(String);
  }
  return null;
}

async function* datasetStream(entry) {
  for await (const row of localData.rows(entry.file)) yield { ...geneKeys(entry, row), ...row };
}

// A dataset used where an artifact goes. Entity-level files come whole; a per-entity file comes
// restricted to the entities of the other input, filtered while it streams, or whole when it fits.
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
    if (out.length > MAX_HELD_ROWS) throw new Error(`${entry.file} has more than ${MAX_HELD_ROWS} rows, more than fits in memory at once: filter, aggregate or top_per_group stream it, or use it with an artifact (join, intersect, difference) so only those entities are read`);
  }
  return out;
}

function normalizeSearchRow(r) {
  const out = { gene: r.Gene ?? r.gene ?? null, ensembl: r.Ensembl ?? r.ensembl ?? null };
  for (const [k, v] of Object.entries(r)) {
    if (['Gene', 'Ensembl', 'gene', 'ensembl'].includes(k)) continue;
    out[k] = v === null || v === undefined || v === 'NA' || String(v).trim() === '' ? null : v;
  }
  return out;
}

function scalarRow(obj) {
  const row = {};
  for (const [k, v] of Object.entries(obj || {})) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) row[k] = v;
  return row;
}

// What a non-bulk agent result becomes: rows for a cohort or an answer, text for a lookup.
function agentArtifact(toolName, args, result) {
  if (toolName === 'deep_research_hpa') {
    if (result?.status !== 'ok') {
      const error = new Error(result?.error || 'search failed');
      error.details = { stop_reason: result?.stop_reason, unresolved_requirements: result?.result?.unresolved_requirements };
      throw error;
    }
    const r = result.result || {};
    return { kind: 'data', label: String(args.goal || 'search').slice(0, 80), rows: (r.rows || []).map(normalizeSearchRow), meta: { search_url: r.search_urls?.[0] || null, query: r.plan || null, not_expressible: (r.not_expressible || []).map(c => c.requirement), mode: r.mode || null, hpa_version: r.hpa_version, source_files: r.source_files } };
  }
  if (toolName === 'investigator_hpa') {
    if (result?.error && result.found !== true) throw new Error(result.error);
    return { kind: 'answer', label: `${result.gene || args.gene}: ${String(args.question || '').slice(0, 60)}`, rows: [{ gene: result.gene || args.gene, ensembl: result.ensembl || null, question: args.question || '', found: result.found === true, answer: result.answer || '', value: result.extracted_value ?? null, entity: result.exact_label ?? null, table: result.source_section || null, cited_row: result.cited_row || null }], meta: { not_in_release: result.not_in_release || [], notes: result.notes || [], citations: result.citations || [], grounded: result.grounded, evidence_status: result.evidence_status } };
  }
  if (toolName === 'check_inclusion_hpa') return { kind: 'answer', label: `${args.gene} in search result?`, rows: [scalarRow(result)], meta: {} };
  const text = [result?.summary_md, result?.summary, result?.answer, result?.message, result?.content, result?.text].find(v => typeof v === 'string' && v.trim()) || JSON.stringify(scalarRow(result));
  return { kind: 'note', label: String(args.topic || args.question || toolName).slice(0, 80), rows: [], text: String(text), meta: { images: Array.isArray(result?.images) ? result.images.length : 0 } };
}

// ---- the loop --------------------------------------------------------------------------------------

async function asoStudy({ goal, mode: requestedMode, max_turns, reasoning_effort }, ctx = {}) {
  const effort = reasoning_effort || ctx.reasoning_effort || null;
  const db = ctx.db;
  if (!db) throw new Error('The study requires db in context.');
  getActiveModel();
  const orchestrator = require('../orchestrator'); // at call time: the orchestrator requires this module too
  const config = platformConfig();
  const maxTurns = max_turns === undefined ? config.asoMaxSteps : max_turns;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('The caller or platform must provide a positive integer study turn allowance');
  const parallel = config.asoParallelLimit || 3;
  const agentMode = await resolveAgentMode(requestedMode ?? 'offline', [FILES.master]);
  const mode = agentMode.mode;
  const identity = geneData.identity();
  const startedAt = Date.now();
  const tokens = { prompt: 0, completion: 0, total: 0 };
  const mainTokens = { prompt: 0, completion: 0, total: 0, calls: 0 };
  const specialistTokens = {};
  const addSpecialistUsage = (name, usage, calls) => {
    if (usage === undefined) return;
    const stats = typeof usage.total === 'object' ? usage.total : usage;
    for (const key of ['prompt', 'completion', 'total']) if (!Number.isFinite(stats[key]) || stats[key] < 0) throw new Error(`${name} returned invalid token accounting for ${key}`);
    const sum = specialistTokens[name] || (specialistTokens[name] = { prompt: 0, completion: 0, total: 0, calls: 0 });
    for (const key of ['prompt', 'completion', 'total']) { sum[key] += stats[key]; tokens[key] += stats[key]; }
    sum.calls += Number(calls) || (usage.steps ? Object.keys(usage.steps).length : 0);
  };
  const addUsage = usage => {
    const p = usage?.prompt_tokens || 0, c = usage?.completion_tokens || 0;
    mainTokens.prompt += p; mainTokens.completion += c; mainTokens.total += p + c; mainTokens.calls++;
    tokens.prompt += p; tokens.completion += c; tokens.total += p + c;
  };

  const workspace = await createWorkspace(db, { visitorId: ctx.visitorId, inferenceModelId: getActiveModel().id, requestText: goal, planJson: { goal, mode, hpa_version: agentMode.hpaVersion, version: 'desk-study' } });
  inference.assignContext({ workspaceId: workspace.id });
  const logger = createLogger(workspace.logPath);
  const log = async (event, data, step) => {
    if (ctx.onStep) await ctx.onStep({ stage: event, label: event, message: typeof data === 'string' ? data : JSON.stringify(data), step });
    return logger.logEvent({ event, data, step });
  };
  let registrations = Promise.resolve();
  const register = args => { const next = registrations.then(() => registerArtifact(db, args)); registrations = next.catch(() => {}); return next; };

  const state = { goal, plan: [], artifacts: [], byId: new Map(), running: new Map(), notes: [], history: [], opened: new Map(), views: new Map(), turn: 0, toolCalls: 0, failed: 0, ids: { a: 0, t: 0 } };
  const remember = text => state.history.push(`turn ${state.turn}: ${text}`);

  const catalog = (await geneData.catalog()).filter(e => e.key !== 'unreadable');
  // The study's agents are the ones that return evidence: a cohort or records. Agents that
  // answer in prose about the database (definitions, membership) belong to the chat.
  const agentSpecs = orchestrator.getToolSpecs().filter(t => !['aso_hpa', 'dictionary_expert_hpa', 'check_inclusion_hpa'].includes(t.function.name)).map(t => {
    const properties = { ...t.function.parameters.properties };
    delete properties.mode;
    t = { ...t, function: { ...t.function, parameters: { ...t.function.parameters, properties } } };
    if (t.function.name !== 'investigator_hpa') return t;
    return { ...t, function: { ...t.function, description: `Raw records for a list of ${identity.entity}s: pass genes=[names] or from=<artifact id> and the complete question (which fields, which rows, units). It finds the tables and fetches every ${identity.entity} at once, returning tables; gene=<name> for a single ${identity.entity}.`, parameters: { ...t.function.parameters, required: [], properties: {
      ...t.function.parameters.properties,
      genes: { type: 'array', items: S, description: `Supplied ${identity.entity} names` },
      from: { type: 'string', description: `Artifact id whose rows supply the ${identity.entity}s` }
    } } } };
  });
  const agentNames = new Set(agentSpecs.map(t => t.function.name));
  const toolSpecs = [...agentSpecs, ...STUDY_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))];
  const system = systemPrompt(identity, catalog.map(e => e.file), [...agentNames]);

  const get = id => {
    const key = String(id || '').trim();
    const a = state.byId.get(key);
    if (!a) throw new Error(`no artifact "${id}" (have ${state.artifacts.map(x => x.id).join(', ') || 'none'})`);
    return a;
  };
  const origin = a => `${a.tool}${a.toolId ? ` ${a.toolId}` : ''}${a.tool === 'chart' ? `(${desk.argsLine(a.args, 120)})` : agentNames.has(a.tool) ? ` "${String(a.args.question || a.args.goal || a.args.topic || '').slice(0, 90)}"` : a.inputs?.length ? ` of ${a.inputs.join(', ')}` : ''}`;

  // Stores a tool's output as an artifact, linked to the artifacts it read.
  async function addArtifact({ kind, label, rows, matrix, text, tool: toolName, args, inputs, meta, figure, toolId, columns: suppliedColumns }) {
    const id = `a${++state.ids.a}`;
    const sources = inputs.map(i => state.byId.get(i)?.uuid).filter(Boolean);
    const base = { workspaceId: workspace.id, artifactsDir: workspace.artifactsDir };
    let reg;
    const images = [];
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
      const artifactKind = kind === 'answer' ? 'answer' : kind === 'note' ? 'note' : toolName === 'deep_research_hpa' ? 'gene_list' : toolName === 'investigator_hpa' ? 'measurement' : `analysis_${toolName}`;
      const payload = matrix
        ? { node_id: id, op: toolName, label, args, row_count: matrix.row_labels.length, column_count: matrix.col_labels.length, ...matrix, provenance: { tool: toolName, purpose: label, sources, ...(meta || {}) } }
        : { node_id: id, op: toolName, label, args, row_count: rows ? rows.length : 0, columns, rows: rows || [], text: text || undefined, provenance: { tool: toolName, purpose: label, sources, ...(meta || {}) } };
      reg = await register({ ...base, kind: artifactKind, format: 'json', schemaJson: { type: toolName, columns }, provenance: { tool: toolName, sources, purpose: label }, payload });
    }
    const columns = suppliedColumns || (rows ? tools.columnsOf(rows) : []);
    const size = kind === 'figure' ? 'figure' : matrix ? `${matrix.row_labels.length} × ${matrix.col_labels.length} matrix` : kind === 'note' ? 'note' : `${rows.length} rows`;
    const a = { id, uuid: reg.artifactUuid, storageUri: reg.storageUri, kind, label, size, rows: rows || null, matrix: matrix || null, figure: figure || null, text: text || null, columns, tool: toolName, args, inputs, meta: meta || {}, images, toolId, turn: state.turn };
    state.artifacts.push(a);
    state.byId.set(id, a);
    return a;
  }

  const artifactEvent = a => ({ id: a.id, kind: a.kind, label: a.label, size: a.size, rows: a.rows ? a.rows.length : undefined, columns: a.columns.slice(0, 12), sample: a.rows ? desk.sampleLines(a.rows, a.columns.slice(0, 7), 3).map(l => l.split(' | ')) : undefined, sample_columns: a.columns.slice(0, 7), text: a.text ? a.text.slice(0, 600) : undefined, images: a.images, artifact_uuid: a.uuid, search_url: a.meta?.search_url, query: a.meta?.query, inputs: a.inputs });
  const artifactsSummary = () => state.artifacts.map(a => ({ artifact_uuid: a.uuid, kind: a.kind === 'figure' ? 'figure' : a.kind === 'note' ? 'inspection' : a.kind === 'answer' ? 'measurement' : 'dataset', tool: a.tool, summary: { id: a.id, label: a.label, row_count: a.rows?.length }, storage_uri: a.storageUri }));

  const wake = { resolve: null };
  const wakeUp = () => { if (wake.resolve) { const r = wake.resolve; wake.resolve = null; r(); } };
  const waitForCompletion = () => new Promise(resolve => {
    const timer = setTimeout(resolve, JOB_WAIT_MS);
    wake.resolve = () => { clearTimeout(timer); setTimeout(resolve, WAKE_DEBOUNCE_MS); };
  });

  // An agent runs in the background through the orchestrator, exactly as a chat message would.
  // The same question is asked once: an identical call points at the earlier job instead.
  const agentJobs = new Map();
  function startAgent(toolName, args) {
    if (args.mode !== undefined && args.mode !== mode) throw new Error(`Delegated agents use the study data source: ${mode}`);
    const executionArgs = { ...args, mode };
    const inputs = [];
    // One entity is a list of one: the investigator returns tables either way.
    if (toolName === 'investigator_hpa' && args.gene !== undefined && args.genes === undefined && args.from === undefined) { executionArgs.genes = [String(args.gene)]; delete executionArgs.gene; }
    if (toolName === 'investigator_hpa' && args.from !== undefined) {
      if (args.gene !== undefined || args.genes !== undefined) throw new Error('Use one of gene, genes or from');
      const input = get(args.from);
      if (!Array.isArray(input.rows) || !input.rows.length) throw new Error(`${args.from} has no rows to investigate`);
      const genes = [...new Set(input.rows.map(row => row.ensembl || row.gene).filter(Boolean))];
      if (!genes.length) throw new Error(`${args.from} has no ${identity.entity} identifiers (columns ${identity.keys.join(', ')})`);
      inputs.push(input.id);
      delete executionArgs.from;
      executionArgs.genes = genes;
    }
    if (toolName === 'investigator_hpa' && args.gene === undefined && args.genes === undefined && args.from === undefined) throw new Error('investigator_hpa needs gene, genes or from');
    const fingerprint = JSON.stringify([toolName, executionArgs]).toLowerCase();
    const earlier = agentJobs.get(fingerprint);
    if (earlier) {
      remember(earlier.made ? `${toolName}(${desk.argsLine(args, 140)}) was already asked as ${earlier.id}: its result is ${earlier.made.join(', ')}` : `${toolName}(${desk.argsLine(args, 140)}) is already running as ${earlier.id}`);
      return false;
    }
    const id = `t${++state.ids.t}`;
    const job = { id, tool: toolName, args, startedAt: Date.now(), kind: 'agent', made: null };
    agentJobs.set(fingerprint, job);
    state.running.set(id, job);
    state.toolCalls++;
    state.agentStarts = (state.agentStarts || 0) + 1;
    const label = String(args.goal || args.question || args.topic || args.gene || toolName).slice(0, 80);
    log('tool.start', { id, tool: toolName, kind: 'agent', label, args, inputs }, id);
    const forward = async s => log(`agent.${s.stage}`, { id, label: s.label, message: s.message }, id);
    job.promise = orchestrator.execute(toolName, executionArgs, { db, visitorId: ctx.visitorId, rawQuery: '', includeRows: true, onStep: forward, reasoningEffort: effort, runControl: ctx.runControl, signal: ctx.signal, cacheKey: workspace.uuid, maxTurns })
      .then(async ({ result }) => {
        addSpecialistUsage(toolName, result?.tokens, result?.calls);
        const made = [];
        if (result?.bulk) {
          if (!result.tables?.length) throw new Error(result.error || result.note || 'Investigator returned no table');
          for (const table of result.tables) {
            const a = await addArtifact({ kind: 'data', label: table.name, rows: table.rows, columns: table.columns, tool: toolName, args, inputs, toolId: id, meta: { lookups: [table.args], coverage: table.coverage, source_file: table.source_file, source_files: [table.source_file], status: result.status, hpa_version: result.hpa_version } });
            made.push(a);
          }
          remember(`${id} ${toolName} done → ${made.map(a => `${a.id} (${a.size})`).join(', ')}${result.note ? `. Investigator note: ${result.note}` : ''}${result.unresolved?.length ? `. Not in the release: ${result.unresolved.slice(0, 10).join(', ')}` : ''}`);
        } else {
          const a = await addArtifact({ ...agentArtifact(toolName, args, result), tool: toolName, args, inputs, toolId: id });
          made.push(a);
          // A search that ran the same query as an earlier one says so: rewording the goal changed nothing.
          const twin = a.meta.query ? state.artifacts.find(x => x !== a && x.meta?.query === a.meta.query) : null;
          const extra = toolName === 'deep_research_hpa' ? ` query: ${String(a.meta.query || '').slice(0, 160)}${a.meta.not_expressible?.length ? `; could not express: ${a.meta.not_expressible.join('; ')}` : ''}${twin ? `; the same query as ${twin.id}${(twin.rows?.length || 0) === a.rows.length ? ', the same cohort' : ''}` : ''}` : a.kind === 'answer' ? ` answer: ${String(a.rows[0]?.answer || '').slice(0, 200)}` : '';
          remember(`${id} ${toolName} done → ${a.id} (${a.size})${extra}`);
        }
        job.made = made.map(a => a.id);
        for (const a of made) await log('tool.done', { id, tool: toolName, kind: 'agent', artifact: artifactEvent(a), ms: Date.now() - job.startedAt }, id);
      })
      .catch(async err => {
        agentJobs.delete(fingerprint);
        state.failed++;
        remember(`${id} ${toolName} failed: ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ''}`);
        await log('tool.failed', { id, tool: toolName, kind: 'agent', error: err.message, details: err.details, ms: Date.now() - job.startedAt }, id);
      })
      .finally(() => { state.running.delete(id); wakeUp(); });
    return true;
  }

  // One table operation: inputs resolved (artifacts, datasets, streams), the operation applied.
  async function computeOut(toolName, args) {
    const inputColumns = new Set(), inputRefs = new Set();
    let streamed = false;
    const rowsOf = async (key, other = null) => {
      const ref = String(args[key] ?? '').trim();
      if (state.byId.has(ref)) {
        const a = get(ref);
        inputRefs.add(a.id);
        if (a.matrix) throw new Error(`${a.id} is a matrix; only a heatmap chart can take it`);
        if (!a.rows) throw new Error(`${a.id} has no rows`);
        for (const c of a.columns) inputColumns.add(c);
        return tools.withColumns([...a.rows], a.columns);
      }
      const entry = ref ? await geneData.entry(ref) : null;
      if (!entry || entry.key === 'unreadable') throw new Error(`nothing called "${ref || '(no name)'}" among the artifacts (${[...state.byId.keys()].join(', ') || 'none'}) or the datasets on disk`);
      inputRefs.add(entry.file);
      const otherRef = other ? String(args[other] ?? '').trim() : '';
      if (otherRef && state.byId.has(otherRef)) inputRefs.add(otherRef);
      const genes = otherRef && state.byId.has(otherRef) ? get(otherRef).rows || null : null;
      // A filter that pins the entity key reads those entities by index; the rest of its clauses apply in memory.
      const pinned = toolName === 'filter' && !genes && ['ensembl', 'name'].includes(entry.key) ? pinnedEntities(entry, args.where) : null;
      const rows = pinned
        ? await datasetRows(entry, { genes: (await geneData.resolveGenes(pinned)).filter(Boolean), limit: parallel })
        : await datasetRows(entry, { genes, where: toolName === 'filter' ? args.where : null, limit: parallel });
      streamed = toolName === 'filter' && !genes && !pinned && !['master', 'lookup', 'scan'].includes(entry.key);
      for (const c of ['gene', 'ensembl', ...entry.columns]) inputColumns.add(c);
      return tools.withColumns(rows, [...inputColumns]);
    };
    const wholeDataset = async key => {
      const ref = String(args[key] ?? '').trim();
      if (!ref || state.byId.has(ref)) return null;
      const entry = await geneData.entry(ref);
      if (!entry || !['ensembl', 'name', 'scan', 'stream'].includes(entry.key)) return null;
      inputRefs.add(entry.file);
      for (const c of ['gene', 'ensembl', ...entry.columns]) inputColumns.add(c);
      return entry;
    };
    let out;
    switch (toolName) {
      case 'combine': {
        if (!['union', 'intersect', 'difference', 'concat'].includes(args.how)) throw new Error('combine: how is union, intersect, difference or concat');
        out = { rows: tools.setOp(args.how, await rowsOf('a', 'b'), await rowsOf('b', 'a'), args.on || null) }; break;
      }
      case 'join': out = executeTableOperation(toolName, args, { a: await rowsOf('a', 'b'), b: await rowsOf('b', 'a') }); break;
      case 'filter': { const rows = await rowsOf('artifact'); out = executeTableOperation(toolName, streamed ? { ...args, where: [] } : args, { artifact: rows }); break; }
      case 'select': case 'classify': case 'compute': case 'fill_missing': case 'correlate': case 'rank': out = executeTableOperation(toolName, args, { artifact: await rowsOf('artifact') }); break;
      case 'top_per_group': { const entry = await wholeDataset('artifact'); out = { rows: entry ? await tools.topPerGroupStream(datasetStream(entry), args, ['gene', 'ensembl', ...entry.columns]) : tools.topPerGroup(await rowsOf('artifact'), args) }; break; }
      case 'aggregate': {
        const entry = await wholeDataset('artifact');
        if (entry) out = { rows: await tools.aggregateStream(datasetStream(entry), args, ['gene', 'ensembl', ...entry.columns]) };
        else out = executeTableOperation(toolName, args, { artifact: await rowsOf('artifact') });
        break;
      }
      case 'overlap': out = { rows: tools.overlap(await rowsOf('a', 'b'), await rowsOf('b', 'a'), await rowsOf('universe'), args.on || null, args.group_by || null) }; break;
      case 'standardize': out = { rows: tools.standardize(await rowsOf('artifact'), args) }; break;
      case 'explode': out = { rows: tools.explode(await rowsOf('artifact'), args.column, args.as) }; break;
      case 'pivot': out = { matrix: tools.pivot(await rowsOf('artifact'), args) }; break;
      case 'chart': { const a = get(args.artifact); inputRefs.add(a.id); out = { figure: tools.chartSpec(args, a.matrix || a.rows) }; break; }
      default: throw new Error(`unknown operation ${toolName}`);
    }
    return { out, inputColumns, inputs: [...inputRefs] };
  }

  const made = new Map();   // fingerprint of an operation → the artifact it made
  async function runTableTool(toolName, args) {
    args = { ...args };
    if (['combine', 'join', 'overlap'].includes(toolName) && args.a === undefined && args.artifact !== undefined) args = { ...args, a: args.artifact };
    // The same operation on the same inputs is the same artifact; it is not made twice.
    const key = JSON.stringify([toolName, args]);
    if (made.has(key) && state.byId.has(made.get(key))) {
      const a = get(made.get(key));
      remember(`${toolName}(${desk.argsLine(args, 140)}) is ${a.id}, already made at turn ${a.turn}`);
      return { ok: true, artifact: a, repeated: true };
    }
    const id = `t${++state.ids.t}`;
    const t0 = Date.now();
    state.toolCalls++;
    let inputs = ['artifact', 'a', 'b', 'universe'].map(k => args[k]).filter(Boolean).map(String);
    const label = toolName === 'chart' ? String(args.title || `${args.type} chart`).slice(0, 80) : `${toolName}(${desk.argsLine(args, 100)})`;
    await log('tool.start', { id, tool: toolName, kind: toolName === 'chart' ? 'chart' : 'tool', label, args, inputs }, id);
    try {
      const { out, inputColumns, inputs: resolvedInputs } = await computeOut(toolName, args);
      inputs = resolvedInputs;
      if (out.rows) out.rows = tools.freshFirst(out.rows, [...inputColumns]);
      const a = await addArtifact({ kind: out.figure ? 'figure' : 'data', label: toolName === 'chart' ? label : `${toolName} of ${inputs.join(', ')}`, rows: out.rows, matrix: out.matrix, figure: out.figure, meta: out.figure ? { omitted_rows: out.figure.omitted_rows || 0 } : out.meta, tool: toolName, args, inputs, toolId: id });
      made.set(key, a.id);
      remember(`${toolName}(${desk.argsLine(args, 140)}) → ${a.id} (${a.size}${a.kind === 'figure' && !a.images.length ? ', not rendered' : ''})`);
      await log('tool.done', { id, tool: toolName, kind: out.figure ? 'chart' : 'tool', artifact: artifactEvent(a), ms: Date.now() - t0 }, id);
      return { ok: true, artifact: a };
    } catch (err) {
      state.failed++;
      remember(`${toolName}(${desk.argsLine(args, 140)}) failed: ${err.message}`);
      await log('tool.failed', { id, tool: toolName, kind: toolName === 'chart' ? 'chart' : 'tool', error: err.message, ms: Date.now() - t0 }, id);
      return { ok: false, error: err.message };
    }
  }

  // A view stays on the desk whole for two turns, then folds to its receipt (reopenable).
  const view = (key, text, receipt) => { state.views.set(key, { text, receipt, turn: state.turn }); };
  async function openWhat(args) {
    const what = String(args.what ?? args.artifact ?? args.id ?? args.dataset ?? args.name ?? args.table ?? '').trim();
    if (!what) throw new Error('open needs what: an artifact id or a dataset name');
    if (state.byId.has(what)) {
      const a = get(what);
      if (a.figure) { view(a.id, `${a.id} figure: ${JSON.stringify(a.figure).slice(0, 1200)}`, `${a.id} figure spec (opened at turn ${state.turn})`); remember(`opened ${a.id} (figure spec on the desk)`); return; }
      if (a.matrix) { view(a.id, `${a.id} matrix rows ${a.matrix.row_labels.join(', ')}; columns ${a.matrix.col_labels.join(', ')}\n${a.matrix.matrix.slice(0, 40).map((row, i) => `  ${desk.cell(a.matrix.row_labels[i])}: ${row.map(v => v === null ? '—' : v).join(' | ')}`).join('\n')}${a.matrix.matrix.length > 40 ? '\n  …' : ''}`, `${a.id} matrix (opened at turn ${state.turn})`); remember(`opened ${a.id} (matrix on the desk)`); return; }
      if (a.text) { view(a.id, `${a.id}: ${a.text.slice(0, 1500)}`, `${a.id} text (opened at turn ${state.turn})`); remember(`opened ${a.id}`); return; }
      const rows = Number.isSafeInteger(args.rows) && args.rows > 0 ? args.rows : VIEW_ROWS;
      const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
      const columns = Array.isArray(args.columns) && args.columns.length ? args.columns.map(c => { const found = a.columns.find(x => x === c) || a.columns.find(x => x.toLowerCase() === String(c).toLowerCase()); if (!found) throw new Error(`${a.id} has no column ${JSON.stringify(c)}; its columns: ${a.columns.join(', ')}`); return found; }) : a.columns;
      const page = a.rows.slice(offset, offset + rows);
      const lines = page.map((row, i) => `  ${offset + i}: ${desk.rowLine(row, columns)}`);
      const range = `rows ${offset}–${offset + page.length - 1} of ${a.rows.length}`;
      view(`${a.id}|${offset}|${columns.join(',')}`, `${a.id} ${range} (${columns.join(' | ')})\n${lines.join('\n') || '  (no rows)'}${offset + page.length < a.rows.length ? `\n  … open ${a.id} offset=${offset + page.length} for more` : ''}`, `${a.id} ${range} (opened at turn ${state.turn}; open again to see them)`);
      remember(`opened ${a.id} ${range} (view on the desk)`);
      return;
    }
    const entry = await geneData.entry(what);
    if (!entry || entry.key === 'unreadable') throw new Error(`nothing called ${JSON.stringify(what)} among the artifacts or the datasets on disk`);
    // Columns asked for are detailed on the card and the rest are named; opened without columns,
    // the table is detailed whole. Later opens add columns to the card.
    const wanted = Array.isArray(args.columns) && args.columns.length ? args.columns.map(c => { const found = entry.columns.find(x => x === c) || entry.columns.find(x => x.toLowerCase() === String(c).toLowerCase()); if (!found) throw new Error(`${entry.file} has no column ${JSON.stringify(c)}; its columns: ${entry.columns.join(', ')}`); return found; }) : null;
    const opened = state.opened.get(entry.file);
    if (opened) {
      const added = (wanted || []).filter(c => !opened.focus.includes(c));
      if (!added.length && (wanted || opened.whole)) { remember(`${entry.file} is already on the desk${wanted ? ' with those columns' : ' whole'}`); return; }
      opened.focus.push(...added);
      if (!wanted) opened.whole = true;
      remember(wanted ? `${entry.file}: added ${added.join(', ')} to its card` : `${entry.file}: its card now details every column`);
      return;
    }
    const [profiled, sample] = await Promise.all([geneData.profile(entry), geneData.sample(entry, 3)]);
    state.opened.set(entry.file, { entry, profile: profiled.columns, sample, scanned: profiled.rows, capped: profiled.capped, focus: wanted || [], whole: !wanted });
    remember(`opened ${entry.file} (on the desk${wanted ? `: ${wanted.join(', ')}` : ''})`);
  }
  const openedCards = () => [...state.opened.values()].map(o => desk.tableCard({ name: o.entry.file, title: o.entry.title, description: o.entry.description, access: geneData.access(o.entry), columns: o.entry.columns, profile: o.profile, sample: o.sample, scanned: o.scanned, capped: o.capped, focus: o.focus, whole: o.whole }));
  // Column names an operation's arguments mention, shown first on its card.
  const argColumns = a => {
    const names = new Set(a.columns || []), found = [];
    const walk = v => { if (typeof v === 'string') { if (names.has(v) && !found.includes(v)) found.push(v); } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(a.args || {});
    return found;
  };

  // What a large table's columns hold, computed once per artifact.
  const profileOf = a => {
    if (a.profile === undefined) a.profile = Array.isArray(a.rows) && a.rows.length > desk.WHOLE_ROWS ? tools.profile(a.rows, a.columns) : null;
    return a.profile;
  };
  function deskText(turn) {
    const running = [...state.running.values()].map(j => `${j.id} ${j.tool} "${String(j.args.goal || j.args.question || j.args.gene || '').slice(0, 100)}" ${Math.round((Date.now() - j.startedAt) / 1000)} s`).join('\n') || '(nothing running)';
    // The frontier (artifacts nothing has read yet) shows whole or sampled; a consumed table folds
    // to one line unless it is small enough that folding would cost a turn to reopen; consumed
    // tables that no frontier artifact read directly are filed together on one line.
    const usedBy = new Map();
    for (const a of state.artifacts) for (const input of a.inputs || []) { if (!usedBy.has(input)) usedBy.set(input, []); usedBy.get(input).push(a.id); }
    const near = new Set(state.artifacts.filter(a => !usedBy.has(a.id)).flatMap(a => a.inputs || []));
    const filed = state.artifacts.filter(a => usedBy.has(a.id) && !near.has(a.id) && (a.rows ? a.rows.length : 0) > desk.SMALL_ROWS);
    const cards = state.artifacts.filter(a => !filed.includes(a)).map(a => desk.resultCard({ id: a.id, label: a.kind === 'answer' || a.kind === 'note' ? a.label : '', origin: origin(a), rows: a.rows || [], columns: a.columns, matrix: a.matrix, figure: a.figure, images: a.images, text: a.text, folded: usedBy.has(a.id) && (a.rows ? a.rows.length : 0) > desk.SMALL_ROWS ? usedBy.get(a.id) : null, profile: usedBy.has(a.id) ? null : profileOf(a), first: [...identity.keys, ...argColumns(a)] }));
    if (filed.length) cards.push(`filed (read by later operations; open by id): ${filed.map(a => `${a.id} (${desk.count(a.rows.length)} rows) ← ${a.tool}`).join('; ')}`);
    // A view is something the model asked to see; it stays on the desk for the whole study.
    const views = [...state.views.values()].map(v => v.text);
    const sections = [
      desk.section('STUDY', goal),
      desk.section('PLAN', studyPlan.planText(state.plan)),
      ...(state.opened.size ? [desk.section('TABLES OPENED', openedCards().join('\n'))] : []),
      desk.section('ARTIFACTS', cards.join('\n') || '(none yet)'),
      ...(views.length ? [desk.section('VIEWS', views.join('\n'))] : []),
      desk.section('RUNNING', running),
      desk.section('HISTORY', desk.historyText(state.history)),
      ...(state.notes.length ? [desk.section('NOTES', state.notes.map((n, i) => `${i + 1}. ${n}`).join('\n'))] : []),
      `TURN ${turn}/${maxTurns}${turn === maxTurns ? ' (last turn: finish now with what exists, listing the rest in not_done)' : ''}`
    ];
    return sections.join('\n\n');
  }

  let report = null, reportFigures, stopReason = null;
  const refusals = new Set();
  let turn = 0, stalls = 0;
  try {
    await log('start', { workspace_uuid: workspace.uuid, mode, hpa_version: agentMode.hpaVersion, model: getActiveModel().configKey, goal });
    await updateWorkspace(db, workspace.id, { status: 'running' });
    while (turn < maxTurns) {
      turn++;
      state.turn = turn;
      // The last turn can only report; skip exists only while an agent is running.
      const offered = turn === maxTurns ? toolSpecs.filter(t => ['finish', 'note'].includes(t.function.name)) : toolSpecs.filter(t => t.function.name !== 'skip' || state.running.size);
      const user = deskText(turn);
      const request = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], tools: offered, temperature: 0, prompt_cache: { key: `study ${workspace.uuid}` }, ...(effort ? { reasoning_effort: effort } : {}) };
      const contextDir = path.join(workspace.workspaceDir, 'context');
      await fs.mkdir(contextDir, { recursive: true });
      const stem = path.join(contextDir, `turn-${String(turn).padStart(2, '0')}`);
      await fs.writeFile(`${stem}.txt`, user, { mode: 0o600 });
      await fs.writeFile(`${stem}.request.json`, JSON.stringify(request), { mode: 0o600 });
      await log('context', { turn, desk_bytes: Buffer.byteLength(user), system_bytes: Buffer.byteLength(system), tool_schema_bytes: Buffer.byteLength(JSON.stringify(offered)) });
      const res = await inference.chat.completions.create(request);
      await fs.writeFile(`${stem}.response.json`, JSON.stringify(res), { mode: 0o600 });
      addUsage(res.usage);
      const message = res.choices?.[0]?.message || {};
      const calls = (message.tool_calls || []).map((c, i) => {
        try {
          const args = JSON.parse(c.function.arguments || '{}');
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
          return { id: c.id || `study_${turn}_${i}`, name: c.function.name, args };
        } catch (err) { return { id: c.id || `study_${turn}_${i}`, name: c.function?.name, args: {}, error: err.message }; }
      });
      await log('turn', { turn, text: message.content ? String(message.content).slice(0, 600) : null, calls: calls.map(c => ({ tool: c.name, args: c.args })), offered: offered.length });
      if (message.content && !calls.length) remember(`said: ${String(message.content).slice(0, 300)}`);
      let waiting = false, sync = 0, started = 0;
      async function executeCall(call) {
        if (call.error) throw new Error(`invalid arguments: ${call.error}`);
        const spec = offered.find(t => t.function.name === call.name);
        if (!spec) throw new Error(`no tool ${call.name}`);
        call.args = decodeArguments(call.args, spec.function.parameters, call.name);
        validate(call.args, spec.function.parameters, call.name);
        if (call.name === 'plan') {
          state.plan = (call.args.items || []).map(studyPlan.createItem);
          if (!state.plan.length) throw new Error('plan needs at least one deliverable');
          sync++; remember(`plan: ${state.plan.length} deliverables`);
          await log('plan', { items: state.plan }); return;
        }
        if (call.name === 'note') {
          const text = String(call.args.text || '').trim();
          const at = Number(call.args.replace) || 0;
          if (at >= 1 && at <= state.notes.length) { if (text) state.notes[at - 1] = text; else state.notes.splice(at - 1, 1); remember(text ? `rewrote note ${at}` : `removed note ${at}`); }
          else if (text) { state.notes.push(text); remember(`noted: ${text.slice(0, 120)}`); }
          sync++; await log('note', { text, replace: at || undefined }); return;
        }
        if (call.name === 'skip') { waiting = true; remember(`waited: ${String(call.args.reason || '').slice(0, 100)}`); await log('skip', { reason: call.args.reason || '' }); return; }
        if (call.name === 'open') { await openWhat(call.args); sync++; return; }
        if (call.name === 'run') {
          const specifications = new Map(toolSpecs.filter(t => TABLE_TOOLS.has(t.function.name)).map(t => [t.function.name, t.function]));
          const steps = call.args.steps || [];
          const batch = await executeBatch({ steps, outputs: steps.map(s => s?.id).filter(id => typeof id === 'string') }, { specifications, concurrency: parallel, execute: runTableTool, external: id => (state.byId.has(id) ? id : null) });
          if (batch.status !== 'completed') remember(`run: ${batch.steps.filter(s => s.status !== 'done').map(s => `${s.id} ${s.status}${s.error ? `: ${s.error}` : ''}`).join('; ')}`);
          sync++; return;
        }
        if (call.name === 'finish') {
          if (!state.plan.length) throw new Error('finish needs a plan first: record the deliverables with plan');
          if (state.running.size) { remember(`finish refused: ${[...state.running.keys()].join(', ')} still running; wait for them (skip) or finish after they return`); await log('finish.refused', { reason: 'agents_running', running: [...state.running.keys()] }); sync++; return; }
          const args = call.args;
          const issues = reportIssues(args, state);
          let figures = [];
          if (!issues.length) {
            figures = selectFigures(state.artifacts, args.figures).filter(a => a.images?.length);
            const missing = studyPlan.uncovered(state.plan, { tables: args.tables || [], figures, claims: args.claims || [], notDone: args.not_done || [] }, state.byId);
            if (missing.length) issues.push(`plan items not delivered and not in not_done: ${missing.join('; ')}. Deliver them (a figure of the requested type, a table, a claim), or list them in not_done with the reason`);
          }
          if (issues.length) {
            const key = JSON.stringify(issues);
            await log('finish.refused', { issues });
            if (refusals.has(key)) { stopReason = 'unresolved_finish'; remember(`finish refused again for the same reasons; the study stops`); return; }
            refusals.add(key);
            remember(`finish refused:\n${issues.map(i => `    - ${i}`).join('\n')}`);
            sync++; return;
          }
          report = renderReport(args, state, figures);
          reportFigures = args.figures === undefined ? undefined : figures.map(a => a.id);
          for (const p of state.plan) p.status = (args.not_done || []).some(item => item.item === state.plan.indexOf(p) + 1) ? 'dropped' : 'done';
          await log('plan', { items: state.plan });
          return;
        }
        if (TABLE_TOOLS.has(call.name)) { await runTableTool(call.name, call.args); sync++; return; }
        if (agentNames.has(call.name)) { if (startAgent(call.name, call.args)) started++; else sync++; return; }
        throw new Error(`no tool ${call.name}`);
      }
      const guarded = async call => {
        try { await executeCall(call); }
        catch (error) { state.failed++; remember(`${call.name}(${desk.argsLine(call.args, 140)}) failed: ${error.message}`); await log('call.failed', { tool: call.name, error: error.message, turn }); sync++; }
      };
      // Sync tools are ordered barriers; operations and agents run together up to the parallel limit.
      let batch = [];
      const drain = async () => { if (batch.length) await Promise.all(batch.map(guarded)); batch = []; };
      for (const call of calls) {
        if (SYNC_TOOLS.has(call.name)) { await drain(); await guarded(call); }
        else { batch.push(call); if (batch.length >= parallel) await drain(); }
      }
      await drain();
      if (report !== null || stopReason) break;
      if (!calls.length) {
        stalls++;
        remember('no tool was called; call tools, skip while agents run, or finish');
        if (stalls > MAX_STALLS) break;
        continue;
      }
      // An agent still running holds the next decision: the loop wakes when the first one returns,
      // so no turn is spent looking at an unchanged desk.
      if (state.running.size) { stalls = 0; await waitForCompletion(); continue; }
      if (sync === 0 && started === 0 && !waiting) { stalls++; remember('that turn did no work: summon agents, run operations, or finish'); if (stalls > MAX_STALLS) break; continue; }
      if (waiting) { stalls++; remember('nothing is running, so there is nothing to wait for: act or finish'); if (stalls > MAX_STALLS) break; continue; }
      stalls = 0;
    }
    if (state.running.size) await Promise.allSettled([...state.running.values()].map(job => job.promise));
    const budgetExhausted = report === null && turn >= maxTurns && !stopReason;
    const incompleteReason = stopReason || (budgetExhausted ? 'turn_budget_exhausted' : report === null ? 'stalled' : state.plan.some(p => p.status === 'dropped') ? 'undelivered_items' : null);
    const outcome = incompleteReason ? 'incomplete' : 'completed';
    const summary = report !== null ? report : budgetExhausted
      ? `The study stopped at its budget of ${maxTurns} turns before it finished. No report was written; the plan shows what was done and what was not, and the artifacts hold everything it made.`
      : `The study stopped before a report was accepted${stopReason ? ` (${stopReason})` : ''}. Completed artifacts are retained; no rejected report was accepted.`;
    const seconds = (Date.now() - startedAt) / 1000;
    const reportArtifacts = reportFigures === undefined ? state.artifacts : [...state.artifacts.filter(artifact => artifact.kind !== 'figure'), ...selectFigures(state.artifacts, reportFigures)];
    const summaryMd = [`# Study`, '', `**Goal:** ${goal}`, '', summary, '', '## Artifacts', '', ...reportArtifacts.map(a => `- ${a.id} ${a.kind} "${a.label}" (${a.size}) from ${a.tool}${a.inputs.length ? ` of ${a.inputs.join(', ')}` : ''}`), '', '## Plan', '', ...state.plan.map((p, i) => `${i + 1}. [${p.status}] ${p.text}`)].join('\n');
    const reportPath = path.join(workspace.workspaceDir, 'report.md');
    await fs.writeFile(reportPath, summaryMd, { mode: 0o600 });
    await register({ workspaceId: workspace.id, artifactsDir: workspace.artifactsDir, kind: 'summary', format: 'md', schemaJson: { type: 'report', ...(reportFigures === undefined ? {} : { figures: reportFigures }) }, provenance: { tool: 'report', sources: reportArtifacts.map(a => a.uuid), purpose: 'Study report' }, payload: null, storageUriOverride: reportPath, skipWrite: true });
    await log('finish', { summary, outcome, incomplete_reason: incompleteReason, turns: turn, tool_calls: state.toolCalls, failed: state.failed, artifacts: state.artifacts.length, seconds, tokens, budget_exhausted: budgetExhausted });
    await updateWorkspace(db, workspace.id, { status: 'completed', message: outcome === 'completed' ? 'Study completed' : `Study incomplete: ${incompleteReason}`, finishedUnixMs: Date.now(), planJson: { goal, mode, hpa_version: agentMode.hpaVersion, version: 'desk-study', outcome, incomplete_reason: incompleteReason, plan: state.plan, turns: turn } });
    await logger.close();
    return { status: 'ok', outcome, incomplete_reason: incompleteReason, workspace_uuid: workspace.uuid, summary, summary_md: summaryMd, artifacts: artifactsSummary(), ...(reportFigures === undefined ? {} : { report_figures: reportFigures }), plan: state.plan, turns: turn, tool_calls: state.toolCalls, failed: state.failed, budget_exhausted: budgetExhausted, tokens, token_breakdown: { aso_hpa: mainTokens, ...specialistTokens }, agents: state.agentStarts || 0, seconds, mode, hpa_version: agentMode.hpaVersion };
  } catch (err) {
    if (state.running.size) await Promise.allSettled([...state.running.values()].map(job => job.promise));
    await log('error', { message: err.message });
    await updateWorkspace(db, workspace.id, { status: 'failed', finishedUnixMs: Date.now(), errorCode: 'study_failed', errorMessage: err.message });
    await logger.close();
    return { status: 'error', error: err.message, workspace_uuid: workspace.uuid, artifacts: artifactsSummary(), tokens };
  }
}

module.exports = asoStudy;
