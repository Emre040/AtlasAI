'use strict';

const { num, wherePredicate, columnsOf, findColumn, compute, rank } = require('../aso/studyTools');

const S = { type: 'string' };
const REDUCERS = ['min', 'max', 'mean', 'median', 'sum', 'count', 'missing', 'zero'];
const blank = value => value === undefined || value === null || String(value).trim() === '' || String(value).trim().toUpperCase() === 'NA';
const APPLY_BULK = {
  type: 'function', function: {
    name: 'apply_bulk',
    description: 'Apply source lookups to the entire supplied list without reading or copying that list into your prompt. Scalar lookups combine into one row per input, retaining earlier input measurements. Explicit aggregates handle repeated rows. A single rows-mode lookup returns all matching source rows (or the top rows per gene), with missing inputs retained. Values are read by code; the model never supplies result values.',
    parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'Short name for this result.' },
      lookups: { type: 'array', items: { type: 'object', properties: {
        table: S,
        match_column: { type: 'string', description: 'Exact source column containing the gene name or Ensembl ID.' },
        value_column: { type: 'string', description: 'Exact source measurement/category column (scalar mode).' },
        as: { type: 'string', description: 'Output column name, including the source unit for measurements.' },
        where: { type: 'array', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: ['=', '!=', '>', '>=', '<', '<=', 'contains', 'in'] }, value: {} }, required: ['column', 'op', 'value'] } },
        aggregate: { type: 'string', enum: REDUCERS, description: 'Choose only if the question requests a reduction across matching source rows. count counts rows; missing counts nonnumeric cells; zero counts numeric zero.' },
        mode: { type: 'string', enum: ['scalar', 'rows'] },
        columns: { type: 'array', items: S, description: 'Exact source columns to retain in rows mode; include entity labels and source values.' },
        top_by: S, top: { type: 'integer', description: 'Rows per gene, sorted numerically by top_by.' }, order: { type: 'string', enum: ['asc', 'desc'] }
      }, required: ['table', 'match_column'] } },
      derive: { type: 'array', description: 'Optional calculations over the combined result, using the registered compute tool. Division by zero stays missing.', items: { type: 'object', properties: { name: S, expr: S }, required: ['name', 'expr'] } },
      sort: { type: 'object', description: 'Optional requested ranking of the completed table using the registered rank operation. Omit top to retain every input, including missing values.', properties: { by: S, order: { type: 'string', enum: ['asc', 'desc'] }, top: { type: 'integer' } }, required: ['by'] }
    }, required: ['name', 'lookups'] }
  }
};

function column(entry, name) {
  if (!entry.columns.includes(name)) throw new Error(`${entry.file} has no column ${JSON.stringify(name)}; columns: ${entry.columns.join(', ')}`);
  return name;
}

