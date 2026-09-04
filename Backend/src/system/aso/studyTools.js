'use strict';

/**
 * The operations a study plan can use. Every operation is code: the model chooses which one to
 * apply to which artifact and with what arguments; it never carries values between steps by hand.
 *
 * Tables are arrays of row objects with a `gene` and `ensembl` column plus whatever the source
 * produced. Set operations key on `ensembl` when present, else on `gene`.
 */

const geneData = require('../../hpa/geneDataAdapter');

const OPS = ['>', '>=', '<', '<=', '=', '!=', 'contains', 'in'];

function num(v) { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; }
function lower(s) { return String(s ?? '').toLowerCase().trim(); }
function keyOf(row, on = null) {
  if (on) { const v = row[on]; return v === undefined || v === null || String(v).trim() === '' ? null : lower(v); }
  const v = row.ensembl || row.Ensembl || row.gene || row.Gene;
  return v ? lower(v) : null;
}
function requireKeys(rows, on, opName) {
  if (rows.some(r => keyOf(r, on) === null)) throw new Error(`${opName}: every row needs a ${on ? `"${on}"` : 'gene or ensembl'} column to match on (use concat to stack tables that share no key)`);
}
function columnsOf(rows) { const set = new Set(); for (const r of rows.slice(0, 200)) for (const k of Object.keys(r)) set.add(k); return [...set]; }
function findColumn(rows, name) {
  if (!name) return null;
  const cols = columnsOf(rows);
  return cols.find(c => c === name) || cols.find(c => lower(c) === lower(name)) || null;
}

// The catalog of operations the planner reads. Descriptions say what the operation does to a
// table; nothing about any particular database.
const TOOL_CATALOG = [
  { name: 'search', inputs: 0, args: { question: 'a question describing which genes to find, in plain words' }, produces: 'a gene table: one row per gene matching the question, with the gene facts the search returns',
    description: 'Finds genes by a question ("kinases enriched in the pancreas that are secreted to blood"). Runs a search agent that knows the database\'s search grammar and returns the matching genes with their facts.' },
  { name: 'lookup', inputs: 1, args: { question: 'a question about one gene with {gene} where the gene name goes', max_genes: 'optional cap on how many genes of the input table to ask about', as: 'optional name for the value column (default value)' }, produces: 'the input genes with columns answer, value (or the "as" name), entity, table, found',
    description: 'Asks a reading agent one factual question about each gene of the input table, in parallel; each answer cites the database row it rests on. Use it for questions that need reading and judgement; for a plain value from a known table use measure, which is exact and free, and for "which entity is highest per gene" use measure of all entities followed by top_per_group. Not for summaries or conclusions: the report does those.' },
  { name: 'measure', inputs: 1, args: { table: 'a per-gene table of the database', value_column: 'the column to read', entity_column: 'optional: the column that names the entity (tissue, cell type, cancer)', entity: 'optional: which entity to read; omit to read every entity as separate rows', as: 'name for the value column in the output (default value); name it after what it holds, such as liver_nTPM, so later steps can refer to it' }, produces: 'rows gene, ensembl, entity (if any), and the value under the "as" name',
    description: 'Reads a value straight from a named table for every gene of the input table: exact, no model call. With an entity ("liver") one row per gene; without, one row per gene per entity, which pivot can turn into a matrix. Two measures joined later keep both values apart when each names its column with "as".' },
  { name: 'union', inputs: 2, args: {}, produces: 'genes present in either input (one row per gene)', description: 'Genes in either table.' },
  { name: 'intersect', inputs: 2, args: {}, produces: 'the rows of the first input whose gene is also in the second', description: 'Genes in both tables (rows and columns of the first; join to add the second\'s columns).' },
  { name: 'difference', inputs: 2, args: {}, produces: 'the rows of the first input whose gene is absent from the second', description: 'Genes in the first table but not the second.' },
  { name: 'concat', inputs: 2, args: {}, produces: 'all rows of the first input followed by all rows of the second', description: 'Stacks two tables with the same columns, keeping every row (no matching on gene): for example two count tables labelled with a route.' },
  { name: 'join', inputs: 2, args: { how: '"inner" (default) or "left"', on: 'optional column to match on instead of gene (for tables without genes, such as counts per entity)' }, produces: 'each row of the first input combined with every row of the second input for the same gene (the second\'s columns suffixed with _2 when names clash)', description: 'Joins two tables by gene, like SQL: a long second table (one row per gene and entity) keeps all its rows.' },
  { name: 'filter', inputs: 1, args: { where: [{ column: 'name', op: OPS.join(' | '), value: 'value, or a list for "in"' }] }, produces: 'the rows that satisfy every clause', description: 'Keeps rows by column conditions. Numbers compare numerically, text by case-insensitive equality or containment.' },
  { name: 'select', inputs: 1, args: { columns: ['names to keep'], rename: { old: 'new' }, add: { new_column: 'a constant value written into every row, such as a label' } }, produces: 'the same rows with only those columns (plus any added constants)', description: 'Keeps and renames columns, and can add a constant column to label the rows before concat.' },
  { name: 'rank', inputs: 1, args: { by: 'column', order: '"desc" (default) or "asc"', top: 'optional N' }, produces: 'rows sorted by the column with a rank column, cut to the top N', description: 'Sorts by a numeric column.' },
  { name: 'aggregate', inputs: 1, args: { group_by: 'optional column', column: 'numeric column', metrics: ['count | sum | mean | median | min | max'] }, produces: 'one row per group with the requested metrics', description: 'Summarises a column, optionally per group.' },
  { name: 'top_per_group', inputs: 1, args: { group_by: 'column that defines the groups (default gene)', by: 'numeric column', n: 'rows to keep per group (default 1)', order: '"desc" (default) or "asc"' }, produces: 'the n highest (or lowest) rows of each group, with a rank column', description: 'Keeps the top rows within each group: for example the entity with the highest value for every gene.' },
  { name: 'compute', inputs: 1, args: { name: 'new column', expr: '"a / b", "a - b", "log2(a / b)", "a + b", "a * b", "abs(a)" where a and b are column names' }, produces: 'the rows with the new column', description: 'Adds a column computed from one or two numeric columns; rows where a value is missing get null.' },
  { name: 'pivot', inputs: 1, args: { row: 'column for rows (default gene)', column: 'column for columns (default entity)', value: 'value column (default value)', top: 'optional: keep the N rows with the highest maximum', top_columns: 'optional: keep the N columns with the highest maximum' }, produces: 'a matrix with row_labels and col_labels, for a heatmap', description: 'Turns long rows (gene, entity, value) into a matrix; cap rows and columns for a readable heatmap.' },
  { name: 'chart', inputs: 1, args: { type: 'bar | lollipop | dot_plot | diverging_bar | grouped_bar | scatter | bubble | heatmap | radar | line | volcano', x: 'label column (bar family) or x column (scatter)', y: 'value column', group: 'optional group column (grouped_bar, radar)', size: 'optional size column (bubble)', title: 'title', x_label: 'axis label', y_label: 'axis label' }, produces: 'a figure', description: 'Draws the input table. A heatmap takes a pivot output; other types take rows with the named columns.' }
];

