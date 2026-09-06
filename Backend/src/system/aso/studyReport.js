'use strict';

// Tables are rendered from saved artifacts. The model chooses a projection and explains it;
// it does not have to transcribe measurements into a second, potentially conflicting table.
const escapeCell = value => String(value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : value).replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');

const OBSERVATIONS_SCHEMA = { type: 'array', description: 'Exact observed facts needed outside full result tables. Choose saved records and their source fields; the report renders their actual values without transcription. Use saved calculation results for comparisons, extrema, counts and correlations.', items: { type: 'object', properties: {
  artifact: { type: 'string' }, row_indices: { type: 'array', items: { type: 'integer' }, description: 'Exact zero-based indices within this saved artifact, as shown by open offsets. Every selected record is retained.' },
  columns: { type: 'array', items: { type: 'string' }, description: 'Exact fields including the relevant identities, dimensions and measures. No value or unit overrides.' }
}, required: ['artifact', 'row_indices', 'columns'] } };
const INTERPRETATION_LABELS = { inference: 'Interpretation', hypothesis: 'Untested hypothesis', limitation: 'Evidence limitation' };
const INTERPRETATIONS_SCHEMA = { type: 'array', description: 'Requested discussion beyond exact observations. Scientific interpretation remains a judgment, not a validated measurement. Use hypothesis for possible causes not established by the retrieved evidence, and limitation for what the evidence cannot establish. Do not transcribe source values or add unobserved methods as facts.', items: { type: 'object', properties: {
  kind: { type: 'string', enum: Object.keys(INTERPRETATION_LABELS), description: 'inference: interpretation of saved results; hypothesis: untested possible explanation; limitation: evidence boundary.' },
  text: { type: 'string', description: 'One scientific point, retaining the stated qualification. Observed identities and values belong in observations or tables.' },
  artifacts: { type: 'array', items: { type: 'string' }, description: 'Saved evidence that motivates this discussion. Every paragraph will cite these artifacts; citations do not establish causality.' }
}, required: ['kind', 'text', 'artifacts'] } };

function renderReport({ summary, tables = [], observations = [], interpretations = [] }, state) {
  const sections = [String(summary || '').trim()];
  for (const table of tables) {
    const id = table.artifact;
    const artifact = state.byId.get(id);
    if (!artifact || !Array.isArray(artifact.rows) || artifact.kind === 'figure') throw new Error(`Report table ${table.artifact} must be a saved row artifact`);
    const columns = table.columns;
    if (!Array.isArray(columns) || !columns.length || columns.some(c => !artifact.columns.includes(c))) throw new Error(`Report table ${id} requires exact columns from ${artifact.columns.join(', ')}`);
    const limit = table.rows === undefined ? artifact.rows.length : table.rows;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Report table rows must be a nonnegative integer');
    const shown = artifact.rows.slice(0, limit);
    const heading = `${table.title || artifact.label} (${id}):`;
    const body = shown.length ? [
      `| ${columns.map(escapeCell).join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      ...shown.map(row => `| ${columns.map(c => escapeCell(row[c])).join(' | ')} |`)
    ].join('\n') : artifact.rows.length ? `No rows shown (${id}).` : `No matching rows (${id}).`;
    sections.push(`${heading}\n\n${body}${shown.length < artifact.rows.length ? `\n\nShowing ${shown.length} of ${artifact.rows.length} rows; the full result is saved in ${id}.` : ''}`);
  }
  if (!Array.isArray(observations)) throw new Error('observations must be an array');
  for (const [index, observation] of observations.entries()) {
    const path = `observations[${index}]`, artifact = state.byId.get(observation?.artifact);
    if (!observation || Object.keys(observation).some(key => !['artifact', 'row_indices', 'columns'].includes(key))) throw new Error(`${path} accepts only artifact, row_indices and columns; values come from the saved records`);
    if (!artifact || !Array.isArray(artifact.rows) || artifact.kind === 'figure') throw new Error(`${path}.artifact must name a saved row artifact`);
    if (!Array.isArray(observation.row_indices) || !observation.row_indices.length || observation.row_indices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= artifact.rows.length)) throw new Error(`${path}.row_indices must select existing zero-based rows in ${artifact.id}`);
    if (!Array.isArray(observation.columns) || !observation.columns.length || observation.columns.some(c => !artifact.columns.includes(c))) throw new Error(`${path}.columns must select exact fields from ${artifact.id}`);
    const columns = observation.columns;
    const body = [`| ${columns.map(escapeCell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...observation.row_indices.map(i => `| ${columns.map(c => escapeCell(artifact.rows[i][c])).join(' | ')} |`)].join('\n');
    sections.push(`Observed records (${artifact.id}):\n\n${body}`);
  }
  if (!Array.isArray(interpretations)) throw new Error('interpretations must be an array');
  for (const [index, item] of interpretations.entries()) {
    const path = `interpretations[${index}]`;
    if (!item || !Object.hasOwn(INTERPRETATION_LABELS, item.kind)) throw new Error(`${path}.kind must be inference, hypothesis or limitation`);
    if (typeof item.text !== 'string' || !item.text.trim()) throw new Error(`${path}.text must contain a scientific point`);
    if (!Array.isArray(item.artifacts) || !item.artifacts.length || item.artifacts.some(id => !state.byId.has(id))) throw new Error(`${path}.artifacts must cite existing evidence`);
    const refs = [...new Set(item.artifacts)].join(', ');
    const paragraphs = item.text.trim().split(/\n\s*\n/).map(paragraph => `**${INTERPRETATION_LABELS[item.kind]}:** ${paragraph.trim()} (${refs}).`);
    sections.push(paragraphs.join('\n\n'));
  }
  return sections.join('\n\n');
}

module.exports = { renderReport, OBSERVATIONS_SCHEMA, INTERPRETATIONS_SCHEMA };
