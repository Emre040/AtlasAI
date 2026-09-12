'use strict';

/**
 * The report is rendered from the data, never transcribed by the model. finish names saved
 * tables and figures by id, and states findings as claims, each bound to the rows and columns
 * of the artifact it rests on. The renderer prints the bound cells beside every claim, and the
 * binder checks that every number a claim states is among those cells (or the row counts they
 * imply). A claim that cannot be bound is not accepted.
 */

const desk = require('./desk');
const { shown } = desk;
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
const { grain } = require('./studyTools');

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
const SMALL_TABLE = 30;   // rows a claim may rest on whole without naming them

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
  // A claim on a small table that names no rows rests on all of them (a distribution, a summary);
  // a large table still needs the rows named.
  if ((!Array.isArray(claim.rows) || !claim.rows.length) && rows.length <= SMALL_TABLE) claim.rows = rows.map((_, i) => i);
  if (!Array.isArray(claim.rows) || !claim.rows.length) throw new Error(`claim on ${artifact.id} must name the rows it rests on (zero-based indices, as numbered on the desk)`);
  if (claim.rows.some(i => !Number.isSafeInteger(i) || i < 0 || i >= rows.length)) throw new Error(`claim rows for ${artifact.id} must be between 0 and ${rows.length - 1}`);
  const columns = resolveColumns(artifact, claim.columns);
  const cells = [...new Set(claim.rows)].map(i => ({ index: i, values: columns.map(c => [c, rows[i][c]]) }));
  const values = numbersIn(cells.map(c => c.values.map(v => v[1])));
  const distinct = columns.map(c => new Set(cells.map(x => String(rows[x.index][c] ?? ''))).size);
  // The entities a table spans (its grain) are a count of it, as its rows are.
  const g = grain(rows, artifact.columns || []);
  return { artifact, cells, columns, values, counts: [cells.length, rows.length, ...distinct, ...(g?.entities ? [g.entities] : [])] };
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

const ORDINAL = /\b(Table|Figure|Fig\.?|Chart|Plot|Panel)\s+(\d+)\b/gi;

