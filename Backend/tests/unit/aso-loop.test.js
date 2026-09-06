'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

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
    '../../inference/gateway': { getActiveModel: () => ({ id: 1, configKey: 'test-model' }), inference: {
      assignContext() {},
      chat: { completions: { async create(request) { requests.push(request); return decide({ request, turn: requests.length, agentDone }); } } }
    } },
    '../../policy/config': { platformConfig: () => ({ asoMaxSteps: 40, asoParallelLimit: 3, asoContextBytes: 8192 }) },
    '../../hpa/geneDataAdapter': { async catalog() { return [entry]; }, async entry(name) { return name === entry.file ? entry : null; }, definition: () => null },
    '../../hpa/agentMode': { async resolveAgentMode() { return { mode: 'offline', hpaVersion: 'test' }; } },
    '../../hpa/localData': { FILES: { master: 'mapping.tsv' }, localData: { async master() { return { rows: options.rows }; }, async *rows(name) {
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
      { type: 'function', function: { name: 'investigator_hpa', parameters: { type: 'object', properties: { gene: { type: 'string' }, question: { type: 'string' }, mode: { type: 'string' } }, required: ['gene'] } } }
    ], execute: execute || (() => { throw new Error('Unexpected agent call'); }) }
  };
  const filename = require.resolve('../../src/system/agents/asoStudy');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const run = args => loaded.exports({ goal: 'Inspect the available evidence', ...args }, { db: {}, visitorId: 1, async onStep(event) { events.push(event); if (event.stage === 'tool.failed') t.diagnostic(event.message); if (['tool.done', 'tool.failed'].includes(event.stage)) agentDone.resolve(event); } });
  return { run, events, requests, updates, directory };
}

test('the real loop retains an agent completion during inference and refuses a premature finish', async t => {
  const agent = deferred();
  const f = await fixture(t, async ({ request, turn, agentDone }) => {
    const text = transcript(request);
    if (turn === 1) {
      const specs = new Map(request.tools.map(x => [x.function.name, x.function]));
      assert.ok(specs.has('deep_research_hpa'));
      assert.ok(specs.has('measure'));
      assert.deepEqual(specs.get('set_plan').parameters.properties.items.items.required, ['step', 'kind']);
      return response(call('set_plan', { items: [{ step: 'Get evidence', kind: 'gene_set' }, { step: 'Finish', kind: 'summary' }] }));
    }
    if (turn === 2) return response(call('deep_research_hpa', { goal: 'Look up TEST', node: 1 }), call('datasets', {}));
    if (turn === 3) {
      assert.match(text, /RUNNING\nt1 deep_research_hpa/);
      agent.resolve({ result: { status: 'ok', result: { rows: [{ Gene: 'TEST', value: 42 }] } } });
      assert.equal((await agentDone.promise).stage, 'tool.done');
      return response(call('finish', { summary: 'Premature conclusion' }));
    }
    assert.equal(turn, 4);
    assert.match(text, /TEST/);
    assert.match(text, /finish refused/);
    assert.match(text, /RUNNING\n\(none\)/);
    return response(call('finish', { summary: 'TEST has the observed value 42 (a1).' }));
  }, () => agent.promise);
  const result = await f.run();
  assert.equal(result.outcome, 'completed');
  assert.equal(result.turns, 4);
  assert.equal(result.artifacts.length, 1);
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'context', 'turn-04.request.json'), 'utf8'));
  assert.deepEqual(saved, f.requests[3]);
  assert.equal(f.events.filter(e => e.stage === 'finish.refused').length, 1);
});

test('planning and a specialist can start together using declared tools on the first turn', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) {
      const research = request.tools.find(x => x.function.name === 'deep_research_hpa');
      assert.ok(research.function.parameters.required.includes('goal'));
      return response(
        call('set_plan', { items: [{ step: 'Find the requested evidence', kind: 'gene_set' }] }),
        call('deep_research_hpa', { goal: 'Find TEST', node: 1 }),
        call('datasets', {})
      );
    }
    assert.match(transcript(request), /TEST/);
    return response(call('finish', { summary: 'TEST is in the returned evidence (a1).' }));
  }, async () => ({ result: { status: 'ok', result: { rows: [{ Gene: 'TEST', value: 42 }] } } }));
  const result = await f.run();
  assert.equal(result.outcome, 'completed');
  assert.equal(result.failed, 0);
  assert.ok(result.turns <= 3); // A completion arriving during inference must be inspected next turn.
  assert.equal(result.plan[0].status, 'done');
  assert.equal(f.events.filter(e => e.stage === 'tool.start').length, 1);
  assert.ok(f.events.findIndex(e => e.stage === 'tool.start') < f.events.findIndex(e => e.stage === 'turn' && JSON.parse(e.message).turn === 2));
});

