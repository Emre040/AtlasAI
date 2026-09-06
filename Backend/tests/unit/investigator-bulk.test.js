'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, call, response, fakeAdapter } = require('../helpers/deskStudyFixture');

async function investigator(script, options = {}) {
  const requests = [];
  const stubs = {
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) { requests.push(request); const next = script.shift(); if (!next) throw new Error('script exhausted'); return typeof next === 'function' ? next(request) : next; } } } } },
    '../../policy/config': { platformConfig: () => ({ asoMaxSteps: options.maxTurns || 8 }) },
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../hpa/localData': { FILES: { master: 'proteinatlas.tsv' } }
  };
  const run = await loadWithStubs('src/system/agents/investigatorBulk.js', stubs);
  return { run: (args, ctx = {}) => run(args, ctx, fakeAdapter(options.adapter)), requests };
}

test('the investigator opens a table, fetches for the whole list and returns the raw rows', async () => {
  const steps = [];
  const { run, requests } = await investigator([
    response(call('open', { table: 'rna_tissue_consensus.tsv' })),
    response(call('fetch', { name: 'liver_lung', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: 'in', value: 'liver,lung' }] })),
    response(call('finish', { results: ['liver_lung'] }))
  ]);
  const result = await run({ genes: ['EGFR', 'ERBB2', 'MET', 'NOPE'], question: 'liver and lung nTPM' }, { onStep: s => steps.push(s) });
  assert.equal(result.status, 'ok');
  assert.equal(result.tables.length, 1);
  assert.deepEqual(result.tables[0].columns, ['gene', 'ensembl', 'Tissue', 'nTPM', 'source_rows', 'source_status']);
  assert.equal(result.tables[0].rows.length, 6, 'EGFR 2 + ERBB2 2 + MET 1 (blank nTPM) + NOPE 1 empty');
  assert.deepEqual(result.tables[0].args, { table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: 'in', value: 'liver,lung' }] });
  assert.deepEqual(result.unresolved, ['NOPE']);
  assert.equal(result.calls, 3);
  assert.equal(result.tokens.total.total, 330);
  // The desk of the third turn holds the opened table with its values and the fetched result with rows.
  const desk = requests[2].messages[1].content;
  assert.match(desk, /OPENED\nrna_tissue_consensus\.tsv — Consensus tissue RNA/);
  assert.match(desk, /Tissue: 3 values: liver \| lung \| heart/);
  assert.match(desk, /RESULTS\nliver_lung \(6 rows\) ← fetch table=rna_tissue_consensus\.tsv, fields=\["Tissue","nTPM"\]/);
  assert.match(desk, /  0: EGFR \| ENSG1 \| liver \| 32\.2 \| 2 \| ok/);
  assert.match(desk, /HISTORY\nturn 1: opened rna_tissue_consensus\.tsv \(on the desk\)\nturn 2: fetch → liver_lung \(6 rows; 3 genes with rows, 1 not in the release\)/);
  assert.match(requests[0].messages[0].content, /You are the Investigator in a study over the Test Atlas/);
  assert.match(requests[0].messages[0].content, /TABLES \(2; open one for its columns and values\)\nrna_tissue_consensus\.tsv — Consensus tissue RNA\ntissues\.tsv — Tissue lookup/);
  assert.equal(requests[0].tools.length, 4);
  assert.ok(steps.some(s => s.stage === 'complete'));
});

test('errors come back as history lines with the columns the model needs, and repeats stop the loop', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { name: 'x', table: 'rna_tissue_consensus.tsv', fields: ['expression'] })),
    response(call('fetch', { name: 'x', table: 'rna_tissue_consensus.tsv', fields: ['expression'] })),
    response(call('fetch', { name: 'x', table: 'rna_tissue_consensus.tsv', fields: ['expression'] }))
  ]);
  const result = await run({ genes: ['EGFR'], question: 'expression' });
  assert.equal(result.status, 'partial');
  assert.equal(result.stop_reason, 'no_progress');
  assert.match(requests[1].messages[1].content, /turn 1: fetch\(name=x, table=rna_tissue_consensus\.tsv, fields=\["expression"\]\) failed: rna_tissue_consensus\.tsv has no column "expression"; its columns: Gene, Gene name, Tissue, nTPM/);
  assert.match(requests[1].messages[1].content, /OPENED\nrna_tissue_consensus\.tsv/, 'a fetch opens the table on the desk even when it fails');
});

test('finish without a matching result is refused with the names that exist', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { name: 'liver', table: 'rna_tissue_consensus.tsv', fields: ['nTPM'], where: [{ column: 'Tissue', op: '=', value: 'liver' }] })),
    response(call('finish', { results: ['livre'] })),
    response(call('finish', { results: ['liver'], note: 'MET has no recorded liver value' }))
  ]);
  const result = await run({ genes: ['EGFR', 'MET'], question: 'liver nTPM' });
  assert.equal(result.status, 'ok');
  assert.equal(result.note, 'MET has no recorded liver value');
  assert.match(requests[2].messages[1].content, /finish\(results=\["livre"\]\) failed: no result named livre; results so far: liver/);
});
