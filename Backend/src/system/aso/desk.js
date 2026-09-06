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
function columnLine(c, vocab = VOCAB_MAX) {
  const blank = c.blank_pct ? `; ${c.blank_pct}% blank` : '';
  if (c.kind === 'empty') return `${c.column}: no values recorded`;
  if (c.kind === 'number') return `${c.column}: number ${c.min === c.max ? count(c.min) : `${count(c.min)} to ${count(c.max)}`}${blank}${c.distinct === '1000+' ? '' : `; ${c.distinct} distinct`}`;
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
  const head = `${name} — ${title || name}${description ? `. ${description}` : ''}${access ? ` [${access}]` : ''}; ${columns.length} columns${scanned ? ` (values from ${capped ? 'the first ' : ''}${count(scanned)} rows)` : ''}${whole && wide ? ' (wide: a few values per column; open it with columns for every value of a column)' : ''}`;
  const lines = [head];
  const profiled = new Map((profile || []).map(c => [c.column, c]));
  const asked = new Set(focus || []);
  const detailed = whole ? columns : columns.filter(c => asked.has(c));
  if (!whole) lines.push(`  columns: ${columns.join(' | ')}`);
  for (const column of detailed) lines.push(`  ${profiled.has(column) ? columnLine(profiled.get(column), asked.has(column) || !wide ? VOCAB_MAX : CARD_VOCAB) : column}`);
  // Sample rows of a wide table show its first columns; the column lines above show the rest.
  const rowColumns = whole && wide ? columns.slice(0, ROW_COLUMNS) : detailed;
  const more = rowColumns.length < detailed.length ? ` | … +${detailed.length - rowColumns.length} columns` : '';
  if (sample?.length) lines.push(`  rows${whole && !wide ? '' : ` (${rowColumns.join(' | ')})`}: ${sample.map(r => rowLine(r, rowColumns) + more).join(' ; ')}`);
  return lines.join('\n');
}

// A produced result as a card: id, what made it, its size, its columns and two rows.
const NOTE_CHARS = 600;   // characters of a text result shown on its card

function resultCard({ id, label, origin, rows, columns, matrix, figure, images, error, text, folded = null, profile = null, first = [] }) {
  if (text && !rows?.length && !matrix && !figure) {
    const body = String(text).replace(/\s+/g, ' ').trim();
    return `${id} note${label ? ` "${label}"` : ''} ← ${origin}\n  ${body.length > NOTE_CHARS ? `${body.slice(0, NOTE_CHARS - 1)}… (open ${id} for the rest)` : body}`;
  }
  if (figure) return `${id} figure ${figure.type}${figure.title ? ` "${figure.title}"` : ''} ← ${origin}${images?.length ? ' (rendered)' : ' (not rendered)'}${figure.omitted_rows ? `; ${figure.omitted_rows} rows omitted for missing values` : ''}`;
  if (matrix) {
    const head = `${id} matrix ${matrix.row_labels.length} × ${matrix.col_labels.length} ← ${origin} (a heatmap input; not a row table)`;
    if (matrix.row_labels.length <= WHOLE_ROWS && matrix.col_labels.length <= WHOLE_ROWS) return [head, `  ${['', ...matrix.col_labels].map(cell).join(' | ')}`, ...matrix.matrix.map((row, i) => `  ${[matrix.row_labels[i], ...row.map(v => v === null ? '' : v)].map(cell).join(' | ')}`)].join('\n');
    return `${head}; rows: ${matrix.row_labels.slice(0, 8).map(cell).join(', ')}${matrix.row_labels.length > 8 ? ', …' : ''}; columns: ${matrix.col_labels.slice(0, 8).map(cell).join(', ')}${matrix.col_labels.length > 8 ? ', …' : ''}`;
  }
  const named = columns.length <= WIDE_COLUMNS ? columns.join(', ') : `${columns.slice(0, ROW_COLUMNS + 4).join(', ')}, … +${columns.length - ROW_COLUMNS - 4} more columns (open ${id} for all names)`;
  const head = `${id}${label ? ` ${label}` : ''} (${count(rows.length)} rows) ← ${origin}: ${named}${error ? ` [${error}]` : ''}`;
  // An artifact that later operations have already consumed is filed: one line, reopenable.
  if (folded) return `${head} [used by ${folded.join(', ')}; open ${id} for its rows]`;
  const whole = rows.length <= WHOLE_ROWS;
  const lines = [head];
  // Rows show the entity keys and the columns the operation named first, then the rest.
  const leading = first.filter(c => columns.includes(c));
  const order = [...leading, ...columns.filter(c => !leading.includes(c))];
  // A large table says what the columns its rows show hold, so the model need not page through it.
  if (!whole && profile) {
    const shownColumns = new Set(order.slice(0, ROW_COLUMNS));
    for (const c of profile) if (shownColumns.has(c.column) && c.kind !== 'empty' && (c.kind === 'number' || c.observed_values || c.blank_pct)) lines.push(`  ${columnLine(c, CARD_VOCAB)}`);
  }
  lines.push(...sampleLines(rows, order, whole ? rows.length : SAMPLE_ROWS).map((l, i) => `  ${whole ? `${i}: ` : ''}${l}`));
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

module.exports = { cell, shown, rowLine, sampleLines, argsLine, tableCard, resultCard, historyText, section, count, SAMPLE_ROWS, WHOLE_ROWS, SMALL_ROWS, WIDE_COLUMNS };
