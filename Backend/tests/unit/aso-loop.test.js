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
  const requests = [], events = [], agentCalls = [], reviews = [];
  let artifact = 0;
  const stubs = {
    '../../inference/gateway': { getActiveModel: () => ({ id: 1, configKey: 'test-model' }), inference: { assignContext() {}, chat: { completions: { async create(request) { requests.push(request); const next = script.shift(); if (!next) throw new Error('script exhausted'); return typeof next === 'function' ? next(request) : next; } } } } },
    '../../policy/config': { platformConfig: () => ({ asoMaxSteps: options.maxTurns || 12, asoParallelLimit: 3 }) },
    // The review of an agent's result against the goal that summoned it is its own model call; tests script it.
    '../../inference/jsonCall': { jsonCall: async (system, user, onStep, label, stats) => { reviews.push({ label, user }); if (stats) { stats.promptTokens += 100; stats.completionTokens += 10; stats.totalTokens += 110; } return options.review ? options.review(user) : { accepted: true, reason: '' }; } },
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
  return { run, requests, events, agentCalls, reviews, directory };
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
  assert.equal(result.tokens.total, 440 + 550 + 110, 'study, specialist and review tokens are all counted');
  assert.equal(result.token_breakdown.investigator_hpa.calls, 3);
  assert.equal(result.agents, 1);
  assert.deepEqual(result.plan.map(p => p.status), ['done', 'done', 'done']);
  assert.match(result.summary, /\*\*Consensus\*\* \(a1, 4 rows\)/);
  assert.match(result.summary, /\| EGFR \| liver \| 32\.2 \|/);
  assert.match(result.summary, /Figure a3: heatmap "Heat" from a2\nFigure a4: grouped_bar "Bars" from a1/);
  assert.match(result.summary, /- EGFR is higher in liver \(32\.2\) than in lung \(14\.1\)\. \(evidence: a1 row 0: gene=EGFR, Tissue=liver, nTPM=32\.2; row 1: gene=EGFR, Tissue=lung, nTPM=14\.1\)/);
  // The desk of turn 2: the artifact as one line with its title and description, its few rows whole.
  const desk2 = requests[1].messages[1].content;
  // The line says what a row is: one per gene and tissue, and which tissues, so nothing counts or filters it blind.
  assert.match(desk2, /ARTIFACTS\na1 "Lung and liver nTPM" \(4 rows over 2 genes, one row per gene and Tissue \(Tissue: liver, lung\): gene, ensembl, Tissue, nTPM, source_rows, source_status\) ← investigator_hpa t1 "lung and liver nTPM"\n  Lung and liver nTPM, described\n  0: EGFR \| ENSG1 \| liver \| 32\.2 \| 2 \| ok\n  1: EGFR \| ENSG1 \| lung \| 14\.1 \| 2 \| ok\n  2: ERBB2/);
  assert.match(desk2, /HISTORY\nturn 1: plan: 3 deliverables\nturn 1: t1 investigator_hpa "Lung and liver nTPM" done → a1 "Lung and liver nTPM" \(4 rows\)/);
  assert.match(desk2, /PLAN\n1\. \[todo\] lung and liver nTPM \| table\n2\. \[todo\] heatmap \| heatmap/);
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /a1 "Lung and liver nTPM" \(4 rows over 2 genes, one row per gene and Tissue[^\n]*\n  Lung and liver nTPM, described\na2 "Heat matrix"/, 'once thepivot read a1, its rows leave the desk');
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
  // an open of rows already on the desk lists them once in the history, in full cells, and makes no view
  assert.match(desk3, /turn 2: a1 rows \(gene \| ensembl \| Tissue \| nTPM \| source_rows \| source_status\): 0: EGFR \| ENSG1 \| liver \| 32\.2 \| 2 \| ok ; 1: EGFR \| ENSG1 \| lung \| 14\.1 \| 2 \| ok ; 2: ERBB2/);
  assert.match(desk3, /turn 2: rank\(artifact=a1, by=nTPM\) failed: rank\.title is required/);
  assert.doesNotMatch(desk3, /\nVIEWS\n/);
});

