'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const BACKEND = process.env.ATLASAI_BACKEND_ROOT || path.resolve(__dirname, '../..');
const { CapabilityCatalog } = require(path.join(BACKEND, 'src/system/aso/capabilityCatalog'));
const { buildRequest } = require(path.join(BACKEND, 'src/inference/adapters/geminiGenerateContent'));
const { executeBatch, validate } = require(path.join(BACKEND, 'src/system/aso/batchOperations'));
const { decodeArguments } = require(path.join(process.env.ATLASAI_SELECT_PROPOSAL_ROOT || BACKEND, 'src/system/aso/toolArguments'));
const { classify, columnsOf, withColumns, CLASSIFY_SCHEMA } = require(path.join(BACKEND, 'src/system/aso/studyTools'));
const { createBulkTools, APPLY_BULK } = require(path.join(BACKEND, 'src/system/agents/investigatorBulkTools'));

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


module.exports = { fixture, call, response, transcript };
