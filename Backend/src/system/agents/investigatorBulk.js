'use strict';

/**
 * Investigator, bulk form: a question about a supplied list of entities in, the raw records that
 * answer it out. The agent knows nothing about the database: the adapter names it, lists its
 * tables and reads them. The model has four tools (find_tables, open, fetch, finish) and a desk
 * that keeps everything it has opened or fetched in front of it every turn. Values are read by
 * code; the model only ever names tables, fields and filters.
 */

const { inference } = require('../../inference/gateway');
const { platformConfig } = require('../../policy/config');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');
const { validate } = require('../aso/batchOperations');
const { decodeArguments } = require('../aso/toolArguments');
const { FILTER_OPS } = require('../aso/studyTools');
const { fetchRows } = require('../aso/fetchRows');
const { tableCard, resultCard, historyText, argsLine, section, count } = require('../aso/desk');
const { AgentStop, createAgentControl, fingerprint } = require('../aso/agentControl');

const S = { type: 'string' };
const WHERE = { type: 'array', description: 'Row filters; every clause must hold. Unary is_missing/is_present/is_numeric/is_non_numeric take column and op only.', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: FILTER_OPS }, value: { description: 'Comparison value, or a list for in; omit for unary predicates' } }, required: ['column', 'op'] } };
const tool = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

function tools(db) {
  return [
    tool('find_tables', 'Tables whose name, title, description or a column contains the word, with their columns.', { about: S }, ['about']),
    tool('open', 'Put a table on the desk: its columns, the values each column takes and sample rows. Open a table before fetching from it.', { table: S }, ['table']),
    tool('fetch', `Retrieve fields from one table for the whole supplied list: one row per matching source row with the ${db.entity} keys, the fields, source_rows and source_status. Omit fields for every column. where selects source rows.`, { name: { type: 'string', description: 'Short name for the result' }, table: S, fields: { type: 'array', items: S }, where: WHERE }, ['name', 'table']),
    tool('finish', 'Return the results that answer the question. note only states a limitation (a field no table holds, unresolved names); it never carries values.', { results: { type: 'array', items: S }, note: S }, ['results'])
  ];
}

function systemPrompt(db, catalog) {
  const listed = catalog.filter(e => e.key !== 'unreadable').map(e => `${e.file} — ${e.title || e.file}`);
  return `You are the Investigator in a study over the ${db.database}. You are given a question about a supplied list of ${db.entity}s and the tables of the database; the tools hold the list. You find the table whose columns hold what the question asks and fetch those fields for the whole list, returning raw records; the study computes, ranks and summarises with its own operations.

The desk in the message is everything you have opened and fetched so far, and stays in front of you every turn.

How it goes:
- open a table: its card shows the columns, the values each column takes and sample rows, so fields and filter values are spelled as the data spells them. find_tables narrows the list below by a word.
- fetch once per table with every field the question needs from it, and a where filter when the question names particular rows. The result keeps repeated rows, zeros, blanks and ties as recorded; a ${db.entity} with no matching row gets one row with empty fields and a source_status saying why. A question that spans several tables is answered by a fetch from each.
- finish names the results that answer the question. The fetched rows are the evidence and a result name is its citation. The note states what no table holds and which names did not resolve.

TABLES (${listed.length}; open one for its columns and values)
${listed.join('\n')}`;
}

