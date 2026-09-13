'use strict';

// The deep-search benchmark: the search agent (deep_research_hpa) over a benchmark folder laid
// out as questions/questions.json and references/queries.json, one catalog model bound for the
// process, the database read only, every model call kept in memory.
//
// Check:  node scripts/manual/search_benchmark.js --check --benchmark <absolute dir>
//         Composes every reference query from its filters, executes it on the local release and
//         fetches it from proteinatlas.org, and writes the query, its clauses and both gene counts
//         back into references/queries.json. A reference is sound when both gene sets are the
//         same and not empty.
// Run:    node scripts/manual/search_benchmark.js --run --benchmark <dir> --model <config key>
//           [--effort low] [--mode offline|online] [--label <results folder>] [--only D1,D2]
//           [--parallel 10]
//         One JSON per question lands in results/<label>/runs/; a question whose file exists is
//         not run again.
// Score:  node scripts/manual/search_benchmark.js --score --benchmark <dir> --label <results folder>
//         Executes each composed query and its reference on the local release and fetches both
//         from the atlas, then writes results.tsv and summary.json: queries whose clause set
//         equals the reference's, whose gene set equals the reference's, and whose local count
//         equals the atlas's own count for the same query.
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { parseArgs } = require('node:util');
const mysql = require('mysql2/promise');
const backend = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(backend, '.env'), quiet: true });
const { IsolatedStudyDb } = require('./compare_study_context');
const adapter = require('../../src/hpa/searchAdapter');

const SEARCH = 'https://www.proteinatlas.org/search/';

// The clauses of a search query, each "AND|NOT urlKey:level;level" with values lower-cased, as
// a set: the same filters in another order are the same query.
function clauses(url) {
  const out = new Set();
  for (const item of parts(url)) out.add(`${item.operator} ${item.key.toLowerCase()}:${item.levels.map(values => values.map(v => v.toLowerCase()).sort().join(',')).join(';')}`);
  return out;
}

