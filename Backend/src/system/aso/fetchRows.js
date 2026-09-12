'use strict';

/**
 * fetch: the one retrieval operation of the Investigator. Given one table of the database it
 * returns one relation of raw rows: for a list of points (the database's entities, or the values
 * of any column), one row per source row that matches each point, carrying the point, the
 * requested fields as recorded, how many rows matched and why a row is empty when none did; or,
 * without a list, every row a filter selects. Nothing is aggregated, ranked or computed here; the
 * study does that with its own operations. The database's own reader supplies the rows.
 */

const { wherePredicate, withColumns, isMissing, inList, listSeparator } = require('./studyTools');
const { namedColumns } = require('./desk');

const STATUS = Object.freeze({ ok: 'ok', noRows: 'no rows in table', noMatch: 'no rows match filter', notInRelease: 'not in release' });
const MAX_HELD_ROWS = 1000000;   // rows one result may hold; a larger selection needs a filter or a list of points

function resolveColumn(entry, name) {
  const found = entry.columns.find(c => c === name) || entry.columns.find(c => c.toLowerCase() === String(name).toLowerCase());
  if (!found) throw new Error(`${entry.file} has no column ${JSON.stringify(name)}; its columns: ${namedColumns(entry.columns)}`);
  return found;
}

const resolveColumns = (entry, names) => [...new Set(names.flatMap(name => {
  const exact = entry.columns.find(c => c === name) || entry.columns.find(c => c.toLowerCase() === String(name).toLowerCase());
  if (exact) return [exact];
  const starting = entry.columns.filter(c => c.toLowerCase().startsWith(String(name).toLowerCase()));
  return starting.length ? starting : [resolveColumn(entry, name)];
}))];

// Columns whose values are the entity's own keys carry nothing the key columns do not.
function identityColumns(entry, sampleRows, keys) {
  const values = new Set(keys.map(v => String(v ?? '').toLowerCase()).filter(Boolean));
  return entry.columns.filter(column => sampleRows.length > 0 && sampleRows.every(row => values.has(String(row[column] ?? '').toLowerCase())));
}

// Which key each identity column repeats: { 'Gene name': 'gene', 'ENSG ID': 'ensembl' }.
function identityKeysOf(identity, row, keys, keyValues) {
  const out = {};
  for (const column of identity) {
    const value = String(row?.[column] ?? '').toLowerCase();
    const key = keys.find((k, i) => String(keyValues[i] ?? '').toLowerCase() === value);
    if (key) out[column] = key;
  }
  return out;
}

const nullFields = wanted => Object.fromEntries(wanted.map(c => [c, null]));
const pick = (row, wanted) => Object.fromEntries(wanted.map(c => [c, isMissing(row[c]) ? null : row[c]]));

