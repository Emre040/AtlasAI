'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const BACKEND = process.env.ATLASAI_BACKEND_ROOT || path.resolve(__dirname, '../..');
const sourcePath = filename => filename;
const entry = { file: 'observations.tsv', title: 'Source observations', key: 'ensembl', columns: ['Gene', 'Sample', 'Value'] };
const lookup = { table: entry.file, match_column: 'Gene', mode: 'rows', columns: ['Sample', 'Value'] };
const apply = name => ['apply_bulk', { name, lookups: [lookup] }];
const finish = ['finish', { results: ['observed'], answer: 'Source observations returned.', not_in_release: [] }];

async function study({ decide, ctx = {}, onRead }) {
  const filename = require.resolve(path.join(BACKEND, 'src/system/agents/investigatorBulk'));
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireOriginal = loaded.require.bind(loaded), requests = [];
  let sourceReads = 0;
  const stubs = {
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test-release' }; } },
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      const action = await decide({ request, turn: requests.length });
      const message = action ? { role: 'assistant', tool_calls: [{ type: 'function', id: `c${requests.length}`, thought_signature: 'native-signature', function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } : { role: 'assistant', content: 'Unfinished reasoning' };
      return { choices: [{ message }], usage: { prompt_tokens: 4, completion_tokens: 1 } };
    } } } } }
  };
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : requireOriginal(name);
  loaded._compile(await fs.readFile(sourcePath(filename), 'utf8'), filename);
  const gene = { gene: 'ONE', ensembl: 'ID1' };
  const rows = Array.from({ length: 12 }, (_, i) => ({ Gene: gene.ensembl, Sample: `sample-${i}`, Value: String(i) }));
  const adapter = {
    async catalog() { return [entry]; }, async entry(file) { return file === entry.file ? entry : null; },
    async resolveGenes() { return [gene]; }, async read() { return { entry, rows }; },
    async readMany() { sourceReads++; onRead?.(); return { entry, byGene: new Map([[gene.ensembl, rows]]) }; },
    definition() { return ''; }
  };
  const result = await loaded.exports({ genes: ['ONE'], question: 'Retrieve all source observations and assess the requested views.' }, ctx, adapter);
  return { result, requests, sourceReads };
}

for (const [label, ctx] of [
  ['supplied names', {}],
  ['an identifier-only artifact', { inputRows: [{ gene: 'ONE', ensembl: 'ID1' }] }]
]) test(`bulk initial context states the complete identifier-only shape for ${label}`, async () => {
  const { result, requests } = await study({ ctx, decide: ({ request, turn }) => {
    const initial = request.messages.find(message => message.role === 'user').content;
    assert.match(initial, /Input schema: gene and ensembl identifiers only\. There are no inherited measurements or other input columns\./);
    assert.ok(request.tools.some(tool => tool.function.name === 'inspect_input'), 'optional existing-value inspection remains available');
    if (turn === 1) return apply('observed');
    assert.equal(turn, 2); return ['finish', { results: ['observed'], not_in_release: [] }];
  } });
  assert.equal(result.status, 'ok'); assert.equal(result.tables[0].rows.length, 12); assert.equal(requests.length, 2);
});

test('bulk initial context reports inherited column count while preserving exact prior values in tools', async () => {
  const inputRows = [{ gene: 'ONE', ensembl: 'ID1', prior_measurement: 0, prior_label: 'exact retained label' }];
  const { result, requests } = await study({ ctx: { inputRows }, decide: ({ request, turn }) => {
    const initial = request.messages.find(message => message.role === 'user').content;
    assert.match(initial, /gene and ensembl identifiers plus 2 inherited columns retained by apply_bulk/);
    assert.doesNotMatch(initial, /There are no inherited|prior_measurement|exact retained label/);
    if (turn === 1) return ['inspect_input', { columns: ['prior_measurement', 'prior_label'] }];
    if (turn === 2) {
      const inspected = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content);
      assert.ok(JSON.stringify(inspected).includes('exact retained label')); assert.ok(JSON.stringify(inspected).includes('0'));
      return apply('observed');
    }
    assert.equal(turn, 3); return ['finish', { results: ['observed'], not_in_release: [] }];
  } });
  assert.equal(result.status, 'ok'); assert.equal(requests.length, 3);
  for (const row of result.tables[0].rows) { assert.equal(row.prior_measurement, 0); assert.equal(row.prior_label, 'exact retained label'); }
});

test('metadata-only inherited schema columns are counted without dumping the wide schema', async () => {
  const rows = [{ gene: 'ONE', ensembl: 'ID1' }];
  Object.defineProperty(rows, 'columns', { value: ['gene', 'ensembl', 'recorded_but_empty'] });
  const { result } = await study({ ctx: { inputRows: rows }, decide: ({ request, turn }) => {
    const initial = request.messages.find(message => message.role === 'user').content;
    assert.match(initial, /plus 1 inherited columns/); assert.doesNotMatch(initial, /recorded_but_empty|There are no inherited/);
    return turn === 1 ? apply('observed') : ['finish', { results: ['observed'], not_in_release: [] }];
  } });
  assert.equal(result.status, 'ok');
});

test('bulk preserves original source exclusions even when the delegated question omits them', async () => {
  const original = 'Compare region measurements only. Exclude subregions; retain zero and missing values.\nReturn all requested evidence exactly.';
  const { result, requests } = await study({ ctx: { studyGoal: original, studyTask: 'Retrieve the region measurements' }, decide: ({ request, turn }) => {
    const user = request.messages.find(message => message.role === 'user').content;
    assert.ok(user.includes(`Original study request (context and constraints for the assigned work):\n${original}\n\nComplete source directory`));
    assert.match(user, /Question: Retrieve all source observations and assess the requested views\./);
    assert.match(user, /Assigned plan result: Retrieve the region measurements/);
    assert.match(request.messages[0].content, /original study request's constraints/);
    return turn === 1 ? apply('observed') : ['finish', { results: ['observed'], not_in_release: [] }];
  } });
  assert.equal(result.status, 'ok'); assert.equal(requests.length, 2);
});

test('bulk preserves the full exact original request including literal lists, whitespace and unicode', async () => {
  const original = 'Exact request:\r\n' + Array.from({ length: 600 }, (_, i) => `literal_name_${i}`).join(', ') + '\nKeep all categories α/β; source limits apply.  ';
  const { result } = await study({ ctx: { studyGoal: original }, decide: ({ request, turn }) => {
    const user = request.messages.find(message => message.role === 'user').content;
    assert.ok(user.includes(`Original study request (context and constraints for the assigned work):\n${original}\n\nComplete source directory`));
    assert.ok(user.includes('literal_name_599')); assert.ok(user.includes('α/β'));
    return turn === 1 ? apply('observed') : ['finish', { results: ['observed'], not_in_release: [] }];
  } });
  assert.equal(result.status, 'ok');
});

test('bulk omits only an exactly duplicate original request', async () => {
  const question = 'Retrieve all source observations and assess the requested views.';
  for (const original of [question, question + ' ']) {
    const { result } = await study({ ctx: { studyGoal: original }, decide: ({ request, turn }) => {
      const user = request.messages.find(message => message.role === 'user').content;
      assert.equal(user.includes('Original study request ('), original !== question);
      if (original === question) assert.equal(user.split(question).length - 1, 1);
      return turn === 1 ? apply('observed') : ['finish', { results: ['observed'], not_in_release: [] }];
    } });
    assert.equal(result.status, 'ok');
  }
});