function claimIssue(claim, state, args = {}) {
  let bound;
  try { bound = binding(claim, state); }
  catch (error) { return error.message; }
  // "Table 2" and "Figure 1" name the report's own tables and figures, numbered in the order the
  // report gives them; an ordinal beyond that order names nothing. The ordinal's number is not a
  // number the data must hold.
  const text = String(claim.text || '');
  for (const m of text.matchAll(ORDINAL)) {
    const table = /^table$/i.test(m[1]);
    const count = table ? (args.tables || []).length : Array.isArray(args.figures) ? args.figures.length : null;
    if (count !== null && !(Number(m[2]) >= 1 && Number(m[2]) <= count)) return `${JSON.stringify(text.length > 160 ? `${text.slice(0, 159)}…` : text)} says "${m[0]}", but the report lists ${count} ${table ? 'table' : 'figure'}${count === 1 ? '' : 's'}: tables and figures are numbered in the order the report gives them; or name the artifact by id (${bound.parts.map(b => b.artifact.id).join(', ')})`;
  }
  const spoken = text.replace(ORDINAL, m => m.replace(/\d+/, ''));
  // Numbers the bound artifacts or the artifacts they were made from were made with (a
  // threshold, a top n) are part of their evidence.
  const lineage = (a, seen = new Set()) => !a || seen.has(a.id) ? [] : (seen.add(a.id), [...numbersIn(a.args || {}), ...(a.inputs || []).flatMap(id => lineage(state.byId.get(id), seen))]);
  const argNumbers = bound.parts.flatMap(b => lineage(b.artifact));
  // A count that is the row count of a bound table spanning fewer entities is two numbers, not
  // one: "114 partners" when the table has 114 rows over 47 genes. A claim that states the row
  // count without the entity count is sent back with both, to say which it means.
  const stated = statedNumbers(spoken);
  for (const n of stated) {
    if (!Number.isInteger(n.value) || bound.values.includes(n.value)) continue;
    for (const part of bound.parts) {
      const rows = part.artifact.rows || [];
      if (rows.length < 2 || rows.length !== n.value) continue;
      const g = grain(rows, part.artifact.columns || []);
      if (!g || !g.entities || g.entities >= rows.length || stated.some(m => m.value === g.entities)) continue;
      return `${JSON.stringify(claim.text.length > 160 ? `${claim.text.slice(0, 159)}…` : claim.text)} states ${n.raw}, which is the number of rows of ${part.artifact.id}${g.by ? ` (one row per ${g.key} and ${g.by})` : ''}, not of ${g.key}s: it spans ${g.entities} ${g.key}s. Say which you mean, and bind that count`;
    }
  }
  // A whole number that is the row count of any saved artifact is bound: the artifact's size is on
  // the desk and in the report ("the 123 partners", citing the distribution drawn from them).
  const rowCounts = new Set(state.artifacts.map(a => (a.rows || []).length));
  // A percent is also the ratio of two bound numbers ("86 of the 123 partners (70%)"): arithmetic
  // the reader can redo from the cells beside the claim.
  const basis = [...new Set([...bound.values, ...bound.counts, ...[...rowCounts]])].filter(v => Number.isFinite(v));
  const ratioOfBound = (value, tolerance) => basis.some(x => basis.some(y => y > 0 && x <= y && Math.abs((x / y) * 100 - value) <= tolerance + 1e-9 * value));
  let unmatched = statedNumbers(spoken).filter(({ value, tolerance, percent }) => !near(bound.values, value, tolerance) && !near(argNumbers, value, tolerance) && !(Number.isInteger(value) && (bound.counts.includes(value) || rowCounts.has(value))) && !(percent && (near(bound.values, value / 100, tolerance / 100) || ratioOfBound(value, tolerance))));
  if (!unmatched.length) return null;
  // A number that sits in a bound row, in a column the claim did not name, is bound by naming the
  // column: the binder does that itself, so the evidence prints the cell.
  const inBoundRows = u => {
    for (const [p, part] of bound.parts.entries()) {
      const rows = part.artifact.rows || [], named = new Set(part.columns || []);
      for (const cell of part.cells) for (const c of part.artifact.columns) {
        if (named.has(c)) continue;
        const n = typeof rows[cell.index][c] === 'number' ? rows[cell.index][c] : typeof rows[cell.index][c] === 'string' && /\d/.test(rows[cell.index][c]) ? Number(String(rows[cell.index][c]).replace(/,/g, '')) : NaN;
        if (Number.isFinite(n) && Math.abs(n - u.value) <= u.tolerance + 1e-9 * Math.abs(u.value)) return { part: p, column: c };
      }
    }
    return null;
  };
  for (const u of [...unmatched]) {
    const hit = inBoundRows(u);
    if (!hit) continue;
    const owner = Array.isArray(claim.evidence) ? (claim.artifact !== undefined ? (hit.part === 0 ? claim : claim.evidence[hit.part - 1]) : claim.evidence[hit.part]) : claim;
    owner.columns = [...(bound.parts[hit.part].columns || []), hit.column];
    unmatched = unmatched.filter(x => x !== u);
  }
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
    if (artifact.figure) { issues.push(`tables[${i}]: ${artifact.id} is a figure, not a table`); continue; }
    // A matrix is a table too: its rows are its row labels, its columns its column labels.
    if (artifact.matrix) {
      const missing = (table.columns || []).filter(c => !artifact.matrix.col_labels.includes(c));
      if (missing.length) issues.push(`tables[${i}]: ${artifact.id} has no column ${missing.map(c => JSON.stringify(c)).join(', ')}; its columns: ${artifact.matrix.col_labels.join(', ')}`);
      continue;
    }
    if (!Array.isArray(artifact.rows)) { issues.push(`tables[${i}]: ${artifact.id} is not a table`); continue; }
    try { resolveColumns(artifact, table.columns); } catch (error) { issues.push(`tables[${i}]: ${error.message}`); }
    if (table.rows !== undefined && !Number.isSafeInteger(table.rows)) issues.push(`tables[${i}].rows must be an integer`);
  }
  if (args.figures !== undefined) {
    if (!Array.isArray(args.figures)) issues.push('figures must be an array of figure artifact ids');
    else for (const id of args.figures) {
      const artifact = state.byId.get(String(id || '').trim());
      if (!artifact || !artifact.figure) issues.push(`figures: ${JSON.stringify(id)} is not a saved figure`);
      else if (!artifact.images?.length) issues.push(`figures: ${artifact.id} was not rendered`);
    }
  }
  // A claim that says "Table 2" without naming an artifact rests on the report's second table.
  for (const claim of args.claims || []) {
    if (!claim || typeof claim.text !== 'string' || claim.artifact !== undefined || Array.isArray(claim.evidence)) continue;
    const m = /\bTable\s+(\d+)\b/i.exec(claim.text);
    const id = m ? (args.tables || [])[Number(m[1]) - 1]?.artifact : undefined;
    if (id !== undefined) claim.artifact = id;
  }
  for (const [i, claim] of (args.claims || []).entries()) {
    if (!claim || typeof claim.text !== 'string' || !claim.text.trim()) { issues.push(`claims[${i}] needs text`); continue; }
    const issue = claimIssue(claim, state, args);
    if (issue) issues.push(`claims[${i}]: ${issue}`);
  }
  for (const [i, text] of (args.limitations || []).entries()) {
    if (typeof text !== 'string' || !text.trim()) issues.push(`limitations[${i}] needs text`);
  }
  for (const [i, item] of (args.not_done || []).entries()) {
    if (!item || !Number.isSafeInteger(item.item) || item.item < 1 || item.item > state.plan.length) issues.push(`not_done[${i}].item must name a plan item between 1 and ${state.plan.length}`);
    else if (!String(item.why || '').trim()) issues.push(`not_done[${i}] needs a reason`);
  }
  // A report is tables, figures or claims; a study that could deliver nothing reports every plan
  // item in not_done, with the reason, and its limitations.
  if (!(args.tables || []).length && !(args.claims || []).length && !(args.not_done || []).length && (args.figures === undefined ? !state.artifacts.some(a => a.figure && a.images?.length) : !args.figures.length)) issues.push('a report needs at least one table, figure or claim, or every plan item in not_done with its reason');
  return issues;
}

