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
const THEN_BY = { type: 'array', description: 'Tie-break columns in order; missing values last', items: { type: 'object', properties: { column: S, order: { type: 'string', enum: ['asc', 'desc'] }, type: { type: 'string', enum: ['auto', 'number', 'text'] } }, required: ['column'] } };
const WHERE = { type: 'array', description: 'Clauses that must all hold, each {column, op, value}; op in takes a list as value; column_b in place of value compares two columns.',items: { type: 'object', properties: { column: S, op: { type: 'string', enum: tools.FILTER_OPS }, value: {}, column_b: S }, required: ['column', 'op'] } };
// A result left unnamed is named by its operation, so title and description are not required.
const tool = (name, description, properties = {}, required = []) => ({ name, description, result_kind: 'table', parameters: { type: 'object', properties: { ...NAMED, ...properties }, required } });
const entries = [
  tool('join', 'Matching rows of a and b side by side: on the entity keys, on one column (on) or several (on_columns); a key the sides call differently is written left=right (ensembl=ensembl_gene_id_2); full and right keep unmatched rows; cross pairs every row of a with every row of b (two counts side by side). A column both carry that agrees on every matched row is kept once; one that differs comes from b with a numbered suffix (_2), as the result line says.', { a: A, b: A, how: { type: 'string', enum: ['inner', 'left', 'right', 'full', 'cross'] }, on: S, on_columns: { type: 'array', items: S } }, ['a', 'b']),
  tool('filter', 'Keep the rows for which every clause of where holds and, when any is given, at least one clause of any. Rows whose column matches a column of another artifact are kept by join (inner), not by filter.', { artifact: A, where: WHERE, any: { ...WHERE, description: 'Clauses of which at least one must hold, each {column, op, value}; beside where, or alone.' } }, ['artifact']),
  tool('select', 'Keep columns, rename them, add label columns (words). Entity keys stay; renaming a column onto an entity key re-keys the table by it.', { artifact: A, columns: { type: 'array', items: S }, rename: { type: 'object', additionalProperties: S, description: 'old name → new name' }, add: { type: 'object', additionalProperties: {}, description: 'new column → text label' } }, ['artifact']),
  tool('rank', 'Sort by a column and add rank: numbers by value, text alphabetically; top keeps the first n (ties at the boundary unless ties=truncate); group_by ranks within each group.', { artifact: A, by: S, order: { type: 'string', enum: ['desc', 'asc'] }, top: N, ties: { type: 'string', enum: ['include', 'truncate'] }, group_by: S, then_by: THEN_BY }, ['artifact', 'by']),
  tool('aggregate', 'Summarise a column over all rows, or per group (group_by, or group_by_columns for several); count is rows, recorded is rows whose cell holds a value (after a left join, the matches, zero where none); group_domains lists expected groups so empty ones show count 0. A statistic of a column is named metric_column (the mean of a column named value is mean_value); count is count.', { artifact: A, column: S, metrics: { type: 'array', items: { type: 'string', enum: tools.AGGREGATE_METRICS } }, group_by: S, group_by_columns: { type: 'array', items: S }, group_domains: { type: 'array', items: { type: 'object', properties: { column: S, values: { type: 'array', items: SCALAR_SCHEMA } }, required: ['column', 'values'] } } }, ['artifact', 'metrics']),
  tool('classify', 'Add a category column: the first rule whose clauses hold gives its value, otherwise the default.', { artifact: A, name: S, rules: { type: 'array', items: { type: 'object', properties: { where: WHERE, value: SCALAR_SCHEMA }, required: ['where', 'value'] } }, otherwise: SCALAR_SCHEMA }, ['artifact', 'name', 'rules', 'otherwise']),
  tool('compute', 'Add a column from an expression over columns and numbers: + - * / ( ) log2 log10 ln abs sqrt exp min max; + also joins text; if(condition, then, else) with < <= > >= = != chooses per row, as in if(rank > 0, gene, "") to name some rows and leave the rest blank; contains(column, "text") is a condition on text or list cells, and conditions combine with and, or, not, so if(contains(class, "a word") or contains(class, "another"), 1, 0) flags rows and aggregate mean turns flags into a share. classify makes category columns.', { artifact: A, name: S, expr: S }, ['artifact', 'name', 'expr']),
  tool('correlate', 'Pearson or Spearman correlation of two numeric columns: r, p_value, n; group_by gives one row per group.', { artifact: A, x: S, y: S, method: { type: 'string', enum: ['pearson', 'spearman'] }, group_by: S }, ['artifact', 'x', 'y'])
];
const TABLE_OPERATIONS = new Map(entries.map(entry => [entry.name, entry]));

function executeTableOperation(name, args, inputs) {
  const rows = inputs.artifact;
  switch (name) {
    case 'join': { const rows = tools.join(inputs.a, inputs.b, args.how, args.on || null, args.on_columns); return { rows, meta: rows.naming }; }
    case 'filter': {
      const clauses = [...(args.where || []), ...(args.any || [])];
      const referenced = clauses.find(clause => typeof clause?.value === 'string' && /^@\w+$/.test(clause.value.trim()));
      if (referenced) throw new Error(`filter: a value is a value, not an artifact (${referenced.value}); to keep the rows of ${args.artifact} whose ${referenced.column} matches a column of another artifact, join them on that column (inner)`);
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
