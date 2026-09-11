'use strict';

/**
 * Deep research, trail version.
 *
 * A question in, one query and its results out, for whatever database the adapter describes.
 * The agent knows nothing about any particular database: it reads the adapter's schema (fields,
 * levels, options) and the database's own definitions, plans which fields the question needs,
 * then walks each field's option tree to fill the filter in ("the trail"), composes the query
 * and runs it once. Choices are checked against the schema, never against result counts.
 */

const { jsonCall: invokeLLM } = require('../../inference/jsonCall');
const { AgentStop: ResearchStop, RepairProgress, createAgentControl } = require('../aso/agentControl');

const PLAN_SYSTEM = `You are turning a scientist's question into a query on a database. You are given the database's search schema: its categories, every filter field, the levels of each field and how many options each level has, plus the database's own definitions of its terms.

Decide which fields the question needs. Every filter you name is filled in afterwards from that field's actual options, so here you choose fields, not values.
Return JSON: { "understanding": "<what the question asks, in the database's terms>", "filters": [ { "requirement": "<the part of the question this filter serves>", "field": "<exact field name>", "operator": "AND" | "NOT", "why": "<why this field, in one sentence>" } ], "cannot": [ { "requirement": "<part of the question>", "why": "<why no field expresses it>" } ] }
Rules:
- Use field names exactly as written in the schema.
- One filter per requirement the question states, and no filter for anything it does not state; a requirement that needs two fields gets two filters.
- A requirement is "cannot" only when no field expresses it; if a field's definition covers it, it is a filter, not "cannot".
- Operator NOT only when the question excludes what the field describes; a requirement phrased with "not" is often a value inside a field (a "not detected" category), which stays AND.
- When the schema has no field for a requirement, put the requirement in "cannot" with the reason; do not approximate it with a different field.
- Prefer the field whose definition matches what the question means over the field whose name resembles the question's words.
- The question may be one part of a study given with it. When the study names the assay (RNA, or protein by immunohistochemistry) and the requirement does not, take the study's assay. When the schema has both an RNA field and a protein field for a requirement and neither the requirement nor the study names the assay, put the requirement in "cannot", naming both fields.`;

const TRAIL_SYSTEM = `You are filling in one filter of a database query. You are given the question, the requirement this filter serves, and the field: its levels and every option at each level, with the database's own definitions where it gives them.

Return JSON: { "choices": [ { "level": 1, "values": ["<option>"] }, { "level": 2, "values": ["<option>"] } ], "why": "<one sentence>" }
Rules:
- Use option names exactly as written.
- A level marked "one value" takes exactly one; "several values allowed" may take more, meaning any of them.
- Leave a level out to leave it unrestricted; level 2 options may depend on the level 1 value. When the question means "all of them" or does not restrict a level, leave that level out rather than listing every option.
- Choose by the definitions: the option whose definition is what the question means, not the option whose name shares words with the question.
- Choose the smallest set of options that means exactly what the question says. Do not add neighbouring categories "to be safe": a question about where expression peaks is not a question about enrichment, and a question about enrichment is not a question about enhancement.
- If several options together are what the question means (a group of cell types, a set of cohorts, two categories that both count), list them all on a level that allows several values.`;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
async function ask(system, user, context, label) {
  await context.control.checkpoint(label, true);
  const result = await invokeLLM(system, user, context.onStep, label, context.stats);
  await context.control.checkpoint(`${label}: returned`);
  return result;
}

function planIssues(plan) {
  const issues = [];
  if (!object(plan) || !Array.isArray(plan.filters) || (plan.cannot !== undefined && !Array.isArray(plan.cannot))) return ['invalid_plan_shape'];
  if (!plan.filters.length && !(plan.cannot || []).length) issues.push('empty_plan');
  for (const item of plan.filters) {
    if (!object(item) || !text(item.requirement)) issues.push('invalid_filter_shape');
  }
  for (const item of plan.cannot || []) if (!object(item) || !text(item.requirement) || !text(item.why)) issues.push('invalid_unexpressible_requirement');
  return [...new Set(issues)].sort();
}

const PLAN_REPAIR_SYSTEM = `Repair only the unresolved requirements below using the exact database schema. Known requirements remain fixed. Return JSON { "repairs": [ { "requirement_id": "<original ID>", "field": "<exact schema field>" } ] }. Include operator AND or NOT only if the original operator was invalid. Known fields and valid operators cannot change. If no field expresses a requirement, instead provide "unexpressible_reason": "<source-schema reason>". Include each unresolved ID; do not drop, merge or rewrite requirements. Do not invent requirement IDs.`;

