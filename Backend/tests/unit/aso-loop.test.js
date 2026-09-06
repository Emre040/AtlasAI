'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadWithStubs, call, response, fakeAdapter, tempWorkspace, ROWS } = require('../helpers/deskStudyFixture');

const LONG = [
  { gene: 'EGFR', ensembl: 'ENSG1', Tissue: 'liver', nTPM: '32.2', source_rows: 2, source_status: 'ok' }, { gene: 'EGFR', ensembl: 'ENSG1', Tissue: 'lung', nTPM: '14.1', source_rows: 2, source_status: 'ok' },
  { gene: 'ERBB2', ensembl: 'ENSG2', Tissue: 'liver', nTPM: '30.7', source_rows: 2, source_status: 'ok' }, { gene: 'ERBB2', ensembl: 'ENSG2', Tissue: 'lung', nTPM: '34.1', source_rows: 2, source_status: 'ok' }
];
const BULK = { bulk: true, found: true, status: 'ok', tables: [{ name: 'liver_lung', rows: LONG, columns: ['gene', 'ensembl', 'Tissue', 'nTPM', 'source_rows', 'source_status'], args: { table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'] }, coverage: { rows: 4 }, source_file: 'rna_tissue_consensus.tsv' }], retained: [], note: '', unresolved: [], mode: 'offline', hpa_version: 'test', tokens: { total: { prompt: 500, completion: 50, total: 550 } }, calls: 3 };
const named = (title, args) => ({ title, description: `${title}, described`, ...args });

async function study(t, script, options = {}) {
  const directory = await tempWorkspace(t);
  const requests = [], events = [], agentCalls = [];
  let artifact = 0;
  const stubs = {
    '../../inference/gateway': { getActiveModel: () => ({ id: 1, configKey: 'test-model' }), inference: { assignContext() {}, chat: { completions: { async create(request) { requests.push(request); const next = script.shift(); if (!next) throw new Error('script exhausted'); return typeof next === 'function' ? next(request) : next; } } } } },
    '../../policy/config': { platformConfig: () => ({ asoMaxSteps: options.maxTurns || 12, asoParallelLimit: 3 }) },
    '../../hpa/geneDataAdapter': fakeAdapter(),
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../hpa/localData': { FILES: { master: 'proteinatlas.tsv' } },
    '../aso/workspaceStore': { async createWorkspace() { return { id: 1, uuid: 'test-study', workspaceDir: directory, artifactsDir: path.join(directory, 'artifacts'), logPath: path.join(directory, 'events.ndjson') }; }, async updateWorkspace() {} },
    '../aso/artifactStore': { async registerArtifact(db, args) { const id = ++artifact; const storageUri = args.storageUriOverride || path.join(directory, 'artifacts', `${id}.json`); if (!args.skipWrite) await fs.writeFile(storageUri, JSON.stringify(args.payload)); return { artifactUuid: `artifact-${id}`, storageUri }; } },
    '../aso/pipelines/renderCharts': { renderCharts: async (spec, renderDir) => { const image = path.join(renderDir, 'plot.png'); await fs.writeFile(image, 'png'); return { images: [image] }; } },
    '../orchestrator': { getToolSpecs: () => [
      { type: 'function', function: { name: 'deep_research_hpa', description: 'search', parameters: { type: 'object', properties: { goal: { type: 'string' }, mode: { type: 'string' } }, required: ['goal'] } } },
      { type: 'function', function: { name: 'investigator_hpa', description: 'investigate', parameters: { type: 'object', properties: { gene: { type: 'string' }, question: { type: 'string' }, mode: { type: 'string' } }, required: [] } } }
    ], async execute(name, args, ctx) { agentCalls.push({ name, args }); await ctx.onStep?.({ stage: 'start', label: 'x', message: 'y' }); return { result: options.agentResult ? await options.agentResult(name, args) : BULK }; } }
  };
  const asoStudy = await loadWithStubs('src/system/agents/asoStudy.js', stubs);
  const run = args => asoStudy({ goal: 'Lung and liver nTPM for EGFR and ERBB2, a heatmap and a grouped bar chart', ...args }, { db: {}, visitorId: 1, async onStep(event) { events.push(event); } });
  return { run, requests, events, agentCalls, directory };
}

test('plan, delegate, compute a chain, and finish a report bound to the data', async t => {
  const { run, requests, agentCalls } = await study(t, [
    response(call('plan', { items: [{ step: 'lung and liver nTPM', kind: 'table' }, { step: 'heatmap', kind: 'heatmap' }, { step: 'grouped bars', kind: 'grouped_bar' }] }), call('investigator_hpa', named('Lung and liver nTPM', { points: ['EGFR', 'ERBB2'], question: 'lung and liver nTPM' }))),
    response(call('run', { steps: [{ id: 'p', tool: 'pivot', args: named('Heat matrix', { artifact: 'a1', row: 'gene', column: 'Tissue', value: 'nTPM' }) }, { id: 'h', tool: 'chart', args: named('Heat', { artifact: '@p', type: 'heatmap' }) }] })),
    response(call('chart', named('Bars', { artifact: 'a1', type: 'grouped_bar', x: 'gene', y: 'nTPM', group: 'Tissue' }))),
    response(call('finish', { tables: [{ artifact: 'a1', columns: ['gene', 'Tissue', 'nTPM'], title: 'Consensus' }], figures: ['a3', 'a4'], claims: [{ text: 'EGFR is higher in liver (32.2) than in lung (14.1).', artifact: 'a1', rows: [0, 1], columns: ['gene', 'Tissue', 'nTPM'] }] }))
  ]);
  const result = await run({});
  assert.equal(result.status, 'ok');
  assert.equal(result.outcome, 'completed', result.summary);
  assert.equal(result.turns, 4);
  assert.equal(requests.length, 4);
  assert.deepEqual(agentCalls.map(c => c.name), ['investigator_hpa']);
  assert.deepEqual(agentCalls[0].args, { points: ['EGFR', 'ERBB2'], question: 'lung and liver nTPM', mode: 'offline' }, 'the agent gets the list and the question; the title stays on the desk');
  assert.equal(result.tokens.total, 440 + 550, 'study and specialist tokens are both counted');
  assert.equal(result.token_breakdown.investigator_hpa.calls, 3);
  assert.equal(result.agents, 1);
  assert.deepEqual(result.plan.map(p => p.status), ['done', 'done', 'done']);
  assert.match(result.summary, /\*\*Consensus\*\* \(a1, 4 rows\)/);
  assert.match(result.summary, /\| EGFR \| liver \| 32\.2 \|/);
  assert.match(result.summary, /Figure a3: heatmap "Heat" from a2\nFigure a4: grouped_bar "Bars" from a1/);
  assert.match(result.summary, /- EGFR is higher in liver \(32\.2\) than in lung \(14\.1\)\. \(evidence: a1 row 0: gene=EGFR, Tissue=liver, nTPM=32\.2; row 1: gene=EGFR, Tissue=lung, nTPM=14\.1\)/);
  // The desk of turn 2: the artifact as one line with its title and description, its few rows whole.
  const desk2 = requests[1].messages[1].content;
  assert.match(desk2, /ARTIFACTS\na1 "Lung and liver nTPM" \(4 rows: gene, ensembl, Tissue, nTPM, source_rows, source_status\) ← investigator_hpa t1 "lung and liver nTPM"\n  Lung and liver nTPM, described\n  0: EGFR \| ENSG1 \| liver \| 32\.2 \| 2 \| ok\n  1: EGFR \| ENSG1 \| lung \| 14\.1 \| 2 \| ok\n  2: ERBB2/);
  assert.match(desk2, /HISTORY\nturn 1: plan: 3 deliverables\nturn 1: t1 investigator_hpa "Lung and liver nTPM" done → a1 "Lung and liver nTPM" \(4 rows\)/);
  assert.match(desk2, /PLAN\n1\. \[todo\] lung and liver nTPM \| table\n2\. \[todo\] heatmap \| heatmap/);
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /a2 "Heat matrix" matrix 2 × 2 \(rows: EGFR, ERBB2; columns: liver, lung\) ← pivot t2 of a1; a heatmap input\n  Heat matrix, described/);
  assert.match(desk3, /a3 "Heat" figure heatmap ← chart t3\(artifact=a2, type=heatmap\) \(rendered\)/);
  assert.match(requests[3].messages[1].content, /a4 "Bars" figure grouped_bar/);
  const system = requests[0].messages[0].content;
  assert.match(system, /You run a study over the Test Atlas/);
  assert.doesNotMatch(system, /DATASETS|\.tsv/, 'the study never sees a file');
  const investigator = requests[0].tools.find(tool => tool.function.name === 'investigator_hpa').function;
  assert.deepEqual(Object.keys(investigator.parameters.properties).sort(), ['column', 'description', 'from', 'points', 'question', 'title']);
  assert.ok(requests[0].tools.every(tool => !['union', 'intersect'].includes(tool.function.name)));
});

test('a claim with a number its rows do not hold is refused with the reason, then accepted once bound correctly', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'nTPM' }))),
    response(call('finish', { claims: [{ text: 'EGFR liver nTPM is 40.1', artifact: 'a1', rows: [0], columns: ['nTPM'] }] })),
    response(call('finish', { claims: [{ text: 'EGFR liver nTPM is 32.2', artifact: 'a1', rows: [0], columns: ['nTPM'] }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.match(requests[2].messages[1].content, /turn 2: finish refused:\n    - claims\[0\]: "EGFR liver nTPM is 40\.1" states 40\.1, not among the cells it is bound to \(a1 rows 0 columns nTPM\): 40\.1 is in no saved artifact/);
  assert.match(result.summary, /\*\*Findings\*\*\n\n- EGFR liver nTPM is 32\.2 \(evidence: a1 row 0: nTPM=32\.2\)/);
});

test('a plan item without a deliverable blocks finish unless it is listed in not_done; a second identical refusal stops the study', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }, { step: 'scatter', kind: 'scatter' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'nTPM' }))),
    response(call('finish', { tables: [{ artifact: 'a1' }] })),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.incomplete_reason, 'unresolved_finish');
  assert.match(requests[2].messages[1].content, /finish refused:\n    - plan items not delivered and not in not_done: 2\. scatter \(scatter\)/);
  const again = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }, { step: 'scatter', kind: 'scatter' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'nTPM' }))),
    response(call('finish', { tables: [{ artifact: 'a1' }], not_done: [{ item: 2, why: 'no second numeric column to plot' }] }))
  ]);
  const accepted = await again.run({});
  assert.equal(accepted.outcome, 'incomplete');
  assert.equal(accepted.incomplete_reason, 'undelivered_items');
  assert.match(accepted.summary, /\*\*Not done\*\*\n\n- Plan item 2: no second numeric column to plot/);
});

