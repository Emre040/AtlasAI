'use strict';

const { StudyContext, bytes } = require('./studyContext');

function rowPageOptions({ rows = 10, offset = 0 } = {}) {
  if (!Number.isSafeInteger(rows) || rows < 1) throw new Error('rows must be a positive safe integer');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative integer');
  return { rows, offset };
}

async function readPage(stream, { rows, offset }) {
  const result = [];
  let skipped = 0, more = false;
  for await (const row of stream) {
    if (skipped < offset) { skipped++; continue; }
    if (result.length === rows) { more = true; break; }
    result.push(row);
  }
  return { rows: result, offset, more, total: more ? null : skipped + result.length };
}

function formatPage(view, columns) {
  const selected = { columns, rows: view.rows.map(row => columns.map(column => row[column] === undefined ? null : row[column])) };
  const extent = view.rows.length ? `rows ${view.offset + 1}–${view.offset + view.rows.length}` : 'no rows';
  return `${extent}; ${view.total === null ? 'total not counted' : `${view.total} total rows`}; ${view.more ? `more rows: open offset=${view.offset + view.rows.length}` : 'end of table'}\n${JSON.stringify(selected)}`;
}

function previewRows(rows, columns, budgetBytes, maxRows = rows.length) {
  const selected = [];
  let used = Buffer.byteLength(JSON.stringify({ columns, rows: [] }));
  for (const row of rows) {
    if (selected.length >= maxRows) break;
    const size = Buffer.byteLength(JSON.stringify(columns.map(c => row[c] === undefined ? null : row[c]))) + 1;
    if (used + size > budgetBytes) break;
    selected.push(row); used += size;
  }
  return { rows: selected, offset: 0, total: rows.length, more: selected.length < rows.length };
}

function cellValue(rows, columns, cell) {
  if (!cell || !Number.isSafeInteger(cell.row) || cell.row < 0 || cell.row >= rows.length) throw new Error('cell.row must identify an existing result row');
  if (!columns.includes(cell.column)) throw new Error(`No result column ${JSON.stringify(cell.column)}`);
  const pointer = cell.path === undefined ? '' : cell.path;
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/')) || /~(?![01])/u.test(pointer)) throw new Error('cell.path must be an exact JSON Pointer');
  let value = rows[cell.row][cell.column];
  if (pointer) for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`No value at JSON Pointer ${JSON.stringify(pointer)}`);
    value = value[key];
  }
  return value === undefined ? null : value;
}

// Delivery bytes govern transport, never the number of stored rows or the size of a value.
// Complete selections live in the same observation archive used by ASO recall. Small results
// keep their existing structured shape; large ones have an exact, independently advancing
// text cursor. JSON escaping and the envelope itself count against the byte allowance.
function createViewReader({ budgetBytes, archive = new StudyContext(), views = [] } = {}) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) throw new Error('View delivery budget must be a positive safe integer');
  const owned = new Set(views);
  if ([...owned].some(id => !archive.records.has(id))) throw new Error('Restored views must exist in the supplied archive');
  function read({ view, text_offset = 0 } = {}) {
    if (!owned.has(view)) throw new Error(`No saved result view ${JSON.stringify(view)}`);
    const text = archive.records.get(view).record.text;
    if (!Number.isSafeInteger(text_offset) || text_offset < 0 || text_offset > text.length) throw new Error(`text_offset must be between 0 and ${text.length}`);
    if (text_offset && /[\uD800-\uDBFF]/.test(text[text_offset - 1])) throw new Error('text_offset splits a Unicode character; use the returned next_text_offset');
    const envelope = { view, delivery: 'text_fragment', format: 'application/json', text_offset, next_text_offset: text.length, complete: false, text: '' };
    const available = budgetBytes - bytes(JSON.stringify(envelope));
    let used = 0, end = text_offset;
    while (end < text.length) {
      const character = String.fromCodePoint(text.codePointAt(end));
      const size = bytes(JSON.stringify(character)) - 2;
      if (used + size > available) break;
      used += size; end += character.length;
    }
    if (end === text_offset && end < text.length) {
      const character = String.fromCodePoint(text.codePointAt(end));
      const first = { ...envelope, text: character, next_text_offset: end + character.length, complete: end + character.length === text.length };
      const minimum = bytes(JSON.stringify(first));
      if (minimum <= budgetBytes) return first;
      const error = new Error(`View delivery budget cannot fit its envelope and the next Unicode character; at least ${minimum} bytes are required`);
      error.code = 'view_delivery_budget_exceeded'; error.minimum_bytes = minimum;
      throw error;
    }
    const result = { ...envelope, next_text_offset: end, complete: end === text.length, text: text.slice(text_offset, end) };
    if (bytes(JSON.stringify(result)) > budgetBytes) {
      const error = new Error('View delivery budget cannot fit the required result envelope');
      error.code = 'view_delivery_budget_exceeded';
      throw error;
    }
    return result;
  }
  return {
    archive,
    ids: () => [...owned],
    read,
    open(value, { source = 'result view', refs = [] } = {}) {
      const text = JSON.stringify(value);
      if (text === undefined) throw new Error('A result view must contain a JSON value');
      if (bytes(text) <= budgetBytes) return value;
      const id = archive.add(text, { source, refs, announce: false });
      owned.add(id);
      try { return read({ view: id }); }
      catch (error) { error.view = id; throw error; }
    }
  };
}

module.exports = { rowPageOptions, readPage, formatPage, previewRows, cellValue, createViewReader };
