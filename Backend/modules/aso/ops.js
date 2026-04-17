'use strict';

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.+-eE]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function rankArray(rows = [], { key = 'value', top = 0, order = 'desc' } = {}) {
  const sorted = rows
    .map(r => ({ ...r, __v: toNumber(r[key]) }))
    .filter(r => r.__v !== null)
    .sort((a, b) => order === 'asc' ? a.__v - b.__v : b.__v - a.__v);
  const sliced = top > 0 ? sorted.slice(0, top) : sorted;
  return sliced.map((r, idx) => ({ ...r, rank: idx + 1 }));
}

function compareDelta(rowsA = [], rowsB = [], { key = 'value', outKey = 'delta', joinKey = 'gene' } = {}) {
  const mapA = new Map();
  rowsA.forEach(r => {
    const id = String(r[joinKey] || '').toUpperCase();
    const val = toNumber(r[key]);
    if (id && val !== null) mapA.set(id, { ...r, _val: val });
  });
  const out = [];
  rowsB.forEach(r => {
    const id = String(r[joinKey] || '').toUpperCase();
    const val = toNumber(r[key]);
    if (!id || val === null) return;
    const a = mapA.get(id);
    if (!a) return;
    out.push({
      [joinKey]: r[joinKey] || a[joinKey],
      [outKey]: a._val - val,
      a_value: a._val,
      b_value: val
    });
  });
  return out;
}

function mergeLongFormat(datasets = [], { joinKey = 'gene', valueKey = 'value' } = {}) {
  const out = [];
  for (const { rows, label } of datasets) {
    for (const r of (rows || [])) {
      const id = r[joinKey];
      if (id === undefined || id === null) continue;
      const val = toNumber(r[valueKey]);
      out.push({ [joinKey]: id, value: val, group: label });
    }
  }
  return out;
}

function joinScatter(rowsA = [], rowsB = [], { joinKey = 'gene', valueKey = 'value' } = {}) {
  const mapA = new Map();
  rowsA.forEach(r => {
    const id = String(r[joinKey] || '').toUpperCase();
    const val = toNumber(r[valueKey]);
    if (id && val !== null) mapA.set(id, { label: r[joinKey], x: val });
  });
  const out = [];
  rowsB.forEach(r => {
    const id = String(r[joinKey] || '').toUpperCase();
    const val = toNumber(r[valueKey]);
    if (!id || val === null) return;
    const a = mapA.get(id);
    if (!a) return;
    out.push({ label: a.label, x: a.x, y: val });
  });
  return out;
}

function joinScatterAll(rowsA = [], rowsB = [], { joinKey = 'gene', valueKey = 'value' } = {}) {
  const mapA = new Map();
  rowsA.forEach(r => {
    const id = String(r[joinKey] || '').toUpperCase();
    const val = toNumber(r[valueKey]);
    if (id && val !== null) mapA.set(id, { label: r[joinKey], x: val });
  });
  const mapB = new Map();
  rowsB.forEach(r => {
    const id = String(r[joinKey] || '').toUpperCase();
    const val = toNumber(r[valueKey]);
    if (id && val !== null) mapB.set(id, { label: r[joinKey], y: val });
  });
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
  const out = [];
  for (const key of allKeys) {
    const a = mapA.get(key);
    const b = mapB.get(key);
    out.push({ label: a?.label || b?.label, x: a?.x ?? 0, y: b?.y ?? 0 });
  }
  return out;
}

function pivotMatrix(rows = [], { rowKey = 'gene', colKey = 'group', valueKey = 'value', topN = 0, rankByCol = '' } = {}) {
  const rowLabels = [];
  const rowIndex = new Map();
  const colLabels = [];
  const colIndex = new Map();
  for (const r of rows) {
    const rk = String(r[rowKey] ?? '');
    const ck = String(r[colKey] ?? '');
    if (!rowIndex.has(rk)) { rowIndex.set(rk, rowLabels.length); rowLabels.push(rk); }
    if (!colIndex.has(ck)) { colIndex.set(ck, colLabels.length); colLabels.push(ck); }
  }
  const matrix = Array.from({ length: rowLabels.length }, () => Array(colLabels.length).fill(0));
  for (const r of rows) {
    const ri = rowIndex.get(String(r[rowKey] ?? ''));
    const ci = colIndex.get(String(r[colKey] ?? ''));
    const val = toNumber(r[valueKey]);
    if (ri !== undefined && ci !== undefined && val !== null) matrix[ri][ci] = val;
  }

  // top_n filtering: keep only the top N rows by value
  if (topN > 0 && topN < rowLabels.length) {
    const rankCol = rankByCol ? colIndex.get(rankByCol) : null;
    // Score each row: by specific column, or by max across all columns
    const scored = rowLabels.map((label, i) => ({
      idx: i,
      score: rankCol !== undefined && rankCol !== null ? matrix[i][rankCol] : Math.max(...matrix[i])
    }));
    scored.sort((a, b) => b.score - a.score);
    const keep = scored.slice(0, topN);
    const newRowLabels = keep.map(k => rowLabels[k.idx]);
    const newMatrix = keep.map(k => matrix[k.idx]);
    return { matrix: newMatrix, row_labels: newRowLabels, col_labels: colLabels };
  }

  return { matrix, row_labels: rowLabels, col_labels: colLabels };
}

function aggregate(rows = [], { key = 'value', metric = 'mean' } = {}) {
  const vals = rows.map(r => toNumber(r[key])).filter(v => v !== null);
  if (!vals.length) return null;
  if (metric === 'min') return Math.min(...vals);
  if (metric === 'max') return Math.max(...vals);
  if (metric === 'median') {
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  // mean default
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

module.exports = { rankArray, compareDelta, aggregate, mergeLongFormat, joinScatter, joinScatterAll, pivotMatrix };
