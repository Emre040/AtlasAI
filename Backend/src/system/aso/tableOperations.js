'use strict';

// One source of truth for registered, declarative table operations. Callers resolve
// handles to rows; source streaming and durable-result storage remain caller concerns.
const tools = require('./studyTools');
const { SCALAR_SCHEMA } = require('./valueSchemas');
const A = { type: 'string', description: 'artifact id, or a dataset name', 'x-artifact-reference': true };
const S = { type: 'string' };
const N = { type: 'integer' };
const THEN_BY = { type: 'array', description: 'Tie-break columns in order; missing values last', items: { type: 'object', properties: { column: S, order: { type: 'string', enum: ['asc', 'desc'] }, type: { type: 'string', enum: ['auto', 'number', 'text'] } }, required: ['column'] } };
const WHERE = { type: 'array', description: 'Clauses that must all hold. is_missing/is_present/is_numeric/is_non_numeric take column and op only; in takes a list; column_b compares two columns of a row.', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: tools.FILTER_OPS }, value: { description: 'Comparison value, or a list for in' }, column_b: S }, required: ['column', 'op'] } };
const tool = (name, description, properties = {}, required = []) => ({ name, description, result_kind: 'table', parameters: { type: 'object', properties, required } });
const entries = [
  tool('join', 'Combine matching rows of a and b: on the entity keys by default, on one column with on, or on several with on_columns. full and right keep unmatched rows; a clashing column from b gets _2.', { a: A, b: A, how: { type: 'string', enum: ['inner', 'left', 'right', 'full'] }, on: S, on_columns: { type: 'array', items: S } }, ['a', 'b']),
  tool('filter', 'Keep the rows for which every clause holds.', { artifact: A, where: WHERE }, ['artifact', 'where']),
  tool('select', 'Keep columns, rename them, add label columns (add takes text labels, never numbers). Entity keys are kept.', { artifact: A, columns: { type: 'array', items: S }, rename: { type: 'object', additionalProperties: S, description: 'old name → new name' }, add: { type: 'object', additionalProperties: {}, description: 'new column → text label' } }, ['artifact']),
  tool('rank', 'Sort by a numeric column and add rank; top keeps the first n with ties at the boundary unless ties=truncate; missing values stay unranked.', { artifact: A, by: S, order: { type: 'string', enum: ['desc', 'asc'] }, top: N, ties: { type: 'string', enum: ['include', 'truncate'] }, then_by: THEN_BY }, ['artifact', 'by']),
  tool('aggregate', 'Summarise a column over all rows or per group: count (rows), numeric_count, zero, sum, mean, median, sd, q1, q3, min, max, missing, distinct. group_by one column or group_by_columns several; group_domains lists every expected group so empty ones appear with count 0.', { artifact: A, column: S, metrics: { type: 'array', items: { type: 'string', enum: tools.AGGREGATE_METRICS } }, group_by: S, group_by_columns: { type: 'array', items: S }, group_domains: { type: 'array', items: { type: 'object', properties: { column: S, values: { type: 'array', items: SCALAR_SCHEMA } }, required: ['column', 'values'] } }, row_scope: { type: 'string', enum: ['records', 'all'] } }, ['artifact', 'metrics']),
  tool('classify', 'Add a category column: the first rule whose clauses all hold gives its value, otherwise the default. Every row is kept.', { artifact: A, name: S, rules: { type: 'array', items: { type: 'object', properties: { where: WHERE, value: SCALAR_SCHEMA }, required: ['where', 'value'] } }, otherwise: SCALAR_SCHEMA }, ['artifact', 'name', 'rules', 'otherwise']),
  tool('compute', 'Add a column from an arithmetic expression over columns and numbers: + - * / ( ) log2 log10 ln abs sqrt exp min max; + also joins text. No conditionals: use classify for those. Missing inputs give a missing result.', { artifact: A, name: S, expr: S }, ['artifact', 'name', 'expr']),
  tool('correlate', 'Pearson or Spearman correlation of two numeric columns: r, p_value, n; group_by gives one row per group.', { artifact: A, x: S, y: S, method: { type: 'string', enum: ['pearson', 'spearman'] }, group_by: S }, ['artifact', 'x', 'y']),
  tool('fill_missing', 'Replace missing cells of the named columns with one value; present values are untouched.', { artifact: A, columns: { type: 'array', items: S }, value: SCALAR_SCHEMA }, ['artifact', 'columns', 'value'])
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

module.exports = { TABLE_OPERATIONS, executeTableOperation, THEN_BY, WHERE, withRowMask, rowMask };