async function planFilters(adapter, goal, context, requirements, study = null) {
  const schema = adapter.overview();
  const base = `Question: "${goal}"${study && study !== goal ? `\nThe study this question is one part of: "${study}"` : ''}\n\nSchema:\n${schema}`;
  const progress = new RepairProgress();
  let feedback = '', plan;
  for (;;) {
    plan = await ask(PLAN_SYSTEM, `${base}${feedback}`, context, feedback ? 'Plan again' : 'Plan');
    const issues = planIssues(plan);
    if (!issues.length) break;
    progress.record({ phase: 'plan', issues }, 'The planner repeated an invalid plan without resolving its schema errors');
    feedback = `\n\nThe plan is invalid: ${issues.join(', ')}. Return explicit filters and cannot arrays. Every filter needs its original requirement and exact field, with operator AND or NOT. Unexpressible requirements need their requirement and reason. Do not omit a requested criterion.`;
  }
  for (const item of plan.filters) {
    const known = text(item.field) && Boolean(adapter.field(item.field));
    const operator = item.operator === undefined ? 'AND' : item.operator;
    const validOperator = ['AND', 'NOT'].includes(operator);
    const issue = !known ? 'unknown_field' : !validOperator ? 'invalid_operator' : null;
    requirements.push({ id: `r${requirements.length + 1}`, requirement: item.requirement, field: text(item.field) ? item.field : null, operator, why: item.why || '', status: known && validOperator ? 'planned' : 'unresolved', issue, error: !known ? `Unknown field ${JSON.stringify(item.field)}` : !validOperator ? `Invalid operator ${JSON.stringify(operator)}; choose AND or NOT from the requirement` : null });
  }
  for (const item of plan.cannot || []) requirements.push({ id: `r${requirements.length + 1}`, requirement: item.requirement, status: 'unexpressible', error: item.why });

  const repairs = new RepairProgress();
  for (;;) {
    const pending = requirements.filter(item => item.status === 'unresolved');
    if (!pending.length) break;
    const state = pending.map(item => ({ id: item.id, issue: item.issue || 'unknown_field', field: item.field && adapter.field(item.field) ? item.field : null, operator: ['AND', 'NOT'].includes(item.operator) ? item.operator : null }));
    repairs.record(state, 'Required fields remain unresolved after the same corrective feedback');
    const answer = await ask(PLAN_REPAIR_SYSTEM, `${base}\n\nUnresolved requirements:\n${JSON.stringify(pending.map(item => ({ requirement_id: item.id, requirement: item.requirement, original_field: item.field, operator: item.operator, error: item.error })))}`, context, 'Repair required fields');
    if (!object(answer) || !Array.isArray(answer.repairs)) {
      pending.forEach(item => { item.issue = 'invalid_repair_shape'; item.error = 'Return a repairs array naming every unresolved requirement ID'; });
      continue;
    }
    const ids = new Set(pending.map(item => item.id));
    const counts = new Map();
    for (const repair of answer.repairs) if (object(repair)) counts.set(repair.requirement_id, (counts.get(repair.requirement_id) || 0) + 1);
    const invalid = answer.repairs.some(repair => !object(repair) || !ids.has(repair.requirement_id) || counts.get(repair.requirement_id) !== 1 || Object.keys(repair).some(key => !['requirement_id', 'field', 'operator', 'unexpressible_reason'].includes(key)) || (text(repair.unexpressible_reason) ? repair.field !== undefined || repair.operator !== undefined : repair.field === undefined && repair.operator === undefined));
    if (invalid) {
      pending.forEach(item => { item.issue = 'invalid_repair_identity_or_shape'; item.error = 'Use each original unresolved ID once, with either field or unexpressible_reason; operators and requirements cannot change'; });
      continue;
    }
    for (const item of pending) {
      const repair = answer.repairs.find(repair => repair.requirement_id === item.id);
      if (!repair) { item.issue = 'missing_requirement_repair'; item.error = 'This required criterion was omitted from the repair'; continue; }
      if (text(repair.unexpressible_reason)) { item.status = 'unexpressible'; item.error = repair.unexpressible_reason; continue; }
      if (item.field && adapter.field(item.field) && repair.field !== undefined && repair.field !== item.field) { item.issue = 'changed_valid_field'; item.error = 'A known field cannot change while repairing another part of the requirement'; continue; }
      if (['AND', 'NOT'].includes(item.operator) && repair.operator !== undefined && repair.operator !== item.operator) { item.issue = 'changed_valid_operator'; item.error = 'The original valid inclusion/exclusion operator must remain unchanged'; continue; }
      const field = repair.field === undefined ? item.field : repair.field;
      const operator = repair.operator === undefined ? item.operator : repair.operator;
      if (['AND', 'NOT'].includes(operator)) item.operator = operator;
      if (!text(field) || !adapter.field(field)) { item.issue = 'unknown_field'; item.error = `Unknown field ${JSON.stringify(field)}`; continue; }
      item.field = field;
      if (!['AND', 'NOT'].includes(operator)) { item.issue = 'invalid_operator'; item.error = `Invalid operator ${JSON.stringify(operator)}; choose AND or NOT`; continue; }
      item.field = field; item.operator = operator; item.status = 'planned'; item.error = null; delete item.issue;
    }
  }
  return { understanding: plan.understanding || '' };
}

