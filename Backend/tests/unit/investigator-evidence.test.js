'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const sourceAdapter = require('../../src/hpa/geneDataAdapter');

async function setup({ sources, plan, answer, ctx = {} }) {
  const filename = require.resolve('../../src/system/agents/investigatorTrail');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireOriginal = loaded.require.bind(loaded);
  const requests = [], events = [], reads = [];
  const stubs = {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test-release' }; } },
    '../../inference/jsonCall': { async jsonCall(system, user, onStep, label, stats) { requests.push({ system, user }); stats.promptTokens += 4; stats.completionTokens += 1; stats.totalTokens += 5; return requests.length === 1 ? plan : answer({ system, user, attempt: requests.length - 1 }); } }
  };
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : requireOriginal(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const adapter = {
    async resolveGene() { return { gene: 'ONE', ensembl: 'ID1' }; },
    async overview() { return sources.map(source => `${source.entry.file}: ${source.entry.columns.join(', ')}`).join('\n'); },
    async entry(file) { return sources.find(source => source.entry.file === file)?.entry; },
    async read(gene, file) { const source = sources.find(source => source.entry.file === file); reads.push(file); return { entry: source.entry, rows: source.rows }; },
    applyWhere: sourceAdapter.applyWhere, render: sourceAdapter.render, cited: sourceAdapter.cited,
    pageUrl() { return 'https://example.invalid/source'; }
  };
  const result = await loaded.exports({ gene: 'ONE', question: 'Answer the specified source question.' }, { onStep: event => events.push(event), ...ctx }, adapter);
  return { result, requests, events, reads };
}

const source = (file = 'source.tsv', rows = [{ Gene: 'ID1', Tissue: 'A', units: '12' }, { Gene: 'ID1', Tissue: 'B', units: '9' }]) => ({ entry: { file, title: file, key: 'ensembl', columns: ['Gene', 'Tissue', 'units'] }, rows });
const rowAnswer = overrides => ({ found: true, answer: 'Observed 12 units in A.', value: '12', entity: 'A', table: 'source.tsv', cited_row: 'A | 12', notes: [], ...overrides });

test('an empty explicit source filter remains empty and reports source-scoped coverage', async () => {
  const where = [{ column: 'Tissue', op: '=', value: 'missing tissue' }];
  const { result, requests, events } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv', where }] }, answer: ({ user }) => {
    assert.match(user, /"source_rows":2/);
    assert.match(user, /"matching_rows":0/);
    assert.doesNotMatch(user, /A \| 12|B \| 9/);
    return rowAnswer({ found: false, answer: 'The gene was never experimentally assayed.', value: null, cited_row: null });
  } });
  assert.equal(requests.length, 2);
  assert.equal(result.evidence_status, 'no_matching_rows');
  assert.equal(result.found, false); assert.equal(result.grounded, true);
  assert.deepEqual(result.coverage[0].where, where);
  assert.equal(result.coverage[0].source_rows, 2); assert.equal(result.coverage[0].matching_rows, 0);
  assert.match(result.answer, /none match/);
  assert.doesNotMatch(result.answer, /never experimentally/);
  assert.ok(events.filter(event => event.stage === 'not_found').every(event => !event.message.includes('never experimentally')));
});

test('no gene rows is distinguished from a filter with zero matches', async () => {
  const { result } = await setup({ sources: [source('source.tsv', [])], plan: { reads: [{ table: 'source.tsv' }] }, answer: () => rowAnswer({ found: false, value: null, cited_row: null, answer: 'No rows, therefore biologically absent.' }) });
  assert.equal(result.evidence_status, 'no_gene_rows');
  assert.equal(result.coverage[0].source_rows, 0); assert.equal(result.coverage[0].matching_rows, 0);
  assert.equal(result.extracted_value, null);
  assert.match(result.answer, /No rows are recorded.*in this release/);
  assert.doesNotMatch(result.answer, /biologically absent/);
});

