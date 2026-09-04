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

// A number from a cell; an empty cell, NA or text is null, never zero.
function num(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const text = String(v).replace(/,/g, '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
function lower(s) { return String(s ?? '').toLowerCase().trim(); }
function keyOf(row, on = null) {
  if (on) { const v = row[on]; return v === undefined || v === null || String(v).trim() === '' ? null : lower(v); }
  const v = row.ensembl || row.Ensembl || row.gene || row.Gene;
  return v ? lower(v) : null;
}
// The keys a row can match on: the named column, or else its ensembl id and its gene name, so a
// table without ensembl ids (an aggregate, a count table) still meets one that has them.
function keysOf(row, on = null) {
  if (on) { const k = keyOf(row, on); return k === null ? [] : [k]; }
  return [row.ensembl || row.Ensembl, row.gene || row.Gene].filter(v => v !== undefined && v !== null && String(v).trim() !== '').map(v => lower(v));
}
function requireKeys(rows, on, opName) {
  if (rows.some(r => !keysOf(r, on).length)) throw new Error(`${opName}: every row needs a ${on ? `"${on}"` : 'gene or ensembl'} column to match on (use concat to stack tables that share no key)`);
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
  { name: 'measure', inputs: 1, args: { table: 'a per-gene table of the database', value_column: 'the column to read', entity_column: 'optional: the column that names the entity (tissue, cell type, cancer)', entity: 'optional: which entity to read; omit to read every entity as separate rows', as: 'name for the value column in the output (default value); name it after what it holds, such as liver_nTPM, so later steps can refer to it' }, produces: 'the input rows with the value added first under the "as" name (and, when every entity is read, the entity column under its dataset name)',
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
  { name: 'compute', inputs: 1, args: { name: 'new column', expr: 'arithmetic over column names and numbers: + - * / parentheses and log2, log10, ln, abs, sqrt, exp, min, max; for example "log2((pancreas_nTPM + 1) / (liver_nTPM + 1))"' }, produces: 'the rows with the new column', description: 'Adds a column computed from numeric columns; rows where a value is missing or the result is not finite get null.' },
  { name: 'pivot', inputs: 1, args: { row: 'column for rows (default gene)', column: 'column for columns (default entity)', value: 'value column (default value)', top: 'optional: keep the N rows with the highest maximum', top_columns: 'optional: keep the N columns with the highest maximum' }, produces: 'a matrix with row_labels and col_labels, for a heatmap', description: 'Turns long rows (gene, entity, value) into a matrix; cap rows and columns for a readable heatmap.' },
  { name: 'chart', inputs: 1, args: { type: 'bar | lollipop | dot_plot | diverging_bar | grouped_bar | scatter | bubble | heatmap | radar | line | volcano', x: 'label column (bar family) or x column (scatter)', y: 'value column', group: 'optional group column (grouped_bar, radar)', size: 'optional size column (bubble)', title: 'title', x_label: 'axis label', y_label: 'axis label' }, produces: 'a figure', description: 'Draws the input table. A heatmap takes a pivot output; other types take rows with the named columns.' }
];

function catalogText() {
  return TOOL_CATALOG.map(t => `- ${t.name}: ${t.description} Inputs: ${t.inputs}. Args: ${JSON.stringify(t.args)}. Produces: ${t.produces}.`).join('\n');
}

// ---- table operations ----------------------------------------------------------------------------

function wherePredicate(columns, where = []) {
  const clauses = [];
  for (const raw of Array.isArray(where) ? where : []) {
    // Clause keys arrive occasionally wrapped in their own quotes ("\"column\""); read them anyway.
    const w = raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.replace(/^["'\s]+|["'\s]+$/g, ''), v])) : {};
    const column = columns.find(c => c === w?.column) || columns.find(c => lower(c) === lower(w?.column)) || null;
    const op = String(w?.op || '=').trim();
    if (!column) throw new Error(`filter: no column named "${w?.column}" (columns: ${columns.slice(0, 30).join(', ')})`);
    if (!OPS.includes(op)) throw new Error(`filter: unknown op "${op}"`);
    // column_b compares with another column of the same row instead of a fixed value.
    const otherName = w.column_b ?? w.other ?? w.versus ?? w.against ?? null;
    const columnB = otherName ? (columns.find(c => c === otherName) || columns.find(c => lower(c) === lower(otherName)) || null) : null;
    if (otherName && !columnB) throw new Error(`filter: no column named "${otherName}" (columns: ${columns.slice(0, 30).join(', ')})`);
    let value = w.value;
    if (op === 'in' && typeof value === 'string') {
      const text = value.trim();
      if (text.startsWith('[')) { try { value = JSON.parse(text); } catch { value = text; } }
      if (typeof value === 'string') value = value.split(/\s*[|,]\s*/).filter(Boolean);
    }
    clauses.push({ column, op, value, columnB });
  }
  return r => clauses.every(({ column, op, value: fixed, columnB }) => {
    const cell = r[column];
    const value = columnB ? r[columnB] : fixed;
    if (columnB && (value === null || value === undefined || String(value).trim() === '')) return false;
    if (op === 'in') return (Array.isArray(value) ? value : [value]).some(v => lower(v) === lower(cell));
    if (op === 'contains') return lower(cell).includes(lower(value));
    if (op === '=' || op === '!=') { const same = lower(cell) === lower(value) || (num(cell) !== null && num(cell) === num(value)); return op === '=' ? same : !same; }
    const a = num(cell), b = num(value);
    if (a === null || b === null) return false;
    return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
  });
}

function applyWhere(rows, where = []) {
  if (!rows.length) return [];
  return rows.filter(wherePredicate(columnsOf(rows), where));
}

// A result's new columns go right after gene and ensembl, so the first look at it shows what
// the step added rather than the identity columns it carried along.
function freshFirst(rows, inputColumns = []) {
  if (!rows.length) return rows;
  const cols = columnsOf(rows);
  const carried = new Set(inputColumns);
  const fresh = cols.filter(c => !carried.has(c) && c !== 'gene' && c !== 'ensembl');
  if (!fresh.length) return rows;
  const order = [...new Set(['gene', 'ensembl', ...fresh, ...cols])];
  return rows.map(r => { const o = {}; for (const k of order) if (k in r) o[k] = r[k]; return o; });
}

function setOp(kind, left, right, on = null) {
  if (kind === 'concat') return [...left, ...right];
  requireKeys(left, on, kind); requireKeys(right, on, kind);
  const rightKeys = new Set(right.flatMap(r => keysOf(r, on)));
  const inRight = r => keysOf(r, on).some(k => rightKeys.has(k));
  if (kind === 'union') { const seen = new Set(); return [...left, ...right].filter(r => { const keys = keysOf(r, on); if (keys.some(k => seen.has(k))) return false; for (const k of keys) seen.add(k); return true; }); }
  if (kind === 'intersect') return left.filter(inRight);
  if (kind === 'difference') return left.filter(r => !inRight(r));
  throw new Error(`unknown set operation ${kind}`);
}

// SQL-like: a left row joined with every right row of the same gene, so a long table (one row per
// gene and entity) keeps all its rows.
function join(left, right, how = 'inner', on = null) {
  const onCol = on ? (findColumn(left, on) || on) : null;
  const onRight = on ? (findColumn(right, on) || on) : null;
  requireKeys(left, onCol, 'join'); requireKeys(right, onRight, 'join');
  const groups = new Map();
  for (const r of right) for (const k of keysOf(r, onRight)) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const leftCols = new Set(columnsOf(left));
  const out = [];
  for (const l of left) {
    // Ensembl ids first; the gene name only when that finds nothing, so a right table with both
    // keys does not match twice.
    let matches = [];
    for (const k of keysOf(l, onCol)) { matches = groups.get(k) || []; if (matches.length) break; }
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
  if (!rows.length) return [];
  const wanted = Array.isArray(columns) && columns.length ? columns : columnsOf(rows);
  const keep = wanted.map(c => { const found = findColumn(rows, c); if (!found) throw new Error(`select: no column named "${c}" (columns: ${columnsOf(rows).slice(0, 30).join(', ')})`); return found; });
  const constants = add && typeof add === 'object' ? Object.entries(add) : [];
  return rows.map(r => { const o = {}; for (const c of keep) o[rename[c] || c] = r[c]; if (r.gene !== undefined && o.gene === undefined) o.gene = r.gene; if (r.ensembl !== undefined && o.ensembl === undefined) o.ensembl = r.ensembl; for (const [k, v] of constants) o[k] = v; return o; });
}

function rank(rows, by, order = 'desc', top = 0) {
  const column = findColumn(rows, by);
  if (!column) throw new Error(`rank: no column named "${by}"`);
  const sorted = rows.map(r => ({ r, v: num(r[column]) })).filter(x => x.v !== null).sort((a, b) => order === 'asc' ? a.v - b.v : b.v - a.v).map((x, i) => ({ ...x.r, rank: i + 1 }));
  return top > 0 ? sorted.slice(0, top) : sorted;
}

function resolveIn(columns, name) {
  if (!name) return null;
  return columns.find(c => c === name) || columns.find(c => lower(c) === lower(name)) || null;
}

// Keeps the n highest (or lowest) rows of each group as rows arrive, so a million-row dataset
// needs only groups × n rows of memory.
function topKeeper({ group_by = 'gene', by, n = 1, order = 'desc' } = {}, columns) {
  const groupCol = resolveIn(columns, group_by);
  const column = resolveIn(columns, by);
  if (!groupCol) throw new Error(`top_per_group: no column named "${group_by}" (columns: ${columns.slice(0, 30).join(', ')})`);
  if (!column) throw new Error(`top_per_group: no column named "${by}" (columns: ${columns.slice(0, 30).join(', ')})`);
  const keep = Math.max(1, Number(n) || 1);
  const asc = order === 'asc';
  const groups = new Map();
  return {
    add(r) {
      const v = num(r[column]);
      if (v === null) return;
      const g = String(r[groupCol] ?? '');
      let arr = groups.get(g);
      if (!arr) { arr = []; groups.set(g, arr); }
      const last = arr[arr.length - 1];
      if (arr.length < keep || (asc ? v < last.v : v > last.v)) {
        arr.push({ r, v });
        arr.sort((a, b) => asc ? a.v - b.v : b.v - a.v);
        if (arr.length > keep) arr.pop();
      }
    },
    result() { const out = []; for (const arr of groups.values()) arr.forEach((x, i) => out.push({ ...x.r, rank: i + 1 })); return out; }
  };
}

function topPerGroup(rows, args = {}) {
  const keeper = topKeeper(args, columnsOf(rows));
  for (const r of rows) keeper.add(r);
  return keeper.result();
}

async function topPerGroupStream(iterable, args, columns) {
  const keeper = topKeeper(args, columns);
  for await (const r of iterable) keeper.add(r);
  return keeper.result();
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const METRICS = ['count', 'sum', 'mean', 'median', 'sd', 'q1', 'q3', 'min', 'max', 'missing', 'distinct'];

// Summarises a column per group as rows arrive; values are kept per group for the order
// statistics, nothing else is held.
function aggregator({ group_by, column, metrics = ['count'] } = {}, columns) {
  const col = column ? resolveIn(columns, column) : null;
  if (column && !col) throw new Error(`aggregate: no column named "${column}" (columns: ${columns.slice(0, 30).join(', ')})`);
  const groupCol = group_by ? resolveIn(columns, group_by) : null;
  if (group_by && !groupCol) throw new Error(`aggregate: no column named "${group_by}" (columns: ${columns.slice(0, 30).join(', ')})`);
  const wanted = (Array.isArray(metrics) ? metrics : [metrics]).map(m => lower(m));
  const unknown = wanted.filter(m => !METRICS.includes(m));
  if (unknown.length) throw new Error(`aggregate: unknown metric ${unknown.join(', ')} (metrics: ${METRICS.join(', ')})`);
  if (!col && wanted.some(m => m !== 'count')) throw new Error('aggregate: name the column to summarise (only count works without one)');
  const groups = new Map();
  return {
    add(r) {
      const g = groupCol ? String(r[groupCol] ?? '') : 'all';
      let st = groups.get(g);
      if (!st) { st = { count: 0, missing: 0, vals: [], distinct: new Set() }; groups.set(g, st); }
      st.count++;
      if (col) {
        const raw = r[col];
        if (raw === null || raw === undefined || String(raw).trim() === '') st.missing++;
        else { st.distinct.add(String(raw)); const v = num(raw); if (v !== null) st.vals.push(v); }
      }
    },
    result() {
      const out = [];
      for (const [g, st] of groups) {
        const vals = st.vals;
        const sorted = [...vals].sort((a, b) => a - b);
        const sum = vals.reduce((a, v) => a + v, 0);
        const mean = vals.length ? sum / vals.length : null;
        const o = groupCol ? { [groupCol]: g } : {};
        for (const m of wanted) {
          if (m === 'count') o.count = st.count;
          else if (m === 'sum') o.sum = sum;
          else if (m === 'mean') o.mean = mean;
          else if (m === 'median') o.median = quantile(sorted, 0.5);
          else if (m === 'sd') o.sd = vals.length > 1 ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (vals.length - 1)) : null;
          else if (m === 'q1') o.q1 = quantile(sorted, 0.25);
          else if (m === 'q3') o.q3 = quantile(sorted, 0.75);
          else if (m === 'min') o.min = sorted.length ? sorted[0] : null;
          else if (m === 'max') o.max = sorted.length ? sorted[sorted.length - 1] : null;
          else if (m === 'missing') o.missing = st.missing;
          else if (m === 'distinct') o.distinct = st.distinct.size;
        }
        out.push(o);
      }
      return out;
    }
  };
}

function aggregate(rows, args = {}) {
  const acc = aggregator(args, columnsOf(rows));
  for (const r of rows) acc.add(r);
  return acc.result();
}

async function aggregateStream(iterable, args, columns) {
  const acc = aggregator(args, columns);
  for await (const r of iterable) acc.add(r);
  return acc.result();
}

// ---- statistics: whole-column and between-column maths, defined on tables only ----------------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Continued fraction for the regularized incomplete beta function (Numerical Recipes betacf).
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

// Two-sided p of a t statistic with df degrees of freedom.
function tTestP(t, df) { return ibeta(df / (df + t * t), df / 2, 0.5); }

function logChoose(n, k) { return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1); }

// P(X >= k) when a genes are drawn from N of which b belong to the other set.
function hypergeomUpper(k, a, b, N) {
  if (k <= 0) return 1;
  const denom = logChoose(N, a);
  let p = 0;
  for (let i = k; i <= Math.min(a, b); i++) {
    if (a - i > N - b) continue;
    p += Math.exp(logChoose(b, i) + logChoose(N - b, a - i) - denom);
  }
  return Math.min(1, p);
}

// Average ranks, ties sharing their mean rank.
function ranks(values) {
  const idx = values.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
  const out = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = r;
    i = j + 1;
  }
  return out;
}

const round = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const sig = p => (p === null || p === undefined || !Number.isFinite(p) ? null : Number(p.toPrecision(3)));

function correlatePairs(pairs, how) {
  const n = pairs.length;
  if (n < 3) return { n, r: null, p_value: null, note: 'fewer than 3 rows with both values' };
  let xs = pairs.map(q => q[0]), ys = pairs.map(q => q[1]);
  if (how === 'spearman') { xs = ranks(xs); ys = ranks(ys); }
  const mx = xs.reduce((a, v) => a + v, 0) / n, my = ys.reduce((a, v) => a + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return { n, r: null, p_value: null, note: 'a column has no variation' };
  const r = sxy / Math.sqrt(sxx * syy);
  const p = Math.abs(r) >= 1 ? 0 : tTestP(r * Math.sqrt((n - 2) / (1 - r * r)), n - 2);
  return { n, r: round(r, 4), p_value: sig(p) };
}

// One correlation for the table, or one per group (a gene's RNA against its protein across
// tissues, say) when group_by names a column.
function correlate(rows, { x, y, method = 'pearson', group_by } = {}) {
  const xc = findColumn(rows, x), yc = findColumn(rows, y);
  if (!xc || !yc) throw new Error(`correlate: needs two numeric columns (asked for ${x || '?'}, ${y || '?'}); columns: ${columnsOf(rows).slice(0, 30).join(', ')}`);
  const groupCol = group_by ? findColumn(rows, group_by) : null;
  if (group_by && !groupCol) throw new Error(`correlate: no column named "${group_by}" (columns: ${columnsOf(rows).slice(0, 30).join(', ')})`);
  const how = lower(method) === 'spearman' ? 'spearman' : 'pearson';
  const groups = new Map();
  for (const r of rows) { const g = groupCol ? String(r[groupCol] ?? '') : 'all'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
  const out = [];
  for (const [g, rs] of groups) {
    const pairs = rs.map(r => [num(r[xc]), num(r[yc])]).filter(([a, b]) => a !== null && b !== null);
    const stat = correlatePairs(pairs, how);
    if (!groupCol && stat.n < 3) throw new Error(`correlate: only ${stat.n} rows have both "${xc}" and "${yc}" as numbers; at least 3 are needed`);
    out.push({ ...(groupCol ? { [groupCol]: g } : {}), x: xc, y: yc, method: how, ...stat });
  }
  return out;
}

// How many genes two tables share against a universe, with the hypergeometric (one-sided,
// over-representation) p. Genes are identified through the universe, so a table keyed by name
// meets one keyed by ensembl id.
function overlapStats(A, B, N) {
  let shared = 0;
  for (const k of A) if (B.has(k)) shared++;
  const expected = N ? A.size * B.size / N : null;
  const rest = N - A.size - B.size + shared;
  const odds = (A.size - shared) > 0 && (B.size - shared) > 0 && rest > 0 ? (shared * rest) / ((A.size - shared) * (B.size - shared)) : null;
  return { a: A.size, b: B.size, shared, universe: N, expected: round(expected, 2), fold: expected ? round(shared / expected, 3) : null, odds_ratio: round(odds, 3), p_value: sig(N ? hypergeomUpper(shared, A.size, B.size, N) : null), test: 'hypergeometric, one-sided (over-representation)' };
}

// group_by tests each group of a (every cancer, every tissue) against b in one call.
function overlap(a, b, universe, on = null, group_by = null) {
  const onA = on ? (findColumn(a, on) || on) : null, onB = on ? (findColumn(b, on) || on) : null, onU = on ? (findColumn(universe, on) || on) : null;
  requireKeys(a, onA, 'overlap'); requireKeys(b, onB, 'overlap'); requireKeys(universe, onU, 'overlap');
  const groupCol = group_by ? findColumn(a, group_by) : null;
  if (group_by && !groupCol) throw new Error(`overlap: no column named "${group_by}" in a (columns: ${columnsOf(a).slice(0, 30).join(', ')})`);
  const canon = new Map();
  for (const r of universe) { const ks = keysOf(r, onU); for (const k of ks) if (!canon.has(k)) canon.set(k, ks[0]); }
  const ids = (rows, col) => { const s = new Set(); for (const r of rows) { for (const k of keysOf(r, col)) { const c = canon.get(k); if (c) { s.add(c); break; } } } return s; };
  const B = ids(b, onB);
  const N = new Set(canon.values()).size;
  if (!groupCol) return [overlapStats(ids(a, onA), B, N)];
  const groups = new Map();
  for (const r of a) { const g = String(r[groupCol] ?? ''); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
  return [...groups].map(([g, rows]) => ({ [groupCol]: g, ...overlapStats(ids(rows, onA), B, N) }));
}

function standardize(rows, { column, method = 'zscore', as } = {}) {
  const col = findColumn(rows, column);
  if (!col) throw new Error(`standardize: no column named "${column}" (columns: ${columnsOf(rows).slice(0, 30).join(', ')})`);
  const how = lower(method);
  const name = String(as || '').trim() || `${col}_${how}`;
  const vals = rows.map(r => num(r[col]));
  const present = vals.filter(v => v !== null);
  if (!present.length) throw new Error(`standardize: no numeric values in "${col}"`);
  let f;
  if (how === 'zscore') {
    const mean = present.reduce((a, v) => a + v, 0) / present.length;
    const sd = present.length > 1 ? Math.sqrt(present.reduce((a, v) => a + (v - mean) ** 2, 0) / (present.length - 1)) : 0;
    f = v => (sd ? (v - mean) / sd : 0);
  } else if (how === 'minmax') {
    const lo = Math.min(...present), hi = Math.max(...present);
    f = v => (hi > lo ? (v - lo) / (hi - lo) : 0);
  } else if (how === 'percentile') {
    const byValue = new Map();
    ranks(present).forEach((rk, i) => byValue.set(present[i], (rk - 0.5) / present.length * 100));
    f = v => byValue.get(v);
  } else throw new Error(`standardize: unknown method "${method}" (zscore, minmax, percentile)`);
  return rows.map((r, i) => ({ ...r, [name]: vals[i] === null ? null : round(f(vals[i]), 4) }));
}

// A small arithmetic language for compute: column names (quote names with spaces), numbers,
// + - * / and parentheses, and the functions log2, log10, ln, abs, sqrt, exp, min, max.
// Every row gets the value, or null where a column it needs is missing or the result is not finite.
const FUNCTIONS = { log2: Math.log2, log10: Math.log10, ln: Math.log, log: Math.log, abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, min: Math.min, max: Math.max };

function parseExpression(text) {
  const tokens = [];
  // Column names with spaces or symbols go in double, single or back quotes.
  const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?)|("[^"]*"|'[^']*'|`[^`]*`)|([A-Za-z_][\w.]*)|([-+*/(),]))/y;
  let i = 0;
  while (i < text.length) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m || m.index !== i) throw new Error(`compute: cannot read "${text}" near "${text.slice(i, i + 12)}"`);
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2].slice(1, -1), quoted: true });
    else if (m[3] !== undefined) tokens.push({ t: 'id', v: m[3] });
    else tokens.push({ t: 'op', v: m[4] });
    i = re.lastIndex;
    if (/^\s*$/.test(text.slice(i))) break;
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const expect = v => { const tok = take(); if (!tok || tok.v !== v) throw new Error(`compute: expected "${v}" in "${text}"`); };
  const parseSum = () => { let node = parseProduct(); while (peek() && (peek().v === '+' || peek().v === '-')) { const op = take().v; node = { op, a: node, b: parseProduct() }; } return node; };
  const parseProduct = () => { let node = parseUnary(); while (peek() && (peek().v === '*' || peek().v === '/')) { const op = take().v; node = { op, a: node, b: parseUnary() }; } return node; };
  const parseUnary = () => { if (peek() && peek().v === '-') { take(); return { op: 'neg', a: parseUnary() }; } return parseAtom(); };
  const parseAtom = () => {
    const tok = take();
    if (!tok) throw new Error(`compute: unexpected end of "${text}"`);
    if (tok.t === 'num') return { num: tok.v };
    if (tok.t === 'op' && tok.v === '(') { const node = parseSum(); expect(')'); return node; }
    if (tok.t === 'id') {
      if (peek() && peek().v === '(' && FUNCTIONS[tok.v.toLowerCase()]) {
        take();
        const args = [parseSum()];
        while (peek() && peek().v === ',') { take(); args.push(parseSum()); }
        expect(')');
        return { fn: tok.v.toLowerCase(), args };
      }
      return { col: tok.v, quoted: !!tok.quoted };
    }
    throw new Error(`compute: unexpected "${tok.v}" in "${text}"`);
  };
  const tree = parseSum();
  if (pos < tokens.length) throw new Error(`compute: unexpected "${tokens[pos].v}" in "${text}"`);
  return tree;
}

function colNodes(tree, out = []) {
  if (!tree || typeof tree !== 'object') return out;
  if (tree.col) out.push(tree);
  for (const k of ['a', 'b']) if (tree[k]) colNodes(tree[k], out);
  for (const a of tree.args || []) colNodes(a, out);
  return out;
}

function columnsIn(tree, out = []) {
  if (!tree) return out;
  if (tree.col) out.push(tree.col);
  if (tree.a) columnsIn(tree.a, out);
  if (tree.b) columnsIn(tree.b, out);
  for (const a of tree.args || []) columnsIn(a, out);
  return out;
}

function evaluate(tree, row, resolved) {
  if (tree.num !== undefined) return tree.num;
  if (tree.str !== undefined) return tree.str;
  if (tree.col) {
    const raw = row[resolved.get(tree.col)];
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    const n = num(raw);
    return n === null ? String(raw) : n;
  }
  if (tree.fn) { const vals = tree.args.map(a => evaluate(a, row, resolved)); return vals.some(v => typeof v !== 'number') ? null : FUNCTIONS[tree.fn](...vals); }
  const a = evaluate(tree.a, row, resolved);
  if (tree.op === 'neg') return typeof a === 'number' ? -a : null;
  const b = evaluate(tree.b, row, resolved);
  if (a === null || b === null) return null;
  if (tree.op === '+') return typeof a === 'string' || typeof b === 'string' ? `${a}${b}` : a + b;
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  if (tree.op === '-') return a - b;
  if (tree.op === '*') return a * b;
  return b === 0 ? null : a / b;
}

// Column names with spaces or symbols may appear bare in an expression; they are quoted here,
// longest first and only outside existing quotes, so "Conc. blood IM [pg/L] + 0" reads as meant.
function autoQuote(expr, columns) {
  const needs = columns.filter(c => c && !/^[A-Za-z_][\w.]*$/.test(c)).sort((a, b) => b.length - a.length);
  let out = String(expr);
  for (const c of needs) {
    out = out.split(/("[^"]*"|'[^']*'|`[^`]*`)/).map((part, i) => (i % 2 ? part : part.split(c).join(`"${c}"`))).join('');
  }
  return out;
}

function compute(rows, name, expr) {
  const tree = parseExpression(autoQuote(String(expr || ''), columnsOf(rows)));
  const resolved = new Map();
  for (const node of colNodes(tree)) {
    const found = findColumn(rows, node.col);
    if (found) { resolved.set(node.col, found); continue; }
    // A quoted token that names no column is a piece of text, as in a + " / " + b.
    if (node.quoted) { node.str = node.col; delete node.col; continue; }
    throw new Error(`compute: no column "${node.col}" (columns: ${columnsOf(rows).slice(0, 20).join(', ')})`);
  }
  return rows.map(r => { const v = evaluate(tree, r, resolved); return { ...r, [name]: typeof v === 'string' ? v : (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(4))) }; });
}

function pivot(rows, { row = 'gene', column, value, top = 0, top_columns = 0 } = {}) {
  const rc = findColumn(rows, row), cc = findColumn(rows, column), vc = findColumn(rows, value);
  if (!rc || !cc || !vc) throw new Error(`pivot: needs row, column and value columns (asked for ${row}, ${column || '?'}, ${value || '?'}); columns: ${columnsOf(rows).slice(0, 30).join(', ')}`);
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
      // The input row travels along: a measure adds a column to the table it was given.
      const ident = { gene: gene ? gene.gene : r.gene, ensembl: gene ? gene.ensembl : (r.ensembl || null) };
      const rest = { ...r };
      for (const k of ['gene', 'ensembl', 'note', valueName]) delete rest[k];
      const make = (fresh, extra = {}) => { const o = { ...ident, ...fresh }; for (const [k, v] of Object.entries(rest)) if (!(k in o)) o[k] = v; return Object.assign(o, extra); };
      if (!gene) { out.push(make({ [valueName]: null }, { note: 'gene not in release' })); continue; }
      let reading;
      try { reading = await geneData.read(gene, entry.file); } catch (e) { out.push(make({ [valueName]: null }, { note: e.message })); continue; }
      try { inferEntityColumn(reading.rows); } catch (e) { out.push(make({ [valueName]: null }, { note: e.message })); continue; }
      const rowsFor = entityCol && entity ? reading.rows.filter(x => lower(x[entityCol]) === lower(entity)) : reading.rows;
      if (entity || !entityCol) {
        const row = rowsFor[0];
        out.push(make({ [valueName]: row ? (num(row[valueCol]) ?? row[valueCol] ?? null) : null }, row ? {} : { note: 'no row' }));
      } else {
        for (const row of rowsFor) out.push(make({ [entityCol]: row[entityCol], [valueName]: num(row[valueCol]) ?? row[valueCol] ?? null }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, rows.length)) }, worker));
  return out;
}

module.exports = { TOOL_CATALOG, catalogText, applyWhere, wherePredicate, freshFirst, aggregateStream, topPerGroupStream, correlate, overlap, standardize, setOp, join, select, rank, topPerGroup, aggregate, compute, pivot, chartSpec, measure, columnsOf, findColumn, keyOf, num };
