'use strict';

// One source of truth for registered, declarative table operations. Callers resolve
// handles to rows; source streaming and durable-result storage remain caller concerns.
const tools = require('./studyTools');
const { SCALAR_SCHEMA } = require('./valueSchemas');
const A = { type: 'string', description: 'Input table handle', 'x-artifact-reference': true };
const S = { type: 'string' };
const N = { type: 'integer' };
const THEN_BY = { type: 'array', description: 'Secondary columns order equal primary scores while preserving their tied rank; missing values remain last.', items: { type: 'object', properties: { column: S, order: { type: 'string', enum: ['asc', 'desc'] }, type: { type: 'string', enum: ['auto', 'number', 'text'], description: 'auto compares numbers numerically and other scalar values lexically; text uses exact lexical order.' } }, required: ['column'] } };
const tool = (name, description, properties = {}, required = []) => ({ name, description, result_kind: 'table', parameters: { type: 'object', properties, required } });
const entries = [
  tool('join', 'Combine matching rows. Default gene identity, or exact on column, or on_columns for a typed tuple. full/right retain unmatched source rows; missing keys never match. Clashing measurement columns get _2.', { a: A, b: A, how: { type: 'string', enum: ['inner', 'left', 'right', 'full'] }, on: S, on_columns: { type: 'array', items: S, description: 'Exact columns forming a composite match key; use instead of on.' } }, ['a', 'b']),
  tool('filter', 'Filter returned result rows by exact values or numeric thresholds; every clause must hold. op in takes a list; column_b compares columns. Unary is_missing/is_present/is_numeric/is_non_numeric take column and op only: missing is null/blank/NA; numeric includes finite zero and negatives; non_numeric means present but nonnumeric.', { artifact: A, where: { type: 'array', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: tools.FILTER_OPS }, value: { description: 'Comparison value, or list for in; omit for unary predicates' }, column_b: { type: 'string', description: 'compare with this column of the same row instead of value' } }, required: ['column', 'op'] } } }, ['artifact', 'where']),
  tool('select', 'Keep columns, rename them, add constant columns. Preserve gene and ensembl for subsequent gene operations.', { artifact: A, columns: { type: 'array', items: S }, rename: { type: 'object', additionalProperties: S, description: 'Map exact original column names to new names' }, add: { type: 'object', additionalProperties: {}, description: 'Map new column names to exact constant values' } }, ['artifact']),
  tool('rank', 'Sort by a numeric column (adds rank); top includes ties at its boundary unless ties=truncate; missing values stay unranked when no top is requested.', { artifact: A, by: S, order: { type: 'string', enum: ['desc', 'asc'] }, top: N, ties: { type: 'string', enum: ['include', 'truncate'] }, then_by: THEN_BY }, ['artifact', 'by']),
  tool('aggregate', 'count counts the selected input rows, not independent samples or original records after joins; numeric_count counts numeric measurements; zero, sum, mean, median, sd, q1, q3, min, max, missing and distinct summarize a column. group_by groups by one column; group_by_columns groups by several columns in one operation and retains each group label separately for grouped charts. With group_domains, emit every declared category combination including empty groups (counts 0, undefined statistics null), rejecting observed labels outside the domains.', { artifact: A, row_scope: { type: 'string', enum: ['records', 'all'], description: 'records excludes authoritative absence placeholders; all counts every input table row. Explicit choice is required when the input contains placeholders. records requires known row lineage; it does not assert biological independence.' }, group_by: S, group_by_columns: { type: 'array', items: S, description: 'Group by this combination of columns, keeping each label in its own output column. Use instead of group_by.' }, group_domains: { type: 'array', description: 'Optional complete domains for every grouping column. Preserve exact scalar types; zero, null and blank strings are distinct labels. Output follows grouping-column order and each values order. Empty values yields no combinations.', items: { type: 'object', properties: { column: S, values: { type: 'array', items: SCALAR_SCHEMA } }, required: ['column', 'values'] } }, column: S, metrics: { type: 'array', items: { type: 'string', enum: tools.AGGREGATE_METRICS } } }, ['artifact', 'metrics']),
  tool('classify', tools.CLASSIFY_DESCRIPTION, { artifact: A, ...tools.CLASSIFY_SCHEMA.properties }, ['artifact', ...tools.CLASSIFY_SCHEMA.required]),
  tool('compute', 'Add a column from an expression over columns and numbers: + - * / ( ) log2 log10 ln abs sqrt exp min max; + also joins text, as in a + " / " + b.', { artifact: A, name: S, expr: { type: 'string', description: 'Exact column names; quoted tokens name an existing column first, otherwise they are literal text. No comparisons or SQL CASE; use classify for ordered conditional rules.' } }, ['artifact', 'name', 'expr']),
  tool('correlate', 'Pearson or Spearman correlation of two numeric columns: r, p_value and n; group_by gives one per group.', { artifact: A, x: S, y: S, method: { type: 'string', enum: ['pearson', 'spearman'] }, group_by: S }, ['artifact', 'x', 'y']),
  tool('fill_missing', 'Replace missing cells only in explicitly selected columns with an exact scalar value. Existing zero, negative and other present values remain unchanged; no fill value is inferred.', { artifact: A, columns: { type: 'array', items: S }, value: SCALAR_SCHEMA }, ['artifact', 'columns', 'value'])
];
const TABLE_OPERATIONS = new Map(entries.map(entry => [entry.name, entry]));

