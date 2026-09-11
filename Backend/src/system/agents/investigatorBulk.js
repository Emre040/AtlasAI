'use strict';

/**
 * Investigator: a question about points in, a mapping out. The points are the database's
 * entities or any values (one, or thousands); the question names one field in one context. The
 * agent knows nothing about the database: it searches the whole release for where the question's
 * words and the points live (the catalogue of tables, column names, every column's recorded
 * values, and the text of big columns), reads rows from one origin for the points, and returns
 * them as the mapping it made, with its reasoning. Every call it makes is small: it sees a few
 * candidate lines and a few lines of history, never a table.
 *
 * A question that asks for several fields, or one field in several contexts, is rejected before
 * anything is read: one origin per run, and the study asks again, one context at a time.
 */

const { inference } = require('../../inference/gateway');
const { jsonCall } = require('../../inference/jsonCall');
const { platformConfig } = require('../../policy/config');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');
const { validate } = require('../aso/batchOperations');
const { decodeArguments } = require('../aso/toolArguments');
const { FILTER_OPS, correctSpelling, nearMisses, inList } = require('../aso/studyTools');
const { fetchRows, fetchMatching, fetchAll } = require('../aso/fetchRows');
const { historyText, argsLine, section, count, namedColumns, sampleLines } = require('../aso/desk');
const { AgentStop, createAgentControl, fingerprint } = require('../aso/agentControl');

const S = { type: 'string' };
const WHERE = { type: 'array', description: 'Row filters; every clause must hold. A unary op takes column and op only.', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: FILTER_OPS }, value: { description: 'Comparison value, or a list for in' } }, required: ['column', 'op'] } };
const tool = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const SEARCH_HITS = 10;      // entries a line of the entity or text-scan kind shows
const SEARCHES_SHOWN = 3;    // searches kept on the desk
const HISTORY_SHOWN = 8;     // history lines kept on the desk
const RESULT_ROWS_SHOWN = 3; // first rows of each result shown on the desk; the rest are counted

function tools(db) {
  const where = { type: 'array', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: FILTER_OPS }, value: {} }, required: ['column', 'op'] } };
  return [
    tool('search', 'Where words live in the release: tables by name or description, columns by name, recorded values with row counts. The field asked, the context named, or a point that is not a gene; one word or several.', { words: { type: 'array', items: S } }, ['words']),
    tool('fetch', `Rows of one table for the points: the fields asked (every column when omitted), where clauses that must all hold, match = the column the points are values of (the other side of a pair table comes back as other). Points that are ${db.entity}s need no match. from + column: the values of a column of an earlier result are the points.`, { title: S, table: S, fields: { type: 'array', items: S }, where, from: S, column: S, match: { type: 'array', items: S, description: 'the column the points are values of; two columns for a pair table' } }, ['table']),
    tool('finish', 'Done: the results that answer the question, the mapping (field → table, column of the result) and a note: what was chosen over what, what no table holds, which points did not resolve.', { results: { type: 'array', items: S, description: 'titles of the results, as listed under RESULTS' }, mapping: { type: 'array', items: { type: 'object', properties: { field: S, table: S, column: S }, required: ['field', 'table', 'column'] } }, note: S }, ['results'])
  ];
}

function systemPrompt(db) {
  return `You are the Investigator in a study over the ${db.database}: given a question about a list of points (the tools hold the list), you return the rows that answer it, from one table, with the mapping you made.
- search says where words live. Search the field asked and the context named, with specific words; a point that is a ${db.entity} is read by the list, not searched.
- fetch reads the rows: the table found, the fields asked (every column when the field's name is not known), a where for the context, spelled as the search shows. What one table lists and another measures is two fetches, the second taking its points from the first (from, column).
- finish as soon as a result holds rows for the points with the field asked: the results, the mapping (field → table, column of the result), a note on what was chosen over what, what no table holds, which points did not resolve. The rows are the evidence; the study computes with them.
Never fetch a whole table to look at it; the search says what is there.`;
}

const GATE_SYSTEM = `You check a question put to a data agent before it runs. The agent answers one question per run: one kind of data, in one context, for a list of points. Reply with JSON: {"accepted": true|false, "reason": "<one sentence>"}. Reject only a question that asks for several at once: several contexts of one kind (two tissues, two cell types, two cohorts), or two different measurements (an RNA expression and a protein location), naming them so they can be asked one at a time. Accept everything else: what is said about the same points in one context, however many columns (a category with its value, a level with its reliability, an association with its p-value, both sides of a pair), a list of points of any size, a filter, and a question that names no context or says any or all. Where the data is kept is not your concern.`;

const flat = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// A recorded value holds a word when either contains the other, the shorter being a word's length.
const holdsWord = (value, needle) => { const f = flat(value); return f.includes(needle) || (f.length >= 4 && needle.includes(f)); };

// The columns of a table whose recorded values are spelled like the database's entity ids.
async function idColumns(adapter, e) {
  if (typeof adapter.isEntityId !== 'function') return [];
  const profile = await adapter.profile(e).catch(() => null);
  return (profile?.columns || []).filter(c => [...(c.observed_values || []), ...(c.full_examples || []), ...(c.examples || [])].some(v => adapter.isEntityId(v))).map(c => c.column);
}

// The recorded spellings of points in a column that has no vocabulary, asked of the source once
// per column and remembered for the run.
async function recordedSpellings(adapter, e, column, points, memo) {
  if (typeof adapter.spellings !== 'function') return null;
  const key = [e.file, column, ...points].join(' ');
  if (!memo.has(key)) memo.set(key, adapter.spellings(e, column, points).catch(() => null));
  return memo.get(key);
}

// How points spelled otherwise than the column are recorded there.
function spelledOtherwise(points, spelled) {
  const notes = points.map(p => { const recorded = spelled.get(p) || []; return recorded.length && !recorded.includes(p) ? `${p} as ${recorded[0]}` : null; }).filter(Boolean);
  return notes.length ? ` (${notes.join(', ')})` : '';
}

