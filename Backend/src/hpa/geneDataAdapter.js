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
const fsp = require('node:fs/promises');
const { localData, FILES } = require('./localData');
const docs = require('./searchDocs');

const MAX_FILE_BYTES = 1.6e9;   // larger tables are sample-level exports; indexing them per request is not interactive
const CATALOG_TTL_MS = 5 * 60 * 1000;
const GENE_ID = /^ENS[A-Z]*G\d+/;

let cached = null;

function stripBom(s) { return s.replace(/^﻿/, ''); }
function unquote(cell) { return cell.length >= 2 && cell.startsWith('"') && cell.endsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell; }

// Header and first data line of a table, without reading the file.
async function peek(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(16384);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
    return { header: stripBom(lines[0] || '').split('\t').map(unquote), first: (lines[1] || '').split('\t').map(unquote) };
  } finally { await handle.close(); }
}

const MAX_SCAN_BYTES = 150e6;   // a table whose gene column is not the first is read whole and filtered
const MAX_LOOKUP_BYTES = 2e6;   // small reference tables (tissue → organ, cell type → lineage) are readable whole
const HUMAN_GENE_ID = /^ENSG\d+/;

// Every table of the active release the agent can read, with the atlas's description and its
// columns. How a table is read follows from its shape: rows keyed by a human gene id in the
// first column (indexed), by a gene name in the first column, by a gene id in a later column
// (scanned), or a small reference table with no gene at all (read whole). Larger files are listed
// as present but not readable here, so the agent can say so instead of guessing.
async function catalog() {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.entries;
  const registry = await localData.refreshRegistry();
  const entries = [];
  for (const dataset of registry.values()) {
    const file = dataset.localPath;
    const base = { file, title: dataset.datasetName || file, description: dataset.description || '', bytes: dataset.unpackedBytes || 0 };
    if (!file.endsWith('.tsv')) { entries.push({ ...base, columns: [], key: 'unreadable', why: 'not a table' }); continue; }
    let head;
    try { head = await peek(localData.filePath(file)); } catch { continue; }
    const columns = head.header;
    // Too large to index per gene; it still streams through filter, aggregate and top_per_group.
    if (base.bytes > MAX_FILE_BYTES) { entries.push({ ...base, columns, key: 'stream', why: `${Math.round(base.bytes / 1e9)} GB sample-level export; no per-gene reads` }); continue; }
    if (file === FILES.master) { entries.push({ ...base, columns, key: 'master' }); continue; }
    const geneColumn = head.first.findIndex(v => HUMAN_GENE_ID.test(v || ''));
    const nameKeyed = /^gene$/i.test(columns[0] || '') && geneColumn === 1;
    if (geneColumn === 0) entries.push({ ...base, columns, key: 'ensembl' });
    else if (nameKeyed) entries.push({ ...base, columns, key: 'name' });
    else if (geneColumn > 0 && base.bytes <= MAX_SCAN_BYTES) entries.push({ ...base, columns, key: 'scan', geneColumn: columns[geneColumn] });
    else if (geneColumn < 0 && !GENE_ID.test(head.first[0] || '') && base.bytes <= MAX_LOOKUP_BYTES && !/^ens/i.test(columns[0] || '')) entries.push({ ...base, columns, key: 'lookup' });
    else entries.push({ ...base, columns, key: 'stream', why: geneColumn < 0 ? 'not keyed by a gene; no per-gene reads' : 'too large to scan for one gene; no per-gene reads' });
  }
  const rank = { master: 0, ensembl: 1, name: 1, scan: 1, lookup: 2, stream: 3, unreadable: 4 };
  entries.sort((a, b) => rank[a.key] - rank[b.key] || a.file.localeCompare(b.file));
  cached = { at: Date.now(), entries };
  return entries;
}

