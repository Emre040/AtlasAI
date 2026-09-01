import React, { useEffect, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpinner, faProjectDiagram } from '@fortawesome/free-solid-svg-icons';
import { authenticatedFetch } from '../api/auth';
import './ProvenanceGraph.css';

const NODE_WIDTH = 196;
const NODE_HEIGHT = 62;
const COLUMN_GAP = 96;
const ROW_GAP = 22;
const PADDING = 24;

const KIND_COLORS = {
  tool_result: '#2563eb',
  dataset: '#059669',
  cleaned: '#059669',
  measurement: '#d97706',
  analysis: '#7c3aed',
  figure: '#db2777',
  summary: '#475569',
  inspection: '#94a3b8'
};

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function detailLines(node) {
  const lines = [];
  const d = node.details || {};
  if (d.rows_found !== undefined) lines.push(`${d.rows_found} genes found`);
  if (d.row_count !== undefined) lines.push(`${d.row_count} rows`);
  if (d.numeric_count !== undefined) lines.push(`${d.numeric_count} numeric values`);
  if (d.tissue) lines.push(`tissue: ${d.tissue}`);
  if (d.gene) lines.push(`gene: ${d.gene}`);
  if (d.extracted_value !== undefined) lines.push(`value: ${d.extracted_value}`);
  if (d.mode) lines.push(`data: ${d.mode}`);
  if (d.top_x) lines.push(`top ${d.top_x}`);
  if (d.joinKey) lines.push(`joined on ${d.joinKey}`);
  if (d.valueKey) lines.push(`value: ${d.valueKey}`);
  if (d.type) lines.push(`chart: ${d.type}`);
  if (d.search_url) lines.push(d.search_url);
  if (d.answer) lines.push(d.answer);
  if (node.purpose) lines.push(node.purpose);
  return lines;
}

// Column per derivation depth, rows in creation order; sizes derive from the node count.
function useLayout(graph) {
  return useMemo(() => {
    if (!graph) return null;
    const columns = new Map();
    for (const node of graph.nodes) {
      if (!columns.has(node.layer)) columns.set(node.layer, []);
      columns.get(node.layer).push(node);
    }
    const positions = new Map();
    let maxRows = 1;
    for (const [layer, nodes] of columns) {
      nodes.sort((a, b) => a.created_at - b.created_at);
      maxRows = Math.max(maxRows, nodes.length);
      nodes.forEach((node, row) => {
        positions.set(node.id, {
          x: PADDING + layer * (NODE_WIDTH + COLUMN_GAP),
          y: PADDING + row * (NODE_HEIGHT + ROW_GAP)
        });
      });
    }
    const width = PADDING * 2 + graph.layers * NODE_WIDTH + Math.max(0, graph.layers - 1) * COLUMN_GAP;
    const height = PADDING * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
    return { positions, width, height };
  }, [graph]);
}

