'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { createBulkTools } = require('../../src/system/agents/investigatorBulkTools');

function fixture(values) {
  const supplied = values.map((_, i) => `INPUT_${i}`), resolved = supplied.map((gene, i) => ({ gene, ensembl: `id_${i}` }));
  const entry = { file: 'source.tsv', key: 'ensembl', columns: ['Gene', 'Observed'] };
  const byGene = new Map(resolved.map((gene, i) => [gene.ensembl, [{ Gene: gene.ensembl, Observed: values[i] }]]));
  let reads = 0;
  const adapter = { async entry() { return entry; }, async catalog() { return [entry]; }, async resolveGenes() { return resolved; }, async readMany() { reads++; return { entry, byGene }; } };
  return { supplied, resolved, entry, byGene, adapter, ops: createBulkTools({ supplied, resolved, adapter }), get reads() { return reads; } };
}
const lookup = (as, aggregate) => ({ table: 'source.tsv', match_column: 'Gene', mode: 'scalar', value_column: 'Observed', as, ...(aggregate ? { aggregate } : {}) });

test('nonaggregated scalar lookup preserves exact present JSON scalar type and lexical spelling', async () => {
  const values = ['0', '001', '1e3', ' -2 ', 0, -2, false, 'false', 'NA', '', null, undefined];
  const f = fixture(values), before = structuredClone([...f.byGene]);
  const out = await f.ops.applyBulk({ name: 'literal_values', lookups: [lookup('source_value')], derive: [{ name: 'doubled', expr: 'source_value * 2' }] });
  assert.deepEqual(out.rows.map(row => row.source_value), ['0', '001', '1e3', ' -2 ', 0, -2, false, 'false', null, null, null, null]);
  assert.deepEqual(out.rows.map(row => row.doubled), [0, 2, 2000, -4, 0, -4, null, null, null, null, null, null]);
  assert.equal(out.coverage[0].zero_output_values, 2); assert.equal(out.coverage[0].missing_output_values, 4);
  assert.deepEqual([...f.byGene], before); assert.equal(f.reads, 1);
});

test('explicit numeric scalar reductions stay numeric and missing source rows stay distinct from blank source values', async () => {
  const f = fixture(['001', '0', '']); f.byGene.set('id_1', []);
  const out = await f.ops.applyBulk({ name: 'reduced', lookups: [lookup('raw'), lookup('mean', 'mean'), lookup('count', 'count'), lookup('numeric', 'numeric_count')] });
  assert.deepEqual(out.rows.map(row => [row.raw, row.mean, row.count, row.numeric]), [['001', 1, 1, 1], [null, null, 0, 0], [null, null, 1, 0]]);
  assert.deepEqual(out.rows.map(row => [row.raw_source_rows, row.raw_missing_rows]), [[1, 0], [0, 0], [1, 1]]);
  assert.equal(f.reads, 1);
  f.byGene.get('id_0').push({ Gene: 'id_0', Observed: '1' });
  await assert.rejects(f.ops.applyBulk({ name: 'ambiguous', lookups: [lookup('value')] }), /explicit aggregate or rows mode/);
});

test('native Investigator returns literal scalar categories unchanged while explicit calculations remain numeric', async () => {
  const f = fixture(['0', '001']), filename = require.resolve('../../src/system/agents/investigatorBulk');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = loaded.require.bind(loaded); let turns = 0;
  loaded.require = name => name === '../../hpa/agentMode' ? { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'fixture' }; } } : name === '../../inference/gateway' ? { inference: { chat: { completions: { async create(request) {
    turns++; let tool, args;
    if (turns === 1) { tool = 'apply_bulk'; args = { name: 'literal', lookups: [lookup('label'), lookup('numeric', 'mean')] }; }
    else if (turns === 2) {
      const receipt = JSON.parse(request.messages.at(-1).content);
      assert.equal(receipt.preview, undefined);
      tool = 'open_result'; args = { name: 'literal', columns: ['label', 'numeric'], rows: 2 };
    } else {
      assert.equal(turns, 3); const receipt = JSON.parse(request.messages.at(-1).content);
      const columns = receipt.columns, rows = receipt.rows;
      assert.equal(rows[0][columns.indexOf('label')], '0'); assert.equal(rows[0][columns.indexOf('numeric')], 0);
      assert.equal(rows[1][columns.indexOf('label')], '001'); assert.equal(rows[1][columns.indexOf('numeric')], 1);
      tool = 'finish'; args = { results: ['literal'] };
    }
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: String(turns), type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  } } } } } : realRequire(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const result = await loaded.exports({ genes: f.supplied, question: 'Return exact source categories and an explicit numeric mean.' }, { reasoningEffort: 'low' }, f.adapter);
  assert.equal(result.status, 'ok', result.error); assert.equal(f.reads, 1);
  assert.deepEqual(result.tables[0].rows.map(row => [row.label, row.numeric]), [['0', 0], ['001', 1]]);
});
