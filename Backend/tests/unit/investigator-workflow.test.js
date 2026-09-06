'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBulkTools } = require('../../src/system/agents/investigatorBulkTools');
const { createResultReducer } = require('../../src/system/agents/investigatorReduce');
const { createSavedOperations } = require('../../src/system/agents/investigatorResults');

function fixture() {
  let reads = 0;
  const entries = [{ file: 'records.tsv', key: 'ensembl', columns: ['Gene', 'place', 'observation', 'value'] }, { file: 'reference.tsv', key: 'ensembl', columns: ['Gene', 'place', 'comparison'] }];
  const source = [0, 0, 0, 10, 20].map((value, i) => ({ Gene: 'id', place: 'left', observation: i < 3 ? 'a' : i === 3 ? 'b' : 'c', value: String(value) }));
  source.push({ Gene: 'id', place: 'right', observation: 'a', value: '5' });
  const adapter = { async resolveGenes() { return [{ gene: 'ONE', ensembl: 'id' }]; }, async catalog() { return entries; }, async entry(file) { return entries.find(entry => entry.file === file); }, async readMany(genes, file) {
    reads++; if (file === 'missing.tsv') throw new Error('source unavailable');
    return { entry: entries.find(entry => entry.file === file), byGene: new Map([['id', structuredClone(file === 'records.tsv' ? source : [{ Gene: 'id', place: 'left', comparison: '1' }, { Gene: 'id', place: 'right', comparison: '2' }])]]) };
  } };
  const results = new Map(), reducer = createResultReducer({ results, release: 'fixture' });
  const bulkTools = createBulkTools({ supplied: ['ONE'], resolved: [{ gene: 'ONE', ensembl: 'id' }], adapter });
  const saved = createSavedOperations({ results, reducer, bulkTools });
  return { results, reducer, saved, adapter, source, get reads() { return reads; } };
}
const stages = () => [
  { name: 'samples', group_by_columns: ['place', 'observation'], measures: [{ column: 'value', metrics: ['median', 'count'], as: { median: 'sample_value', count: 'records' } }] },
  { name: 'places', group_by_columns: ['place'], measures: [{ column: 'sample_value', metrics: ['median'], as: { median: 'place_value' } }, { column: 'records', metrics: ['sum'], as: { sum: 'records' } }] }
];
const graph = () => ({ steps: [
  { id: 'source', tool: 'apply_bulk', args: { name: 'raw', lookups: [{ table: 'records.tsv', match_column: 'Gene', mode: 'rows', columns: ['place', 'observation', 'value'] }] } },
  { id: 'reference', tool: 'apply_bulk', args: { name: 'comparison', lookups: [{ table: 'reference.tsv', match_column: 'Gene', mode: 'rows', columns: ['place', 'comparison'] }] } },
  { id: 'classed', tool: 'classify', args: { artifact: '@source', result: 'classified', name: 'positive', rules: [{ where: [{ column: 'value', op: '>', value: 0 }], value: true }], otherwise: false } },
  { id: 'nested', tool: 'reduce_result', args: { from: '@classed', stages: stages() } },
  { id: 'joined', tool: 'join', args: { a: '@nested', b: '@reference', on_columns: ['gene', 'place'], how: 'full', result: 'joined' } },
  { id: 'correlated', tool: 'correlate', args: { artifact: '@joined', x: 'place_value', y: 'comparison', group_by: 'gene', method: 'spearman', result: 'correlated' } },
  { id: 'ranked', tool: 'rank', args: { artifact: '@correlated', by: 'r', result: 'ranked' } }
], outputs: ['ranked'] });

test('workflow composes actual raw retrieval, classification, nested reductions and saved correlations without source rereads', async () => {
  const f = fixture(), out = await f.saved.run(graph());
  assert.equal(out.status, 'completed', JSON.stringify(out)); assert.equal(f.reads, 2);
  assert.deepEqual([...f.results.keys()].sort(), ['raw', 'comparison', 'classified', 'samples', 'places', 'joined', 'correlated', 'ranked'].sort());
  assert.equal(f.results.get('places').rows.find(row => row.place === 'left').place_value, 10); // Pooled median would be 0.
  assert.equal(f.results.get('places').rows.find(row => row.place === 'left').records, 5);
  assert.equal(out.outputs[0].table.rows[0].r, -1); assert.equal(out.outputs[0].table.rows[0].n, 2);
  assert.equal(f.results.get('raw').rows[0].value, '0'); assert.equal(f.results.get('raw').rows[0].positive, undefined);
  assert.equal(f.results.get('classified').rows[0].positive, false); assert.deepEqual(f.saved.unfinished(), []);
  assert.equal(out.steps.find(step => step.id === 'nested').artifact, 'places');
});

test('whole workflow preflight rejects invalid schemas, cycles, duplicate stage names and untracked literal dependencies before reads or mutation', async () => {
  for (const edit of [
    g => { g.steps[3].args.stages_preprocessing = []; },
    g => { g.steps[3].args.stages[1].name = 'raw'; },
    g => { g.steps[3].args.stages = []; },
    g => { g.steps[3].args.from = '@missing'; },
    g => { g.steps[3].args.from = '@joined'; },
    g => { g.steps[4].args.a = 'places'; },
    g => { g.steps[6].tool = 'execute_code'; }
  ]) {
    const f = fixture(), g = graph(); edit(g);
    await assert.rejects(f.saved.run(g)); assert.equal(f.reads, 0); assert.equal(f.results.size, 0);
  }
});

test('failed later reduction keeps completed raw and intermediate outputs, blocks dependents and permits direct-tool repair', async () => {
  const f = fixture(), g = graph(); g.steps[3].args.stages[1].measures[0].column = 'absent';
  const out = await f.saved.run(g);
  assert.equal(out.status, 'partial'); assert.equal(f.reads, 2);
  assert.ok(f.results.has('raw')); assert.ok(f.results.has('samples')); assert.ok(!f.results.has('places'));
  assert.equal(out.steps.find(step => step.id === 'nested').status, 'failed');
  assert.equal(out.steps.find(step => step.id === 'joined').status, 'blocked'); assert.ok(f.saved.unfinished().length >= 4);
  const repaired = f.reducer.reduce({ from: 'samples', stages: [stages()[1]] }); assert.equal(repaired.status, 'completed');
  assert.ok(!f.saved.unfinished().some(item => item.requirement.endsWith('places')));
  await f.saved.execute('join', { a: 'places', b: 'comparison', on_columns: ['gene', 'place'], how: 'full', result: 'joined' });
  await f.saved.execute('correlate', { artifact: 'joined', x: 'place_value', y: 'comparison', group_by: 'gene', method: 'spearman', result: 'correlated' });
  await f.saved.execute('rank', { artifact: 'correlated', by: 'r', result: 'ranked' });
  assert.deepEqual(f.saved.unfinished(), []); assert.deepEqual(f.reducer.unfinished(), []); assert.equal(f.reads, 2);
});

test('source execution failure retains an independent completed lookup and blocks its dependent result', async () => {
  const f = fixture(), g = graph(); g.steps[0].args.lookups[0].table = 'missing.tsv';
  const out = await f.saved.run(g); assert.equal(out.status, 'partial'); assert.ok(f.results.has('comparison'));
  assert.ok(!f.results.has('raw')); assert.ok(!f.results.has('places')); assert.equal(out.steps.find(step => step.id === 'nested').status, 'blocked');
  assert.ok(f.saved.unfinished().some(item => item.requirement.endsWith('raw')));
});