function catalogText() {
  return TOOL_CATALOG.map(t => `- ${t.name}: ${t.description} Inputs: ${t.inputs}. Args: ${JSON.stringify(t.args)}. Produces: ${t.produces}.`).join('\n');
}

// ---- table operations ----------------------------------------------------------------------------

function applyWhere(rows, where = []) {
  const clauses = [];
  for (const w of Array.isArray(where) ? where : []) {
    const column = findColumn(rows, w?.column);
    const op = String(w?.op || '=').trim();
    if (!column) throw new Error(`filter: no column named "${w?.column}" (columns: ${columnsOf(rows).slice(0, 20).join(', ')})`);
    if (!OPS.includes(op)) throw new Error(`filter: unknown op "${op}"`);
    clauses.push({ column, op, value: w.value });
  }
  return rows.filter(r => clauses.every(({ column, op, value }) => {
    const cell = r[column];
    if (op === 'in') return (Array.isArray(value) ? value : [value]).some(v => lower(v) === lower(cell));
    if (op === 'contains') return lower(cell).includes(lower(value));
    if (op === '=' || op === '!=') { const same = lower(cell) === lower(value) || (num(cell) !== null && num(cell) === num(value)); return op === '=' ? same : !same; }
    const a = num(cell), b = num(value);
    if (a === null || b === null) return false;
    return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
  }));
}

