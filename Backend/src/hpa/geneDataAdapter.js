'use strict';

/**
 * The atlas's per-gene data, presented as a catalog for the investigator agent.
 *
 * The catalog is built from the release itself: every ready table whose rows are keyed by a gene
 * becomes an entry, described by the words the atlas team gave the file (hpa_datasets) and by its
 * own column header. The agent picks tables from this catalog and reads the gene's rows; nothing
 * about pages, sections or which table means what is written here.
 */

const fs = require('node:fs');
const readline = require('node:readline');
const { localData, FILES, parseHeader, parseCells } = require('./localData');
const { duckStore } = require('./duckStore');
const docs = require('./searchDocs');
const { definition, sourceDefinitions } = require('./sourceDefinitions');

const CATALOG_TTL_MS = 5 * 60 * 1000;
const GENE_ID = /^ENS[A-Z]*G\d+/;

let cached = null;

// Read complete header and first data record; a wide raw table has no arbitrary header cutoff.
async function peek(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  try {
    for await (const line of lines) {
      if (header === null) header = parseHeader(line);
      else if (line.length) return { header, first: parseCells(line) };
    }
    return { header: header || [], first: [] };
  } finally { lines.close(); stream.destroy(); }
}

const HUMAN_GENE_ID = /^ENSG\d+/;

// Every table of the active release the agent can read, with the atlas's description and its
// columns. How a table is read follows from its shape: rows keyed by a human gene id in the
// first column (indexed), by a gene name in the first column, by a gene id in a later column
// (streamed), or a reference table with no gene at all (read whole). File size does not change
// whether source evidence is available; readers choose indexed or streaming access by shape.
async function catalog() {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.entries;
  const registry = await localData.refreshRegistry();
  const entries = [];
  for (const dataset of registry.values()) {
    const file = dataset.localPath;
    const base = { file, title: dataset.datasetName || file, description: dataset.description || '', bytes: dataset.unpackedBytes || 0, hpaVersion: dataset.hpaVersion, resource: dataset.resource, sourcePageUrl: dataset.sourcePageUrl, sourceSection: dataset.sourceSection };
    if (!file.endsWith('.tsv')) { entries.push({ ...base, columns: [], key: 'unreadable', why: 'not a table' }); continue; }
    let head;
    try { head = await peek(localData.filePath(file)); }
    catch (error) { entries.push({ ...base, columns: [], key: 'unreadable', why: `source could not be read: ${error.message}` }); continue; }
    const columns = head.header;
    // A file the release database could not load is in the release but not readable here.
    if (!duckStore.has(file)) { entries.push({ ...base, columns, key: 'unreadable', why: `not loaded in the release database: ${duckStore.errorOf(file)}` }); continue; }
    if (file === FILES.master) { entries.push({ ...base, columns, key: 'master' }); continue; }
    const geneColumn = head.first.findIndex(v => HUMAN_GENE_ID.test(v || ''));
    const nameKeyed = /^gene$/i.test(columns[0] || '') && geneColumn === 1;
    if (geneColumn === 0) entries.push({ ...base, columns, key: 'ensembl' });
    else if (nameKeyed) entries.push({ ...base, columns, key: 'name' });
    else if (geneColumn > 0) entries.push({ ...base, columns, key: 'scan', geneColumn: columns[geneColumn] });
    else if (geneColumn < 0 && !GENE_ID.test(head.first[0] || '') && !/^ens/i.test(columns[0] || '')) entries.push({ ...base, columns, key: 'lookup' });
    else entries.push({ ...base, columns, key: 'stream', why: 'not keyed by a human gene; no per-gene reads' });
  }
  const rank = { master: 0, ensembl: 1, name: 1, scan: 1, lookup: 2, stream: 3, unreadable: 4 };
  entries.sort((a, b) => rank[a.key] - rank[b.key] || a.file.localeCompare(b.file));
  cached = { at: Date.now(), entries };
  return entries;
}

// Text for the plan step: one line per table.
async function overview() {
  const entries = await catalog();
  const lines = ['Tables of the Human Protein Atlas release on local disk. Columns are listed as they appear in the file.', '', 'Per-gene tables (rows for the gene are read):'];
  let n = 0;
  for (const e of entries.filter(x => ['master', 'ensembl', 'name', 'scan'].includes(x.key))) {
    // Sample-level tables carry one column per sample; the first few say what they hold.
    const shown = e.key === 'master' || e.columns.length <= 12 ? e.columns : e.columns.slice(0, 12);
    const cols = e.key === 'master' ? `${e.columns.length} columns, one row per gene: ${shown.join(' | ')}` : `columns: ${shown.join(' | ')}${shown.length < e.columns.length ? ` … (${e.columns.length} columns)` : ''}`;
    lines.push(`${++n}. ${e.file} — ${e.title}. ${e.description} ${cols}`);
  }
  lines.push('', 'Reference tables (no gene column; read whole, for names, groups and organs):');
  for (const e of entries.filter(x => x.key === 'lookup')) lines.push(`${++n}. ${e.file} — ${e.title}. ${e.description} columns: ${e.columns.join(' | ')}`);
  const unreadable = entries.filter(x => x.key === 'unreadable');
  if (unreadable.length) {
    lines.push('', 'Present in the release but not readable here (say so if the question needs one):');
    for (const e of unreadable) lines.push(`- ${e.file} — ${e.title}. ${e.description} (${e.why})`);
  }
  lines.push('', 'Category definitions accompany source reads and apply only to their named columns. Shared category labels can have different meanings across assays. Definitions explain category criteria; per-gene validation methods require their own recorded evidence.');
  return lines.join('\n');
}

