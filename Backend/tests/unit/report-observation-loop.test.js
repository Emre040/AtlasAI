'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const BACKEND = process.env.ATLASAI_BACKEND_ROOT || path.resolve(__dirname, '../..');
const { CapabilityCatalog } = require(path.join(BACKEND, 'src/system/aso/capabilityCatalog'));

let callId = 0;
const call = (name, args) => {
  return { id: `test_${++callId}`, type: 'function', thought_signature: 'opaque-signature', function: { name, arguments: JSON.stringify(args) } };
};
const transcript = request => request.messages.map(m => {
  if (m.role === 'tool') {
    const result = JSON.parse(m.content);
    return [result.plan, result.observations, result.error].filter(Boolean).join('\n');
  }
  return m.content || '';
}).join('\n');
const response = (...tool_calls) => ({ choices: [{ message: { tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t, decide, execute, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aso-loop-test-'));
  await fs.mkdir(path.join(directory, 'artifacts'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const events = [], updates = [], requests = [];
  const agentDone = deferred();
  const entry = options.entry || { file: 'mapping.tsv', key: 'lookup', title: 'Mapping', columns: ['name', 'value'] };
  let artifact = 0;
  const stubs = {
    // Most tests isolate execution with tools already loaded. Cold-discovery tests
    // below use the real initial catalog and actual load_tools exchanges.
    '../aso/capabilityCatalog': { CapabilityCatalog: options.nativeDiscovery ? CapabilityCatalog : class extends CapabilityCatalog {
      constructor(args) { super({ ...args, coreNames: args.tools.map(tool => tool.function.name) }); }
    } },
    '../../inference/gateway': { getActiveModel: () => ({ id: 1, configKey: 'test-model' }), inference: {
      assignContext() {},
      chat: { completions: { async create(request) { requests.push(request); return decide({ request, turn: requests.length, agentDone }); } } }
    } },
    '../../policy/config': { platformConfig: () => ({ asoMaxSteps: 40, asoParallelLimit: 3, asoContextBytes: 8192 }) },
    '../../hpa/geneDataAdapter': { async catalog() { return [entry]; }, async entry(name) { return name === entry.file ? entry : null; }, definition: () => null },
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../hpa/localData': { FILES: { master: 'mapping.tsv' }, localData: { async master() { return { rows: options.rows }; }, async table() { if (options.onRead) await options.onRead(); return { columns: entry.columns, rows: options.rows || [] }; }, async *rows(name) {
      if (options.onRead) await options.onRead();
      if (options.rawFile) {
        const [header, ...lines] = (await fs.readFile(path.join(directory, name), 'utf8')).trimEnd().split('\n');
        const columns = header.split('\t');
        for (const line of lines) { const cells = line.split('\t'); yield Object.fromEntries(columns.map((column, i) => [column, cells[i]])); }
        return;
      }
      if (options.rows) { yield* options.rows; return; }
      for (let i = 0; i < 17; i++) yield { name: `label ${i}`, value: i };
    } } },
    '../aso/workspaceStore': { async createWorkspace() { return { id: 1, uuid: 'test-study', workspaceDir: directory, artifactsDir: path.join(directory, 'artifacts'), logPath: path.join(directory, 'events.ndjson') }; }, async updateWorkspace(db, id, update) { updates.push(update); } },
    '../aso/artifactStore': { async registerArtifact(db, args) { const id = ++artifact; const storageUri = args.storageUriOverride || path.join(directory, 'artifacts', `${id}.json`); if (!args.skipWrite) await fs.writeFile(storageUri, JSON.stringify(args.payload)); return { artifactUuid: `artifact-${id}`, storageUri }; } },
    '../aso/pipelines/renderCharts': { renderCharts: options.renderCharts || (async (spec, renderDir) => { const image = path.join(renderDir, 'plot.png'); await fs.writeFile(image, 'rendered test image'); return { images: [image] }; }) },
    '../orchestrator': { getToolSpecs: () => [
      { type: 'function', function: { name: 'deep_research_hpa', parameters: { type: 'object', properties: { goal: { type: 'string' }, mode: { type: 'string' } }, required: ['goal'] } } },
      { type: 'function', function: { name: 'investigator_hpa', parameters: { type: 'object', properties: { gene: { type: 'string' }, question: { type: 'string' }, mode: { type: 'string' } }, required: ['gene'] } } },
      ...(options.extraAgentSpecs || [])
    ], execute: execute || (() => { throw new Error('Unexpected agent call'); }) }
  };
  const filename = require.resolve(path.join(BACKEND, 'src/system/agents/asoStudy'));
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const run = args => loaded.exports({ goal: 'Inspect the available evidence', ...args }, { db: {}, visitorId: 1, async onStep(event) { events.push(event); if (event.stage === 'tool.failed') t.diagnostic(event.message); if (['tool.done', 'tool.failed'].includes(event.stage)) agentDone.resolve(event); } });
  return { run, events, requests, updates, directory };
}

const records = Array.from({ length: 1003 }, () => ({ gene: 'EXAMPLE', value: '17.25', category: 'recorded' }));
const evidence = async () => ({ result: { status: 'ok', result: { rows: records, mode: 'offline' } } });

for (const index of [42, 1001]) test(`exact observation of saved artifact row ${index} finishes without narrative transcription`, async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Return a selected recorded observation', kind: 'table' }] }), call('deep_research_hpa', { goal: 'Load supplied observations', node: 1 }));
    assert.ok(request.tools.find(tool => tool.function.name === 'finish').function.parameters.properties.observations);
    if (turn > 2) t.diagnostic(transcript(request).split('finish refused.').at(-1).slice(0, 1600));
    return response(call('finish', { observations: [{ artifact: 'a1', row_indices: [index], columns: ['gene', 'value', 'category'] }] }));
  }, evidence, { nativeDiscovery: true });
  const result = await f.run({ goal: 'Return an exact source observation', max_turns: 3 });
  assert.equal(result.outcome, 'completed', result.incomplete_reason);
  assert.match(result.summary, /EXAMPLE.*17\.25.*recorded/);
  assert.equal(f.requests.length, 2);
});