// Where words live in the release: a table by its name or description, a column by its name, a
// value by the recorded values of a column (counted at the source), an item inside list cells.
// Tables are grouped by the words they match, most words first; in the first group a table placed
// by its text or its values is shown with its columns and the values found, a table placed by a
// column name alone is named; the other groups name their tables with the values found. A word
// that is an entity of the database is answered with its id and the columns of the tables found
// so far that hold such ids; a word no vocabulary holds is scanned for in the text of big
// columns; points that are not entities are placed in the columns that hold them, by vocabulary
// or by the spellings recorded at the source. Returns the text and the tables of the first group.
async function searchRelease(adapter, catalog, words, listed, found = new Set(), memo = new Map()) {
  // A word is searched by its parts: main_subcellular_location is main, subcellular, location.
  const parts = w => String(w).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const needles = [...new Set(words.flatMap(parts).map(flat).filter(n => n.length >= 2))];
  const entities = (await adapter.resolveGenes(words).catch(() => [])).map((gene, i) => gene ? { word: words[i], gene } : null).filter(Boolean);
  const hits = new Map();
  const hit = e => { if (!hits.has(e.file)) hits.set(e.file, { e, words: new Set(), named: new Set(), titled: new Set(), columns: [], values: [], items: [] }); return hits.get(e.file); };
  for (const e of catalog) {
    if (e.key === 'unreadable') continue;
    const about = flat(`${e.file} ${e.title || ''} ${e.description || ''}`);
    const named = needles.filter(n => about.includes(n));
    if (named.length) { const h = hit(e); const own = flat(`${e.file} ${e.title || ''}`); for (const n of named) { h.named.add(n); h.words.add(n); if (own.includes(n)) h.titled.add(n); } }
    const profile = await adapter.profile(e).catch(() => null);
    for (const c of e.columns) {
      const inName = needles.filter(n => flat(c).includes(n));
      if (!inName.length) continue;
      const h = hit(e);
      h.columns.push({ column: c, card: (profile?.columns || []).find(card => card.column === c) || null, words: inName });
      for (const n of inName) h.words.add(n);
    }
    for (const card of profile?.columns || []) {
      for (const [kind, recorded] of [['values', card.observed_values], ['items', card.parts?.values]]) {
        if (!Array.isArray(recorded)) continue;
        for (const n of needles) { const f = recorded.filter(v => holdsWord(v, n)); if (f.length) { const h = hit(e); h[kind].push({ column: card.column, found: f.slice(0, 3), more: f.length - Math.min(3, f.length), word: n }); h.words.add(n); } }
      }
    }
  }
  const ranked = [...hits.values()].sort((a, b) => b.words.size - a.words.size || b.titled.size - a.titled.size || b.named.size - a.named.size || (b.columns.length + b.values.length + b.items.length) - (a.columns.length + a.values.length + a.items.length));
  const wordOf = new Map();
  for (const w of words) for (const part of parts(w)) { const n = flat(part); if (n.length >= 2 && !wordOf.has(n)) wordOf.set(n, part); }
  const groups = [];
  for (const h of ranked) {
    const key = needles.filter(n => h.words.has(n)).map(n => wordOf.get(n)).join(' + ');
    let g = groups.find(x => x.key === key);
    if (!g) { g = { key, tables: [] }; groups.push(g); }
    g.tables.push(h);
  }
  const first = groups[0]?.tables || [];
  for (const h of first) found.add(h.e.file);
  const lines = [];
  if (entities.length) {
    // The list reads an entity's rows by its keys; a pair table holds ids on both sides.
    const holders = [];
    for (const file of found) {
      const e = catalog.find(x => x.file === file);
      const ids = e ? await idColumns(adapter, e) : [];
      if (ids.length) holders.push(`${file} · ${ids.join(', ')}${ids.length > 1 ? ' (a pair table: match against both)' : ''}`);
    }
    const master = catalog.find(e => e.key === 'master');
    const pointWords = new Set(listed.map(p => flat(p)));
    const asPoints = entities.filter(x => pointWords.has(flat(x.word)) || pointWords.has(flat(x.gene.gene)) || pointWords.has(flat(x.gene.ensembl)));
    const asValues = entities.filter(x => !asPoints.includes(x));
    const idOf = x => `${JSON.stringify(x.word)} is a ${adapter.identity().entity} of the release (${x.gene.gene} = ${x.gene.ensembl})`;
    const where = holders.length ? `; columns holding ${adapter.identity().entity} ids in the tables found: ${holders.slice(0, SEARCH_HITS).join('; ')}` : '';
    if (asPoints.length) lines.push(`${asPoints.map(idOf).join('; ')}: fetch reads its rows for the list by its keys, no search of the point is needed${master ? `; its own row (name, id, annotations) is in ${master.file}` : ''}${where || '; search a word of the subject to find the table, then fetch with the list'}`);
    if (asValues.length) lines.push(`${asValues.map(idOf).join('; ')}: a where on a column of ${adapter.identity().entity} ids selects its rows${where}`);
  }
  if (groups.length) {
    const single = v => v.found.length === 1 && !v.more;
    // Where each word was found in a table: the columns named by it (counted when many), the
    // columns whose values or items hold it (the value when one, else how many), and the
    // vocabulary of a column named by the whole search, which a where or a match needs.
    const placesOf = async (h, counted) => {
      const parts = [];
      for (const n of needles.filter(n => h.words.has(n))) {
        const places = [];
        const cols = h.columns.filter(c => c.words.includes(n));
        if (cols.length) places.push(cols.length <= 3 ? `column${cols.length > 1 ? 's' : ''} ${cols.map(c => c.column).join(', ')}` : `${count(cols.length)} column names (${cols.slice(0, 3).map(c => c.column).join(', ')}, …)`);
        for (const v of h.values.filter(v => v.word === n)) {
          const rows = counted && single(v) && typeof adapter.holds === 'function' ? await adapter.holds(h.e, v.column, v.found).catch(() => null) : null;
          places.push(single(v) ? `${v.column} = ${v.found[0]}${rows !== null ? ` (${count(rows)} rows)` : ''}` : v.more ? `${v.column} (${count(v.found.length + v.more)} values, e.g. ${v.found[0]})` : `${v.column} = ${v.found.join(' | ')}`);
        }
        for (const v of h.items.filter(v => v.word === n)) places.push(single(v) ? `${v.column} lists ${v.found[0]}` : `${v.column} lists ${count(v.found.length + v.more)} items, e.g. ${v.found[0]}`);
        if (h.named.has(n) && !places.length) places.push('its name or description');
        if (places.length) parts.push(`${wordOf.get(n)}: ${places.join(', ')}`);
      }
      for (const c of h.columns.filter(c => needles.every(n => c.words.includes(n)) && vocabularyShown(c.card))) parts.push(`column ${c.column} = ${vocabularyShown(c.card)}`);
      return parts.join('; ');
    };
    // A table of a later group is named with the columns holding the words, and the value when
    // a column holds one.
    const holding = h => { const byColumn = new Map(); for (const v of [...h.values, ...h.items]) { const seen = byColumn.get(v.column) || new Set(); for (const f of v.found) seen.add(f); if (v.more) seen.add(null); byColumn.set(v.column, seen); } return [...byColumn.entries()].map(([column, found]) => found.size === 1 && !found.has(null) ? `${column} = ${[...found][0]}` : column); };
    const brief = h => { const cols = holding(h); return `${h.e.file}${cols.length ? ` (${cols.slice(0, 3).join(', ')}${cols.length > 3 ? `, +${cols.length - 3}` : ''})` : ''}`; };
    for (const [i, g] of groups.entries()) {
      const head = `${g.key}${g.tables.length > 1 ? ` (${count(g.tables.length)} tables)` : ''}:`;
      if (i > 0) { lines.push(`${head} ${g.tables.map(brief).join(', ')}`); continue; }
      // The first group in full; a table placed by a column name alone is named with it.
      const placed = g.tables.filter(h => h.named.size || h.values.length || h.items.length || h.columns.some(c => needles.every(n => c.words.includes(n))));
      const full = [];
      for (const h of placed) full.push(`${h.e.file} (${columnsNamed(h.e.columns)}) — ${h.e.title || h.e.file}: ${await placesOf(h, true)}`);
      const rest = g.tables.filter(h => !placed.includes(h)).map(h => `${h.e.file} (${[...new Set(h.columns.map(c => c.column))].slice(0, 3).join(', ')})`);
      lines.push(`${head}${full.length ? `\n  ${full.join('\n  ')}` : ''}${rest.length ? `${full.length ? '\n  ' : ' '}by a column name: ${rest.join(', ')}` : ''}`);
    }
  }
  // A word no vocabulary holds (a symbol, an id, a sample, free text) is scanned for in the text
  // columns that have no vocabulary, across every table: where it lives, with how many rows.
  if (typeof adapter.textHits === 'function') {
    const covered = new Set(ranked.flatMap(h => [...h.values, ...h.items]).flatMap(v => words.filter(w => v.found.some(x => flat(x).includes(flat(w))))));
    const unplaced = words.filter(w => flat(w).length >= 2 && !covered.has(w) && !entities.some(x => x.word === w));
    const scanned = [];
    if (unplaced.length) {
      for (const e of catalog) {
        if (e.key === 'unreadable') continue;
        const profile = await adapter.profile(e).catch(() => null);
        for (const card of (profile?.columns || []).filter(c => c.kind === 'text' && !Array.isArray(c.observed_values))) {
          for (const w of unplaced) { const hit = await adapter.textHits(e, card.column, w).catch(() => null); if (hit?.rows) scanned.push({ line: `${e.file} · ${card.column} = ${hit.values.join(' | ')} (${count(hit.rows)} rows hold "${w}")`, rows: hit.rows }); }
        }
      }
    }
    if (scanned.length) lines.push(`text columns holding the words: ${scanned.sort((a, b) => b.rows - a.rows).slice(0, SEARCH_HITS).map(s => s.line).join('; ')}${scanned.length > SEARCH_HITS ? ` (+${scanned.length - SEARCH_HITS})` : ''}`);
  }
  // Where the points live, when they are not the database's entities: in a column whose
  // vocabulary holds them, or one without a vocabulary whose recorded spellings do.
  if (listed.length && !listed.resolvedAny) {
    const sample = listed.slice(0, 3);
    const where = [];
    for (const e of catalog) {
      if (e.key === 'unreadable') continue;
      const profile = await adapter.profile(e).catch(() => null);
      for (const card of profile?.columns || []) {
        const vocabulary = Array.isArray(card.observed_values) || card.parts?.kind === 'items' ? [...(card.observed_values || []), ...(card.parts?.kind === 'items' ? card.parts.values : [])] : null;
        if (vocabulary) { if (sample.every(p => vocabulary.some(v => flat(v) === flat(p)) || nearMisses(p, vocabulary).length === 1)) where.push(`${e.file} · ${card.column}`); continue; }
        if (card.kind !== 'text') continue;
        const spelled = await recordedSpellings(adapter, e, card.column, sample, memo);
        if (spelled && sample.every(p => spelled.get(p)?.length)) where.push(`${e.file} · ${card.column}${spelledOtherwise(sample, spelled)}`);
      }
    }
    if (where.length) lines.push(`the points are values of: ${where.slice(0, SEARCH_HITS).join('; ')}`);
  }
  return { text: lines.length ? lines.join('\n') : `nothing in the release is named by ${words.map(w => JSON.stringify(w)).join(', ')}: try a word of the subject, or a value as the data spells it`, tables: first.map(h => h.e.file) };
}

