'use strict';

// The investigator benchmark: the investigator agent (investigator_hpa) over a benchmark folder
// laid out as questions/questions.json and references/answers.json, one catalog model bound
// for the process, the database read only, every model call kept in memory.
//
// Run:    node scripts/manual/investigator_benchmark.js --run --benchmark <abs dir> --model <config key>
//           [--effort low] [--label <results folder>] [--only I1,I2] [--parallel 4]
//         One JSON per question lands in results/<label>/runs/; a question with a file is not
//         run again.
// Score:  node scripts/manual/investigator_benchmark.js --score --benchmark <abs dir> --label <results folder>
//         Every expected row of the reference (a point, its context, its value) must appear in a
//         returned table; the cited source file must be the reference's. A negative question
//         passes when the agent reports that no table holds the value; a rejection question
//         passes when the agent refuses the question as several fields.
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { connect } = require('./search_benchmark');

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 1) + '\n');
const median = list => { const sorted = list.slice().sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };
const norm = v => String(v ?? '').trim().toLowerCase();
const sameValue = (got, want) => {
  const g = String(got ?? '').trim(), w = String(want ?? '').trim();
  if (g === w) return true;
  const gn = Number(g.replace(/,/g, '')), wn = Number(w.replace(/,/g, ''));
  if (Number.isFinite(gn) && Number.isFinite(wn) && g !== '' && w !== '') return Math.abs(gn - wn) <= Math.max(1e-9, Math.abs(wn) * 1e-6);
  return norm(g) === norm(w);
};

async function loadBenchmark(dir) {
  const questions = await readJson(path.join(dir, 'questions/questions.json'));
  const references = await readJson(path.join(dir, 'references/answers.json'));
  for (const q of questions) if (!references[q.id]) throw new Error(`${q.id} has no reference`);
  return { questions, references };
}

async function run(values) {
  if (!values.model) throw new Error('--model is required');
  const { questions } = await loadBenchmark(values.benchmark);
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
    const settings = { model: model.configKey, reasoning_effort: values.effort || model.reasoningEffort, release: session.release, parallel: Number(values.parallel), questions: todo.length, started_unix_ms: Date.now() };
    console.log(JSON.stringify(settings));
    const runOne = async q => {
      const file = path.join(out, 'runs', `${q.id}.json`);
      try { await fs.access(file); return; } catch {}
      const started = Date.now();
      const steps = [];
      let result, error = null;
      try {
        const answer = await gateway.runWithActiveModel(model, () => inference.withContext({ purpose: 'manual' }, () => orchestrator.execute('investigator_hpa', { question: q.text, ...(q.points ? { points: q.points } : {}) }, {
          db: session.db, visitorId: 1, rawQuery: '', reasoningEffort: values.effort, onStep: async e => { steps.push({ stage: e.stage, label: e.label || null, message: String(e.message || '').slice(0, 600) }); }
        })));
        result = answer.result;
      } catch (e) { error = e.message; result = null; }
      const tables = (result?.tables || []).map(t => ({ name: t.name, title: t.title, source_file: t.source_file, columns: t.columns, rows: t.rows, mapping: t.mapping || null, note: t.note || null }));
      const rec = {
        id: q.id, difficulty: q.difficulty, text: q.text, points: q.points || null, status: error ? 'error' : result?.status || null, found: result?.found ?? null, error: error || result?.error || null,
        note: result?.note || null, mapping: result?.mapping || null, unresolved: result?.unresolved || [], tables,
        tokens: result?.tokens?.total || null, calls: result?.calls ?? null, turns: result?.turns ?? null, seconds: (Date.now() - started) / 1000,
        model: model.configKey, reasoning_effort: values.effort || model.reasoningEffort, release: session.release, steps
      };
      await writeJson(file, rec);
      console.log(`${q.id}\t${rec.status}\t${tables.length} tables\t${rec.tokens?.total ?? '-'} tok\t${rec.seconds.toFixed(1)}s\t${(rec.error || rec.note || '').slice(0, 140)}`);
    };
    const queue = [...todo];
    if (Number(values.parallel) > 1 && queue.length) await runOne(queue.shift());
    await Promise.all(Array.from({ length: Number(values.parallel) }, async () => { while (queue.length) await runOne(queue.shift()); }));
    await writeJson(path.join(out, 'run.json'), { ...settings, finished_unix_ms: Date.now() });
  } finally { await session.end(); }
}

// One expected row is found when a returned table has a row whose key column holds the point
// (symbol or Ensembl id), whose context columns hold the expected context, and whose value
// column holds the expected value.
function findRow(tables, expected) {
  const cellsOf = row => Object.values(row).map(norm);
  const points = expected.point.map(norm);
  const isPoint = row => cellsOf(row).some(c => points.includes(c));
  // The investigator returns one table per value column, so a context that is itself a value
  // (a publication id beside a concentration) may sit in a sibling table's row for the same
  // point; a context that names the column holding the value is a column name, not a cell.
  const contextHeld = (value, table, row) => {
    const v = norm(value);
    if (cellsOf(row).includes(v) || (table.columns || []).map(norm).includes(v)) return true;
    return tables.some(t => (t.rows || []).some(r => isPoint(r) && cellsOf(r).includes(v)));
  };
  for (const table of tables) {
    for (const row of table.rows || []) {
      if (!isPoint(row)) continue;
      if (!Object.values(row).some(v => sameValue(v, expected.value))) continue;
      if (Object.values(expected.context || {}).every(v => contextHeld(v, table, row))) return { table: table.source_file || null };
    }
  }
  return null;
}

