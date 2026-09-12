'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, call, response, fakeAdapter, CONSENSUS, TISSUES, ROWS, GENES } = require('../helpers/deskStudyFixture');

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
  assert.deepEqual(result.tables[0].columns, ['gene', 'ensembl', 'Tissue', 'nTPM'], 'the read\'s bookkeeping is in the coverage, not in columns');
  assert.equal(result.tables[0].rows.length, 6, 'EGFR 2 + ERBB2 2 + MET 1 (blank nTPM) + NOPE 1 empty');
  assert.deepEqual(result.mapping, [{ field: 'nTPM', table: 'rna_tissue_consensus.tsv', column: 'nTPM' }]);
  assert.equal(result.note, 'the consensus table holds one nTPM per tissue');
  assert.deepEqual(result.unresolved, ['NOPE']);
  assert.equal(result.calls, 3, 'three turns, no gate');
  assert.equal(gates.length, 0, 'no gate call');
  // The desk of the second turn: the search's findings, compact, and nothing of any table.
  const desk2 = requests[1].messages[1].content;
  assert.match(desk2, /POINTS\n4 points supplied, 3 resolve as genes in the release; not genes of the release: NOPE\. First points: EGFR, ERBB2, MET, NOPE/);
  assert.match(desk2, /SEARCHES\nsearch "liver", "nTPM" →\n  liver \+ nTPM:\n    rna_tissue_consensus\.tsv \(Gene, Gene name, Tissue, nTPM\) — Consensus tissue RNA: liver: Tissue = liver \(3 rows\); nTPM: column nTPM\n  liver: tissues\.tsv \(Tissue = liver\)\n\nTABLES FOUND\n\(under SEARCHES\)\n/);
  assert.match(requests[0].messages[1].content, /TABLES FOUND\n\(none yet\)/);
  assert.doesNotMatch(desk2, /OPENED|columns: Gene, Gene name/, 'no table card');
  assert.ok(Buffer.byteLength(desk2) < 2500, `a turn's desk stays small: ${Buffer.byteLength(desk2)} bytes`);
  // The release's tables are listed in the system prompt, so a fetch needs no search to find the table.
  assert.match(requests[0].messages[0].content, /Tables of the release:\nrna_tissue_consensus\.tsv — Consensus tissue RNA \(4 columns\)\ntissues\.tsv — Tissue lookup \(2 columns\)$/);
  // The desk of the third turn: the result as one line.
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /RESULTS\nLiver and lung nTPM \(6 rows: gene, ensembl, Tissue, nTPM\) ← fetch table=rna_tissue_consensus\.tsv, fields=\["Tissue","nTPM"\]/);
  assert.match(desk3, /turn 2: fetch → "Liver and lung nTPM" \(6 rows; 3 points with rows, 1 not in the release\)/);
  assert.match(requests[0].messages[0].content, /You are the Investigator in a study over the Test Atlas/);
  assert.equal(requests[0].tools.length, 3);
  assert.ok(steps.some(s => s.stage === 'complete' && /Mapped: nTPM → rna_tissue_consensus\.tsv\.nTPM/.test(s.message)));
});


