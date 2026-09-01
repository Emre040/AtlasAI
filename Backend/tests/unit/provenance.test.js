'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProvenanceGraph, detailsFromPayload, layer } = require('../../src/system/aso/provenance');
const { uuidStringToBuffer } = require('../../src/shared/ids');

const WORKSPACE_UUID = '01a05ee1-978d-7038-92c0-a5caffb27a7a';
const UUIDS = [
  '01a05ee1-0000-7000-8000-000000000001',
  '01a05ee1-0000-7000-8000-000000000002',
  '01a05ee1-0000-7000-8000-000000000003',
  '01a05ee1-0000-7000-8000-000000000004',
  '01a05ee1-0000-7000-8000-000000000005'
];

function artifact(id, kind, typeKey, producer, format = 'json', extra = {}) {
  return {
    id,
    public_id: uuidStringToBuffer(UUIDS[id - 1]),
    kind,
    type_key: typeKey,
    format,
    name: `${UUIDS[id - 1]}.${format}`,
    producer_key: producer,
    purpose: null,
    storage_uri: '/nonexistent/path',
    content_type: null,
    size_bytes: 100 * id,
    schema_json: null,
    created_unix_ms: 1_700_000_000_000 + id,
    ...extra
  };
}

test('provenance graph layers artifacts by derivation depth and marks unconsumed outputs', async () => {
  const rows = {
    workspace: {
      public_id: uuidStringToBuffer(WORKSPACE_UUID), status: 'completed', request_text: 'Compare kidney genes',
      plan_json: JSON.stringify({ mode: 'offline', hpa_version: '25.1' }), artifact_count: 5, status_message: null,
      created_unix_ms: 1, started_unix_ms: 1, finished_unix_ms: 9, model_config_key: 'deepseek-v4-flash'
    },
    artifacts: [
      artifact(1, 'tool_result', 'tool_result', 'deep_research_hpa'),
      artifact(2, 'dataset', 'gene_list', 'aso_hpa'),
      artifact(3, 'measurement', 'measurement', 'aso_hpa'),
      artifact(4, 'figure', 'figure', 'chart', 'json', { schema_json: JSON.stringify({ type: 'chart_spec' }) }),
      artifact(5, 'figure', 'figure', 'aso_hpa', 'png', { schema_json: JSON.stringify({ type: 'image' }) })
    ],
    links: [
      { artifact_id: 2, related_artifact_id: 1, relation: 'derived_from', ordinal: 0 },
      { artifact_id: 3, related_artifact_id: 2, relation: 'derived_from', ordinal: 0 },
      { artifact_id: 4, related_artifact_id: 3, relation: 'derived_from', ordinal: 0 },
      { artifact_id: 5, related_artifact_id: 4, relation: 'derived_from', ordinal: 0 }
    ]
  };
  const graph = await buildProvenanceGraph(rows);
  assert.equal(graph.workspace.id, WORKSPACE_UUID);
  assert.equal(graph.workspace.mode, 'offline');
  assert.equal(graph.layers, 5);
  assert.deepEqual(graph.nodes.map(node => node.layer), [0, 1, 2, 3, 4]);
  assert.deepEqual(graph.outputs, [UUIDS[4]]);
  assert.equal(graph.edges.length, 4);
  assert.equal(graph.edges[0].operation, 'ASO operation');
  assert.equal(graph.nodes[0].title, 'Deep research search');
  assert.equal(graph.nodes[3].title, 'Chart specification');
  assert.equal(graph.nodes[4].title, 'Rendered figure');
  assert.equal(graph.nodes[0].artifact_path, `/workspaces/${WORKSPACE_UUID}/artifacts/${UUIDS[0]}.json`);
});

test('payload details stay whitelisted and never include rows', () => {
  const details = detailsFromPayload({ kind: 'measurement' }, {
    label: 'Kidney nTPM', tissue: 'kidney', mode: 'direct', row_count: 3, rows: [{ gene: 'FXYD2', value: 3774.6 }],
    provenance: { source_dataset: 'x', purpose: 'Kidney nTPM' }
  });
  assert.deepEqual(details, { purpose: 'Kidney nTPM', label: 'Kidney nTPM', tissue: 'kidney', mode: 'direct', row_count: 3 });

  // A cycle (impossible for real links, which always point at earlier artifacts) still terminates.
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  layer(nodes, [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]);
  assert.deepEqual(nodes.map(node => node.layer), [2, 0, 1]);
});
