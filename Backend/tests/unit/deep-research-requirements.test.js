'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');

async function runStudy({ decide, ctx = {}, rows = [{ gene: 'RESULT', ensembl: 'ID_RESULT' }], executeError = null }) {
  const filename = require.resolve('../../src/system/agents/deepResearchTrail');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = loaded.require.bind(loaded);
  const calls = [], executions = [];
  loaded.require = name => name === '../../inference/jsonCall' ? { async jsonCall(system, user, onStep, label, stats) {
    calls.push({ system, user, label });
    assert.ok(calls.length < 30, 'A test response cycle must terminate without an arbitrary runtime retry ceiling');
    stats.promptTokens += 4; stats.completionTokens += 1; stats.totalTokens += 5;
    return decide({ system, user, label, call: calls.length });
  } } : realRequire(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const fields = ['Selection A', 'Selection B'].map(name => ({ name, levels: [{}, {}, {}] }));
  const options = [['A1', 'A2'], ['B1', 'B2'], ['C1', 'C2']];
  const adapter = {
    name: 'Synthetic source schema',
    overview() { return 'Selection A and Selection B each have three explicit levels.'; },
    field(name) { return fields.find(field => field.name === name); },
    fieldTree(field) { return `${field.name}: level 1 A1/A2, level 2 B1/B2, level 3 C1/C2`; },
    canonicalize(field, choices) {
      const path = [];
      for (let level = 0; level < 3; level++) {
        const wanted = choices[level] || [];
        if (!wanted.length) { path.push(null); continue; }
        if (wanted.some(value => !options[level].includes(value))) return { error: `Unknown option at level ${level + 1}` };
        path.push(wanted.length === 1 ? wanted[0] : [...wanted]);
      }
      while (path.at(-1) === null) path.pop();
      return path.length ? { field, path } : { error: 'No option chosen' };
    },
    compose(filters) { return `https://example.invalid/search?filters=${encodeURIComponent(JSON.stringify(filters))}`; },
    describe(filters) { return filters.map(filter => `${filter.operator} ${filter.field} ${JSON.stringify(filter.path)}`).join('; '); },
    async execute(filters, url, mode) { executions.push({ filters: structuredClone(filters), mode }); if (executeError) throw new Error(executeError); return { rows, mode, version: 'fixture-release' }; },
    summarize(values) { return { count: values.length, top: values }; }
  };
  const result = await loaded.exports({ goal: 'Apply both exact requested criteria.', mode: 'offline' }, { includeRows: true, ...ctx }, adapter);
  return { result, calls, executions };
}

const filter = (field, requirement, operator = 'AND') => ({ field, requirement, operator });
const plan = (...filters) => ({ understanding: 'Exact requested cohort', filters, cannot: [] });
const choose = (...values) => ({ choices: values.map((value, index) => ({ level: index + 1, values: [value] })) });

test('an unresolved original field cannot disappear when repair omits its requirement ID', async () => {
  const { result, executions, calls } = await runStudy({ decide: ({ call }) => call === 1
    ? plan(filter('Selection A', 'keep this criterion'), filter('unknown field', 'also require this criterion'))
    : { repairs: [] } });
  assert.equal(executions.length, 0); assert.equal(result.status, 'error');
  assert.equal(result.outcome, 'incomplete'); assert.equal(result.stop_reason, 'no_progress_cycle');
  assert.equal(result.result.validation_passed, false);
  assert.ok(result.result.unresolved_requirements.some(item => item.id === 'r2' && item.requirement === 'also require this criterion'));
  assert.match(calls[1].user, /"requirement_id":"r2"/);
});

test('different misspelled fields do not manufacture productive retries', async () => {
  const { result, calls, executions } = await runStudy({ decide: ({ call }) => call === 1
    ? plan(filter('wrong first name', 'exact requirement'))
    : { repairs: [{ requirement_id: 'r1', field: `another invalid name ${call}` }] } });
  assert.equal(calls.length, 2); assert.equal(executions.length, 0);
  assert.equal(result.stop_reason, 'no_progress_cycle');
  assert.equal(result.result.unresolved_requirements[0].requirement, 'exact requirement');
});

test('field repair preserves the original exclusion operator and all other requirements', async () => {
  const { result, executions } = await runStudy({ decide: ({ call }) => call === 1
    ? plan(filter('Selection A', 'include the first criterion'), filter('unknown name', 'exclude the second criterion', 'NOT'))
    : call === 2 ? { repairs: [{ requirement_id: 'r2', field: 'Selection B' }] } : choose('A1') });
  assert.equal(result.status, 'ok'); assert.equal(result.result.validation_passed, true);
  assert.equal(executions.length, 1); assert.equal(executions[0].filters.length, 2);
  assert.equal(executions[0].filters[1].operator, 'NOT');
  assert.deepEqual(result.result.requirements.map(item => item.status), ['validated', 'validated']);
});

test('an invalid field shape retains its criterion and repair cannot change a valid exclusion', async () => {
  const failed = await runStudy({ decide: ({ call }) => call === 1 ? plan(filter(null, 'the original excluded criterion', 'NOT')) : { repairs: [{ requirement_id: 'r1', field: 'Selection A', operator: 'AND' }] } });
  assert.equal(failed.executions.length, 0); assert.equal(failed.result.stop_reason, 'no_progress_cycle');
  assert.equal(failed.result.result.unresolved_requirements[0].operator, 'NOT');
  assert.equal(failed.result.result.unresolved_requirements[0].requirement, 'the original excluded criterion');
  const fixed = await runStudy({ decide: ({ call }) => call === 1 ? plan(filter(null, 'exact criterion', 'invalid operator'))
    : call === 2 ? { repairs: [{ requirement_id: 'r1', field: 'Selection A' }] }
      : call === 3 ? { repairs: [{ requirement_id: 'r1', operator: 'NOT' }] } : choose('A1') });
  assert.equal(fixed.result.status, 'ok'); assert.equal(fixed.executions[0].filters[0].operator, 'NOT');
});

test('an unexpressible criterion prevents a partial query from masquerading as the requested cohort', async () => {
  const { result, executions, calls } = await runStudy({ decide: () => ({ ...plan(filter('Selection A', 'first criterion')), cannot: [{ requirement: 'unavailable requested evidence', why: 'No field supplies this evidence.' }] }) });
  assert.equal(calls.length, 1); assert.equal(executions.length, 0);
  assert.equal(result.stop_reason, 'unexpressible_requirements');
  assert.equal(result.result.validation_passed, false);
  assert.equal(result.result.not_expressible[0].requirement, 'unavailable requested evidence');
});

test('a failed required option path does not execute the filters completed before it', async () => {
  const { result, executions } = await runStudy({ decide: ({ call }) => call === 1
    ? plan(filter('Selection A', 'first criterion'), filter('Selection B', 'second criterion'))
    : call === 2 ? choose('A1') : choose('WRONG') });
  assert.equal(executions.length, 0);
  assert.equal(result.stop_reason, 'no_progress_cycle');
  assert.equal(result.result.trail.length, 1);
  assert.equal(result.result.unresolved_requirements[0].requirement, 'second criterion');
  assert.equal(result.result.query_executed, false);
});

test('productive validation of deeper option prefixes can exceed the old two-attempt limit', async () => {
  const { result, calls, executions } = await runStudy({ decide: ({ call }) => call === 1
    ? plan(filter('Selection A', 'multilevel criterion'))
    : call === 2 ? choose('WRONG')
      : call === 3 ? choose('A1', 'WRONG')
        : call === 4 ? choose('A1', 'B1', 'WRONG') : choose('A1', 'B1', 'C1') });
  assert.equal(result.status, 'ok'); assert.equal(calls.length, 5); assert.equal(executions.length, 1);
  assert.deepEqual(executions[0].filters[0].path, ['A1', 'B1', 'C1']);
});

test('unknown and duplicate levels cannot be ignored to validate an incomplete path', async () => {
  for (const choices of [
    [{ level: 1, values: ['A1'] }, { level: 99, values: ['B1'] }],
    [{ level: 1, values: ['A1'] }, { level: 1, values: ['A2'] }]
  ]) {
    const { result, executions } = await runStudy({ decide: ({ call }) => call === 1 ? plan(filter('Selection A', 'exact criterion')) : { choices } });
    assert.equal(executions.length, 0); assert.equal(result.stop_reason, 'no_progress_cycle');
  }
});

test('a malformed plan remains an explicit error without a fabricated unrestricted query', async () => {
  const { result, calls, executions } = await runStudy({ decide: () => ({}) });
  assert.equal(calls.length, 2); assert.equal(executions.length, 0);
  assert.equal(result.stop_reason, 'no_progress_cycle');
  assert.equal(result.result.unresolved_requirements[0].id, 'goal');
});

test('zero matched rows is a valid complete search and never triggers query broadening', async () => {
  const { result, calls, executions } = await runStudy({ rows: [], decide: ({ call }) => call === 1 ? plan(filter('Selection A', 'criterion yielding no matches')) : choose('A1') });
  assert.equal(calls.length, 2); assert.equal(executions.length, 1);
  assert.equal(result.status, 'ok'); assert.equal(result.result.rows_found, 0);
  assert.equal(result.result.validation_passed, true); assert.deepEqual(result.result.rows, []);
});

test('caller token budgets stop additional inference and retain the unresolved criterion', async () => {
  const { result, calls, executions } = await runStudy({ ctx: { budget: { total_tokens: 5 } }, decide: () => plan(filter('Selection A', 'criterion still awaiting options')) });
  assert.equal(calls.length, 1); assert.equal(executions.length, 0);
  assert.equal(result.stop_reason, 'token_budget_exhausted'); assert.equal(result.tokens.total, 5);
  assert.equal(result.result.unresolved_requirements[0].requirement, 'criterion still awaiting options');
  const zero = await runStudy({ ctx: { budget: { total_tokens: 0 } }, decide: () => { throw new Error('Must not infer without budget'); } });
  assert.equal(zero.calls.length, 0); assert.equal(zero.result.stop_reason, 'token_budget_exhausted');
});

test('caller deadline and cancellation prevent further work without altering the cohort criteria', async () => {
  const expired = await runStudy({ ctx: { budget: { deadline_unix_ms: 1 } }, decide: () => { throw new Error('Expired deadline'); } });
  assert.equal(expired.calls.length, 0); assert.equal(expired.result.stop_reason, 'deadline_reached');
  const controller = new AbortController();
  const cancelled = await runStudy({ ctx: { signal: controller.signal }, decide: () => { controller.abort(); return plan(filter('Selection A', 'criterion')); } });
  assert.equal(cancelled.calls.length, 1); assert.equal(cancelled.executions.length, 0); assert.equal(cancelled.result.stop_reason, 'cancelled');
});

test('shared control admission can stop a child without using a private local turn cap', async () => {
  const checkpoints = [];
  const { result, calls, executions } = await runStudy({ ctx: { runControl: { async checkpoint(event) { checkpoints.push(event); return event.phase === 'Trail' && event.beforeInference ? { allowed: false, reason: 'shared_tokens_exhausted' } : { allowed: true }; } } }, decide: () => plan(filter('Selection A', 'required criterion')) });
  assert.equal(calls.length, 1); assert.equal(executions.length, 0);
  assert.equal(result.stop_reason, 'shared_tokens_exhausted');
  assert.ok(checkpoints.every(event => event.agentKey === 'deep_research_hpa'));
});

test('an attempted source query failure is distinguished from refusing an unvalidated query', async () => {
  const { result, executions } = await runStudy({ executeError: 'source unavailable', decide: ({ call }) => call === 1 ? plan(filter('Selection A', 'criterion')) : choose('A1') });
  assert.equal(executions.length, 1);
  assert.equal(result.result.query_attempted, true); assert.equal(result.result.query_executed, false);
  assert.equal(result.outcome, 'incomplete'); assert.equal(result.result.validation_passed, false);
});