test('without a list, fetch returns every row a filter selects; with match, the points are values of a column', async () => {
  const table = await investigator([
    response(call('fetch', { title: 'Liver rows', description: 'Every gene in liver', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: '=', value: 'liver' }] })),
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
  assert.deepEqual(values.tables[0].columns, ['Tissue', 'gene', 'ensembl', 'nTPM']);
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
    response(call('fetch', { title: 'Heart rows', description: 'Every gene in heart', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: '=', value: 'Heart-' }] })),
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
    response(call('fetch', { title: 'Rows', description: 'Rows of the points', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Gene', op: 'in', value: 'ENSG1' }] })),
    response(call('fetch', { title: 'Rows', description: 'Rows of the points', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Gene', op: 'in', value: 'ENSG1' }] }))
  ]);
  const twice = await keyed.run({ points: ['EGFR', 'ERBB2'], question: 'nTPM of these genes' });
  assert.match(keyed.requests[1].messages[1].content, /turn 1: the where on Gene names 1 of the list's 2 points; the list selects the rows, so it is set aside\nturn 1: fetch → "Rows" \(5 rows/);
  assert.equal(twice.status, 'ok', 'the list selects the rows; a where on the key column is set aside');
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
  assert.match(desk2, /"EGFR" is a gene of the release \(EGFR = ENSG1\): fetch reads its rows for the list by its keys, no search of the point is needed; columns holding gene ids in the tables found: rna_tissue_consensus\.tsv · Gene\n  "ERBB2" is a gene of the release \(ERBB2 = ENSG2\): a where on a column of gene ids selects its rows; columns holding gene ids in the tables found: rna_tissue_consensus\.tsv · Gene/);
  assert.match(desk2, /consensus:\n    rna_tissue_consensus\.tsv \(Gene, Gene name, Tissue, nTPM\) — Consensus tissue RNA: consensus: its name or description\n/);
  assert.doesNotMatch(desk2, /text columns holding the words/, 'a key point is not scanned for');
  const scan = await investigator([
    response(call('search', { words: ['lung'] })),
    response(call('finish', { results: [], note: 'nothing to fetch' }))
  ], { adapter: { async profile(e) { return { rows: 6, capped: false, columns: e.columns.map(c => ({ column: c, kind: 'text', blank_pct: 0, distinct: '1000+', observed_values: null, examples: [], full_examples: [] })) }; } } });
  await scan.run({ question: 'rows in lung' });
  assert.match(scan.requests[1].messages[1].content, /text columns holding the words: rna_tissue_consensus\.tsv · Tissue = lung \(2 rows hold "lung"\); tissues\.tsv · Tissue = lung \(1 rows hold "lung"\)/);
});

test('points spelled otherwise than a column without a vocabulary are placed and matched by the spellings recorded at the source', async () => {
  const noVocabulary = { adapter: { async profile(e) { return { rows: 6, capped: false, columns: e.columns.map(c => c === 'nTPM' ? { column: c, kind: 'number', blank_pct: 17, distinct: '5', min: 0, max: 34.1, examples: [] } : { column: c, kind: 'text', blank_pct: 0, distinct: '1000+', observed_values: null, examples: [], full_examples: [] }) }; } } };
  const { run, requests } = await investigator([
    response(call('search', { words: ['nTPM'] })),
    response(call('fetch', { title: 'Liver rows', description: 'nTPM of the liver rows', table: 'rna_tissue_consensus.tsv', fields: ['nTPM'] })),
    response(call('finish', { results: ['Liver rows'], mapping: [{ field: 'nTPM', table: 'rna_tissue_consensus.tsv', column: 'nTPM' }] }))
  ], noVocabulary);
  const result = await run({ points: ['LI-VER'], question: 'nTPM of the rows of this tissue' });
  assert.equal(result.status, 'ok');
  assert.match(requests[1].messages[1].content, /the points are values of: rna_tissue_consensus\.tsv · Tissue \(LI-VER as liver\); tissues\.tsv · Tissue \(LI-VER as liver\)/);
  assert.match(requests[2].messages[1].content, /turn 2: the points are values of Tissue, not genes: matched against it\nturn 2: read "LI-VER" as "liver", the spelling of Tissue\nturn 2: fetch → "Liver rows" \(3 rows; 1 points with rows\)/);
  assert.deepEqual(result.tables[0].rows.map(r => [r.Tissue, r.gene, r.nTPM]), [['liver', 'EGFR', '32.2'], ['liver', 'ERBB2', '30.7'], ['liver', 'MET', null]]);
});

test('a where whose value is the point names the column the points are matched against', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'Liver rows', description: 'the rows of the liver', table: 'rna_tissue_consensus.tsv', fields: ['Gene name', 'nTPM'], where: [{ column: 'Tissue', op: '=', value: 'liver' }] })),
    response(call('finish', { results: ['Liver rows'], mapping: [{ field: 'nTPM', table: 'rna_tissue_consensus.tsv', column: 'nTPM' }] }))
  ]);
  const result = await run({ points: ['liver'], question: 'genes with their nTPM in this tissue' });
  assert.equal(result.status, 'ok');
  assert.match(requests[1].messages[1].content, /turn 1: the where on Tissue names the points: matched against it\nturn 1: fetch → "Liver rows" \(3 rows; 1 points with rows\)/);
  assert.ok(!result.tables[0].args.where?.length, 'the clause the match makes is set aside');
  assert.deepEqual(result.tables[0].rows.map(r => [r.Tissue, r.gene, r.nTPM]), [['liver', 'EGFR', '32.2'], ['liver', 'ERBB2', '30.7'], ['liver', 'MET', null]]);
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