test('ASO passes a saved list to bulk Investigator without copying it into prompts, and receives every result table', async t => {
  let calls = 0;
  const cohort = Array.from({ length: 600 }, (_, i) => ({ Gene: `BULK_GENE_${i}`, Ensembl: `ENSG${String(i).padStart(11, '0')}` }));
  const f = await fixture(t, ({ request, turn }) => {
    assert.doesNotMatch(JSON.stringify(request), /BULK_GENE_599/);
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Find cohort', kind: 'gene_set' }, { step: 'Measure both sources', kind: 'table' }] }), call('deep_research_hpa', { goal: 'Find cohort', node: 1 }));
    if (turn === 2) return response(call('investigator_hpa', { from: 'a1', question: 'Measure both sources', node: 2 }));
    assert.match(transcript(request), /first_measurements/); assert.match(transcript(request), /second_measurements/);
    return response(call('finish', { summary: 'Both source tables are available (a2, a3).' }));
  }, async (name, args, ctx) => {
    calls++;
    if (name === 'deep_research_hpa') return { result: { status: 'ok', result: { rows: cohort } } };
    assert.equal(args.genes.length, 600); assert.equal(args.genes[599], cohort[599].Ensembl);
    assert.equal(args.from, undefined); assert.equal(ctx.inputRows.length, 600);
    assert.equal(ctx.studyGoal, 'Inspect the available evidence');
    assert.equal(ctx.studyTask, 'Measure both sources');
    return { result: { bulk: true, found: true, tables: ['first_measurements', 'second_measurements'].map(name => ({ name, rows: ctx.inputRows.map(row => ({ gene: row.gene, ensembl: row.ensembl, measurement: 12 })), columns: ['gene', 'ensembl', 'measurement'], provenance: [{ table: 'raw.tsv' }], coverage: [{ inputs: 600 }], calculations: [] })), not_in_release: [], input_count: 600, answer: 'Measurements returned' } };
  });
  const result = await f.run();
  assert.equal(result.outcome, 'completed', result.error); assert.equal(calls, 2); assert.equal(result.artifacts.length, 3);
  assert.equal(result.artifacts[2].summary.row_count, 600);
  const stored = JSON.parse(await fs.readFile(result.artifacts[2].storage_uri, 'utf8'));
  assert.deepEqual(stored.provenance.sources, ['artifact-1']);
  assert.equal(stored.provenance.lookups[0].table, 'raw.tsv');
});

test('partial bulk data remains available while its unfinished plan step stays open', async t => {
  let counted = false;
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Count genes by cohort', kind: 'table' }] }), call('investigator_hpa', { genes: ['ONE', 'TWO'], question: 'Retrieve data and count by cohort', node: 1 }));
    if (!/Unfinished work for ASO/.test(transcript(request))) return response(call('skip', { reason: 'Waiting for the source data' }));
    if (!counted) {
      assert.match(transcript(request), /1\. \[doing\]/);
      assert.match(transcript(request), /Unfinished work for ASO/);
      assert.match(transcript(request), /Stopped before finish/);
      counted = true;
      return response(call('aggregate', { artifact: 'a1', group_by: 'cohort', column: 'gene', metrics: ['count'], node: 1 }));
    }
    assert.match(transcript(request), /1\. \[done\]/);
    return response(call('finish', { summary: 'The cohort counts are available in a2.' }));
  }, async () => ({ result: { bulk: true, status: 'partial', found: true, error: 'Stopped before finish', answer: 'Source rows retained.', input_count: 2, unresolved_inputs: 0, not_in_release: [], remaining_for_aso: [{ requirement: 'Count genes by cohort', why: 'ASO has the cohort memberships' }], tables: [{ name: 'source_values', rows: [{ gene: 'ONE', cohort: 'A' }, { gene: 'TWO', cohort: 'B' }], columns: ['gene', 'cohort'], provenance: [], coverage: [], calculations: [] }] } }));
  const result = await f.run();
  assert.equal(result.outcome, 'completed', result.error); assert.equal(result.failed, 0);
  const first = JSON.parse(await fs.readFile(result.artifacts[0].storage_uri, 'utf8'));
  assert.equal(first.rows.length, 2); assert.equal(first.provenance.status, 'partial');
  assert.equal(first.provenance.error, 'Stopped before finish');
  assert.deepEqual(result.plan[0].artifacts, ['a1', 'a2']);
});