test('finish while an agent runs is refused and the loop waits for the agent; a failed operation is a history line with the columns', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'nTPM' }))),
    response(call('investigator_hpa', named('More values', { points: ['ERBB2'], question: 'nTPM' })), call('finish', { tables: [{ artifact: 'a1' }] })),
    response(call('filter', named('High', { artifact: 'a1', where: [{ column: 'expression', op: '>', value: 1 }] }))),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ], { agentResult: async () => { await new Promise(resolve => setTimeout(resolve, 60)); return BULK; } });
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.equal(result.turns, 4, 'no turn is spent looking at an unchanged desk while an agent runs');
  assert.ok(!requests[0].tools.some(tool => ['finish', 'filter', 'open'].includes(tool.function.name)), 'before any artifact exists only the plan, notes and the agents are offered');
  assert.ok(requests[1].tools.some(tool => tool.function.name === 'finish'));
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /RUNNING\n\(nothing running\)/);
  assert.match(desk3, /turn 2: finish refused: t2 still running; wait for them \(skip\) or finish after they return\nturn 2: t2 investigator_hpa "More values" done → a2 "More values" \(4 rows\)/);
  assert.match(requests[3].messages[1].content, /turn 3: filter\(artifact=a1, where=\[\{"column":"expression","op":">","value":1\}\]\) failed: filter: no column named "expression" \(columns: gene, ensembl, Tissue, nTPM, source_rows, source_status\)/);
  assert.equal(result.failed, 1, 'the failed filter; a refused finish is feedback, not a failure');
});