function fieldChoice(adapter, field, answer) {
  if (!object(answer) || !Array.isArray(answer.choices)) return { error: 'Return a choices array', state: { issue: 'invalid_choices_shape' } };
  const choices = [], seen = new Set();
  for (const choice of answer.choices) {
    if (!object(choice) || !Number.isInteger(choice.level) || choice.level < 1 || choice.level > field.levels.length) return { error: `Every choice level must exist in the ${field.levels.length}-level schema`, state: { issue: 'unknown_level' } };
    if (seen.has(choice.level)) return { error: 'A level must appear only once; list multiple allowed values together', state: { issue: 'duplicate_level' } };
    if (!Array.isArray(choice.values) || choice.values.some(value => !text(value))) return { error: 'Level values must be an array of nonempty exact option names', state: { issue: 'invalid_values_shape' } };
    seen.add(choice.level); choices[choice.level - 1] = choice.values;
  }
  const canonical = adapter.canonicalize(field.name, choices);
  if (!canonical.error) return { canonical };
  const validPrefixes = [];
  for (let depth = 1; depth <= field.levels.length; depth++) {
    const prefix = adapter.canonicalize(field.name, choices.slice(0, depth));
    if (!prefix.error) validPrefixes.push({ depth, path: prefix.path.map(value => Array.isArray(value) ? [...value].sort() : value) });
  }
  return { error: canonical.error, state: { issue: 'invalid_option_path', validPrefixes } };
}

async function walkField(adapter, goal, requirement, context) {
  const field = adapter.field(requirement.field);
  const base = `Question: "${goal}"\nRequirement ${requirement.id}: "${requirement.requirement}"${requirement.operator === 'NOT' ? ' (exclude this selection)' : ''}\n\n${adapter.fieldTree(field)}`;
  const progress = new RepairProgress();
  let feedback = '';
  for (;;) {
    const answer = await ask(TRAIL_SYSTEM, `${base}${feedback}`, context, feedback ? 'Trail again' : 'Trail');
    const checked = fieldChoice(adapter, field, answer);
    if (checked.canonical) return { ...checked.canonical, operator: requirement.operator, requirement: requirement.requirement, requirement_id: requirement.id, why: answer.why || '' };
    requirement.status = 'unresolved'; requirement.error = checked.error;
    progress.record({ requirement_id: requirement.id, ...checked.state }, `${requirement.requirement}: the option repair repeated without new validated choices`);
    await context.onStep?.({ stage: 'reasoning_step', label: 'Correct required filter', message: `${field.name}: ${checked.error}` });
    feedback = `\n\nThe previous choices were invalid: ${checked.error}. Correct this requirement using the exact schema. Unknown or duplicate levels cannot be ignored and this required filter cannot be dropped.`;
  }
}