test('the real open tool exposes honest row pagination and preserves the full observation', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    const text = transcript(request);
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Finish', kind: 'summary' }] }));
    if (turn === 2) return response(call('open', { what: 'mapping.tsv', rows: 10 }));
    if (turn === 3) {
      assert.match(text, /rows 1–10; total not counted; more rows: open offset=10/);
      assert.doesNotMatch(text, /10 rows, whole/);
      return response(call('open', { what: 'mapping.tsv', rows: 10, offset: 10 }));
    }
    assert.match(text, /rows 11–17; 17 total rows; end of table/);
    return response(call('finish', { summary: 'Inspected the mapping.' }));
  });
  assert.equal((await f.run()).outcome, 'completed');
  assert.ok((await fs.readdir(path.join(f.directory, 'observations'))).length >= 2);
});

test('a late result cannot complete a replacement plan item with the same number', async t => {
  const agent = deferred();
  const f = await fixture(t, async ({ request, turn, agentDone }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Original question', kind: 'gene_set' }] }));
    if (turn === 2) return response(call('deep_research_hpa', { goal: 'Original question', node: 1 }), call('datasets', {}));
    if (turn === 3) return response(call('set_plan', { items: [{ step: 'Replacement question', kind: 'table' }] }), call('datasets', {}));
    if (turn === 4) {
      agent.resolve({ result: { status: 'ok', result: { rows: [{ Gene: 'TEST', value: 42 }] } } });
      await agentDone.promise;
      return response(call('skip', { reason: 'Inspect the arriving result' }));
    }
    assert.match(transcript(request), /1\. \[todo\] Replacement question/);
    assert.match(transcript(request), /rewritten plan was not marked done/);
    return response(call('update_plan', { item: 1, status: 'dropped', note: 'Original evidence does not answer the replacement question' }), call('finish', { summary: 'The replacement question remains unanswered.' }));
  }, () => agent.promise);
  const result = await f.run();
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.plan[0].status, 'dropped');
});

test('running out of turns produces an incomplete study, not a success claim', async t => {
  const f = await fixture(t, () => response(call('set_plan', { items: [{ step: 'Unfinished analysis', kind: 'table' }] })));
  const result = await f.run({ max_turns: 1 });
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.incomplete_reason, 'turn_budget_exhausted');
  assert.equal(result.budget_exhausted, true);
  assert.match(f.updates.at(-1).message, /Study incomplete/);
});

test('preparing data and a manual done update cannot complete a chart step; rendering can', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Get evidence', kind: 'gene_set' }, { step: 'Draw evidence', kind: 'bar' }] }));
    if (turn === 2) return response(call('deep_research_hpa', { goal: 'TEST', node: 1 }));
    if (turn === 3) return response(call('filter', { artifact: 'a1', where: [{ column: 'value', op: '>', value: 0 }], node: 2 }));
    if (turn === 4) {
      assert.match(transcript(request), /2\. \[doing\] Draw evidence/);
      assert.match(transcript(request), /requires chart output/);
      return response(call('update_plan', { item: 2, status: 'done', artifacts: ['a2'], note: 'Figure is finished' }), call('finish', { summary: 'Done.' }));
    }
    if (turn === 5) {
      assert.match(transcript(request), /update_plan refused for item 2: requires chart output/);
      return response(call('chart', { artifact: 'a2', type: 'bar', x: 'gene', y: 'value', node: 2 }));
    }
    assert.equal(turn, 6);
    assert.match(transcript(request), /2\. \[done\] Draw evidence/);
    return response(call('finish', { summary: 'TEST is shown in figure a3 from a2.' }));
  }, async () => ({ result: { status: 'ok', result: { rows: [{ Gene: 'TEST', value: 42 }] } } }));
  const result = await f.run();
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.plan[1].artifacts, ['a2', 'a3']);
  assert.equal(result.artifacts.filter(a => a.kind === 'figure').length, 1);
});

