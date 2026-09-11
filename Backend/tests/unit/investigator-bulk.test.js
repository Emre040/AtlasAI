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

test('the investigator opens a table, asks for a column\'s values, fetches for the whole list and returns the raw rows', async () => {
  const steps = [];
  const { run, requests } = await investigator([
    response(call('open', { table: 'rna_tissue_consensus.tsv' }), call('columns', { table: 'rna_tissue_consensus.tsv', about: 'tpm' }), call('values', { table: 'rna_tissue_consensus.tsv', column: 'Tissue' })),
    response(call('fetch', { title: 'Liver and lung nTPM', description: 'Consensus nTPM in liver and lung for the list', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: 'in', value: 'liver,lung' }] })),
    response(call('finish', { results: ['Liver and lung nTPM'] }))
  ]);
  const result = await run({ points: ['EGFR', 'ERBB2', 'MET', 'NOPE'], question: 'liver and lung nTPM' }, { onStep: s => steps.push(s) });
  assert.equal(result.status, 'ok');
  assert.equal(result.tables.length, 1);
  assert.equal(result.tables[0].title, 'Liver and lung nTPM');
  assert.deepEqual(result.tables[0].columns, ['gene', 'ensembl', 'Tissue', 'nTPM', 'source_rows', 'source_status']);
  assert.equal(result.tables[0].rows.length, 6, 'EGFR 2 + ERBB2 2 + MET 1 (blank nTPM) + NOPE 1 empty');
  assert.deepEqual(result.tables[0].args, { table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: 'in', value: 'liver,lung' }] });
  assert.deepEqual(result.unresolved, ['NOPE']);
  assert.equal(result.calls, 3);
  // The desk of the second turn: the table as its column names plus the one column asked for.
  const desk2 = requests[1].messages[1].content;
  assert.match(desk2, /OPENED\nrna_tissue_consensus\.tsv — Consensus tissue RNA\. Consensus nTPM per tissue \[rows per gene\]; 4 columns \(values from 6 rows\)\n  columns: Gene, Gene name, Tissue, nTPM\n  Tissue: 3 values: liver \| lung \| heart\n/);
  assert.match(desk2, /turn 1: columns of rna_tissue_consensus\.tsv about "tpm": nTPM\n/);
  assert.doesNotMatch(desk2, /nTPM: number/, 'a column not asked for shows no values');
  // The desk of the third turn: the result as one line, no rows.
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /RESULTS\nLiver and lung nTPM \(6 rows: gene, ensembl, Tissue, nTPM, source_rows, source_status\) ← fetch table=rna_tissue_consensus\.tsv, fields=\["Tissue","nTPM"\]/);
  assert.match(desk3, /\n  Consensus nTPM in liver and lung for the list\n  0: EGFR \| ENSG1 \| liver \| 32\.2 \| 2 \| ok\n/, 'a result of a few rows sits on the desk whole');
  assert.match(desk3, /HISTORY\nturn 1: opened rna_tissue_consensus\.tsv \(on the desk\)\nturn 1: columns of rna_tissue_consensus\.tsv about "tpm": nTPM\nturn 1: values of rna_tissue_consensus\.tsv Tissue \(on its card\)\nturn 2: fetch → "Liver and lung nTPM" \(6 rows; 3 points with rows, 1 not in the release\)/);
  assert.match(requests[0].messages[0].content, /You are the Investigator in a study over the Test Atlas/);
  assert.match(requests[0].messages[0].content, /TABLES \(2; find_tables narrows them by a word, open one for its columns\)\nrna_tissue_consensus\.tsv, tissues\.tsv/);
  assert.equal(requests[0].tools.length, 6);
  assert.ok(steps.some(s => s.stage === 'complete'));
});

