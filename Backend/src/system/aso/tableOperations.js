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
  tool('select', 'Keep columns, rename them, add label columns (labels are words, never numbers). Entity keys are kept; renaming a column onto an entity key re-keys the table by it (a partner or target id column).', { artifact: A, columns: { type: 'array', items: S }, rename: { type: 'object', additionalProperties: S, description: 'old name → new name' }, add: { type: 'object', additionalProperties: {}, description: 'new column → text label' } }, ['artifact']),
  tool('rank', 'Sort by a numeric column and add rank; top keeps the first n with ties at the boundary unless ties=truncate; missing values stay unranked.', { artifact: A, by: S, order: { type: 'string', enum: ['desc', 'asc'] }, top: N, ties: { type: 'string', enum: ['include', 'truncate'] }, then_by: THEN_BY }, ['artifact', 'by']),
  tool('aggregate', 'Summarise a column over all rows or per group: count (rows), numeric_count, zero, sum, mean, median, sd, q1, q3, min, max, missing, distinct. group_by one column or group_by_columns several; group_domains lists every expected group so empty ones appear with count 0. Rows that record an absence count like any other: filter them out first.', { artifact: A, column: S, metrics: { type: 'array', items: { type: 'string', enum: tools.AGGREGATE_METRICS } }, group_by: S, group_by_columns: { type: 'array', items: S }, group_domains: { type: 'array', items: { type: 'object', properties: { column: S, values: { type: 'array', items: SCALAR_SCHEMA } }, required: ['column', 'values'] } } }, ['artifact', 'metrics']),
  tool('classify', 'Add a category column: the first rule whose clauses all hold gives its value, otherwise the default. Every row is kept.', { artifact: A, name: S, rules: { type: 'array', items: { type: 'object', properties: { where: WHERE, value: SCALAR_SCHEMA }, required: ['where', 'value'] } }, otherwise: SCALAR_SCHEMA }, ['artifact', 'name', 'rules', 'otherwise']),
  tool('compute', 'Add a column from an arithmetic expression over columns and numbers: + - * / ( ) log2 log10 ln abs sqrt exp min max; + also joins text. No conditionals: use classify for those. Missing inputs give a missing result.', { artifact: A, name: S, expr: S }, ['artifact', 'name', 'expr']),
  tool('correlate', 'Pearson or Spearman correlation of two numeric columns: r, p_value, n; group_by gives one row per group.', { artifact: A, x: S, y: S, method: { type: 'string', enum: ['pearson', 'spearman'] }, group_by: S }, ['artifact', 'x', 'y']),
  tool('fill_missing', 'Replace missing cells of the named columns with one value; present values are untouched.', { artifact: A, columns: { type: 'array', items: S }, value: SCALAR_SCHEMA }, ['artifact', 'columns', 'value'])
];
const TABLE_OPERATIONS = new Map(entries.map(entry => [entry.name, entry]));

function executeTableOperation(name, args, inputs) {
  const rows = inputs.artifact;
  switch (name) {
    case 'join': return { rows: tools.join(inputs.a, inputs.b, args.how, args.on || null, args.on_columns) };
    case 'filter': return { rows: tools.applyWhere(rows, args.where), meta: { predicate_columns: [...new Set((args.where || []).flatMap(clause => [clause.column, clause.column_b || clause.other || clause.versus || clause.against]).filter(Boolean).map(column => tools.findColumn(rows, column)))] } };
    case 'select': return { rows: tools.select(rows, args.columns, args.rename, args.add) };
    case 'rank': {
      const ranked = tools.rank(rows, args.by, args.order, Number(args.top) || 0, args.ties, args.then_by);
      return { rows: ranked, meta: { ordering_columns: [...new Set([tools.findColumn(rows, args.by), ...(args.then_by || []).map(rule => tools.findColumn(rows, rule.column)), 'rank'])].filter(Boolean) } };
    }
    case 'aggregate': return { rows: tools.aggregate(rows, args), meta: { input_rows: rows.length } };
    case 'correlate': return { rows: tools.correlate(rows, args) };
    case 'classify': { const classified = tools.classify(rows, args); return { rows: classified, meta: { classifications: [classified.classification], predicate_columns: classified.classification.predicate_columns } }; }
    case 'compute': return { rows: tools.compute(rows, String(args.name), String(args.expr)) };
    case 'fill_missing': { const filled = tools.fillMissing(rows, args); return { rows: filled, meta: { fills: [filled.fill] } }; }
    default: throw new Error(`Unknown registered table operation ${name}`);
  }
}

module.exports = { TABLE_OPERATIONS, executeTableOperation, THEN_BY, WHERE };