test('a chart specification without a rendered image cannot complete its plan step', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Get evidence', kind: 'gene_set' }, { step: 'Draw evidence', kind: 'bar' }] }));
    if (turn === 2) return response(call('deep_research_hpa', { goal: 'TEST', node: 1 }));
    if (turn === 3) return response(call('chart', { artifact: 'a1', type: 'bar', x: 'gene', y: 'value', node: 2 }));
    assert.match(transcript(request), /2\. \[doing\] Draw evidence/);
    assert.match(transcript(request), /requires chart output.*rendered figure/);
    return response(call('update_plan', { item: 2, status: 'dropped', note: 'Renderer did not produce an image' }), call('finish', { summary: 'Figure rendering failed.' }));
  }, async () => ({ result: { status: 'ok', result: { rows: [{ Gene: 'TEST', value: 42 }] } } }), { renderCharts: async () => ({ images: [] }) });
  assert.equal((await f.run()).outcome, 'incomplete');
});

test('an invalid context budget fails before creating a study', async t => {
  const f = await fixture(t, () => { throw new Error('Inference must not run'); });
  await assert.rejects(() => f.run({ context_budget_bytes: 0 }), /no longer supported/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.updates.length, 0);
});

test('native tools retain raw master columns, correct arguments and matched provider exchanges', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Select and calculate', kind: 'table' }] }));
    const names = request.tools.map(t => t.function.name);
    assert.ok(names.includes('filter') && names.includes('compute') && names.includes('measure'));
    assert.ok(!names.includes('run') && !names.includes('help') && !names.includes('aso_hpa'));
    if (turn === 2) return response(call('schema', { what: 'example.tsv' }));
    if (turn === 3) return response(call('filter', { artifact: 'example.tsv', where: [{ column: 'Gene', op: '=', value: 'EXAMPLE' }] }));
    if (turn === 4) return response(call('compute', { artifact: 'a1', expr: 'score * 7', name: 'scaled', node: 1 }));
    assert.match(transcript(request), /scaled.*EXAMPLE/s);
    assert.match(transcript(request), /score \* 7/);
    const replayed = request.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
    assert.ok(replayed.every(c => c.id && c.thought_signature === 'opaque-signature'));
    assert.equal(request.messages.filter(m => m.role === 'tool').length, replayed.length);
    return response(call('finish', { summary: 'EXAMPLE has scaled value 21 in a2.' }));
  }, null, { entry: { file: 'example.tsv', key: 'master', columns: ['Gene', 'Ensembl', 'score'] }, rows: [{ Gene: 'EXAMPLE', Ensembl: 'ENSG00000000001', score: 3 }, { Gene: 'SECOND', Ensembl: 'ENSG00000000002', score: 5 }] });
  const result = await f.run();
  assert.equal(result.outcome, 'completed');
  assert.equal(result.tool_calls, 2);
  const rows = JSON.parse(await fs.readFile(result.artifacts[1].storage_uri, 'utf8')).rows;
  assert.equal(rows[0].Gene, 'EXAMPLE');
  assert.equal(rows[0].Ensembl, 'ENSG00000000001');
  assert.equal(rows[0].scaled, 21);
});

