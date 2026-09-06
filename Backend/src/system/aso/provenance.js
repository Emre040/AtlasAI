'use strict';

// Turns a workspace's artifact rows and links into a drawable provenance graph: which artifacts
// were used, through which operation, to produce which datasets, analyses, figures and report.
// Nothing here is model-generated; it is read straight from aso_artifacts, aso_artifact_links and
// the artifact files themselves.

const fs = require('node:fs/promises');
const path = require('node:path');
const { uuidBufferToString } = require('../../shared/ids');

const MAX_DETAIL_FILE_BYTES = 512 * 1024;

// Human names for producer keys (ASO operations and tools).
const PRODUCER_LABELS = Object.freeze({
  deep_research_hpa: 'Deep research search',
  investigator_hpa: 'Gene investigation',
  aso_hpa: 'ASO operation',
  chart: 'Chart rendering',
  explicit_request: 'Requested chart',
  report: 'Final report',
  // Study (ASO v2) operations: the node's producer is the operation that made it.
  search: 'Search agent',
  lookup: 'Reading agent',
  fetch: 'Fetch',
  measure: 'Measure',
  union: 'Union',
  combine: 'Combine',
  analysis_combine: 'Combine',
  intersect: 'Intersect',
  difference: 'Difference',
  join: 'Join',
  filter: 'Filter',
  select: 'Select',
  rank: 'Rank',
  top_per_group: 'Top per group',
  aggregate: 'Aggregate',
  compute: 'Compute',
  pivot: 'Pivot'
});

const TYPE_LABELS = Object.freeze({
  tool_result: 'Tool result',
  gene_list: 'Gene list',
  cleaned: 'Cleaned dataset',
  dataset: 'Dataset',
  measurement: 'Measurement batch',
  analysis: 'Analysis',
  analysis_rank: 'Ranking',
  analysis_delta: 'Difference',
  analysis_aggregate: 'Aggregate',
  analysis_merge: 'Merge',
  analysis_scatter: 'Scatter join',
  analysis_concat: 'Concatenation',
  analysis_matrix: 'Matrix',
  analysis_union: 'Union',
  analysis_intersect: 'Intersection',
  analysis_difference: 'Difference',
  analysis_join: 'Join',
  analysis_filter: 'Filter',
  analysis_select: 'Selection',
  analysis_top_per_group: 'Top per group',
  analysis_compute: 'Computed column',
  figure: 'Figure',
  summary: 'Report',
  inspection: 'Inspection'
});

function parseSchema(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null && source[key] !== '') out[key] = source[key];
  }
  return out;
}

// Small, whitelisted facts from the artifact file: what a search found, what was measured, how an
// analysis was joined. Never the rows themselves.
function detailsFromPayload(artifact, payload) {
  if (!payload || typeof payload !== 'object') return {};
  const provenance = payload.provenance && typeof payload.provenance === 'object' ? payload.provenance : {};
  const details = pick(provenance, ['tool', 'purpose', 'top_x', 'joinKey', 'valueKey', 'mode', 'op', 'key', 'metric', 'direction', 'limit']);
  if (artifact.kind === 'tool_result') {
    Object.assign(details, pick(payload.compact || {}, ['rows_found', 'search_url', 'validation_passed', 'gene', 'ensembl', 'found', 'extracted_value', 'confidence', 'mode']));
    if (payload.compact?.answer_snippet) details.answer = String(payload.compact.answer_snippet).slice(0, 200);
  }
  if (artifact.kind === 'measurement') {
    Object.assign(details, pick(payload, ['label', 'tissue', 'mode', 'value_type', 'unit', 'row_count', 'numeric_count', 'node_id', 'op']));
  }
  if (artifact.kind === 'dataset' || artifact.kind === 'cleaned' || artifact.kind === 'analysis') {
    Object.assign(details, pick(payload, ['label', 'row_count', 'count', 'unit', 'value_type', 'node_id', 'op']));
    if (Array.isArray(payload.rows) && details.row_count === undefined) details.row_count = payload.rows.length;
    if (Array.isArray(payload.genes) && details.row_count === undefined) details.row_count = payload.genes.length;
  }
  if (artifact.kind === 'figure' && Array.isArray(payload.charts)) {
    const chart = payload.charts[0] || {};
    Object.assign(details, pick(chart, ['type', 'title', 'x_label', 'y_label']));
    Object.assign(details, pick(payload, ['node_id', 'label']));
    details.chart_count = payload.charts.length;
  }
  return details;
}

