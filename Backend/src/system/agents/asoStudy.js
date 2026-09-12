'use strict';

/**
 * The study loop (aso_hpa). One model, one desk, one loop.
 *
 * Every turn the model sees its whole working set, rebuilt from state: the goal, the plan, every
 * artifact as one line (id, title, columns, size, what made it; its rows when there are only a
 * few), the rows it asked to see, what is running, its own history and notes. It calls tools:
 * the agents (from the orchestrator), the table operations over artifacts, plan/note/open/run/
 * skip and finish. Every result is an artifact linked to its inputs and named by the model with
 * a title and a description; an agent that returns wakes the loop. The report is bound to the
 * data: tables and figures by id, findings as claims tied to the rows they rest on. The model
 * never carries values and never reads a file: sets of entities come from the search agent, rows
 * from the Investigator. Nothing about the database is written here: its name and entity come
 * from the adapter.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const { inference, getActiveModel } = require('../../inference/gateway');
const { jsonCall } = require('../../inference/jsonCall');
const { platformConfig } = require('../../policy/config');
const tools = require('../aso/studyTools');
const { TABLE_OPERATIONS, executeTableOperation, A } = require('../aso/tableOperations');
const geneData = require('../../hpa/geneDataAdapter');

// The recorded values whose names contain a word of the text (four letters or more, the longest
// words first), as "column: value (table)", at most eight: what the atlas calls the thing the
// text names.
async function atlasValuesFor(text) {
  if (typeof geneData.findValues !== 'function') return [];
  const words = [...new Set(String(text).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [])].sort((a, b) => b.length - a.length).slice(0, 8);
  const lines = [];
  for (const word of words) {
    for (const hit of await geneData.findValues(word)) {
      for (const value of hit.values) {
        const line = `${hit.column}: ${value} (${hit.file})`;
        if (!lines.includes(line)) lines.push(line);
        if (lines.length >= 8) return lines;
      }
    }
  }
  return lines;
}
const { createWorkspace, updateWorkspace } = require('../aso/workspaceStore');
const { registerArtifact } = require('../aso/artifactStore');
const { createLogger } = require('../aso/logger');
const { renderCharts } = require('../aso/pipelines/renderCharts');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');
const { validate, executeBatch, ARGUMENTS_SCHEMA } = require('../aso/batchOperations');
const { decodeArguments } = require('../aso/toolArguments');
const studyPlan = require('../aso/studyPlan');
const { FINISH_SCHEMA, reportIssues, renderReport } = require('../aso/studyReport');
const { selectFigures } = require('../aso/reportFigures');
const desk = require('../aso/desk');

const MAX_STALLS = 2;             // turns in a row with nothing to do before the loop ends
const WAKE_DEBOUNCE_MS = 300;     // completions this close together wake the loop once
const JOB_WAIT_MS = 15 * 60_000;  // longest the loop waits for a running agent
const VIEW_ROWS = 10;             // rows an open shows by default

// ---- tools of the study itself ---------------------------------------------------------------------

const S = { type: 'string' };
const N = { type: 'integer' };
const SCALE = { type: 'string', enum: ['linear', 'log'] };
const tool = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'object', properties, required } });
// An operation names its result for a reader: a title and a description.
// Every operation names its result (title, description); one left unnamed is named by its operation.
const op = (name, description, properties = {}, required = []) => tool(name, description, { title: S, description: S, ...properties }, required);
const STUDY_TOOLS = [
  tool('plan', 'The deliverables the study owes: one item per requested table, figure (its chart type), cohort (gene_set) or interpretation. Replaces the plan.', { items: { type: 'array', items: { type: 'object', properties: { step: S, kind: { type: 'string', enum: studyPlan.KINDS } }, required: ['step', 'kind'] } } }, ['items']),
  tool('note', 'Keep a decision or open question on the desk; replace overwrites note N.', { text: S, replace: N }, ['text']),
  tool('open', 'Show rows of an artifact: rows and offset page it, columns narrow it.', { artifact: A, rows: N, offset: N, columns: { type: 'array', items: S } }, ['artifact']),
  tool('run', 'Runs operations: a chain of steps, each {id, tool: an operation from the list, args}, later steps naming earlier ones as @id (an existing artifact by its own id); one artifact per step, every step in the trail.',{ steps: { type: 'array', items: { type: 'object', properties: { id: S, tool: S, args: ARGUMENTS_SCHEMA }, required: ['id', 'tool', 'args'] } } }, ['steps']),
  op('combine', 'Rows of a and b as one table: concat (every row of a, then every row of b; label names a column that says which input each row came from, by its title, so stacked cohorts stay told apart), intersect (rows of a whose entity is in b) or difference (rows of a whose entity is not in b). on matches by a column instead of the entity. One row per entity across both tables is concat then distinct.', { a: A, b: A, how: { type: 'string', enum: ['concat', 'intersect', 'difference'] }, on: S, label: S }, ['a', 'b', 'how']),
  TABLE_OPERATIONS.get('join'),
  TABLE_OPERATIONS.get('filter'),
  TABLE_OPERATIONS.get('select'),
  TABLE_OPERATIONS.get('rank'),
  TABLE_OPERATIONS.get('aggregate'),
  TABLE_OPERATIONS.get('classify'),
  TABLE_OPERATIONS.get('compute'),
  op('pivot', 'A matrix for a heatmap: rows from row, columns from column, cells from value (aggregate duplicates first).', { artifact: A, row: S, column: S, value: S }, ['artifact', 'column', 'value']),
  op('chart', 'Draw an artifact; the title is the figure title. Bar family: x labels, y values; series come from group (a column of series names) or series (several value columns, one series each); grouped_bar needs one of them. scatter/bubble: numeric x and y, label names points (a blank label leaves a point unnamed; labels are drawn where they fit beside their points), group colours them. heatmap takes a pivot. Values spanning orders of magnitude (expression) read on a log scale: x_scale, y_scale for axes, scale for heatmap cells. missing=omit skips rows with a missing number.', { artifact: A, type: { type: 'string', enum: studyPlan.CHART_KINDS }, x: S, y: S, series: { type: 'array', items: S }, group: S, size: S, label: S, x_label: S, y_label: S, x_scale: SCALE, y_scale: SCALE, scale: SCALE, missing: { type: 'string', enum: ['error', 'omit'] } }, ['artifact', 'type']),
  TABLE_OPERATIONS.get('correlate'),
  op('overlap', 'Entities a and b share, against every entity of the database or a universe artifact: shared, expected, fold, hypergeometric p; group_by tests each group of a.', { a: A, b: A, universe: A, on: S, group_by: S }, ['a', 'b']),
  op('explode', 'One row per item of a list cell; "key: number" items become <as>_key and <as>_value, "label (number)" <as>_label and <as>_value, others <as>_item.', { artifact: A, column: S, as: S }, ['artifact', 'column']),
  tool('skip', 'Nothing to do until a running agent returns.', { reason: S }, ['reason']),
  tool('finish', 'Deliver the report: tables and figures by id, findings as claims bound to their cells, limitations, not_done.', FINISH_SCHEMA)
];
const TABLE_TOOLS = new Set(['combine', 'join', 'filter', 'select', 'rank', 'aggregate', 'classify', 'compute', 'pivot', 'chart', 'correlate', 'overlap', 'explode']);

// The operations as one line each, read off their own schemas: name, arguments (a list as
// name[], a choice as name=a|b, an object by its keys), then what the operation does. This is
// what the study reads instead of one JSON schema per operation on every turn; a step of run
// is still checked against the full schema, and a wrong argument is answered with the schema's
// own message.
function argumentLine(name, schema) {
  if (!schema || typeof schema !== 'object') return name;
  if (schema.enum) return `${name}=${schema.enum.join('|')}`;
  if (schema.type === 'array') {
    const item = schema.items || {};
    if (item.enum) return `${name}[]=${item.enum.join('|')}`;
    if (item.type === 'object' && item.properties) return `${name}[{${Object.entries(item.properties).map(([k, v]) => argumentLine(k, v)).join(', ')}}]`;
    return `${name}[]`;
  }
  if (schema.type === 'object' && schema.properties) return `${name}{${Object.entries(schema.properties).map(([k, v]) => argumentLine(k, v)).join(', ')}}`;
  return name;
}
// What each operation does, in one clause; the arguments come from the schema. The filter clause
// shape and its operators are written once, above the list.
const BRIEF = {
  combine: 'one table from a and b: concat every row of both (label names a column saying which input a row came from), intersect or difference by entity, or by a column with on',
  join: 'rows of a and b side by side, matched on the entity keys, on one column (on) or several (on_columns), left=right when the sides name it differently; a shared column that agrees is kept once, one that differs comes from b as name_2',
  filter: 'keep the rows where every where clause holds and, when any is given, one any clause holds; a value is a value: matching another artifact is join',
  select: 'keep or rename columns, add label columns; entity keys stay',
  rank: 'sort by a column and add rank; top keeps the first n (ties at the edge kept unless ties=truncate); group_by ranks within groups',
  aggregate: 'summarise a column over all rows or per group; a statistic is named metric_column, count is rows, recorded is cells with a value; group_domains lists expected groups so empty ones show 0',
  classify: 'add a category column: the first rule whose where holds gives its value, else otherwise',
  compute: 'add a column from an expression over columns and numbers: + - * / ( ) log2 log10 ln abs sqrt exp min max, + also joins text; if(condition, then, else) with < <= > >= = != and or not; contains(column, "text") for text and list cells',
  pivot: 'a matrix for a heatmap: rows from row, columns from column, cells from value (aggregate duplicates first)',
  chart: 'a figure: bars take x labels and y values, series from group (a column of names) or series[] (value columns); scatter and bubble take numeric x and y, label, group, size; heatmap takes a pivot; x_scale, y_scale, scale log for wide-ranging values; missing=omit skips rows without a number',
  correlate: 'Pearson or Spearman correlation of x and y: r, p_value, n; group_by gives one row per group',
  overlap: 'the entities a and b share, tested against every entity of the database or a universe artifact: shared, expected, fold, hypergeometric p; group_by tests each group of a',
  explode: 'one row per item of a list cell: "key: number" items become as_key and as_value, "label (number)" as_label and as_value, others as_item'
};
function operationsReference(tools) {
  const ops = tools.find(t => t.name === 'filter').parameters.properties.where.items.properties.op.enum;
  const clause = `where and any are lists of clauses {column, op, value} (column_b compares two columns); op is one of ${ops.join(' ')}; in takes a list as value`;
  const lines = tools.filter(t => TABLE_TOOLS.has(t.name)).map(t => {
    const props = Object.entries(t.parameters.properties).filter(([k]) => !['title', 'description'].includes(k));
    const required = new Set(t.parameters.required || []);
    const arg = (k, v) => ['where', 'any'].includes(k) ? k : k === 'rules' ? 'rules[{where, value}]' : argumentLine(k, v);
    return `${t.name}(${props.map(([k, v]) => `${arg(k, v)}${required.has(k) ? '' : '?'}`).join(', ')}): ${BRIEF[t.name] || t.description}`;
  });
  return `${clause}\n${lines.join('\n')}`;
}
const SYNC_TOOLS = new Set(['plan', 'note', 'open', 'skip', 'finish']);

// The arguments of a call without the name it gives its result.
const bare = args => { const { title, description, ...rest } = args || {}; return rest; };

function systemPrompt(db, agentNames) {
  const entity = db.entity;
  const search = agentNames.includes('deep_research_hpa') ? 'deep_research_hpa' : 'the search agent';
  return `You run a study over the ${db.database} for a scientist. The agents and the operations produce every value; you choose what to ask and how to combine the results, and you never read a file. ${search} finds the ${entity}s matching a description in words, the way the ${db.database} search would, and returns them as a table. investigator_hpa answers a question with rows: for a list of points (points=[…], one or hundreds, ${entity}s or any values such as tissues; or from=<artifact id> and column) it returns every point with the fields asked for, and without a list every row the question selects; fields that live in different source tables come back as one artifact each, and join combines them. The search selects by the atlas's categories; anything that is a row of a table (a partner, a sample, a measurement, a p-value) is the Investigator's, and a set the search cannot express is asked of the Investigator in plain language. The operations compute over artifacts. Every result is an artifact with an id (a1, a2, …), a title and a description; the artifacts are the evidence of the study, and the report cites them by id.

The desk in the message is your whole working set and stays in front of you every turn: the plan, every artifact as one line (id, title, columns, rows, what made it; a result of a few rows whole, with row indices), the rows you asked to see, what is running, your history and your notes. open shows rows of an artifact when a decision or a claim needs them; select narrows columns.

Read the question as one study: what it says about how a thing is measured, in which cohort, scope or release, holds for every part of the question unless the question says otherwise.

How a study goes:
1. plan lists the deliverables, one item per requested table, figure of a given type, cohort or interpretation; independent work starts in the same turn.
2. A set of ${entity}s comes from ${search}; its rows come from investigator_hpa with from=<that artifact's id> and the question. Both run in the background and return tables that are used as they are.
3. Operations run as steps of run, written as chains: every step whose inputs are known goes in one run call, later steps naming earlier ones as @id (explode, then aggregate the counts, then the chart; filter, then rank, then the table), each step named with a title and a description a reader understands. One run per analysis, one turn; a run of one step is only for a step whose next step needs its result seen first. Independent chains go in the same turn. The operations and their arguments are listed below.
4. finish delivers the report from the data: tables and figures by id, and findings as claims, each bound to the rows and columns it rests on. The report prints those cells beside the claim, so every number a claim states is among them or was computed into an artifact the claim cites. Limitations state what the evidence cannot establish, in words. A plan item that cannot be delivered goes in not_done with the reason.
Values are reported as recorded: units, zeros, blanks, repeated rows and ties. A missing record is absence from this source.`;
}

// ---- what agents return -----------------------------------------------------------------------------

// A found set is its members, by identity. What else holds of them is a question for the Investigator.
function normalizeSearchRow(r, context = []) {
  return { gene: r.Gene ?? r.gene ?? null, ensembl: r.Ensembl ?? r.ensembl ?? null, ...Object.fromEntries(context.map(c => [c, r[c] ?? null])) };
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
    // The search's own account of its selection travels with the result: each requirement, the
    // field and value it chose, and why. The controller and the review read it; a choice among
    // fields, or of a narrower category than asked, is visible instead of buried in the agent's log.
    const trail = (r.trail || []).map(f => `${f.requirement} → ${f.field}${Array.isArray(f.path) && f.path.length ? `: ${f.path.join(' / ')}` : ''}${f.operator === 'NOT' ? ' (excluded)' : ''}${f.why ? ` — ${String(f.why).replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''}`);
    // A search over a two-level field with no value named returns one row per gene and matched
    // value; that column rides along, named after the field.
    const context = Array.isArray(r.context_columns) ? r.context_columns : [];
    return { kind: 'data', label: String(args.goal || 'search').slice(0, 80), rows: (r.rows || []).map(row => normalizeSearchRow(row, context)), ...(context.length ? { columns: ['gene', 'ensembl', ...context] } : {}), meta: { search_url: r.search_urls?.[0] || null, query: r.plan || null, trail, understanding: r.understanding || null, not_expressible: (r.not_expressible || []).map(c => c.requirement), mode: r.mode || null, hpa_version: r.hpa_version, source_files: r.source_files, ...(context.length ? { context_columns: context } : {}) } };
  }
  if (toolName === 'investigator_hpa') {
    if (result?.error && result.found !== true) throw new Error(result.error);
    return { kind: 'answer', label: `${result.gene || args.gene}: ${String(args.question || '').slice(0, 60)}`, rows: [{ gene: result.gene || args.gene, ensembl: result.ensembl || null, question: args.question || '', found: result.found === true, answer: result.answer || '', value: result.extracted_value ?? null, entity: result.exact_label ?? null, table: result.source_section || null, cited_row: result.cited_row || null }], meta: { not_in_release: result.not_in_release || [], notes: result.notes || [], citations: result.citations || [], grounded: result.grounded, evidence_status: result.evidence_status } };
  }
  const text = [result?.summary_md, result?.summary, result?.answer, result?.message, result?.content, result?.text].find(v => typeof v === 'string' && v.trim()) || JSON.stringify(scalarRow(result));
  return { kind: 'note', label: String(args.topic || args.question || toolName).slice(0, 80), rows: [], text: String(text), meta: { images: Array.isArray(result?.images) ? result.images.length : 0 } };
}

// ---- the loop --------------------------------------------------------------------------------------

async function asoStudy({ goal, max_turns, reasoning_effort }, ctx = {}) {
  const effort = reasoning_effort || ctx.reasoning_effort || null;
  const db = ctx.db;
  if (!db) throw new Error('The study requires db in context.');
  getActiveModel();
  const orchestrator = require('../orchestrator'); // at call time: the orchestrator requires this module too
  const config = platformConfig();
  const maxTurns = max_turns === undefined ? config.asoMaxSteps : max_turns;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('The caller or platform must provide a positive integer study turn allowance');
  const parallel = config.asoParallelLimit || 3;
  // A study runs on the local release: the Investigator reads its files, and no caller's mode changes that.
  const agentMode = await resolveAgentMode('offline', [FILES.master]);
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
  // What an agent brings back is judged against the call that summoned it, in the sense of the
  // study, before the controller builds on it: the selection (the kind of entity, the measurement,
  // the filters, the table), never the numbers. A result that is not what was asked stays on the
  // desk, flagged on its line and in the history, so the controller asks again with what the
  // study means instead of following it blind.
  const REVIEW_SYSTEM = `You judge whether an agent's result is what the call asked it for: the call alone, not the study it serves, which asks for other things in other calls. You see the call that summoned the agent (its goal or question), the agent's own account of how it selected the result (the search query it built, or the source table, fields and filters it read) and the result's shape. Judge the selection only: the right kind of entity, the measurement and source the study means, the filters and categories the call states, the right source table; a search that could not express part of the call, or that served it only in part, is not what was asked. Do not judge the numbers. Reply with JSON: {"accepted": true|false, "reason": "<one sentence: what was asked and what was selected instead, or what matches>"}.`;
  const reviewStats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, perStep: {} };
  async function reviewResult(toolName, args, a, siblings = []) {
    // The Investigator answers a call that spans source tables with one artifact per table; each
    // is judged for its own share, with the others named, not against the whole call alone.
    const others = siblings.filter(x => x !== a);
    const share = others.length ? `\n\nThis call returned ${siblings.length} artifacts, one per source table; the others are ${others.map(x => `${x.id} "${x.label}" (${x.size}; columns: ${x.columns.join(', ')})`).join('; ')}. Judge ${a.id} for its own share of the call; the rest of the call is theirs.` : '';
    const account = toolName === 'deep_research_hpa'
      ? `Search query built: ${a.meta?.query || '(none)'}${a.meta?.understanding ? `; the search understood the call as: ${a.meta.understanding}` : ''}${a.meta?.trail?.length ? `; its selection, requirement by requirement: ${a.meta.trail.join('; ')}` : ''}${a.meta?.not_expressible?.length ? `; could not express: ${a.meta.not_expressible.join('; ')}` : ''}`
      : `Source lookups: ${JSON.stringify(a.meta?.lookups || []).slice(0, 1200)}${a.meta?.coverage ? `; coverage: ${JSON.stringify(a.meta.coverage).slice(0, 300)}` : ''}`;
    const asked = args.goal ? `goal: ${args.goal}` : `question: ${args.question || ''}`;
    // The reviewer sees the table the way the desk describes it: how many entities it spans, what
    // tells its rows apart, and that column's values, so a table of many rows over few entities
    // or a category the call excluded is judged for what it is.
    const g = Array.isArray(a.rows) ? tools.grain(a.rows, a.columns, identity.keys) : null;
    const byValues = g?.by ? [...new Set(a.rows.map(r => r[g.by]).filter(v => v !== null && v !== undefined && v !== '').map(String))] : [];
    const grain = g && g.entities < a.rows.length ? `; ${a.rows.length} rows over ${g.entities} ${identity.entity}s${g.by ? `, one row per ${identity.entity} and ${g.by} (${byValues.length} values${byValues.length <= 40 ? `: ${byValues.join(', ').slice(0, 900)}` : ''})` : ''}` : '';
    const user = `The call: ${toolName} "${args.title || ''}", ${asked}${Array.isArray(args.points) && args.points.length ? ` (for ${args.points.length} listed points)` : args.from ? ` (for the points of ${args.from})` : ''}\n\nWhat the agent did: ${account}\n\nResult ${a.id}: ${a.size}${grain}; columns: ${a.columns.join(', ')}${a.rows?.length ? `; first rows: ${desk.sampleLines(a.rows, a.columns.slice(0, 7), 3).join(' ; ')}` : ''}${share}`;
    const before = reviewStats.totalTokens;
    try {
      const verdict = effort ? await inference.withContext({ reasoningEffort: effort }, () => jsonCall(REVIEW_SYSTEM, user, undefined, `review ${a.id}`, reviewStats)) : await jsonCall(REVIEW_SYSTEM, user, undefined, `review ${a.id}`, reviewStats);
      const accepted = verdict?.accepted !== false;
      const reason = String(verdict?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      a.meta.review = { accepted, reason };
      if (!accepted) { a.description = `${a.description} ⚠ Review: ${reason}`; remember(`review of ${a.id}: not what the call asked for: ${reason}. Ask again with what the study means, or use it knowing this`); }
      await log('agent.review', { id: a.id, accepted, reason });
    } catch (error) { await log('agent.review', { id: a.id, error: error.message }); }
    const spent = reviewStats.totalTokens - before;
    if (spent) addSpecialistUsage('review', { prompt: reviewStats.promptTokens, completion: reviewStats.completionTokens, total: reviewStats.totalTokens }, 1), reviewStats.promptTokens = reviewStats.completionTokens = reviewStats.totalTokens = 0;
  }
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

  const state = { goal, plan: [], artifacts: [], byId: new Map(), running: new Map(), notes: [], history: [], views: new Map(), turn: 0, toolCalls: 0, failed: 0, ids: { a: 0, t: 0 }, failedCalls: new Map() };
  // A call that failed for a reason that does not change (a requirement the search cannot
  // express, a column that is not there, an argument of the wrong shape) is refused when it is
  // made again exactly the same way, before it costs another agent run or another turn.
  const TRANSIENT = /timed? ?out|rate limit|429|50\d|ECONN|network|temporar|overloaded/i;
  const callKeyOf = (name, args) => `${name} ${JSON.stringify(bare(args))}`;
  const repeatOf = (name, args) => { const f = state.failedCalls.get(callKeyOf(name, args)); return f && !TRANSIENT.test(f.error) ? f : null; };
  const remember = text => state.history.push(`turn ${state.turn}: ${text}`);

  // The study's agents are the two that return data: a set of entities (deep research) and rows
  // (the Investigator). Asking the user (clarify) belongs to the chat, and the documentation
  // reader belongs to the chat too: a study never needs the atlas's prose, and a controller that
  // asks it for column names burns turns (it is not a schema service). Each agent is described
  // by what it returns, in the database's own terms, and names its result.
  const agentSpecs = orchestrator.getToolSpecs().filter(t => ['deep_research_hpa', 'investigator_hpa'].includes(t.function.name)).map(t => {
    const properties = { ...t.function.parameters.properties };
    delete properties.mode;
    const entity = identity.entity;
    if (t.function.name === 'deep_research_hpa') return { ...t, function: { ...t.function, description: `The ${identity.database} search: the ${entity}s selected by the atlas's own annotation categories (tissue specificity and enrichment, protein class, secretome and subcellular location, prognostic category, evidence level), as the search page would; returns them as a table. It reads no table: partners, samples, per-tissue values, p-values and measurements are rows, and rows are investigator_hpa's.`, parameters: { ...t.function.parameters, required: ['goal', 'title', 'description'], properties: { ...properties, goal: { type: 'string', description: 'the set described, with every stated requirement' }, title: S, description: S } } } };
    if (t.function.name === 'investigator_hpa') return { ...t, function: { ...t.function, description: `Rows from any source table of the ${identity.database} (interaction partners, per-sample or per-tissue expression, CPTAC, blood concentrations, prognostic p-values, annotations): for a list of points (points=[...], or from=<artifact id> and column) every point with the fields asked for; without a list, every row the question selects (the partners of one ${entity}, the samples of a cell type). Ask in plain language: it finds the table and the columns itself, and it reads exactly what the question says, so the question must be precise: the measurement and its unit, the grain of the rows wanted (one row per point, or one per sample, cluster or cohort: a question that says samples gets sample rows), and the context by the atlas's own name for it. Hard rule: one list of points per call, the common factor of what is asked (one gene, one set of genes, one set of tissues); another list is another call. Ask for everything needed about those points in that one call, however many values, contexts or tables it spans (nTPM in every brain region; heart and liver expression; a location and a prognosis): the answer is one artifact per value read, with the context as a column (region, tissue, cohort) and the Investigator's mapping (table and column) and note saying what it holds; join combines artifacts. Use every artifact a call returns; do not ask again for what one already holds. It returns each field as the atlas records it, never a derived or renamed column: categories, flags and counts are made from its rows by the operations. Read the mapping and note before using the rows. Every row returned carries the point's name and id already: no call is needed for names or ids.`, parameters: { ...t.function.parameters, required: ['question', 'title', 'description'], properties: {
      points: { type: 'array', items: S, description: `${entity}s, or any values (tissues, cell lines, categories)` },
      from: { type: 'string', description: 'artifact id whose rows supply the points' },
      column: { type: 'string', description: `column of from that holds the points; its ${entity} keys by default` },
      question: { type: 'string', description: 'the complete question: fields, rows, units' },
      title: S,
      description: S
    } } } };
    return { ...t, function: { ...t.function, parameters: { ...t.function.parameters, properties } } };
  });
  const agentNames = new Set(agentSpecs.map(t => t.function.name));
  const toolSpecs = [...agentSpecs, ...STUDY_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))];
  // The model is offered run and the study's own tools; the operations run as steps of run.
  const offeredSpecs = toolSpecs.filter(t => !TABLE_TOOLS.has(t.function.name));
  const system = `${systemPrompt(identity, [...agentNames])}\n\nOperations, as steps of run (every step has title and description; a step's args are checked against the operation's full schema):\n${operationsReference(STUDY_TOOLS)}`;

  const get = id => {
    const key = String(id || '').trim();
    const a = state.byId.get(key);
    if (!a) throw new Error(`no artifact "${id}" (have ${state.artifacts.map(x => x.id).join(', ') || 'none'})`);
    return a;
  };
  // A join's line says what b's clashing columns are now called, so nothing is guessed from a
  // suffix, and how many rows on a side had no key value to match.
  const renames = a => {
    const parts = [];
    const r = Object.entries(a.meta?.renamed || {});
    if (r.length) parts.push(`${a.inputs[1]}'s ${r.map(([from, to]) => `${from} as ${to}`).join(', ')}`);
    for (const [side, n] of Object.entries(a.meta?.unkeyed || {})) if (n) parts.push(`${desk.count(n)} rows of ${a.inputs[side === 'a' ? 0 : 1]} had no ${a.args?.on || 'key'} value to match`);
    // How many rows of each side found a partner: an empty result is then an empty intersection, not a mistake.
    const m = a.meta?.matched;
    if (m) {
      if (!m.a && !m.b) parts.push(`no row of ${a.inputs[0]} matched a row of ${a.inputs[1]}${a.args?.on ? ` on ${a.args.on}` : ' on the entity keys'}`);
      else if (m.a < m.rows_a || m.b < m.rows_b) parts.push(`${desk.count(m.a)} of ${desk.count(m.rows_a)} rows of ${a.inputs[0]} matched, ${desk.count(m.b)} of ${desk.count(m.rows_b)} of ${a.inputs[1]}`);
    }
    return parts.length ? ` (${parts.join('; ')})` : '';
  };
  const origin = a => `${a.tool}${a.toolId ? ` ${a.toolId}` : ''}${a.tool === 'chart' ? `(${desk.argsLine(bare(a.args), 120)})` : agentNames.has(a.tool) ? ` "${String(a.args.question || a.args.goal || a.args.topic || '').slice(0, 90)}"` : a.inputs?.length ? ` of ${a.inputs.join(', ')}${renames(a)}` : ''}`;

  // Stores a tool's output as an artifact, linked to the artifacts it read.
  async function addArtifact({ kind, label, description = '', rows, matrix, text, tool: toolName, args, inputs, meta, figure, toolId, columns: suppliedColumns }) {
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
        // What the rendering could not show stays with the figure: the desk and the report say it.
        if (rendered?.notes?.[0]?.labels !== undefined) figure.labels_fit = rendered.notes[0];
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
    const a = { id, uuid: reg.artifactUuid, storageUri: reg.storageUri, kind, label, description, size, rows: rows || null, matrix: matrix || null, figure: figure || null, text: text || null, columns, tool: toolName, args, inputs, meta: meta || {}, images, toolId, turn: state.turn };
    state.artifacts.push(a);
    state.byId.set(id, a);
    return a;
  }

  const artifactEvent = a => ({ id: a.id, kind: a.kind, label: a.label, title: a.label, description: a.description, size: a.size, rows: a.rows ? a.rows.length : undefined, columns: a.columns.slice(0, 12), sample: a.rows ? desk.sampleLines(a.rows, a.columns.slice(0, 7), 3).map(l => l.split(' | ')) : undefined, sample_columns: a.columns.slice(0, 7), text: a.text ? a.text.slice(0, 600) : undefined, images: a.images, artifact_uuid: a.uuid, search_url: a.meta?.search_url, query: a.meta?.query, inputs: a.inputs });
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
  // Up to the parallel limit, an agent starts at once, as it always did; beyond it, the agent
  // waits for a slot, so a turn that summons one set per tissue does not start a dozen together.
  let agentsActive = 0;
  const agentQueue = [];
  const withSlot = start => { if (agentsActive < parallel) { agentsActive++; return start(); } return new Promise(resolve => agentQueue.push(resolve)).then(start); };
  const releaseSlot = () => { const next = agentQueue.shift(); if (next) next(); else agentsActive--; };
  function startAgent(toolName, args) {
    if (args.mode !== undefined && args.mode !== mode) throw new Error(`Delegated agents use the study data source: ${mode}`);
    // A call left unnamed is named by what it asks.
    const title = String(args.title || '').trim() || `${toolName}: ${String(args.goal || args.question || '').trim().slice(0, 90)}`;
    const description = String(args.description || '').trim() || title;
    const executionArgs = { ...bare(args), mode };
    // The search sees the whole study: a choice a sub-goal leaves open is settled by the study,
    // not by whichever field the words resemble.
    if (toolName === 'deep_research_hpa') executionArgs.study = state.goal;
    const inputs = [];
    if (toolName === 'investigator_hpa') {
      // The points come as a list, or from an artifact's column (its entity keys by default);
      // without either, the question itself selects the rows.
      if (args.from !== undefined) {
        // from names the points; a list sent beside it is set aside, and the history says so.
        if (Array.isArray(args.points) && args.points.length) remember(`${toolName}: the points listed are set aside, from=${args.from} names the points`);
        const input = get(args.from);
        if (!Array.isArray(input.rows) || !input.rows.length) throw new Error(`${args.from} has no rows to investigate`);
        const column = args.column ? (input.columns.find(c => c === args.column) || input.columns.find(c => c.toLowerCase() === String(args.column).toLowerCase())) : null;
        if (args.column && !column) throw new Error(`${args.from} has no column ${JSON.stringify(args.column)}; its columns: ${desk.namedColumns(input.columns)}`);
        const values = column ? input.rows.map(row => row[column]) : input.rows.map(row => row[identity.keys[1]] || row[identity.keys[0]]);
        const points = [...new Set(values.filter(v => v !== null && v !== undefined && String(v).trim() !== '').map(String))];
        if (!points.length) throw new Error(`${args.from} has no ${column || identity.entity} values to investigate`);
        // Rows that are all about one entity carry their points in another column: say which.
        if (!column && points.length === 1 && input.rows.length > 1) throw new Error(`${args.from} is about one ${identity.entity} (${points[0]}) across ${input.rows.length} rows; name the column that holds the points with column: ${desk.namedColumns(input.columns.filter(c => !identity.keys.includes(c)))}`);
        inputs.push(input.id);
        delete executionArgs.from; delete executionArgs.column;
        executionArgs.points = points;
      } else if (Array.isArray(args.points) && args.points.length) executionArgs.points = args.points.map(String);
      else executionArgs.points = [];   // no list, or an empty one: the question itself selects the rows
      delete executionArgs.gene; delete executionArgs.genes;
    }
    const fingerprint = JSON.stringify([toolName, executionArgs]).toLowerCase();
    const earlier = agentJobs.get(fingerprint);
    if (earlier) {
      // Its artifacts, each once, the fullest first, with their size: the desk line says the rest.
      const made = earlier.made ? [...new Set(earlier.made)].map(id => state.byId.get(id)).filter(Boolean).sort((x, y) => (y.rows?.length || 0) - (x.rows?.length || 0)) : [];
      remember(earlier.made ? `${toolName}(${desk.argsLine(bare(args), 140)}) was already asked as ${earlier.id}: its result is ${made.map(a => `${a.id} "${a.label}" (${a.size})`).join(', ') || 'nothing'}; asking again the same way returns nothing new: use what it made, or ask for other fields with from and the column that names the rows` : `${toolName}(${desk.argsLine(bare(args), 140)}) is already running as ${earlier.id}`);
      return false;
    }
    const id = `t${++state.ids.t}`;
    const job = { id, tool: toolName, args, startedAt: Date.now(), kind: 'agent', made: null, turn: state.turn, callKey: callKeyOf(toolName, args) };
    agentJobs.set(fingerprint, job);
    state.running.set(id, job);
    state.toolCalls++;
    state.agentStarts = (state.agentStarts || 0) + 1;
    log('tool.start', { id, tool: toolName, kind: 'agent', label: title, args, inputs }, id);
    const forward = async s => log(`agent.${s.stage}`, { id, label: s.label, message: s.message }, id);
    // Agents run a few at a time, as operations do: each carries its own working set, and a turn
    // that summons one set per tissue would start a dozen at once.
    job.promise = withSlot(() => orchestrator.execute(toolName, executionArgs, { db, visitorId: ctx.visitorId, rawQuery: '', includeRows: true, onStep: forward, reasoningEffort: effort, runControl: ctx.runControl, signal: ctx.signal, cacheKey: workspace.uuid, maxTurns }).finally(releaseSlot))
      .then(async ({ result }) => {
        addSpecialistUsage(toolName, result?.tokens, result?.calls);
        const made = [], repeats = [];
        if (result?.bulk) {
          if (!result.tables?.length) throw new Error(result.error || result.note || 'Investigator returned no table');
          // A table that reads the same source table, fields, filter and points as an earlier artifact
          // is that artifact: it is not registered twice, and the earlier id stands for it.
          const twinOf = table => state.artifacts.find(x => x.tool === toolName && (x.meta?.source_rows ?? x.rows?.length) === table.rows.length && JSON.stringify(x.columns) === JSON.stringify(table.columns) && JSON.stringify(x.meta?.lookups) === JSON.stringify([table.args]) && JSON.stringify(x.meta?.points) === JSON.stringify(executionArgs.points));
          const lines = [];
          for (const table of result.tables) {
            const twin = twinOf(table);
            if (twin) { repeats.push(twin); lines.push(`${twin.id} again (the same rows)`); continue; }
            // One measurement per entity in a few categories the question named (a gene's nTPM in
            // two tissues, fetched with a filter on those tissues) arrives as one row per entity
            // with a column per category: the shape a scatter, a mean or a ratio needs.
            const named = (table.args?.where || []).map(w => w?.column).filter(Boolean);
            const wide = named.length ? tools.widenByCategory(table.rows, table.columns, identity.keys, { only: named }) : null;
            const shape = wide ? ` One row per ${identity.entity}; ${wide.measure} by ${wide.by} in the columns ${wide.values.join(', ')}.` : '';
            // The study's own title names the result (it is what the controller will look for and
            // what a concat label carries); the Investigator's title tells several tables apart.
            const label = result.tables.length === 1 ? (title || table.title) : (table.title && table.title !== title ? `${title}: ${table.title}` : title);
            const a = await addArtifact({ kind: 'data', label, description: `${table.description || description}${shape}`, rows: wide ? wide.rows : table.rows, columns: wide ? wide.columns : table.columns, tool: toolName, args, inputs, toolId: id, meta: { lookups: [table.args], points: executionArgs.points, coverage: table.coverage, source_file: table.source_file, source_files: [table.source_file], status: result.status, hpa_version: result.hpa_version, source_rows: table.rows.length, ...(wide ? { shape: { wide_by: wide.by, measure: wide.measure, values: wide.values } } : {}) } });
            made.push(a);
            lines.push(`${a.id} "${a.label}" (${a.size})`);
          }
          const nothingNew = made.length ? '' : ': nothing new; the Investigator answers per source table, one artifact each, and join combines them';
          // Each artifact carries its own note and mapping, written by the Investigator from what it
          // did; the run's note (why this over that) goes to the history once.
          const mapped = result.mapping?.length ? `Mapped: ${result.mapping.map(m => `${m.field} → ${m.table}.${m.column}`).join('; ')}` : '';
          for (const a of made) a.meta.mapping = result.mapping || [];
          remember(`${id} ${toolName} "${title}" done → ${lines.join(', ')}${nothingNew}${mapped ? `. ${mapped}` : ''}${result.note ? `. Investigator note: ${result.note}` : ''}${result.unresolved?.length ? `. Not in the release: ${result.unresolved.slice(0, 10).join(', ')}` : ''}`);
        } else {
          const a = await addArtifact({ ...agentArtifact(toolName, args, result), label: title, description, tool: toolName, args, inputs, toolId: id });
          made.push(a);
          // A search that ran the same query as an earlier one says so: rewording the goal changed nothing.
          const twin = a.meta.query ? state.artifacts.find(x => x !== a && x.meta?.query === a.meta.query) : null;
          const extra = toolName === 'deep_research_hpa' ? ` query: ${String(a.meta.query || '').slice(0, 160)}${a.meta.trail?.length ? `; chosen: ${a.meta.trail.join('; ')}` : ''}${a.meta.not_expressible?.length ? `; could not express: ${a.meta.not_expressible.join('; ')}` : ''}${twin ? `; the same query as ${twin.id}${(twin.rows?.length || 0) === a.rows.length ? ', the same set' : ''}` : ''}` : a.kind === 'answer' ? ` answer: ${String(a.rows[0]?.answer || '').slice(0, 200)}` : '';
          // The selection stays on the artifact's line every turn, not only in the history.
          if (toolName === 'deep_research_hpa' && a.meta.trail?.length) a.description = `${a.description} Selected by: ${a.meta.trail.join('; ')}`;
          // A set's rows are one Investigator call away; the history says so as it lands.
          const next = toolName === 'deep_research_hpa' && a.rows.length && agentNames.has('investigator_hpa') ? `; its rows: investigator_hpa from=${a.id} with the question` : '';
          remember(`${id} ${toolName} "${title}" done → ${a.id} (${a.size})${extra}${next}`);
        }
        // The study judges the Investigator's artifacts itself: each carries its note and mapping.
        if (toolName !== 'investigator_hpa') for (const a of made) await reviewResult(toolName, args, a, made);
        job.made = [...made, ...repeats].map(a => a.id);
        for (const a of made) await log('tool.done', { id, tool: toolName, kind: 'agent', artifact: artifactEvent(a), ms: Date.now() - job.startedAt }, id);
      })
      .catch(async err => {
        agentJobs.delete(fingerprint);
        state.failed++;
        state.failedCalls.set(job.callKey, { turn: job.turn, error: err.message });
        // A set the search cannot express is not the end of the road: what is a row of a table
        // (partners, samples, measurements) is the Investigator's, and every entity of the
        // database is what overlap tests against by itself. The failure line says so.
        const refused = toolName === 'deep_research_hpa' && err.details?.stop_reason === 'unexpressible_requirements';
        const hint = refused
          ? ` (the search selects ${identity.entity}s by the atlas's annotation categories; a table's rows, partners, samples, measurements, p-values, come from investigator_hpa, without points when the question itself selects the rows; no list of every ${identity.entity} is needed, overlap tests against the whole database by itself)` : '';
        // What the atlas calls the thing the call names: recorded values whose names contain a
        // word of the call, so a set the search could not express as worded may exist under its
        // atlas name.
        const called = refused ? await atlasValuesFor(String(args.goal || args.question || '')) : [];
        remember(`${id} ${toolName} "${title}" failed: ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ''}${hint}${called.length ? `; the atlas records, under words of the call: ${called.join('; ')}` : ''}`);
        await log('tool.failed', { id, tool: toolName, kind: 'agent', error: err.message, details: err.details, ms: Date.now() - job.startedAt }, id);
      })
      .finally(() => { state.running.delete(id); state.agentsReturned = (state.agentsReturned || 0) + 1; wakeUp(); });
    return true;
  }

  // One table operation over artifacts: inputs resolved, the operation applied.
  async function computeOut(toolName, args) {
    const inputColumns = new Set(), inputRefs = new Set();
    const rowsOf = key => {
      const a = get(String(args[key] ?? '').trim());
      inputRefs.add(a.id);
      if (a.matrix) throw new Error(`${a.id} is a matrix; only a heatmap chart can take it`);
      if (!a.rows) throw new Error(`${a.id} has no rows`);
      for (const c of a.columns) inputColumns.add(c);
      return tools.withColumns([...a.rows], a.columns);
    };
    // Matching by a column that is only another name for the entity (the gene symbol) loses the
    // entities that have no symbol: 378 of the 20,162 genes, and a universe of 19,773 instead of
    // 20,162. When every input carries the entity key, the key is what matches.
    if (['combine', 'overlap'].includes(toolName) && args.on) {
      const key = identity.keys[identity.keys.length - 1];
      const tables = ['a', 'b', 'universe'].filter(k => args[k] !== undefined).map(k => get(args[k]));
      if (identity.keys.includes(args.on) && args.on !== key && tables.every(t => (t.columns || []).includes(key))) args = { ...args, on: undefined, matched_on: key };
    }
    let out;
    switch (toolName) {
      case 'combine': {
        if (args.how !== 'union' && !['concat', 'intersect', 'difference'].includes(args.how)) throw new Error('combine: how is concat, intersect or difference');
        const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : null;
        if (label && args.how !== 'concat') throw new Error('combine: label goes with concat, which keeps every row of both inputs');
        // With a label, each row says which input it came from, by that input's title.
        // The label is each input's title; two inputs with the same title are told apart by their ids.
        const names = { [args.a]: state.byId.get(args.a)?.label || args.a, [args.b]: state.byId.get(args.b)?.label || args.b };
        if (args.a !== args.b && names[args.a] === names[args.b]) { names[args.a] = `${names[args.a]} (${args.a})`; names[args.b] = `${names[args.b]} (${args.b})`; }
        const tagged = (rows, id) => label ? tools.withColumns(rows.map(r => ({ [label]: names[id], ...r })), [label, ...tools.columnsOf(rows).filter(c => c !== label)]) : rows;
        out = { rows: tools.setOp(args.how, tagged(rowsOf('a'), args.a), tagged(rowsOf('b'), args.b), args.on || null) }; break;
      }
      case 'join': out = executeTableOperation(toolName, args, { a: rowsOf('a'), b: rowsOf('b') }); break;
      case 'aggregate': {
        out = executeTableOperation(toolName, args, { artifact: rowsOf('artifact') });
        // A statistic of a column is named after both (mean_value), so two aggregates joined
        // side by side stay told apart: a bare "mean" and "mean_2" once had a study report two
        // tissues' means the wrong way round. count is rows and keeps its name.
        if (args.column && out.rows) {
          const metrics = (Array.isArray(args.metrics) ? args.metrics : [args.metrics]).map(m => String(m).toLowerCase()).filter(m => m !== 'count');
          const renamed = Object.fromEntries(metrics.map(m => [m, `${m}_${args.column}`]));
          out.rows = tools.withColumns(out.rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [renamed[k] || k, v]))), tools.columnsOf(out.rows).map(c => renamed[c] || c));
        }
        break;
      }
      case 'filter': case 'select': case 'classify': case 'compute': case 'correlate': case 'rank': out = executeTableOperation(toolName, args, { artifact: rowsOf('artifact') }); break;
      case 'overlap': {
        // The universe is every entity of the database unless an artifact is named.
        const universe = args.universe ? rowsOf('universe') : tools.withColumns(await geneData.entities(), [...identity.keys]);
        out = { rows: tools.overlap(rowsOf('a'), rowsOf('b'), universe, args.on || null, args.group_by || null) }; break;
      }
      case 'explode': out = { rows: tools.explode(rowsOf('artifact'), args.column, args.as) }; break;
      case 'pivot': out = { matrix: tools.pivot(rowsOf('artifact'), args) }; break;
      case 'chart': { const a = get(args.artifact); inputRefs.add(a.id); out = { figure: tools.chartSpec(args, a.matrix || a.rows) }; break; }
      default: throw new Error(`unknown operation ${toolName}`);
    }
    return { out, inputColumns, inputs: [...inputRefs] };
  }

  const made = new Map();   // fingerprint of an operation → the artifact it made
  async function runTableTool(toolName, args) {
    const callKey = callKeyOf(toolName, args);   // as called, before any alias, so a repeat of the same call is recognised
    args = { ...args };
    if (['combine', 'join', 'overlap'].includes(toolName) && args.a === undefined && args.artifact !== undefined) args = { ...args, a: args.artifact };
    // A result left unnamed is named by its operation.
    const title = String(args.title || '').trim() || `${toolName}(${desk.argsLine(bare(args), 90)})`;
    const description = String(args.description || '').trim() || title;
    // The same operation on the same inputs is the same artifact, whatever it is called; it is not made twice.
    const key = JSON.stringify([toolName, bare(args)]);
    if (made.has(key) && state.byId.has(made.get(key))) {
      const a = get(made.get(key));
      remember(`${toolName}(${desk.argsLine(bare(args), 140)}) is ${a.id} "${a.label}", already made at turn ${a.turn}`);
      return { ok: true, artifact: a, repeated: true };
    }
    const id = `t${++state.ids.t}`;
    const t0 = Date.now();
    state.toolCalls++;
    let inputs = ['artifact', 'a', 'b', 'universe'].map(k => args[k]).filter(Boolean).map(String);
    await log('tool.start', { id, tool: toolName, kind: toolName === 'chart' ? 'chart' : 'tool', label: title, args, inputs }, id);
    try {
      const { out, inputColumns, inputs: resolvedInputs } = await computeOut(toolName, args);
      inputs = resolvedInputs;
      if (out.rows) out.rows = tools.freshFirst(out.rows, [...inputColumns]);
      const a = await addArtifact({ kind: out.figure ? 'figure' : 'data', label: title, description, rows: out.rows, matrix: out.matrix, figure: out.figure, meta: out.figure ? { omitted_rows: out.figure.omitted_rows || 0 } : out.meta, tool: toolName, args, inputs, toolId: id });
      made.set(key, a.id);
      remember(`${toolName}(${desk.argsLine(bare(args), 140)}) → ${a.id} "${title}" (${a.size}${a.kind === 'figure' && !a.images.length ? ', not rendered' : ''})${renames(a)}`);
      await log('tool.done', { id, tool: toolName, kind: out.figure ? 'chart' : 'tool', artifact: artifactEvent(a), ms: Date.now() - t0 }, id);
      return { ok: true, artifact: a };
    } catch (err) {
      state.failed++;
      state.failedCalls.set(callKey, { turn: state.turn, error: err.message });
      remember(`${toolName}(${desk.argsLine(bare(args), 140)}) failed: ${err.message}`);
      await log('tool.failed', { id, tool: toolName, kind: toolName === 'chart' ? 'chart' : 'tool', error: err.message, ms: Date.now() - t0 }, id);
      return { ok: false, error: err.message };
    }
  }

  // A view is something the model asked to see; it stays on the desk for the whole study, one
  // per page of an artifact, a later opening of the same page replacing the earlier.
  const view = (key, text, receipt) => { state.views.set(key, { text, receipt, turn: state.turn }); };
  // Column names an operation's arguments mention, shown first in a view.
  const argColumns = a => {
    const names = new Set(a.columns || []), found = [];
    const walk = v => { if (typeof v === 'string') { if (names.has(v) && !found.includes(v)) found.push(v); } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(bare(a.args));
    return found;
  };
  async function openWhat(args) {
    const what = String(args.artifact ?? args.what ?? args.id ?? '').trim();
    if (!what) throw new Error('open needs artifact: an artifact id');
    const a = get(what);
    if (a.figure) { view(a.id, `${a.id} figure: ${JSON.stringify(a.figure).slice(0, 1200)}`, `${a.id} figure spec (opened at turn ${state.turn})`); remember(`opened ${a.id} (figure spec on the desk)`); return true; }
    if (a.matrix) { view(a.id, `${a.id} matrix rows ${a.matrix.row_labels.join(', ')}; columns ${a.matrix.col_labels.join(', ')}\n${a.matrix.matrix.slice(0, 40).map((row, i) => `  ${desk.cell(a.matrix.row_labels[i])}: ${row.map(v => v === null ? '—' : v).join(' | ')}`).join('\n')}${a.matrix.matrix.length > 40 ? '\n  …' : ''}`, `${a.id} matrix (opened at turn ${state.turn})`); remember(`opened ${a.id} (matrix on the desk)`); return true; }
    if (a.text) { view(a.id, `${a.id}: ${a.text.slice(0, 1500)}`, `${a.id} text (opened at turn ${state.turn})`); remember(`opened ${a.id}`); return true; }
    const named = Array.isArray(args.columns) && args.columns.length > 0;
    // Rows already on the desk are not opened again; a cell cut short there is read in full by naming its column.
    if (!named && state.wholeOnDesk?.has(a.id)) {
      // The rows are already on the desk. Asked for anyway, they go into the history once, in
      // full cells: a model that wants to read a value before it writes a claim gets it, instead
      // of an idle turn (gpt-oss stalled a finished study asking to see its two-row tables). A
      // second identical open is idle.
      state.shownWhole = state.shownWhole || new Map();
      const earlier = state.shownWhole.get(a.id);
      if (earlier) { remember(`${a.id}'s ${a.rows.length} rows are on the desk under ARTIFACTS and were listed in full at turn ${earlier}; open ${a.id} with columns for chosen columns, or use the values`); return false; }
      state.shownWhole.set(a.id, state.turn);
      const line = `${a.id} rows (${a.columns.join(' | ')}): ${a.rows.map((r, i) => `${i}: ${desk.rowLine(r, a.columns, desk.FULL_CELL)}`).join(' ; ')}`;
      remember(line.length > 2000 ? `${line.slice(0, 1999)}…` : line);
      return true;
    }
    const rows = Number.isSafeInteger(args.rows) && args.rows > 0 ? args.rows : VIEW_ROWS;
    const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
    const columns = named ? args.columns.map(c => { const found = a.columns.find(x => x === c) || a.columns.find(x => x.toLowerCase() === String(c).toLowerCase()); if (!found) throw new Error(`${a.id} has no column ${JSON.stringify(c)}; its columns: ${desk.namedColumns(a.columns)}`); return found; }) : a.columns;
    // A view of a wide artifact shows its keys, the columns its operation named and the first
    // columns; naming columns shows any of them.
    const lead = [...identity.keys, ...argColumns(a)].filter(c => columns.includes(c));
    const shownColumns = columns.length > desk.WIDE_COLUMNS ? [...lead, ...columns.filter(c => !lead.includes(c))].slice(0, desk.WIDE_COLUMNS / 2) : columns;
    const hidden = columns.length - shownColumns.length;
    const page = a.rows.slice(offset, offset + rows);
    const lines = page.map((row, i) => `  ${offset + i}: ${desk.rowLine(row, shownColumns, named ? desk.FULL_CELL : desk.CELL)}`);
    const range = `rows ${offset}–${offset + page.length - 1} of ${a.rows.length}`;
    const text = `${a.id} ${range} (${shownColumns.join(' | ')}${hidden ? ` | … +${hidden} columns; name columns to see them` : ''})\n${lines.join('\n') || '  (no rows)'}${offset + page.length < a.rows.length ? `\n  … open ${a.id} offset=${offset + page.length} for more` : ''}`;
    // The same page opened again while it is still whole on the desk shows nothing new.
    const key = `${a.id}|${offset}`, existing = state.views.get(key);
    const consumedAt = Math.max(-Infinity, ...state.artifacts.filter(x => (x.inputs || []).includes(a.id)).map(x => x.turn));
    if (existing && existing.text === text && !(consumedAt > existing.turn) && state.turn <= existing.turn + 1) { remember(`${a.id} ${range} is already on the desk under VIEWS`); return false; }
    // The same page asked for again after it folded is a page the study keeps needing: it stays
    // on the desk until an operation reads the artifact, instead of costing a turn each time.
    if (existing && existing.text === text && !(consumedAt > existing.turn)) { state.views.set(key, { ...existing, turn: state.turn, pinned: true }); remember(`opened ${a.id} ${range} again: it stays on the desk until an operation reads ${a.id}`); return true; }
    view(key, text, `${a.id} ${range} (opened at turn ${state.turn}; open again to see them)`);
    remember(`opened ${a.id} ${range} (view on the desk)`);
    return true;
  }

  function deskText(turn) {
    const running = [...state.running.values()].map(j => `${j.id} ${j.tool} "${String(j.args.title || '').slice(0, 100)}" ${Math.round((Date.now() - j.startedAt) / 1000)} s`).join('\n') || '(nothing running)';
    // An artifact a later operation read shows no rows: they live on in the successor.
    const consumed = new Set(state.artifacts.flatMap(a => a.inputs || []));
    // The artifacts whose every row is on the desk this turn; open answers for them from the desk.
    state.wholeOnDesk = new Set(state.artifacts.filter(a => Array.isArray(a.rows) && !consumed.has(a.id) && desk.inline(a.rows, a.columns)).map(a => a.id));
    // A table with more rows than entities says so, and says what tells its rows apart (one row
    // per gene and tissue, with the tissues): ranking or counting it counts rows, not entities,
    // and a filter on that column uses the values as written.
    const spread = a => {
      const g = tools.grain(a.rows, a.columns, identity.keys);
      if (!g || g.entities >= a.rows.length) return '';
      const by = g.by ? `, one row per ${identity.entity} and ${g.by}${g.values ? ` (${g.by}: ${g.values.join(', ')})` : ` (${desk.count(g.distinct)} values)`}` : '';
      return ` over ${desk.count(g.entities)} ${identity.entity}s${by}`;
    };
    const lines = state.artifacts.map(a => desk.resultLine({ id: a.id, title: a.label, description: a.description, origin: origin(a), rows: a.rows || [], columns: a.columns, spread: spread(a), matrix: a.matrix, figure: a.figure, images: a.images, text: a.text, consumed: consumed.has(a.id) }));
    // A view stays whole until a later turn's operation consumes its artifact; then it folds to
    // its receipt, since the rows live on in the successor and open shows them again.
    const consumedAfter = new Map();
    for (const a of state.artifacts) for (const input of a.inputs || []) consumedAfter.set(input, Math.max(consumedAfter.get(input) ?? -Infinity, a.turn));
    // A view is read on the turn after it was opened; from then on it is its receipt, and open
    // brings it back. Rows the study keeps looking at do not ride along on every turn.
    const views = [...state.views.entries()].map(([key, v]) => ((consumedAfter.get(key.split('|')[0]) ?? -Infinity) > v.turn || (!v.pinned && state.turn > v.turn + 1)) ? v.receipt : v.text);
    const sections = [
      desk.section('STUDY', goal),
      desk.section('PLAN', studyPlan.planText(state.plan, agentNames.has('deep_research_hpa') ? { gene_set: 'gene_set ← deep_research_hpa' } : {})),
      desk.section('ARTIFACTS', lines.join('\n') || '(none yet)'),
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
      // Only what can act is offered: before any artifact exists, the plan, notes and the agents;
      // the operations, open and finish once there is something to work on.
      const offered = turn === maxTurns ? offeredSpecs.filter(t => ['finish', 'note'].includes(t.function.name))
        // finish is offered once there is something to report, or once every agent that came
        // back came back with nothing: a study whose data does not exist finishes with what it
        // could not do.
        : offeredSpecs.filter(t => (t.function.name !== 'skip' || state.running.size) && (state.artifacts.length || (t.function.name === 'finish' && state.agentsReturned && !state.running.size) || ['plan', 'note', 'skip'].includes(t.function.name) || agentNames.has(t.function.name)));
      const user = deskText(turn);
      const request = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], tools: offered, temperature: 0, prompt_cache: { key: `study ${workspace.uuid}` }, ...(effort ? { reasoning_effort: effort } : {}) };
      const contextDir = path.join(workspace.workspaceDir, 'context');
      await fs.mkdir(contextDir, { recursive: true });
      const stem = path.join(contextDir, `turn-${String(turn).padStart(2, '0')}`);
      await fs.writeFile(`${stem}.txt`, user, { mode: 0o600 });
      await fs.writeFile(`${stem}.request.json`, JSON.stringify(request), { mode: 0o600 });
      await log('context', { turn, desk_bytes: Buffer.byteLength(user), system_bytes: Buffer.byteLength(system), tool_schema_bytes: Buffer.byteLength(JSON.stringify(offered)) });
      // A provider that fails a turn (a cut stream, a status with no body) is asked again, twice,
      // before the study gives up: the desk is the same, so the turn is simply resent.
      let res;
      for (let attempt = 1; ; attempt++) {
        try { res = await inference.chat.completions.create(request); break; }
        catch (error) {
          if (attempt > 2 || ctx.signal?.aborted) throw error;
          await log('inference.retry', { turn, attempt, error: error.message });
          await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
        }
      }
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
      let waiting = false, sync = 0, started = 0, repeated = 0;
      async function executeCall(call) {
        if (call.error) throw new Error(`invalid arguments: ${call.error}`);
        // An operation called by name, though only run is offered, is the operation: it runs.
        const spec = offered.find(t => t.function.name === call.name) || toolSpecs.find(t => t.function.name === call.name && TABLE_TOOLS.has(call.name));
        if (!spec) throw new Error(`no tool ${call.name}`);
        call.args = decodeArguments(call.args, spec.function.parameters, call.name);
        const ignored = validate(call.args, spec.function.parameters, call.name);
        if (ignored.length) remember(`${call.name}: ${ignored.slice(0, 5).map(key => key.slice(call.name.length + 1).slice(0, 40)).join(', ')}${ignored.length > 5 ? ` (+${ignored.length - 5})` : ''} ${ignored.length === 1 ? 'is not an argument' : 'are not arguments'} of this tool, ignored`);
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
        if (call.name === 'open') { if (await openWhat(call.args)) sync++; return; }
        if (call.name === 'run') {
          const specifications = new Map(toolSpecs.filter(t => TABLE_TOOLS.has(t.function.name)).map(t => [t.function.name, t.function]));
          const all = Array.isArray(call.args.steps) ? call.args.steps : [];
          // An agent named as a run step starts on its own (it returns in the background) and the
          // steps that use its result wait for the artifact: the run is not lost to that mistake.
          const lifted = new Map();
          for (const s of all) {
            if (!s || !agentNames.has(s.tool)) continue;
            const repeat = repeatOf(s.tool, s.args || {});
            try {
              if (repeat) throw new Error(`the same call failed at turn ${repeat.turn} (${repeat.error.slice(0, 160)}); it would fail the same way, change it`);
              if (startAgent(s.tool, s.args || {})) { started++; lifted.set(String(s.id), `t${state.ids.t}`); } else { sync++; lifted.set(String(s.id), 'already asked'); }
            } catch (error) { state.failed++; state.failedCalls.set(callKeyOf(s.tool, s.args || {}), { turn, error: error.message }); lifted.set(String(s.id), null); remember(`run step ${s.id} ${s.tool}(${desk.argsLine(bare(s.args), 120)}) failed: ${error.message}`); }
          }
          const waits = [], steps = [];
          for (const s of all) {
            if (!s || agentNames.has(s.tool)) continue;
            const text = JSON.stringify(s.args || {});
            // A step uses another as @id, or names it bare where an artifact id goes.
            const names = Object.values(s.args || {}).flatMap(v => (Array.isArray(v) ? v : [v])).filter(v => typeof v === 'string');
            const dep = [...lifted.keys()].find(stepId => text.includes(`@${stepId}`) || names.includes(stepId));
            if (dep) waits.push(`${s.id} uses @${dep}${lifted.get(dep) ? `, which ${lifted.get(dep) === 'already asked' ? 'an earlier call' : lifted.get(dep)} is producing: run it again with that artifact's id when it is on the desk` : ', which failed'}`);
            else steps.push(s);
          }
          if (lifted.size) remember(`run: ${[...lifted].map(([stepId, t]) => `${stepId} ${t ? (t === 'already asked' ? 'already asked' : `started as ${t}`) : 'failed'}`).join(', ')}${waits.length ? `; ${waits.join('; ')}` : ''}`);
          if (steps.length) {
            const batch = await executeBatch({ steps, outputs: steps.map(s => s?.id).filter(id => typeof id === 'string') }, { specifications, concurrency: parallel, execute: runTableTool, external: id => (state.byId.has(id) ? id : null) });
            if (batch.status !== 'completed') remember(`run: ${batch.steps.filter(s => s.status !== 'done').map(s => `${s.id} ${s.status}${s.error ? `: ${s.error}` : ''}`).join('; ')}`);
          }
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
        // A call already made, or already asked, does no work: the turn is idle if that is all it did.
        if (TABLE_TOOLS.has(call.name)) { const made = await runTableTool(call.name, call.args); if (made?.repeated) repeated++; else sync++; return; }
        if (agentNames.has(call.name)) { if (startAgent(call.name, call.args)) started++; else repeated++; return; }
        throw new Error(`no tool ${call.name}`);
      }
      const guarded = async call => {
        const repeat = repeatOf(call.name, call.args);
        if (repeat) { state.failed++; remember(`${call.name}(${desk.argsLine(bare(call.args), 140)}) refused: the same call failed at turn ${repeat.turn} (${repeat.error.slice(0, 160)}); it would fail the same way, change it`); await log('call.refused', { tool: call.name, turn, earlier: repeat.turn }); sync++; return; }
        try { await executeCall(call); }
        catch (error) { state.failed++; state.failedCalls.set(callKeyOf(call.name, call.args), { turn, error: error.message }); remember(`${call.name}(${desk.argsLine(bare(call.args), 140)}) failed: ${error.message}`); await log('call.failed', { tool: call.name, error: error.message, turn }); sync++; }
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
      if (sync === 0 && started === 0 && !waiting) { stalls++; remember(repeated ? 'that turn only repeated calls already made: use their artifacts as they are, ask differently, or finish' : 'that turn did no work: summon agents, run operations, or finish'); if (stalls > MAX_STALLS) break; continue; }
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
