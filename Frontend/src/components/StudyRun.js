import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faChartBar, faDna, faExternalLinkAlt, faFileAlt, faSpinner, faTable, faTh, faTimes, faQuestion } from '@fortawesome/free-solid-svg-icons';
import AsoChart from './AsoChart';
import './StudyRun.css';

// A study run (aso_hpa) as a live map. It starts with the query. Agent nodes (Deep research,
// Investigator) and tool nodes appear when they start work, and each drops a data island when it
// finishes: a gene set, a table, a matrix, a figure. Islands feed the next tools. Click anything
// for its details. Live SSE steps and stored run events share one shape (stage + JSON message),
// so the same reducer draws a run in progress and a run reloaded from history.

const AGENT = { search: 'Deep research', lookup: 'Investigator' };
const QUERY_W = 200;
const QUERY_H = 92;
const OP_W = 132;
const AGENT_W = 156;
const OP_H = 58;
const ISLAND_W = 176;
const ISLAND_H = 62;
const GAP = 34;
const COL_GAP = 56;
const ROW_GAP = 20;
const PAD = 24;

function parse(message) {
  if (!message || typeof message !== 'string') return null;
  const t = message.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function stageOf(event) {
  return String(event?.stage || '').toLowerCase();
}

// What kind of island a step produces.
function islandType(node) {
  if (node.op === 'search') return 'genes';
  if (node.op === 'chart') return 'figure';
  if (node.op === 'pivot' || node.matrix) return 'matrix';
  return 'table';
}

const ISLAND_META = {
  genes: { name: 'Gene set', icon: faDna },
  table: { name: 'Table', icon: faTable },
  matrix: { name: 'Matrix', icon: faTh },
  figure: { name: 'Figure', icon: faChartBar },
  report: { name: 'Report', icon: faFileAlt }
};

// The study's state after every event so far.
export function studyStateFromEvents(events) {
  const state = {
    phase: 'starting', goal: '', workspaceUuid: null, mode: null, hpaVersion: null, understanding: '', cannot: [],
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
  const appear = node => { if (node && node.appeared === null) node.appeared = state.order++; };
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
    else if (stage === 'plan.start') { state.goal = d.goal || state.goal; state.phase = 'planning'; }
    else if (stage === 'plan.invalid') state.planErrors = d.errors || [];
    else if (stage === 'plan.graph') {
      state.understanding = d.understanding || '';
      state.cannot = Array.isArray(d.cannot) ? d.cannot : [];
      for (const raw of d.nodes || []) upsert(raw, 0);
      state.phase = 'running';
    } else if (stage === 'node.start') {
      const node = upsert({ id: d.node, op: d.op, label: d.label, inputs: d.inputs, args: d.args });
      if (node) { node.status = 'running'; appear(node); }
      state.phase = 'running';
    } else if (stage === 'node.done') {
      const node = upsert({ id: d.node, op: d.op, label: d.label });
      if (node) { appear(node); Object.assign(node, { status: 'done', rows: d.rows, ms: d.ms, columns: d.columns, sample: d.sample, sampleColumns: d.sample_columns, matrix: d.matrix, images: d.images || [], artifactUuid: d.artifact_uuid, searchUrl: d.search_url, query: d.query, asked: d.asked, found: d.found }); }
    } else if (stage === 'node.failed') {
      const node = upsert({ id: d.node, op: d.op, label: d.label });
      if (node) { appear(node); Object.assign(node, { status: 'failed', error: d.error, ms: d.ms }); }
    } else if (stage === 'node.blocked') {
      const node = upsert({ id: d.node });
      if (node) Object.assign(node, { status: 'blocked', error: d.input ? `waiting on ${d.input}, which failed` : 'an input never completed' });
    } else if (stage === 'node.repair') {
      const node = upsert({ id: d.node });
      if (node) { node.repaired = { missing: d.missing || [], before: d.args_before, after: d.args_after }; if (d.args_after) node.args = d.args_after; }
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

// One line for the run bar while the study runs.
export function studyStatusLine(events) {
  const s = studyStateFromEvents(events);
  const running = s.nodes.filter(n => n.status === 'running');
  const done = s.nodes.filter(n => n.status === 'done').length;
  if (s.phase === 'planning') return 'Planning the study';
  if (s.phase === 'reviewing') return `Reviewing results · ${done}/${s.nodes.length} steps done`;
  if (s.phase === 'reporting') return 'Writing the report';
  if (s.phase === 'running') return running.length ? `${running.map(n => `${n.id} ${(AGENT[n.op] || n.op).toLowerCase()}`).slice(0, 3).join(', ')}${running.length > 3 ? ` +${running.length - 3}` : ''} · ${done}/${s.nodes.length} done` : `${done}/${s.nodes.length} steps done`;
  if (s.phase === 'failed') return 'Study failed';
  return 'Study complete';
}

// Map nodes: the query, then for every started step its agent or tool node and, when it has
// finished, its island. Each step sits one column right of the islands it reads; the query is
// the root of the steps that read nothing. Columns are centred so the map grows from the middle.
function layoutMap(state) {
  const started = state.nodes.filter(n => n.appeared !== null).sort((a, b) => a.appeared - b.appeared);
  const depth = new Map();
  for (const n of started) {
    const parents = (n.inputs || []).filter(i => depth.has(i));
    depth.set(n.id, parents.length ? Math.max(...parents.map(p => depth.get(p))) + 1 : 0);
  }
  const columns = new Map();
  for (const n of started) { const d = depth.get(n.id); if (!columns.has(d)) columns.set(d, []); columns.get(d).push(n); }
  const layers = Math.max(-1, ...columns.keys()) + 1;
  const colStride = OP_W + GAP + ISLAND_W + COL_GAP;
  const rowH = Math.max(OP_H, ISLAND_H);
  const maxRows = Math.max(1, ...[...columns.values()].map(c => c.length));
  const height = PAD * 2 + Math.max(QUERY_H, maxRows * rowH + (maxRows - 1) * ROW_GAP);
  const boxes = new Map();
  const mid = height / 2;
  boxes.set('query', { x: PAD, y: mid - QUERY_H / 2, w: QUERY_W, h: QUERY_H, type: 'query' });
  for (let d = 0; d < layers; d++) {
    const list = columns.get(d) || [];
    const colH = list.length * rowH + (list.length - 1) * ROW_GAP;
    let y = mid - colH / 2;
    const x = PAD + QUERY_W + COL_GAP + d * colStride;
    for (const n of list) {
      const isAgent = Boolean(AGENT[n.op]);
      const opW = isAgent ? AGENT_W : OP_W;
      boxes.set(`${n.id}:op`, { x, y: y + (rowH - OP_H) / 2, w: opW, h: OP_H, type: isAgent ? 'agent' : 'tool', node: n });
      if (n.status === 'done') boxes.set(`${n.id}:out`, { x: x + opW + GAP, y: y + (rowH - ISLAND_H) / 2, w: ISLAND_W, h: ISLAND_H, type: 'island', node: n });
      y += rowH + ROW_GAP;
    }
  }
  const edges = [];
  for (const n of started) {
    const parents = (n.inputs || []).filter(i => boxes.has(`${i}:out`));
    if (!parents.length) edges.push(['query', `${n.id}:op`]);
    for (const p of parents) edges.push([`${p}:out`, `${n.id}:op`]);
    if (boxes.has(`${n.id}:out`)) edges.push([`${n.id}:op`, `${n.id}:out`]);
  }
  const width = layers ? PAD + QUERY_W + COL_GAP + (layers - 1) * colStride + AGENT_W + GAP + ISLAND_W + PAD : PAD * 2 + QUERY_W;
  return { boxes, edges, width, height, started: started.length };
}

function edgePath(from, to) {
  const x1 = from.x + from.w, y1 = from.y + from.h / 2, x2 = to.x, y2 = to.y + to.h / 2;
  const bend = Math.max(18, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function seconds(ms) {
  return ms === undefined || ms === null ? '' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function islandStat(node) {
  if (node.op === 'search') return `${node.rows} genes`;
  if (node.op === 'chart') return 'figure';
  if (node.matrix) return `${node.matrix[0]} × ${node.matrix[1]}`;
  if (node.asked !== undefined) return `${node.found} of ${node.asked} answered`;
  return node.rows === undefined ? '' : `${node.rows} rows`;
}

// The report body without the title, goal, workspace line, figure links and the node table, which
// the map already shows.
function reportBody(md) {
  const cut = md.indexOf('\n## Figures');
  const body = (cut === -1 ? md : md.slice(0, cut)).split('\n').filter(line => !/^# /.test(line) && !/^\*\*(Goal|Workspace):\*\*/.test(line));
  return body.join('\n').trim();
}

function Detail({ box, state, apiBaseUrl, workspaceUuid, onArtifactEnter, onArtifactLeave }) {
  if (box.type === 'query') {
    return (
      <div className="HPAG-study-detail">
        <div className="HPAG-study-detail-head"><span className="HPAG-study-pill">query</span><span className="HPAG-study-detail-label">The goal</span></div>
        <div className="HPAG-study-detail-why">{state.goal}</div>
        {state.understanding && <div className="HPAG-study-detail-line"><span><b>Read as:</b> {state.understanding}</span></div>}
        {state.cannot.length > 0 && <div className="HPAG-study-detail-line"><span><b>Not expressible in this database:</b> {state.cannot.map(c => c.requirement).join('; ')}</span></div>}
      </div>
    );
  }
  const node = box.node;
  const steps = state.agentSteps.get(node.id);
  const argEntries = Object.entries(node.args || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const isIsland = box.type === 'island';
  const kindName = isIsland ? ISLAND_META[islandType(node)].name : (AGENT[node.op] || node.op);
  return (
    <div className="HPAG-study-detail">
      <div className="HPAG-study-detail-head">
        <span className={`HPAG-study-pill HPAG-study-pill-${node.status}`}>{node.status}</span>
        <span className="HPAG-study-detail-id">{node.id}</span>
        <span className="HPAG-study-detail-op">{kindName}</span>
        <span className="HPAG-study-detail-label">{node.label}</span>
        {node.ms !== undefined && <span className="HPAG-study-detail-meta">{seconds(node.ms)}</span>}
        {node.rows !== undefined && <span className="HPAG-study-detail-meta">{node.rows} rows</span>}
        {node.matrix && <span className="HPAG-study-detail-meta">{node.matrix[0]} × {node.matrix[1]} matrix</span>}
        {node.inputs?.length > 0 && <span className="HPAG-study-detail-meta">reads {node.inputs.join(', ')}</span>}
        {node.round ? <span className="HPAG-study-detail-meta">added in review {node.round}</span> : null}
      </div>
      {node.why && <div className="HPAG-study-detail-why">{node.why}</div>}
      {node.error && <div className="HPAG-study-detail-error">{node.error}</div>}
      {node.repaired && <div className="HPAG-study-detail-line"><span>Arguments repaired before running: {node.repaired.missing.join(', ')} did not exist in the input.</span></div>}
      {isIsland && node.op === 'chart' && workspaceUuid && node.artifactUuid && (
        <div className="HPAG-study-figure"><AsoChart apiBaseUrl={apiBaseUrl} workspaceUuid={workspaceUuid} artifactId={node.artifactUuid} title={node.args?.title || node.label} onArtifactEnter={onArtifactEnter} onArtifactLeave={onArtifactLeave} /></div>
      )}
      {!isIsland && argEntries.length > 0 && (
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
      {isIsland && node.sample?.length > 0 && (
        <div className="HPAG-study-sample">
          <table>
            <thead><tr>{(node.sampleColumns || []).map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{node.sample.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
          </table>
          {node.columns?.length > (node.sampleColumns || []).length && <div className="HPAG-study-sample-more">columns: {node.columns.join(', ')}</div>}
        </div>
      )}
      {!isIsland && steps?.length > 0 && (
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
  const layout = useMemo(() => layoutMap(state), [state]);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const ws = workspaceUuid || state.workspaceUuid;
  const focus = hovered || selected;
  const linked = new Set();
  if (focus) { linked.add(focus); for (const [a, b] of layout.edges) { if (a === focus) linked.add(b); if (b === focus) linked.add(a); } }

  const counts = { done: 0, failed: 0, running: 0 };
  for (const n of state.nodes) { if (n.status === 'done') counts.done++; else if (n.status === 'failed' || n.status === 'blocked') counts.failed++; else if (n.status === 'running') counts.running++; }
  const live = !isComplete && state.phase !== 'done' && state.phase !== 'failed';
  const phaseText = { starting: 'Starting', planning: 'Planning', running: 'Running', reviewing: 'Reviewing results', reporting: 'Writing the report', done: 'Complete', failed: 'Failed' }[state.phase] || state.phase;
  const selectedBox = selected ? layout.boxes.get(selected) : null;
  const elapsed = state.final?.seconds !== undefined ? `${Number(state.final.seconds).toFixed(1)}s` : null;
  const figures = state.nodes.filter(n => n.op === 'chart' && n.status === 'done' && n.artifactUuid);
  const toggle = key => setSelected(selected === key ? null : key);

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

      <div className="HPAG-map-scroll">
        <div className="HPAG-map" style={{ width: layout.width, height: layout.height }}>
          <svg className="HPAG-map-edges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
            <defs>
              <marker id="HPAG-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
              </marker>
            </defs>
            {layout.edges.map(([a, b]) => {
              const from = layout.boxes.get(a);
              const to = layout.boxes.get(b);
              if (!from || !to) return null;
              const hot = focus && (a === focus || b === focus);
              return <path key={`${a}>${b}`} className={`HPAG-map-edge ${hot ? 'HPAG-map-edge-hot' : ''} ${focus && !hot ? 'HPAG-map-edge-dim' : ''}`} d={edgePath(from, to)} markerEnd="url(#HPAG-map-arrow)" />;
            })}
          </svg>

          {[...layout.boxes.entries()].map(([key, box]) => {
            const dim = focus && !linked.has(key);
            const common = {
              key,
              style: { left: box.x, top: box.y, width: box.w, height: box.h },
              onMouseEnter: () => setHovered(key),
              onMouseLeave: () => setHovered(null),
              onClick: () => toggle(key),
              role: 'button',
              tabIndex: 0,
              onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key); } }
            };
            if (box.type === 'query') {
              return (
                <div {...common} className={`HPAG-map-node HPAG-map-query ${selected === key ? 'HPAG-map-selected' : ''} ${dim ? 'HPAG-map-dim' : ''}`}>
                  <div className="HPAG-map-node-kind"><FontAwesomeIcon icon={faQuestion} /> Query</div>
                  <div className="HPAG-map-query-text">{truncate(state.goal || 'the goal', 120)}</div>
                </div>
              );
            }
            const n = box.node;
            if (box.type === 'island') {
              const type = islandType(n);
              const meta = ISLAND_META[type];
              return (
                <div {...common} className={`HPAG-map-node HPAG-map-island HPAG-map-island-${type} ${selected === key ? 'HPAG-map-selected' : ''} ${dim ? 'HPAG-map-dim' : ''}`}>
                  <div className="HPAG-map-node-kind"><FontAwesomeIcon icon={meta.icon} /> {meta.name}<span className="HPAG-map-node-id">{n.id}</span></div>
                  <div className="HPAG-map-node-label">{truncate(n.label, 26)}</div>
                  <div className="HPAG-map-node-stat">{islandStat(n)}</div>
                </div>
              );
            }
            const agent = AGENT[n.op];
            return (
              <div {...common} className={`HPAG-map-node ${agent ? 'HPAG-map-agent' : 'HPAG-map-tool'} HPAG-map-status-${n.status} ${selected === key ? 'HPAG-map-selected' : ''} ${dim ? 'HPAG-map-dim' : ''}`}>
                <div className="HPAG-map-node-kind">
                  {n.status === 'running' ? <FontAwesomeIcon icon={faSpinner} spin /> : n.status === 'done' ? <FontAwesomeIcon icon={faCheck} /> : <FontAwesomeIcon icon={faTimes} />}
                  {' '}{agent || n.op}<span className="HPAG-map-node-id">{n.id}</span>
                </div>
                <div className="HPAG-map-node-label">{truncate(agent ? n.label : n.label, agent ? 24 : 20)}</div>
                <div className="HPAG-map-node-stat">{n.status === 'running' ? 'working…' : n.status === 'done' ? seconds(n.ms) : truncate(n.error, 28)}</div>
              </div>
            );
          })}
        </div>
      </div>
      {!selectedBox && <div className="HPAG-study-hint">{layout.started ? 'Click a node or an island for its details.' : state.phase === 'planning' ? 'Agents appear here as they start.' : ''}</div>}
      {selectedBox && <Detail box={selectedBox} state={state} apiBaseUrl={apiBaseUrl} workspaceUuid={ws} onArtifactEnter={onArtifactEnter} onArtifactLeave={onArtifactLeave} />}

      {state.reflections.map(r => (
        <div key={r.round} className="HPAG-study-review">
          <span className="HPAG-study-review-label">Review {r.round}{r.done ? ' · done' : r.added.length ? ` · added ${r.added.map(a => a.id).join(', ')}` : ''}</span>
          <span className="HPAG-study-review-text">{r.assessment}</span>
        </div>
      ))}

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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportBody(state.report.md)}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