test('without a list, fetch returns every row a filter selects; with match, the points are values of a column', async () => {
  const table = await investigator([
    response(call('fetch', { title: 'Liver rows', description: 'Every gene in liver', table: 'rna_tissue_consensus.tsv', where: [{ column: 'Tissue', op: '=', value: 'liver' }] })),
    response(call('finish', { results: ['Liver rows'] }))
  ]);
  const whole = await table.run({ question: 'every gene with its liver nTPM' });
  assert.equal(whole.status, 'ok');
  assert.deepEqual(whole.tables[0].columns, ['gene', 'ensembl', 'Tissue', 'nTPM']);
  assert.deepEqual(whole.tables[0].rows.map(r => [r.gene, r.nTPM]), [['EGFR', '32.2'], ['ERBB2', '30.7'], ['MET', null]]);
  assert.deepEqual(whole.tables[0].coverage, { rows: 3, scanned: 6 });
  assert.match(table.requests[1].messages[1].content, /LIST\nNo list: the question selects rows by a filter\./);
  const matched = await investigator([
    response(call('fetch', { title: 'Genes per tissue', description: 'Every gene measured in each tissue', table: 'rna_tissue_consensus.tsv', fields: ['nTPM'], match: 'Tissue' })),
    response(call('finish', { results: ['Genes per tissue'] }))
  ]);
  const byTissue = await matched.run({ points: ['liver', 'Lung', 'skin'], question: 'nTPM of every gene per tissue' });
  assert.equal(byTissue.status, 'ok');
  assert.deepEqual(byTissue.tables[0].columns, ['Tissue', 'gene', 'ensembl', 'nTPM', 'source_rows', 'source_status']);
  assert.deepEqual(byTissue.tables[0].rows.map(r => [r.Tissue, r.gene, r.nTPM, r.source_status]), [['liver', 'EGFR', '32.2', 'ok'], ['liver', 'ERBB2', '30.7', 'ok'], ['liver', 'MET', null, 'ok'], ['lung', 'EGFR', '14.1', 'ok'], ['lung', 'ERBB2', '34.1', 'ok'], ['skin', null, null, 'no rows in table']]);
  assert.deepEqual(byTissue.tables[0].args, { table: 'rna_tissue_consensus.tsv', fields: ['nTPM'], match: 'Tissue' });
  assert.match(matched.requests[0].messages[1].content, /LIST\n3 points supplied; none is a gene of the release, so fetch matches them against a column \(match\)/);
});

test('errors come back as history lines with the columns the model needs, and repeats under new titles stop the loop', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'x', description: 'y', table: 'rna_tissue_consensus.tsv', fields: ['expression'] })),
    response(call('fetch', { title: 'x again', description: 'y', table: 'rna_tissue_consensus.tsv', fields: ['expression'] })),
    response(call('fetch', { title: 'x once more', description: 'y', table: 'rna_tissue_consensus.tsv', fields: ['expression'] }))
  ]);
  const result = await run({ points: ['EGFR'], question: 'expression' });
  assert.equal(result.status, 'partial');
  assert.equal(result.stop_reason, 'no_progress');
  assert.match(requests[1].messages[1].content, /turn 1: fetch\(title=x, description=y, table=rna_tissue_consensus\.tsv, fields=\["expression"\]\) failed: rna_tissue_consensus\.tsv has no column "expression"; its columns: Gene, Gene name, Tissue, nTPM/);
  assert.match(requests[1].messages[1].content, /OPENED\nrna_tissue_consensus\.tsv/, 'a fetch opens the table on the desk even when it fails');
});

test('finish without a matching result is refused with the titles that exist', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'liver', description: 'liver nTPM', table: 'rna_tissue_consensus.tsv', fields: ['nTPM'], where: [{ column: 'Tissue', op: '=', value: 'liver' }] })),
    response(call('finish', { results: ['livre'] })),
    response(call('finish', { results: ['liver'], note: 'MET has no recorded liver value' }))
  ]);
  const result = await run({ points: ['EGFR', 'MET'], question: 'liver nTPM' });
  assert.equal(result.status, 'ok');
  assert.equal(result.note, 'MET has no recorded liver value');
  assert.match(requests[2].messages[1].content, /finish\(results=\["livre"\]\) failed: no result titled livre; results so far: liver/);
});

test('a fetch takes its points from a column of an earlier result: what one table lists is read from another', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'Liver rows', description: 'Every gene with a liver row', table: 'rna_tissue_consensus.tsv', fields: ['nTPM'], where: [{ column: 'Tissue', op: '=', value: 'liver' }] })),
    response(call('fetch', { title: 'Lung nTPM of those', description: 'Lung nTPM for each gene of Liver rows', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: '=', value: 'lung' }], from: 'Liver rows', column: 'nope' })),
    response(call('fetch', { title: 'Lung nTPM of those', description: 'Lung nTPM for each gene of Liver rows', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: '=', value: 'lung' }], from: 'Liver rows', column: 'gene' })),
    response(call('finish', { results: ['Liver rows', 'Lung nTPM of those'] }))
  ]);
  const result = await run({ question: 'the lung nTPM of every gene with a liver row' });
  assert.equal(result.status, 'ok');
  assert.equal(result.tables.length, 2);
  const second = result.tables[1];
  assert.deepEqual(second.args, { table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: '=', value: 'lung' }], from: 'Liver rows', column: 'gene' });
  assert.equal(second.coverage.supplied, 3, 'the three genes of Liver rows are the points');
  assert.deepEqual(second.rows.map(r => [r.gene, r.nTPM]), [['EGFR', '14.1'], ['ERBB2', '34.1'], ['MET', null]]);
  assert.match(requests[2].messages[1].content, /failed: "Liver rows" has no column "nope"; its columns: /);
  assert.match(requests[3].messages[1].content, /turn 3: fetch for the 3 values of "Liver rows" gene → "Lung nTPM of those" \(3 rows; 2 points with rows, 1 with no row matching the filter\)/);
  assert.equal(result.calls, 4);
});

