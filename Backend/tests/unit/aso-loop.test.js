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

async function study(t, script, options = {}) {
  const directory = await tempWorkspace(t);
  const requests = [], events = [], agentCalls = [];
  let artifact = 0;
  const stubs = {
    '../../inference/gateway': { getActiveModel: () => ({ id: 1, configKey: 'test-model' }), inference: { assignContext() {}, chat: { completions: { async create(request) { requests.push(request); const next = script.shift(); if (!next) throw new Error('script exhausted'); return typeof next === 'function' ? next(request) : next; } } } } },
    '../../policy/config': { platformConfig: () => ({ asoMaxSteps: options.maxTurns || 12, asoParallelLimit: 3 }) },
    '../../hpa/geneDataAdapter': fakeAdapter(),
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../hpa/localData': { FILES: { master: 'proteinatlas.tsv' }, localData: { async master() { return { rows: [] }; }, async table() { return { columns: [], rows: [] }; }, async *rows() { for (const row of ROWS.ENSG1) yield row; } } },
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
    response(call('plan', { items: [{ step: 'lung and liver nTPM', kind: 'table' }, { step: 'heatmap', kind: 'heatmap' }, { step: 'grouped bars', kind: 'grouped_bar' }] }), call('investigator_hpa', { genes: ['EGFR', 'ERBB2'], question: 'lung and liver nTPM' })),
    response(call('run', { steps: [{ id: 'p', tool: 'pivot', args: { artifact: 'a1', row: 'gene', column: 'Tissue', value: 'nTPM' } }, { id: 'h', tool: 'chart', args: { artifact: '@p', type: 'heatmap', title: 'Heat' } }] })),
    response(call('chart', { artifact: 'a1', type: 'grouped_bar', x: 'gene', y: 'nTPM', group: 'Tissue', title: 'Bars' })),
    response(call('finish', { tables: [{ artifact: 'a1', columns: ['gene', 'Tissue', 'nTPM'], title: 'Consensus' }], figures: ['a3', 'a4'], claims: [{ text: 'EGFR is higher in liver (32.2) than in lung (14.1).', artifact: 'a1', rows: [0, 1], columns: ['gene', 'Tissue', 'nTPM'] }] }))
  ]);
  const result = await run({});
  assert.equal(result.status, 'ok');
  assert.equal(result.outcome, 'completed', result.summary);
  assert.equal(result.turns, 4);
  assert.equal(requests.length, 4);
  assert.deepEqual(agentCalls.map(c => c.name), ['investigator_hpa']);
  assert.equal(agentCalls[0].args.mode, 'offline');
  assert.equal(result.tokens.total, 440 + 550, 'study and specialist tokens are both counted');
  assert.equal(result.token_breakdown.investigator_hpa.calls, 3);
  assert.equal(result.agents, 1);
  assert.deepEqual(result.plan.map(p => p.status), ['done', 'done', 'done']);
  assert.match(result.summary, /\*\*Consensus\*\* \(a1, 4 rows\)/);
  assert.match(result.summary, /\| EGFR \| liver \| 32\.2 \|/);
  assert.match(result.summary, /Figure a3: heatmap "Heat" from a2\nFigure a4: grouped_bar "Bars" from a1/);
  assert.match(result.summary, /- EGFR is higher in liver \(32\.2\) than in lung \(14\.1\)\. \(evidence: a1 row 0: gene=EGFR, Tissue=liver, nTPM=32\.2; row 1: gene=EGFR, Tissue=lung, nTPM=14\.1\)/);
  // The desk of turn 2: the artifact card with columns and two rows, and the history of the agent.
  const desk2 = requests[1].messages[1].content;
  assert.match(desk2, /ARTIFACTS\na1 \(4 rows\) ← investigator_hpa t1 "lung and liver nTPM": gene, ensembl, Tissue, nTPM, source_rows, source_status\n  0: EGFR \| ENSG1 \| liver \| 32\.2 \| 2 \| ok\n  1: EGFR \| ENSG1 \| lung \| 14\.1 \| 2 \| ok\n  2: ERBB2/, 'a small table sits on the desk whole, with row indices for claims');
  assert.match(desk2, /HISTORY\nturn 1: plan: 3 deliverables\nturn 1: t1 investigator_hpa done → a1 \(4 rows\)/);
  assert.match(desk2, /PLAN\n1\. \[todo\] lung and liver nTPM \| table\n2\. \[todo\] heatmap \| heatmap/);
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /a2 matrix 2 × 2 ← pivot t2 of a1 \(a heatmap input; not a row table\)\n   \| liver \| lung\n  EGFR \| 32\.2 \| 14\.1/);
  assert.match(desk3, /a3 figure heatmap "Heat" ← chart t3\(artifact=a2, type=heatmap, title=Heat\) \(rendered\)/);
  assert.match(requests[3].messages[1].content, /a4 figure grouped_bar "Bars"/);
  assert.match(requests[0].messages[0].content, /You run a study over the Test Atlas/);
  assert.match(requests[0].messages[0].content, /DATASETS ON DISK[^\n]*\nrna_tissue_consensus\.tsv, tissues\.tsv/);
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'investigator_hpa' && tool.function.parameters.properties.genes && tool.function.parameters.properties.from && !tool.function.parameters.properties.mode));
});

