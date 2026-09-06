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
function aggregator({ group_by, group_by_columns, column, metrics = ['count'] } = {}, columns) {
  const col = column ? resolveIn(columns, column) : null;
  if (column && !col) throw new Error(`aggregate: no column named "${column}" (columns: ${columns.slice(0, 30).join(', ')})`);
  const groupCol = group_by ? resolveIn(columns, group_by) : null;
  if (group_by && !groupCol) throw new Error(`aggregate: no column named "${group_by}" (columns: ${columns.slice(0, 30).join(', ')})`);
  if (group_by_columns !== undefined && (!Array.isArray(group_by_columns) || !group_by_columns.length)) throw new Error('aggregate: group_by_columns must be a nonempty array');
  if (group_by && group_by_columns !== undefined) throw new Error('aggregate: use group_by or group_by_columns, not both');
  const groupCols = (group_by_columns || []).map(name => {
    const found = resolveIn(columns, name);
    if (!found) throw new Error(`aggregate: no grouping column named "${name}"`);
    return found;
  });
  if (new Set(groupCols).size !== groupCols.length) throw new Error('aggregate: grouping columns must be distinct');
  const wanted = (Array.isArray(metrics) ? metrics : [metrics]).map(m => lower(m));
  const unknown = wanted.filter(m => !METRICS.includes(m));
  if (unknown.length) throw new Error(`aggregate: unknown metric ${unknown.join(', ')} (metrics: ${METRICS.join(', ')})`);
  if (!col && wanted.some(m => m !== 'count')) throw new Error('aggregate: name the column to summarise (only count works without one)');
  const groups = new Map();
  return {
    add(r) {
      const labels = groupCols.map(name => r[name] === undefined ? null : r[name]);
      const g = groupCols.length ? JSON.stringify(labels) : groupCol ? String(r[groupCol] ?? '') : 'all';
      let st = groups.get(g);
      if (!st) { st = { labels, count: 0, missing: 0, vals: [], distinct: new Set() }; groups.set(g, st); }
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
        const o = groupCols.length ? Object.fromEntries(groupCols.map((name, index) => [name, st.labels[index]])) : groupCol ? { [groupCol]: g } : {};
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

// ---- list cells: their grammar, exploding them into rows, and profiling columns -------------------

const LIST_SEPS = [';', ',', '|'];

// How the text cells of a column are built: a separator (when most cells have one) and the
// shape of an item: "key: number", "label (number)" or a plain item.
function listGrammar(values) {
  const sample = values.slice(0, 300);
  if (!sample.length) return null;
  let best = null;
  for (const sep of LIST_SEPS) {
    const count = sample.filter(v => v.includes(sep)).length;
    if (count / sample.length >= 0.3 && (!best || count > best.count)) best = { sep, count };
  }
  const items = best ? sample.flatMap(v => v.split(best.sep).map(x => x.trim()).filter(Boolean)) : sample;
  const kv = items.filter(x => /^[^:]+:\s*[-+]?\d/.test(x)).length / Math.max(1, items.length);
  const paren = items.filter(x => /^.+\s\(([-+]?\d[^)]*)\)$/.test(x)).length / Math.max(1, items.length);
  return { sep: best ? best.sep : null, shape: kv >= 0.6 ? 'key: number' : paren >= 0.6 ? 'label (number)' : 'item' };
}

// One row per item of a list cell; "key: number" items become two columns, "label (number)" too.
function explode(rows, column, as) {
  const col = findColumn(rows, column);
  if (!col) throw new Error(`explode: no column named "${column}" (columns: ${columnsOf(rows).slice(0, 30).join(', ')})`);
  const values = rows.map(r => r[col]).filter(v => v !== null && v !== undefined && String(v).trim() !== '').map(String);
  const grammar = listGrammar(values) || { sep: null, shape: 'item' };
  const base = String(as || col).trim();
  const out = [];
  for (const r of rows) {
    const raw = r[col];
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    const items = grammar.sep ? String(raw).split(grammar.sep).map(x => x.trim()).filter(Boolean) : [String(raw).trim()];
    for (const item of items) {
      const o = { ...r };
      delete o[col];
      if (grammar.shape === 'key: number') { const i = item.indexOf(':'); o[`${base}_key`] = item.slice(0, i).trim(); const v = item.slice(i + 1).trim(); o[`${base}_value`] = num(v) ?? v; }
      else if (grammar.shape === 'label (number)') { const m = item.match(/^(.+)\s\(([^)]*)\)$/); o[`${base}_label`] = m ? m[1].trim() : item; o[`${base}_value`] = m ? (num(m[2]) ?? m[2]) : null; }
      else o[`${base}_item`] = item;
      out.push(o);
    }
  }
  return out;
}

// A column card per column as rows arrive: kind, blanks, distinct values, examples, range, grammar.
function profiler(columns) {
  const st = new Map(columns.map(c => [c, { n: 0, blank: 0, nums: 0, min: Infinity, max: -Infinity, distinct: new Map(), samples: [] }]));
  return {
    add(r) {
      for (const c of columns) {
        const s = st.get(c);
        s.n++;
        const v = r[c];
        const t = v === null || v === undefined ? '' : String(v).trim();
        if (!t) { s.blank++; continue; }
        const x = num(t);
        if (x !== null) { s.nums++; if (x < s.min) s.min = x; if (x > s.max) s.max = x; }
        if (s.distinct.has(t)) s.distinct.set(t, s.distinct.get(t) + 1); else if (s.distinct.size < 1000) s.distinct.set(t, 1);
        if (s.samples.length < 300) s.samples.push(t);
      }
    },
    result() {
      return columns.map(c => {
        const s = st.get(c);
        const filled = s.n - s.blank;
        const kind = filled === 0 ? 'empty' : s.nums / filled >= 0.95 ? 'number' : 'text';
        const top = [...s.distinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v]) => (v.length > 40 ? `${v.slice(0, 39)}…` : v));
        const fullExamples = [...s.distinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v]) => v);
        const grammar = kind === 'text' ? listGrammar(s.samples) : null;
        return {
          column: c, kind, rows: s.n, blank_pct: s.n ? Math.round(100 * s.blank / s.n) : 0,
          distinct: s.distinct.size >= 1000 ? '1000+' : String(s.distinct.size), examples: top,
          full_examples: fullExamples,
          observed_values: kind === 'text' && s.distinct.size < 1000 ? [...s.distinct.keys()] : null,
          min: kind === 'number' ? s.min : undefined, max: kind === 'number' ? s.max : undefined,
          list: grammar && grammar.sep ? `list of '${grammar.shape}' items separated by '${grammar.sep}'` : (grammar && grammar.shape !== 'item' ? `'${grammar.shape}'` : undefined)
        };
      });
    }
  };
}