test('a filter value the table spells differently is read as the table spells it, and the history says so', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'Heart rows', description: 'Every gene in heart', table: 'rna_tissue_consensus.tsv', where: [{ column: 'Tissue', op: '=', value: 'Heart-' }] })),
    response(call('finish', { results: ['Heart rows'] }))
  ]);
  const result = await run({ question: 'every gene with its heart nTPM' });
  assert.equal(result.status, 'ok');
  assert.equal(result.tables[0].rows.length, 1);
  assert.deepEqual(result.tables[0].args.where, [{ column: 'Tissue', op: '=', value: 'heart' }]);
  assert.match(requests[1].messages[1].content, /turn 1: read "Heart-" as "heart", the spelling of Tissue\nturn 1: fetch → "Heart rows" \(1 rows/);
});

test('a point matched against a column is read as the column spells it', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'Heart rows', description: 'Rows of the points', table: 'rna_tissue_consensus.tsv', match: 'Tissue' })),
    response(call('finish', { results: ['Heart rows'] }))
  ]);
  const result = await run({ points: ['Heart-'], question: 'rows of these tissues' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tables[0].rows.map(r => [r.Tissue, r.gene]), [['heart', 'EGFR']]);
  assert.match(requests[1].messages[1].content, /turn 1: read "Heart-" as "heart", the spelling of Tissue/);
});

test('points that are not entities are matched against the one column that holds them, spelling corrected; a where on the key column beside a list is refused', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'Rows', description: 'Rows of the points', table: 'rna_tissue_consensus.tsv', fields: ['nTPM'] })),
    response(call('finish', { results: ['Rows'] }))
  ]);
  const result = await run({ points: ['Liver-', 'heart'], question: 'nTPM of every gene in these tissues' });
  assert.equal(result.status, 'ok');
  assert.equal(result.tables[0].args.match, 'Tissue');
  assert.deepEqual(result.tables[0].rows.map(r => [r.Tissue, r.gene]), [['liver', 'EGFR'], ['liver', 'ERBB2'], ['liver', 'MET'], ['heart', 'EGFR']]);
  assert.match(requests[1].messages[1].content, /turn 1: the points are values of Tissue, not genes: matched against it\nturn 1: read "Liver-" as "liver", the spelling of Tissue/);
  const keyed = await investigator([
    response(call('fetch', { title: 'Rows', description: 'Rows of the points', table: 'rna_tissue_consensus.tsv', where: [{ column: 'Gene', op: 'in', value: 'ENSG1' }] })),
    response(call('finish', { results: [], note: 'stopped' }))
  ]);
  const refused = await keyed.run({ points: ['EGFR', 'ERBB2'], question: 'nTPM of these genes' });
  assert.equal(refused.status, 'ok');
  assert.match(keyed.requests[1].messages[1].content, /failed: the list already selects the rows by Gene; a where on Gene can only drop points from it\. Leave that clause out/);
});

test('a word that is a value is not a table, and an Investigator that gives up says what it tried', async () => {
  const { run, requests } = await investigator([
    response(call('find_tables', { about: 'heart' })),
    response(call('find_tables', { about: 'heart' })),
    response(call('find_tables', { about: 'heart' }))
  ]);
  const result = await run({ question: 'heart nTPM of every gene' });
  assert.equal(result.status, 'partial');
  assert.equal(result.stop_reason, 'no_progress');
  assert.match(requests[1].messages[1].content, /no table has "heart" in its name, title, description, columns or recorded values; a value \(a category, a sample, a name\) lives in a column: find the table by a word of its subject, open it, and ask values for the column that could hold it/);
  assert.match(result.error, /repeated itself without new evidence; it had tried: turn 1: find_tables "heart" → no table has "heart" in its name, title, description, columns or recorded values; a value/);
});

test('a table search also finds a word among a column\'s recorded values, with the spelling the data uses', async () => {
  const { run, requests } = await investigator([
    response(call('find_tables', { about: 'Heart' })),
    response(call('fetch', { title: 'Heart rows', description: 'Every gene in heart', table: 'rna_tissue_consensus.tsv', where: [{ column: 'Tissue', op: '=', value: 'heart' }] })),
    response(call('finish', { results: ['Heart rows'] }))
  ], { adapter: { async findValues(word) { return word === 'heart' ? [{ file: 'rna_tissue_consensus.tsv', column: 'Tissue', inside: false, values: ['heart'], more: 0 }] : []; } } });
  const result = await run({ question: 'every gene with its heart nTPM' });
  assert.equal(result.status, 'ok');
  assert.match(requests[1].messages[1].content, /turn 1: find_tables "Heart" →\n    rna_tissue_consensus\.tsv — its column Tissue holds: heart\n/);
});