function definition(name) { return docs.OPTIONS[name] || ''; }

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
  lines.push('', 'Category terms the atlas uses in these tables:', ...Object.entries(docs.OPTIONS).filter(([k]) => /enriched|enhanced|specificity|detected|highest|Tau|prognostic|Enhanced|Supported|Approved|Uncertain|^High$|^Medium$|^Low$|location/i.test(k)).map(([k, v]) => `- ${k}: ${v}`));
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
  } else if (e.key === 'scan') {
    const wanted = new Set(unique.map(gene => gene.ensembl));
    for (const gene of unique) result.set(gene.ensembl, []);
    for (const row of (await localData.table(e.file)).rows) {
      if (wanted.has(row[e.geneColumn])) result.get(row[e.geneColumn]).push(row);
    }
  } else {
    await localData.geneIndex(e.file);
    const queue = [...unique];
    await Promise.all(Array.from({ length: Math.min(8, unique.length) }, async () => {
      while (queue.length) {
        const gene = queue.shift();
        result.set(gene.ensembl, await localData.geneRows(e.file, e.key === 'ensembl' ? gene.ensembl : gene.gene));
      }
    }));
  }
  return { entry: e, byGene: result };
}

// The gene's rows in one table: a list of rows (each an object column → value); the master
// table yields its single row with empty cells dropped.
async function read(gene, file) {
  const e = await entry(file);
  if (!e) throw new Error(`no table named "${file}" in the release`);
  if (e.key === 'unreadable') throw new Error(`"${e.file}" is in the release but not readable here: ${e.why}`);
  if (e.key === 'stream') throw new Error(`"${e.file}" has no per-gene reads (${e.why}); filter, aggregate or top_per_group stream it whole`);
  if (e.key === 'master') {
    const master = await localData.master();
    const row = master.byEnsembl.get(gene.ensembl);
    if (!row) return { entry: e, rows: [] };
    const kept = Object.fromEntries(Object.entries(row).filter(([, v]) => String(v ?? '').trim() !== '' && v !== 'NA'));
    return { entry: e, rows: [kept] };
  }
  if (e.key === 'lookup') return { entry: e, rows: (await localData.table(e.file)).rows };
  if (e.key === 'scan') {
    const table = await localData.table(e.file);
    return { entry: e, rows: table.rows.filter(r => r[e.geneColumn] === gene.ensembl) };
  }
  const rows = await localData.geneRows(e.file, e.key === 'ensembl' ? gene.ensembl : gene.gene);
  return { entry: e, rows };
}