function runOperation(name, args, inputs) {
  const rows = inputs.artifact;
  switch (name) {
    case 'join': return { rows: tools.join(inputs.a, inputs.b, args.how, args.on || null, args.on_columns) };
    case 'filter': return { rows: tools.applyWhere(rows, args.where), meta: { predicate_columns: [...new Set((args.where || []).flatMap(clause => [clause.column, clause.column_b || clause.other || clause.versus || clause.against]).filter(Boolean).map(column => tools.findColumn(rows, column)))] } };
    case 'select': return { rows: tools.select(rows, args.columns, args.rename, args.add) };
    case 'rank': {
      const ranked = tools.rank(rows, args.by, args.order, Number(args.top) || 0, args.ties, args.then_by);
      return { rows: ranked, meta: { ordering_columns: [...new Set([tools.findColumn(rows, args.by), ...(args.then_by || []).map(rule => tools.findColumn(rows, rule.column)), 'rank'])].filter(Boolean) } };
    }
    case 'aggregate': {
      const mask = rowMask(rows);
      if (args.row_scope !== undefined && !['records', 'all'].includes(args.row_scope)) throw new Error('aggregate row_scope must be records or all');
      if (args.row_scope === 'records' && !mask) throw new Error('aggregate row_scope records requires authoritative row lineage; use all for input-table row counts');
      if (mask?.some(value => !value) && args.row_scope === undefined) throw new Error('aggregate input contains absence placeholders; choose row_scope records to exclude them or all to count every retained input row');
      const selected = args.row_scope === 'records' ? tools.withColumns(rows.filter((row, index) => mask[index]), tools.columnsOf(rows)) : rows;
      return { rows: tools.aggregate(selected, args), meta: { aggregation_rows: { scope: args.row_scope || 'all', input_rows: rows.length, selected_rows: selected.length,
        record_rows: mask ? mask.filter(Boolean).length : null, placeholder_rows: mask ? mask.filter(value => !value).length : null,
        semantics: 'Selected predecessor rows, not proof of independent samples or original source records after joins' } } };
    }
    case 'correlate': return { rows: tools.correlate(rows, args) };
    case 'classify': { const classified = tools.classify(rows, args); return { rows: classified, meta: { classifications: [classified.classification], predicate_columns: classified.classification.predicate_columns } }; }
    case 'compute': return { rows: tools.compute(rows, String(args.name), String(args.expr)) };
    case 'fill_missing': { const filled = tools.fillMissing(rows, args); return { rows: filled, meta: { fills: [filled.fill] } }; }
    default: throw new Error(`Unknown registered table operation ${name}`);
  }
}