test('an inference failure settles already running jobs before closing the workspace', async t => {
  const agent = deferred();
  const f = await fixture(t, ({ turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Search', kind: 'gene_set' }] }));
    if (turn === 2) return response(call('deep_research_hpa', { goal: 'TEST', node: 1 }), call('datasets', {}));
    setTimeout(() => agent.resolve({ result: { status: 'ok', result: { rows: [{ Gene: 'TEST', value: 42 }] } } }), 10);
    throw new Error('Provider request failed');
  }, () => agent.promise);
  const result = await f.run();
  assert.equal(result.status, 'error');
  assert.equal(result.artifacts.length, 1);
  assert.ok(f.events.findIndex(e => e.stage === 'tool.done') < f.events.findIndex(e => e.stage === 'error'));
  assert.equal(f.updates.at(-1).status, 'failed');
});

test('earlier evidence and full native tool descriptions survive a long conversation', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Inspect evidence', kind: 'summary' }] }));
    const compute = request.tools.find(t => t.function.name === 'compute').function;
    assert.ok(compute.parameters.required.includes('expr'));
    assert.match(compute.description, /expression/);
    assert.ok(!request.messages.some(m => m.content?.startsWith('STUDY CHECKPOINT:')));
    if (turn === 2) return response(call('open', { what: 'mapping.tsv', rows: 10 }));
    if (turn < 12) return response(call('note', { text: 'Decision content '.repeat(400) }));
    assert.ok(Buffer.byteLength(JSON.stringify(request.messages)) > 32768);
    assert.match(transcript(request), /label 0/);
    return response(call('finish', { summary: 'The inspected evidence is preserved.' }));
  });
  const result = await f.run({ max_turns: 12 });
  assert.equal(result.outcome, 'completed', result.error);
  assert.equal(result.compactions, 0);
});

test('registered operations read a fresh raw file and render its group measurements', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [
      { step: 'Compute group summaries', kind: 'table' },
      { step: 'Draw the comparison', kind: 'bar' }
    ] }));
    if (turn === 2) return response(call('aggregate', { artifact: 'fresh.tsv', group_by: 'category', column: 'value', metrics: ['mean'], node: 1 }));
    if (turn === 3) {
      assert.match(transcript(request), /1\. \[done\]/);
      return response(call('chart', { artifact: 'a1', type: 'bar', x: 'category', y: 'mean', node: 2 }));
    }
    assert.match(transcript(request), /2\. \[done\]/);
    return response(call('finish', { summary: 'Category A averages 3 and B averages 8 (a1). The comparison is shown in a2.' }));
  }, null, { entry: { file: 'fresh.tsv', key: 'stream', columns: ['category', 'value'] }, rawFile: true });
  const raw = 'category\tvalue\nA\t2\nA\t4\nB\t8\n';
  await fs.writeFile(path.join(f.directory, 'fresh.tsv'), raw);
  const result = await f.run();
  assert.equal(result.outcome, 'completed', result.error);
  const table = JSON.parse(await fs.readFile(result.artifacts[0].storage_uri, 'utf8'));
  assert.deepEqual(table.rows, [{ category: 'A', mean: 3 }, { category: 'B', mean: 8 }]);
  assert.deepEqual(result.plan[1].artifacts, ['a2']);
  assert.equal(await fs.readFile(path.join(f.directory, 'fresh.tsv'), 'utf8'), raw);
});

