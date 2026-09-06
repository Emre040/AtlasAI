'use strict';

// Tables are rendered from saved artifacts. The model chooses a projection and explains it;
// it does not have to transcribe measurements into a second, potentially conflicting table.
const escapeCell = value => String(value === null || value === undefined ? '—' : value).replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');

function renderReport({ summary, tables = [] }, state) {
  const sections = [String(summary || '').trim()];
  for (const table of tables) {
    const id = table.artifact;
    const artifact = state.byId.get(id);
    if (!artifact || !Array.isArray(artifact.rows) || artifact.kind === 'figure') throw new Error(`Report table ${table.artifact} must be a saved row artifact`);
    const columns = table.columns;
    if (!Array.isArray(columns) || !columns.length || columns.some(c => !artifact.columns.includes(c))) throw new Error(`Report table ${id} requires exact columns from ${artifact.columns.join(', ')}`);
    const limit = table.rows === undefined ? 40 : table.rows;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Report table rows must be between 1 and 200');
    const shown = artifact.rows.slice(0, limit);
    const heading = `${table.title || artifact.label} (${id}):`;
    const body = shown.length ? [
      `| ${columns.map(escapeCell).join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      ...shown.map(row => `| ${columns.map(c => escapeCell(row[c])).join(' | ')} |`)
    ].join('\n') : `No matching rows (${id}).`;
    sections.push(`${heading}\n\n${body}${shown.length < artifact.rows.length ? `\n\nShowing ${shown.length} of ${artifact.rows.length} rows; the full result is saved in ${id}.` : ''}`);
  }
  return sections.join('\n\n');
}

module.exports = { renderReport };
