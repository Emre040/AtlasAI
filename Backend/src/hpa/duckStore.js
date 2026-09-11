'use strict';

/**
 * The release as one DuckDB file beside the TSVs. Every ready table of the active release is a
 * table of the same name, every column text as the file spells it, so a per-gene read, a filtered
 * read of a big table or the values of a column are a query and not a pass over the file.
 *
 * A build is named by what it was built from (every ready file with its size and time): the same
 * set is the same build and is kept; a changed set is built again into a new file, and the
 * metadata file (hpa-<version>.duckdb.json) names the current one and holds each table's source
 * and column profile. Servers open the current build read-only, so any number of processes read
 * it at once, and a build never waits for a server: it writes a new file and switches the
 * pointer. The deployment builds after the files are synced; a server checks again before it
 * answers and builds if it must, one builder at a time.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const duckdb = require('duckdb');
const { columnCard } = require('../system/aso/studyTools');

const MEMORY_LIMIT = process.env.HPA_DUCKDB_MEMORY_LIMIT || '16GB';
const THREADS = Number(process.env.HPA_DUCKDB_THREADS) || 8;
const LOADER_VERSION = 2;             // part of a build's name: a change in how tables load builds again
const PROFILE_VERSION = 2;            // a table's profile is computed again when this changes
const PROFILE_BATCH = 64;             // columns tallied per query, so a wide table stays within memory
const VOCABULARY = 1000;              // distinct values kept for a column, as the row profiler keeps
const SAMPLES = 300;                  // cell values read for a text column's list grammar
const CHUNK = 2000;                   // values per IN list
const BUILD_WAIT_MS = 90 * 60_000;    // how long a start waits for a build running in another process

const tableName = file => file.replace(/\.tsv$/i, '').replace(/[^A-Za-z0-9_]/g, '_');
const quoted = name => `"${String(name).replace(/"/g, '""')}"`;
const literal = text => `'${String(text).replace(/'/g, "''")}'`;
const blank = column => `(${column} IS NULL OR trim(${column}) = '')`;
// A row as the file readers give it: a missing cell is the empty string.
const plain = row => { const out = {}; for (const key of Object.keys(row)) { const v = row[key]; out[key] = v === null || v === undefined ? '' : typeof v === 'bigint' ? Number(v) : v; } return out; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = file => fsp.access(file).then(() => true, () => false);
const readJson = file => fsp.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

const openDatabase = (file, readOnly) => new Promise((resolve, reject) => { const db = new duckdb.Database(file, readOnly ? { access_mode: 'READ_ONLY' } : {}, error => (error ? reject(error) : resolve(db))); });
const closeDatabase = db => new Promise(resolve => db.close(() => resolve()));
const run = (db, sql) => new Promise((resolve, reject) => db.run(sql, error => (error ? reject(error) : resolve())));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))));
const configure = async db => { await run(db, `SET GLOBAL memory_limit = ${literal(MEMORY_LIMIT)}`); await run(db, `SET GLOBAL threads = ${THREADS}`); };

// What a build is made from: every ready TSV of the release, with its size and time.
async function sourcesOf(root, datasets) {
  const sources = [];
  for (const dataset of datasets) {
    if (!dataset.localPath || !/\.tsv$/i.test(dataset.localPath)) continue;
    const stat = await fsp.stat(path.join(root, dataset.localPath));
    sources.push({ file: dataset.localPath, table: tableName(dataset.localPath), size: stat.size, mtime: Math.round(stat.mtimeMs), unpacked_bytes: dataset.unpackedBytes ?? null, downloaded_unix_ms: dataset.downloadedUnixMs ?? null });
  }
  return sources.sort((a, b) => a.file.localeCompare(b.file));
}
const stampOf = sources => crypto.createHash('sha256').update(JSON.stringify([LOADER_VERSION, sources.map(s => [s.file, s.size, s.mtime, s.unpacked_bytes, s.downloaded_unix_ms])])).digest('hex').slice(0, 12);
const sameSource = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

class DuckStore {
  constructor() { this.db = null; this.root = null; this.version = null; this.file = null; this.meta = null; }

  get open() { return this.db !== null; }

  metaPath(root, version) { return path.join(root, `hpa-${version}.duckdb.json`); }

  // The current build for these files, built first if there is none: then opened read-only.
  async ensure({ root, version, datasets, log = () => {} }) {
    if (!root || !version) throw new Error('the release database needs the data root and the active HPA version');
    const sources = await sourcesOf(root, datasets);
    const stamp = stampOf(sources);
    let meta = await this.current(root, version, stamp);
    if (!meta) meta = await this.build({ root, version, sources, stamp, log });
    await this.connect(root, version, meta);
    await this.sweep(root, version, meta.file, log);
    return this.meta;
  }

  async current(root, version, stamp) {
    const meta = await readJson(this.metaPath(root, version));
    return meta && meta.stamp === stamp && meta.file && meta.tables && await exists(path.join(root, meta.file)) ? meta : null;
  }

  // One builder at a time: a second process waits for the first's build rather than making its own.
  async build({ root, version, sources, stamp, log }) {
    const lockPath = path.join(root, `hpa-${version}.duckdb.lock`);
    const started = Date.now();
    for (;;) {
      try { await fsp.writeFile(lockPath, String(process.pid), { flag: 'wx' }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(await fsp.readFile(lockPath, 'utf8').catch(() => '0'));
        if (!pid || !alive(pid)) { await fsp.rm(lockPath, { force: true }); continue; }
        if (Date.now() - started > BUILD_WAIT_MS) throw new Error(`the release database has been building in process ${pid} for over ${Math.round(BUILD_WAIT_MS / 60_000)} minutes`);
        log(`waiting for the build running in process ${pid}`);
        await sleep(5000);
        const done = await this.current(root, version, stamp);
        if (done) return done;
      }
    }
    try {
      const done = await this.current(root, version, stamp);
      if (done) return done;
      const file = `hpa-${version}-${stamp}.duckdb`;
      const building = path.join(root, `${file}.building`);
      await fsp.rm(building, { force: true });
      await fsp.rm(`${building}.wal`, { force: true });
      // A table whose file is unchanged since the previous build is copied from it, not loaded again.
      const previous = await readJson(this.metaPath(root, version));
      const previousFile = previous?.file && previous.file !== file && await exists(path.join(root, previous.file)) ? path.join(root, previous.file) : null;
      log(`building ${file} from ${sources.length} files${previousFile ? `, unchanged tables copied from ${previous.file}` : ''}`);
      const db = await openDatabase(building, false);
      const tables = {};
      try {
        await configure(db);
        if (previousFile) await run(db, `ATTACH ${literal(previousFile)} AS previous (READ_ONLY)`);
        for (const source of sources) {
          const t0 = Date.now();
          const t = quoted(source.table);
          const kept = previousFile ? previous.tables[source.file] : null;
          try {
            if (kept && !kept.error && kept.table === source.table && sameSource(kept.source, source) && kept.profile_version === PROFILE_VERSION && kept.profile) {
              await run(db, `CREATE TABLE ${t} AS SELECT * FROM previous.${t}`);
              tables[source.file] = { ...kept, seconds: Math.round((Date.now() - t0) / 100) / 10 };
              log(`copied ${source.file}: ${Number(kept.rows).toLocaleString('en-US')} rows, ${tables[source.file].seconds} s`);
              continue;
            }
            await run(db, `CREATE TABLE ${t} AS SELECT * FROM read_csv(${literal(path.join(root, source.file))}, delim='\t', header=true, all_varchar=true, quote='"', escape='"', null_padding=true, ignore_errors=false)`);
            const columns = (await all(db, `DESCRIBE ${t}`)).map(r => r.column_name);
            const [{ n }] = await all(db, `SELECT count(*)::DOUBLE AS n FROM ${t}`);
            const profile = await profileTable(db, source.table, columns);
            tables[source.file] = { table: source.table, source, rows: Number(n), columns, profile, profile_version: PROFILE_VERSION, seconds: Math.round((Date.now() - t0) / 100) / 10 };
            log(`loaded ${source.file}: ${Number(n).toLocaleString('en-US')} rows, ${columns.length} columns, ${tables[source.file].seconds} s`);
          } catch (error) {
            await run(db, `DROP TABLE IF EXISTS ${t}`).catch(() => {});
            tables[source.file] = { table: source.table, source, error: error.message };
            log(`failed ${source.file}: ${error.message}`);
          }
        }
        if (previousFile) await run(db, 'DETACH previous').catch(() => {});
        await run(db, 'CHECKPOINT');
      } finally { await closeDatabase(db); }
      await fsp.rename(building, path.join(root, file));
      const meta = { hpa_version: version, stamp, file, built_unix_ms: Date.now(), tables };
      const metaPath = this.metaPath(root, version);
      await fsp.writeFile(`${metaPath}.tmp`, JSON.stringify(meta));
      await fsp.rename(`${metaPath}.tmp`, metaPath);
      const failed = Object.values(tables).filter(t => t.error).length;
      log(`built ${file}: ${Object.keys(tables).length - failed} tables${failed ? `, ${failed} failed` : ''}, ${Math.round((Date.now() - started) / 1000)} s`);
      return meta;
    } finally { await fsp.rm(lockPath, { force: true }); }
  }

  // Builds of this version other than the current one are removed; a process still reading one
  // keeps its handle, so nothing it reads goes away under it.
  async sweep(root, version, current, log) {
    const prefix = `hpa-${version}-`;
    for (const name of await fsp.readdir(root).catch(() => [])) {
      if (!name.startsWith(prefix) || !name.includes('.duckdb') || name === current || name.startsWith(`${current}.`)) continue;
      if (name.endsWith('.building') || name.endsWith('.building.wal')) { if (await exists(path.join(root, `hpa-${version}.duckdb.lock`))) continue; }
      await fsp.rm(path.join(root, name), { force: true });
      log(`removed ${name}: not the current build`);
    }
  }

  async connect(root, version, meta) {
    if (this.db && this.root === root && this.file === meta.file) { this.meta = meta; return; }
    await this.close();
    this.db = await openDatabase(path.join(root, meta.file), true);
    await configure(this.db);
    this.root = root; this.version = version; this.file = meta.file; this.meta = meta;
  }

  async close() {
    if (!this.db) return;
    const db = this.db;
    this.db = null; this.meta = null; this.root = null; this.version = null; this.file = null;
    await closeDatabase(db);
  }

  all(sql) { if (!this.db) throw new Error('the release database is not open'); return all(this.db, sql); }

  // Rows one by one on a connection of their own, so a long read blocks nothing else.
  async *stream(sql) {
    if (!this.db) throw new Error('the release database is not open');
    const connection = this.db.connect();
    try { for await (const row of connection.stream(sql)) yield plain(row); }
    finally { try { connection.close(() => {}); } catch { /* closed with the database */ } }
  }

  tableOf(file) {
    if (!this.db) throw new Error('the release database is not open');
    const t = this.meta?.tables?.[file];
    if (!t || t.error) throw new Error(`${file} is not in the release database${t?.error ? `: ${t.error}` : ''}`);
    return t;
  }

  has(file) { const t = this.meta?.tables?.[file]; return Boolean(t && !t.error); }
  errorOf(file) { return this.meta?.tables?.[file]?.error || 'not loaded'; }
  rowCount(file) { return this.tableOf(file).rows; }
  columnsOf(file) { return this.tableOf(file).columns; }
  profileOf(file) { return this.tableOf(file).profile; }

  // Every row of a table, or those whose column holds one of the values: as the file spells it,
  // case and surrounding space aside, or the same number, which is how the row filter matches.
  rows(file, { where = [] } = {}) {
    const t = this.tableOf(file);
    const clauses = where.map(({ column, values }) => {
      const q = quoted(column);
      const texts = [...new Set(values.map(v => String(v).trim().toLowerCase()))].map(literal);
      const numbers = [...new Set(values.map(v => Number(String(v).replace(/,/g, '').trim())).filter(Number.isFinite))];
      return `(lower(trim(${q})) IN (${texts.join(', ')})${numbers.length ? ` OR TRY_CAST(replace(${q}, ',', '') AS DOUBLE) IN (${numbers.join(', ')})` : ''})`;
    });
    return this.stream(`SELECT * FROM ${quoted(t.table)}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`);
  }

  // The rows whose column holds one of the values, grouped by value; a value with no row has [].
  async rowsBy(file, column, values) {
    const t = this.tableOf(file);
    const out = new Map(values.map(v => [v, []]));
    const unique = [...out.keys()];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const rows = await this.all(`SELECT * FROM ${quoted(t.table)} WHERE ${quoted(column)} IN (${unique.slice(i, i + CHUNK).map(literal).join(', ')})`);
      for (const row of rows) { const key = row[column]; if (out.has(key)) out.get(key).push(plain(row)); }
    }
    return out;
  }

  async sample(file, n = 3) {
    const t = this.tableOf(file);
    return (await this.all(`SELECT * FROM ${quoted(t.table)} LIMIT ${Math.max(1, Number(n) || 3)}`)).map(plain);
  }
}