const columnsNamed = columns => columns.length > 12 ? `${columns.slice(0, 12).join(', ')} … ${columns.length} columns` : columns.join(', ');

// Where a filter value is recorded in the release, when the table filtered holds no row with it:
// the columns of any table whose vocabulary holds the words of the value.
async function recordedElsewhere(adapter, catalog, value, except) {
  const needle = flat(value);
  if (needle.length < 3) return [];
  const places = [];
  for (const e of catalog) {
    if (e.key === 'unreadable') continue;
    const profile = await adapter.profile(e).catch(() => null);
    for (const card of profile?.columns || []) {
      const recorded = [...(Array.isArray(card.observed_values) ? card.observed_values : []), ...(Array.isArray(card.parts?.values) ? card.parts.values : [])];
      const found = recorded.filter(v => holdsWord(v, needle));
      if (found.length && !(e.file === except.file && found.every(v => except.columns.has(card.column)))) places.push(`${e.file} · ${card.column} = ${found.slice(0, 3).join(' | ')}${found.length > 3 ? ` (+${found.length - 3})` : ''}`);
    }
  }
  return places;
}

// The recorded values of a text column as the search shows them: the whole vocabulary when the
// card holds it, otherwise its size with the commonest values; nothing for a numeric column.
function vocabularyShown(card) {
  if (!card || card.kind !== 'text') return '';
  if (Array.isArray(card.observed_values) && card.observed_values.length && card.observed_values.length <= 12) return card.observed_values.join(' | ');
  const examples = (card.examples || []).filter(Boolean);
  return examples.length ? `${card.distinct} values, e.g. ${examples.join(' | ')}` : '';
}