test('a view folds to its receipt once a later turn consumes its artifact; opening it again brings it back', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'nTPM' }))),
    response(call('open', { artifact: 'a1', columns: ['nTPM'] })),
    response(call('rank', named('Ranked', { artifact: 'a1', by: 'nTPM' }))),
    response(call('open', { artifact: 'a1', columns: ['nTPM'] })),
    response(call('finish', { tables: [{ artifact: 'a2' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.match(requests[2].messages[1].content, /\nVIEWS\na1 rows 0–3 of 4 \(nTPM\)\n  0: 32\.2\n/);
  const folded = requests[3].messages[1].content;
  assert.match(folded, /\nVIEWS\na1 rows 0–3 of 4 \(opened at turn 2; open again to see them\)\n/);
  assert.doesNotMatch(folded, /  0: 32\.2/);
  assert.match(requests[4].messages[1].content, /\nVIEWS\na1 rows 0–3 of 4 \(nTPM\)\n  0: 32\.2\n/);
});

test('a join line says what b\'s clashing columns are now called; shared columns that agree are kept once', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR', 'ERBB2'], question: 'nTPM' }))),
    response(call('filter', named('Liver', { artifact: 'a1', where: [{ column: 'Tissue', op: '=', value: 'liver' }] })), call('filter', named('Lung', { artifact: 'a1', where: [{ column: 'Tissue', op: '=', value: 'lung' }] }))),
    response(call('join', named('Liver beside lung', { a: 'a2', b: 'a3', how: 'inner' }))),
    response(call('finish', { tables: [{ artifact: 'a4' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  const desk4 = requests[3].messages[1].content;
  assert.match(desk4, /a4 "Liver beside lung" \(2 rows: [^\n]*nTPM_2[^\n]*\) ← join t4 of a2, a3 \(a3's Tissue as Tissue_2, nTPM as nTPM_2\)/);
  assert.doesNotMatch(desk4, /source_status_2/, 'shared columns that agree are kept once');
});

test('an empty join says that no row matched; an open that shows nothing new is not work', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR', 'ERBB2'], question: 'nTPM' }))),
    response(call('filter', named('Liver', { artifact: 'a1', where: [{ column: 'Tissue', op: '=', value: 'liver' }] })), call('filter', named('Heart', { artifact: 'a1', where: [{ column: 'Tissue', op: '=', value: 'heart' }] }))),
    response(call('join', named('Liver beside heart', { a: 'a2', b: 'a3', how: 'inner' }))),
    response(call('open', { artifact: 'a1', columns: ['Tissue'] })),
    response(call('open', { artifact: 'a1', columns: ['Tissue'] })),
    response(call('finish', { tables: [{ artifact: 'a2' }], claims: [{ text: 'No gene has both a liver and a heart reading.', artifact: 'a4', rows: [] }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.match(requests[3].messages[1].content, /turn 3: join\(a=a2, b=a3, how=inner\) → a4 "Liver beside heart" \(0 rows\) \(no row of a2 matched a row of a3 on the entity keys\)/);
  assert.match(requests[5].messages[1].content, /turn 5: a1 rows 0–3 of 4 is already on the desk under VIEWS\nturn 5: that turn did no work/);
});

test('a summon whose tables repeat earlier artifacts registers nothing and says what combines them', async t => {
  const { run, requests, agentCalls } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR', 'ERBB2'], question: 'nTPM' }))),
    response(call('investigator_hpa', named('Values, consolidated', { points: ['EGFR', 'ERBB2'], question: 'one consolidated row per gene with liver and lung nTPM' }))),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.equal(agentCalls.length, 2, 'a differently worded question is asked');
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /turn 2: t2 investigator_hpa "Values, consolidated" done → a1 again \(the same rows\): nothing new; the Investigator answers per source table, one artifact each, and join combines them/);
  assert.doesNotMatch(desk3, /\na2 /, 'no second artifact for the same rows');
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
  assert.match(requests[2].messages[1].content, /turn 2: investigator_hpa\(points=\["EGFR"\], question=nTPM\) was already asked as t1: its result is a1 "Values" \(\d+ rows\); asking again the same way returns nothing new: use what it made, or ask for other fields with from and the column that names the rows\nturn 2: that turn only repeated calls already made: use their artifacts as they are, ask differently, or finish/);
});

test('from on an artifact whose rows are all about one entity is refused with the columns that could hold the points', async t => {
  const partners = { ...BULK, tables: [{ ...BULK.tables[0], rows: [{ gene: 'TP53', ensembl: 'ENSG_TP53', partner: 'ENSG_MDM2', source_rows: 2, source_status: 'ok' }, { gene: 'TP53', ensembl: 'ENSG_TP53', partner: 'ENSG_EP300', source_rows: 2, source_status: 'ok' }], columns: ['gene', 'ensembl', 'partner', 'source_rows', 'source_status'] }] };
  const { run, requests, agentCalls } = await study(t, [
    response(call('plan', { items: [{ step: 'partners', kind: 'table' }] }), call('investigator_hpa', named('Partners', { points: ['TP53'], question: 'interaction partners' }))),
    response(call('investigator_hpa', named('Locations', { from: 'a1', question: 'main location' }))),
    response(call('investigator_hpa', named('Locations', { from: 'a1', column: 'partner', question: 'main location' }))),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ], { agentResult: async (name, args) => args.points?.[0] === 'TP53' ? partners : BULK });
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.match(requests[2].messages[1].content, /turn 2: investigator_hpa\(from=a1, question=main location\) failed: a1 is about one gene \(ENSG_TP53\) across 2 rows; name the column that holds the points with column: partner, source_rows, source_status/);
  assert.deepEqual(agentCalls[1].args.points, ['ENSG_MDM2', 'ENSG_EP300']);
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

test('an optional argument sent as null is absent: from with points null takes the artifact column', async t => {
  const { run, requests, agentCalls } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR', 'ERBB2'], question: 'nTPM' }))),
    response(call('investigator_hpa', named('Again', { points: null, from: 'a1', column: 'gene', question: 'kidney nTPM' }))),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.deepEqual(agentCalls[1].args.points, ['EGFR', 'ERBB2']);
  assert.doesNotMatch(requests[2].messages[1].content, /must be an array|not both/);
});

test('an agent named as a run step starts on its own and the steps that use it wait', async t => {
  const { run, requests, agentCalls } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'nTPM' }))),
    response(call('run', { steps: [
      { id: 'e', tool: 'investigator_hpa', args: named('Kidney', { points: ['ERBB2'], question: 'kidney nTPM' }) },
      { id: 'f', tool: 'filter', args: named('Liver', { artifact: '@e', where: [{ column: 'Tissue', op: '=', value: 'liver' }] }) },
      { id: 'g', tool: 'join', args: named('Beside', { a: 'a1', b: 'e', how: 'inner' }) }
    ] })),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.deepEqual(agentCalls.map(c => c.args.points), [['EGFR'], ['ERBB2']], 'the agent step ran on its own');
  assert.match(requests[2].messages[1].content, /turn 2: run: e started as t2; f uses @e, which t2 is producing: run it again with that artifact's id when it is on the desk; g uses @e, which t2 is producing/, 'a step named bare where an artifact id goes waits too');
});

test('a call that failed for a reason that does not change is refused when it is repeated', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'nTPM' }))),
    response(call('filter', named('Nothing', { artifact: 'a9', where: [{ column: 'Tissue', op: '=', value: 'liver' }] }))),
    response(call('filter', named('Nothing', { artifact: 'a9', where: [{ column: 'Tissue', op: '=', value: 'liver' }] }))),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  const history = requests[3].messages[1].content;
  assert.match(history, /turn 2: filter\([^\n]*\) failed: /);
  assert.match(history, /turn 3: filter\([^\n]*\) refused: the same call failed at turn 2 \(/);
});

test('an agent result that is not what the call asked for is flagged on its line and in the history', async t => {
  const { run, requests, reviews } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'RNA nTPM in liver and lung' }))),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ], { review: user => (/RNA nTPM in liver and lung/.test(user) ? { accepted: false, reason: 'the call asks for RNA, the lookup read the protein table' } : { accepted: true, reason: '' }) });
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.equal(reviews.length, 1);
  assert.match(reviews[0].user, /Study goal: Lung and liver nTPM for EGFR and ERBB2[\s\S]*The call: investigator_hpa "Values", question: RNA nTPM in liver and lung \(for 1 listed points\)[\s\S]*Source lookups: \[\{"table":"rna_tissue_consensus.tsv"/);
  const desk2 = requests[1].messages[1].content;
  assert.match(desk2, /a1 "Values"[^\n]*\n  Values, described ⚠ Review: the call asks for RNA, the lookup read the protein table/);
  assert.match(desk2, /turn 1: review of a1: not what the call asked for: the call asks for RNA, the lookup read the protein table\. Ask again with what the study means, or use it knowing this/);
  assert.equal(result.token_breakdown.review.calls, 1);
});

test("a search result carries the search's own account of its selection, on its line and in the review", async t => {
  const search = { status: 'ok', outcome: 'completed', result: { rows: [{ Gene: 'ALB', Ensembl: 'ENSG1' }], plan: 'Tissue expression (IHC): Liver / hepatocytes / Not detected', understanding: 'genes without protein staining in liver', search_urls: ['u'], trail: [{ requirement_id: 'r1', requirement: 'not detected in liver', field: 'Tissue expression (IHC)', path: ['Liver', 'hepatocytes', 'Not detected'], operator: 'AND', why: 'protein level per tissue; the RNA field has no per-tissue detection' }], not_expressible: [] }, tokens: { prompt: 10, completion: 5, total: 15 } };
  const { run, requests, reviews } = await study(t, [
    response(call('plan', { items: [{ step: 'set', kind: 'gene_set' }] }), call('deep_research_hpa', named('Liver set', { goal: 'not detected in liver' }))),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ], { agentResult: async name => (name === 'deep_research_hpa' ? search : BULK) });
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  const desk2 = requests[1].messages[1].content;
  assert.match(desk2, /a1 "Liver set"[^\n]*\n  Liver set, described Selected by: not detected in liver → Tissue expression \(IHC\): Liver \/ hepatocytes \/ Not detected — protein level per tissue; the RNA field has no per-tissue detection/);
  assert.match(desk2, /turn 1: t1 deep_research_hpa "Liver set" done → a1 \(1 rows\) query: Tissue expression \(IHC\): Liver \/ hepatocytes \/ Not detected; chosen: not detected in liver → Tissue expression \(IHC\)/);
  assert.match(reviews[0].user, /the search understood the call as: genes without protein staining in liver; its selection, requirement by requirement: not detected in liver → Tissue expression \(IHC\)/);
});

test('an Investigator call that spans two source tables is reviewed one artifact at a time, each for its own share', async t => {
  const two = { ...BULK, tables: [
    { ...BULK.tables[0], name: 'liver_lung', title: 'RNA per tissue' },
    { name: 'locations', title: 'Locations', rows: [{ gene: 'EGFR', ensembl: 'ENSG1', location: 'Plasma membrane' }], columns: ['gene', 'ensembl', 'location'], args: { table: 'subcellular_location.tsv', fields: ['location'] }, coverage: { rows: 1 }, source_file: 'subcellular_location.tsv' }
  ] };
  const { run, reviews } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', named('Values', { points: ['EGFR'], question: 'RNA per tissue and the main location' }))),
    response(call('finish', { tables: [{ artifact: 'a1' }, { artifact: 'a2' }] }))
  ], { agentResult: async () => two });
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.equal(reviews.length, 2);
  assert.match(reviews[0].user, /This call returned 2 artifacts, one per source table; the others are a2 "Values: Locations" \(1 rows; columns: gene, ensembl, location\)\. Judge a1 for its own share of the call/);
  assert.match(reviews[1].user, /the others are a1 "Values: RNA per tissue"/);
});
