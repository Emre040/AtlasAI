'use strict';

// Numbers a summary states, with the precision they were written at: a decimal, a number of a
// thousand or more, or scientific notation. Small whole numbers (counts, ranks, list markers)
// are too ambiguous to check.
const NUMBER = /(?<![\w.])[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+−]?\d+)?(?![\w])/g;
// Scientific notation in human-readable reports denotes the same number as e notation.
// Match it as one span so its mantissa is never screened as a separate measurement.
const SCIENTIFIC = /(?<![\w.])([-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:×|⋅|·|\*)\s*10\s*(?:\^\s*([+\-−]?\d+)|([⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+))(?![\w⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻])/g;
const SUPERSCRIPT = Object.fromEntries([...'⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻'].map((symbol, i) => [symbol, '0123456789+-'[i]]));
function numericMentions(text) {
  const value = String(text || ''), found = [], spans = [];
  for (const match of value.matchAll(SCIENTIFIC)) {
    const exponent = match[2] === undefined ? [...match[3]].map(c => SUPERSCRIPT[c]).join('') : match[2].replaceAll('−', '-');
    found.push({ raw: match[0], clean: `${match[1].replace(/,/g, '').replaceAll('−', '-')}e${exponent}`, index: match.index });
    spans.push([match.index, match.index + match[0].length]);
  }
  for (const match of value.matchAll(NUMBER)) {
    if (!spans.some(([start, end]) => match.index >= start && match.index < end)) found.push({ raw: match[0], clean: match[0].replace(/,/g, '').replaceAll('−', '-'), index: match.index });
  }
  return found.sort((a, b) => a.index - b.index);
}
function statedNumbers(text) {
  const out = [];
  for (const { raw, clean } of numericMentions(text)) {
    const value = Number(clean);
    if (!Number.isFinite(value)) continue;
    const mantissa = clean.split(/[eE]/)[0];
    const exponent = /[eE]/.test(clean) ? Number(clean.split(/[eE]/)[1]) : 0;
    const decimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
    if (!mantissa.includes('.') && !exponent && Math.abs(value) < 1000) continue;
    out.push({ raw, value, tolerance: 0.5 * 10 ** (exponent - decimals) });
  }
  return out;
}

// Every number an artifact holds, sorted, computed once: numeric cells, numbers inside text
// and saved JSON values, matrix cells. Object keys are labels, not recorded values.
function artifactNumbers(a) {
  if (a.numbersSorted) return a.numbersSorted;
  const values = [];
  const push = v => { if (Number.isFinite(v)) values.push(v); };
  const visit = v => {
    if (typeof v === 'number') push(v);
    else if (typeof v === 'string' && v && /\d/.test(v)) { const n = Number(v.replace(/,/g, '')); if (Number.isFinite(n)) push(n); else for (const m of numericMentions(v)) push(Number(m.clean)); }
    else if (Array.isArray(v)) for (const item of v) visit(item);
    else if (v !== null && typeof v === 'object') for (const item of Object.values(v)) visit(item);
  };
  if (a.rows) for (const r of a.rows) for (const v of Object.values(r)) visit(v);
  const matrix = a.matrix?.matrix || a.figure?.matrix;
  if (matrix) for (const row of matrix) for (const v of row) if (v !== null && v !== undefined) push(Number(v));
  if (a.figure?.data) for (const point of a.figure.data) for (const key of ['x', 'y', 'value']) if (point[key] !== null && point[key] !== undefined) push(Number(point[key]));
  a.numbersSorted = Float64Array.from(values).sort();
  return a.numbersSorted;
}

function nearIn(sorted, x, tol) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x - tol) lo = mid + 1; else hi = mid; }
  return lo < sorted.length && sorted[lo] <= x + tol + 1e-9 * Math.abs(x);
}
const holds = (sorted, value, tolerance) => nearIn(sorted, value, tolerance);

function evidenceBlocks(text) {
  const paragraphs = String(text).split(/\n\s*\n/).filter(p => p.trim());
  const references = p => [...new Set(String(p).match(/\ba\d+\b/g) || [])];
  let listSources = [];
  return paragraphs.map((paragraph, i) => {
    const ids = references(paragraph);
    const isList = /^\s*(?:[-*+]\s|\d+[.)]\s)/.test(paragraph);
    if (isList) ids.push(...listSources);
    else listSources = /:\s*$/.test(paragraph) ? [...ids] : [];
    if (/^\s*\|/m.test(paragraph)) {
      const before = paragraphs[i - 1] || '';
      const after = (paragraphs[i + 1] || '').replace(/[*_()`]/g, '').trim();
      if (/:\s*$/.test(before)) ids.push(...references(before));
      if (/^source\s*:/i.test(after)) ids.push(...references(after));
    }
    return { text: paragraph, ids: [...new Set(ids)] };
  });
}

// Screen numbers against explicit paragraph/table citations. This is not a scientific claim
// verifier: it does not prove row/column identity or the direction of a comparison. Unit
// conversions must be materialized by compute, never guessed through power-of-ten matches.
function verificationIssues(summary, state) {
  const text = String(summary || '');
  const common = Float64Array.from([
    ...state.artifacts.filter(a => a.rows).map(a => a.rows.length),
    ...numericMentions(state.goal).map(m => Number(m.clean))
  ].filter(Number.isFinite)).sort();
  const issues = [];
  for (const block of evidenceBlocks(text)) {
    const here = block.ids.filter(id => state.byId.has(id));
    const sources = here.map(id => state.byId.get(id));
    const missing = [];
    for (const { raw, value, tolerance } of statedNumbers(block.text)) {
      const ok = holds(common, value, tolerance) || sources.some(a => holds(artifactNumbers(a), value, tolerance));
      if (!ok && !missing.includes(raw)) missing.push(raw);
    }
    if (missing.length) issues.push({ paragraph: block.text, artifacts: here, numbers: missing, reason: here.length ? 'number_not_in_cited_artifacts' : 'no_source_citation' });
  }
  return issues;
}

function unverifiedNumbers(summary, state) {
  return [...new Set(verificationIssues(summary, state).flatMap(issue => issue.numbers))];
}

module.exports = { statedNumbers, unverifiedNumbers, verificationIssues };
