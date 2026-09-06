'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');

async function investigator(decide) {
  const filename = require.resolve('../../src/system/agents/investigatorBulk');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireOriginal = loaded.require.bind(loaded);
  const stubs = {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../inference/gateway': { inference: { chat: { completions: { create: decide } } } }
  };
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : requireOriginal(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  return loaded.exports;
}

function response(name, args, id) {
  return { choices: [{ message: { role: 'assistant', tool_calls: [{ id, type: 'function', thought_signature: 'original-signature', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 7, completion_tokens: 2 } };
}

test('bulk context discovers arbitrary sources and inherited data without repeating the complete schema or list', async () => {
  const supplied = Array.from({ length: 600 }, (_, i) => `INPUT_${i}`);
  const resolved = supplied.map((gene, i) => ({ gene, ensembl: `ID_${i}` }));
  const extras = Object.fromEntries(Array.from({ length: 104 }, (_, i) => [`inherited_field_${i}`, `retained_value_${i}`]));
  const inputRows = resolved.map(gene => ({ ...gene, ...extras }));
  const entry = { file: 'newly_imported_values.tsv', title: 'New release measurements', key: 'name', description: 'Readings per source specimen with experimental evidence.', columns: ['Target', 'Specimen', 'Value units', 'Quality'] };
  const stream = { file: 'other_stream_source.tsv', title: 'Other raw source', key: 'stream', columns: ['many raw fields'], why: 'stream with table tools' };
  const byGene = new Map(resolved.map((gene, i) => [gene.ensembl, [{ Target: gene.gene, Specimen: 'sample A', 'Value units': String(i), Quality: 'Supported' }]]));
  let sourceReads = 0, calls = 0;
  const adapter = {
    async catalog() { return [entry, stream]; },
    async overview() { throw new Error('The complete verbose catalog must not be injected'); },
    async resolveGenes() { return resolved; },
    async entry(file) { return [entry, stream].find(source => source.file === file); },
    async read(gene) { return { entry, rows: byGene.get(gene.ensembl) }; },
    async readMany() { sourceReads++; return { entry, byGene }; },
    definition(term) { return term === 'Supported' ? 'Supported source evidence, not certainty of biological absence.' : ''; }
  };
  const run = await investigator(async request => {
    calls++;
    const initial = request.messages[1].content;
    assert.match(initial, /600 genes/);
    assert.match(initial, /gene and ensembl identifiers plus 104 inherited columns retained/);
    assert.match(initial, /newly_imported_values.tsv/);
    assert.match(initial, /other_stream_source.tsv/);
    assert.doesNotMatch(initial, /inherited_field_|retained_value_|Value units/);
    assert.doesNotMatch(JSON.stringify(request), /INPUT_599/);
    if (calls === 1) return response('inspect_table', { table: entry.file }, 'schema');
    if (calls === 2) {
      const schema = JSON.parse(request.messages.at(-1).content);
      assert.deepEqual(schema.columns, entry.columns);
      assert.deepEqual(schema.definitions, {});
      assert.equal(schema.unavailable_definitions.sample_term_pairs, 1); // A generic Quality field has no documented antibody-assay scope.
      return response('apply_bulk', { name: 'measurements', lookups: [{ table: entry.file, match_column: 'Target', value_column: 'Value units', as: 'observed_units' }] }, 'measure');
    }
    if (calls === 3) {
      const receipt = JSON.parse(request.messages.at(-1).content);
      assert.equal(receipt.rows, 600);
      assert.ok(receipt.columns.includes('observed_units'));
      assert.equal(receipt.inherited_columns.count, 104);
      assert.doesNotMatch(JSON.stringify(receipt), /inherited_field_|retained_value_/);
      assert.deepEqual(receipt.sources, [entry.file]);
      assert.equal(request.messages[2].tool_calls[0].thought_signature, 'original-signature');
      return response('inspect_input', {}, 'input-schema');
    }
    if (calls === 4) {
      const schema = JSON.parse(request.messages.at(-1).content);
      assert.equal(schema.column_count, 106);
      assert.ok(schema.columns.includes('inherited_field_103'));
      assert.equal(schema.sample, undefined);
      return response('open_result', { name: 'measurements', columns: ['gene', 'inherited_field_103'], rows: 1 }, 'inherited-result');
    }
    const page = JSON.parse(request.messages.at(-1).content);
    assert.deepEqual(page.rows, [['INPUT_0', 'retained_value_103']]);
    return response('finish', { results: ['measurements'], answer: 'Exact source measurements returned with source coverage.', not_in_release: [] }, 'finish');
  });
  const result = await run({ genes: supplied, question: 'Retrieve the source readings.' }, { inputRows, reasoningEffort: 'low' }, adapter);
  assert.equal(result.status, 'ok');
  assert.equal(calls, 5); assert.equal(sourceReads, 1);
  assert.equal(result.tables[0].rows[599].observed_units, 599);
  assert.equal(result.tables[0].rows[599].inherited_field_103, 'retained_value_103');
});

test('an unavailable source remains discoverable and its exact schema can be inspected without a false source read', async () => {
  const entry = { file: 'unavailable_raw.tsv', title: 'Unavailable raw table', key: 'stream', columns: ['Exact raw field'], why: 'Requires streaming access' };
  let calls = 0;
  const run = await investigator(async request => {
    calls++;
    if (calls === 1) return response('inspect_table', { table: entry.file }, 'schema');
    const schema = JSON.parse(request.messages.at(-1).content);
    assert.deepEqual(schema.columns, entry.columns);
    assert.equal(schema.key, 'stream');
    assert.match(schema.access_note, /streaming/);
    return response('finish', { results: [], answer: 'Per-input lookup unavailable for this source.', not_in_release: [], remaining_for_aso: [{ requirement: 'Read this source', why: schema.access_note }] }, 'finish');
  });
  const result = await run({ genes: ['ONE'], question: 'Read this source.' }, {}, {
    async catalog() { return [entry]; }, async entry() { return entry; }, async resolveGenes() { return [{ gene: 'ONE', ensembl: 'ID1' }]; },
    async read() { throw new Error('This source cannot be read per gene'); }, definition() { return ''; }
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.remaining_for_aso[0].requirement, 'Read this source');
});
