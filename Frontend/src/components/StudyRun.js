import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faExternalLinkAlt, faSpinner } from '@fortawesome/free-solid-svg-icons';
import AsoChart from './AsoChart';
import './StudyRun.css';

// A study run (aso_hpa) as it happens: the planned graph appears at once, nodes light up as they
// run, finish or fail, figures render as their chart nodes complete, and the report arrives last.
// Live SSE steps and stored run events share one shape (stage + JSON message), so the same
// reducer draws a run in progress and a run reloaded from history.

const NODE_W = 172;
const NODE_H = 48;
const COL_GAP = 58;
const ROW_GAP = 14;
const PAD = 20;

const FAMILY = { search: 'search', lookup: 'agent', measure: 'measure', chart: 'figure' };

function parse(message) {
  if (!message || typeof message !== 'string') return null;
  const t = message.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function stageOf(event) {
  return String(event?.stage || '').toLowerCase();
}

// The study's state after every event so far.
export function studyStateFromEvents(events) {
  const state = {
    phase: 'starting', workspaceUuid: null, mode: null, hpaVersion: null, understanding: '', cannot: [],
    nodes: [], byId: new Map(), reflections: [], report: null, final: null, error: null, agentSteps: new Map(),
    failed: false, complete: false, planErrors: []
  };
  const upsert = (raw, round) => {
    if (!raw?.id) return;
    let node = state.byId.get(raw.id);
    if (!node) {
      node = { id: raw.id, op: raw.op, label: raw.label || raw.id, inputs: raw.inputs || [], why: raw.why || '', args: raw.args || {}, status: 'pending', round };
      state.byId.set(node.id, node);
      state.nodes.push(node);
    } else {
      Object.assign(node, { op: raw.op || node.op, label: raw.label || node.label, inputs: raw.inputs || node.inputs, why: raw.why || node.why, args: raw.args || node.args });
    }
    return node;
  };
  for (const event of events || []) {
    if (event?.status === 'completed') {
      state.complete = true;
      if (event.failed) { state.failed = true; state.error = state.error || event.message; }
      continue;
    }
    if (event?.status === 'started') continue;
    const stage = stageOf(event);
    const d = parse(event.message) || {};
    if (stage === 'start') { state.workspaceUuid = d.workspace_uuid || state.workspaceUuid; state.mode = d.mode || null; state.hpaVersion = d.hpa_version || null; state.phase = 'planning'; }
    else if (stage === 'plan.start') state.phase = 'planning';
    else if (stage === 'plan.invalid') state.planErrors = d.errors || [];
    else if (stage === 'plan.graph') {
      state.understanding = d.understanding || '';
      state.cannot = Array.isArray(d.cannot) ? d.cannot : [];
      for (const raw of d.nodes || []) upsert(raw, 0);
      state.phase = 'running';
    } else if (stage === 'node.start') {
      const node = upsert({ id: d.node, op: d.op, label: d.label, inputs: d.inputs, args: d.args }, undefined);
      if (node) { node.status = 'running'; node.startedAt = event.createdAt || Date.now(); }
      state.phase = 'running';
    } else if (stage === 'node.done') {
      const node = upsert({ id: d.node, op: d.op, label: d.label });
      if (node) Object.assign(node, { status: 'done', rows: d.rows, ms: d.ms, columns: d.columns, sample: d.sample, sampleColumns: d.sample_columns, matrix: d.matrix, images: d.images || [], artifactUuid: d.artifact_uuid, searchUrl: d.search_url, query: d.query, asked: d.asked, found: d.found });
    } else if (stage === 'node.failed') {
      const node = upsert({ id: d.node, op: d.op, label: d.label });
      if (node) Object.assign(node, { status: 'failed', error: d.error, ms: d.ms });
    } else if (stage === 'node.blocked') {
      const node = upsert({ id: d.node });
      if (node) Object.assign(node, { status: 'blocked', error: d.input ? `waiting on ${d.input}, which failed` : 'an input never completed' });
    } else if (stage.startsWith('agent.')) {
      const key = String(d.node || '').split(':')[0];
      if (key) {
        if (!state.agentSteps.has(key)) state.agentSteps.set(key, []);
        state.agentSteps.get(key).push({ stage: stage.slice(6), label: d.label || '', message: d.message || '', who: String(d.node || '').includes(':') ? String(d.node).split(':')[1] : null });
      }
    } else if (stage === 'reflect.start') state.phase = 'reviewing';
    else if (stage === 'reflect') {
      state.reflections.push({ round: d.round, done: d.done, assessment: d.assessment || '', added: d.added || [], errors: d.errors || [] });
      for (const raw of d.added || []) upsert(raw, d.round);
      state.phase = d.done ? 'reporting' : 'running';
    } else if (stage === 'report.start') state.phase = 'reporting';
    else if (stage === 'report.written') state.report = { title: d.title || '', md: d.report_md || '' };
    else if (stage === 'final') { state.final = d; state.phase = 'done'; }
    else if (stage === 'error') { state.error = d.message || event.message || 'The study failed.'; state.failed = true; state.phase = 'failed'; }
  }
  if (state.complete && state.phase !== 'failed') state.phase = state.failed ? 'failed' : 'done';
  return state;
}

// One line for the shimmer bar while the study runs.
export function studyStatusLine(events) {
  const s = studyStateFromEvents(events);
  const running = s.nodes.filter(n => n.status === 'running');
  const done = s.nodes.filter(n => n.status === 'done').length;
  if (s.phase === 'planning') return 'Planning the study';
  if (s.phase === 'reviewing') return `Reviewing results · ${done}/${s.nodes.length} steps done`;
  if (s.phase === 'reporting') return 'Writing the report';
  if (s.phase === 'running') return running.length ? `Running ${running.map(n => `${n.id} ${n.op}`).slice(0, 3).join(', ')}${running.length > 3 ? ` +${running.length - 3}` : ''} · ${done}/${s.nodes.length} done` : `${done}/${s.nodes.length} steps done`;
  if (s.phase === 'failed') return 'Study failed';
  return 'Study complete';
}

// Longest-path layers from the plan's inputs, so every arrow points right.
function layoutNodes(nodes) {
  const depth = new Map();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const resolve = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const node = byId.get(id);
    const parents = (node?.inputs || []).filter(i => byId.has(i));
    const value = parents.length ? Math.max(...parents.map(p => resolve(p, seen))) + 1 : 0;
    depth.set(id, value);
    return value;
  };
  for (const n of nodes) resolve(n.id);
  const columns = new Map();
  for (const n of nodes) { const l = depth.get(n.id) || 0; if (!columns.has(l)) columns.set(l, []); columns.get(l).push(n); }
  const layers = Math.max(0, ...columns.keys()) + 1;
  const maxRows = Math.max(1, ...[...columns.values()].map(c => c.length));
  const positions = new Map();
  for (const [layer, list] of columns) {
    const offset = ((maxRows - list.length) * (NODE_H + ROW_GAP)) / 2;
    list.forEach((n, row) => positions.set(n.id, { x: PAD + layer * (NODE_W + COL_GAP), y: PAD + offset + row * (NODE_H + ROW_GAP) }));
  }
  return { positions, width: PAD * 2 + layers * NODE_W + Math.max(0, layers - 1) * COL_GAP, height: PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP };
}

