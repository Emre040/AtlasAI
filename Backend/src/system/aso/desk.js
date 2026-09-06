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
const WHOLE_ROWS = 60;    // a result this small is shown whole: cheaper than a turn spent opening it
const SMALL_ROWS = 12;    // a result this small stays whole even after later operations consumed it
const DIGITS = 6;         // significant digits a number is displayed with; artifacts keep full precision
const VOCAB_MAX = 60;     // distinct values listed in full for a categorical column of a source table
const CARD_VOCAB = 12;    // distinct values listed in full on a result card
const EXAMPLES = 6;       // examples listed for a column with more values than that
const HISTORY_MAX = 40;   // history lines kept on the desk before the oldest are folded

// A number shown with DIGITS significant digits; a value written at that precision still binds
// to the exact cell, whose tolerance follows the digits written.
function shown(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(DIGITS)));
  if (typeof v === 'string' && /^-?\d*\.\d{7,}(e[-+]?\d+)?$/i.test(v.trim())) return String(Number(Number(v).toPrecision(DIGITS)));
  return v;
}

function cell(v) {
  const t = shown(v);
  const s = t === null || t === undefined ? '' : typeof t === 'object' ? JSON.stringify(t) : String(t);
  return s.length > CELL ? `${s.slice(0, CELL - 1)}…` : s;
}

const ROW_COLUMNS = 8;    // columns a sample row shows
const WIDE_COLUMNS = 24;  // a header names every column up to this many; wider tables name the first ones

function rowLine(row, columns) { return columns.map(c => cell(row[c])).join(' | '); }

// Sample rows show the first columns (keys and fresh columns come first); the rest are counted.
function sampleLines(rows, columns, n = SAMPLE_ROWS) {
  const shownColumns = columns.slice(0, ROW_COLUMNS);
  const more = columns.length > ROW_COLUMNS ? ` | … +${columns.length - ROW_COLUMNS} columns` : '';
  return rows.slice(0, n).map(r => rowLine(r, shownColumns) + more);
}

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

// One line per column from a profile: what kind of values it holds and which ones. A source
// table lists a categorical column's values in full (spelling matters for filters); a result card
// lists a few, since its rows are on the desk.
function columnLine(c, vocab = VOCAB_MAX, brief = false) {
  const blank = c.blank_pct ? `; ${c.blank_pct}% blank` : '';
  if (c.kind === 'empty') return `${c.column}: no values recorded`;
  if (c.kind === 'number') return `${c.column}: number ${c.min === c.max ? count(c.min) : `${count(c.min)} to ${count(c.max)}`}${blank}${c.distinct === '1000+' ? '' : `; ${c.distinct} distinct`}`;
  // A brief line says what the column is; the values come when the column is asked for.
  if (brief && !(Array.isArray(c.observed_values) && c.observed_values.length <= 3)) return `${c.column}: text, ${c.distinct} distinct${blank}${c.list ? `; ${c.list}` : ''}`;
  const values = Array.isArray(c.observed_values) && c.observed_values.length <= vocab ? c.observed_values : null;
  if (values) return `${c.column}: ${values.length === 1 ? 'always' : `${values.length} values:`} ${values.map(v => v.length > CELL ? `${v.slice(0, CELL - 1)}…` : v).join(' | ')}${blank}${c.list ? `; ${c.list}` : ''}`;
  const examples = (c.full_examples || c.examples || []).slice(0, vocab === VOCAB_MAX ? EXAMPLES : 3).map(v => v.length > CELL ? `${v.slice(0, CELL - 1)}…` : v);
  return `${c.column}: text, ${c.distinct} distinct${examples.length ? ` (e.g. ${examples.join(' | ')})` : ''}${blank}${c.list ? `; ${c.list}` : ''}`;
}