function reduce(rows, key, reducer) {
  const values = rows.map(row => num(row[key])).filter(value => value !== null).sort((a, b) => a - b);
  if (reducer === 'count') return rows.length;
  if (reducer === 'missing') return rows.length - values.length;
  if (reducer === 'zero') return values.filter(value => value === 0).length;
  if (!reducer) {
    if (rows.length > 1) throw new Error(`${rows.length} matching source rows; choose an explicit aggregate or rows mode`);
    const value = rows[0]?.[key];
    return blank(value) ? null : num(value) === null ? value : num(value);
  }
  if (!values.length) return null;
  if (reducer === 'min') return values[0];
  if (reducer === 'max') return values.at(-1);
  if (reducer === 'sum' || reducer === 'mean') return values.reduce((a, b) => a + b, 0) / (reducer === 'mean' ? values.length : 1);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function createBulkTools({ supplied, resolved, inputRows, adapter }) {
  const sourceReads = new Map();
  const base = resolved.map((gene, i) => ({ ...inputRows?.[i], gene: gene ? gene.gene : supplied[i], ensembl: gene ? gene.ensembl : null }));
  const read = table => {
    if (!sourceReads.has(table)) sourceReads.set(table, adapter.readMany(resolved.filter(Boolean), table));
    return sourceReads.get(table);
  };
  return { async applyBulk(args) {
    if (!args.name?.trim() || !Array.isArray(args.lookups) || !args.lookups.length) throw new Error('apply_bulk needs a name and at least one lookup');
    const rowMode = args.lookups.some(lookup => lookup.mode === 'rows');
    if (rowMode && args.lookups.length !== 1) throw new Error('A rows-mode result takes one lookup; return other results in another apply_bulk call');
    let resultRows = rowMode ? [] : base.map(row => ({ ...row }));
    const provenance = [], coverage = [], named = new Set(columnsOf(base));
    for (const lookup of args.lookups) {
      const entry = await adapter.entry(lookup.table);
      if (!entry) throw new Error(`No table named ${lookup.table}`);
      column(entry, lookup.match_column);
      const predicate = wherePredicate(entry.columns, lookup.where || []);
      const rowsMode = lookup.mode === 'rows';
      if (lookup.aggregate && !REDUCERS.includes(lookup.aggregate)) throw new Error(`Unknown aggregate ${lookup.aggregate}`);
      if (rowsMode) {
        if (!Array.isArray(lookup.columns) || !lookup.columns.length) throw new Error('rows mode needs source columns');
        lookup.columns.forEach(name => column(entry, name));
        if (lookup.columns.some(name => name === 'gene' || name === 'ensembl')) throw new Error('gene and ensembl are retained automatically; omit them from the source columns');
        if (lookup.aggregate) throw new Error('Use scalar mode for an aggregate');
        if (lookup.top !== undefined && (!Number.isSafeInteger(lookup.top) || lookup.top < 1)) throw new Error('top must be a positive integer');
        if (lookup.top !== undefined) column(entry, lookup.top_by);
      } else {
        column(entry, lookup.value_column);
        if (!lookup.as?.trim() || named.has(lookup.as)) throw new Error(`Choose a new, unique output column for ${lookup.as || lookup.value_column}`);
        for (const key of [lookup.as, `${lookup.as}_source_rows`, `${lookup.as}_missing_rows`]) {
          if (named.has(key)) throw new Error(`Output column ${key} already exists`);
          named.add(key);
        }
      }
      const source = await read(entry.file);
      let missingGenes = 0, matchedRows = 0, nonnumeric = 0;
      for (let i = 0; i < resolved.length; i++) {
        const gene = resolved[i];
        const raw = gene ? source.byGene.get(gene.ensembl) || [] : [];
        const keyed = raw.filter(row => [gene.gene, gene.ensembl].some(value => String(row[lookup.match_column]).trim().toUpperCase() === value.toUpperCase()));
        if (raw.length && !keyed.length) throw new Error(`${entry.file}.${lookup.match_column} does not match the supplied genes; inspect the source gene column`);
        const rows = keyed.filter(predicate);
        matchedRows += rows.length;
        if (!rows.length) missingGenes++;
        if (rowsMode) {
          const numericRows = lookup.top === undefined ? rows : rows.filter(row => num(row[lookup.top_by]) !== null);
          const selected = lookup.top === undefined || !numericRows.length ? numericRows : rank(numericRows, lookup.top_by, lookup.order || 'desc', lookup.top);
          if (!selected.length) resultRows.push({ ...base[i], ...Object.fromEntries(lookup.columns.map(key => [key, null])), source_rows: rows.length, lookup_status: !gene ? 'gene_not_in_release' : rows.length ? 'no_numeric_values' : 'no_matching_rows' });
          for (const row of selected) resultRows.push({ ...base[i], ...Object.fromEntries(lookup.columns.map(key => [key, row[key]])), ...(lookup.top === undefined ? {} : { rank: row.rank }), source_rows: rows.length });
        } else {
          const missing = rows.filter(row => blank(row[lookup.value_column])).length;
          nonnumeric += rows.filter(row => num(row[lookup.value_column]) === null).length;
          resultRows[i][lookup.as] = reduce(rows, lookup.value_column, lookup.aggregate);
          resultRows[i][`${lookup.as}_source_rows`] = rows.length;
          resultRows[i][`${lookup.as}_missing_rows`] = missing;
          if (!gene) resultRows[i].lookup_status = 'gene_not_in_release';
        }
      }
      provenance.push({ ...lookup, table: entry.file, source_description: entry.description || '', input_count: supplied.length });
      coverage.push({ table: entry.file, output: lookup.as || args.name, inputs: supplied.length, genes_without_matching_rows: missingGenes, matched_source_rows: matchedRows, ...(rowsMode ? {} : { nonnumeric_source_values: nonnumeric, missing_output_values: resultRows.filter(row => row[lookup.as] === null).length, zero_output_values: resultRows.filter(row => row[lookup.as] === 0).length }) });
    }
    for (const step of args.derive || []) {
      if (columnsOf(resultRows).includes(step.name)) throw new Error(`Derived column ${step.name} already exists`);
      resultRows = compute(resultRows, step.name, step.expr);
    }
    if (args.sort) {
      if (args.sort.top !== undefined && (!Number.isSafeInteger(args.sort.top) || args.sort.top < 1)) throw new Error('sort.top must be a positive integer');
      const column = findColumn(resultRows, args.sort.by);
      const unranked = resultRows.filter(row => num(row[column]) === null).map(row => ({ ...row, rank: null }));
      resultRows = rank(resultRows, args.sort.by, args.sort.order || 'desc', args.sort.top);
      if (args.sort.top === undefined) resultRows.push(...unranked);
    }
    const declared = rowMode ? [...args.lookups[0].columns, 'source_rows'] : args.lookups.flatMap(lookup => [lookup.as, `${lookup.as}_source_rows`, `${lookup.as}_missing_rows`]);
    const currentColumns = [...new Set([...columnsOf(resultRows), ...declared, ...(args.derive || []).map(step => step.name)])];
    const newColumns = currentColumns.filter(key => !columnsOf(base).includes(key));
    const measurements = newColumns.filter(key => !/_source_rows$|_missing_rows$/.test(key));
    const columns = [...new Set(['gene', 'ensembl', ...measurements, ...newColumns, ...currentColumns])];
    resultRows = resultRows.map(row => Object.fromEntries(columns.map(key => [key, row[key] === undefined ? null : row[key]])));
    return { name: args.name, rows: resultRows, columns, provenance, coverage, unresolved_inputs: resolved.filter(gene => !gene).length, calculations: args.derive || [], ...(args.sort ? { sort: args.sort } : {}) };
  } };
}

module.exports = { APPLY_BULK, createBulkTools };