test('a zero row-count answer can cite exact runtime coverage without inventing a measurement row', async () => {
  const { result } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv', where: [{ column: 'units', op: '>', value: 100 }] }] }, answer: () => rowAnswer({ answer: 'Zero source rows exceed the specified threshold.', value: 0, cited_row: null, cited_coverage: { read_id: 'r1', table: 'source.tsv', metric: 'matching_rows', value: 0 } }) });
  assert.equal(result.found, true); assert.equal(result.grounded, true);
  assert.equal(result.evidence_status, 'coverage'); assert.equal(result.extracted_value, 0);
  assert.equal(result.cited_row, null);
  assert.deepEqual(result.cited_coverage, { read_id: 'r1', table: 'source.tsv', metric: 'matching_rows', value: 0 });
});

test('unknown answer sources cannot borrow a valid row citation from the first source', async () => {
  const { result, requests } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv' }] }, answer: () => rowAnswer({ table: 'unread_source.tsv' }) });
  assert.equal(requests.length, 3);
  assert.equal(result.found, false); assert.equal(result.grounded, false);
  assert.equal(result.evidence_status, 'invalid_citation');
  assert.equal(result.source_section, null); assert.equal(result.cited_row, null); assert.equal(result.extracted_value, null);
  assert.doesNotMatch(result.answer, /Observed 12/);
});

test('coverage citation rejects wrong counts, source names, metrics and ambiguous repeated reads', async () => {
  for (const cited_coverage of [
    { read_id: 'r1', table: 'source.tsv', metric: 'matching_rows', value: 99 },
    { read_id: 'r1', table: 'wrong.tsv', metric: 'matching_rows', value: 2 },
    { read_id: 'r1', table: 'source.tsv', metric: 'distinct_entities', value: 2 },
    { table: 'source.tsv', metric: 'matching_rows', value: 2 }
  ]) {
    const { result } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv', rows: 1, offset: 0 }, { table: 'source.tsv', rows: 1, offset: 1 }] }, answer: () => rowAnswer({ value: cited_coverage.value, cited_row: null, cited_coverage }) });
    assert.equal(result.found, false, JSON.stringify(cited_coverage));
    assert.equal(result.evidence_status, 'invalid_citation');
    assert.equal(result.cited_coverage, null);
  }
});

test('invalid source filters fail explicitly and never answer from unfiltered rows', async () => {
  const { result, requests } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv', where: [{ column: 'invented column', op: '=', value: 'A' }] }] }, answer: () => { throw new Error('Must not answer from a broadened source'); } });
  assert.equal(requests.length, 1);
  assert.equal(result.found, false); assert.equal(result.evidence_status, 'source_error');
  assert.match(result.error, /column/i);
});

test('all explicitly selected sources are read and a citation selects the exact later source', async () => {
  const sources = ['one.tsv', 'two.tsv', 'three.tsv', 'four.tsv'].map(file => source(file));
  const { result, reads } = await setup({ sources, plan: { reads: sources.map(source => ({ table: source.entry.file })) }, answer: () => rowAnswer({ table: 'four.tsv' }) });
  assert.deepEqual(reads, sources.map(source => source.entry.file));
  assert.equal(result.found, true);
  assert.equal(result.evidence_status, 'observed');
  assert.match(result.source_section, /four.tsv/);
  assert.equal(result.coverage.length, 4);
});

test('an unknown planned table is an explicit error rather than a silently omitted requirement', async () => {
  const { result, requests } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv' }, { table: 'not_in_catalog.tsv' }] }, answer: () => { throw new Error('An invalid plan must not silently lose a requested source'); } });
  assert.equal(requests.length, 1);
  assert.equal(result.evidence_status, 'source_error');
  assert.match(result.error, /Unknown source table/);
});