function profile(rows, columns) {
  const cols = columns && columns.length ? columns : columnsOf(rows);
  const p = profiler(cols);
  for (const r of rows) p.add(r);
  return p.result();
}

async function profileStream(iterable, columns, maxRows = Infinity) {
  const p = profiler(columns);
  let n = 0;
  for await (const r of iterable) { p.add(r); if (++n >= maxRows) break; }
  return { profile: p.result(), rows: n };
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
  const matrix = rowLabels.map(() => Array(colLabels.length).fill(null));
  const filled = new Set();
  for (const r of rows) {
    const i = ri.get(String(r[rc] ?? '')), j = ci.get(String(r[cc] ?? ''));
    const key = `${i}:${j}`;
    if (filled.has(key)) throw new Error(`pivot: duplicate cell for ${r[rc]}, ${r[cc]}; aggregate duplicates explicitly first`);
    filled.add(key); matrix[i][j] = num(r[vc]);
  }
  const maximum = values => Math.max(-Infinity, ...values.filter(v => v !== null));
  let keepRows = rowLabels.map((_, i) => i);
  if (top > 0 && top < rowLabels.length) keepRows = keepRows.map(i => ({ i, s: maximum(matrix[i]) })).sort((a, b) => b.s - a.s).slice(0, top).map(x => x.i);
  let keepCols = colLabels.map((_, j) => j);
  if (top_columns > 0 && top_columns < colLabels.length) keepCols = keepCols.map(j => ({ j, s: maximum(keepRows.map(i => matrix[i][j])) })).sort((a, b) => b.s - a.s).slice(0, top_columns).map(x => x.j);
  return { matrix: keepRows.map(i => keepCols.map(j => matrix[i][j])), row_labels: keepRows.map(i => rowLabels[i]), col_labels: keepCols.map(j => colLabels[j]) };
}

