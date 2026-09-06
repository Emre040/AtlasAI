'use strict';

function rowPageOptions({ rows = 10, offset = 0 } = {}) {
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 200) throw new Error('rows must be an integer from 1 to 200');
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

module.exports = { rowPageOptions, readPage, formatPage, previewRows };