function parts(url) {
  const q = String(url || '').replace(/^.*\/search\//, '');
  const out = [];
  let operator = 'AND';
  for (const part of q.split(/\+(?=(?:AND|NOT)\+)/)) {
    let text = part;
    const m = /^(AND|NOT)\+(.*)$/s.exec(text);
    if (m) { operator = m[1]; text = m[2]; }
    const [key, ...rest] = text.split(':');
    const levels = rest.join(':').split(';').map(level => level.split(',').map(v => decodeURIComponent(v.replace(/\+/g, ' ')).trim()).filter(Boolean));
    out.push({ operator, key, levels });
    operator = 'AND';
  }
  return out;
}

// The filters of a search query in the adapter's terms, or an error naming what the schema lacks.
function filtersOf(url) {
  const filters = [];
  for (const item of parts(url)) {
    const f = adapter.fields().find(f => f.urlKey === item.key);
    if (!f) return { error: `no field with url key ${JSON.stringify(item.key)}` };
    const c = adapter.canonicalize(f.name, item.levels);
    if (c.error) return { error: `${item.key}: ${c.error}` };
    filters.push({ ...c, operator: item.operator });
  }
  return { filters };
}

// Reference filters as written in queries.json (field, path, operator) in the adapter's terms.
function filtersFrom(items) {
  const filters = [];
  const problems = [];
  for (const item of items) {
    const c = adapter.canonicalize(item.field, item.path);
    if (c.error) { problems.push(`${item.field}: ${c.error}`); continue; }
    filters.push({ ...c, operator: item.operator === 'NOT' ? 'NOT' : 'AND' });
  }
  return { filters, problems };
}

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'AtlasAI benchmark (research; contact: atlasai)', Accept: 'text/tab-separated-values' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} from the atlas`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// The gene set the atlas returns for a query, read from its tab-separated download.
async function liveGenes(url, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const text = await httpGetText(`${url}?format=tsv&compress=no`);
      const lines = text.split('\n').filter(line => line.length);
      if (!lines.length) return new Set();
      const header = lines[0].split('\t').map(cell => cell.replace(/^"|"$/g, ''));
      const at = header.indexOf('Ensembl');
      if (at < 0) throw new Error('the atlas download has no Ensembl column');
      return new Set(lines.slice(1).map(line => line.split('\t')[at]?.replace(/^"|"$/g, '')).filter(Boolean));
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function connect() {
  if (process.env.HPA_DB_NAME !== 'atlasai' || !['127.0.0.1', 'localhost'].includes(process.env.HPA_DB_HOST)) throw new Error('The benchmark requires the local atlasai read-only connection');
  const connection = await mysql.createConnection({ host: process.env.HPA_DB_HOST, user: process.env.HPA_DB_USER, password: process.env.HPA_DB_PASS, database: process.env.HPA_DB_NAME });
  await connection.query('START TRANSACTION READ ONLY');
  const db = new IsolatedStudyDb(connection);
  const config = await require('../../src/policy/config').initializePlatformConfig(db);
  const runtime = require('../../src/config/runtime').loadRuntimeConfig(backend);
  const { localData } = require('../../src/hpa/localData');
  localData.configure({ root: runtime.dataLocalRoot, db });
  const release = config.current().activeHpaVersion;
  await require('../../src/hpa/duckStore').duckStore.ensure({ root: runtime.dataLocalRoot, version: release, datasets: await localData.datasets.listReady(release), log: () => {} });
  return { connection, db, config, release, end: async () => { config.stopRefreshing(); await connection.rollback(); await connection.end(); } };
}

const genesOf = rows => new Set((Array.isArray(rows) ? rows : []).map(r => r.Ensembl).filter(Boolean));
const sameSet = (a, b) => Boolean(a && b) && a.size === b.size && [...a].every(g => b.has(g));
const median = list => { const sorted = list.slice().sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 1) + '\n');

async function localGenes(filters) {
  const out = await adapter.execute(filters, adapter.compose(filters), 'offline');
  return genesOf(out.rows);
}

async function loadBenchmark(dir) {
  const questions = await readJson(path.join(dir, 'questions/questions.json'));
  const references = await readJson(path.join(dir, 'references/queries.json'));
  for (const q of questions) if (!references[q.id]) throw new Error(`${q.id} has no reference query`);
  return { questions, references };
}

async function check(values) {
  const file = path.join(values.benchmark, 'references/queries.json');
  const references = await readJson(file);
  const session = await connect();
  const only = values.only ? new Set(values.only.split(',').map(s => s.trim())) : null;
  let sound = 0;
  try {
    for (const [id, ref] of Object.entries(references)) {
      if (only && !only.has(id)) { if (ref.check?.same_set && ref.check.local_genes > 0) sound++; continue; }
      const { filters, problems } = filtersFrom(ref.filters);
      if (problems.length) { ref.url = null; ref.clauses = []; ref.check = { release: session.release, problems, local_genes: null, live_genes: null, same_set: false, checked_unix_ms: Date.now() }; console.log(`${id}\tPROBLEM\t${problems.join('; ')}`); continue; }
      const url = adapter.compose(filters);
      let local, live, error = null;
      try { local = await localGenes(filters); } catch (e) { error = `local: ${e.message}`; }
      try { live = await liveGenes(url); } catch (e) { error = (error ? error + '; ' : '') + `live: ${e.message}`; }
      const same = sameSet(local, live);
      ref.url = url;
      ref.clauses = [...clauses(url)];
      ref.check = { release: session.release, problems: error ? [error] : [], local_genes: local ? local.size : null, live_genes: live ? live.size : null, same_set: same, checked_unix_ms: Date.now() };
      if (same && local.size > 0) sound++;
      console.log(`${id}\t${same && local.size > 0 ? 'SOUND' : same ? 'EMPTY' : 'DIFF'}\tlocal ${local ? local.size : '-'}\tlive ${live ? live.size : '-'}\t${error || ''}`);
      await writeJson(file, references);
    }
  } finally { await session.end(); }
  console.log(JSON.stringify({ references: Object.keys(references).length, sound, release: session.release }));
}

async function run(values) {
  if (!values.model) throw new Error('--model is required');
  const { questions, references } = await loadBenchmark(values.benchmark);
  const only = values.only ? new Set(values.only.split(',').map(s => s.trim())) : null;
  const todo = questions.filter(q => !only || only.has(q.id));
  const out = path.join(values.benchmark, 'results', values.label);
  await fs.mkdir(path.join(out, 'runs'), { recursive: true });
  const session = await connect();
  try {
    const { initializeInferenceGateway, inference } = require('../../src/inference/gateway');
    const gateway = await initializeInferenceGateway(session.db);
    const orchestrator = require('../../src/system/orchestrator');
    const model = await gateway.loadModel(values.model);
    if (!model) throw new Error(`No catalog model with config_key ${JSON.stringify(values.model)}`);
    const settings = { model: model.configKey, reasoning_effort: values.effort || model.reasoningEffort, mode: values.mode, release: session.release, parallel: Number(values.parallel), questions: todo.length, started_unix_ms: Date.now() };
    console.log(JSON.stringify(settings));
    const runOne = async q => {
      const file = path.join(out, 'runs', `${q.id}.json`);
      try { await fs.access(file); return; } catch {}
      const started = Date.now();
      const steps = [];
      let result;
      try {
        const answer = await gateway.runWithActiveModel(model, () => inference.withContext({ purpose: 'manual' }, () => orchestrator.execute('deep_research_hpa', { goal: q.text, mode: values.mode }, {
          db: session.db, visitorId: 1, rawQuery: '', reasoningEffort: values.effort, onStep: async e => { steps.push({ stage: e.stage, label: e.label || null, message: String(e.message || '').slice(0, 600) }); }
        })));
        result = answer.result;
      } catch (error) { result = { status: 'error', error: error.message }; }
      const url = result?.result?.search_urls?.[0] || null;
      const rec = {
        id: q.id, difficulty: q.difficulty, text: q.text, status: result?.status || null, outcome: result?.outcome || null, error: result?.error || null,
        url, rows_found: result?.result?.rows_found ?? null, plan: result?.result?.plan || null, understanding: result?.result?.understanding || null,
        trail: result?.result?.trail || [], requirements: result?.result?.requirements || [], not_expressible: result?.result?.not_expressible || [],
        tokens: result?.tokens || null, seconds: (Date.now() - started) / 1000, model: model.configKey, reasoning_effort: values.effort || model.reasoningEffort, mode: values.mode, release: session.release, steps
      };
      await writeJson(file, rec);
      const want = clauses(references[q.id].url), got = url ? clauses(url) : new Set();
      const same = url !== null && want.size === got.size && [...want].every(c => got.has(c));
      console.log(`${q.id}\t${same ? 'SAME' : rec.status === 'ok' ? 'DIFF' : 'FAIL'}\t${rec.tokens?.total ?? '-'} tok\t${rec.seconds.toFixed(1)}s\t${same ? '' : (rec.error || `- ${[...want].filter(c => !got.has(c)).join(' | ')} + ${[...got].filter(c => !want.has(c)).join(' | ')}`).slice(0, 220)}`);
    };
    const queue = [...todo];
    // The first question runs alone so the local indexes (protein classes, per-tissue values)
    // are built once; parallel runs then share them instead of each building its own.
    if (Number(values.parallel) > 1 && queue.length) await runOne(queue.shift());
    await Promise.all(Array.from({ length: Number(values.parallel) }, async () => { while (queue.length) await runOne(queue.shift()); }));
    await writeJson(path.join(out, 'run.json'), { ...settings, finished_unix_ms: Date.now() });
  } finally { await session.end(); }
}

async function score(values) {
  const { questions, references } = await loadBenchmark(values.benchmark);
  const out = path.join(values.benchmark, 'results', values.label);
  const session = await connect();
  const results = [];
  try {
    for (const q of questions) {
      const file = path.join(out, 'runs', `${q.id}.json`);
      let rec;
      try { rec = await readJson(file); } catch { continue; }
      if (!rec.score || values.rescore) {
        const ref = references[q.id];
        const want = clauses(ref.url), got = rec.url ? clauses(rec.url) : new Set();
        const referenceFilters = filtersFrom(ref.filters).filters;
        const referenceLocal = await localGenes(referenceFilters);
        const referenceLive = await liveGenes(ref.url).catch(error => ({ error: error.message }));
        const parsed = rec.url ? filtersOf(rec.url) : { error: rec.error || 'no query composed' };
        const agentLocal = parsed.filters ? await localGenes(parsed.filters).catch(error => ({ error: error.message })) : { error: parsed.error };
        const agentLive = rec.url ? await liveGenes(rec.url).catch(error => ({ error: error.message })) : { error: parsed.error };
        const set = value => value instanceof Set ? value : null;
        rec.score = {
          same_clauses: rec.url !== null && want.size === got.size && [...want].every(c => got.has(c)),
          missing_clauses: [...want].filter(c => !got.has(c)), extra_clauses: [...got].filter(c => !want.has(c)),
          reference_rows_local: referenceLocal.size, reference_rows_live: set(referenceLive)?.size ?? null,
          agent_rows_local: set(agentLocal)?.size ?? null, agent_rows_live: set(agentLive)?.size ?? null,
          same_genes_local: sameSet(set(agentLocal), referenceLocal), same_genes_live: sameSet(set(agentLive), set(referenceLive)),
          overlap_live: set(agentLive) && set(referenceLive) ? [...agentLive].filter(g => referenceLive.has(g)).length : null,
          count_verified: rec.rows_found !== null && set(agentLive) !== null && rec.rows_found === agentLive.size,
          errors: [referenceLive.error, agentLocal.error, agentLive.error].filter(Boolean)
        };
        await writeJson(file, rec);
      }
      results.push(rec);
      const s = rec.score;
      console.log(`${q.id}\tclauses ${s.same_clauses ? 'same' : 'diff'}\tgenes ${s.same_genes_live ? 'same' : 'diff'}\tcount ${s.count_verified ? 'verified' : 'off'}\tagent ${s.agent_rows_local}/${s.agent_rows_live}\treference ${s.reference_rows_local}/${s.reference_rows_live}\t${s.errors.join('; ')}`);
    }
  } finally { await session.end(); }
  const byId = new Map(questions.map(q => [q.id, q]));
  const rows = results.map(r => [r.id, byId.get(r.id).difficulty, byId.get(r.id).filters, r.status, r.score.same_clauses, r.score.same_genes_live, r.score.count_verified, r.rows_found, r.score.agent_rows_live, r.score.reference_rows_live, r.tokens?.total ?? '', r.seconds.toFixed(1), r.url || '']);
  await fs.writeFile(path.join(out, 'results.tsv'), ['id\tdifficulty\tfilters\tstatus\tsame_clauses\tsame_genes\tcount_verified\trows_local\trows_live\treference_rows_live\ttokens\tseconds\turl', ...rows.map(r => r.join('\t'))].join('\n') + '\n');
  const count = (list, test) => list.filter(test).length;
  const tier = name => { const list = results.filter(r => byId.get(r.id).difficulty === name); return { questions: list.length, same_clauses: count(list, r => r.score.same_clauses), same_genes: count(list, r => r.score.same_genes_live), count_verified: count(list, r => r.score.count_verified) }; };
  const summary = {
    model: results[0]?.model || null, reasoning_effort: results[0]?.reasoning_effort || null, mode: results[0]?.mode || null, release: session.release, questions: results.length,
    composed: count(results, r => r.url), failed: count(results, r => r.status !== 'ok'),
    same_clauses: count(results, r => r.score.same_clauses), same_genes: count(results, r => r.score.same_genes_live), count_verified: count(results, r => r.score.count_verified),
    by_difficulty: { Easy: tier('Easy'), Medium: tier('Medium'), Hard: tier('Hard') },
    tokens_total: results.reduce((s, r) => s + (r.tokens?.total || 0), 0), tokens_prompt: results.reduce((s, r) => s + (r.tokens?.prompt || 0), 0), tokens_completion: results.reduce((s, r) => s + (r.tokens?.completion || 0), 0),
    tokens_median: median(results.map(r => r.tokens?.total || 0)), seconds_median: median(results.map(r => r.seconds || 0))
  };
  await writeJson(path.join(out, 'summary.json'), summary);
  console.log(JSON.stringify(summary));
}

async function main() {
  const { values } = parseArgs({ options: {
    check: { type: 'boolean', default: false }, run: { type: 'boolean', default: false }, score: { type: 'boolean', default: false }, rescore: { type: 'boolean', default: false },
    benchmark: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, mode: { type: 'string', default: 'offline' }, label: { type: 'string' }, only: { type: 'string' }, parallel: { type: 'string', default: '4' }
  } });
  if (!values.benchmark || !path.isAbsolute(values.benchmark)) throw new Error('an absolute --benchmark directory is required');
  if (values.check) await check(values);
  else if (values.run) { if (!values.label) throw new Error('--label names the results folder'); await run(values); }
  else if (values.score) { if (!values.label) throw new Error('--label names the results folder'); await score(values); }
  else throw new Error('one of --check, --run or --score is required');
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { clauses, filtersOf, filtersFrom, connect, liveGenes, SEARCH };
