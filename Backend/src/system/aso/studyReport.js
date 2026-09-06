'use strict';

/**
 * The report is rendered from the data, never transcribed by the model. finish names saved
 * tables and figures by id, and states findings as claims, each bound to the rows and columns
 * of the artifact it rests on. The renderer prints the bound cells beside every claim, and the
 * binder checks that every number a claim states is among those cells (or the row counts they
 * imply). A claim that cannot be bound is not accepted.
 */

const { shown } = require('./desk');
const escapeCell = value => String(value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : shown(value)).replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
const S = { type: 'string' };
const N = { type: 'integer' };

const FINISH_SCHEMA = {
  tables: { type: 'array', description: 'Saved tables to print: artifact, optional columns, title and rows (first N).', items: { type: 'object', properties: { artifact: S, columns: { type: 'array', items: S }, title: S, rows: N }, required: ['artifact'] } },
  figures: { type: 'array', items: S, description: 'Figure ids in order; omit for all, [] for none.' },
  claims: { type: 'array', description: 'Findings, each bound to the cells it rests on: artifact and rows (and columns) of one table, or evidence for several. Every number stated is among those cells.', items: { type: 'object', properties: { text: S, artifact: S, rows: { type: 'array', items: N }, columns: { type: 'array', items: S }, evidence: { type: 'array', items: { type: 'object', properties: { artifact: S, rows: { type: 'array', items: N }, columns: { type: 'array', items: S } }, required: ['artifact', 'rows'] } } }, required: ['text'] } },
  limitations: { type: 'array', items: S, description: 'What the evidence cannot establish, in words.' },
  not_done: { type: 'array', description: 'Plan items not delivered, with the reason.', items: { type: 'object', properties: { item: N, why: S }, required: ['item', 'why'] } }
};

// Numbers a text states, with the precision they were written at.
const { statedNumbers } = require('./numbers');

function numbersIn(value, out = []) {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (typeof value === 'string' && /\d/.test(value)) {
    const n = Number(value.replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n); else for (const m of statedNumbers(value)) out.push(m.value);
  } else if (Array.isArray(value)) for (const item of value) numbersIn(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) numbersIn(item, out);
  return out;
}

const near = (values, x, tol) => values.some(v => Math.abs(v - x) <= tol + 1e-9 * Math.abs(x));

function resolveColumns(artifact, columns) {
  if (columns === undefined) return artifact.columns;
  if (!Array.isArray(columns) || !columns.length) throw new Error(`columns for ${artifact.id} must be a nonempty list`);
  return columns.map(c => {
    const found = artifact.columns.find(x => x === c) || artifact.columns.find(x => x.toLowerCase() === String(c).toLowerCase());
    if (!found) throw new Error(`${artifact.id} has no column ${JSON.stringify(c)}; its columns: ${artifact.columns.join(', ')}`);
    return found;
  });
}

// What a claim rests on: the cells it names, as numbers and as text for the reader. A claim binds
// one table (artifact, rows, columns) or several (evidence: a list of such bindings).
function binding(claim, state) {
  if (Array.isArray(claim.evidence) || claim.artifact === undefined) {
    const parts = Array.isArray(claim.evidence) ? claim.evidence : [];
    if (claim.artifact !== undefined) parts.unshift({ artifact: claim.artifact, rows: claim.rows, columns: claim.columns });
    if (!parts.length) throw new Error('a claim needs artifact and rows, or evidence with at least one binding');
    const bound = parts.map(part => bindOne(part, state));
    return { artifact: bound[0].artifact, parts: bound, cells: bound.flatMap(b => b.cells), columns: bound[0].columns, values: bound.flatMap(b => b.values), counts: bound.flatMap(b => b.counts) };
  }
  const one = bindOne(claim, state);
  return { ...one, parts: [one] };
}