test('explicit source pages reject citations from rows the model did not see', async () => {
  const { result, requests } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv', columns: ['Tissue', 'units'], rows: 1, offset: 1 }] }, answer: ({ user }) => {
    assert.match(user, /B \| 9/); assert.doesNotMatch(user, /A \| 12/);
    return rowAnswer();
  } });
  assert.equal(requests.length, 3);
  assert.equal(result.found, false); assert.equal(result.evidence_status, 'invalid_citation');
  assert.equal(result.coverage[0].source_rows, 2); assert.equal(result.coverage[0].matching_rows, 2); assert.equal(result.coverage[0].shown_rows, 1);
  assert.equal(result.coverage[0].complete_rows, false);
});

test('missing selected source fields remain distinct from recorded numeric zero', async () => {
  const missing = { entry: { file: 'master.tsv', title: 'Master', key: 'master', columns: ['Gene', 'Unrecorded field', 'Zero field'] }, rows: [{ Gene: 'ID1', 'Unrecorded field': '', 'Zero field': '0' }] };
  const absent = await setup({ sources: [missing], plan: { reads: [{ table: 'master.tsv', columns: ['Unrecorded field'] }] }, answer: () => rowAnswer({ table: 'master.tsv', found: false, value: null, answer: 'It was never measured.' }) });
  assert.equal(absent.result.evidence_status, 'no_recorded_values');
  assert.match(absent.result.answer, /no recorded values.*Unrecorded field/);
  assert.doesNotMatch(absent.result.answer, /never measured/);
  assert.deepEqual(absent.result.coverage[0].unrecorded_columns, ['Unrecorded field']);
  const zero = await setup({ sources: [missing], plan: { reads: [{ table: 'master.tsv', columns: ['Zero field'] }] }, answer: () => rowAnswer({ table: 'master.tsv', value: '0', cited_row: 'Zero field: 0', answer: 'The recorded value is zero.' }) });
  assert.equal(zero.result.found, true); assert.equal(zero.result.evidence_status, 'observed');
  assert.equal(zero.result.extracted_value, '0');
});

test('a follow-up source read can provide a citation absent from the first view of the same table', async () => {
  const { result, reads } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv', rows: 1, offset: 1 }] }, answer: ({ attempt }) => attempt === 1
    ? rowAnswer({ found: false, value: null, need_more: { table: 'source.tsv', columns: ['Tissue', 'units'], rows: 1, offset: 0 } })
    : rowAnswer() });
  assert.deepEqual(reads, ['source.tsv', 'source.tsv']);
  assert.equal(result.found, true); assert.equal(result.evidence_status, 'observed');
  assert.equal(result.cited_row, 'A | 12');
  assert.equal(result.coverage.length, 2);
});

test('productive source paging and a citation repair can require more than three answers and one follow-up', async () => {
  const rows = ['A', 'B', 'C', 'D'].map((Tissue, i) => ({ Gene: 'ID1', Tissue, units: String(i + 1) }));
  const { result, requests, reads } = await setup({ sources: [source('source.tsv', rows)], plan: { reads: [{ table: 'source.tsv', rows: 1, offset: 0 }] }, answer: ({ attempt, user }) => {
    if (attempt <= 3) return rowAnswer({ found: false, need_more: { table: 'source.tsv', rows: 1, offset: attempt } });
    assert.match(user, /D \| 4/);
    return rowAnswer({ answer: 'D has 4 units.', entity: 'D', value: '4', cited_row: attempt === 4 ? 'D | wrong' : 'D | 4' });
  } });
  assert.equal(requests.length, 6, 'one plan and five answer calls, without a private ceiling');
  assert.equal(reads.length, 4); assert.equal(result.coverage.length, 4);
  assert.equal(result.found, true); assert.equal(result.cited_row, 'D | 4');
  assert.deepEqual(result.tokens.total, { prompt: 24, completion: 6, total: 30 });
  assert.doesNotMatch(requests[1].system, /one more read/);
});

