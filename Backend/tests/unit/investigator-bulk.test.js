'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, call, response, fakeAdapter } = require('../helpers/deskStudyFixture');

async function investigator(script, options = {}) {
  const requests = [], gates = [];
  const stubs = {
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) { requests.push(request); const next = script.shift(); if (!next) throw new Error('script exhausted'); return typeof next === 'function' ? next(request) : next; } } } } },
    // The gate is its own small model call; tests script its verdict.
    // The stub touches the stats the way the real call does, so a mismatch in their shape fails here.
    '../../inference/jsonCall': { jsonCall: async (system, user, onStep, label, stats) => { gates.push({ system, user, label }); stats.promptTokens += 50; stats.completionTokens += 10; stats.totalTokens += 60; stats.perStep[label] = stats.perStep[label] || { prompt: 0, completion: 0, total: 0 }; stats.perStep[label].total += 60; return options.gate || { accepted: true, reason: 'one field in one context' }; } },
    '../../policy/config': { platformConfig: () => ({ asoMaxSteps: options.maxTurns || 8 }) },
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../hpa/localData': { FILES: { master: 'proteinatlas.tsv' } }
  };
  const run = await loadWithStubs('src/system/agents/investigatorBulk.js', stubs);
  return { run: (args, ctx = {}) => run(args, ctx, fakeAdapter(options.adapter)), requests, gates };
}

test('the investigator searches the release, fetches for the whole list and returns the mapping with its reasoning', async () => {
  const steps = [];
  const { run, requests, gates } = await investigator([
    response(call('search', { words: ['liver', 'nTPM'] })),
    response(call('fetch', { title: 'Liver and lung nTPM', description: 'Consensus nTPM in liver and lung for the list', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: 'in', value: 'liver,lung' }] })),
    response(call('finish', { results: ['Liver and lung nTPM'], mapping: [{ field: 'nTPM', table: 'rna_tissue_consensus.tsv', column: 'nTPM' }], note: 'the consensus table holds one nTPM per tissue' }))
  ]);
  const result = await run({ points: ['EGFR', 'ERBB2', 'MET', 'NOPE'], question: 'liver and lung nTPM' }, { onStep: s => steps.push(s) });
  assert.equal(result.status, 'ok');
  assert.equal(result.tables.length, 1);
  assert.equal(result.tables[0].title, 'Liver and lung nTPM');
  assert.deepEqual(result.tables[0].columns, ['gene', 'ensembl', 'Tissue', 'nTPM', 'source_rows', 'source_status']);
  assert.equal(result.tables[0].rows.length, 6, 'EGFR 2 + ERBB2 2 + MET 1 (blank nTPM) + NOPE 1 empty');
  assert.deepEqual(result.mapping, [{ field: 'nTPM', table: 'rna_tissue_consensus.tsv', column: 'nTPM' }]);
  assert.equal(result.note, 'the consensus table holds one nTPM per tissue');
  assert.deepEqual(result.unresolved, ['NOPE']);
  assert.equal(result.calls, 4, 'the gate and three turns');
  assert.equal(gates.length, 1);
  assert.match(gates[0].user, /Question: liver and lung nTPM\nPoints: 4 \(EGFR, ERBB2, MET, …\)/);
  // The desk of the second turn: the search's findings, compact, and nothing of any table.
  const desk2 = requests[1].messages[1].content;
  assert.match(desk2, /POINTS\n4 points supplied, 3 resolve as genes in the release; not genes of the release: NOPE\. First points: EGFR, ERBB2, MET, NOPE/);
  assert.match(desk2, /SEARCHES\nsearch "liver", "nTPM" →\n  tables named by the words: rna_tissue_consensus\.tsv — Consensus tissue RNA: Consensus nTPM per tissue \(Gene, Gene name, Tissue, nTPM\)/);
  assert.match(desk2, /\n  columns named by the words: rna_tissue_consensus\.tsv · nTPM\n/);
  assert.match(desk2, /\n  values holding the words: rna_tissue_consensus\.tsv · Tissue = liver \(3 rows\); tissues\.tsv · Tissue = liver/);
  assert.doesNotMatch(desk2, /OPENED|columns: Gene, Gene name/, 'no table card');
  assert.ok(Buffer.byteLength(desk2) < 2500, `a turn's desk stays small: ${Buffer.byteLength(desk2)} bytes`);
  // The desk of the third turn: the result as one line.
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /RESULTS\nLiver and lung nTPM \(6 rows: gene, ensembl, Tissue, nTPM, source_rows, source_status\) ← fetch table=rna_tissue_consensus\.tsv, fields=\["Tissue","nTPM"\]/);
  assert.match(desk3, /turn 2: fetch → "Liver and lung nTPM" \(6 rows; 3 points with rows, 1 not in the release\)/);
  assert.match(requests[0].messages[0].content, /You are the Investigator in a study over the Test Atlas/);
  assert.equal(requests[0].tools.length, 3);
  assert.ok(steps.some(s => s.stage === 'complete' && /Mapped: nTPM → rna_tissue_consensus\.tsv\.nTPM/.test(s.message)));
});

