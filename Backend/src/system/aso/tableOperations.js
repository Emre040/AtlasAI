'use strict';

// One source of truth for registered, declarative table operations. Callers resolve
// handles to rows; source streaming and durable-result storage remain caller concerns.
const tools = require('./studyTools');
const { SCALAR_SCHEMA } = require('./valueSchemas');
const A = { type: 'string', description: 'artifact id', 'x-artifact-reference': true };
const S = { type: 'string' };
const N = { type: 'integer' };
// Every operation names its result for a reader: a title and a description.
const NAMED = { title: S, description: S };
const THEN_BY = { type: 'array', items: { type: 'object', properties: { column: S, order: { type: 'string', enum: ['asc', 'desc'] }, type: { type: 'string', enum: ['auto', 'number', 'text'] } }, required: ['column'] } };
const WHERE = { type: 'array', items: { type: 'object', properties: { column: S, op: { type: 'string', enum: tools.FILTER_OPS }, value: {}, column_b: S }, required: ['column', 'op'] } };
// A result left unnamed is named by its operation, so title and description are not required.
const tool = (name, description, properties = {}, required = []) => ({ name, description, result_kind: 'table', parameters: { type: 'object', properties: { ...NAMED, ...properties }, required } });
const entries = [
  tool('join', 'Rows of a and b side by side, matched on the entity keys, on one column (on) or several (on_columns), left=right when the sides name it differently; how inner|left|right|full|cross. A column both carry that agrees is kept once; one that differs comes from b as name_2.', { a: A, b: A, how: { type: 'string', enum: ['inner', 'left', 'right', 'full', 'cross'] }, on: S, on_columns: { type: 'array', items: S } }, ['a', 'b']),
  tool('filter', 'Keep the rows where every clause of where holds and at least one clause of any; a value is a value, matching another artifact is join.', { artifact: A, where: WHERE, any: WHERE }, ['artifact']),
  tool('select', 'Keep or rename columns, add label columns; entity keys stay.', { artifact: A, columns: { type: 'array', items: S }, rename: { type: 'object', additionalProperties: S }, add: { type: 'object', additionalProperties: {} } }, ['artifact']),
  tool('rank', 'Sort by a column and add rank; top keeps the first n (ties at the boundary kept unless ties=truncate); group_by ranks within groups.', { artifact: A, by: S, order: { type: 'string', enum: ['desc', 'asc'] }, top: N, ties: { type: 'string', enum: ['include', 'truncate'] }, group_by: S, then_by: THEN_BY }, ['artifact', 'by']),
  tool('aggregate', 'Summarise a column over all rows, or per group (group_by, or group_by_columns); a statistic is named metric_column, count is rows, recorded is cells with a value; group_domains lists expected groups so empty ones show 0.', { artifact: A, column: S, metrics: { type: 'array', items: { type: 'string', enum: tools.AGGREGATE_METRICS } }, group_by: S, group_by_columns: { type: 'array', items: S }, group_domains: { type: 'array', items: { type: 'object', properties: { column: S, values: { type: 'array', items: SCALAR_SCHEMA } }, required: ['column', 'values'] } } }, ['artifact', 'metrics']),
  tool('classify', 'Add a category column: the first rule whose where holds gives its value, else otherwise.', { artifact: A, name: S, rules: { type: 'array', items: { type: 'object', properties: { where: WHERE, value: SCALAR_SCHEMA }, required: ['where', 'value'] } }, otherwise: SCALAR_SCHEMA }, ['artifact', 'name', 'rules', 'otherwise']),
  tool('compute', 'Add a column from an expression over columns and numbers: + - * / ( ) log2 log10 ln abs sqrt exp min max, + also joins text; if(condition, then, else) with < <= > >= = != and or not; contains(column, "text") holds for text and list cells.', { artifact: A, name: S, expr: S }, ['artifact', 'name', 'expr']),
  tool('correlate', 'Pearson or Spearman correlation of two numeric columns: r, p_value, n; group_by gives one row per group.', { artifact: A, x: S, y: S, method: { type: 'string', enum: ['pearson', 'spearman'] }, group_by: S }, ['artifact', 'x', 'y'])
];
const TABLE_OPERATIONS = new Map(entries.map(entry => [entry.name, entry]));

function executeTableOperation(name, args, inputs) {
  const rows = inputs.artifact;
  switch (name) {
    case 'join': { const rows = tools.join(inputs.a, inputs.b, args.how, args.on || null, args.on_columns); return { rows, meta: rows.naming }; }
    case 'filter': {
      const clauses = [...(args.where || []), ...(args.any || [])];
      const isReference = v => typeof v === 'string' && /^@\w+(\.\S+)?$/.test(v.trim());
      const referenced = clauses.map(clause => ({ clause, value: [clause?.value, ...(clause?.op === 'in' ? tools.inList(clause.value) : [])].find(isReference) })).find(x => x.value);
      if (referenced) throw new Error(`filter: a value is a value, not an artifact (${referenced.value}); to keep the rows of ${args.artifact} whose ${referenced.clause.column} matches a column of another artifact, join them on that column (inner)`);
      // A value the column spells differently is refused with the column's spelling.
      tools.refuseMisspelled(clauses, column => {
        const name = tools.findColumn(rows, column);
        if (!name) return null;
        const seen = new Set();
        for (const row of rows) { const v = row[name]; if (v === null || v === undefined || String(v).trim() === '') continue; seen.add(String(v)); if (seen.size > 5000) return null; }
        return [...seen];
      }, args.artifact);
      return { rows: tools.applyWhere(rows, args.where, args.any), meta: { predicate_columns: [...new Set(clauses.flatMap(clause => [clause.column, clause.column_b || clause.other || clause.versus || clause.against]).filter(Boolean).map(column => tools.findColumn(rows, column)))] } };
    }
    case 'select': return { rows: tools.select(rows, args.columns, args.rename, args.add) };
    case 'rank': {
      if (args.group_by) return { rows: tools.topPerGroup(rows, { group_by: args.group_by, by: args.by, n: args.top, order: args.order, ties: args.ties, then_by: args.then_by }) };
      const ranked = tools.rank(rows, args.by, args.order, Number(args.top) || 0, args.ties, args.then_by);
      return { rows: ranked, meta: { ordering_columns: [...new Set([tools.findColumn(rows, args.by), ...(args.then_by || []).map(rule => tools.findColumn(rows, rule.column)), 'rank'])].filter(Boolean) } };
    }
    case 'aggregate': return { rows: tools.aggregate(rows, args), meta: { input_rows: rows.length } };
    case 'correlate': return { rows: tools.correlate(rows, args) };
    case 'classify': { const classified = tools.classify(rows, args); return { rows: classified, meta: { classifications: [classified.classification], predicate_columns: classified.classification.predicate_columns } }; }
    case 'compute': return { rows: tools.compute(rows, String(args.name), String(args.expr)) };
    default: throw new Error(`Unknown registered table operation ${name}`);
  }
}

module.exports = { TABLE_OPERATIONS, executeTableOperation, A, THEN_BY, WHERE };
