'use strict';

/**
 * Investigator: a question in, the raw rows that answer it out. With a list of points (one or
 * hundreds; the database's entities, or any values such as tissues or categories) it returns
 * every point with the fields asked for; without a list it returns every row a filter selects.
 * The agent knows nothing about the database: the adapter names it, lists its tables and reads
 * them. The model names tables, columns and filters; it never carries values. It sees a table's
 * column names, asks for the values of a column when it needs a spelling, and never a whole table.
 */

const { inference } = require('../../inference/gateway');
const { platformConfig } = require('../../policy/config');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');
const { validate } = require('../aso/batchOperations');
const { decodeArguments } = require('../aso/toolArguments');
const { FILTER_OPS } = require('../aso/studyTools');
const { fetchRows, fetchMatching, fetchAll } = require('../aso/fetchRows');
const { tableCard, columnLine, namedColumns, resultLine, historyText, argsLine, section, count } = require('../aso/desk');
const { AgentStop, createAgentControl, fingerprint } = require('../aso/agentControl');

const S = { type: 'string' };
const WHERE = { type: 'array', description: 'Row filters; every clause must hold. A unary op takes column and op only.', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: FILTER_OPS }, value: { description: 'Comparison value, or a list for in' } }, required: ['column', 'op'] } };
const tool = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

function tools(db) {
  return [
    tool('find_tables', 'Tables whose name, title, description or a column contains the word, with their columns.', { about: S }, ['about']),
    tool('open', 'Put a table on the desk: what it is and its first column names.', { table: S }, ['table']),
    tool('columns', 'The columns of a table whose name contains the word.', { table: S, about: S }, ['table', 'about']),
    tool('values', 'The values a column of a table takes (every value of a category column, the range of a number column), spelled as the data spells them.', { table: S, column: S }, ['table', 'column']),
    tool('fetch', `Retrieve rows from one table. With the list: one row per source row for each point, with the point, the fields, source_rows and source_status; the points are ${db.entity}s unless match names the column their values are in. Without the list: every row where holds. Omit fields for every column.`, { title: S, description: S, table: S, fields: { type: 'array', items: S }, where: WHERE, match: { type: 'string', description: 'Column whose values the points are' } }, ['title', 'description', 'table']),
    tool('finish', 'Return the results that answer the question, by title. note states what no table holds and which points did not resolve.', { results: { type: 'array', items: S }, note: S }, ['results'])
  ];
}

function systemPrompt(db, catalog) {
  const listed = catalog.filter(e => e.key !== 'unreadable').map(e => e.file);
  return `You are the Investigator in a study over the ${db.database}. You are given a question, with or without a list of points, and the tables of the database; the tools hold the list. You find the table whose columns hold what the question asks and fetch those fields, returning raw rows; the study computes, ranks and summarises with its own operations.

The desk in the message is everything you have opened and fetched so far, and stays in front of you every turn.

How it goes:
- open a table: its card names its first columns; columns finds the rest by a word. values shows what one column holds, so fields and filter values are spelled as the data spells them. find_tables narrows the list below by a word.
- fetch once per table with every field the question needs from it, and a where filter when the question names particular rows. With a list, the points are ${db.entity}s read by their keys, or the values of the column named by match. Each result has a title and a description a reader understands. The result keeps repeated rows, zeros, blanks and ties as recorded; a point with no matching row gets one row with empty fields and a source_status saying why. A question that spans several tables is answered by a fetch from each.
- finish names the results that answer the question. The fetched rows are the evidence and a result's title is its citation. The note states what no table holds and which points did not resolve.

TABLES (${listed.length}; find_tables narrows them by a word, open one for its columns)
${listed.join(', ')}`;
}