test('qualified discussion alone remains an additive finish path with exact evidence references', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Collect supplied observations', kind: 'table' }, { step: 'Discuss evidence limits', kind: 'summary' }] }), call('deep_research_hpa', { goal: 'Load supplied observations', node: 1 }));
    assert.equal(turn, 2);
    return response(call('finish', { interpretations: [
      { kind: 'inference', text: 'The saved rows provide source observations.', artifacts: ['a1'] },
      { kind: 'hypothesis', text: 'An untested sampling effect could contribute.\n\nAn untested handling effect could also contribute.', artifacts: ['a1'] },
      { kind: 'limitation', text: 'The source observations do not establish a cause.', artifacts: ['a1'] }
    ] }));
  }, evidence, { nativeDiscovery: true });
  const result = await f.run({ goal: 'Discuss the evidence boundaries' });
  assert.equal(result.outcome, 'completed');
  assert.match(result.summary, /Interpretation/); assert.match(result.summary, /Evidence limitation/);
  const hypothesisParagraphs = result.summary.split(/\n\s*\n/).filter(paragraph => /effect could/.test(paragraph));
  assert.equal(hypothesisParagraphs.length, 2);
  for (const paragraph of hypothesisParagraphs) assert.match(paragraph, /Untested hypothesis/, 'each standalone paragraph must retain the generated qualification');
});

test('invalid observation references reject before finish.completed changes a plan item', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Collect supplied observations', kind: 'table' }, { step: 'Discuss evidence limits', kind: 'summary' }] }), call('deep_research_hpa', { goal: 'Load supplied observations', node: 1 }));
    if (turn === 2) return response(call('finish', { completed: [{ item: 2, artifacts: ['a1'] }], observations: [{ artifact: 'a1', row_indices: [1003], columns: ['value'] }] }));
    assert.equal(turn, 3); assert.match(transcript(request), /row_indices must select existing/);
    const turnFrame = request.messages.filter(message => message.role === 'user').at(-1).content;
    assert.match(turnFrame, /2\. \[todo\]/);
    return response(call('finish', { summary: 'Saved observations provide the requested source evidence (a1).' }));
  }, evidence, { nativeDiscovery: true });
  const result = await f.run({ goal: 'Return and discuss source observations' });
  assert.equal(result.outcome, 'completed');
});

test('legacy summary plus table finish stays valid with additional report fields omitted', async t => {
  const f = await fixture(t, ({ turn }) => turn === 1
    ? response(call('set_plan', { items: [{ step: 'Collect supplied observations', kind: 'table' }] }), call('deep_research_hpa', { goal: 'Load supplied observations', node: 1 }))
    : response(call('finish', { summary: 'The recorded measurement is 17.25 (a1).', tables: [{ artifact: 'a1', columns: ['gene', 'value'], rows: 1 }] })), evidence, { nativeDiscovery: true });
  const result = await f.run({ goal: 'Return source observations' });
  assert.equal(result.outcome, 'completed'); assert.match(result.summary, /recorded measurement is 17\.25/);
});

test('hypothesis qualification does not bypass the existing numerical evidence guard', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Collect supplied observations', kind: 'table' }, { step: 'Interpret the observations', kind: 'summary' }] }), call('deep_research_hpa', { goal: 'Load supplied observations', node: 1 }));
    if (turn === 2) return response(call('finish', { interpretations: [{ kind: 'hypothesis', text: 'The measurement may have been 1234.56.', artifacts: ['a1'] }] }));
    assert.equal(turn, 3); assert.match(transcript(request), /number_not_in_cited_artifacts/); assert.match(transcript(request), /Unmatched numbers: 1234.56/);
    return response(call('finish', { observations: [{ artifact: 'a1', row_indices: [1001], columns: ['gene', 'value'] }], interpretations: [{ kind: 'limitation', text: 'The source records do not establish a cause.', artifacts: ['a1'] }] }));
  }, evidence, { nativeDiscovery: true });
  const result = await f.run({ goal: 'Report and interpret observed evidence' });
  assert.equal(result.outcome, 'completed'); assert.doesNotMatch(result.summary, /1234\.56/); assert.match(result.summary, /17\.25/);
  assert.equal(f.requests.length, 3);
});

test('exact observation can preserve a saved structured source cell without a false numerical rejection', async t => {
  const rows = [{ gene: 'EXAMPLE', metadata: { threshold: 97.125, labels: ['source category'], missing: null } }];
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Collect supplied source metadata', kind: 'table' }] }), call('deep_research_hpa', { goal: 'Load supplied source metadata', node: 1 }));
    if (turn > 2) t.diagnostic(transcript(request).split('finish refused.').at(-1).slice(0, 1200));
    return response(call('finish', { observations: [{ artifact: 'a1', row_indices: [0], columns: ['gene', 'metadata'] }] }));
  }, async () => ({ result: { status: 'ok', result: { rows } } }), { nativeDiscovery: true });
  const result = await f.run({ goal: 'Return exact source metadata', max_turns: 3 });
  assert.equal(result.outcome, 'completed', result.incomplete_reason); assert.match(result.summary, /97\.125/);
});