async function entry(file) {
  const entries = await catalog();
  return entries.find(e => e.file === file || e.file === `${file}.tsv`) || null;
}

async function resolveGene(query) {
  const resolved = await localData.resolveGene(query);
  return resolved ? { gene: resolved.gene, ensembl: resolved.ensembl } : null;
}

async function resolveGenes(queries) {
  return (await localData.resolveGenes(queries)).map(gene => gene ? { gene: gene.gene, ensembl: gene.ensembl } : null);
}

// One source read for a supplied cohort. Full rows stay in the tool layer. Indexed sources
// are indexed once before any gene reads; small unindexed tables are loaded only once.
async function readMany(genes, file) {
  const e = await entry(file);
  if (!e || ['unreadable', 'lookup', 'stream'].includes(e.key)) throw new Error(`No bulk gene read for ${file}${e?.why ? ': ' + e.why : ''}`);
  const result = new Map();
  const unique = [...new Map(genes.map(gene => [gene.ensembl, gene])).values()];
  if (!unique.length) return { entry: e, byGene: result };
  if (e.key === 'master') {
    const master = await localData.master();
    for (const gene of unique) result.set(gene.ensembl, master.byEnsembl.has(gene.ensembl) ? [master.byEnsembl.get(gene.ensembl)] : []);
  } else {
    // Rows keyed by the gene id in the first column, by its name there, or by an id in a later column.
    const found = await duckStore.rowsBy(e.file, geneKeyColumn(e), unique.map(gene => geneKey(e, gene)));
    for (const gene of unique) result.set(gene.ensembl, found.get(geneKey(e, gene)) || []);
  }
  return { entry: e, byGene: result };
}

const geneKeyColumn = e => (e.key === 'scan' ? e.geneColumn : e.columns[0]);
const geneKey = (e, gene) => (e.key === 'name' ? gene.gene : gene.ensembl);
const collect = async iterable => { const out = []; for await (const row of iterable) out.push(row); return out; };

// The gene's rows in one table: a list of rows (each an object column → value); the master
// table retains its declared columns, including fields with no recorded value.
async function read(gene, file) {
  const e = await entry(file);
  if (!e) throw new Error(`no table named "${file}" in the release`);
  if (e.key === 'unreadable') throw new Error(`"${e.file}" is in the release but not readable here: ${e.why}`);
  if (e.key === 'stream') throw new Error(`"${e.file}" has no per-gene reads (${e.why}); filter, aggregate or top_per_group stream it whole`);
  if (e.key === 'master') {
    const master = await localData.master();
    const row = master.byEnsembl.get(gene.ensembl);
    if (!row) return { entry: e, rows: [] };
    return { entry: e, rows: [row] };
  }
  if (e.key === 'lookup') return { entry: e, rows: await collect(duckStore.rows(e.file)) };
  const key = geneKey(e, gene);
  return { entry: e, rows: (await duckStore.rowsBy(e.file, geneKeyColumn(e), [key])).get(key) || [] };
}

// A row filter the plan can attach: { column, op, value } with op one of > >= < <= = != contains.
// Applied by code before rendering, so counts and thresholds are exact and not left to the model.
function applyWhere(reading, where = []) {
  const { entry: e, rows } = reading;
  const { wherePredicate, FILTER_OPS } = require('../system/aso/studyTools');
  const clauses = [];
  for (const w of Array.isArray(where) ? where : []) {
    const column = e.columns.find(c => c.toLowerCase() === String(w?.column || '').toLowerCase());
    const op = String(w?.op || '=').trim();
    if (!column) throw new Error(`filter: no column named "${w?.column}" in ${e.file}`);
    if (!FILTER_OPS.includes(op)) throw new Error(`filter: unknown op "${op}"`);
    clauses.push({ ...w, column, op });
  }
  if (!clauses.length) return { reading, clauses: [] };
  const keep = rows.filter(wherePredicate(e.columns, clauses));
  return { reading: { entry: e, rows: keep, unfiltered: rows.length, clauses }, clauses };
}