test('the gate rejects a question that asks for several contexts, and nothing is read', async () => {
  const { run, requests } = await investigator([], { gate: { accepted: false, reason: 'asks for three contexts (heart, liver, blood); ask for one at a time' } });
  const result = await run({ points: ['EGFR'], question: 'heart, liver and blood nTPM' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.stop_reason, 'rejected');
  assert.deepEqual(result.tables, []);
  assert.equal(result.error, 'rejected: asks for three contexts (heart, liver, blood); ask for one at a time');
  assert.equal(requests.length, 0, 'no turn was spent');
  assert.equal(result.calls, 1);
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
  assert.match(table.requests[1].messages[1].content, /POINTS\nNo list: the question selects rows by a filter\./);
  const matched = await investigator([
    response(call('fetch', { title: 'Tissue rows', description: 'Rows of the tissues', table: 'rna_tissue_consensus.tsv', fields: ['nTPM'], match: 'Tissue' })),
    response(call('finish', { results: ['Tissue rows'] }))
  ]);
  const values = await matched.run({ points: ['liver', 'heart'], question: 'nTPM of every gene in these tissues' });
  assert.equal(values.status, 'ok');
  assert.deepEqual(values.tables[0].columns, ['Tissue', 'gene', 'ensembl', 'nTPM', 'source_rows', 'source_status']);
  assert.deepEqual(values.tables[0].rows.map(r => [r.Tissue, r.gene]), [['liver', 'EGFR'], ['liver', 'ERBB2'], ['liver', 'MET'], ['heart', 'EGFR']]);
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
});

test('a filter value or a point the table spells differently is read as the table spells it; a where on the key column beside a list is refused', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'Heart rows', description: 'Every gene in heart', table: 'rna_tissue_consensus.tsv', where: [{ column: 'Tissue', op: '=', value: 'Heart-' }] })),
    response(call('finish', { results: ['Heart rows'] }))
  ]);
  const result = await run({ question: 'every gene with its heart nTPM' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tables[0].args.where, [{ column: 'Tissue', op: '=', value: 'heart' }]);
  assert.match(requests[1].messages[1].content, /turn 1: read "Heart-" as "heart", the spelling of Tissue\nturn 1: fetch → "Heart rows" \(1 rows/);
  const points = await investigator([
    response(call('fetch', { title: 'Rows', description: 'Rows of the points', table: 'rna_tissue_consensus.tsv', fields: ['nTPM'] })),
    response(call('finish', { results: ['Rows'] }))
  ]);
  const matched = await points.run({ points: ['Liver-', 'heart'], question: 'nTPM of every gene in these tissues' });
  assert.equal(matched.tables[0].args.match, 'Tissue');
  assert.match(points.requests[1].messages[1].content, /turn 1: the points are values of Tissue, not genes: matched against it\nturn 1: read "Liver-" as "liver", the spelling of Tissue/);
  const keyed = await investigator([
    response(call('fetch', { title: 'Rows', description: 'Rows of the points', table: 'rna_tissue_consensus.tsv', where: [{ column: 'Gene', op: 'in', value: 'ENSG1' }] })),
    response(call('fetch', { title: 'Rows', description: 'Rows of the points', table: 'rna_tissue_consensus.tsv', where: [{ column: 'Gene', op: 'in', value: 'ENSG1, ENSG2' }] })),
    response(call('fetch', { title: 'Rows', description: 'Rows of the points', table: 'rna_tissue_consensus.tsv', where: [{ column: 'Gene', op: 'in', value: 'ENSG1, ENSG2' }] }))
  ]);
  const twice = await keyed.run({ points: ['EGFR', 'ERBB2'], question: 'nTPM of these genes' });
  assert.match(keyed.requests[1].messages[1].content, /failed: the list already selects the rows by Gene; this where names 1 of its 2 points and would drop the rest \(ERBB2\)\. Leave that clause out/);
  assert.equal(twice.status, 'ok', 'a where naming every point of the list changes nothing and is allowed');
  assert.equal(twice.tables[0].rows.length, 5);
  assert.equal(twice.note, 'returned when the same fetch was asked again; the mapping is read from the fetches', 'a fetch asked again after it was made returns the results');
  assert.deepEqual(twice.mapping, [{ field: 'Tissue', table: 'rna_tissue_consensus.tsv', column: 'Tissue' }, { field: 'nTPM', table: 'rna_tissue_consensus.tsv', column: 'nTPM' }], 'the mapping is read from the fetch');
});