async function investigatorBulk({ genes, question, mode = 'offline' }, ctx = {}, adapter = require('../../hpa/geneDataAdapter')) {
  const started = Date.now();
  const stats = { prompt: 0, completion: 0, total: 0, calls: 0 };
  const results = new Map();
  const opened = new Map();
  const history = [];
  const { onStep } = ctx;
  const emit = (stage, label, message) => onStep?.({ stage, label, message });
  let release = null, resolved = [], db = null;
  try {
    if (!Array.isArray(genes) || !genes.length || genes.some(gene => typeof gene !== 'string' || !gene.trim())) throw new Error('Bulk Investigator requires a nonempty array of names');
    if (typeof question !== 'string' || !question.trim()) throw new Error('Bulk Investigator requires a question');
    const control = createAgentControl({ ctx, stats: { get totalTokens() { return stats.total; } }, agentKey: 'investigator_hpa' });
    await control.checkpoint('Resolve sources');
    release = await resolveAgentMode(mode, [FILES.master]);
    if (release.mode !== 'offline') throw new Error('Bulk Investigator requires the local release');
    db = adapter.identity();
    const keys = { entity: db.entity, columns: db.keys };
    resolved = await adapter.resolveGenes(genes);
    const unresolved = genes.filter((_, i) => !resolved[i]);
    const identities = new Map();
    for (const gene of resolved) if (gene && !identities.has(gene.ensembl)) identities.set(gene.ensembl, gene);
    const catalog = await adapter.catalog();
    const system = systemPrompt(db, catalog);
    const offered = tools(db);
    const maxTurns = ctx.maxTurns || platformConfig().asoMaxSteps;
    await emit('start', 'Investigator', `${genes.length} ${db.entity}s supplied, ${identities.size} resolved${unresolved.length ? `, ${unresolved.length} not in the release` : ''}. Question: ${question}`);

    const findTables = about => {
      const word = String(about || '').trim().toLowerCase();
      const hits = catalog.filter(e => e.key !== 'unreadable' && (!word || e.file.toLowerCase().includes(word) || String(e.title || '').toLowerCase().includes(word) || String(e.description || '').toLowerCase().includes(word) || e.columns.some(c => c.toLowerCase().includes(word))));
      if (!hits.length) return `no table has "${about}" in its name, title, description or columns`;
      return hits.map(e => `${e.file} — ${e.title || e.file} [${adapter.access(e)}]: ${e.columns.length > 24 ? `${e.columns.slice(0, 24).join(', ')} … (${e.columns.length} columns)` : e.columns.join(', ')}`).join('\n');
    };
    const openTable = async name => {
      const entry = await adapter.entry(String(name || '').trim());
      if (!entry || entry.key === 'unreadable') throw new Error(`no table named ${JSON.stringify(name)}${entry?.why ? `: ${entry.why}` : ''}; find_tables lists the tables`);
      if (opened.has(entry.file)) return opened.get(entry.file);
      const [profiled, sample] = await Promise.all([adapter.profile(entry), adapter.sample(entry, 3)]);
      const card = tableCard({ name: entry.file, title: entry.title, description: entry.description, access: adapter.access(entry), columns: entry.columns, profile: profiled.columns, sample, scanned: profiled.rows, capped: profiled.capped });
      opened.set(entry.file, { entry, card });
      return opened.get(entry.file);
    };
    const desk = turn => {
      const list = `${count(genes.length)} ${db.entity}s supplied, ${count(identities.size)} resolved in the release${unresolved.length ? `; not in the release: ${unresolved.slice(0, 12).join(', ')}${unresolved.length > 12 ? ` (+${unresolved.length - 12})` : ''}` : ''}. First names: ${[...identities.values()].slice(0, 8).map(g => g.gene).join(', ')}${identities.size > 8 ? ', …' : ''}.`;
      const cards = [...results.values()].map(t => resultCard({ id: t.name, origin: `fetch ${argsLine(t.args, 160)}`, rows: t.rows, columns: t.columns }));
      return [
        section('QUESTION', question),
        section('LIST', list),
        section('OPENED', [...opened.values()].map(o => o.card).join('\n') || '(no table opened yet)'),
        section('RESULTS', cards.join('\n') || '(none yet)'),
        section('HISTORY', historyText(history)),
        `TURN ${turn}/${maxTurns}`
      ].join('\n\n');
    };

    const done = new Map();   // fingerprint of a completed call → its outcome line
    let idle = 0;
    for (let turn = 1; turn <= maxTurns; turn++) {
      await control.checkpoint('Investigator decision', true);
      const request = { messages: [{ role: 'system', content: system }, { role: 'user', content: desk(turn) }], tools: offered, temperature: 0, prompt_cache: { key: `investigator ${ctx.cacheKey || question}` }, ...(ctx.reasoningEffort ? { reasoning_effort: ctx.reasoningEffort } : {}) };
      const response = await inference.chat.completions.create(request);
      stats.calls++;
      const usage = response.usage || {};
      stats.prompt += usage.prompt_tokens || 0; stats.completion += usage.completion_tokens || 0; stats.total = stats.prompt + stats.completion;
      await control.checkpoint('Investigator decision: returned');
      const calls = response.choices?.[0]?.message?.tool_calls || [];
      if (!calls.length) {
        history.push(`turn ${turn}: no tool called`);
        if (++idle > 1) throw new AgentStop('no_progress', 'Investigator stopped calling tools');
        continue;
      }
      let progressed = false;
      for (const call of calls) {
        await control.checkpoint('Investigator tool');
        const name = call.function?.name;
        let args;
        try {
          const spec = offered.find(t => t.function.name === name);
          if (!spec) throw new Error(`no tool ${name}`);
          args = decodeArguments(JSON.parse(call.function.arguments || '{}'), spec.function.parameters, name);
          validate(args, spec.function.parameters, name);
          const key = fingerprint({ name, args });
          if (name !== 'finish' && done.has(key)) { history.push(`turn ${turn}: ${name}(${argsLine(args)}) repeated; ${done.get(key)}`); continue; }
          if (name === 'find_tables') {
            const text = findTables(args.about);
            history.push(`turn ${turn}: find_tables "${args.about}" →\n${text.split('\n').map(l => `    ${l}`).join('\n')}`);
            done.set(key, 'listed above'); progressed = true;
          } else if (name === 'open') {
            const o = await openTable(args.table);
            history.push(`turn ${turn}: opened ${o.entry.file} (on the desk)`);
            done.set(key, 'already on the desk'); progressed = true;
            await emit('execution_step', 'Opened', `${o.entry.file}: ${o.entry.columns.length} columns`);
          } else if (name === 'fetch') {
            const resultName = String(args.name || '').trim();
            if (!resultName) throw new Error('fetch needs a name for its result');
            if (results.has(resultName)) throw new Error(`a result named ${resultName} exists; choose another name`);
            const entry = await adapter.entry(String(args.table || '').trim());
            if (!entry) throw new Error(`no table named ${JSON.stringify(args.table)}; find_tables lists the tables`);
            if (!opened.has(entry.file)) await openTable(entry.file);
            await emit('execution_step', 'Fetch', `${entry.file}${args.fields?.length ? ` fields ${args.fields.join(', ')}` : ''}${args.where?.length ? ` where ${args.where.map(w => `${w.column} ${w.op} ${w.value ?? ''}`).join(' and ')}` : ''} for ${count(identities.size)} ${db.entity}s`);
            const fetched = await fetchRows({ adapter, entry, supplied: genes, resolved, fields: args.fields, where: args.where, keys });
            const table = { name: resultName, rows: fetched.rows, columns: fetched.columns, args: { table: entry.file, fields: fetched.fields, ...(args.where?.length ? { where: args.where } : {}) }, coverage: fetched.coverage, source_file: entry.file };
            results.set(resultName, table);
            const c = fetched.coverage;
            history.push(`turn ${turn}: fetch → ${resultName} (${count(table.rows.length)} rows; ${c.with_rows} ${db.entity}s with rows${c.no_match ? `, ${c.no_match} with no row matching the filter` : ''}${c.no_rows ? `, ${c.no_rows} with no row in the table` : ''}${c.not_in_release ? `, ${c.not_in_release} not in the release` : ''})`);
            done.set(key, `it made ${resultName}`); progressed = true;
            await emit('selection_step', 'Result', `${resultName}: ${count(c.rows)} rows for ${c.with_rows}/${c.entities} ${db.entity}s`);
          } else {
            const names = [...new Set((args.results || []).map(String))];
            const unknown = names.filter(n => !results.has(n));
            if (unknown.length) throw new Error(`no result named ${unknown.join(', ')}; results so far: ${[...results.keys()].join(', ') || 'none'}`);
            if (!names.length && !String(args.note || '').trim()) throw new Error('finish needs result names, or a note saying what no table holds');
            const tables = names.map(n => results.get(n));
            const note = String(args.note || '').trim();
            await emit('complete', 'Investigator done', `${tables.length} result${tables.length === 1 ? '' : 's'}: ${names.join(', ')}${note ? `. ${note}` : ''}`);
            return { bulk: true, found: tables.length > 0, status: 'ok', tables, retained: [...results.values()].filter(t => !names.includes(t.name)), note, unresolved, opened: [...opened.keys()], mode: 'offline', hpa_version: release.hpaVersion, tokens: { total: { prompt: stats.prompt, completion: stats.completion, total: stats.total } }, calls: stats.calls, turns: turn, seconds: (Date.now() - started) / 1000 };
          }
        } catch (error) {
          if (error instanceof AgentStop) throw error;
          history.push(`turn ${turn}: ${name || 'call'}(${argsLine(args || {})}) failed: ${error.message}`);
          await emit('reasoning_step', 'Correction needed', error.message);
        }
      }
      idle = progressed ? 0 : idle + 1;
      if (idle > 1) throw new AgentStop('no_progress', 'Investigator repeated itself without new evidence');
    }
    throw new AgentStop('turn_budget_exhausted', `Investigator used its ${maxTurns} turns without finishing`);
  } catch (error) {
    await emit('error', 'Investigator', error.message);
    const stop = error instanceof AgentStop ? { stop_reason: error.reason, incomplete: true } : {};
    return { bulk: true, found: results.size > 0, status: 'partial', ...stop, error: error.message, tables: [...results.values()], retained: [], note: `Investigator stopped before finishing: ${error.message}`, unresolved: genes.filter((_, i) => !resolved[i]), opened: [...opened.keys()], mode: 'offline', hpa_version: release?.hpaVersion || null, tokens: { total: { prompt: stats.prompt, completion: stats.completion, total: stats.total } }, calls: stats.calls, seconds: (Date.now() - started) / 1000 };
  }
}

module.exports = investigatorBulk;
