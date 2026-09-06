'use strict';

const CHART_KINDS = ['bar', 'lollipop', 'dot_plot', 'diverging_bar', 'grouped_bar', 'scatter', 'bubble', 'heatmap', 'radar', 'line', 'volcano'];
const KINDS = ['gene_set', 'table', 'interpretation', 'summary', ...CHART_KINDS];
const AGENT_FOR = { gene_set: 'deep_research_hpa', interpretation: 'investigator_hpa' };
const isReport = item => item.kind === 'summary';

function validateItem(item) {
  if (!KINDS.includes(item.kind)) throw new Error(`Plan kind must be one of ${KINDS.join(', ')}`);
  if (!String(item.text || '').trim()) throw new Error('A plan step must describe its requested result');
}

function createItem(input) {
  const item = { text: String(input.step || ''), kind: input.kind,
    inputs: input.inputs, status: 'todo', note: '', artifacts: [] };
  validateItem(item);
  return item;
}

function completionIssue(item, byId) {
  validateItem(item);
  if (!Array.isArray(item.artifacts) || item.artifacts.some(id => !byId.has(id))) return 'artifacts must list existing artifact IDs';
  if (isReport(item)) return null;
  const evidence = item.artifacts.map(id => byId.get(id));
  const agent = AGENT_FOR[item.kind];
  if (agent) return evidence.some(a => a.tool === agent) ? null : `requires ${agent} output for this step; an earlier search in table ancestry does not answer this question`;
  if (CHART_KINDS.includes(item.kind)) return evidence.some(a => a.tool === 'chart' && a.args.type === item.kind && a.kind === 'figure' && a.images.length)
    ? null : `requires chart output of type ${item.kind} (a rendered figure)`;
  const tables = evidence.filter(a => a.kind === 'data' && (Array.isArray(a.rows) || a.matrix));
  if (!tables.length) return 'requires a saved result table';
  const unfinished = a => [...(a.meta?.remaining_for_aso || []), ...(a.meta?.not_in_release || [])];
  if (tables.some(a => !unfinished(a).length)) return null;
  return `Investigator returned supporting data with unfinished requirements: ${[...new Set(tables.flatMap(a => unfinished(a).map(item => item.requirement)))].join('; ')}. Complete that work or revise the plan explicitly`;
}

module.exports = { KINDS, CHART_KINDS, createItem, validateItem, completionIssue, isReport };