function edgePath(from, to) {
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const bend = Math.max(32, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export default function ProvenanceGraph({ apiBaseUrl, workspaceUuid, onOpenArtifact, onLeaveArtifact }) {
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState(null);
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    if (!workspaceUuid) return undefined;
    let cancelled = false;
    authenticatedFetch(`${apiBaseUrl}/workspaces/${workspaceUuid}/provenance`)
      .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
      .then(json => { if (!cancelled) setGraph(json); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [apiBaseUrl, workspaceUuid]);

  const layout = useLayout(graph);
  const outputs = useMemo(() => new Set(graph?.outputs || []), [graph]);

  if (error) return <div className="HPAG-prov-error">Provenance could not be loaded ({error}).</div>;
  if (!graph || !layout) return <div className="HPAG-prov-loading"><FontAwesomeIcon icon={faSpinner} spin /> Tracing artifacts…</div>;
  if (graph.nodes.length === 0) return <div className="HPAG-prov-error">This run produced no artifacts.</div>;

  const hoveredNode = hovered ? graph.nodes.find(node => node.id === hovered) : null;
  const highlighted = new Set();
  if (hoveredNode) {
    highlighted.add(hoveredNode.id);
    for (const edge of graph.edges) {
      if (edge.to === hoveredNode.id) highlighted.add(edge.from);
      if (edge.from === hoveredNode.id) highlighted.add(edge.to);
    }
  }

  return (
    <div className="HPAG-prov">
      <div className="HPAG-prov-head">
        <FontAwesomeIcon icon={faProjectDiagram} />
        <span className="HPAG-prov-title">How this result was produced</span>
        <span className="HPAG-prov-meta">
          {graph.nodes.length} artifacts · {graph.edges.length} derivations
          {graph.workspace.mode ? ` · ${graph.workspace.mode} data${graph.workspace.hpa_version ? ` (HPA ${graph.workspace.hpa_version})` : ''}` : ''}
          {graph.workspace.model ? ` · ${graph.workspace.model}` : ''}
        </span>
      </div>
      <div className="HPAG-prov-legend">
        {Object.entries(KIND_COLORS).filter(([kind]) => graph.nodes.some(node => node.kind === kind)).map(([kind, color]) => (
          <span key={kind} className="HPAG-prov-legend-item"><i style={{ background: color }} />{kind.replace('_', ' ')}</span>
        ))}
        <span className="HPAG-prov-legend-item"><i className="HPAG-prov-legend-output" />final output</span>
      </div>
      <div className="HPAG-prov-scroll">
        <svg className="HPAG-prov-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Provenance graph">
          <defs>
            <marker id="HPAG-prov-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
            </marker>
            <marker id="HPAG-prov-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#111827" />
            </marker>
          </defs>
          {graph.edges.map(edge => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (!from || !to) return null;
            const hot = hoveredNode && (edge.from === hoveredNode.id || edge.to === hoveredNode.id);
            return (
              <g key={`${edge.from}-${edge.to}-${edge.relation}`} className={`HPAG-prov-edge ${hot ? 'HPAG-prov-edge-hot' : ''}`}>
                <path d={edgePath(from, to)} markerEnd={`url(#${hot ? 'HPAG-prov-arrow-hot' : 'HPAG-prov-arrow'})`} />
                <title>{edge.relation.replace('_', ' ')} → {edge.operation}</title>
              </g>
            );
          })}
          {graph.nodes.map(node => {
            const position = layout.positions.get(node.id);
            const color = KIND_COLORS[node.kind] || '#64748b';
            const dim = hoveredNode && !highlighted.has(node.id);
            const isOutput = outputs.has(node.id);
            const openable = node.format === 'png' || node.format === 'json' || node.format === 'md';
            return (
              <g
                key={node.id}
                className={`HPAG-prov-node ${dim ? 'HPAG-prov-node-dim' : ''} ${openable ? 'HPAG-prov-node-openable' : ''}`}
                transform={`translate(${position.x}, ${position.y})`}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => { setHovered(null); if (openable) onLeaveArtifact?.(); }}
                onClick={event => openable && onOpenArtifact?.(node, event)}
              >
                <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="9" ry="9" className="HPAG-prov-node-box" style={isOutput ? { stroke: '#111827', strokeWidth: 2 } : undefined} />
                <rect width="6" height={NODE_HEIGHT} rx="3" ry="3" fill={color} />
                <text x="16" y="22" className="HPAG-prov-node-title">{truncate(node.title, 26)}</text>
                <text x="16" y="40" className="HPAG-prov-node-sub">{truncate(node.subtitle || node.producer_label, 30)}</text>
                <text x="16" y="54" className="HPAG-prov-node-meta">{truncate([node.format, formatBytes(node.size_bytes)].filter(Boolean).join(' · '), 30)}</text>
              </g>
            );
          })}
        </svg>
      </div>
      {hoveredNode && (
        <div className="HPAG-prov-details">
          <div className="HPAG-prov-details-title">{hoveredNode.title}{hoveredNode.subtitle ? ` · ${hoveredNode.subtitle}` : ''}</div>
          <div className="HPAG-prov-details-body">
            <span>produced by {hoveredNode.producer_label}</span>
            {detailLines(hoveredNode).map((line, index) => <span key={index}>{line}</span>)}
            <span>{new Date(hoveredNode.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
          </div>
        </div>
      )}
    </div>
  );
}