test('a search finds a word no vocabulary holds by scanning text columns, and says of a key point that the list reads it', async () => {
  const { run, requests } = await investigator([
    response(call('search', { words: ['consensus', 'EGFR', 'ERBB2'] })),
    response(call('fetch', { title: 'Rows', description: 'EGFR rows', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'] })),
    response(call('finish', { results: ['Rows'] }))
  ]);
  const result = await run({ points: ['EGFR'], question: 'nTPM per tissue' });
  assert.equal(result.status, 'ok');
  const desk2 = requests[1].messages[1].content;
  assert.match(desk2, /"EGFR" is a gene of the release \(ENSG1\); "ERBB2" is a gene of the release \(ENSG2\): fetch reads its rows for the list by its keys, no search of the point is needed; columns holding gene ids in the tables found: rna_tissue_consensus\.tsv · Gene/);
  assert.match(desk2, /tables named by the words: rna_tissue_consensus\.tsv — Consensus tissue RNA/);
  assert.doesNotMatch(desk2, /text columns holding the words/, 'a key point is not scanned for');
  const scan = await investigator([
    response(call('search', { words: ['lung'] })),
    response(call('finish', { results: [], note: 'nothing to fetch' }))
  ], { adapter: { async profile(e) { return { rows: 6, capped: false, columns: e.columns.map(c => ({ column: c, kind: 'text', blank_pct: 0, distinct: '1000+', observed_values: null, examples: [], full_examples: [] })) }; } } });
  await scan.run({ question: 'rows in lung' });
  assert.match(scan.requests[1].messages[1].content, /text columns holding the words: rna_tissue_consensus\.tsv · Tissue = lung \(2 rows hold "lung"\); tissues\.tsv · Tissue = lung \(1 rows hold "lung"\)/);
});

test('a search that names nothing says so, and an Investigator that gives up says what it tried', async () => {
  const { run, requests } = await investigator([
    response(call('search', { words: ['zzz'] })),
    response(call('search', { words: ['zzz'] })),
    response(call('search', { words: ['zzz'] }))
  ]);
  const result = await run({ question: 'zzz of every gene' });
  assert.equal(result.status, 'partial');
  assert.equal(result.stop_reason, 'no_progress');
  assert.match(requests[1].messages[1].content, /search "zzz" →\n  nothing in the release is named by "zzz": try a word of the subject, or a value as the data spells it/);
  assert.match(result.error, /repeated itself without new evidence; it had tried: turn 1: searched "zzz" \(under SEARCHES\); turn 2: search\(words=\["zzz"\]\) repeated; under SEARCHES/);
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