// The card of every column, from queries: tallies for all columns in one pass, then the distinct
// values with counts of the columns that have few, and sample cells for the rest.
async function profileTable(db, table, columns) {
  const q = columns.map(quoted);
  const t = quoted(table);
  const [{ n }] = await all(db, `SELECT count(*)::DOUBLE AS n FROM ${t}`);
  const agg = { n };
  // Tallies a batch of columns at a time: a table of a thousand columns stays within memory.
  for (let start = 0; start < columns.length; start += PROFILE_BATCH) {
    const tallies = [];
    for (let i = start; i < Math.min(columns.length, start + PROFILE_BATCH); i++) {
      tallies.push(
        `count(*) FILTER (WHERE ${blank(q[i])})::DOUBLE AS ${quoted(`b${i}`)}`,
        `count(*) FILTER (WHERE NOT ${blank(q[i])} AND TRY_CAST(replace(${q[i]}, ',', '') AS DOUBLE) IS NOT NULL)::DOUBLE AS ${quoted(`u${i}`)}`,
        `min(TRY_CAST(replace(${q[i]}, ',', '') AS DOUBLE))::DOUBLE AS ${quoted(`mn${i}`)}`,
        `max(TRY_CAST(replace(${q[i]}, ',', '') AS DOUBLE))::DOUBLE AS ${quoted(`mx${i}`)}`,
        `approx_count_distinct(trim(${q[i]}))::DOUBLE AS ${quoted(`d${i}`)}`
      );
    }
    Object.assign(agg, (await all(db, `SELECT ${tallies.join(', ')} FROM ${t}`))[0]);
  }
  const cards = [];
  for (const [i, c] of columns.entries()) {
    const s = { n: agg.n, blank: agg[`b${i}`], nums: agg[`u${i}`], min: agg[`mn${i}`] ?? Infinity, max: agg[`mx${i}`] ?? -Infinity, distinct: new Map(), samples: [] };
    const filled = s.n - s.blank;
    if (filled > 0) {
      const few = agg[`d${i}`] < VOCABULARY;
      const values = few
        ? await all(db, `SELECT trim(${q[i]}) AS v, count(*)::DOUBLE AS c FROM ${t} WHERE NOT ${blank(q[i])} GROUP BY 1 ORDER BY c DESC, v LIMIT ${VOCABULARY}`)
        : await all(db, `SELECT trim(${q[i]}) AS v, 1::DOUBLE AS c FROM ${t} WHERE NOT ${blank(q[i])} LIMIT ${SAMPLES}`);
      for (const { v, c: count } of values) s.distinct.set(v, (s.distinct.get(v) || 0) + count);
      if (!few) s.distinctCount = Math.max(VOCABULARY, Math.round(agg[`d${i}`]));
      if (s.nums / filled < 0.95) s.samples = values.slice(0, SAMPLES).map(({ v }) => v);
    }
    cards.push(columnCard(c, s));
  }
  return cards;
}

const duckStore = new DuckStore();

module.exports = { DuckStore, duckStore, tableName, sourcesOf, stampOf };