// Figures are numbered in the order the report gives them, beside their artifact id.
function figureLine(artifact, number) {
  const f = artifact.figure || {};
  const axis = (label, scale) => label ? `${label}${scale === 'log' ? ' (log)' : ''}` : '';
  const axes = [axis(f.x_label, f.x_scale), axis(f.y_label, f.y_scale)].filter(Boolean);
  return `Figure ${number} (${artifact.id}): ${f.type}${f.title ? ` "${f.title}"` : ''}${axes.length ? ` (${axes.join(' vs ')})` : ''}${f.scale === 'log' ? ' (log colour scale)' : ''}${artifact.inputs?.length ? ` from ${artifact.inputs.join(', ')}` : ''}${desk.labelsFit(f)}`;
}

function evidenceText(bound) {
  return (bound.parts || [bound]).map(b => {
    if (!b.cells.length) return Array.isArray(b.artifact.rows) && !b.artifact.rows.length ? `${b.artifact.id}: no rows` : `${b.artifact.id}`;
    const shown = b.cells.slice(0, 12).map(c => `row ${c.index}: ${c.values.map(([k, v]) => `${k}=${escapeCell(v)}`).join(', ')}`);
    return `${b.artifact.id} ${shown.join('; ')}${b.cells.length > 12 ? `; … ${b.cells.length - 12} more rows` : ''}`;
  }).join(' | ');
}

// Markdown from the accepted finish arguments and the saved artifacts.
// Tables and figures are numbered in the order the report gives them, so "Table 2" in a claim
// names the second table; every heading keeps the artifact id beside the number.
function renderReport(args, state, figures) {
  const sections = [];
  for (const [i, table] of (args.tables || []).entries()) {
    const artifact = state.byId.get(String(table.artifact).trim());
    const heading = `**Table ${i + 1}. ${table.title || artifact.label || artifact.id}**`;
    if (artifact.matrix) {
      const m = artifact.matrix;
      const columns = (table.columns || []).length ? table.columns : m.col_labels;
      const shown = m.row_labels.slice(0, table.rows > 0 ? table.rows : m.row_labels.length);
      const body = [`|  | ${columns.map(escapeCell).join(' | ')} |`, `| --- | ${columns.map(() => '---').join(' | ')} |`, ...shown.map((label, i) => `| ${escapeCell(label)} | ${columns.map(c => escapeCell(m.matrix[i][m.col_labels.indexOf(c)])).join(' | ')} |`)].join('\n');
      sections.push(`${heading} (${artifact.id}, ${m.row_labels.length} × ${m.col_labels.length})\n\n${body}${shown.length < m.row_labels.length ? `\n\nShowing ${shown.length} of ${m.row_labels.length} rows; the full matrix is saved as ${artifact.id}.` : ''}`);
      continue;
    }
    const columns = resolveColumns(artifact, table.columns);
    const shown = artifact.rows.slice(0, table.rows > 0 ? table.rows : artifact.rows.length);
    const body = shown.length ? [`| ${columns.map(escapeCell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...shown.map(row => `| ${columns.map(c => escapeCell(row[c])).join(' | ')} |`)].join('\n') : `No rows (${artifact.id}).`;
    sections.push(`${heading} (${artifact.id}, ${artifact.rows.length} rows)\n\n${body}${shown.length < artifact.rows.length ? `\n\nShowing ${shown.length} of ${artifact.rows.length} rows; the full table is saved as ${artifact.id}.` : ''}`);
  }
  if (figures.length) sections.push(figures.map((artifact, i) => figureLine(artifact, i + 1)).join('\n'));
  if ((args.claims || []).length) sections.push(`**Findings**\n\n${args.claims.map(claim => { const bound = binding(claim, state); return `- ${claim.text.trim()} (evidence: ${evidenceText(bound)})`; }).join('\n')}`);
  // A limitation is scope, not evidence: a number in it that no saved artifact holds (a definition's
  // threshold, a count from elsewhere) is printed with a note saying it is unverified here.
  if ((args.limitations || []).length) sections.push(`**Limitations**\n\n${args.limitations.map(text => { const loose = statedNumbers(text).filter(n => !locate(state, n.value, n.tolerance).length && !(n.percent && locate(state, n.value / 100, n.tolerance / 100).length) && !state.artifacts.some(a => (a.rows || []).length === n.value)); return `- ${String(text).trim()}${loose.length ? ` (${loose.map(n => n.raw).join(', ')}: not verified against the data of this study)` : ''}`; }).join('\n')}`);
  if ((args.not_done || []).length) sections.push(`**Not done**\n\n${args.not_done.map(item => `- Plan item ${item.item}: ${String(item.why).trim()}`).join('\n')}`);
  return sections.join('\n\n');
}

module.exports = { FINISH_SCHEMA, reportIssues, renderReport, statedNumbers, binding };