const ROW_INDEX = Symbol('registered input row');
function rowMask(rows) {
  if (rows.record_rows === undefined) return null;
  if (!Array.isArray(rows.record_rows) || rows.record_rows.length !== rows.length || rows.record_rows.some(value => typeof value !== 'boolean')) throw new Error('Invalid authoritative record_rows metadata');
  return rows.record_rows;
}
function withRowMask(rows, mask, kind) {
  if (mask) Object.defineProperty(rows, 'record_rows', { value: [...mask], configurable: true });
  if (kind) Object.defineProperty(rows, 'row_kind', { value: kind, configurable: true });
  return rows;
}
function executeTableOperation(name, args, inputs) {
  let prepared = inputs, mask, rowKind, leftKey, rightKey;
  if (name === 'join') {
    rowKind = 'joined_result_row';
    const a = rowMask(inputs.a), b = rowMask(inputs.b);
    if (a && b) {
      const occupied = new Set([...tools.columnsOf(inputs.a), ...tools.columnsOf(inputs.b)]);
      const marker = prefix => { let key = prefix; while (occupied.has(key)) key += '_'; occupied.add(key); return key; };
      leftKey = marker('__saved_left_row'); rightKey = marker('__saved_right_row');
      prepared = { a: tools.withColumns(inputs.a.map((row, index) => ({ ...row, [leftKey]: index })), [...tools.columnsOf(inputs.a), leftKey]),
        b: tools.withColumns(inputs.b.map((row, index) => ({ ...row, [rightKey]: index })), [...tools.columnsOf(inputs.b), rightKey]) };
      mask = { a, b }; rowKind = 'joined_result_row';
    }
  } else if (!['aggregate', 'correlate'].includes(name)) {
    mask = rowMask(inputs.artifact); rowKind = inputs.artifact.row_kind;
    if (mask) prepared = { ...inputs, artifact: tools.withColumns(inputs.artifact.map((row, index) => ({ ...row, [ROW_INDEX]: index })), tools.columnsOf(inputs.artifact)) };
  }
  if (name === 'aggregate') rowKind = 'aggregate_group';
  if (name === 'correlate') rowKind = 'correlation_group';
  const out = runOperation(name, args, prepared);
  if (mask) {
    let records;
    if (name === 'join') {
      records = out.rows.map(row => Boolean(row[leftKey] !== null && row[leftKey] !== undefined && mask.a[row[leftKey]] || row[rightKey] !== null && row[rightKey] !== undefined && mask.b[row[rightKey]]));
      const columns = tools.columnsOf(out.rows).filter(column => column !== leftKey && column !== rightKey);
      out.rows = tools.withColumns(out.rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]]))), columns);
    } else {
      records = out.rows.map((row, index) => mask[name === 'select' ? index : row[ROW_INDEX]]);
      if (records.some(value => typeof value !== 'boolean')) throw new Error(`${name} lost authoritative row lineage`);
      out.rows = tools.withColumns(out.rows.map(row => { const value = { ...row }; delete value[ROW_INDEX]; return value; }), tools.columnsOf(out.rows));
    }
    out.meta = { ...(out.meta || {}), record_rows: records, ...(rowKind ? { row_kind: rowKind } : {}) };
    withRowMask(out.rows, records, rowKind);
  }
  if (rowKind) {
    out.meta = { ...(out.meta || {}), row_kind: rowKind };
    withRowMask(out.rows, null, rowKind);
  }
  return out;
}

module.exports = { TABLE_OPERATIONS, executeTableOperation, THEN_BY, withRowMask, rowMask };