function setOp(kind, left, right, on = null) {
  if (kind === 'concat') return [...left, ...right];
  requireKeys(left, on, kind); requireKeys(right, on, kind);
  const rightKeys = new Set(right.map(r => keyOf(r, on)));
  if (kind === 'union') { const seen = new Set(); return [...left, ...right].filter(r => { const k = keyOf(r, on); if (seen.has(k)) return false; seen.add(k); return true; }); }
  if (kind === 'intersect') return left.filter(r => rightKeys.has(keyOf(r, on)));
  if (kind === 'difference') return left.filter(r => !rightKeys.has(keyOf(r, on)));
  throw new Error(`unknown set operation ${kind}`);
}

// SQL-like: a left row joined with every right row of the same gene, so a long table (one row per
// gene and entity) keeps all its rows.
function join(left, right, how = 'inner', on = null) {
  const onCol = on ? (findColumn(left, on) || on) : null;
  const onRight = on ? (findColumn(right, on) || on) : null;
  requireKeys(left, onCol, 'join'); requireKeys(right, onRight, 'join');
  const groups = new Map();
  for (const r of right) { const k = keyOf(r, onRight); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const leftCols = new Set(columnsOf(left));
  const out = [];
  for (const l of left) {
    const matches = groups.get(keyOf(l, onCol)) || [];
    if (!matches.length) { if (how === 'left') out.push({ ...l }); continue; }
    for (const r of matches) {
      const merged = { ...l };
      for (const [k, v] of Object.entries(r)) {
        if (k === 'gene' || k === 'ensembl' || k === onRight) continue;
        merged[leftCols.has(k) ? `${k}_2` : k] = v;
      }
      out.push(merged);
    }
  }
  return out;
}

function select(rows, columns = [], rename = {}, add = {}) {
  const keep = (Array.isArray(columns) && columns.length ? columns : columnsOf(rows)).map(c => findColumn(rows, c)).filter(Boolean);
  const constants = add && typeof add === 'object' ? Object.entries(add) : [];
  return rows.map(r => { const o = {}; for (const c of keep) o[rename[c] || c] = r[c]; if (r.gene !== undefined && o.gene === undefined) o.gene = r.gene; if (r.ensembl !== undefined && o.ensembl === undefined) o.ensembl = r.ensembl; for (const [k, v] of constants) o[k] = v; return o; });
}

function rank(rows, by, order = 'desc', top = 0) {
  const column = findColumn(rows, by);
  if (!column) throw new Error(`rank: no column named "${by}"`);
  const sorted = rows.map(r => ({ r, v: num(r[column]) })).filter(x => x.v !== null).sort((a, b) => order === 'asc' ? a.v - b.v : b.v - a.v).map((x, i) => ({ ...x.r, rank: i + 1 }));
  return top > 0 ? sorted.slice(0, top) : sorted;
}

function topPerGroup(rows, { group_by = 'gene', by, n = 1, order = 'desc' } = {}) {
  const groupCol = findColumn(rows, group_by);
  const column = findColumn(rows, by);
  if (!groupCol) throw new Error(`top_per_group: no column named "${group_by}"`);
  if (!column) throw new Error(`top_per_group: no column named "${by}"`);
  const keep = Math.max(1, Number(n) || 1);
  const groups = new Map();
  for (const r of rows) { const g = String(r[groupCol] ?? ''); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
  const out = [];
  for (const rs of groups.values()) {
    const sorted = rs.map(r => ({ r, v: num(r[column]) })).filter(x => x.v !== null).sort((a, b) => order === 'asc' ? a.v - b.v : b.v - a.v);
    sorted.slice(0, keep).forEach((x, i) => out.push({ ...x.r, rank: i + 1 }));
  }
  return out;
}

function aggregate(rows, { group_by, column, metrics = ['count'] }) {
  const col = column ? findColumn(rows, column) : null;
  if (column && !col) throw new Error(`aggregate: no column named "${column}"`);
  const groupCol = group_by ? findColumn(rows, group_by) : null;
  if (group_by && !groupCol) throw new Error(`aggregate: no column named "${group_by}"`);
  const groups = new Map();
  for (const r of rows) { const g = groupCol ? String(r[groupCol] ?? '') : 'all'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
  const out = [];
  for (const [g, rs] of groups) {
    const vals = col ? rs.map(r => num(r[col])).filter(v => v !== null) : [];
    const sorted = [...vals].sort((a, b) => a - b);
    const o = groupCol ? { [groupCol]: g } : {};
    for (const m of metrics) {
      if (m === 'count') o.count = rs.length;
      else if (m === 'sum') o.sum = vals.reduce((s, v) => s + v, 0);
      else if (m === 'mean') o.mean = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      else if (m === 'median') o.median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
      else if (m === 'min') o.min = sorted.length ? sorted[0] : null;
      else if (m === 'max') o.max = sorted.length ? sorted[sorted.length - 1] : null;
    }
    out.push(o);
  }
  return out;
}

function compute(rows, name, expr) {
  const m = /^\s*(log2\()?\s*([\w .\-()\[\]]+?)\s*(?:([-+*/])\s*([\w .\-()\[\]]+?))?\s*\)?\s*$/.exec(String(expr || ''));
  const abs = /^\s*abs\(\s*(.+?)\s*\)\s*$/.exec(String(expr || ''));
  if (abs) { const col = findColumn(rows, abs[1]); if (!col) throw new Error(`compute: no column "${abs[1]}"`); return rows.map(r => ({ ...r, [name]: num(r[col]) === null ? null : Math.abs(num(r[col])) })); }
  if (!m) throw new Error(`compute: cannot read "${expr}"`);
  const log2 = Boolean(m[1]);
  const a = findColumn(rows, m[2]);
  const b = m[4] ? findColumn(rows, m[4]) : null;
  if (!a || (m[4] && !b)) throw new Error(`compute: no column "${!a ? m[2] : m[4]}"`);
  return rows.map(r => {
    const x = num(r[a]), y = b ? num(r[b]) : null;
    if (x === null || (b && y === null)) return { ...r, [name]: null };
    let v = x;
    if (b) v = m[3] === '/' ? (y === 0 ? null : x / y) : m[3] === '-' ? x - y : m[3] === '+' ? x + y : x * y;
    if (log2) v = v === null || v <= 0 ? null : Math.log2(v);
    return { ...r, [name]: v === null ? null : Number(v.toFixed(4)) };
  });
}

function pivot(rows, { row = 'gene', column = 'entity', value = 'value', top = 0, top_columns = 0 } = {}) {
  const rc = findColumn(rows, row), cc = findColumn(rows, column), vc = findColumn(rows, value);
  if (!rc || !cc || !vc) throw new Error(`pivot: needs columns ${row}, ${column}, ${value}`);
  const rowLabels = [], colLabels = [], ri = new Map(), ci = new Map();
  for (const r of rows) { const a = String(r[rc] ?? ''), b = String(r[cc] ?? ''); if (!ri.has(a)) { ri.set(a, rowLabels.length); rowLabels.push(a); } if (!ci.has(b)) { ci.set(b, colLabels.length); colLabels.push(b); } }
  const matrix = rowLabels.map(() => Array(colLabels.length).fill(0));
  for (const r of rows) { const v = num(r[vc]); if (v !== null) matrix[ri.get(String(r[rc] ?? ''))][ci.get(String(r[cc] ?? ''))] = v; }
  let keepRows = rowLabels.map((_, i) => i);
  if (top > 0 && top < rowLabels.length) keepRows = keepRows.map(i => ({ i, s: Math.max(...matrix[i]) })).sort((a, b) => b.s - a.s).slice(0, top).map(x => x.i);
  let keepCols = colLabels.map((_, j) => j);
  if (top_columns > 0 && top_columns < colLabels.length) keepCols = keepCols.map(j => ({ j, s: Math.max(...keepRows.map(i => matrix[i][j])) })).sort((a, b) => b.s - a.s).slice(0, top_columns).map(x => x.j);
  return { matrix: keepRows.map(i => keepCols.map(j => matrix[i][j])), row_labels: keepRows.map(i => rowLabels[i]), col_labels: keepCols.map(j => colLabels[j]) };
}

// A chart specification for the renderer from named columns; generic across chart types.
function chartSpec(args, input) {
  const base = { type: args.type, title: args.title || '', x_label: args.x_label || '', y_label: args.y_label || '' };
  if (args.type === 'heatmap') {
    if (!input || !Array.isArray(input.matrix)) throw new Error('chart: heatmap needs a pivot output');
    return { ...base, matrix: input.matrix, row_labels: input.row_labels, col_labels: input.col_labels };
  }
  const rows = Array.isArray(input) ? input : input?.rows || [];
  if (!rows.length) throw new Error('chart: no rows');
  const x = findColumn(rows, args.x) || findColumn(rows, 'gene') || findColumn(rows, 'label');
  const y = findColumn(rows, args.y) || findColumn(rows, 'value');
  if (!x || !y) throw new Error(`chart: columns not found (x ${args.x}, y ${args.y}); available: ${columnsOf(rows).join(', ')}`);
  const group = args.group ? findColumn(rows, args.group) : null;
  const size = args.size ? findColumn(rows, args.size) : null;
  if (['scatter', 'bubble', 'volcano'].includes(args.type)) {
    return { ...base, data: rows.map(r => ({ x: num(r[x]) ?? 0, y: num(r[y]) ?? 0, label: String(r.gene ?? r.label ?? r[x] ?? ''), size: size ? (num(r[size]) ?? 10) : 10 })) };
  }
  if (args.type === 'line') return { ...base, data: rows.map(r => ({ x: r[x], y: num(r[y]) ?? 0, series: group ? String(r[group]) : undefined })) };
  const data = rows.map(r => ({ label: String(r[x] ?? ''), value: num(r[y]) ?? 0, ...(group ? { group: String(r[group] ?? '') } : {}) }));
  if (['grouped_bar', 'radar', 'stacked_bar'].includes(args.type) && !group) throw new Error(`chart: ${args.type} needs a group column`);
  return { ...base, data };
}

// Exact per-gene reads from a named table: one row per gene (with an entity) or per gene per entity.
async function measure(rows, { table, value_column, entity_column, entity, as }, limit = 8) {
  const valueName = String(as || '').trim() || 'value';
  const entry = await geneData.entry(table);
  if (!entry) throw new Error(`measure: no table named "${table}" in the release`);
  const valueCol = entry.columns.find(c => lower(c) === lower(value_column));
  if (!valueCol) throw new Error(`measure: "${table}" has no column "${value_column}" (columns: ${entry.columns.join(', ')})`);
  let entityCol = entity_column ? entry.columns.find(c => lower(c) === lower(entity_column)) : null;
  if (entity_column && !entityCol) throw new Error(`measure: "${table}" has no column "${entity_column}"`);
  // No entity column named: find the one that holds the entity, or the first text column that
  // is not the gene, so "liver" reads the liver row and a long read keeps its entity names.
  const inferEntityColumn = rows => {
    if (entityCol || !rows.length) return;
    const candidates = entry.columns.filter(c => c !== valueCol && !/^(gene|ensembl|gene name)$/i.test(c));
    if (entity) {
      entityCol = candidates.find(c => rows.some(r => lower(r[c]) === lower(entity))) || null;
      if (!entityCol) throw new Error(`measure: no column of "${table}" holds "${entity}" (columns: ${entry.columns.join(', ')})`);
    } else if (rows.length > 1) {
      entityCol = candidates.find(c => rows.every(r => num(r[c]) === null && String(r[c] ?? '') !== '')) || null;
    }
  };
  const out = [];
  const queue = [...rows];
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      const gene = await geneData.resolveGene(r.ensembl || r.gene);
      if (!gene) { out.push({ gene: r.gene, ensembl: r.ensembl || null, entity: entity || null, [valueName]: null, note: 'gene not in release' }); continue; }
      let reading;
      try { reading = await geneData.read(gene, entry.file); } catch (e) { out.push({ gene: gene.gene, ensembl: gene.ensembl, entity: entity || null, [valueName]: null, note: e.message }); continue; }
      try { inferEntityColumn(reading.rows); } catch (e) { out.push({ gene: gene.gene, ensembl: gene.ensembl, entity: entity || null, [valueName]: null, note: e.message }); continue; }
      const rowsFor = entityCol && entity ? reading.rows.filter(x => lower(x[entityCol]) === lower(entity)) : reading.rows;
      if (entity || !entityCol) {
        const row = rowsFor[0];
        out.push({ gene: gene.gene, ensembl: gene.ensembl, entity: entity || null, [valueName]: row ? (num(row[valueCol]) ?? row[valueCol] ?? null) : null, ...(row ? {} : { note: 'no row' }) });
      } else {
        for (const row of rowsFor) out.push({ gene: gene.gene, ensembl: gene.ensembl, entity: row[entityCol], [valueName]: num(row[valueCol]) ?? row[valueCol] ?? null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, rows.length)) }, worker));
  return out;
}

module.exports = { TOOL_CATALOG, catalogText, applyWhere, setOp, join, select, rank, topPerGroup, aggregate, compute, pivot, chartSpec, measure, columnsOf, findColumn, keyOf, num };
