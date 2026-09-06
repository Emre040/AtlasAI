'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, call, response, transcript } = require('../helpers/nativeStudyFixture');
const { reportFigureArtifacts } = require('../../src/system/aso/reportFigures');

const input = { entry: { file: 'mapping.tsv', key: 'lookup', columns: ['name', 'x', 'y'] }, rows: [{ name: 'ONE', x: 0, y: 2 }, { name: 'TWO', x: 3, y: 4 }] };
const tables = [{ artifact: 'a1', columns: ['name', 'x', 'y'], title: 'Exact source table' }];
const completed = [{ item: 2, artifacts: ['a3'] }, { item: 3, artifacts: ['a1'] }];
function prepare(turn) {
  if (turn === 1) return response(call('set_plan', { items: [{ step: 'Read the observations', kind: 'table' }, { step: 'Draw the requested comparison', kind: 'scatter' }, { step: 'Report the result', kind: 'summary' }] }), call('select', { artifact: 'mapping.tsv', node: 1 }));
  if (turn === 2) return response(call('chart', { artifact: 'a1', type: 'scatter', x: 'y', y: 'x', title: 'Exploratory reversed axes', node: 2 }));
  if (turn === 3) return response(call('chart', { artifact: 'a1', type: 'scatter', x: 'x', y: 'y', label: 'name', title: 'Corrected comparison' }));
}
async function verifyRetained(result) {
  assert.deepEqual(result.artifacts.filter(a => a.kind === 'figure').map(a => a.summary.id), ['a2', 'a3']);
  for (const artifact of result.artifacts) await fs.access(artifact.storage_uri);
}

test('native finish selects corrected figure for report and shared HTTP export while preserving all workspace artifacts', async t => {
  const f = await fixture(t, ({ request, turn }) => prepare(turn) || (() => {
    assert.equal(turn, 4);
    const schema = request.tools.find(tool => tool.function.name === 'finish').function.parameters;
    assert.equal(schema.properties.figures.type, 'array'); assert.ok(!schema.required.includes('figures'));
    return response(call('finish', { figures: ['a3'], tables, completed }));
  })(), undefined, input);
  const result = await f.run();
  assert.equal(result.outcome, 'completed'); assert.equal(result.failed, 0);
  assert.deepEqual(result.report_figures, ['a3']);
  assert.deepEqual(result.plan[1].artifacts, ['a3']);
  const report = await fs.readFile(path.join(f.directory, 'report.md'), 'utf8');
  assert.equal(report, result.summary_md);
  assert.match(report, /a3 figure "Corrected comparison"/);
  assert.doesNotMatch(report, /a2 figure|Exploratory reversed axes/);
  assert.match(report, /ONE \| 0 \| 2/); assert.match(report, /a1 data/);
  assert.deepEqual(reportFigureArtifacts(result).map(a => a.summary.id), ['a3']);
  await verifyRetained(result);
});

for (const [label, figures, expected] of [['omitted', undefined, ['a2', 'a3']], ['empty', [], []]]) test(`native ${label} figure selection preserves the documented export behavior and ordinary tables`, async t => {
  const f = await fixture(t, ({ turn }) => {
    if (figures === undefined) return prepare(turn) || response(call('finish', { tables, completed }));
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Read observations', kind: 'table' }, { step: 'Report exact table', kind: 'summary' }] }), call('select', { artifact: 'mapping.tsv', node: 1 }));
    if (turn === 2) return response(call('chart', { artifact: 'a1', type: 'scatter', x: 'y', y: 'x', title: 'Exploratory reversed axes' }));
    if (turn === 3) return response(call('chart', { artifact: 'a1', type: 'scatter', x: 'x', y: 'y', title: 'Corrected comparison' }));
    return response(call('finish', { figures, tables, completed: [{ item: 2, artifacts: ['a1'] }] }));
  }, undefined, input);
  const result = await f.run();
  assert.equal(result.outcome, 'completed');
  assert.equal(Object.hasOwn(result, 'report_figures'), figures !== undefined);
  assert.deepEqual(reportFigureArtifacts(result).map(a => a.summary.id), expected);
  for (const id of ['a2', 'a3']) assert.equal(result.summary_md.includes(`${id} figure`), expected.includes(id));
  assert.match(result.summary, /ONE \| 0 \| 2/);
  await verifyRetained(result);
});

for (const [label, figures, error] of [['unknown', ['a999'], /must name a saved figure/], ['table', ['a1'], /must name a saved figure/], ['duplicate', ['a3', 'a3'], /must not repeat/], ['omitted requested plot', [], /must include bound evidence for requested chart item 2/], ['earlier plot instead of bound correction', ['a2'], /must include bound evidence for requested chart item 2/]]) test(`native ${label} selection refuses before applying completion bindings`, async t => {
  const f = await fixture(t, ({ request, turn }) => prepare(turn) || (() => {
    if (turn === 4) return response(call('finish', { figures, tables, completed }));
    assert.equal(turn, 5); assert.match(transcript(request), error);
    const frame = request.messages.filter(message => message.role === 'user').at(-1).content;
    assert.match(frame, /3\. \[todo\] Report the result/);
    return response(call('finish', { figures: ['a3'], tables, completed }));
  })(), undefined, input);
  const result = await f.run();
  assert.equal(result.outcome, 'completed'); assert.deepEqual(result.report_figures, ['a3']);
  assert.deepEqual(result.plan[1].artifacts, ['a3']);
  await verifyRetained(result);
});

test('explicit empty figure selection cannot use unselected workspace plots to justify an empty report', async t => {
  const f = await fixture(t, ({ request, turn }) => prepare(turn) || (() => {
    if (turn === 4) return response(call('finish', { figures: [], completed }));
    assert.equal(turn, 5); assert.match(transcript(request), /empty report does not satisfy/);
    assert.match(request.messages.filter(message => message.role === 'user').at(-1).content, /3\. \[todo\]/);
    return response(call('finish', { figures: ['a3'], completed }));
  })(), undefined, input);
  const result = await f.run();
  assert.equal(result.outcome, 'completed'); assert.deepEqual(result.report_figures, ['a3']);
});

test('shared query and batch export selection preserves requested order and rejects invalid references', () => {
  const artifacts = [{ kind: 'dataset', summary: { id: 'a1' } }, { kind: 'figure', summary: { id: 'a2' } }, { kind: 'figure', summary: { id: 'a3' } }];
  const before = JSON.stringify(artifacts);
  assert.deepEqual(reportFigureArtifacts({ artifacts, report_figures: ['a3', 'a2'] }), [artifacts[2], artifacts[1]]);
  assert.deepEqual(reportFigureArtifacts({ artifacts }), [artifacts[1], artifacts[2]]);
  assert.deepEqual(reportFigureArtifacts({ artifacts, report_figures: [] }), []);
  for (const report_figures of [['a1'], ['a999'], ['a2', 'a2'], null, 'a2', [2]]) assert.throws(() => reportFigureArtifacts({ artifacts, report_figures }), /finish.figures/);
  assert.equal(JSON.stringify(artifacts), before);
});
