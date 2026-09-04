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

const PLAN_SYSTEM = `You are turning a scientist's question into a query on a database. You are given the database's search schema: its categories, every filter field, the levels of each field and how many options each level has, plus the database's own definitions of its terms.

Decide which fields the question needs. Every filter you name is filled in afterwards from that field's actual options, so here you choose fields, not values.
Return JSON: { "understanding": "<what the question asks, in the database's terms>", "filters": [ { "requirement": "<the part of the question this filter serves>", "field": "<exact field name>", "operator": "AND" | "NOT", "why": "<why this field, in one sentence>" } ], "cannot": [ { "requirement": "<part of the question>", "why": "<why no field expresses it>" } ] }
Rules:
- Use field names exactly as written in the schema.
- One filter per requirement the question states, and no filter for anything it does not state; a requirement that needs two fields gets two filters.
- A requirement is "cannot" only when no field expresses it; if a field's definition covers it, it is a filter, not "cannot".
- Operator NOT only when the question excludes what the field describes; a requirement phrased with "not" is often a value inside a field (a "not detected" category), which stays AND.
- When the schema has no field for a requirement, put the requirement in "cannot" with the reason; do not approximate it with a different field.
- Prefer the field whose definition matches what the question means over the field whose name resembles the question's words.`;

const TRAIL_SYSTEM = `You are filling in one filter of a database query. You are given the question, the requirement this filter serves, and the field: its levels and every option at each level, with the database's own definitions where it gives them.

Return JSON: { "choices": [ { "level": 1, "values": ["<option>"] }, { "level": 2, "values": ["<option>"] } ], "why": "<one sentence>" }
Rules:
- Use option names exactly as written.
- A level marked "one value" takes exactly one; "several values allowed" may take more, meaning any of them.
- Leave a level out to leave it unrestricted; level 2 options may depend on the level 1 value. When the question means "all of them" or does not restrict a level, leave that level out rather than listing every option.
- Choose by the definitions: the option whose definition is what the question means, not the option whose name shares words with the question.
- Choose the smallest set of options that means exactly what the question says. Do not add neighbouring categories "to be safe": a question about where expression peaks is not a question about enrichment, and a question about enrichment is not a question about enhancement.
- If several options together are what the question means (a group of cell types, a set of cohorts, two categories that both count), list them all on a level that allows several values.`;

async function ask(system, user, onStep, label, stats) {
  const result = await invokeLLM(system, user, onStep, label, stats);
  return result && typeof result === 'object' ? result : {};
}

async function planFilters(adapter, goal, onStep, stats) {
  const schema = adapter.overview();
  let user = `Question: "${goal}"\n\nSchema:\n${schema}`;
  let plan = await ask(PLAN_SYSTEM, user, onStep, 'Plan', stats);
  const check = p => (Array.isArray(p.filters) ? p.filters : []).map(f => ({ ...f, known: Boolean(adapter.field(f?.field)) }));
  let filters = check(plan);
  const unknown = filters.filter(f => !f.known);
  if (unknown.length) {
    await onStep?.({ stage: 'reasoning_step', label: 'Plan again', message: `Unknown fields: ${unknown.map(f => f.field).join(', ')}` });
    user += `\n\nYour previous answer named fields that are not in the schema: ${unknown.map(f => `"${f.field}"`).join(', ')}. Answer again using exact field names, or move the requirement to "cannot".`;
    plan = await ask(PLAN_SYSTEM, user, onStep, 'Plan again', stats);
    filters = check(plan).filter(f => f.known);
  }
  return { understanding: plan.understanding || '', filters: filters.filter(f => f.known), cannot: Array.isArray(plan.cannot) ? plan.cannot.filter(c => c && c.requirement) : [] };
}