test('finish naming no result title returns every result made', async () => {
  const { run } = await investigator([
    response(call('fetch', { title: 'liver', description: 'liver nTPM', table: 'rna_tissue_consensus.tsv', fields: ['nTPM'], where: [{ column: 'Tissue', op: '=', value: 'liver' }] })),
    response(call('finish', { results: ['EGFR: 32.2', 'MET: none'], note: 'MET has no recorded liver value' }))
  ]);
  const result = await run({ points: ['EGFR', 'MET'], question: 'liver nTPM' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tables.map(t => t.title), ['liver'], 'the values read are no titles; every result made is returned');
  assert.equal(result.note, 'MET has no recorded liver value');
});

test('without a list, a gene the question names is the point: its rows are read by its keys', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'EGFR nTPM', description: 'nTPM per tissue', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'] })),
    response(call('finish', { results: ['EGFR nTPM'] }))
  ]);
  const steps = [];
  const result = await run({ question: 'liver and lung nTPM of EGFR' }, { onStep: s => steps.push(s) });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tables[0].rows.map(r => [r.gene, r.Tissue, r.nTPM]), [['EGFR', 'liver', '32.2'], ['EGFR', 'lung', '14.1'], ['EGFR', 'heart', '0.0']], 'only the named gene\'s rows, not the whole table');
  assert.match(requests[0].messages[1].content, /POINTS\nNo list; the question names EGFR \(a gene of the release\): read as the point, by its keys, on either side of a pair table/);
  assert.ok(steps.some(s => s.stage === 'start' && /No list; the question names EGFR: the point\. Question:/.test(s.message)));
});

test('a search that places no table not already found is nothing new, and two in a row end the run; a table name searched shows that table\'s card once', async () => {
  const { run, requests } = await investigator([
    response(call('search', { words: ['liver'] })),
    response(call('search', { words: ['nTPM', 'rna_tissue_consensus.tsv'] })),
    response(call('search', { words: ['Tissue', 'rna_tissue_consensus'] })),
    response(call('search', { words: ['Gene'] })),
    response(call('finish', { results: [] }))
  ]);
  const result = await run({ points: ['EGFR'], question: 'liver nTPM' });
  assert.equal(result.status, 'partial');
  assert.equal(result.stop_reason, 'no_progress');
  const desk3 = requests[2].messages[1].content;
  assert.match(desk3, /search "nTPM", "rna_tissue_consensus\.tsv" →\n  nTPM \+ rna_tissue_consensus:\n    rna_tissue_consensus\.tsv \(Gene, Gene name, Tissue, nTPM\) — Consensus tissue RNA: nTPM: column nTPM; rna_tissue_consensus: its name\n  rna_tissue_consensus\.tsv — Consensus tissue RNA \(4 columns; rows per gene\):\n    Gene = 3 values, e\.g\. ENSG1 \| ENSG2\n    Gene name = 3 values, e\.g\. x\n    Tissue = liver \| lung \| heart\n    nTPM: number 0–34\.1 \(blank 17%\)/, 'the table named is shown whole: every column with what it records');
  assert.match(desk3, /turn 2: searched "nTPM", "rna_tissue_consensus\.tsv" \(under SEARCHES\)/);
  const desk4 = requests[3].messages[1].content;
  assert.match(desk4, /search "Tissue", "rna_tissue_consensus" →\n[^]*\(nothing new: every table here was found already; fetch from one, search a table's name for its columns and values, or search other words\)/, 'the card is shown once');
  assert.match(desk4, /turn 3: searched "Tissue", "rna_tissue_consensus": nothing new \(under SEARCHES\)/);
  assert.equal(requests.length, 4, 'the second fruitless search in a row ends the run before a fifth call');
});

const PAIRS = { file: 'interaction_consensus.tsv', key: 'stream', title: 'Interactions', description: 'Gene pairs', columns: ['ensembl_gene_id_1', 'ensembl_gene_id_2', 'datasets'], hpaVersion: 'test' };
const PAIR_ROWS = [{ ensembl_gene_id_1: 'ENSG1', ensembl_gene_id_2: 'ENSG2', datasets: 'a' }, { ensembl_gene_id_1: 'ENSG3', ensembl_gene_id_2: 'ENSG1', datasets: 'b' }, { ensembl_gene_id_1: 'ENSG2', ensembl_gene_id_2: 'ENSG3', datasets: 'c' }];
const withPairs = () => ({
  catalog: async () => [CONSENSUS, TISSUES, PAIRS],
  entry: async name => [CONSENSUS, TISSUES, PAIRS].find(e => e.file === name || e.file === `${name}.tsv`) || null,
  async *rows(e) { if (e === PAIRS) { for (const r of PAIR_ROWS) yield r; } else if (e === CONSENSUS) { for (const g of GENES) for (const r of ROWS[g.ensembl]) yield r; } else { yield { Tissue: 'liver', Organ: 'Liver & Gallbladder' }; } },
  async profile(e) { return e === PAIRS ? { rows: 3, capped: false, columns: PAIRS.columns.map(c => ({ column: c, kind: 'text', blank_pct: 0, distinct: '3', observed_values: c === 'datasets' ? ['a', 'b', 'c'] : null, full_examples: c === 'datasets' ? ['a'] : ['ENSG1', 'ENSG2'], examples: c === 'datasets' ? ['a'] : ['ENSG1', 'ENSG2'] })) } : fakeAdapter().profile(e); }
});

test('a where naming one gene in both id columns of a pair table reads the gene on either side, as a point', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'EGFR pairs', description: 'Pairs of EGFR', table: 'interaction_consensus.tsv', fields: ['datasets'], where: [{ column: 'ensembl_gene_id_1', op: '=', value: 'EGFR' }, { column: 'ensembl_gene_id_2', op: '=', value: 'EGFR' }] })),
    response(call('finish', { results: ['EGFR pairs'] }))
  ], { adapter: withPairs() });
  const result = await run({ question: 'interaction partners of the gene named in the filter' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tables[0].rows.map(r => [r.other, r.datasets]).sort(), [['ENSG2', 'a'], ['ENSG3', 'b']], 'both sides are read; the partner is other');
  assert.match(requests[1].messages[1].content, /interaction_consensus\.tsv holds gene ids on both sides: ENSG1 is read as the point, matched against ensembl_gene_id_1 and ensembl_gene_id_2; the other side is other/);
});

