'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { buildRequest } = require('../../src/inference/adapters/geminiGenerateContent');

async function run(decide, { size = 3, question = 'Read Signal in region α only. Preserve the source spelling and missing records.' } = {}) {
  const names = Array.from({ length: size }, (_, i) => `INPUT_${i}`);
  const resolved = names.map((gene, i) => ({ gene, ensembl: `ID_${i}` }));
  const entry = { file: 'newly-imported.tsv', key: 'ensembl', description: 'Measured source observations.', columns: ['Identifier', 'Region', 'Signal', 'Annotation'] };
  const byGene = new Map(resolved.map((gene, i) => [gene.ensembl, [
    { Identifier: gene.ensembl, Region: 'α', Signal: i === 0 ? 0 : i === 1 ? null : `00${i}`, Annotation: 'EXACT_SOURCE_NOTE' },
    { Identifier: gene.ensembl, Region: 'β', Signal: '-2', Annotation: 'SECOND_SOURCE_NOTE' },
    { Identifier: gene.ensembl, Region: 'γ', Signal: '999', Annotation: 'NOT_AN_INSPECTION_SAMPLE' }
  ]]));
  const filename = require.resolve('../../src/system/agents/investigatorBulk');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded), requests = [];
  const reads = { single: 0, bulk: 0 };
  loaded.require = name => {
    assert.ok(!['./investigatorResults', './investigatorReduce', './operationSupersession', '../aso/capabilityCatalog'].includes(name), `Investigator must not load study workflow machinery: ${name}`);
    if (name === '../../hpa/agentMode') return { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } };
    if (name === '../../inference/gateway') return { inference: { chat: { completions: { async create(request) {
      requests.push(structuredClone(request));
      assert.deepEqual(request.tools.map(t => t.function.name).sort(), ['apply_bulk', 'finish', 'inspect_input', 'inspect_table', 'open_result']);
      assert.equal(request.reasoning_effort, 'low');
      assert.ok(request.messages[1].content.endsWith(`ASSIGNMENT\nQuestion: ${question}`));
      assert.doesNotMatch(JSON.stringify(request), /PARENT_STUDY_DELIVERABLE|PARENT_PLAN_DELIVERABLE/);
      const actions = decide({ request, turn: requests.length, reads });
      return { choices: [{ message: { role: 'assistant', tool_calls: actions.map(([name, args], index) => ({ id: `c${requests.length}_${index}`, type: 'function', thought_signature: 'native-signature', function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 4, completion_tokens: 1 } };
    } } } } };
    return original(name);
  };
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const adapter = {
    async catalog() { return [entry]; }, async entry(file) { return file === entry.file ? entry : null; }, async resolveGenes() { return resolved; },
    async read(gene) { reads.single++; return { entry, rows: byGene.get(gene.ensembl) }; },
    async readMany() { reads.bulk++; return { entry, byGene }; }
  };
  const result = await loaded.exports({ genes: names, question }, { reasoningEffort: 'low', studyGoal: 'PARENT_STUDY_DELIVERABLE', studyTask: 'PARENT_PLAN_DELIVERABLE' }, adapter);
  return { result, requests, reads };
}

const lookup = ['apply_bulk', { name: 'readings', lookups: [{ table: 'newly-imported.tsv', match_column: 'Identifier', value_column: 'Signal', as: 'signal', where: [{ column: 'Region', op: '=', value: 'α' }] }] }];

test('focused bulk discovery handles the full supplied list and archives old observations without losing exact retrieval', async () => {
  let schema;
  const { result, requests, reads } = await run(({ request, turn }) => {
    if (turn === 1) return [['inspect_table', { table: 'newly-imported.tsv' }]];
    const latest = JSON.parse(request.messages.at(-1).content);
    if (turn === 2) {
      schema = latest;
      assert.equal(schema.sample.rows.length, 2);
      assert.equal(schema.sample.more, true);
      assert.doesNotMatch(JSON.stringify(schema), /NOT_AN_INSPECTION_SAMPLE/);
      return [lookup];
    }
    if (turn === 3) {
      assert.equal(latest.rows, 600); assert.equal(latest.coverage[0].matched_source_rows, 600);
      assert.doesNotMatch(JSON.stringify(request), /INPUT_599|EXACT_SOURCE_NOTE/);
      assert.deepEqual(JSON.parse(request.messages.find(m => m.tool_call_id === 'c1_0').content), { archived_call: 'c1_0', table: 'newly-imported.tsv', column_count: 4 });
      return [['open_result', { name: 'readings', rows: 2, columns: ['gene', 'signal'] }]];
    }
    if (turn === 4) {
      assert.deepEqual(latest.rows, [['INPUT_0', 0], ['INPUT_1', null]]);
      return [['open_result', { name: 'readings', rows: 1, offset: 599, columns: ['gene', 'signal'] }]];
    }
    if (turn === 5) {
      assert.deepEqual(latest.rows, [['INPUT_599', '00599']]);
      assert.deepEqual(JSON.parse(request.messages.find(m => m.tool_call_id === 'c3_0').content), { archived_call: 'c3_0', name: 'readings' });
      return [['open_result', { call: 'c1_0' }]];
    }
    if (turn === 6) {
      assert.deepEqual(latest, schema);
      assert.equal(reads.single, 1); assert.equal(reads.bulk, 1);
      assert.doesNotMatch(JSON.stringify(request), /INPUT_599/);
      return [['open_result', { call: 'c3_0' }]];
    }
    assert.equal(turn, 7);
    assert.deepEqual(latest.rows, [['INPUT_0', 0], ['INPUT_1', null]]);
    const wire = buildRequest(request, { modelId: 'gemini-3.8-flash', reasoningEffort: 'low' });
    const parts = wire.contents.flatMap(content => content.parts);
    assert.equal(parts.filter(part => part.functionCall).length, parts.filter(part => part.functionResponse).length);
    assert.ok(parts.filter(part => part.functionCall).every(part => part.thoughtSignature === 'native-signature'));
    return [['finish', { results: ['readings'] }]];
  }, { size: 600 });
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.tables[0].rows.length, 600);
  assert.deepEqual(result.tables[0].rows.slice(0, 2).map(row => row.signal), [0, null]);
  assert.equal(result.tables[0].rows[599].signal, '00599');
  assert.equal(result.raw_sources[0].rows.length, 1800);
  assert.deepEqual(reads, { single: 1, bulk: 1 });
  assert.equal(requests.length, 7);
});

for (const tool of ['run', 'reduce_result', 'load_tools', 'join', 'correlate', 'aso_hpa', 'deep_research_hpa', 'investigator_hpa']) {
  test(`Investigator cannot invoke ${tool} and returns its source evidence for ASO to finish the assigned analysis`, async () => {
    const missing = { requirement: 'Analyze the returned measurements', why: 'This requires the coordinator data tools.' };
    const { result, reads } = await run(({ request, turn }) => {
      if (turn === 1) return [lookup];
      if (turn === 2) return [[tool, {}]];
      assert.equal(turn, 3);
      assert.match(JSON.parse(request.messages.at(-1).content).error, new RegExp(`Investigator has no ${tool} tool`));
      return [['finish', { results: ['readings'], unfinished_requirements: [missing] }]];
    });
    assert.equal(result.status, 'partial', result.error);
    assert.deepEqual(result.remaining_for_aso, [missing]);
    assert.equal(result.tables[0].rows.length, 3);
    assert.equal(reads.bulk, 1);
  });
}