// Source views are complete unless the caller requests focus or a page. The exact view is
// retained for citation validation, so unseen rows never count as evidence the agent read.
function render(reading, focus = [], options = {}) {
  const { entry: e, rows } = reading;
  const { isMissing } = require('../system/aso/studyTools');
  const filtered = reading.unfiltered !== undefined ? `${rows.length} of ${reading.unfiltered} rows match ${reading.clauses.map(c => `${c.column} ${c.op}${Object.hasOwn(c, 'value') ? ` ${c.value}` : c.column_b ? ` ${c.column_b}` : ''}`).join(' and ')}` : null;
  const words = focus.map(f => String(f).toLowerCase()).filter(Boolean);
  const offset = options.offset === undefined ? 0 : options.offset;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Source view offset must be a nonnegative integer');
  if (options.rows !== undefined && (!Number.isSafeInteger(options.rows) || options.rows < 1)) throw new Error('Source view rows must be a positive integer');
  const available = e.columns;
  const cols = options.columns || available.filter(c => e.key === 'master' || (!/^gene$/i.test(c) && !/^gene name$/i.test(c) && c !== e.geneColumn));
  if (!Array.isArray(cols) || cols.some(c => !available.includes(c))) throw new Error(`Source view columns must exist in ${e.file}`);
  const columnFocus = !options.columns && words.length ? cols.filter(c => words.some(w => c.toLowerCase().includes(w))) : [];
  const viewColumns = columnFocus.length ? columnFocus : cols;
  const matches = words.length && !columnFocus.length ? rows.filter(r => viewColumns.some(c => words.some(w => String(r[c] ?? '').toLowerCase().includes(w)))) : rows;
  const shown = matches.slice(offset, options.rows === undefined ? undefined : offset + options.rows);
  reading.shownColumns = viewColumns;
  reading.shownRows = shown;
  const definitions = sourceDefinitions(e, shown, [], viewColumns);
  const definitionsText = Object.keys(definitions.definitions).length || definitions.unavailable_definitions ? `\nSource column definitions: ${JSON.stringify(definitions)}` : '';
  const complete = shown.length === rows.length && viewColumns.length === cols.length;
  if (!rows.length) return { text: `${e.file}: ${filtered || 'no rows for this gene'}.`, shown: 0, total: reading.unfiltered ?? 0, matching: 0, complete: true, next_offset: null };
  if (e.key === 'master') {
    const lines = shown.flatMap(row => viewColumns.map(k => `${k}: ${isMissing(row[k]) ? '[not recorded]' : row[k]}`));
    return { text: `${e.file} (one row per gene; ${viewColumns.length}/${available.length} columns shown):\n${lines.join('\n')}${definitionsText}`, shown: shown.length, total: rows.length, matching: matches.length, complete, next_offset: offset + shown.length < matches.length ? offset + shown.length : null };
  }
  const notes = [];
  if (filtered) notes.push(filtered);
  if (matches.length < rows.length) notes.push(`${matches.length} of ${rows.length} rows mention ${words.map(w => `"${w}"`).join(', ')}`);
  else if (!filtered) notes.push(`${rows.length} rows`);
  if (offset || shown.length < matches.length) notes.push(`showing ${shown.length} rows at offset ${offset} of ${matches.length} matching rows`);
  if (viewColumns.length < cols.length) notes.push(`showing ${viewColumns.length}/${cols.length} columns matching focus`);
  const lines = shown.map(r => viewColumns.map(c => r[c]).join(' | '));
  return { text: `${e.file} (${notes.join('; ')})\ncolumns: ${viewColumns.join(' | ')}\n${lines.join('\n')}${definitionsText}`, shown: shown.length, total: rows.length, matching: matches.length, complete, next_offset: offset + shown.length < matches.length ? offset + shown.length : null };
}

// Require an actual shown row/field and its value. Empty fields, partial fragments, and a value
// copied from a different row cannot validate a citation.
function cited(reading, citation, value = null) {
  const needle = String(citation || '').trim().toLowerCase();
  if (!needle) return false;
  const { num, isMissing } = require('../system/aso/studyTools');
  const e = reading.entry, rows = reading.shownRows || [], cols = reading.shownColumns || [];
  const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase() || (num(a) !== null && num(a) === num(b));
  if (e.key === 'master') {
    const citedLines = needle.split('\n').map(line => line.trim()).filter(Boolean);
    const fields = rows.flatMap(row => cols.filter(k => !isMissing(row[k])).map(k => ({ text: `${k}: ${row[k]}`.toLowerCase(), value: row[k] })));
    return citedLines.every(line => fields.some(field => field.text === line)) && (value === null || value === undefined || fields.some(field => citedLines.includes(field.text) && same(field.value, value)));
  }
  const citedCells = needle.split('|').map(s => s.trim());
  return rows.some(row => {
    const cells = cols.map(c => row[c]);
    const fullLine = cells.map(cell => String(cell ?? '').trim().toLowerCase()).join(' | ');
    const matches = fullLine === needle || (citedCells.length === cells.length && citedCells.every((cell, i) => same(cell, cells[i])));
    return matches && cells.some(cell => !isMissing(cell)) && (value === null || value === undefined || cells.some(cell => !isMissing(cell) && same(cell, value)));
  });
}