test('a where that matches no row names a gene of the release as a point, and says when its clauses hold on no row together', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'Heart', description: 'ERBB2 in heart', table: 'rna_tissue_consensus.tsv', fields: ['nTPM'], where: [{ column: 'Gene', op: '=', value: 'ENSG2' }, { column: 'Tissue', op: '=', value: 'heart' }] })),
    response(call('finish', { results: ['Heart'] }))
  ]);
  const result = await run({ question: 'nTPM in heart of the gene named in the filter' });
  assert.equal(result.status, 'ok');
  assert.equal(result.tables[0].rows.length, 0);
  assert.match(requests[1].messages[1].content, /no row of rna_tissue_consensus\.tsv matched the where \(all 2 clauses at once\): "ENSG2" is a gene of the release \(ERBB2 = ENSG2\): sent as a point it is read by its keys\. "heart" is recorded in tissues\.tsv · Tissue = heart/);
  assert.doesNotMatch(requests[1].messages[1].content, /recorded nowhere/);
});

test('points taken from a column of an earlier result are matched against an id column under their ids', async () => {
  const { run, requests } = await investigator([
    response(call('fetch', { title: 'Liver rows', description: 'Every gene in liver', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], where: [{ column: 'Tissue', op: '=', value: 'liver' }] })),
    response(call('fetch', { title: 'Lung by name', description: 'Lung nTPM of the liver genes', table: 'rna_tissue_consensus.tsv', fields: ['Tissue', 'nTPM'], from: 'Liver rows', column: 'gene', match: 'Gene', where: [{ column: 'Tissue', op: '=', value: 'lung' }] })),
    response(call('finish', { results: ['Lung by name'] }))
  ]);
  const result = await run({ question: 'lung nTPM of every gene expressed in liver' });
  assert.equal(result.status, 'ok');
  assert.equal(result.tables[0].coverage.with_rows, 2, 'EGFR and ERBB2 have lung rows; the symbols found the id column');
  assert.match(requests[2].messages[1].content, /turn 2: fetch for the 3 values of "Liver rows" gene → "Lung by name" \(3 rows; 2 points with rows, 1 with no row matching the filter\)/);
});