function bindOne(claim, state) {
  const artifact = state.byId.get(String(claim.artifact || '').trim());
  if (!artifact) throw new Error(`claim cites ${JSON.stringify(claim.artifact)}, which is not a saved artifact`);
  if (artifact.figure) {
    if (claim.rows?.length) throw new Error(`${artifact.id} is a figure; bind the claim to the table it was drawn from`);
    return { artifact, cells: [], values: numbersIn(artifact.figure.data || artifact.figure.matrix || []), counts: [] };
  }
  if (artifact.matrix) {
    const values = numbersIn(artifact.matrix.matrix);
    return { artifact, cells: [], values, counts: [artifact.matrix.row_labels.length, artifact.matrix.col_labels.length] };
  }
  const rows = artifact.rows || [];
  // An empty table is evidence of emptiness: a claim on it binds to no rows and its count is 0.
  if (!rows.length) {
    if (Array.isArray(claim.rows) && claim.rows.length) throw new Error(`${artifact.id} has no rows; a claim about it takes rows: []`);
    return { artifact, cells: [], columns: artifact.columns, values: [], counts: [0] };
  }
  if (!Array.isArray(claim.rows) || !claim.rows.length) throw new Error(`claim on ${artifact.id} must name the rows it rests on (zero-based indices, as numbered on the desk)`);
  if (claim.rows.some(i => !Number.isSafeInteger(i) || i < 0 || i >= rows.length)) throw new Error(`claim rows for ${artifact.id} must be between 0 and ${rows.length - 1}`);
  const columns = resolveColumns(artifact, claim.columns);
  const cells = [...new Set(claim.rows)].map(i => ({ index: i, values: columns.map(c => [c, rows[i][c]]) }));
  const values = numbersIn(cells.map(c => c.values.map(v => v[1])));
  const distinct = columns.map(c => new Set(cells.map(x => String(rows[x.index][c] ?? ''))).size);
  return { artifact, cells, columns, values, counts: [cells.length, rows.length, ...distinct] };
}

// Where a number lives among all saved artifacts, so a refusal says where to bind instead.
function locate(state, value, tolerance, limit = 3) {
  const hits = [];
  for (const a of state.artifacts) {
    if (!Array.isArray(a.rows)) continue;
    for (const [i, row] of a.rows.entries()) {
      for (const c of a.columns) {
        const cell = row[c];
        const n = typeof cell === 'number' ? cell : typeof cell === 'string' && /\d/.test(cell) ? Number(cell.replace(/,/g, '')) : NaN;
        if (Number.isFinite(n) && Math.abs(n - value) <= tolerance + 1e-9 * Math.abs(value)) { hits.push(`${a.id} row ${i} ${c}`); if (hits.length >= limit) return hits; }
      }
    }
  }
  return hits;
}

function claimIssue(claim, state) {
  let bound;
  try { bound = binding(claim, state); }
  catch (error) { return error.message; }
  // Numbers the bound artifacts or the artifacts they were made from were made with (a
  // threshold, a top n) are part of their evidence.
  const lineage = (a, seen = new Set()) => !a || seen.has(a.id) ? [] : (seen.add(a.id), [...numbersIn(a.args || {}), ...(a.inputs || []).flatMap(id => lineage(state.byId.get(id), seen))]);
  const argNumbers = bound.parts.flatMap(b => lineage(b.artifact));
  const unmatched = statedNumbers(claim.text).filter(({ value, tolerance }) => !near(bound.values, value, tolerance) && !near(argNumbers, value, tolerance) && !(Number.isInteger(value) && bound.counts.includes(value)));
  if (!unmatched.length) return null;
  const where = unmatched.map(u => { const hits = locate(state, u.value, u.tolerance); return `${u.raw}${hits.length ? ` is at ${hits.join(', ')}` : ' is in no saved artifact'}`; });
  const boundTo = bound.parts.map(b => `${b.artifact.id} rows ${[...new Set(b.cells.map(c => c.index))].join(', ') || '(none)'}${b.columns ? ` columns ${b.columns.join(', ')}` : ''}`).join('; ');
  return `${JSON.stringify(claim.text.length > 160 ? `${claim.text.slice(0, 159)}…` : claim.text)} states ${unmatched.map(u => u.raw).join(', ')}, not among the cells it is bound to (${boundTo}): ${where.join('; ')}. Add those rows to the claim's evidence, or compute the number with an operation and cite that result.`;
}

