'use strict';

/**
 * The desk: the working set an agent sees on every turn.
 *
 * Nothing the model has seen is taken away and nothing it needs sits behind a knob. Every table
 * it has opened stays on the desk as a card (columns, the values each column takes, sample rows);
 * every result it has produced stays as a card (columns, two rows); its own past calls stay as
 * one-line history. Row data lives on disk in the artifacts; the desk only ever shows a sample.
 * The text is rebuilt from state each turn, so it is small, stable and cacheable.
 */

const CELL = 48;          // characters per shown cell
const SAMPLE_ROWS = 2;    // rows shown under a large result card
const WHOLE_ROWS = 12;    // a result this small is shown whole
const VOCAB_MAX = 60;     // distinct values listed in full for a categorical column
const EXAMPLES = 6;       // examples listed for a column with more values than that
const HISTORY_MAX = 40;   // history lines kept on the desk before the oldest are folded

function cell(v) {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > CELL ? `${s.slice(0, CELL - 1)}…` : s;
}

function rowLine(row, columns) { return columns.map(c => cell(row[c])).join(' | '); }

function sampleLines(rows, columns, n = SAMPLE_ROWS) { return rows.slice(0, n).map(r => rowLine(r, columns)); }

// Arguments on one line, cut only between arguments: a cut inside a value can change a column
// name and make the model refer to something that does not exist.
function argsLine(args, max = 220) {
  const parts = Object.entries(args || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${text.length > 120 ? `${text.slice(0, 119)}…` : text}`;
  });
  let out = '';
  for (const part of parts) {
    if (out && out.length + part.length + 2 > max) { out += ', …'; break; }
    out += (out ? ', ' : '') + part;
  }
  return out;
}

const count = n => Number(n).toLocaleString('en-US');

// One line per column from a profile: what kind of values it holds and which ones.
function columnLine(c) {
  const blank = c.blank_pct ? `; ${c.blank_pct}% blank` : '';
  if (c.kind === 'empty') return `${c.column}: no values recorded`;
  if (c.kind === 'number') return `${c.column}: number ${c.min === c.max ? count(c.min) : `${count(c.min)} to ${count(c.max)}`}${blank}${c.distinct === '1000+' ? '' : `; ${c.distinct} distinct`}`;
  const values = Array.isArray(c.observed_values) && c.observed_values.length <= VOCAB_MAX ? c.observed_values : null;
  if (values) return `${c.column}: ${values.length === 1 ? 'always' : `${values.length} values:`} ${values.map(v => v.length > CELL ? `${v.slice(0, CELL - 1)}…` : v).join(' | ')}${blank}${c.list ? `; ${c.list}` : ''}`;
  const examples = (c.full_examples || c.examples || []).slice(0, EXAMPLES).map(v => v.length > CELL ? `${v.slice(0, CELL - 1)}…` : v);
  return `${c.column}: text, ${c.distinct} distinct${examples.length ? ` (e.g. ${examples.join(' | ')})` : ''}${blank}${c.list ? `; ${c.list}` : ''}`;
}

// A source table as a card: what it is, what its columns hold, how a few rows look.
function tableCard({ name, title, description, access, columns, profile, sample, scanned, capped }) {
  const head = `${name} — ${title || name}${description ? `. ${description}` : ''}${access ? ` [${access}]` : ''}; ${columns.length} columns${scanned ? ` (values from ${capped ? 'the first ' : ''}${count(scanned)} rows)` : ''}`;
  const lines = [head];
  const profiled = new Map((profile || []).map(c => [c.column, c]));
  for (const column of columns) lines.push(`  ${profiled.has(column) ? columnLine(profiled.get(column)) : column}`);
  if (sample?.length) lines.push(`  rows: ${sample.map(r => rowLine(r, columns)).join(' ; ')}`);
  return lines.join('\n');
}

// A produced result as a card: id, what made it, its size, its columns and two rows.
function resultCard({ id, label, origin, rows, columns, matrix, figure, images, error }) {
  if (figure) return `${id} figure ${figure.type}${figure.title ? ` "${figure.title}"` : ''} ← ${origin}${images?.length ? ' (rendered)' : ' (not rendered)'}${figure.omitted_rows ? `; ${figure.omitted_rows} rows omitted for missing values` : ''}`;
  if (matrix) {
    const head = `${id} matrix ${matrix.row_labels.length} × ${matrix.col_labels.length} ← ${origin} (a heatmap input; not a row table)`;
    if (matrix.row_labels.length <= WHOLE_ROWS && matrix.col_labels.length <= WHOLE_ROWS) return [head, `  ${['', ...matrix.col_labels].map(cell).join(' | ')}`, ...matrix.matrix.map((row, i) => `  ${[matrix.row_labels[i], ...row.map(v => v === null ? '' : v)].map(cell).join(' | ')}`)].join('\n');
    return `${head}; rows: ${matrix.row_labels.slice(0, 8).map(cell).join(', ')}${matrix.row_labels.length > 8 ? ', …' : ''}; columns: ${matrix.col_labels.slice(0, 8).map(cell).join(', ')}${matrix.col_labels.length > 8 ? ', …' : ''}`;
  }
  const head = `${id}${label ? ` ${label}` : ''} (${count(rows.length)} rows) ← ${origin}: ${columns.join(', ')}${error ? ` [${error}]` : ''}`;
  const whole = rows.length <= WHOLE_ROWS;
  const lines = [head, ...sampleLines(rows, columns, whole ? rows.length : SAMPLE_ROWS).map((l, i) => `  ${whole ? `${i}: ` : ''}${l}`)];
  if (!whole) lines.push(`  … ${count(rows.length - SAMPLE_ROWS)} more rows (open ${id} to see them)`);
  return lines.join('\n');
}

// History keeps every line; when it grows long the oldest lines fold into one count so the
// recent trail stays readable.
function historyText(lines) {
  if (lines.length <= HISTORY_MAX) return lines.join('\n') || '(nothing yet)';
  const dropped = lines.length - HISTORY_MAX;
  return [`(${dropped} earlier steps)`, ...lines.slice(dropped)].join('\n');
}

function section(title, body) { return `${title}\n${body}`; }

module.exports = { cell, rowLine, sampleLines, argsLine, tableCard, resultCard, historyText, section, count, SAMPLE_ROWS };