// The rows of the entities in the list, read by the database's per-entity reader.
async function fetchRows({ adapter, entry, supplied, resolved, fields, where = [], keys }) {
  if (!entry) throw new Error('fetch needs a table');
  if (['unreadable', 'lookup', 'stream'].includes(entry.key)) throw new Error(`${entry.file} has no per-${keys.entity} reads (${adapter.access(entry)}); match the points against one of its columns, or fetch without a list and a where filter`);
  if (where !== undefined && !Array.isArray(where)) throw new Error('where must be an array of { column, op, value } clauses');
  const predicate = wherePredicate(entry.columns, where || []);
  // The list is keyed by resolved identity; a name that appears twice is one entity.
  const entities = [], seen = new Set();
  for (const [index, gene] of resolved.entries()) {
    const id = gene ? gene.ensembl : `unresolved:${String(supplied[index]).toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entities.push({ supplied: supplied[index], gene });
  }
  const source = await adapter.readMany(entities.map(e => e.gene).filter(Boolean), entry.file);
  const firstRows = [...source.byGene.values()].find(rows => rows.length) || [];
  const firstGene = entities.find(e => e.gene && source.byGene.get(e.gene.ensembl)?.length)?.gene;
  const identity = identityColumns(entry, firstRows.slice(0, 1), firstGene ? [firstGene.gene, firstGene.ensembl] : []);
  const wanted = (Array.isArray(fields) && fields.length ? resolveColumns(entry, fields) : entry.columns).filter(c => !identity.includes(c));
  const [geneKey, idKey] = keys.columns;
  const columns = [geneKey, idKey, ...wanted.filter(c => c !== geneKey && c !== idKey), 'source_rows', 'source_status'];
  const out = [];
  const coverage = { supplied: supplied.length, entities: entities.length, resolved: 0, with_rows: 0, no_rows: 0, no_match: 0, not_in_release: 0, rows: 0 };
  for (const { supplied: name, gene } of entities) {
    const base = { [geneKey]: gene ? gene.gene : name, [idKey]: gene ? gene.ensembl : null };
    if (!gene) { coverage.not_in_release++; out.push({ ...base, ...nullFields(wanted), source_rows: 0, source_status: STATUS.notInRelease }); continue; }
    coverage.resolved++;
    const all = source.byGene.get(gene.ensembl) || [];
    const rows = all.filter(predicate);
    if (!rows.length) {
      if (all.length) coverage.no_match++; else coverage.no_rows++;
      out.push({ ...base, ...nullFields(wanted), source_rows: 0, source_status: all.length ? STATUS.noMatch : STATUS.noRows });
      continue;
    }
    coverage.with_rows++;
    for (const row of rows) {
      coverage.rows++;
      out.push({ ...base, ...pick(row, wanted), source_rows: rows.length, source_status: STATUS.ok });
    }
  }
  return { rows: withColumns(out, columns), columns, coverage, fields: wanted, identity_columns: identity, identity_keys: identityKeysOf(identity, firstRows[0], keys.columns, firstGene ? [firstGene.gene, firstGene.ensembl] : []) };
}

// The rows whose value in one column is one of the points: the points are any values (tissues,
// cell lines, categories), matched case-insensitively; a list column holds a point as one of
// its items. Rows of an entity-keyed table also carry the entity keys.
async function fetchMatching({ adapter, entry, points, fields, where = [], match, keys, aliases = null }) {
  if (!entry) throw new Error('fetch needs a table');
  if (entry.key === 'unreadable') throw new Error(`${entry.file} is in the release but not readable here`);
  // One column, or several when a point may sit in any of them (the two sides of a pair table);
  // with several, the result names the point in a column of its own and the other side in other,
  // and the sides themselves are not repeated: which side held the point says nothing.
  const matchColumns = (Array.isArray(match) ? match : [match]).map(name => resolveColumn(entry, name));
  const paired = matchColumns.length > 1;
  const column = paired ? 'point' : matchColumns[0];
  const cards = typeof adapter.profile === 'function' ? (await adapter.profile(entry).catch(() => null))?.columns || [] : [];
  const separators = Object.fromEntries(matchColumns.map(c => [c, listSeparator(cards.find(card => card.column === c))]).filter(([, sep]) => sep));
  const itemsOf = (cell, sep) => sep && cell !== null && cell !== undefined ? String(cell).split(sep) : [cell];
  const predicate = wherePredicate(entry.columns, where || []);
  const keyed = !['lookup', 'stream'].includes(entry.key) && !paired;
  const [geneKey, idKey] = keys.columns;
  const keyColumns = keyed ? [geneKey, idKey].filter(c => c !== column) : [];
  const unique = [...new Map(points.map(p => [String(p).trim().toLowerCase(), String(p).trim()])).entries()];
  const byPoint = new Map(unique.map(([key]) => [key, []]));
  // A point may be spelled otherwise in the column (an entity by its id where the point is its
  // name): every alias of a point finds the point's rows.
  const keyOfValue = new Map(unique.map(([key]) => [key, key]));
  for (const [key, point] of unique) for (const alias of (aliases?.get(point) || [])) keyOfValue.set(String(alias).trim().toLowerCase(), key);
  const spellings = [...keyOfValue.keys()];
  // The read is narrowed at the source to rows where any match column holds a point; the rows
  // are then matched here as before, so what is kept is exactly what matches.
  for await (const row of adapter.rows(entry, { where: [{ columns: matchColumns, values: spellings, ...(Object.keys(separators).length ? { separators } : {}) }] })) {
    const seen = new Set();
    for (const c of matchColumns) for (const item of itemsOf(row[c], separators[c])) {
      const key = keyOfValue.get(String(item ?? '').trim().toLowerCase());
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      byPoint.get(key).push(row);
    }
  }
  const first = [...byPoint.values()].find(rows => rows.length)?.[0];
  const firstKeys = keyed && first ? adapter.keysOf(entry, first) : {};
  const identity = keyed && first ? identityColumns(entry, [first], [firstKeys[geneKey], firstKeys[idKey]]) : [];
  const wanted = (Array.isArray(fields) && fields.length ? resolveColumns(entry, fields) : entry.columns).filter(c => !identity.includes(c) && c !== column && !(paired && matchColumns.includes(c)));
  // A point matched against several columns of a pair table: the side that is not the point is
  // named in a column of its own, so the point's counterparts are that column and never the
  // point itself.
  const columns = [column, ...(paired ? ['other'] : []), ...keyColumns, ...wanted.filter(c => !keyColumns.includes(c)), 'source_rows', 'source_status'];
  const otherOf = (row, key) => matchColumns.map(c => row[c]).find(v => keyOfValue.get(String(v ?? '').trim().toLowerCase()) !== key) ?? null;
  // The point is shown as the column spells it, when the column holds it whole.
  const spelledAs = (all, point) => !paired && all.length && !separators[column] ? all[0][column] : point;
  const out = [];
  const coverage = { supplied: points.length, entities: unique.length, with_rows: 0, no_rows: 0, no_match: 0, rows: 0 };
  for (const [key, point] of unique) {
    const all = byPoint.get(key);
    const rows = all.filter(predicate);
    const base = { [column]: spelledAs(all, point), ...(paired ? { other: null } : {}) };
    if (!rows.length) {
      if (all.length) coverage.no_match++; else coverage.no_rows++;
      out.push({ ...base, ...Object.fromEntries(keyColumns.map(c => [c, null])), ...nullFields(wanted), source_rows: 0, source_status: all.length ? STATUS.noMatch : STATUS.noRows });
      continue;
    }
    coverage.with_rows++;
    // A pair table lists a pair from both sides; the pair is one row, whichever side held the point.
    const seenOther = new Set();
    const kept = paired ? rows.filter(row => { const o = String(otherOf(row, key) ?? '').trim().toLowerCase(); if (seenOther.has(o)) return false; seenOther.add(o); return true; }) : rows;
    for (const row of kept) {
      coverage.rows++;
      const ids = keyed ? adapter.keysOf(entry, row) : {};
      out.push({ ...base, ...(paired ? { other: otherOf(row, key) } : {}), ...Object.fromEntries(keyColumns.map(c => [c, ids[c] ?? null])), ...pick(row, wanted), source_rows: kept.length, source_status: STATUS.ok });
    }
  }
  return { rows: withColumns(out, columns), columns, coverage, fields: wanted, match: column, identity_columns: identity, identity_keys: identityKeysOf(identity, first, keys.columns, [firstKeys[geneKey], firstKeys[idKey]]) };
}

// Every row a filter selects, without a list. Rows of an entity-keyed table carry the entity keys.
async function fetchAll({ adapter, entry, fields, where = [], keys }) {
  if (!entry) throw new Error('fetch needs a table');
  if (entry.key === 'unreadable') throw new Error(`${entry.file} is in the release but not readable here`);
  if (where !== undefined && !Array.isArray(where)) throw new Error('where must be an array of { column, op, value } clauses');
  const predicate = wherePredicate(entry.columns, where || []);
  const keyed = !['lookup', 'stream'].includes(entry.key);
  const keyColumns = keyed ? keys.columns : [];
  // Equality and membership clauses on named columns narrow the read at the source; the predicate
  // then decides every row it gets, so what is kept is exactly what the filter keeps.
  const narrowing = (where || []).map(clause => {
    const column = entry.columns.find(c => c === clause?.column) || entry.columns.find(c => c.toLowerCase() === String(clause?.column || '').toLowerCase());
    if (!column || !['=', 'in'].includes(clause.op) || clause.value === null || clause.value === undefined) return null;
    const values = clause.op === 'in' ? inList(clause.value) : [clause.value];
    return values.length ? { column, values } : null;
  }).filter(Boolean);
  const selected = [];
  let scanned = 0;
  for await (const row of adapter.rows(entry, { where: narrowing })) {
    scanned++;
    if (!predicate(row)) continue;
    selected.push(row);
    if (selected.length > MAX_HELD_ROWS) throw new Error(`${entry.file}: more than ${MAX_HELD_ROWS.toLocaleString('en-US')} rows selected, more than a result can hold; add a where filter, or a list of points`);
  }
  const firstKeys = keyed && selected.length ? adapter.keysOf(entry, selected[0]) : {};
  const identity = keyed && selected.length ? identityColumns(entry, [selected[0]], keyColumns.map(c => firstKeys[c])) : [];
  const wanted = (Array.isArray(fields) && fields.length ? resolveColumns(entry, fields) : entry.columns).filter(c => !identity.includes(c));
  const columns = [...keyColumns, ...wanted.filter(c => !keyColumns.includes(c))];
  const out = selected.map(row => ({ ...(keyed ? adapter.keysOf(entry, row) : {}), ...pick(row, wanted) }));
  // The table's size is what the selection is measured against, however the read was narrowed.
  const total = narrowing.length && typeof adapter.rowCount === 'function' ? await adapter.rowCount(entry) : scanned;
  return { rows: withColumns(out, columns), columns, coverage: { rows: out.length, scanned: total }, fields: wanted };
}

module.exports = { fetchRows, fetchMatching, fetchAll, STATUS };