// Every problem with a finish call, in words the model can act on. Empty means accepted.
function reportIssues(args, state) {
  const issues = [];
  for (const [i, table] of (args.tables || []).entries()) {
    const artifact = state.byId.get(String(table?.artifact || '').trim());
    if (!artifact) { issues.push(`tables[${i}] cites ${JSON.stringify(table?.artifact)}, which is not a saved artifact`); continue; }
    if (!Array.isArray(artifact.rows)) { issues.push(`tables[${i}]: ${artifact.id} is a ${artifact.figure ? 'figure' : 'matrix'}, not a row table`); continue; }
    try { resolveColumns(artifact, table.columns); } catch (error) { issues.push(`tables[${i}]: ${error.message}`); }
    if (table.rows !== undefined && (!Number.isSafeInteger(table.rows) || table.rows < 1)) issues.push(`tables[${i}].rows must be a positive integer`);
  }
  if (args.figures !== undefined) {
    if (!Array.isArray(args.figures)) issues.push('figures must be an array of figure artifact ids');
    else for (const id of args.figures) {
      const artifact = state.byId.get(String(id || '').trim());
      if (!artifact || !artifact.figure) issues.push(`figures: ${JSON.stringify(id)} is not a saved figure`);
      else if (!artifact.images?.length) issues.push(`figures: ${artifact.id} was not rendered`);
    }
  }
  for (const [i, claim] of (args.claims || []).entries()) {
    if (!claim || typeof claim.text !== 'string' || !claim.text.trim()) { issues.push(`claims[${i}] needs text`); continue; }
    const issue = claimIssue(claim, state);
    if (issue) issues.push(`claims[${i}]: ${issue}`);
  }
  for (const [i, text] of (args.limitations || []).entries()) {
    const numbers = statedNumbers(text);
    if (numbers.length) issues.push(`limitations[${i}] states ${numbers.map(n => n.raw).join(', ')}; numbers belong in a claim bound to the rows that hold them`);
  }
  for (const [i, item] of (args.not_done || []).entries()) {
    if (!item || !Number.isSafeInteger(item.item) || item.item < 1 || item.item > state.plan.length) issues.push(`not_done[${i}].item must name a plan item between 1 and ${state.plan.length}`);
    else if (!String(item.why || '').trim()) issues.push(`not_done[${i}] needs a reason`);
  }
  if (!(args.tables || []).length && !(args.claims || []).length && (args.figures === undefined ? !state.artifacts.some(a => a.figure && a.images?.length) : !args.figures.length)) issues.push('a report needs at least one table, figure or claim');
  return issues;
}

function figureLine(artifact) {
  const f = artifact.figure || {};
  return `Figure ${artifact.id}: ${f.type}${f.title ? ` "${f.title}"` : ''}${f.x_label || f.y_label ? ` (${[f.x_label, f.y_label].filter(Boolean).join(' vs ')})` : ''}${artifact.inputs?.length ? ` from ${artifact.inputs.join(', ')}` : ''}`;
}

function evidenceText(bound) {
  return (bound.parts || [bound]).map(b => {
    if (!b.cells.length) return Array.isArray(b.artifact.rows) && !b.artifact.rows.length ? `${b.artifact.id}: no rows` : `${b.artifact.id}`;
    const shown = b.cells.slice(0, 12).map(c => `row ${c.index}: ${c.values.map(([k, v]) => `${k}=${escapeCell(v)}`).join(', ')}`);
    return `${b.artifact.id} ${shown.join('; ')}${b.cells.length > 12 ? `; … ${b.cells.length - 12} more rows` : ''}`;
  }).join(' | ');
}

// Markdown from the accepted finish arguments and the saved artifacts.
function renderReport(args, state, figures) {
  const sections = [];
  for (const table of args.tables || []) {
    const artifact = state.byId.get(String(table.artifact).trim());
    const columns = resolveColumns(artifact, table.columns);
    const shown = artifact.rows.slice(0, table.rows === undefined ? artifact.rows.length : table.rows);
    const body = shown.length ? [`| ${columns.map(escapeCell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...shown.map(row => `| ${columns.map(c => escapeCell(row[c])).join(' | ')} |`)].join('\n') : `No rows (${artifact.id}).`;
    sections.push(`**${table.title || artifact.label || artifact.id}** (${artifact.id}, ${artifact.rows.length} rows)\n\n${body}${shown.length < artifact.rows.length ? `\n\nShowing ${shown.length} of ${artifact.rows.length} rows; the full table is saved as ${artifact.id}.` : ''}`);
  }
  if (figures.length) sections.push(figures.map(figureLine).join('\n'));
  if ((args.claims || []).length) sections.push(`**Findings**\n\n${args.claims.map(claim => { const bound = binding(claim, state); return `- ${claim.text.trim()} (evidence: ${evidenceText(bound)})`; }).join('\n')}`);
  if ((args.limitations || []).length) sections.push(`**Limitations**\n\n${args.limitations.map(text => `- ${String(text).trim()}`).join('\n')}`);
  if ((args.not_done || []).length) sections.push(`**Not done**\n\n${args.not_done.map(item => `- Plan item ${item.item}: ${String(item.why).trim()}`).join('\n')}`);
  return sections.join('\n\n');
}

module.exports = { FINISH_SCHEMA, reportIssues, renderReport, statedNumbers, binding };