async function readDetails(artifact) {
  if (artifact.format !== 'json' || !artifact.storage_uri) return {};
  if (artifact.size_bytes !== null && Number(artifact.size_bytes) > MAX_DETAIL_FILE_BYTES) return {};
  try {
    const text = await fs.readFile(artifact.storage_uri, 'utf8');
    return detailsFromPayload(artifact, JSON.parse(text));
  } catch {
    return {};
  }
}

function nodeTitle(artifact, schema, details) {
  if (artifact.kind === 'tool_result') return PRODUCER_LABELS[artifact.producer_key] || artifact.producer_key;
  if (artifact.kind === 'analysis') return TYPE_LABELS[`analysis_${schema?.type}`] || TYPE_LABELS[artifact.type_key] || 'Analysis';
  if (artifact.kind === 'figure') return schema?.type === 'image' ? 'Rendered figure' : 'Chart specification';
  return TYPE_LABELS[artifact.type_key] || TYPE_LABELS[artifact.kind] || artifact.kind;
}

function nodeSubtitle(artifact, details) {
  if (details.label) return details.label;
  if (details.title) return details.title;
  if (artifact.purpose) return artifact.purpose;
  if (details.gene) return details.gene;
  if (details.search_url) return details.search_url.replace('https://www.proteinatlas.org/search/', '').replace(/\+/g, ' ').slice(0, 80);
  return '';
}

// Longest-path layering from the roots so every edge points to a later column.
function layer(nodes, edges) {
  const incoming = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) incoming.get(edge.to)?.push(edge.from);
  const depth = new Map();
  const visiting = new Set();
  const resolve = id => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = incoming.get(id) || [];
    const value = parents.length === 0 ? 0 : Math.max(...parents.map(resolve)) + 1;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const node of nodes) node.layer = resolve(node.id);
}

async function buildProvenanceGraph({ workspace, artifacts, links }) {
  const byId = new Map();
  const nodes = [];
  for (const artifact of artifacts) {
    const schema = parseSchema(artifact.schema_json);
    const details = await readDetails(artifact);
    const id = uuidBufferToString(artifact.public_id);
    const node = {
      id,
      kind: artifact.kind,
      type: artifact.type_key,
      schema_type: schema?.type ?? null,
      format: artifact.format,
      name: artifact.name,
      producer: artifact.producer_key,
      producer_label: PRODUCER_LABELS[artifact.producer_key] || artifact.producer_key,
      title: nodeTitle(artifact, schema, details),
      subtitle: nodeSubtitle(artifact, details),
      purpose: artifact.purpose,
      size_bytes: artifact.size_bytes === null ? null : Number(artifact.size_bytes),
      created_at: Number(artifact.created_unix_ms),
      details,
      artifact_path: `/workspaces/${uuidBufferToString(workspace.public_id)}/artifacts/${artifact.name}`,
      layer: 0
    };
    byId.set(Number(artifact.id), node);
    nodes.push(node);
  }

  const edges = [];
  for (const link of links) {
    const from = byId.get(Number(link.related_artifact_id));
    const to = byId.get(Number(link.artifact_id));
    if (!from || !to) continue;
    edges.push({ from: from.id, to: to.id, relation: link.relation, ordinal: Number(link.ordinal), operation: to.producer_label });
  }
  layer(nodes, edges);

  const consumed = new Set(edges.map(edge => edge.from));
  const plan = parseSchema(workspace.plan_json) || {};
  return {
    workspace: {
      id: uuidBufferToString(workspace.public_id),
      goal: workspace.request_text,
      status: workspace.status,
      status_message: workspace.status_message,
      model: workspace.model_config_key,
      mode: plan.mode ?? null,
      hpa_version: plan.hpa_version ?? null,
      artifact_count: Number(workspace.artifact_count),
      created_at: Number(workspace.created_unix_ms),
      finished_at: workspace.finished_unix_ms === null ? null : Number(workspace.finished_unix_ms)
    },
    nodes,
    edges,
    outputs: nodes.filter(node => !consumed.has(node.id) && (node.kind === 'figure' || node.kind === 'analysis' || node.kind === 'summary')).map(node => node.id),
    layers: Math.max(0, ...nodes.map(node => node.layer)) + 1
  };
}

module.exports = { buildProvenanceGraph, detailsFromPayload, layer };