// A chart specification for the renderer from named columns; generic across chart types.
function chartSpec(args, input) {
  const base = { type: args.type, title: args.title || '', x_label: args.x_label || '', y_label: args.y_label || '' };
  if (args.type === 'heatmap') {
    if (!input || !Array.isArray(input.matrix)) throw new Error('chart: heatmap needs a pivot output');
    return { ...base, matrix: input.matrix, row_labels: input.row_labels, col_labels: input.col_labels };
  }
  let rows = Array.isArray(input) ? input : input?.rows || [];
  if (!rows.length) throw new Error('chart: no rows');
  const x = findColumn(rows, args.x);
  const y = findColumn(rows, args.y);
  if (!x || !y) throw new Error(`chart: columns not found (x ${args.x}, y ${args.y}); available: ${columnsOf(rows).join(', ')}`);
  const group = args.group ? findColumn(rows, args.group) : null;
  const size = args.size ? findColumn(rows, args.size) : null;
  const label = args.label ? findColumn(rows, args.label) : null;
  if (args.group && !group) throw new Error(`chart: no group column ${args.group}`);
  if (args.size && !size) throw new Error(`chart: no size column ${args.size}`);
  if (args.label && !label) throw new Error(`chart: no label column ${args.label}`);
  const numeric = [y, ...(['scatter', 'bubble', 'volcano'].includes(args.type) ? [x] : []), ...(size ? [size] : [])];
  const valid = rows.filter(r => numeric.every(c => num(r[c]) !== null));
  base.omitted_rows = rows.length - valid.length;
  if (base.omitted_rows && args.missing !== 'omit') throw new Error(`chart: ${base.omitted_rows} rows have missing numeric values; inspect them, then use missing=omit to exclude them explicitly`);
  rows = valid;
  if (!rows.length) throw new Error('chart: no rows with measured numeric values');
  if (['scatter', 'bubble', 'volcano'].includes(args.type)) {
    return { ...base, data: rows.map(r => ({ x: num(r[x]), y: num(r[y]), label: label ? String(r[label] ?? '') : '', size: size ? num(r[size]) : 10 })) };
  }
  if (args.type === 'line') return { ...base, data: rows.map(r => ({ x: r[x], y: num(r[y]), series: group ? String(r[group]) : undefined })) };
  const data = rows.map(r => ({ label: String(r[x] ?? ''), value: num(r[y]), ...(group ? { group: String(r[group] ?? '') } : {}) }));
  if (['grouped_bar', 'radar', 'stacked_bar'].includes(args.type) && !group) throw new Error(`chart: ${args.type} needs a group column`);
  return { ...base, data };
}

// Exact per-gene reads from a named table: one row per gene (with an entity) or per gene per entity.
async function measure(rows, { table, value_column, entity_column, entity, as, aggregate: reducer }, limit = 8) {
  const valueName = String(as || '').trim();
  if (!valueName) throw new Error('measure: as must name the output column');
  if (entity && !entity_column) throw new Error('measure: entity requires an explicit entity_column');
  if (reducer && !['min', 'max', 'mean', 'median'].includes(reducer)) throw new Error(`measure: unsupported aggregate ${reducer}`);
  const entry = await geneData.entry(table);
  if (!entry) throw new Error(`measure: no table named "${table}" in the release`);
  const valueCol = entry.columns.find(c => lower(c) === lower(value_column));
  if (!valueCol) throw new Error(`measure: "${table}" has no column "${value_column}" (columns: ${entry.columns.join(', ')})`);
  let entityCol = entity_column ? entry.columns.find(c => lower(c) === lower(entity_column)) : null;
  if (entity_column && !entityCol) throw new Error(`measure: "${table}" has no column "${entity_column}"`);
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
      const reading = await geneData.read(gene, entry.file);
      const rowsFor = entityCol && entity ? reading.rows.filter(x => lower(x[entityCol]) === lower(entity)) : reading.rows;
      if (entity || !entityCol || reducer) {
        if (rowsFor.length > 1 && !reducer) throw new Error(`measure: ${gene.ensembl} has ${rowsFor.length} matching rows in ${table}; select an entity, provide aggregate explicitly, or intersect the raw dataset with the gene artifact to retain all rows`);
        if (reducer) {
          const values = rowsFor.map(row => num(row[valueCol])).filter(v => v !== null).sort((a, b) => a - b);
          const n = values.length;
          const value = !n ? null : reducer === 'min' ? values[0] : reducer === 'max' ? values[n - 1] : reducer === 'mean' ? values.reduce((a, b) => a + b, 0) / n : n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
          out.push(make({ [valueName]: value, [`${valueName}_source_rows`]: rowsFor.length, [`${valueName}_numeric_rows`]: n }));
          continue;
        }
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

module.exports = { applyWhere, wherePredicate, freshFirst, aggregateStream, topPerGroupStream, correlate, overlap, standardize, explode, profile, profileStream, listGrammar, setOp, join, select, rank, topPerGroup, aggregate, compute, pivot, chartSpec, measure, columnsOf, findColumn, keyOf, num };