test('valid consecutive plan and note edits do not trigger an inactivity stop', async t => {
  const f = await fixture(t, ({ turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Finish', kind: 'summary' }] }));
    if (turn < 5) return response(call('note', { text: `Decision ${turn}`, ...(turn > 2 ? { replace: 1 } : {}) }));
    return response(call('finish', { summary: 'The scope is resolved.' }));
  });
  const result = await f.run();
  assert.equal(result.outcome, 'completed'); assert.equal(result.turns, 5);
});

test('both shared agents dispatch directly, with no custom executor or automatic review calls', async t => {
  const dispatched = [];
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [
      { step: 'Find the gene set', kind: 'gene_set' },
      { step: 'Interpret a source for a gene', kind: 'interpretation' }
    ] }));
    const offered = request.tools.map(t => t.function.name);
    assert.ok(offered.includes('deep_research_hpa'));
    assert.ok(offered.includes('investigator_hpa'));
    assert.ok(!offered.includes('sql'));
    assert.ok(!offered.includes('review'));
    if (turn === 2) return response(call('deep_research_hpa', { goal: 'Find the requested gene set', node: 1 }));
    if (turn === 3) return response(call('investigator_hpa', { gene: 'ENSG00000000001', question: 'Interpret its source measurement', node: 2 }));
    if (turn === 4) return response(call('open', { what: 'a2', columns: ['table', 'cited_row'] }));
    assert.equal(turn, 5, 'Finishing must not trigger a hidden reviewer inference');
    assert.match(transcript(request), /source.tsv/);
    return response(call('finish', { summary: 'The source interpretation is saved in a2.' }));
  }, async (name, args, context) => {
    dispatched.push({ name, args });
    assert.equal(args.mode, 'offline');
    assert.equal(context.includeRows, true);
    if (name === 'deep_research_hpa') return { result: { status: 'ok', result: { rows: [{ Gene: 'EXAMPLE', Ensembl: 'ENSG00000000001' }] } } };
    assert.equal(name, 'investigator_hpa');
    return { result: { found: true, gene: 'EXAMPLE', ensembl: args.gene, answer: 'The raw measurement is available.', extracted_value: 13.5, exact_label: 'source entity', source_section: 'source.tsv', cited_row: { Gene: args.gene, value: '13.5' } } };
  });
  const result = await f.run();
  assert.equal(result.outcome, 'completed', result.error);
  assert.deepEqual(dispatched.map(d => d.name), ['deep_research_hpa', 'investigator_hpa']);
  assert.equal(f.requests.length, result.turns);
  assert.equal(f.events.filter(e => e.stage === 'review').length, 0);
  assert.equal(result.artifacts.length, 2);
  const answer = JSON.parse(await fs.readFile(result.artifacts[1].storage_uri, 'utf8'));
  assert.equal(answer.rows[0].table, 'source.tsv');
  assert.equal(answer.rows[0].cited_row.value, '13.5');
});

test('independent native reads overlap and keep each response attached to the right call', async t => {
  let active = 0, peak = 0;
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Inspect the source', kind: 'summary' }] }));
    if (turn === 2) return response(
      call('open', { what: 'mapping.tsv', columns: ['name'], rows: 2 }),
      call('open', { what: 'mapping.tsv', columns: ['value'], rows: 2 })
    );
    const replies = request.messages.filter(m => m.role === 'tool').slice(-2).map(m => JSON.parse(m.content).observations);
    assert.match(replies[0], /label 0/);
    assert.doesNotMatch(replies[1], /label 0/);
    assert.match(replies[1], /\[\[0\],\[1\]\]/);
    return response(call('finish', { summary: 'Both projections were inspected.' }));
  }, null, { async onRead() {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
  } });
  assert.equal((await f.run()).outcome, 'completed');
  assert.equal(peak, 2);
});

test('schema about excludes unrelated headers while preserving exact source field names', async t => {
  const entry = { file: 'mapping.tsv', key: 'lookup', columns: ['name', 'value', 'unrelated_metadata'] };
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Inspect the measurement', kind: 'summary' }] }));
    if (turn === 2) return response(call('schema', { what: 'mapping.tsv', about: 'value' }));
    const reply = JSON.parse(request.messages.filter(m => m.role === 'tool').at(-1).content).observations;
    assert.match(reply, /3 total columns; 1 matching/);
    assert.match(reply, /Columns: \["value"\]/);
    assert.doesNotMatch(reply, /unrelated_metadata/);
    return response(call('finish', { summary: 'The measurement field is known.' }));
  }, null, { entry });
  assert.equal((await f.run()).outcome, 'completed');
});

test('skip alongside an inspection waits for the agent instead of polling the model again', async t => {
  const f = await fixture(t, ({ request, turn }) => {
    if (turn === 1) return response(call('set_plan', { items: [{ step: 'Find evidence', kind: 'gene_set' }] }));
    if (turn === 2) return response(
      call('deep_research_hpa', { goal: 'Find TEST', node: 1 }),
      call('schema', { what: 'mapping.tsv' }),
      call('skip', { reason: 'The source schema is known; the next work needs the agent result' })
    );
    assert.equal(turn, 3);
    assert.match(transcript(request), /TEST/);
    assert.match(transcript(request), /returned a1/);
    return response(call('finish', { summary: 'TEST is in the returned set (a1).' }));
  }, async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { result: { status: 'ok', result: { rows: [{ Gene: 'TEST' }] } } };
  });
  assert.equal((await f.run()).outcome, 'completed');
  assert.equal(f.requests.length, 3);
});
