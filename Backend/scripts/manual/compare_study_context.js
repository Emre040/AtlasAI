'use strict';

// Real inference + raw HPA reads, with all study/artifact/accounting writes isolated in memory
// and an explicitly chosen local output directory. The database connection is READ ONLY.
// node scripts/manual/compare_study_context.js --case kinase --out /tmp/aso-check
// Add --baseline <git-ref> to run that ASO implementation through the same orchestrator.
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const mysql = require('mysql2/promise');
const backend = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(backend, '.env'), quiet: true });
const { INFERENCE_CALL_COLUMNS } = require('../../src/database/repositories/inferenceCalls');

const GOALS = {
  kinase: "Which kinases are elevated in the pancreas? Measure each one's nTPM in the pancreas and in the liver, compute the pancreas-to-liver ratio, rank them, and draw a bar chart of the ratio. Also list the genes whose liver value is zero.",
  tissue: 'Compare ALB and INS across all tissues in the normal-tissue RNA consensus dataset. For each gene report the number of tissue rows, minimum, maximum and mean nTPM. List its top three tissues, draw a grouped bar chart of those values, and state any missing or zero values. Use the raw dataset and cite the results.'
};

class IsolatedStudyDb {
  constructor(connection) { this.connection = connection; this.ids = 0; this.artifacts = new Map(); this.calls = []; this.writes = 0; }
  async execute(sql, args = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT id FROM `atlasai`\.`aso_artifacts`/.test(normalized)) {
      const row = this.artifacts.get(args[0].toString('hex'));
      return [[row && row.workspaceId === args[1] ? { id: row.id } : null].filter(Boolean)];
    }
    if (/^SELECT\b/i.test(normalized)) return this.connection.execute(sql, args);
    if (/^INSERT INTO `atlasai`\.`inference_calls`/.test(normalized)) {
      this.calls.push(Object.fromEntries(INFERENCE_CALL_COLUMNS.map((key, i) => [key, args[i + 1]])));
    } else if (/^INSERT INTO `atlasai`\.`aso_artifacts`/.test(normalized)) {
      this.artifacts.set(args[0].toString('hex'), { id: this.ids + 1, workspaceId: args[1] });
    } else if (!/^(INSERT INTO|UPDATE) `atlasai`\.`(aso_workspaces|aso_artifact_links)`/.test(normalized)) {
      throw new Error(`Unexpected evaluation database write: ${normalized.split(' ').slice(0, 3).join(' ')}`);
    }
    this.writes++;
    return [{ insertId: ++this.ids, affectedRows: 1 }];
  }
  async transaction(work) { return work(this); }
}