const SEARCH_RULE = 'A point that is an entity of the release is read by the list: fetch the table found, without searching the point itself.';

async function investigatorBulk(args, ctx = {}, adapter = require('../../hpa/geneDataAdapter')) {
  const { question, mode = 'offline' } = args;
  const points = args.points ?? args.genes ?? null;
  const started = Date.now();
  const stats = { prompt: 0, completion: 0, total: 0, calls: 0 };
  const results = new Map();
  const history = [];
  const searches = [];
  const found = new Set();   // tables found by any search so far, for what a later search says about a point
  const memo = new Map();    // spellings asked of the source, by column and points
  const { onStep } = ctx;
  const emit = (stage, label, message) => onStep?.({ stage, label, message });
  let release = null, resolved = [], db = null;
  const unresolvedPoints = () => (points || []).filter((_, i) => !resolved[i]);
  const done = (extra, turns) => ({ bulk: true, mode: 'offline', hpa_version: release?.hpaVersion || null, tokens: { total: { prompt: stats.prompt, completion: stats.completion, total: stats.total } }, calls: stats.calls, turns, seconds: (Date.now() - started) / 1000, unresolved: unresolvedPoints(), ...extra });
  try {
    if (points !== null && (!Array.isArray(points) || points.some(p => typeof p !== 'string' || !p.trim()))) throw new Error('Investigator points must be an array of names');
    if (typeof question !== 'string' || !question.trim()) throw new Error('Investigator requires a question');
    const control = createAgentControl({ ctx, stats: { get totalTokens() { return stats.total; } }, agentKey: 'investigator_hpa' });
    await control.checkpoint('Resolve sources');
    release = await resolveAgentMode(mode, [FILES.master]);
    if (release.mode !== 'offline') throw new Error('Investigator requires the local release');
    db = adapter.identity();
    const keys = { entity: db.entity, columns: db.keys };
    const listed = points && points.length ? [...points] : [];
    resolved = listed.length ? await adapter.resolveGenes(listed) : [];
    const identities = new Map();
    for (const gene of resolved) if (gene && !identities.has(gene.ensembl)) identities.set(gene.ensembl, gene);
    listed.resolvedAny = identities.size > 0;
    const catalog = await adapter.catalog();
    const system = systemPrompt(db);
    const offered = tools(db);
    const maxTurns = ctx.maxTurns || platformConfig().asoMaxSteps;
    await emit('start', 'Investigator', `${listed.length ? `${listed.length} points supplied, ${identities.size} resolve as ${db.entity}s` : 'No list'}. Question: ${question}`);

    // The gate: one field in one context, or nothing is read.
    const gateStats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, perStep: {} };
    const gate = await jsonCall(GATE_SYSTEM, `Question: ${question}\nPoints: ${listed.length ? `${count(listed.length)} (${listed.slice(0, 3).join(', ')}${listed.length > 3 ? ', …' : ''})` : 'none'}`, onStep, 'Gate', gateStats);
    stats.prompt += gateStats.promptTokens; stats.completion += gateStats.completionTokens; stats.total = stats.prompt + stats.completion; stats.calls++;
    if (gate && gate.accepted === false) {
      const reason = String(gate.reason || 'the question asks for more than one origin').trim();
      await emit('error', 'Investigator', `rejected: ${reason}`);
      return done({ found: false, status: 'rejected', stop_reason: 'rejected', incomplete: true, error: `rejected: ${reason}`, tables: [], retained: [], note: `rejected: ${reason}` }, 0);
    }

    const desk = turn => {
      const list = listed.length
        ? `${count(listed.length)} points supplied${identities.size ? `, ${count(identities.size)} resolve as ${db.entity}s in the release` : `; none is a ${db.entity} of the release, so fetch matches them against the column the search finds them in`}${unresolvedPoints().length && identities.size ? `; not ${db.entity}s of the release: ${unresolvedPoints().slice(0, 8).join(', ')}${unresolvedPoints().length > 8 ? ` (+${unresolvedPoints().length - 8})` : ''}` : ''}. First points: ${listed.slice(0, 5).join(', ')}`
        : 'No list: the question selects rows by a filter.';
      const shownSearches = searches.slice(-SEARCHES_SHOWN).map(s => `search ${s.words.map(w => JSON.stringify(w)).join(', ')} →\n  ${s.text.split('\n').join('\n  ')}`);
      // Tables found by searches that left the desk keep their columns here.
      const visible = new Set(searches.slice(-SEARCHES_SHOWN).flatMap(s => s.tables || []));
      const foundLines = [...found].filter(file => !visible.has(file)).map(file => { const e = catalog.find(x => x.file === file); return e ? `${e.file} (${columnsNamed(e.columns)})` : file; });
      // Each result with its first rows, so what a fetch holds is seen and not fetched again.
      const lines = [...results.values()].map(t => `${t.title} (${count(t.rows.length)} rows: ${namedColumns(t.columns)}) ← fetch ${argsLine(t.args, 120)}${t.coverage?.with_rows !== undefined ? `; ${t.coverage.with_rows} points with rows` : ''}${t.identity?.length ? `; ${t.identity.join(', ')} are the keys` : ''}${t.rows.length ? `\n  ${sampleLines(t.rows, t.columns, RESULT_ROWS_SHOWN).join('\n  ')}${t.rows.length > RESULT_ROWS_SHOWN ? `\n  … +${count(t.rows.length - RESULT_ROWS_SHOWN)} rows` : ''}` : ''}`);
      return [
        section('QUESTION', question),
        section('POINTS', list),
        section('SEARCHES', shownSearches.join('\n') || '(none yet)'),
        section('TABLES FOUND', foundLines.join('\n') || (found.size ? '(under SEARCHES)' : '(none yet)')),
        section('RESULTS', lines.join('\n') || '(none yet)'),
        section('HISTORY', historyText(history.slice(-HISTORY_SHOWN))),
        `TURN ${turn}/${maxTurns}`
      ].join('\n\n');
    };

    const seen = new Map();   // fingerprint of a completed call → its outcome line
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
        history.push(`turn ${turn}: no tool called${response.choices?.[0]?.finish_reason === 'length' ? ' (the answer ran out of room before a call)' : ''}`);
        if (++idle > 1) throw new AgentStop('no_progress', `Investigator stopped calling tools; it had tried: ${history.slice(-4).map(line => line.replace(/\s*\n\s*/g, ' ').slice(0, 200)).join('; ')}`);
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
          const ignored = validate(args, spec.function.parameters, name);
          if (ignored.length) history.push(`turn ${turn}: ${name}: ${ignored.slice(0, 5).map(key => key.slice(name.length + 1).slice(0, 40)).join(', ')} ${ignored.length === 1 ? 'is not an argument' : 'are not arguments'} of this tool, ignored`);
          const { title: _title, description: _description, ...bareArgs } = args;
          const key = fingerprint({ name, args: bareArgs });
          if (name !== 'finish' && seen.has(key)) {
            // A fetch asked again after it was made is the agent done without saying so: its
            // results are returned, the mapping read from the fetches themselves.
            if (name === 'fetch' && results.size) {
              const tables = [...results.values()];
              const mapping = [...new Map(tables.flatMap(t => (t.args.fields || []).map(field => ({ field, table: t.args.table, column: field }))).map(m => [`${m.field} ${m.table} ${m.column}`, m])).values()];
              await emit('complete', 'Investigator done', `${tables.length} result${tables.length === 1 ? '' : 's'}, returned when the same fetch was asked again`);
              return done({ found: true, status: 'ok', tables, retained: [], mapping, note: 'returned when the same fetch was asked again; the mapping is read from the fetches', opened: [] }, turn);
            }
            // A search asked again after it left the desk is shown again.
            const left = name === 'search' ? searches.findIndex(s => s.key === key) : -1;
            if (left >= 0 && left < searches.length - SEARCHES_SHOWN) { searches.push(...searches.splice(left, 1)); history.push(`turn ${turn}: search ${searches.at(-1).words.map(w => JSON.stringify(w)).join(', ')} shown again (under SEARCHES)`); progressed = true; continue; }
            history.push(`turn ${turn}: ${name}(${argsLine(bareArgs)}) repeated; ${seen.get(key)}`); continue;
          }
          if (name === 'search') {
            const words = (args.words || []).map(String).map(w => w.trim()).filter(Boolean);
            if (!words.length) throw new Error('search needs a word');
            const { text, tables: placed } = await searchRelease(adapter, catalog, words, listed, found, memo);
            searches.push({ words, text, key, tables: placed });
            history.push(`turn ${turn}: searched ${words.map(w => JSON.stringify(w)).join(', ')} (under SEARCHES)`);
            seen.set(key, 'under SEARCHES'); progressed = true;
            await emit('execution_step', 'Search', `${words.join(', ')}: ${text.split('\n')[0].slice(0, 160)}`);
          } else if (name === 'fetch') {
            let title = String(args.title || '').trim() || `${String(args.table || '').replace(/\.tsv$/i, '')}: ${(args.fields || []).join(', ') || 'every column'}${args.where?.length ? ` where ${args.where.map(w => `${w.column} ${w.op} ${Array.isArray(w.value) ? w.value.join('|') : w.value ?? ''}`).join(' and ')}` : ''}`.slice(0, 120);
            const description = title;
            const spelling = [];
            if (results.has(title)) { let n = 2; while (results.has(`${title} (${n})`)) n++; spelling.push(`a result titled ${JSON.stringify(title)} exists: this one is titled "${title} (${n})"`); title = `${title} (${n})`; }
            const entry = await adapter.entry(String(args.table || '').trim());
            if (!entry || entry.key === 'unreadable') throw new Error(`no table named ${JSON.stringify(args.table)}${entry?.why ? `: ${entry.why}` : ''}; search names the tables`);
            const cards = (await adapter.profile(entry)).columns;
            // The vocabulary of a column: its recorded values, and the items of its list cells.
            const vocabularyOf = card => Array.isArray(card?.observed_values) || card?.parts?.kind === 'items' ? [...(card.observed_values || []), ...(card.parts?.kind === 'items' ? card.parts.values : [])] : null;
            const knownValuesOf = column => vocabularyOf(cards.find(c => c.column === column) || cards.find(c => c.column.toLowerCase() === String(column).toLowerCase()));
            const idCols = await idColumns(adapter, entry);
            // A filter value the table spells differently is read as the table spells it; on a
            // column of entity ids, an entity named by name is read by its id.
            for (const clause of args.where || []) {
              if (!clause || !['=', '!=', 'in'].includes(clause.op) || clause.value === null || clause.value === undefined) continue;
              const column = entry.columns.find(c => c === clause.column) || entry.columns.find(c => c.toLowerCase() === String(clause.column || '').toLowerCase());
              if (!column) throw new Error(`${entry.file} has no column ${JSON.stringify(clause.column)}; its columns: ${namedColumns(entry.columns)}`);
              let values = clause.op === 'in' ? inList(clause.value) : [clause.value], changed = false;
              if (idCols.includes(column) && values.some(v => !adapter.isEntityId(v))) {
                const genes = await adapter.resolveGenes(values.map(String)).catch(() => []);
                const byId = values.map((v, i) => !adapter.isEntityId(v) && genes[i] ? genes[i].ensembl : v);
                const notes = values.map((v, i) => byId[i] !== v ? `${v} read as ${byId[i]}` : null).filter(Boolean);
                if (notes.length) { values = byId; changed = true; spelling.push(`${column} holds ids: ${notes.join(', ')}`); }
              }
              const read = correctSpelling(values, knownValuesOf(column), column, entry.file);
              if (read.notes.length) { values = read.values; changed = true; spelling.push(...read.notes); }
              if (changed) clause.value = clause.op === 'in' ? values : values[0];
            }
            // The points of a fetch are the list, or the values of a column of an earlier result.
            let supplied = listed, supplyResolved = resolved, supplyIdentities = identities, chained = null;
            // A column named without from is the column the points are values of.
            if (args.from === undefined && args.column !== undefined && args.match === undefined) { args.match = args.column; delete args.column; spelling.push('column without from read as match'); }
            if (args.from !== undefined || args.column !== undefined) {
              if (args.from === undefined || args.column === undefined) throw new Error('from and column go together: the title of an earlier result and the column whose values are the points');
              const wanted = String(args.from).trim();
              const byTable = [...results.values()].filter(t => String(t.args?.table || '').toLowerCase().replace(/\.tsv$/, '') === wanted.toLowerCase().replace(/\.tsv$/, ''));
              const source = results.get(wanted) || [...results.values()].find(t => t.title.toLowerCase() === wanted.toLowerCase()) || (byTable.length === 1 ? byTable[0] : null);
              if (!source) throw new Error(`no result titled ${JSON.stringify(wanted)}; results so far: ${[...results.keys()].join(', ') || 'none'}`);
              const column = source.columns.find(c => c === args.column) || source.columns.find(c => c.toLowerCase() === String(args.column).trim().toLowerCase());
              if (!column) throw new Error(`${JSON.stringify(source.title)} has no column ${JSON.stringify(args.column)}; its columns: ${namedColumns(source.columns)}`);
              supplied = [...new Set(source.rows.map(r => r[column]).filter(v => v !== null && v !== undefined && String(v).trim() !== '').map(String))];
              if (!supplied.length) throw new Error(`${JSON.stringify(source.title)} holds no value in ${column}`);
              supplyResolved = args.match ? [] : await adapter.resolveGenes(supplied);
              supplyIdentities = new Map();
              for (const gene of supplyResolved) if (gene && !supplyIdentities.has(gene.ensembl)) supplyIdentities.set(gene.ensembl, gene);
              chained = { from: source.title, column };
            }
            // A where whose values are the points names the column the points are values of: the
            // points are matched against it, and the clause, which the match makes, is set aside.
            let match = args.match;
            if (supplied.length && (Array.isArray(match) ? match.length : match)) {
              const asked = Array.isArray(match) ? match : [match];
              const columns = asked.filter(c => entry.columns.some(k => k.toLowerCase() === String(c).trim().toLowerCase()));
              const pointsNamed = asked.filter(c => !columns.includes(c) && supplied.some(p => flat(p) === flat(c)));
              if (pointsNamed.length) { match = columns.length ? columns : undefined; spelling.push(`match named ${pointsNamed.length === asked.length ? 'the points' : pointsNamed.join(', ')}, which the list supplies: ${match ? 'left out of match' : 'match dropped'}`); }
            }
            if (supplied.length && !match && !supplyIdentities.size && args.where?.length) {
              const pointKeys = new Set(supplied.map(p => flat(p)));
              const naming = args.where.filter(c => c && ['=', 'in', 'contains'].includes(c.op) && (c.op === 'in' ? inList(c.value) : [c.value]).every(v => pointKeys.has(flat(v))));
              if (naming.length === 1) { match = naming[0].column; args.where = args.where.filter(c => c !== naming[0]); spelling.push(`the where on ${naming[0].column} names the points: matched against it`); }
            }
            // A where on the column the list already selects by is set aside: the list is the
            // selection, by whichever spelling the column holds; a clause naming fewer points than
            // the list, or other ids, would only lose rows.
            if (supplied.length && !match && args.where?.length) {
              const keyColumns = [entry.geneColumn, ...(['ensembl', 'name', 'master'].includes(entry.key) ? entry.columns.slice(0, entry.key === 'name' ? 2 : 1) : [])].filter(Boolean).map(c => c.toLowerCase());
              const keysOfList = new Set([...supplied, ...supplyResolved.filter(Boolean).flatMap(g => [g.gene, g.ensembl])].filter(Boolean).map(v => String(v).trim().toLowerCase()));
              for (const clause of [...args.where]) {
                if (!clause || !keyColumns.includes(String(clause.column || '').toLowerCase()) || !['=', 'in'].includes(clause.op)) continue;
                const named = new Set((clause.op === 'in' ? inList(clause.value) : [clause.value]).map(v => String(v).trim().toLowerCase()));
                const dropped = supplied.filter((p, i) => { const g = supplyResolved[i]; return g && ![p, g.gene, g.ensembl].filter(Boolean).some(v => named.has(String(v).trim().toLowerCase())); });
                args.where = args.where.filter(c => c !== clause);
                spelling.push(dropped.length ? `the where on ${clause.column} names ${count(named.size)} of the list's ${count(supplied.length)} points; the list selects the rows, so it is set aside` : `the where on ${clause.column} names the points of the list, which already selects them: set aside`);
              }
            }
            // Points matched against a column are read as the column spells them; points that are
            // none of the database's entities and name no column are matched against the one
            // column of the table whose vocabulary holds them.
            if (supplied.length && match) {
              for (const column of Array.isArray(match) ? match : [match]) {
                const read = correctSpelling(supplied, knownValuesOf(column), column, entry.file);
                if (read.notes.length) { supplied = read.values; spelling.push(...read.notes); }
              }
            } else if (supplied.length && !supplyIdentities.size) {
              const valued = cards.map(c => ({ column: c.column, values: vocabularyOf(c) })).filter(c => c.values?.length);
              const wanted = supplied.map(v => String(v).trim().toLowerCase());
              const holds = c => v => c.values.some(o => String(o).trim().toLowerCase() === v) || nearMisses(v, c.values).length === 1;
              const holding = valued.filter(c => wanted.every(holds(c)));
              if (holding.length === 1) {
                match = holding[0].column;
                const read = correctSpelling(supplied, holding[0].values, match, entry.file);
                supplied = read.values; spelling.push(...read.notes);
                history.push(`turn ${turn}: the points are values of ${match}, not ${db.entity}s: matched against it`);
              } else if (holding.length > 1) throw new Error(`none of the points is a ${db.entity} of the release; they are values of ${holding.map(c => c.column).join(' and ')}: name the column meant with match`);
              else {
                // No vocabulary holds the points: the columns without one are asked at the source.
                const spelledIn = [];
                for (const card of cards.filter(c => c.kind === 'text' && !vocabularyOf(c))) {
                  const spelled = await recordedSpellings(adapter, entry, card.column, supplied, memo);
                  if (spelled && supplied.every(p => spelled.get(p)?.length)) spelledIn.push(card.column);
                }
                if (spelledIn.length === 1) { match = spelledIn[0]; history.push(`turn ${turn}: the points are values of ${match}, not ${db.entity}s: matched against it`); }
                else if (spelledIn.length > 1) throw new Error(`none of the points is a ${db.entity} of the release; they are values of ${spelledIn.join(' and ')}: name the column meant with match`);
              }
            }
            // A point that is an entity is found in a column under any of its names (its id, its
            // symbol); a point spelled otherwise in a column without a vocabulary is found under
            // the spelling recorded there.
            const aliases = new Map();
            supplied.forEach((p, i) => { const g = supplyResolved[i]; if (g) aliases.set(String(p).trim(), [g.gene, g.ensembl].filter(Boolean)); });
            if (supplied.length && match) {
              for (const column of (Array.isArray(match) ? match : [match])) {
                const card = cards.find(c => c.column === column) || cards.find(c => c.column.toLowerCase() === String(column).toLowerCase());
                if (!card || Array.isArray(card.observed_values)) continue;
                const spelled = await recordedSpellings(adapter, entry, card.column, supplied, memo);
                if (!spelled) continue;
                for (const p of supplied) {
                  const others = (spelled.get(p) || []).filter(v => String(v).toLowerCase() !== String(p).trim().toLowerCase());
                  if (!others.length) continue;
                  aliases.set(String(p).trim(), [...(aliases.get(String(p).trim()) || []), ...others]);
                  spelling.push(`read ${JSON.stringify(p)} as ${JSON.stringify(others[0])}, the spelling of ${card.column}`);
                }
              }
            }
            // A field naming no column is dropped with a note (a point is no column: the list reads
            // it); a fetch with no field left fails with the columns.
            if (Array.isArray(args.fields) && args.fields.length) {
              const known = [], unknown = [];
              for (const f of args.fields) {
                const name = String(f);
                const hit = entry.columns.find(c => c === name) || entry.columns.find(c => c.toLowerCase() === name.toLowerCase()) || entry.columns.find(c => c.toLowerCase().startsWith(name.toLowerCase()));
                (hit ? known : unknown).push(name);
              }
              if (unknown.length && known.length) {
                args.fields = known;
                const pointNamed = unknown.filter(u => supplied.some(p => flat(p) === flat(u)));
                spelling.push(`no column of ${entry.file} is named ${unknown.join(', ')}${pointNamed.length ? ` (${pointNamed.join(', ')}: ${pointNamed.length === 1 ? 'a point, read by the list' : 'points, read by the list'})` : ''}: dropped from the fields`);
              }
            }
            // A fetch that would read the rows of a result made already (the same table, fields,
            // filter and points; a match on entity points changes nothing) is the agent done
            // without saying so: every result is returned, the mapping read from the fetches.
            const effective = fingerprint({ table: entry.file, fields: [...(args.fields || [])].sort(), where: args.where || [], from: chained?.from, column: chained?.column, match: supplyIdentities.size ? undefined : match });
            const made = [...results.values()].find(t => t.effective === effective);
            if (made) {
              const tables = [...results.values()];
              const mapping = [...new Map(tables.flatMap(t => (t.args.fields || []).map(field => ({ field, table: t.args.table, column: field }))).map(m => [`${m.field} ${m.table} ${m.column}`, m])).values()];
              await emit('complete', 'Investigator done', `${tables.length} result${tables.length === 1 ? '' : 's'}, returned when the rows of "${made.title}" were fetched again`);
              return done({ found: true, status: 'ok', tables, retained: [], mapping, note: `returned when the rows of "${made.title}" were fetched again; the mapping is read from the fetches`, opened: [] }, turn);
            }
            if (spelling.length) history.push(`turn ${turn}: ${[...new Set(spelling)].join('; ')}`);
            const filter = args.where?.length ? ` where ${args.where.map(w => `${w.column} ${w.op} ${w.value ?? ''}`).join(' and ')}` : '';
            await emit('execution_step', 'Fetch', `${entry.file}${args.fields?.length ? ` fields ${args.fields.join(', ')}` : ''}${filter}${supplied.length ? ` for ${count(supplied.length)} points${chained ? ` from "${chained.from}" ${chained.column}` : ''}${match ? ` matched against ${Array.isArray(match) ? match.join(', ') : match}` : ''}` : ''}`);
            let fetched;
            if (!supplied.length) fetched = await fetchAll({ adapter, entry, fields: args.fields, where: args.where, keys });
            else if (match) fetched = await fetchMatching({ adapter, entry, points: supplied, fields: args.fields, where: args.where, match, keys, aliases });
            else if (supplyIdentities.size && idCols.length > 1) {
              // A pair table holds an entity on either side: its rows are read by both sides, the
              // point named in point and the other side in other, so a row's entity is the other.
              history.push(`turn ${turn}: ${entry.file} holds ${db.entity} ids on both sides (${idCols.join(', ')}): the points are matched against both; the other side is other`);
              fetched = await fetchMatching({ adapter, entry, points: supplied, fields: args.fields, where: args.where, match: idCols, keys, aliases });
            }
            else if (supplyIdentities.size) fetched = await fetchRows({ adapter, entry, supplied, resolved: supplyResolved, fields: args.fields, where: args.where, keys });
            else if (['lookup', 'stream'].includes(entry.key) && supplyIdentities.size && args.where?.length) {
              history.push(`turn ${turn}: ${entry.file} has no ${db.entity} rows for the list; read whole by the where`);
              fetched = await fetchAll({ adapter, entry, fields: args.fields, where: args.where, keys });
            }
            else throw new Error(`none of the points is a ${db.entity} of the release, and no column of ${entry.file} holds them; search a point to see where such values live, name the column with match, or fetch without the list`);
            const table = { name: title, title, description, rows: fetched.rows, columns: fetched.columns, args: { table: entry.file, fields: fetched.fields, ...(args.where?.length ? { where: args.where } : {}), ...(fetched.match ? { match: fetched.match } : {}), ...(chained || {}) }, coverage: fetched.coverage, source_file: entry.file, effective, identity: fetched.identity_columns || [] };
            results.set(title, table);
            const c = fetched.coverage;
            // A filter that matched no row at all: the desk says where its values are recorded.
            if (args.where?.length && ((supplied.length && !c.with_rows && c.no_match) || (!supplied.length && !c.rows))) {
              const notes = [];
              for (const clause of args.where) {
                if (!clause || clause.value === null || clause.value === undefined) continue;
                for (const value of (clause.op === 'in' ? inList(clause.value) : [clause.value]).map(String).slice(0, 3)) {
                  const places = await recordedElsewhere(adapter, catalog, value, { file: entry.file, columns: new Set([clause.column]) });
                  notes.push(places.length ? `${JSON.stringify(value)} is recorded in ${places.slice(0, 6).join('; ')}${places.length > 6 ? ` (+${places.length - 6})` : ''}` : `${JSON.stringify(value)} is recorded nowhere in the release`);
                }
              }
              if (notes.length) history.push(`turn ${turn}: no row of ${entry.file} matched the where: ${notes.join('. ')}`);
            }
            const summary = supplied.length
              ? `${c.with_rows} points with rows${c.no_match ? `, ${c.no_match} with no row matching the filter` : ''}${c.no_rows ? `, ${c.no_rows} with no row in the table` : ''}${c.not_in_release ? `, ${c.not_in_release} not in the release` : ''}`
              : `${count(c.rows)} of ${count(c.scanned)} rows selected`;
            history.push(`turn ${turn}: fetch${chained ? ` for the ${count(supplied.length)} values of "${chained.from}" ${chained.column}` : ''} → "${title}" (${count(table.rows.length)} rows; ${summary})`);
            seen.set(key, `it made "${title}"`); progressed = true;
            await emit('selection_step', 'Result', `${title}: ${count(table.rows.length)} rows`);
          } else {
            // A result is named by its title, exactly, case aside, or by a start of it that names one.
            const titleOf = name => { const want = String(name).trim(); const keys = [...results.keys()]; return keys.find(k => k === want) || keys.find(k => k.toLowerCase() === want.toLowerCase()) || (keys.filter(k => k.toLowerCase().startsWith(want.toLowerCase())).length === 1 ? keys.find(k => k.toLowerCase().startsWith(want.toLowerCase())) : null); };
            const named = (args.results || []).map(n => [String(n), titleOf(n)]);
            const unknown = named.filter(([, k]) => !k).map(([n]) => n);
            // Names that are no titles at all (the values read, a table) with results made: the
            // agent is done with what it fetched, and every result is returned.
            if (unknown.length && named.every(([, k]) => !k) && results.size) { history.push(`turn ${turn}: finish named no result title (${unknown.slice(0, 2).map(n => n.slice(0, 40)).join(', ')}${unknown.length > 2 ? ', …' : ''}); every result made is returned`); named.splice(0, named.length, ...[...results.keys()].map(k => [k, k])); }
            else if (unknown.length) throw new Error(`no result titled ${unknown.join(', ')}; results are named by their titles under RESULTS: ${[...results.keys()].join(', ') || 'none'}`);
            const names = [...new Set(named.map(([, k]) => k))];
            if (!names.length && !String(args.note || '').trim()) throw new Error('finish needs result titles, or a note saying what no table holds');
            const tables = names.map(n => results.get(n));
            const note = String(args.note || '').trim();
            const mapping = (args.mapping || []).filter(m => m && m.field && m.table && m.column).map(m => ({ field: String(m.field), table: String(m.table), column: String(m.column) }));
            // A mapped column is a column of the results named, as the result spells it: the study
            // reads the field there.
            const held = [...new Set(tables.flatMap(t => t.columns))];
            const astray = [], resolved = [];
            for (const m of mapping) {
              const column = held.find(c => c === m.column) || held.find(c => c.toLowerCase() === m.column.toLowerCase());
              const start = m.column.replace(/[*.\s]+$/, '').toLowerCase();
              const starting = column ? [] : held.filter(c => start && c.toLowerCase().startsWith(start));
              if (column) resolved.push({ ...m, column });
              else if (starting.length) resolved.push(...starting.map(c => ({ ...m, column: c })));
              else astray.push(m);
            }
            mapping.splice(0, mapping.length, ...resolved);
            if (astray.length) throw new Error(`the mapping names ${astray.map(m => `${m.column} for ${m.field}`).join(', ')}, which no result named has; the columns of ${tables.map(t => `"${t.title}"`).join(', ')}: ${namedColumns(held)}`);
            await emit('complete', 'Investigator done', `${tables.length} result${tables.length === 1 ? '' : 's'}: ${names.join(', ')}${mapping.length ? `. Mapped: ${mapping.map(m => `${m.field} → ${m.table}.${m.column}`).join('; ')}` : ''}${note ? `. ${note}` : ''}`);
            return done({ found: tables.length > 0, status: 'ok', tables, retained: [...results.values()].filter(t => !names.includes(t.name)), mapping, note, opened: [] }, turn);
          }
        } catch (error) {
          if (error instanceof AgentStop) throw error;
          history.push(`turn ${turn}: ${name || 'call'}(${argsLine(args || {})}) failed: ${error.message}`);
          await emit('reasoning_step', 'Correction needed', error.message);
        }
      }
      idle = progressed ? 0 : idle + 1;
      if (idle > 1) throw new AgentStop('no_progress', `Investigator repeated itself without new evidence; it had tried: ${history.slice(-4).map(line => line.replace(/\s*\n\s*/g, ' ').slice(0, 200)).join('; ')}`);
    }
    throw new AgentStop('turn_budget_exhausted', `Investigator used its ${maxTurns} turns without finishing`);
  } catch (error) {
    await emit('error', 'Investigator', error.message);
    const stop = error instanceof AgentStop ? { stop_reason: error.reason, incomplete: true } : {};
    // Stopped before naming its results: every fetched table is returned, the fullest first.
    return done({ found: results.size > 0, status: 'partial', ...stop, error: error.message, tables: [...results.values()].sort((x, y) => y.rows.length - x.rows.length), retained: [], mapping: [], note: `Investigator stopped before finishing: ${error.message}`, opened: [] }, undefined);
  }
}

module.exports = investigatorBulk;