async function deepResearchTrail({ goal, mode: requestedMode = 'online', study = null }, ctx = {}, adapter = require('../../hpa/searchAdapter')) {
  const { onStep, includeRows = false } = ctx;
  const startedAt = Date.now();
  const stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, perStep: {} };
  const requirements = [], filters = [];
  let queryAttempted = false, queryExecuted = false;
  await onStep?.({ stage: 'start', message: `Research agent (trail) activated. Goal: "${goal}"` });
  try {
    const context = { onStep, stats, control: createAgentControl({ ctx, stats, agentKey: 'deep_research_hpa' }) };
    await onStep?.({ stage: 'planning_step', label: 'Plan', message: `Reading the ${adapter.name} schema` });
    const plan = await planFilters(adapter, goal, context, requirements, typeof study === 'string' && study.trim() ? study.trim() : null);
    if (plan.understanding) await onStep?.({ stage: 'reasoning_step', label: 'Understood', message: plan.understanding });
    if (requirements.some(item => item.status !== 'planned')) throw new ResearchStop('unexpressible_requirements', 'The requested cohort includes criteria that the source schema cannot express');

    for (const item of requirements) {
      await onStep?.({ stage: 'planning_step', label: 'Trail', message: `${item.field} for "${item.requirement}"` });
      const filled = await walkField(adapter, goal, item, context);
      await onStep?.({ stage: 'selection_step', label: 'Chosen', message: `${adapter.describe([filled])}${filled.why ? ' — ' + filled.why : ''}` });
      filters.push(filled); item.status = 'validated'; item.error = null;
    }
    if (!filters.length || requirements.some(item => item.status !== 'validated')) throw new ResearchStop('unresolved_requirements', 'Every required criterion must be validated before running the requested cohort query');

    const url = adapter.compose(filters);
    if (!url) throw new Error('The filters compose to no query.');
    await context.control.checkpoint('Execute validated query');
    await onStep?.({ stage: 'execution_step', label: 'URL Ready', message: url });
    queryAttempted = true;
    const run = await adapter.execute(filters, url, requestedMode);
    queryExecuted = true;
    const summary = adapter.summarize(run.rows);
    await onStep?.({ stage: 'execution_step', label: 'Result', message: `${summary.count} rows (${run.mode}${run.version ? ', ' + run.version : ''})` });
    const finishedAt = Date.now();
    await onStep?.({ stage: 'planning_step', label: 'Timer', message: `Total runtime: ${((finishedAt - startedAt) / 1000).toFixed(1)}s` });
    await onStep?.({ stage: 'planning_step', label: 'Token Usage', message: `Input tokens: ${stats.promptTokens} | Output tokens: ${stats.completionTokens} | Total: ${stats.totalTokens}` });
    return {
      status: 'ok',
      outcome: 'completed',
      summary_md: `**Research Complete for "${goal}"**\n\nFound **${summary.count}** genes matching the criteria.\n\n**Query:** ${adapter.describe(filters)}\n\n**Search URLs:**\n- ${url}`,
      result: {
        rows_found: summary.count, preview: summary.top, search_urls: [url], validation_passed: true, validation_details: null, attempts: 1, query_attempted: queryAttempted, query_executed: queryExecuted,
        mode: run.mode, hpa_version: run.version, source_files: run.source_files, plan: adapter.describe(filters), understanding: plan.understanding,
        trail: filters.map(f => ({ requirement_id: f.requirement_id, requirement: f.requirement, field: f.field, path: f.path, operator: f.operator, why: f.why })),
        requirements, unresolved_requirements: [], not_expressible: [],
        ...(includeRows ? { rows: run.rows } : {})
      },
      tokens: { prompt: stats.promptTokens, completion: stats.completionTokens, total: stats.totalTokens },
      started_unix_ms: startedAt,
      finished_unix_ms: finishedAt
    };
  } catch (err) {
    await onStep?.({ stage: 'error', label: 'Error', message: err.message });
    const unresolved = requirements.filter(item => item.status !== 'validated').map(item => ({ ...item, status: item.status === 'unexpressible' ? 'unexpressible' : 'unresolved', error: item.error || err.message }));
    if (!unresolved.length) unresolved.push({ id: 'goal', requirement: goal, status: 'unresolved', error: err.message });
    return {
      status: 'error', outcome: 'incomplete', stop_reason: err.reason || 'source_or_validation_error', error: err.message,
      result: { validation_passed: false, query_attempted: queryAttempted, query_executed: queryExecuted, rows_found: null, requirements, unresolved_requirements: unresolved, not_expressible: unresolved.filter(item => item.status === 'unexpressible').map(item => ({ requirement: item.requirement, why: item.error })), trail: filters.map(filter => ({ requirement_id: filter.requirement_id, requirement: filter.requirement, field: filter.field, path: filter.path, operator: filter.operator })) },
      tokens: { prompt: stats.promptTokens, completion: stats.completionTokens, total: stats.totalTokens }, started_unix_ms: startedAt, finished_unix_ms: Date.now()
    };
  }
}

module.exports = deepResearchTrail;