// A source table as a card: what it is, what its columns hold, how a few rows look. Opened
// for particular columns (focus), the card details those in full and names the rest; opened
// whole, it details every column, a wide table with a few values per column and every value
// for the columns that were asked for. A table costs what was asked of it.
function tableCard({ name, title, description, access, columns, profile, sample, scanned, capped, focus = null, whole = focus === null }) {
  const wide = columns.length > WIDE_COLUMNS;
  const head = `${name} — ${title || name}${description ? `. ${description}` : ''}${access ? ` [${access}]` : ''}; ${columns.length} columns${scanned ? ` (values from ${capped ? 'the first ' : ''}${count(scanned)} rows)` : ''}${whole && wide ? ' (wide: what each column holds; open it with columns for the values of a column)' : ''}`;
  const lines = [head];
  const profiled = new Map((profile || []).map(c => [c.column, c]));
  const asked = new Set(focus || []);
  const detailed = whole ? columns : columns.filter(c => asked.has(c));
  if (!whole) lines.push(`  columns: ${namedColumns(columns)}`);
  for (const column of detailed) lines.push(`  ${profiled.has(column) ? columnLine(profiled.get(column), asked.has(column) || !wide ? VOCAB_MAX : CARD_VOCAB, wide && !asked.has(column)) : column}`);
  // Sample rows of a wide table show its first columns; the column lines above show the rest.
  const rowColumns = whole && wide ? columns.slice(0, ROW_COLUMNS) : detailed;
  const more = rowColumns.length < detailed.length ? ` | … +${detailed.length - rowColumns.length} columns` : '';
  if (sample?.length) lines.push(`  rows${whole && !wide ? '' : ` (${rowColumns.join(' | ')})`}: ${sample.map(r => rowLine(r, rowColumns) + more).join(' ; ')}`);
  return lines.join('\n');
}

// Column names on one line: every name up to the header limit, else the first ones and a count.
function namedColumns(columns) {
  return columns.length <= WIDE_COLUMNS ? columns.join(', ') : `${columns.slice(0, ROW_COLUMNS + 4).join(', ')}, … +${columns.length - ROW_COLUMNS - 4} more columns`;
}

// A produced result as a line: id, title, size, columns, what made it; then its description.
// A result of a few rows shows them whole, with indices; anything larger is opened on request.
const NOTE_CHARS = 600;   // characters of a text result shown on its line
const INLINE_ROWS = 10;   // a result this small is shown whole (a top ten): cheaper than a turn spent opening it

function resultLine({ id, title = '', description = '', origin, rows = [], columns = [], matrix, figure, images, text }) {
  const head = title ? `${id} "${title}"` : id;
  if (text && !rows.length && !matrix && !figure) {
    const body = String(text).replace(/\s+/g, ' ').trim();
    return `${head} note ← ${origin}\n  ${body.length > NOTE_CHARS ? `${body.slice(0, NOTE_CHARS - 1)}… (open ${id} for the rest)` : body}`;
  }
  if (figure) return `${head} figure ${figure.type} ← ${origin}${images?.length ? ' (rendered)' : ' (not rendered)'}${figure.omitted_rows ? `; ${figure.omitted_rows} rows omitted for missing values` : ''}`;
  if (matrix) {
    const head2 = `${head} matrix ${matrix.row_labels.length} × ${matrix.col_labels.length} (rows: ${matrix.row_labels.slice(0, 6).map(cell).join(', ')}${matrix.row_labels.length > 6 ? ', …' : ''}; columns: ${matrix.col_labels.slice(0, 6).map(cell).join(', ')}${matrix.col_labels.length > 6 ? ', …' : ''}) ← ${origin}; a heatmap input`;
    return description ? `${head2}\n  ${description}` : head2;
  }
  const lines = [`${head} (${count(rows.length)} rows: ${namedColumns(columns)}) ← ${origin}`];
  if (description) lines.push(`  ${description}`);
  if (rows.length && rows.length <= INLINE_ROWS) lines.push(...sampleLines(rows, columns, rows.length).map((l, i) => `  ${i}: ${l}`));
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

module.exports = { cell, shown, rowLine, sampleLines, argsLine, tableCard, columnLine, namedColumns, resultLine, historyText, section, count, INLINE_ROWS, WIDE_COLUMNS, ROW_COLUMNS };
