import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faExternalLinkAlt, faSpinner, faTimes, faMinus } from '@fortawesome/free-solid-svg-icons';
import AsoChart from './AsoChart';
import './StudyRun.css';

// A study run (aso_hpa) as a live map. The plan is a checklist in the corner; the map starts empty
// and grows an island for every step as it runs, each island holding the data the step produced:
// a table preview, the search result, or the figure itself. Live SSE steps and stored run events
// share one shape (stage + JSON message), so the same reducer draws a run in progress and a run
// reloaded from history.

const KIND = {
  search: { name: 'Deep research', family: 'agent-search' },
  lookup: { name: 'Investigator', family: 'agent-gene' },
  measure: { name: 'Measure', family: 'measure' },
  chart: { name: 'Figure', family: 'figure' }
};
const ISLAND_W = 240;
const CHART_W = 380;
const COL_GAP = 64;
const ROW_GAP = 22;
const PAD = 24;
const HEIGHT = { running: 78, failed: 104, blocked: 78, data: 128, matrix: 96, figure: 292, search: 132 };

function parse(message) {
  if (!message || typeof message !== 'string') return null;
  const t = message.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function stageOf(event) {
  return String(event?.stage || '').toLowerCase();
}

function kindOf(node) {
  return KIND[node.op] || { name: node.op, family: 'table' };
}

// The study's state after every event so far.
export function studyStateFromEvents(events) {
  const state = {
    phase: 'starting', workspaceUuid: null, mode: null, hpaVersion: null, understanding: '', cannot: [],
    nodes: [], byId: new Map(), reflections: [], report: null, final: null, error: null, agentSteps: new Map(),
    failed: false, complete: false, planErrors: [], order: 0
  };
  const upsert = (raw, round) => {
    if (!raw?.id) return null;
    let node = state.byId.get(raw.id);
    if (!node) {
      node = { id: raw.id, op: raw.op, label: raw.label || raw.id, inputs: raw.inputs || [], why: raw.why || '', args: raw.args || {}, status: 'pending', round: round || 0, appeared: null };
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
      const node = upsert({ id: d.node, op: d.op, label: d.label, inputs: d.inputs, args: d.args });
      if (node) { node.status = 'running'; if (node.appeared === null) node.appeared = state.order++; }
      state.phase = 'running';
    } else if (stage === 'node.done') {
      const node = upsert({ id: d.node, op: d.op, label: d.label });
      if (node) {
        if (node.appeared === null) node.appeared = state.order++;
        Object.assign(node, { status: 'done', rows: d.rows, ms: d.ms, columns: d.columns, sample: d.sample, sampleColumns: d.sample_columns, matrix: d.matrix, images: d.images || [], artifactUuid: d.artifact_uuid, searchUrl: d.search_url, query: d.query, asked: d.asked, found: d.found });
      }
    } else if (stage === 'node.failed') {
      const node = upsert({ id: d.node, op: d.op, label: d.label });
      if (node) { if (node.appeared === null) node.appeared = state.order++; Object.assign(node, { status: 'failed', error: d.error, ms: d.ms }); }
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
  if (s.phase === 'running') return running.length ? `${running.map(n => `${n.id} ${kindOf(n).name.toLowerCase()}`).slice(0, 3).join(', ')}${running.length > 3 ? ` +${running.length - 3}` : ''} · ${done}/${s.nodes.length} done` : `${done}/${s.nodes.length} steps done`;
  if (s.phase === 'failed') return 'Study failed';
  return 'Study complete';
}

function bodyKind(node) {
  if (node.status === 'running' || node.status === 'failed' || node.status === 'blocked') return node.status;
  if (node.op === 'chart') return 'figure';
  if (node.op === 'search') return 'search';
  if (node.matrix) return 'matrix';
  return 'data';
}

// Islands are the steps that have started. Each sits one column right of its inputs and keeps its
// row once placed, so the map grows without rearranging what is already there.
function layoutIslands(nodes) {
  const islands = nodes.filter(n => n.appeared !== null).sort((a, b) => a.appeared - b.appeared);
  const layer = new Map();
  for (const n of islands) {
    const parents = (n.inputs || []).filter(i => layer.has(i));
    layer.set(n.id, parents.length ? Math.max(...parents.map(p => layer.get(p))) + 1 : 0);
  }
  const columns = new Map();
  for (const n of islands) { const l = layer.get(n.id); if (!columns.has(l)) columns.set(l, []); columns.get(l).push(n); }
  const layers = Math.max(-1, ...columns.keys()) + 1;
  const colWidth = [];
  for (let l = 0; l < layers; l++) colWidth.push((columns.get(l) || []).some(n => n.op === 'chart') ? CHART_W : ISLAND_W);
  const colX = [];
  let x = PAD;
  for (let l = 0; l < layers; l++) { colX.push(x); x += colWidth[l] + COL_GAP; }
  const boxes = new Map();
  let height = 0;
  for (let l = 0; l < layers; l++) {
    let y = PAD;
    for (const n of columns.get(l) || []) {
      const h = HEIGHT[bodyKind(n)] || HEIGHT.data;
      const w = n.op === 'chart' ? CHART_W : ISLAND_W;
      boxes.set(n.id, { x: colX[l], y, w, h });
      y += h + ROW_GAP;
    }
    height = Math.max(height, y);
  }
  return { islands, boxes, width: layers ? x - COL_GAP + PAD : 0, height: islands.length ? height - ROW_GAP + PAD : 0 };
}

function edgePath(from, to) {
  const x1 = from.x + from.w, y1 = from.y + Math.min(from.h, 60) / 2 + 8, x2 = to.x, y2 = to.y + Math.min(to.h, 60) / 2 + 8;
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
// the map already shows.
function reportBody(md) {
  const cut = md.indexOf('\n## Figures');
  const body = (cut === -1 ? md : md.slice(0, cut)).split('\n').filter(line => !/^# /.test(line) && !/^\*\*(Goal|Workspace):\*\*/.test(line));
  return body.join('\n').trim();
}

function IslandBody({ node, apiBaseUrl, workspaceUuid, onArtifactEnter, onArtifactLeave }) {
  const kind = bodyKind(node);
  if (kind === 'running') return <div className="HPAG-map-working"><FontAwesomeIcon icon={faSpinner} spin /> working…</div>;
  if (kind === 'failed' || kind === 'blocked') return <div className="HPAG-map-fail">{truncate(node.error, 120)}</div>;
  if (kind === 'figure') {
    return workspaceUuid && node.artifactUuid
      ? <div className="HPAG-map-figure"><AsoChart apiBaseUrl={apiBaseUrl} workspaceUuid={workspaceUuid} artifactId={node.artifactUuid} title="" height={210} onArtifactEnter={onArtifactEnter} onArtifactLeave={onArtifactLeave} /></div>
      : <div className="HPAG-map-working">figure rendered</div>;
  }
  if (kind === 'search') {
    return (
      <div className="HPAG-map-search">
        <div className="HPAG-map-count">{node.rows} genes</div>
        <div className="HPAG-map-query">{truncate(node.query, 110)}</div>
        {node.sample?.length > 0 && <div className="HPAG-map-genes">{node.sample.map(r => r[0]).filter(Boolean).join(', ')}{node.rows > node.sample.length ? ', …' : ''}</div>}
      </div>
    );
  }
  if (kind === 'matrix') return <div className="HPAG-map-count">{node.matrix[0]} × {node.matrix[1]} matrix</div>;
  const cols = node.sampleColumns || [];
  return (
    <div className="HPAG-map-sheet">
      <div className="HPAG-map-count">{node.rows} rows{node.asked !== undefined ? ` · ${node.found} of ${node.asked} answered` : ''}</div>
      {cols.length > 0 && (
        <table>
          <thead><tr>{cols.slice(0, 4).map(c => <th key={c}>{truncate(c, 14)}</th>)}</tr></thead>
          <tbody>{(node.sample || []).slice(0, 3).map((row, i) => <tr key={i}>{row.slice(0, 4).map((cell, j) => <td key={j}>{truncate(cell, 16)}</td>)}</tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

function NodeDetail({ node, steps }) {
  const argEntries = Object.entries(node.args || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return (
    <div className="HPAG-study-detail">
      <div className="HPAG-study-detail-head">
        <span className={`HPAG-study-pill HPAG-study-pill-${node.status}`}>{node.status}</span>
        <span className="HPAG-study-detail-id">{node.id}</span>
        <span className="HPAG-study-detail-op">{kindOf(node).name}</span>
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

function TodoIcon({ status }) {
  if (status === 'done') return <FontAwesomeIcon icon={faCheck} className="HPAG-todo-icon HPAG-todo-icon-done" />;
  if (status === 'running') return <FontAwesomeIcon icon={faSpinner} spin className="HPAG-todo-icon HPAG-todo-icon-running" />;
  if (status === 'failed') return <FontAwesomeIcon icon={faTimes} className="HPAG-todo-icon HPAG-todo-icon-failed" />;
  if (status === 'blocked') return <FontAwesomeIcon icon={faMinus} className="HPAG-todo-icon HPAG-todo-icon-blocked" />;
  return <span className="HPAG-todo-icon HPAG-todo-icon-pending" />;
}

export default function StudyRun({ events, apiBaseUrl, workspaceUuid, isComplete, onArtifactEnter, onArtifactLeave }) {
  const state = useMemo(() => studyStateFromEvents(events), [events]);
  const layout = useMemo(() => layoutIslands(state.nodes), [state.nodes]);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [planOpen, setPlanOpen] = useState(true);
  const ws = workspaceUuid || state.workspaceUuid;
  // Once the study is over the checklist has done its job; fold it so the map has the space.
  const finished = state.phase === 'done' || state.phase === 'failed';
  useEffect(() => { if (finished) setPlanOpen(false); }, [finished]);

  const counts = { done: 0, failed: 0, running: 0 };
  for (const n of state.nodes) { if (n.status === 'done') counts.done++; else if (n.status === 'failed' || n.status === 'blocked') counts.failed++; else if (n.status === 'running') counts.running++; }
  const phaseText = { starting: 'Starting', planning: 'Planning', running: 'Running', reviewing: 'Reviewing results', reporting: 'Writing the report', done: 'Complete', failed: 'Failed' }[state.phase] || state.phase;
  const live = !isComplete && state.phase !== 'done' && state.phase !== 'failed';
  const selectedNode = selected ? state.byId.get(selected) : null;
  const focus = hovered || selected;
  const elapsed = state.final?.seconds !== undefined ? `${Number(state.final.seconds).toFixed(1)}s` : null;
  const reviewFor = round => state.reflections.find(r => r.round === round);

  return (
    <div className="HPAG-study">
      <div className="HPAG-study-head">
        <span className={`HPAG-study-phase HPAG-study-phase-${state.phase}`}>{live && <FontAwesomeIcon icon={faSpinner} spin />} {phaseText}</span>
        {state.nodes.length > 0 && (
          <span className="HPAG-study-counts"><b>{counts.done}</b> of {state.nodes.length} steps done{counts.running ? `, ${counts.running} running` : ''}{counts.failed ? `, ${counts.failed} failed` : ''}</span>
        )}
        <span className="HPAG-study-meta">
          {elapsed && `${elapsed} · `}{state.final?.tokens?.total ? `${Number(state.final.tokens.total).toLocaleString()} tokens · ` : ''}{state.mode ? `${state.mode} data` : ''}{state.hpaVersion ? ` (HPA ${state.hpaVersion})` : ''}
        </span>
      </div>
      {state.error && <div className="HPAG-study-error">{state.error}</div>}

      <div className="HPAG-study-body">
        <div className="HPAG-map-wrap">
          {layout.islands.length === 0 ? (
            <div className="HPAG-map-empty">{state.phase === 'planning' || state.phase === 'starting' ? 'The map fills in as steps run.' : 'No step has run.'}</div>
          ) : (
            <div className="HPAG-map-scroll">
              <div className="HPAG-map" style={{ width: layout.width + (planOpen ? 320 : 0), height: layout.height }}>
                <svg className="HPAG-map-edges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
                  <defs>
                    <marker id="HPAG-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
                    </marker>
                  </defs>
                  {layout.islands.map(n => (n.inputs || []).map(i => {
                    const from = layout.boxes.get(i);
                    const to = layout.boxes.get(n.id);
                    if (!from || !to) return null;
                    const hot = focus && (i === focus || n.id === focus);
                    return <path key={`${i}-${n.id}`} className={`HPAG-map-edge ${hot ? 'HPAG-map-edge-hot' : ''} ${focus && !hot ? 'HPAG-map-edge-dim' : ''}`} d={edgePath(from, to)} markerEnd="url(#HPAG-map-arrow)" />;
                  }))}
                </svg>
                {layout.islands.map(n => {
                  const box = layout.boxes.get(n.id);
                  const kind = kindOf(n);
                  return (
                    <div
                      key={n.id}
                      className={`HPAG-map-island HPAG-map-island-${n.status} HPAG-map-family-${kind.family} ${selected === n.id ? 'HPAG-map-island-selected' : ''}`}
                      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                      onMouseEnter={() => setHovered(n.id)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => setSelected(selected === n.id ? null : n.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(selected === n.id ? null : n.id); } }}
                    >
                      <div className="HPAG-map-island-head">
                        <span className="HPAG-map-island-id">{n.id}</span>
                        <span className="HPAG-map-island-kind">{kind.name}</span>
                        {n.ms !== undefined && <span className="HPAG-map-island-time">{seconds(n.ms)}</span>}
                      </div>
                      <div className="HPAG-map-island-label">{truncate(n.label, n.op === 'chart' ? 60 : 34)}</div>
                      <IslandBody node={n} apiBaseUrl={apiBaseUrl} workspaceUuid={ws} onArtifactEnter={onArtifactEnter} onArtifactLeave={onArtifactLeave} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className={`HPAG-todo ${planOpen ? '' : 'HPAG-todo-collapsed'}`}>
          <button type="button" className="HPAG-todo-head" onClick={() => setPlanOpen(o => !o)} aria-expanded={planOpen}>
            Plan{state.nodes.length ? ` · ${counts.done}/${state.nodes.length}` : ''}<span className="HPAG-todo-toggle">{planOpen ? '−' : '+'}</span>
          </button>
          {planOpen && state.understanding && <div className="HPAG-todo-understanding">{state.understanding}</div>}
          {planOpen && state.nodes.length === 0 && <div className="HPAG-todo-empty">{state.phase === 'planning' ? 'Planning…' : 'No plan yet.'}</div>}
          {planOpen && <ol className="HPAG-todo-list">
            {state.nodes.map((n, i) => {
              const review = n.round ? reviewFor(n.round) : null;
              const firstOfRound = Boolean(n.round) && (i === 0 || state.nodes[i - 1].round !== n.round);
              return (
                <React.Fragment key={n.id}>
                  {firstOfRound && review ? <li className="HPAG-todo-review"><b>Review {n.round}</b> {truncate(review.assessment, 220)}</li> : null}
                  <li className={`HPAG-todo-item HPAG-todo-item-${n.status} ${selected === n.id ? 'HPAG-todo-item-selected' : ''}`} onClick={() => setSelected(selected === n.id ? null : n.id)}>
                    <TodoIcon status={n.status} />
                    <span className="HPAG-todo-id">{n.id}</span>
                    <span className="HPAG-todo-text">{n.label}</span>
                    <span className="HPAG-todo-kind">{kindOf(n).name}</span>
                  </li>
                </React.Fragment>
              );
            })}
            {state.reflections.filter(r => r.done && !r.added.length).map(r => <li key={`r${r.round}`} className="HPAG-todo-review"><b>Review {r.round}</b> {truncate(r.assessment, 220)}</li>)}
            {state.cannot.map((c, i) => <li key={`c${i}`} className="HPAG-todo-item HPAG-todo-item-cannot"><FontAwesomeIcon icon={faMinus} className="HPAG-todo-icon HPAG-todo-icon-blocked" /><span className="HPAG-todo-text">{c.requirement}</span><span className="HPAG-todo-kind">not expressible</span></li>)}
          </ol>}
          {planOpen && state.planErrors.length > 0 && <div className="HPAG-todo-note">The first plan was corrected: {state.planErrors.slice(0, 2).join('; ')}</div>}
        </div>
      </div>

      {selectedNode && <NodeDetail node={selectedNode} steps={state.agentSteps.get(selectedNode.id)} />}

      {state.report && (
        <div className="HPAG-study-report">
          <div className="HPAG-study-report-title">{state.report.title}</div>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportBody(state.report.md)}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