test('a claim with a number its rows do not hold is refused with the reason, then accepted once bound correctly', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', { genes: ['EGFR'], question: 'nTPM' })),
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
    response(call('plan', { items: [{ step: 'values', kind: 'table' }, { step: 'scatter', kind: 'scatter' }] }), call('investigator_hpa', { genes: ['EGFR'], question: 'nTPM' })),
    response(call('finish', { tables: [{ artifact: 'a1' }] })),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.incomplete_reason, 'unresolved_finish');
  assert.match(requests[2].messages[1].content, /finish refused:\n    - plan items not delivered and not in not_done: 2\. scatter \(scatter\)/);
  const again = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }, { step: 'scatter', kind: 'scatter' }] }), call('investigator_hpa', { genes: ['EGFR'], question: 'nTPM' })),
    response(call('finish', { tables: [{ artifact: 'a1' }], not_done: [{ item: 2, why: 'no second numeric column to plot' }] }))
  ]);
  const accepted = await again.run({});
  assert.equal(accepted.outcome, 'incomplete');
  assert.equal(accepted.incomplete_reason, 'undelivered_items');
  assert.match(accepted.summary, /\*\*Not done\*\*\n\n- Plan item 2: no second numeric column to plot/);
});

test('finish while an agent runs is refused and the loop waits for the agent; a failed operation is a history line with the columns', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', { genes: ['EGFR'], question: 'nTPM' }), call('finish', { tables: [{ artifact: 'a1' }] })),
    response(call('filter', { artifact: 'a1', where: [{ column: 'expression', op: '>', value: 1 }] })),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ], { agentResult: async () => { await new Promise(resolve => setTimeout(resolve, 60)); return BULK; } });
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.equal(result.turns, 3, 'no turn is spent looking at an unchanged desk while the agent runs');
  const desk2 = requests[1].messages[1].content;
  assert.match(desk2, /RUNNING\n\(nothing running\)/);
  assert.match(desk2, /turn 1: finish refused: t1 still running; wait for them \(skip\) or finish after they return\nturn 1: t1 investigator_hpa done → a1 \(4 rows\)/);
  assert.match(requests[2].messages[1].content, /turn 2: filter\(artifact=a1, where=\[\{"column":"expression","op":">","value":1\}\]\) failed: filter: no column named "expression" \(columns: gene, ensembl, Tissue, nTPM, source_rows, source_status\)/);
  assert.equal(result.failed, 1, 'the failed filter; a refused finish is feedback, not a failure');
});

test('an identical agent call is answered by the earlier job, and one gene is investigated as a list of one', async t => {
  const { run, requests, agentCalls } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('investigator_hpa', { gene: 'EGFR', question: 'nTPM' })),
    response(call('investigator_hpa', { gene: 'EGFR', question: 'nTPM' })),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  assert.deepEqual(agentCalls.map(c => c.args.genes), [['EGFR']], 'asked once, as a list');
  assert.equal(agentCalls[0].args.gene, undefined);
  assert.equal(result.agents, 1);
  assert.match(requests[2].messages[1].content, /turn 2: investigator_hpa\(gene=EGFR, question=nTPM\) was already asked as t1: its result is a1/);
});

test('a dataset opened for columns is detailed for those; a filter pinning the entity key reads it by index', async t => {
  const { run, requests } = await study(t, [
    response(call('plan', { items: [{ step: 'values', kind: 'table' }] }), call('open', { what: 'rna_tissue_consensus.tsv', columns: ['nTPM'] })),
    response(call('open', { what: 'rna_tissue_consensus.tsv', columns: ['Tissue'] }), call('filter', { artifact: 'rna_tissue_consensus.tsv', where: [{ column: 'Gene name', op: '=', value: 'ERBB2' }, { column: 'Tissue', op: '=', value: 'lung' }] })),
    response(call('finish', { tables: [{ artifact: 'a1' }] }))
  ]);
  const result = await run({});
  assert.equal(result.outcome, 'completed', result.summary);
  const desk2 = requests[1].messages[1].content;
  assert.match(desk2, /TABLES OPENED\nrna_tissue_consensus\.tsv — Consensus tissue RNA\. Consensus nTPM per tissue \[rows per gene\]; 4 columns \(values from 6 rows\)\n  columns: Gene \| Gene name \| Tissue \| nTPM\n  nTPM: number 0 to 34\.1; 17% blank; 5 distinct\n  rows \(nTPM\): 32\.2 ; 14\.1/);
  assert.match(desk2, /turn 1: opened rna_tissue_consensus\.tsv \(on the desk: nTPM\)/);
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /  columns: Gene \| Gene name \| Tissue \| nTPM\n  Tissue: 3 values: liver \| lung \| heart\n  nTPM: number/, 'a later open adds columns to the card');
  assert.match(desk3, /turn 2: rna_tissue_consensus\.tsv: added Tissue to its card/);
  assert.match(desk3, /a1 \(1 rows\) ← filter t\d+ of rna_tissue_consensus\.tsv: [^\n]*\n  0: ERBB2 \| ENSG2 \| ERBB2 \| lung \| ENSG2 \| 34\.1/, 'the stream stub holds only EGFR rows, so ERBB2 came through the index; keys and the filtered columns lead the row');
});
