'use strict';

/**
 * fetch: the one retrieval operation of the Investigator. For a supplied list of entities and one
 * table of the database, return one relation: one row per source row that matches, carrying the
 * entity keys, the requested fields as recorded, how many rows matched for that entity and why a
 * row is empty when none did. Nothing is aggregated, ranked or computed here; the study does that
 * with its own operations over the result. The database's own reader supplies the rows.
 */

const { wherePredicate, withColumns, isMissing } = require('./studyTools');

const STATUS = Object.freeze({ ok: 'ok', noRows: 'no rows in table', noMatch: 'no rows match filter', notInRelease: 'not in release' });

function resolveColumns(entry, names) {
  return names.map(name => {
    const found = entry.columns.find(c => c === name) || entry.columns.find(c => c.toLowerCase() === String(name).toLowerCase());
    if (!found) throw new Error(`${entry.file} has no column ${JSON.stringify(name)}; its columns: ${entry.columns.join(', ')}`);
    return found;
  });
}

// Columns whose values are the entity's own keys carry nothing the key columns do not.
function identityColumns(entry, sampleRows, keys) {
  const values = new Set(keys.map(v => String(v ?? '').toLowerCase()).filter(Boolean));
  return entry.columns.filter(column => sampleRows.length > 0 && sampleRows.every(row => values.has(String(row[column] ?? '').toLowerCase())));
}

async function fetchRows({ adapter, entry, supplied, resolved, fields, where = [], keys }) {
  if (!entry) throw new Error('fetch needs a table');
  if (['unreadable', 'lookup', 'stream'].includes(entry.key)) throw new Error(`${entry.file} cannot be fetched per ${keys.entity}: ${adapter.access(entry)}${entry.key === 'lookup' ? '; open it to read it whole' : ''}`);
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
  const wanted = Array.isArray(fields) && fields.length ? resolveColumns(entry, fields) : entry.columns.filter(c => !identity.includes(c));
  const [geneKey, idKey] = keys.columns;
  const columns = [geneKey, idKey, ...wanted.filter(c => c !== geneKey && c !== idKey), 'source_rows', 'source_status'];
  const out = [];
  const coverage = { supplied: supplied.length, entities: entities.length, resolved: 0, with_rows: 0, no_rows: 0, no_match: 0, not_in_release: 0, rows: 0 };
  for (const { supplied: name, gene } of entities) {
    const base = { [geneKey]: gene ? gene.gene : name, [idKey]: gene ? gene.ensembl : null };
    if (!gene) { coverage.not_in_release++; out.push({ ...base, ...Object.fromEntries(wanted.map(c => [c, null])), source_rows: 0, source_status: STATUS.notInRelease }); continue; }
    coverage.resolved++;
    const all = source.byGene.get(gene.ensembl) || [];
    const rows = all.filter(predicate);
    if (!rows.length) {
      if (all.length) coverage.no_match++; else coverage.no_rows++;
      out.push({ ...base, ...Object.fromEntries(wanted.map(c => [c, null])), source_rows: 0, source_status: all.length ? STATUS.noMatch : STATUS.noRows });
      continue;
    }
    coverage.with_rows++;
    for (const row of rows) {
      coverage.rows++;
      out.push({ ...base, ...Object.fromEntries(wanted.map(c => [c, isMissing(row[c]) ? null : row[c]])), source_rows: rows.length, source_status: STATUS.ok });
    }
  }
  return { rows: withColumns(out, columns), columns, coverage, fields: wanted, identity_columns: identity };
}

module.exports = { fetchRows, STATUS };
