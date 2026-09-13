'use strict';

// Puts one question about the atlas to the reader (dictionary_expert_hpa in about mode) under one
// catalog model, with the database read only and every model call recorded in --out.
// node scripts/manual/reader_question.js --question-file <text file> --model <config key> [--effort low] --out <new absolute directory>
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const mysql = require('mysql2/promise');
const backend = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(backend, '.env'), quiet: true });
const { IsolatedStudyDb } = require('./compare_study_context');

async function main() {
  const { values } = parseArgs({ options: { 'question-file': { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, out: { type: 'string' } } });
  if (!values.out || !path.isAbsolute(values.out)) throw new Error('--out must be an absolute, new local directory');
  if (!values['question-file'] || !values.model) throw new Error('--question-file and --model are required');
  const question = (await fs.readFile(values['question-file'], 'utf8')).trim();
  if (process.env.HPA_DB_NAME !== 'atlasai' || !['127.0.0.1', 'localhost'].includes(process.env.HPA_DB_HOST)) throw new Error('Evaluation requires the local atlasai read-only connection');
  await fs.mkdir(values.out, { mode: 0o700 });
  const connection = await mysql.createConnection({ host: process.env.HPA_DB_HOST, user: process.env.HPA_DB_USER, password: process.env.HPA_DB_PASS, database: process.env.HPA_DB_NAME });
  let config;
  const started = Date.now();
  try {
    await connection.query('START TRANSACTION READ ONLY');
    const db = new IsolatedStudyDb(connection);
    const { initializeInferenceGateway, inference } = require('../../src/inference/gateway');
    const gateway = await initializeInferenceGateway(db);
    config = await require('../../src/policy/config').initializePlatformConfig(db);
    const runtime = require('../../src/config/runtime').loadRuntimeConfig(backend);
    require('../../src/hpa/localData').localData.configure({ root: runtime.dataLocalRoot, db });
    const orchestrator = require('../../src/system/orchestrator');
    const model = await gateway.loadModel(values.model);
    if (!model) throw new Error(`No catalog model with config_key ${JSON.stringify(values.model)}`);
    const requests = [];
    const original = gateway.createChatCompletion.bind(gateway);
    gateway.createChatCompletion = async request => {
      const selected = gateway.getActiveModel();
      if (selected.configKey !== values.model) throw new Error(`Every inference must use ${values.model}`);
      const item = { request, started_at: Date.now(), model: { config_key: selected.configKey, model_id: selected.modelId, provider_key: selected.providerKey, adapter_key: selected.adapterKey, effective_reasoning_effort: request.reasoning_effort || selected.reasoningEffort } };
      const index = requests.push(item);
      try { const response = await original(request); item.response = response; return response; }
      catch (error) { item.error = { message: error.message, ...(Number.isSafeInteger(error.status) ? { http_status: error.status } : {}) }; throw error; }
      finally { item.finished_at = Date.now(); await fs.writeFile(path.join(values.out, `inference-${String(index).padStart(3, '0')}.json`), JSON.stringify(item), { mode: 0o600 }); }
    };
    const events = [];
    console.log(JSON.stringify({ model: model.configKey, reasoning_effort: values.effort || model.reasoningEffort, question }));
    const { result } = await gateway.runWithActiveModel(model, () => inference.withContext({ purpose: 'manual' }, () => orchestrator.execute('dictionary_expert_hpa', { question }, {
      db, visitorId: 1, rawQuery: '', reasoningEffort: values.effort,
      onStep: async event => { events.push({ ...event, unix_ms: Date.now() }); console.log(`${event.stage} ${String(event.label || '')} ${String(event.message || '').slice(0, 200)}`); }
    })));
    // Usage as the provider reported it on each recorded call.
    const total = key => requests.reduce((sum, item) => sum + (Number(item.response?.usage?.[key]) || 0), 0);
    const summary = { question, model: model.configKey, reasoning_effort: values.effort || model.reasoningEffort, result, seconds: (Date.now() - started) / 1000,
      accounting: { calls: requests.filter(item => item.response).length, attempted_calls: requests.length, input_tokens: total('prompt_tokens'), output_tokens: total('completion_tokens'), total_tokens: total('total_tokens') } };
    await fs.writeFile(path.join(values.out, 'result.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(values.out, 'events.json'), JSON.stringify(events), { mode: 0o600 });
    await fs.writeFile(path.join(values.out, 'answer.md'), `# ${values.model}\n\n**Q:** ${question}\n\n${result?.summary_md || result?.text || JSON.stringify(result).slice(0, 4000)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ status: result?.status, citations: (result?.citations || []).length, pages: (result?.pages || []).length, not_found: result?.not_found || '', tokens: summary.accounting, seconds: summary.seconds }));
  } finally {
    config?.stopRefreshing();
    await connection.rollback();
    await connection.end();
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