function scoreRecord(rec, ref) {
  if (ref.kind === 'negative') {
    const text = norm(`${rec.note || ''} ${rec.error || ''} ${(rec.tables || []).map(t => t.note || '').join(' ')}`);
    const admitted = rec.found === false || /no table|nothing in the release|not (held|recorded|in) |does not hold|holds no|not available|no column/.test(text);
    return { correct: admitted && !(rec.tables || []).some(t => (t.rows || []).length), reason: admitted ? 'reported no table holds the value' : 'did not report the value as absent', rows_expected: 0, rows_found: 0, source_ok: null };
  }
  if (ref.kind === 'rejection') {
    const text = norm(`${rec.error || ''} ${rec.note || ''}`);
    const refused = rec.status === 'error' || /one (field|context|origin)|several fields|one at a time|two fields|more than one field/.test(text);
    return { correct: refused && !(rec.tables || []).some(t => (t.rows || []).length), reason: refused ? 'refused as several fields' : 'answered instead of refusing', rows_expected: 0, rows_found: 0, source_ok: null };
  }
  const expected = ref.rows;
  let found = 0; const sources = new Set();
  for (const e of expected) { const hit = findRow(rec.tables || [], e); if (hit) { found++; if (hit.table) sources.add(hit.table); } }
  // A question over two files (two fields at once) expects every one of them read.
  const wanted = ref.source_files || (ref.source_file ? [ref.source_file] : []);
  const sourceOk = wanted.length ? wanted.every(w => [...sources].some(s => norm(s) === norm(w))) : null;
  const correct = found === expected.length && expected.length > 0 && (sourceOk !== false);
  return { correct, reason: correct ? 'every expected row present from the reference source' : found < expected.length ? `${found} of ${expected.length} expected rows present` : 'rows present but read from another source', rows_expected: expected.length, rows_found: found, source_ok: sourceOk, sources: [...sources] };
}

async function score(values) {
  const { questions, references } = await loadBenchmark(values.benchmark);
  const out = path.join(values.benchmark, 'results', values.label);
  const results = [];
  for (const q of questions) {
    const file = path.join(out, 'runs', `${q.id}.json`);
    let rec;
    try { rec = await readJson(file); } catch { continue; }
    rec.score = scoreRecord(rec, references[q.id]);
    await writeJson(file, rec);
    results.push(rec);
    console.log(`${q.id}\t${rec.score.correct ? 'CORRECT' : 'WRONG'}\t${rec.score.rows_found}/${rec.score.rows_expected}\tsource ${rec.score.source_ok === null ? '-' : rec.score.source_ok ? 'ok' : 'other'}\t${rec.tokens?.total ?? '-'} tok\t${rec.score.reason}`);
  }
  const byId = new Map(questions.map(q => [q.id, q]));
  const rows = results.map(r => [r.id, byId.get(r.id).difficulty, r.status, r.score.correct, r.score.rows_found, r.score.rows_expected, r.score.source_ok ?? '', r.tokens?.total ?? '', r.seconds.toFixed(1)]);
  await fs.writeFile(path.join(out, 'results.tsv'), ['id\tdifficulty\tstatus\tcorrect\trows_found\trows_expected\tsource_ok\ttokens\tseconds', ...rows.map(r => r.join('\t'))].join('\n') + '\n');
  const count = (list, test) => list.filter(test).length;
  const tier = name => { const list = results.filter(r => byId.get(r.id).difficulty === name); return { questions: list.length, correct: count(list, r => r.score.correct) }; };
  const summary = { model: results[0]?.model || null, reasoning_effort: results[0]?.reasoning_effort || null, release: results[0]?.release || null, questions: results.length, correct: count(results, r => r.score.correct), failed: count(results, r => r.status === 'error'),
    by_difficulty: { Easy: tier('Easy'), Medium: tier('Medium'), Hard: tier('Hard') },
    tokens_total: results.reduce((s, r) => s + (r.tokens?.total || 0), 0), tokens_prompt: results.reduce((s, r) => s + (r.tokens?.prompt || 0), 0), tokens_completion: results.reduce((s, r) => s + (r.tokens?.completion || 0), 0),
    tokens_median: median(results.map(r => r.tokens?.total || 0)), seconds_median: median(results.map(r => r.seconds || 0)) };
  await writeJson(path.join(out, 'summary.json'), summary);
  console.log(JSON.stringify(summary));
}

async function main() {
  const { values } = parseArgs({ options: { run: { type: 'boolean', default: false }, score: { type: 'boolean', default: false }, benchmark: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, label: { type: 'string' }, only: { type: 'string' }, parallel: { type: 'string', default: '4' } } });
  if (!values.benchmark || !path.isAbsolute(values.benchmark)) throw new Error('an absolute --benchmark directory is required');
  if (!values.label) throw new Error('--label names the results folder');
  if (values.run) await run(values); else if (values.score) await score(values); else throw new Error('one of --run or --score is required');
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { scoreRecord, findRow };