async function walkField(adapter, goal, filter, onStep, stats) {
  const f = adapter.field(filter.field);
  const tree = adapter.fieldTree(f);
  let user = `Question: "${goal}"\nRequirement this filter serves: "${filter.requirement}"${filter.operator === 'NOT' ? ' (this filter is negated: the query excludes what it selects)' : ''}\n\n${tree}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await ask(TRAIL_SYSTEM, user, onStep, attempt ? 'Trail again' : 'Trail', stats);
    const choices = [];
    for (const c of Array.isArray(answer.choices) ? answer.choices : []) {
      const level = Number(c?.level);
      if (Number.isInteger(level) && level >= 1 && level <= f.levels.length) choices[level - 1] = c.values;
    }
    const canonical = adapter.canonicalize(f.name, choices);
    if (!canonical.error) return { ...canonical, operator: filter.operator === 'NOT' ? 'NOT' : 'AND', requirement: filter.requirement, why: answer.why || '' };
    await onStep?.({ stage: 'reasoning_step', label: 'Trail again', message: `${f.name}: ${canonical.error}` });
    user += `\n\nYour previous answer was not valid: ${canonical.error}. Answer again with exact option names.`;
  }
  return null;
}

async function deepResearchTrail({ goal, mode: requestedMode = 'online' }, { onStep, includeRows = false } = {}, adapter = require('../../hpa/searchAdapter')) {
  const startedAt = Date.now();
  const stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, perStep: {} };
  await onStep?.({ stage: 'start', message: `Research agent (trail) activated. Goal: "${goal}"` });
  try {
    await onStep?.({ stage: 'planning_step', label: 'Plan', message: `Reading the ${adapter.name} schema` });
    const plan = await planFilters(adapter, goal, onStep, stats);
    if (plan.understanding) await onStep?.({ stage: 'reasoning_step', label: 'Understood', message: plan.understanding });
    for (const c of plan.cannot) await onStep?.({ stage: 'reasoning_step', label: 'Not expressible', message: `${c.requirement}: ${c.why || ''}` });
    if (!plan.filters.length) throw new Error(plan.cannot.length ? `The schema cannot express this question: ${plan.cannot.map(c => c.requirement).join('; ')}` : 'No filter could be planned.');

    const filters = [];
    for (const item of plan.filters) {
      await onStep?.({ stage: 'planning_step', label: 'Trail', message: `${item.field} for "${item.requirement}"` });
      const filled = await walkField(adapter, goal, item, onStep, stats);
      if (!filled) { await onStep?.({ stage: 'reasoning_step', label: 'Dropped', message: `${item.field}: no valid choice after two attempts` }); continue; }
      await onStep?.({ stage: 'selection_step', label: 'Chosen', message: `${adapter.describe([filled])}${filled.why ? ' — ' + filled.why : ''}` });
      filters.push(filled);
    }
    if (!filters.length) throw new Error('No filter could be filled in.');

    const url = adapter.compose(filters);
    if (!url) throw new Error('The filters compose to no query.');
    await onStep?.({ stage: 'execution_step', label: 'URL Ready', message: url });
    const run = await adapter.execute(filters, url, requestedMode);
    const summary = adapter.summarize(run.rows);
    await onStep?.({ stage: 'execution_step', label: 'Result', message: `${summary.count} rows (${run.mode}${run.version ? ', ' + run.version : ''})` });
    const finishedAt = Date.now();
    await onStep?.({ stage: 'planning_step', label: 'Timer', message: `Total runtime: ${((finishedAt - startedAt) / 1000).toFixed(1)}s` });
    await onStep?.({ stage: 'planning_step', label: 'Token Usage', message: `Input tokens: ${stats.promptTokens} | Output tokens: ${stats.completionTokens} | Total: ${stats.totalTokens}` });
    const cannotNote = plan.cannot.length ? `\n\n**Not expressible in this database:**\n${plan.cannot.map(c => `- ${c.requirement}${c.why ? ': ' + c.why : ''}`).join('\n')}` : '';
    return {
      status: 'ok',
      summary_md: `**Research Complete for "${goal}"**\n\nFound **${summary.count}** genes matching the criteria.\n\n**Query:** ${adapter.describe(filters)}\n\n**Search URLs:**\n- ${url}${cannotNote}`,
      result: {
        rows_found: summary.count, preview: summary.top, search_urls: [url], validation_passed: true, validation_details: null, attempts: 1,
        mode: run.mode, hpa_version: run.version, plan: adapter.describe(filters), understanding: plan.understanding,
        trail: filters.map(f => ({ requirement: f.requirement, field: f.field, path: f.path, operator: f.operator, why: f.why })),
        not_expressible: plan.cannot,
        ...(includeRows ? { rows: run.rows } : {})
      },
      tokens: { prompt: stats.promptTokens, completion: stats.completionTokens, total: stats.totalTokens },
      started_unix_ms: startedAt,
      finished_unix_ms: finishedAt
    };
  } catch (err) {
    await onStep?.({ stage: 'error', label: 'Error', message: err.message });
    return { status: 'error', error: err.message, tokens: { prompt: stats.promptTokens, completion: stats.completionTokens, total: stats.totalTokens } };
  }
}

module.exports = deepResearchTrail;