test('opening an artifact that is whole on the desk is answered from the desk, without a view; an operation without a title is refused', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'nTPM' }))),
    response(call('open', { artifact: 'a1' }), call('rank', { artifact: 'a1', by: 'nTPM' })),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /turn 2: a1 is whole on the desk \(rows 0–3\)/);
  assert.match(desk3, /turn 2: rank\(artifact=a1, by=nTPM\) failed: rank\.title is required/);
  assert.doesNotMatch(desk3, /\nVIEWS\n/);
});

test('an identical agent call is answered by the earlier job', async t => {
  const { run, requests, agentCalls } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'nTPM' }))),
    response(call('investigator_hpa', named('Values again', { points: ['EGFR'], question: 'nTPM' }))),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.deepEqual(agentCalls.map(c => c.args.points), [['EGFR']], 'asked once');
  assert.equal(result.agents, 1);
  assert.match(requests[2].messages[1].content, /turn 2: investigator_hpa\(points=\["EGFR"\], question=nTPM\) was already asked as t1: its result is a1/);
});

test('the Investigator takes points from an artifact column, or no list at all; a file name is not an artifact', async t => {
  const { run, requests, agentCalls } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR', 'ERBB2'], question: 'nTPM' }))),
    response(call('investigator_hpa', named('Genes per tissue', { from: 'a1', column: 'Tissue', question: 'every gene measured in each tissue' })), call('investigator_hpa', named('Liver rows', { question: 'every gene with its liver nTPM' }))),
    response(call('filter', named('Liver', { artifact: 'rna_tissue_consensus.tsv', where: [{ column: 'Tissue', op: '=', value: 'liver' }] }))),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.deepEqual(agentCalls.map(c => c.args.points), [['EGFR', 'ERBB2'], ['liver', 'lung'], []]);
  assert.deepEqual(agentCalls[1].args.question, 'every gene measured in each tissue');
  assert.match(requests[3].messages[1].content, /turn 3: filter\(artifact=rna_tissue_consensus\.tsv, where=[^)]*\) failed: no artifact "rna_tissue_consensus\.tsv" \(have a1, a2, a3\)/);
});