function edgePath(from, to) {
  const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2, x2 = to.x, y2 = to.y + NODE_H / 2;
  const bend = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function seconds(ms) {
  return ms === undefined || ms === null ? '' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

// The report body without the title, goal, workspace line, figure links and the node table, which
// the view already shows.
function reportBody(md) {
  const cut = md.indexOf('\n## Figures');
  const body = (cut === -1 ? md : md.slice(0, cut)).split('\n').filter(line => !/^# /.test(line) && !/^\*\*(Goal|Workspace):\*\*/.test(line));
  return body.join('\n').trim();
}

function useTicker(active) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

function NodeDetail({ node, steps }) {
  const argEntries = Object.entries(node.args || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return (
    <div className="HPAG-study-detail">
      <div className="HPAG-study-detail-head">
        <span className={`HPAG-study-pill HPAG-study-pill-${node.status}`}>{node.status}</span>
        <span className="HPAG-study-detail-id">{node.id}</span>
        <span className="HPAG-study-detail-op">{node.op}</span>
        <span className="HPAG-study-detail-label">{node.label}</span>
        {node.ms !== undefined && <span className="HPAG-study-detail-meta">{seconds(node.ms)}</span>}
        {node.rows !== undefined && <span className="HPAG-study-detail-meta">{node.rows} rows</span>}
        {node.matrix && <span className="HPAG-study-detail-meta">{node.matrix[0]} × {node.matrix[1]} matrix</span>}
        {node.inputs?.length > 0 && <span className="HPAG-study-detail-meta">from {node.inputs.join(', ')}</span>}
      </div>
      {node.why && <div className="HPAG-study-detail-why">{node.why}</div>}
      {node.error && <div className="HPAG-study-detail-error">{node.error}</div>}
      {argEntries.length > 0 && (
        <dl className="HPAG-study-args">
          {argEntries.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd></React.Fragment>)}
        </dl>
      )}
      {node.searchUrl && (
        <div className="HPAG-study-detail-line">
          {node.query && <span>{node.query}</span>}
          <a href={node.searchUrl} target="_blank" rel="noopener noreferrer">open on proteinatlas.org <FontAwesomeIcon icon={faExternalLinkAlt} /></a>
        </div>
      )}
      {node.asked !== undefined && <div className="HPAG-study-detail-line">{node.found} of {node.asked} genes answered with a cited row</div>}
      {node.sample?.length > 0 && (
        <div className="HPAG-study-sample">
          <table>
            <thead><tr>{(node.sampleColumns || []).map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{node.sample.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
          </table>
          {node.columns?.length > (node.sampleColumns || []).length && <div className="HPAG-study-sample-more">columns: {node.columns.join(', ')}</div>}
        </div>
      )}
      {steps?.length > 0 && (
        <div className="HPAG-study-steps">
          {steps.slice(-14).map((s, i) => (
            <div key={i} className="HPAG-study-step">
              <span className="HPAG-study-step-label">{s.who ? `${s.who} · ` : ''}{s.label || s.stage}</span>
              <span className="HPAG-study-step-message">{truncate(s.message, 260)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StudyRun({ events, apiBaseUrl, workspaceUuid, isComplete, onArtifactEnter, onArtifactLeave }) {
  const state = useMemo(() => studyStateFromEvents(events), [events]);
  const layout = useMemo(() => layoutNodes(state.nodes), [state.nodes]);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  useTicker(!isComplete && state.phase !== 'done' && state.phase !== 'failed');
  const ws = workspaceUuid || state.workspaceUuid;

  const counts = { done: 0, failed: 0, running: 0 };
  for (const n of state.nodes) { if (n.status === 'done') counts.done++; else if (n.status === 'failed' || n.status === 'blocked') counts.failed++; else if (n.status === 'running') counts.running++; }
  const phaseText = { starting: 'Starting', planning: 'Planning the study', running: 'Running the graph', reviewing: 'Reviewing results', reporting: 'Writing the report', done: 'Complete', failed: 'Failed' }[state.phase] || state.phase;
  const selectedNode = selected ? state.byId.get(selected) : null;
  const neighbours = new Set();
  const focus = hovered || selected;
  if (focus) {
    neighbours.add(focus);
    for (const n of state.nodes) {
      if (n.inputs?.includes(focus)) neighbours.add(n.id);
      if (n.id === focus) for (const i of n.inputs || []) neighbours.add(i);
    }
  }
  const figures = state.nodes.filter(n => n.op === 'chart' && n.status === 'done' && n.artifactUuid);
  const elapsed = state.final?.seconds !== undefined ? `${Number(state.final.seconds).toFixed(1)}s` : null;

  return (
    <div className="HPAG-study">
      <div className="HPAG-study-head">
        <span className={`HPAG-study-phase HPAG-study-phase-${state.phase}`}>
          {!isComplete && state.phase !== 'done' && state.phase !== 'failed' && <FontAwesomeIcon icon={faSpinner} spin />} {phaseText}
        </span>
        {state.nodes.length > 0 && (
          <span className="HPAG-study-counts">
            <b>{counts.done}</b> of {state.nodes.length} steps done{counts.running ? `, ${counts.running} running` : ''}{counts.failed ? `, ${counts.failed} failed` : ''}
          </span>
        )}
        <span className="HPAG-study-meta">
          {elapsed && `${elapsed} · `}{state.final?.tokens?.total ? `${Number(state.final.tokens.total).toLocaleString()} tokens · ` : ''}{state.mode ? `${state.mode} data` : ''}{state.hpaVersion ? ` (HPA ${state.hpaVersion})` : ''}
        </span>
      </div>
      {state.understanding && <div className="HPAG-study-understanding">{state.understanding}</div>}
      {state.planErrors.length > 0 && <div className="HPAG-study-note">The first plan was corrected: {state.planErrors.slice(0, 3).join('; ')}</div>}
      {state.error && <div className="HPAG-study-error">{state.error}</div>}

      {state.nodes.length > 0 && (
        <div className="HPAG-study-scroll">
          <svg className="HPAG-study-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Study graph">
            <defs>
              <marker id="HPAG-study-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
              </marker>
            </defs>
            {state.nodes.map(n => (n.inputs || []).map(i => {
              const from = layout.positions.get(i);
              const to = layout.positions.get(n.id);
              if (!from || !to) return null;
              const hot = focus && (i === focus || n.id === focus);
              const dim = focus && !hot;
              return <path key={`${i}-${n.id}`} className={`HPAG-study-edge ${hot ? 'HPAG-study-edge-hot' : ''} ${dim ? 'HPAG-study-edge-dim' : ''}`} d={edgePath(from, to)} markerEnd="url(#HPAG-study-arrow)" />;
            }))}
            {state.nodes.map(n => {
              const p = layout.positions.get(n.id);
              if (!p) return null;
              const family = FAMILY[n.op] || 'table';
              const dim = focus && !neighbours.has(n.id);
              const sub = n.status === 'done' ? (n.rows !== undefined ? `${n.rows} rows` : n.matrix ? `${n.matrix[0]} × ${n.matrix[1]}` : n.images?.length ? 'figure' : '') : n.status === 'running' ? 'running…' : n.status === 'failed' ? 'failed' : n.status === 'blocked' ? 'blocked' : n.round ? `added in review ${n.round}` : 'waiting';
              return (
                <g key={n.id} className={`HPAG-study-node HPAG-study-node-${n.status} HPAG-study-family-${family} ${dim ? 'HPAG-study-node-dim' : ''} ${selected === n.id ? 'HPAG-study-node-selected' : ''}`}
                  transform={`translate(${p.x}, ${p.y})`}
                  onMouseEnter={() => setHovered(n.id)} onMouseLeave={() => setHovered(null)}
                  onClick={() => setSelected(selected === n.id ? null : n.id)}>
                  <rect className="HPAG-study-node-box" width={NODE_W} height={NODE_H} rx="8" ry="8" />
                  <rect className="HPAG-study-node-bar" width="5" height={NODE_H} rx="2.5" ry="2.5" />
                  <text x="13" y="18" className="HPAG-study-node-id">{n.id}</text>
                  <text x={NODE_W - 9} y="18" textAnchor="end" className="HPAG-study-node-op">{n.op}</text>
                  <text x="13" y="36" className="HPAG-study-node-label">{truncate(n.label, 22)}</text>
                  <text x={NODE_W - 9} y="36" textAnchor="end" className="HPAG-study-node-sub">{truncate(sub, 11)}</text>
                  <title>{n.id} {n.op}: {n.label}{n.why ? `\n${n.why}` : ''}{n.error ? `\n${n.error}` : ''}</title>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      {state.nodes.length > 0 && !selectedNode && <div className="HPAG-study-hint">Click a step to see what it did: its arguments, rows, the agent's trail, and any error.</div>}
      {selectedNode && <NodeDetail node={selectedNode} steps={state.agentSteps.get(selectedNode.id)} />}

      {state.reflections.map(r => (
        <div key={r.round} className="HPAG-study-review">
          <span className="HPAG-study-review-label">Review {r.round}{r.done ? ' · done' : r.added.length ? ` · added ${r.added.map(a => a.id).join(', ')}` : ''}</span>
          <span className="HPAG-study-review-text">{r.assessment}</span>
        </div>
      ))}
      {state.cannot.length > 0 && (
        <div className="HPAG-study-note">Not expressible in this database: {state.cannot.map(c => c.requirement).join('; ')}</div>
      )}

      {figures.length > 0 && ws && (
        <div className="HPAG-study-figures">
          {figures.map(n => (
            <div key={n.id} className="HPAG-study-figure">
              <AsoChart apiBaseUrl={apiBaseUrl} workspaceUuid={ws} artifactId={n.artifactUuid} title={`${n.id} · ${n.args?.title || n.label}`} onArtifactEnter={onArtifactEnter} onArtifactLeave={onArtifactLeave} />
            </div>
          ))}
        </div>
      )}

      {state.report && (
        <div className="HPAG-study-report">
          <div className="HPAG-study-report-title">{state.report.title}</div>
          <ReactMarkdown>{reportBody(state.report.md)}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