test('successive repairs of source, row and value preserve validated progress', async () => {
  const { result, requests } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv' }] }, answer: ({ attempt, user }) => {
    if (attempt === 1) return rowAnswer({ table: 'unknown.tsv' });
    if (attempt === 2) return rowAnswer({ cited_row: 'A | absent' });
    if (attempt === 3) return rowAnswer({ value: '999' });
    assert.match(user, /row citation is valid.*value is not recorded/);
    return rowAnswer();
  } });
  assert.equal(requests.length, 5); assert.equal(result.found, true); assert.equal(result.extracted_value, '12');
});

test('equivalent source-view requests cannot manufacture progress or duplicate the evidence context', async () => {
  const { result, requests, reads } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv', columns: ['Tissue', 'units'] }] }, answer: ({ attempt }) => rowAnswer({ found: false, need_more: { table: 'source.tsv', columns: attempt % 2 ? ['units', 'Tissue'] : ['Tissue', 'units'], offset: 0, why: `new wording ${attempt}` } }) });
  assert.equal(requests.length, 3); assert.equal(reads.length, 1);
  assert.equal(result.coverage.length, 1); assert.equal(result.found, false);
  assert.equal(result.incomplete, true); assert.equal(result.stop_reason, 'no_progress_cycle');
});

test('new offsets that reveal the same empty view do not count as new evidence', async () => {
  const { result, requests } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv', rows: 1, offset: 50 }] }, answer: ({ attempt }) => rowAnswer({ found: false, need_more: { table: 'source.tsv', rows: 1, offset: 50 + attempt } }) });
  assert.equal(requests.length, 3); assert.equal(result.coverage.length, 1);
  assert.equal(result.stop_reason, 'no_progress_cycle'); assert.equal(result.found, false);
});

test('changing invalid source spelling does not reset a citation repair cycle', async () => {
  const { result, requests } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv' }] }, answer: ({ attempt }) => rowAnswer({ table: `invented-${attempt}.tsv`, answer: `Unchecked statement ${attempt}` }) });
  assert.equal(requests.length, 3); assert.equal(result.stop_reason, 'no_progress_cycle');
  assert.equal(result.evidence_status, 'invalid_citation'); assert.equal(result.found, false);
  assert.equal(result.cited_row, null); assert.doesNotMatch(result.answer, /Unchecked statement/);
});

test('caller token admission stops further inference while retaining source coverage and actual usage', async () => {
  const { result, requests, reads } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv' }] }, answer: () => { throw new Error('No allowance for an answer call'); }, ctx: { budget: { total_tokens: 5 } } });
  assert.equal(requests.length, 1); assert.equal(reads.length, 1);
  assert.equal(result.stop_reason, 'token_budget_exhausted'); assert.equal(result.incomplete, true);
  assert.equal(result.found, false); assert.equal(result.coverage[0].source_rows, 2);
  assert.deepEqual(result.tokens.total, { prompt: 4, completion: 1, total: 5 });
});

test('cancellation after an admitted response prevents its follow-up source operation', async () => {
  const controller = new AbortController();
  const { result, requests, reads } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv', rows: 1 }] }, answer: () => {
    controller.abort(); return rowAnswer({ found: false, need_more: { table: 'source.tsv', rows: 1, offset: 1 } });
  }, ctx: { signal: controller.signal } });
  assert.equal(requests.length, 2); assert.equal(reads.length, 1);
  assert.equal(result.stop_reason, 'cancelled'); assert.equal(result.found, false);
  assert.equal(result.coverage.length, 1); assert.equal(result.tokens.total.total, 10);
});

test('expired deadlines and invalid shared-control decisions fail before inference', async () => {
  for (const [ctx, expected] of [[{ budget: { deadline_unix_ms: 0 } }, 'deadline_reached'], [{ runControl: { async checkpoint() {} } }, null]]) {
    const { result, requests, reads } = await setup({ sources: [source()], plan: { reads: [{ table: 'source.tsv' }] }, answer: () => rowAnswer(), ctx });
    assert.equal(requests.length, 0); assert.equal(reads.length, 0); assert.equal(result.found, false);
    if (expected) assert.equal(result.stop_reason, expected);
    else assert.match(result.error, /allowed: true or allowed: false/);
  }
});