async function investigatorBulk(args, ctx = {}, adapter = require('../../hpa/geneDataAdapter')) {
  const { question, mode = 'offline' } = args;
  const points = args.points ?? args.genes ?? null;
  const started = Date.now();
  const stats = { prompt: 0, completion: 0, total: 0, calls: 0 };
  const results = new Map();
  const opened = new Map();
  const history = [];
  const { onStep } = ctx;
  const emit = (stage, label, message) => onStep?.({ stage, label, message });
  let release = null, resolved = [], db = null;
  const unresolvedPoints = () => (points || []).filter((_, i) => !resolved[i]);
  try {
    if (points !== null && (!Array.isArray(points) || points.some(p => typeof p !== 'string' || !p.trim()))) throw new Error('Investigator points must be an array of names');
    if (typeof question !== 'string' || !question.trim()) throw new Error('Investigator requires a question');
    const control = createAgentControl({ ctx, stats: { get totalTokens() { return stats.total; } }, agentKey: 'investigator_hpa' });
    await control.checkpoint('Resolve sources');
    release = await resolveAgentMode(mode, [FILES.master]);
    if (release.mode !== 'offline') throw new Error('Investigator requires the local release');
    db = adapter.identity();
    const keys = { entity: db.entity, columns: db.keys };
    const listed = points && points.length ? points : [];
    resolved = listed.length ? await adapter.resolveGenes(listed) : [];
    const identities = new Map();
    for (const gene of resolved) if (gene && !identities.has(gene.ensembl)) identities.set(gene.ensembl, gene);
    const catalog = await adapter.catalog();
    const system = systemPrompt(db, catalog);
    const offered = tools(db);
    const maxTurns = ctx.maxTurns || platformConfig().asoMaxSteps;
    await emit('start', 'Investigator', `${listed.length ? `${listed.length} points supplied, ${identities.size} resolve as ${db.entity}s` : 'No list'}. Question: ${question}`);

    const findTables = about => {
      const word = String(about || '').trim().toLowerCase();
      const hits = catalog.filter(e => e.key !== 'unreadable' && (!word || e.file.toLowerCase().includes(word) || String(e.title || '').toLowerCase().includes(word) || String(e.description || '').toLowerCase().includes(word) || e.columns.some(c => c.toLowerCase().includes(word))));
      if (!hits.length) return `no table has "${about}" in its name, title, description or columns`;
      return hits.map(e => `${e.file} — ${e.title || e.file} [${adapter.access(e)}]: ${e.columns.length > 24 ? `${e.columns.slice(0, 24).join(', ')} … (${e.columns.length} columns)` : e.columns.join(', ')}`).join('\n');
    };
    const openTable = async name => {
      const entry = await adapter.entry(String(name || '').trim());
      if (!entry || entry.key === 'unreadable') throw new Error(`no table named ${JSON.stringify(name)}${entry?.why ? `: ${entry.why}` : ''}; find_tables lists the tables`);
      if (!opened.has(entry.file)) opened.set(entry.file, { entry, asked: [], profile: null });
      return opened.get(entry.file);
    };
    // The values of one column, from the table's profile, read once per table.
    const columnValues = async (name, column) => {
      const o = await openTable(name);
      const found = o.entry.columns.find(c => c === column) || o.entry.columns.find(c => c.toLowerCase() === String(column).toLowerCase());
      if (!found) throw new Error(`${o.entry.file} has no column ${JSON.stringify(column)}; its columns: ${namedColumns(o.entry.columns)}`);
      if (!o.profile) o.profile = await adapter.profile(o.entry);
      if (!o.asked.includes(found)) o.asked.push(found);
      const c = o.profile.columns.find(p => p.column === found);
      return c ? columnLine(c) : `${found}: no values recorded`;
    };
    const desk = turn => {
      const list = listed.length
        ? `${count(listed.length)} points supplied${identities.size ? `, ${count(identities.size)} resolve as ${db.entity}s in the release` : `; none is a ${db.entity} of the release, so fetch matches them against a column (match)`}${unresolvedPoints().length && identities.size ? `; not ${db.entity}s of the release: ${unresolvedPoints().slice(0, 12).join(', ')}${unresolvedPoints().length > 12 ? ` (+${unresolvedPoints().length - 12})` : ''}` : ''}. First points: ${listed.slice(0, 8).join(', ')}${listed.length > 8 ? ', …' : ''}.`
        : 'No list: the question selects rows by a filter.';
      const cards = [...opened.values()].map(o => tableCard({ name: o.entry.file, title: o.entry.title, description: o.entry.description, access: adapter.access(o.entry), columns: o.entry.columns, profile: o.profile?.columns, scanned: o.profile?.rows, capped: o.profile?.capped, focus: o.asked, whole: false }));
      const lines = [...results.values()].map(t => resultLine({ id: t.title, description: t.description, rows: t.rows, columns: t.columns, origin: `fetch ${argsLine(t.args, 140)}` }));
      return [
        section('QUESTION', question),
        section('LIST', list),
        section('OPENED', cards.join('\n') || '(no table opened yet)'),
        section('RESULTS', lines.join('\n') || '(none yet)'),
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
          // The same fetch under another title is the same fetch.
          const { title: _title, description: _description, ...bareArgs } = args;
          const key = fingerprint({ name, args: bareArgs });
          if (name !== 'finish' && done.has(key)) { history.push(`turn ${turn}: ${name}(${argsLine(bareArgs)}) repeated; ${done.get(key)}`); continue; }
          if (name === 'find_tables') {
            const text = findTables(args.about);
            history.push(`turn ${turn}: find_tables "${args.about}" →\n${text.split('\n').map(l => `    ${l}`).join('\n')}`);
            done.set(key, 'listed above'); progressed = true;
          } else if (name === 'open') {
            const o = await openTable(args.table);
            history.push(`turn ${turn}: opened ${o.entry.file} (on the desk)`);
            done.set(key, 'already on the desk'); progressed = true;
            await emit('execution_step', 'Opened', `${o.entry.file}: ${o.entry.columns.length} columns`);
          } else if (name === 'columns') {
            const o = await openTable(args.table);
            const word = String(args.about || '').trim().toLowerCase();
            const hits = o.entry.columns.filter(c => c.toLowerCase().includes(word));
            history.push(`turn ${turn}: columns of ${o.entry.file} about "${args.about}": ${hits.length ? hits.join(' | ') : `none of its ${o.entry.columns.length} columns`}`);
            done.set(key, 'listed above'); progressed = true;
          } else if (name === 'values') {
            const line = await columnValues(args.table, args.column);
            history.push(`turn ${turn}: values of ${args.table} ${args.column} (on its card)`);
            done.set(key, 'on the table card'); progressed = true;
            await emit('execution_step', 'Values', line.slice(0, 200));
          } else if (name === 'fetch') {
            const title = String(args.title || '').trim();
            const description = String(args.description || '').trim();
            if (!title || !description) throw new Error('fetch needs a title and a description for its result');
            if (results.has(title)) throw new Error(`a result titled ${JSON.stringify(title)} exists; choose another title`);
            const entry = await adapter.entry(String(args.table || '').trim());
            if (!entry) throw new Error(`no table named ${JSON.stringify(args.table)}; find_tables lists the tables`);
            await openTable(entry.file);
            const filter = args.where?.length ? ` where ${args.where.map(w => `${w.column} ${w.op} ${w.value ?? ''}`).join(' and ')}` : '';
            await emit('execution_step', 'Fetch', `${entry.file}${args.fields?.length ? ` fields ${args.fields.join(', ')}` : ''}${filter}${listed.length ? ` for ${count(listed.length)} points` : ''}`);
            let fetched;
            if (!listed.length) fetched = await fetchAll({ adapter, entry, fields: args.fields, where: args.where, keys });
            else if (args.match) fetched = await fetchMatching({ adapter, entry, points: listed, fields: args.fields, where: args.where, match: args.match, keys });
            else if (identities.size) fetched = await fetchRows({ adapter, entry, supplied: listed, resolved, fields: args.fields, where: args.where, keys });
            else throw new Error(`none of the points is a ${db.entity} of the release; name the column their values are in with match`);
            const table = { name: title, title, description, rows: fetched.rows, columns: fetched.columns, args: { table: entry.file, fields: fetched.fields, ...(args.where?.length ? { where: args.where } : {}), ...(fetched.match ? { match: fetched.match } : {}) }, coverage: fetched.coverage, source_file: entry.file };
            results.set(title, table);
            const c = fetched.coverage;
            const summary = listed.length
              ? `${c.with_rows} points with rows${c.no_match ? `, ${c.no_match} with no row matching the filter` : ''}${c.no_rows ? `, ${c.no_rows} with no row in the table` : ''}${c.not_in_release ? `, ${c.not_in_release} not in the release` : ''}`
              : `${count(c.rows)} of ${count(c.scanned)} rows selected`;
            history.push(`turn ${turn}: fetch → "${title}" (${count(table.rows.length)} rows; ${summary})`);
            done.set(key, `it made "${title}"`); progressed = true;
            await emit('selection_step', 'Result', `${title}: ${count(table.rows.length)} rows`);
          } else {
            const names = [...new Set((args.results || []).map(String))];
            const unknown = names.filter(n => !results.has(n));
            if (unknown.length) throw new Error(`no result titled ${unknown.join(', ')}; results so far: ${[...results.keys()].join(', ') || 'none'}`);
            if (!names.length && !String(args.note || '').trim()) throw new Error('finish needs result titles, or a note saying what no table holds');
            const tables = names.map(n => results.get(n));
            const note = String(args.note || '').trim();
            await emit('complete', 'Investigator done', `${tables.length} result${tables.length === 1 ? '' : 's'}: ${names.join(', ')}${note ? `. ${note}` : ''}`);
            return { bulk: true, found: tables.length > 0, status: 'ok', tables, retained: [...results.values()].filter(t => !names.includes(t.name)), note, unresolved: unresolvedPoints(), opened: [...opened.keys()], mode: 'offline', hpa_version: release.hpaVersion, tokens: { total: { prompt: stats.prompt, completion: stats.completion, total: stats.total } }, calls: stats.calls, turns: turn, seconds: (Date.now() - started) / 1000 };
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
    return { bulk: true, found: results.size > 0, status: 'partial', ...stop, error: error.message, tables: [...results.values()], retained: [], note: `Investigator stopped before finishing: ${error.message}`, unresolved: unresolvedPoints(), opened: [...opened.keys()], mode: 'offline', hpa_version: release?.hpaVersion || null, tokens: { total: { prompt: stats.prompt, completion: stats.completion, total: stats.total } }, calls: stats.calls, seconds: (Date.now() - started) / 1000 };
  }
}

module.exports = investigatorBulk;