function pageUrl(gene) { return `https://www.proteinatlas.org/${gene.ensembl}-${gene.gene}`; }

// What the database is and what one row of a per-entity table is about. The agents' prompts
// take their nouns from here; nothing about the atlas is written into them.
function identity() {
  return { database: 'Human Protein Atlas', entity: 'gene', keys: ['gene', 'ensembl'], key_description: 'gene symbol and Ensembl gene id', release: platformRelease() };
}

function platformRelease() {
  try { return require('../policy/config').platformConfig().activeHpaVersion || null; } catch { return null; }
}

// How a table is read, in words the agent can act on.
function access(e) {
  if (e.key === 'master') return 'one row per gene';
  if (['ensembl', 'name', 'scan'].includes(e.key)) return 'rows per gene';
  if (e.key === 'lookup') return 'reference table, no gene column';
  if (e.key === 'stream') return `large sample table: ${e.why}`;
  return e.why || e.key;
}

// The values a table's columns take: kind, range, distinct values (listed in full when few),
// examples, blanks and list grammar, over every row of the table, as the release database
// recorded them when the table was loaded.
async function profile(e, columns = e.columns) {
  const wanted = new Set(columns);
  return { columns: duckStore.profileOf(e.file).filter(c => wanted.has(c.column)), rows: duckStore.rowCount(e.file), capped: false, at: Date.now() };
}

// The first rows of a table as they are in the file.
async function sample(e, n = 3) {
  return duckStore.sample(e.file, n);
}

// How many rows a table holds.
async function rowCount(e) {
  return duckStore.rowCount(e.file);
}

// Whether a value is spelled like an id of the database's entity.
function isEntityId(value) {
  return HUMAN_GENE_ID.test(String(value || ''));
}

// How many rows of a table hold one of the values in a column.
async function holds(e, column, values) {
  return duckStore.holds(e.file, column, values);
}

// Rows of a text column of a table containing a word: how many, and a few of the values.
async function textHits(e, column, word, limit = 4) {
  return duckStore.textHits(e.file, column, word, limit);
}

// Where a value lives: every column of every readable table whose recorded values, or the items
// inside its list cells, contain the word (a category, a sample, a name), with the spellings
// found. A word that is a value is not a table; this is how the table and the spelling are found.
async function findValues(word) {
  const flat = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const needle = flat(word);
  if (needle.length < 2) return [];
  const hits = [];
  for (const e of await catalog()) {
    if (e.key === 'unreadable' || !duckStore.has(e.file)) continue;
    for (const card of duckStore.profileOf(e.file)) {
      for (const [values, inside] of [[card.observed_values, false], [card.parts?.values, true]]) {
        if (!Array.isArray(values)) continue;
        const found = values.filter(v => flat(v).includes(needle));
        if (found.length) hits.push({ file: e.file, column: card.column, inside, values: found.slice(0, 6), more: Math.max(0, found.length - 6) });
      }
      if (hits.length >= 20) return hits;
    }
  }
  return hits;
}

// The entity keys of a raw row of a table, as the table records them.
function keysOf(e, row) {
  const isId = v => HUMAN_GENE_ID.test(String(v || ''));
  if (e.key === 'name') return { gene: row[e.columns[0]] || null, ensembl: row[e.columns[1]] || null };
  const column = e.geneColumn || e.columns.find(c => isId(row[c]));
  const name = row['Gene name'] ?? (isId(row.Gene) ? null : row.Gene) ?? null;
  return { gene: name || null, ensembl: column ? row[column] || null : null };
}

// Every row of a table, whatever its shape, or the rows whose named columns hold given values
// (where: [{ column, values }]), read from the release database.
async function* rows(e, { where = [] } = {}) {
  yield* duckStore.rows(e.file, { where });
}

// Every entity of the database: the universe an overlap test is measured against.
async function entities() {
  return (await localData.master()).rows.map(row => ({ gene: row.Gene || null, ensembl: row.Ensembl || null }));
}

module.exports = { name: 'Human Protein Atlas per-gene tables', identity, access, catalog, overview, entry, resolveGene, resolveGenes, read, readMany, keysOf, rows, entities, applyWhere, render, cited, pageUrl, definition, profile, sample, rowCount, findValues, holds, textHits, isEntityId, sources: docs.SOURCES };