// A row filter the plan can attach: { column, op, value } with op one of > >= < <= = != contains.
// Applied by code before rendering, so counts and thresholds are exact and not left to the model.
function applyWhere(reading, where = []) {
  const { entry: e, rows } = reading;
  const clauses = [];
  for (const w of Array.isArray(where) ? where : []) {
    const column = e.columns.find(c => c.toLowerCase() === String(w?.column || '').toLowerCase());
    const op = String(w?.op || '=').trim();
    if (!column || !['>', '>=', '<', '<=', '=', '!=', 'contains'].includes(op)) continue;
    clauses.push({ column, op, value: w.value });
  }
  if (!clauses.length) return { reading, clauses: [] };
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const keep = rows.filter(r => clauses.every(({ column, op, value }) => {
    const cell = r[column];
    if (op === 'contains') return String(cell ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    if (op === '=' || op === '!=') { const same = String(cell ?? '').toLowerCase() === String(value ?? '').toLowerCase() || (num(cell) !== null && num(cell) === num(value)); return op === '=' ? same : !same; }
    const a = num(cell), b = num(value);
    if (a === null || b === null) return false;
    return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
  }));
  return { reading: { entry: e, rows: keep, unfiltered: rows.length, clauses }, clauses };
}

// Compact text of the rows for the answer step; a focus keeps only rows mentioning any of the
// given words when that leaves something, so a 1,200-row table does not have to be read whole.
const MAX_ROWS_SHOWN = 400;
const MAX_COLUMNS_SHOWN = 40;

function render(reading, focus = []) {
  const { entry: e, rows } = reading;
  const filtered = reading.unfiltered !== undefined ? `${rows.length} of ${reading.unfiltered} rows match ${reading.clauses.map(c => `${c.column} ${c.op} ${c.value}`).join(' and ')}` : null;
  if (!rows.length) return { text: `${e.file}: ${filtered || 'no rows for this gene'}.`, shown: 0, total: reading.unfiltered ?? 0 };
  if (e.key === 'master') {
    const row = rows[0];
    return { text: `${e.file} (one row per gene):\n${Object.entries(row).map(([k, v]) => `${k}: ${v}`).join('\n')}`, shown: 1, total: 1 };
  }
  const words = focus.map(f => String(f).toLowerCase()).filter(Boolean);
  const matches = words.length ? rows.filter(r => Object.values(r).some(v => words.some(w => String(v).toLowerCase().includes(w)))) : rows;
  let shown = matches.length ? matches : rows;
  const notes = [];
  if (filtered) notes.push(filtered);
  if (matches.length && matches.length < rows.length) notes.push(`${matches.length} of ${rows.length} rows, those mentioning ${words.map(w => `"${w}"`).join(', ')}`);
  else if (!filtered) notes.push(`${rows.length} rows`);
  if (shown.length > MAX_ROWS_SHOWN) { shown = shown.slice(0, MAX_ROWS_SHOWN); notes.push(`only the first ${MAX_ROWS_SHOWN} shown; narrow with focus words for the rest`); }
  let cols = e.columns.filter(c => !/^gene$/i.test(c) && !/^gene name$/i.test(c) && c !== e.geneColumn);
  if (cols.length > MAX_COLUMNS_SHOWN) {
    // A wide table has one column per sample; the columns whose names mention a focus word come first.
    const wanted = cols.filter(c => words.some(w => c.toLowerCase().includes(w)));
    const rest = cols.filter(c => !wanted.includes(c));
    cols = [...wanted, ...rest].slice(0, MAX_COLUMNS_SHOWN);
    notes.push(`${cols.length} of ${e.columns.length} columns shown${wanted.length ? `, those mentioning ${words.map(w => `"${w}"`).join(', ')} first` : ''}`);
  }
  reading.shownColumns = cols;   // the citation check must look at the same columns the model saw
  const lines = shown.map(r => cols.map(c => r[c]).join(' | '));
  return { text: `${e.file} (${notes.join('; ')})\ncolumns: ${cols.join(' | ')}\n${lines.join('\n')}`, shown: shown.length, total: rows.length };
}

// Whether a cited row really is one of the rows shown to the model: the whole line, or most of
// its cells (a 40-column row copied with a number reformatted still counts; an invented row does not).
function cited(reading, citation, value = null) {
  const needle = String(citation || '').trim().toLowerCase();
  if (!needle) return false;
  const { entry: e, rows } = reading;
  if (e.key === 'master') return Object.entries(rows[0] || {}).some(([k, v]) => needle.includes(String(v).toLowerCase()) || `${k}: ${v}`.toLowerCase() === needle);
  const cols = reading.shownColumns || e.columns.filter(c => !/^gene$/i.test(c) && !/^gene name$/i.test(c) && c !== e.geneColumn).slice(0, MAX_COLUMNS_SHOWN);
  const citedCells = needle.split('|').map(s => s.trim()).filter(Boolean);
  // The value must sit in the cited row when it is a cell of the table; a derived value (a
  // count, a ratio) is not a cell anywhere and is not held against the citation.
  const literal = value === null || value === undefined ? null : String(value).trim().toLowerCase();
  const isCell = literal !== null && rows.some(r => cols.some(c => { const x = String(r[c] ?? '').trim().toLowerCase(); return x === literal || (Number.isFinite(Number(literal)) && x !== '' && Number(x) === Number(literal)); }));
  const wanted = isCell ? literal : null;
  return rows.some(r => {
    const cells = cols.map(c => String(r[c] ?? '').trim().toLowerCase());
    const line = cells.join(' | ');
    if (line === needle || needle.includes(line) || line.includes(needle)) return true;
    if (citedCells.length < 2) return false;
    const hits = citedCells.filter(c => cells.includes(c) || cells.some(x => x && (Number(x) === Number(c) && Number.isFinite(Number(c))))).length;
    const enough = hits >= Math.ceil(citedCells.length * 0.6);
    return enough && (wanted === null || cells.some(x => x === wanted || (Number.isFinite(Number(wanted)) && Number(x) === Number(wanted))));
  });
}

function pageUrl(gene) { return `https://www.proteinatlas.org/${gene.ensembl}-${gene.gene}`; }

module.exports = { name: 'Human Protein Atlas per-gene tables', catalog, overview, entry, resolveGene, resolveGenes, read, readMany, applyWhere, render, cited, pageUrl, definition, sources: docs.SOURCES };