async function main() {
  const { values } = parseArgs({ options: { case: { type: 'string' }, out: { type: 'string' }, baseline: { type: 'string' }, turns: { type: 'string', default: '40' }, 'goal-file': { type: 'string' }, 'context-bytes': { type: 'string' }, effort: { type: 'string' }, 'genes-file': { type: 'string' } } });
  if (!values.out || !path.isAbsolute(values.out)) throw new Error('--out must be an absolute, new local directory');
  const bulkGenes = values['genes-file'] ? JSON.parse(await fs.readFile(values['genes-file'], 'utf8')) : null;
  const maxTurns = Number(values.turns);
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('--turns must be a positive integer');
  const goal = values['goal-file'] ? (await fs.readFile(values['goal-file'], 'utf8')).trim() : GOALS[values.case];
  if (!goal) throw new Error('Choose --case kinase|tissue or --goal-file');
  if (process.env.HPA_DB_NAME !== 'atlasai' || !['127.0.0.1', 'localhost'].includes(process.env.HPA_DB_HOST)) throw new Error('Evaluation requires the local atlasai read-only connection');
  await fs.mkdir(values.out, { mode: 0o700 });
  const sourceHashes = {};
  await fs.mkdir(path.join(values.out, 'code'), { mode: 0o700 });
  async function runtimeFiles(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await runtimeFiles(filename));
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.relative(path.join(backend, 'src'), filename));
    }
    return files;
  }
  const names = [...await runtimeFiles(path.join(backend, 'src')), 'system/aso/pipelines/render_charts.py', '../package.json', '../package-lock.json', '../scripts/manual/compare_study_context.js'].sort();
  for (const name of names) {
    const source = values.baseline && name === 'system/agents/asoStudy.js'
      ? execFileSync('git', ['show', `${values.baseline}:Backend/src/${name}`], { cwd: backend })
      : await fs.readFile(path.join(backend, 'src', name));
    sourceHashes[name] = crypto.createHash('sha256').update(source).digest('hex');
    const snapshotPath = path.join(values.out, 'code', path.relative(backend, path.resolve(backend, 'src', name)));
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(snapshotPath, source, { mode: 0o600 });
  }
  if (values.baseline) {
    const filename = require.resolve('../../src/system/agents/asoStudy');
    const source = execFileSync('git', ['show', `${values.baseline}:Backend/src/system/agents/asoStudy.js`], { cwd: backend, encoding: 'utf8' });
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(source, filename);
    require.cache[filename] = loaded;
  }
  const connection = await mysql.createConnection({ host: process.env.HPA_DB_HOST, user: process.env.HPA_DB_USER, password: process.env.HPA_DB_PASS, database: process.env.HPA_DB_NAME });
  let config;
  try {
    await connection.query('START TRANSACTION READ ONLY');
    const db = new IsolatedStudyDb(connection);
    const { initializeInferenceGateway, inference } = require('../../src/inference/gateway');
    const gateway = await initializeInferenceGateway(db);
    config = await require('../../src/policy/config').initializePlatformConfig(db);
    const runtime = require('../../src/config/runtime').loadRuntimeConfig(backend);
    require('../../src/system/aso/workspaceStore').configureWorkspaceRoot(values.out);
    require('../../src/hpa/localData').localData.configure({ root: runtime.dataLocalRoot, db });
    const orchestrator = require('../../src/system/orchestrator');
    const { model } = await gateway.resolveActiveModel();
    if (model.configKey !== 'gemini-3.8-flash' || (values.effort || model.reasoningEffort) !== 'low') throw new Error('This evaluation protocol requires gemini-3.8-flash with low reasoning effort');
    const events = [];
    const requests = [];
    const original = gateway.createChatCompletion.bind(gateway);
    gateway.createChatCompletion = async request => {
      const requestIndex = requests.length;
      const item = { request, started_at: Date.now() };
      requests.push(item);
      const response = await original(request);
      Object.assign(item, { finished_at: Date.now(), response });
      await fs.writeFile(path.join(values.out, `inference-${String(requestIndex + 1).padStart(3, '0')}.json`), JSON.stringify(item), { mode: 0o600 });
      return response;
    };
    console.log(JSON.stringify({ model: model.configKey, reasoning_effort: values.effort || model.reasoningEffort, release: config.current().activeHpaVersion, baseline: values.baseline || null, max_turns: maxTurns, goal }));
    const { result } = await gateway.runWithActiveModel(model, () => inference.withContext({ purpose: 'manual' }, () => orchestrator.execute(bulkGenes ? 'investigator_hpa' : 'aso_hpa', { ...(bulkGenes ? { genes: bulkGenes, question: goal } : { goal }), mode: 'offline', max_turns: maxTurns, ...(values.effort ? { reasoning_effort: values.effort } : {}), ...(values['context-bytes'] ? { context_budget_bytes: Number(values['context-bytes']) } : {}) }, {
      db, visitorId: 1, rawQuery: '', reasoningEffort: values.effort,
      onStep: async event => {
        events.push(event);
        if (['tool.start', 'tool.done'].includes(event.stage) && JSON.parse(event.message).kind === 'agent') console.log(`${event.stage} ${event.message.slice(0, 300)}`);
        if (['turn', 'tool.failed', 'finish', 'error'].includes(event.stage)) console.log(`${event.stage} ${event.message.slice(0, 300)}`);
      }
    })));
    const total = key => db.calls.reduce((sum, call) => sum + (Number(call[key]) || 0), 0);
    const turns = events.filter(e => e.stage === 'turn').map(e => JSON.parse(e.message));
    const allCalls = turns.flatMap(t => t.calls);
    const inspections = allCalls.filter(c => ['open', 'describe', 'datasets'].includes(c.tool));
    const uniqueInspections = new Set(inspections.map(c => JSON.stringify(c)));
    const summary = { variant: values.baseline || 'candidate', case: values.case || values['goal-file'], model: model.configKey, hpa_version: config.current().activeHpaVersion, max_turns: maxTurns, result, accounting: { calls: db.calls.length, input_tokens: total('input_tokens'), cached_input_tokens: total('cached_input_tokens'), output_tokens: total('output_tokens'), total_tokens: total('total_tokens'), cost_usd: total('cost_microusd') / 1e6 }, context: { inspections: inspections.length, repeated_inspections: inspections.length - uniqueInspections.size }, isolated_writes: db.writes };
    const agentStarts = events.filter(e => e.stage === 'tool.start').map(e => JSON.parse(e.message)).filter(e => e.kind === 'agent');
    summary.agent_invocations = Object.fromEntries([...new Set(agentStarts.map(e => e.tool))].map(name => [name, agentStarts.filter(e => e.tool === name).length]));
    summary.main_model_calls = turns.length;
    summary.specialist_model_calls = db.calls.length - turns.length;
    summary.source_sha256 = sourceHashes;
    summary.reasoning_effort = values.effort || model.reasoningEffort;
    await fs.writeFile(path.join(values.out, 'result.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(values.out, 'events.json'), JSON.stringify(events), { mode: 0o600 });
    await fs.writeFile(path.join(values.out, 'calls.json'), JSON.stringify(db.calls), { mode: 0o600 });
    console.log(JSON.stringify({ status: result.status, outcome: result.outcome, turns: result.turns, agents: summary.agent_invocations, tokens: summary.accounting, context: summary.context, out: values.out }));
  } finally {
    config?.stopRefreshing();
    await connection.rollback();
    await connection.end();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { IsolatedStudyDb };
