import React, { useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChartBar, faDatabase, faFlagCheckered, faGear, faListCheck, faMagnifyingGlass, faMicroscope, faNoteSticky, faQuestion, faRobot, faExternalLinkAlt } from '@fortawesome/free-solid-svg-icons';
import './StudyRun.css';

// A study run (aso_hpa) as a live map, top to bottom. The query sits at the top. An agent (deep
// research for a set of genes, the Investigator for rows) or an operation appears the moment the
// study calls it, named with the title the study gave it, and pulses until it returns; its data
// or figure island appears under it, linked to what it read, carrying the title and description
// the study wrote for it. Plan, note and finish get islands of their own. Hovering an island opens
// its details beside it, live while it runs. The plan sits top right and its items tick off as
// the report delivers them. Live SSE steps and stored run events share one shape (stage + JSON
// message), so the same reducer draws a run in progress and a run reloaded from history.

const AGENT_NAMES = { deep_research_hpa: 'Deep research', investigator_hpa: 'Investigator', check_inclusion_hpa: 'Inclusion check', dictionary_expert_hpa: 'Dictionary' };
const ICONS = { query: faQuestion, agent: faRobot, deep_research_hpa: faMagnifyingGlass, investigator_hpa: faMicroscope, data: faDatabase, tool: faGear, figure: faChartBar, plan: faListCheck, note: faNoteSticky, finish: faFlagCheckered };
const CELL_W = 124;
const ROW_H = 112;
const ICON = 46;
const PAD_X = 24;
const PAD_Y = 18;

function parse(message) {
  if (!message || typeof message !== 'string') return null;
  const t = message.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function stageOf(event) {
  return String(event?.stage || '').toLowerCase();
}

// The study's state after every event so far: islands in order of appearance, with their links.
export function studyStateFromEvents(events) {
  const state = { phase: 'starting', goal: '', workspaceUuid: null, mode: null, hpaVersion: null, model: null, plan: [], islands: [], byKey: new Map(), turns: [], trails: new Map(), finish: null, error: null, complete: false, failed: false, artifactsById: new Map() };
  const add = island => { island.order = state.islands.length; state.islands.push(island); state.byKey.set(island.key, island); return island; };
  add({ key: 'query', type: 'query', label: 'Query', inputs: [], status: 'done' });
  for (const event of events || []) {
    if (event?.status === 'completed') { state.complete = true; if (event.failed) { state.failed = true; state.error = state.error || event.message; } continue; }
    if (event?.status === 'started') continue;
    const stage = stageOf(event);
    const d = parse(event.message) || {};
    if (stage === 'start') { state.workspaceUuid = d.workspace_uuid || state.workspaceUuid; state.mode = d.mode || null; state.hpaVersion = d.hpa_version || null; state.model = d.model || null; state.goal = d.goal || state.goal; state.phase = 'running'; }
    else if (stage === 'turn') state.turns.push({ turn: d.turn, text: d.text || '', calls: d.calls || [] });
    else if (stage === 'plan') {
      state.plan = Array.isArray(d.items) ? d.items : state.plan;
      // The first plan is an island; later plan events (a rewrite, the statuses at finish) update it.
      const existing = state.islands.find(i => i.type === 'plan');
      if (existing) existing.items = state.plan.map(p => ({ ...p }));
      else add({ key: 'plan', type: 'plan', label: 'Plan', inputs: ['query'], status: 'done', items: state.plan.map(p => ({ ...p })) });
    }
    else if (stage === 'note') add({ key: `note${state.islands.length}`, type: 'note', label: 'Note', inputs: ['query'], status: 'done', text: d.text || '' });
    else if (stage === 'skip') state.turns.push({ turn: null, skip: d.reason || '' });
    else if (stage === 'finish.refused') state.turns.push({ turn: null, refused: Array.isArray(d.issues) ? d.issues : [d.reason || 'refused'] });
    else if (stage === 'call.failed') state.turns.push({ turn: null, failed: `${d.tool}: ${d.error || ''}` });
    else if (stage === 'tool.start') {
      const type = d.kind === 'agent' ? 'agent' : 'tool';
      add({ key: d.id, type, tool: d.tool, label: type === 'agent' ? (AGENT_NAMES[d.tool] || d.tool) : d.tool, title: d.label || '', args: d.args || {}, inputs: (d.inputs || []).length ? d.inputs : ['query'], status: 'running', startedAt: event.createdAt || null });
    } else if (stage === 'tool.done') {
      const t = state.byKey.get(d.id);
      if (t) { t.status = 'done'; t.ms = d.ms; t.output = d.artifact?.id || null; }
      const a = d.artifact;
      if (a) {
        const island = add({ key: a.id, type: a.kind === 'figure' ? 'figure' : 'data', kind: a.kind, label: a.label, title: a.title || a.label || '', description: a.description || '', size: a.size, inputs: [d.id], status: 'done', rows: a.rows, columns: a.columns || [], sample: a.sample || [], sampleColumns: a.sample_columns || [], text: a.text || null, images: a.images || [], searchUrl: a.search_url || null, query: a.query || null, artifactUuid: a.artifact_uuid, from: t ? { tool: t.tool, args: t.args, inputs: t.inputs } : null });
        state.artifactsById.set(a.id, island);
      }
    } else if (stage === 'tool.failed') {
      const t = state.byKey.get(d.id);
      if (t) { t.status = 'failed'; t.error = d.error; t.ms = d.ms; }
    } else if (stage.startsWith('agent.')) {
      if (d.id) { if (!state.trails.has(d.id)) state.trails.set(d.id, []); state.trails.get(d.id).push({ stage: stage.slice(6), label: d.label || '', message: d.message || '' }); }
    } else if (stage === 'finish') {
      state.finish = d;
      const incomplete = d.outcome === 'incomplete' || d.budget_exhausted === true || d.unverified_numbers?.length > 0;
      add({ key: 'finish', type: 'finish', label: incomplete ? 'Incomplete' : 'Finish', inputs: ['query'], status: 'done', summary: d.summary || '' });
      state.phase = incomplete ? 'incomplete' : 'done';
    } else if (stage === 'error') { state.error = d.message || event.message || 'The study failed.'; state.failed = true; state.phase = 'failed'; }
  }
  if (state.complete && state.phase !== 'failed') {
    if (state.failed) state.phase = 'failed';
    else if (state.phase !== 'incomplete') state.phase = 'done';
  }
  return state;
}

// One line for the run bar while the study runs.
export function studyStatusLine(events) {
  const s = studyStateFromEvents(events);
  const running = s.islands.filter(i => i.status === 'running');
  const artifacts = s.islands.filter(i => i.type === 'data' || i.type === 'figure').length;
  if (s.phase === 'failed') return 'Study failed';
  if (s.phase === 'incomplete') return 'Study incomplete';
  if (s.phase === 'done') return 'Study complete';
  if (running.length) return `${running.map(i => i.label.toLowerCase()).slice(0, 3).join(', ')}${running.length > 3 ? ` +${running.length - 3}` : ''} running · ${artifacts} artifacts`;
  if (s.turns.length) return `turn ${s.turns.length} · ${artifacts} artifacts`;
  return 'Starting the study';
}

// Rows by depth from the query; islands read their inputs, so everything flows downward.
function layoutIslands(state, width) {
  const depth = new Map();
  for (const i of state.islands) {
    const parents = (i.inputs || []).filter(p => depth.has(p));
    depth.set(i.key, i.key === 'query' ? 0 : parents.length ? Math.max(...parents.map(p => depth.get(p))) + 1 : 1);
  }
  // Finish closes the map: it sits under everything.
  if (depth.has('finish')) depth.set('finish', Math.max(...depth.values()) + 1);
  const rows = new Map();
  for (const i of state.islands) { const d = depth.get(i.key); if (!rows.has(d)) rows.set(d, []); rows.get(d).push(i); }
  const rowCount = Math.max(0, ...rows.keys()) + 1;
  const maxCols = Math.max(1, ...[...rows.values()].map(r => r.length));
  const mapWidth = Math.max(width, PAD_X * 2 + maxCols * CELL_W);
  const positions = new Map();
  for (const [d, list] of rows) {
    const rowWidth = list.length * CELL_W;
    const start = (mapWidth - rowWidth) / 2;
    list.forEach((i, c) => positions.set(i.key, { x: start + c * CELL_W + CELL_W / 2, y: PAD_Y + d * ROW_H + ICON / 2 }));
  }
  return { positions, width: mapWidth, height: PAD_Y * 2 + rowCount * ROW_H };
}

function edgePath(from, to) {
  const x1 = from.x, y1 = from.y + ICON / 2 + 14, x2 = to.x, y2 = to.y - ICON / 2 - 2;
  const bend = Math.max(16, (y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function seconds(ms) {
  return ms === undefined || ms === null ? '' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function iconFor(island) {
  if (island.type === 'agent') return ICONS[island.tool] || ICONS.agent;
  return ICONS[island.type] || ICONS.tool;
}

// The arguments of a call, without the title and description shown above them.
function argLines(args) {
  return Object.entries(args || {}).filter(([k, v]) => k !== 'title' && k !== 'description' && v !== undefined && v !== null && v !== '').map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
}

// The plan item kinds, in the words the study uses.
const KIND_LABELS = { gene_set: 'set of genes', table: 'table', interpretation: 'interpretation' };
function kindLabel(kind) { return KIND_LABELS[kind] || `${String(kind || '').replace(/_/g, ' ')} chart`; }

function Panel({ island, state }) {
  const trail = state.trails.get(island.key) || [];
  const out = island.output ? state.artifactsById.get(island.output) : null;
  return (
    <div className="HPAG-map-panel-body">
      <div className="HPAG-map-panel-head">
        <span className={`HPAG-map-pill HPAG-map-pill-${island.status}`}>{island.type === 'query' ? 'query' : island.status}</span>
        <span className="HPAG-map-panel-key">{island.key}</span>
        <span className="HPAG-map-panel-title">{island.type === 'agent' || island.type === 'tool' ? island.label : island.type === 'data' ? (island.size || 'data') : island.type === 'figure' ? 'figure' : island.label}</span>
        {island.ms !== undefined && <span className="HPAG-map-panel-meta">{seconds(island.ms)}</span>}
      </div>
      {island.type === 'query' && (
        <>
          <div className="HPAG-map-panel-text">{state.goal}</div>
          {state.turns.length > 0 && (
            <div className="HPAG-map-steps">
              {state.turns.slice(-10).map((t, i) => (
                <div key={i} className={`HPAG-map-step ${t.refused || t.failed ? 'HPAG-map-step-refused' : ''}`}>
                  <span className="HPAG-map-step-label">{t.turn ? `turn ${t.turn}` : t.refused ? 'report refused' : t.failed ? 'call failed' : 'wait'}</span>
                  <span className="HPAG-map-step-text">{t.refused ? truncate(t.refused.join(' · '), 260) : t.failed ? truncate(t.failed, 200) : t.skip !== undefined ? `skip: ${t.skip}` : t.calls.length ? t.calls.map(c => c.tool).join(', ') : truncate(t.text, 160)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {(island.type === 'agent' || island.type === 'tool') && (
        <>
          {island.title && <div className="HPAG-map-panel-name">{island.title}</div>}
          {island.args?.description && <div className="HPAG-map-panel-text">{island.args.description}</div>}
          <dl className="HPAG-map-args">{argLines(island.args).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{truncate(v, 240)}</dd></React.Fragment>)}</dl>
          {island.inputs?.filter(i => i !== 'query').length > 0 && <div className="HPAG-map-panel-meta">reads {island.inputs.filter(i => i !== 'query').join(', ')}</div>}
          {island.error && <div className="HPAG-map-panel-error">{island.error}</div>}
          {trail.length > 0 && (
            <div className="HPAG-map-steps">
              {trail.slice(-12).map((s, i) => (
                <div key={i} className="HPAG-map-step">
                  <span className="HPAG-map-step-label">{s.label || s.stage}</span>
                  <span className="HPAG-map-step-text">{truncate(s.message, 220)}</span>
                </div>
              ))}
            </div>
          )}
          {island.status === 'running' && <div className="HPAG-map-panel-meta">working…</div>}
          {out && <div className="HPAG-map-panel-meta">produced {out.key} ({out.size})</div>}
        </>
      )}
      {(island.type === 'data' || island.type === 'figure') && (
        <>
          <div className="HPAG-map-panel-name">{island.title || island.label}</div>
          {island.description && <div className="HPAG-map-panel-text">{island.description}</div>}
          {island.from && <div className="HPAG-map-panel-meta">from {AGENT_NAMES[island.from.tool] || island.from.tool}{island.from.inputs?.filter(i => i !== 'query').length ? ` of ${island.from.inputs.filter(i => i !== 'query').join(', ')}` : ''}</div>}
          {island.query && <div className="HPAG-map-panel-meta">{island.query}</div>}
          {island.searchUrl && <a className="HPAG-map-link" href={island.searchUrl} target="_blank" rel="noopener noreferrer">open on proteinatlas.org <FontAwesomeIcon icon={faExternalLinkAlt} /></a>}
          {island.text && <div className="HPAG-map-panel-text">{truncate(island.text, 500)}</div>}
          {island.sample?.length > 0 && (
            <div className="HPAG-map-sample">
              <table>
                <thead><tr>{island.sampleColumns.map(c => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{island.sample.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
          {island.columns?.length > 0 && <div className="HPAG-map-panel-meta">columns: {truncate(island.columns.join(', '), 200)}</div>}
          {island.type === 'figure' && island.images?.length > 0 && <div className="HPAG-map-panel-meta">rendered: {island.images.join(', ')}</div>}
        </>
      )}
      {island.type === 'plan' && <ol className="HPAG-map-plan-list">{island.items.map((p, i) => <li key={i} className={`HPAG-map-plan-${p.status}`}>{p.text} <span className="HPAG-map-plan-kind">{kindLabel(p.kind)}</span></li>)}</ol>}
      {island.type === 'note' && <div className="HPAG-map-panel-text">{island.text}</div>}
      {island.type === 'finish' && <div className="HPAG-map-panel-text">{truncate(island.summary, 600)}</div>}
    </div>
  );
}

export default function StudyRun({ events, isComplete }) {
  const state = useMemo(() => studyStateFromEvents(events), [events]);
  const [hovered, setHovered] = useState(null);
  const [pinned, setPinned] = useState(null);
  const [width, setWidth] = useState(800);
  const leaveTimer = useRef(null);
  const measureRef = el => { if (el && el.clientWidth && el.clientWidth !== width) setWidth(el.clientWidth); };
  const layout = useMemo(() => layoutIslands(state, width), [state, width]);
  const focus = pinned || hovered;
  const focusIsland = focus ? state.byKey.get(focus) : null;
  const focusPos = focus ? layout.positions.get(focus) : null;
  const linked = new Set();
  if (focus) { linked.add(focus); for (const i of state.islands) { if (i.inputs?.includes(focus)) linked.add(i.key); if (i.key === focus) for (const p of i.inputs || []) linked.add(p); } }
  const enter = key => { if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; } setHovered(key); };
  const leave = () => { leaveTimer.current = setTimeout(() => setHovered(null), 180); };
  const live = !isComplete && !['done', 'failed', 'incomplete'].includes(state.phase);
  const counts = { artifacts: state.islands.filter(i => i.type === 'data' || i.type === 'figure').length, agents: state.islands.filter(i => i.type === 'agent').length, running: state.islands.filter(i => i.status === 'running').length, failed: state.islands.filter(i => i.status === 'failed').length };
  const panelLeft = focusPos ? (focusPos.x > layout.width * 0.55 ? focusPos.x - ICON / 2 - 12 - 320 : focusPos.x + ICON / 2 + 12) : 0;
  const panelTop = focusPos ? Math.max(6, focusPos.y - 20) : 0;

  return (
    <div className="HPAG-study">
      <div className="HPAG-study-head">
        <span className={`HPAG-study-phase HPAG-study-phase-${state.phase}`}>{live ? 'Running' : state.phase === 'failed' ? 'Failed' : state.phase === 'incomplete' ? 'Incomplete' : 'Complete'}</span>
        <span className="HPAG-study-counts">{state.turns.filter(t => t.turn).length} turns · {counts.agents} agent{counts.agents === 1 ? '' : 's'} · {counts.artifacts} artifacts{counts.running ? ` · ${counts.running} running` : ''}{counts.failed ? ` · ${counts.failed} failed` : ''}</span>
        <span className="HPAG-study-meta">{state.finish?.seconds ? `${Number(state.finish.seconds).toFixed(0)}s · ` : ''}{state.finish?.tokens?.total ? `${Number(state.finish.tokens.total).toLocaleString()} tokens · ` : ''}{state.model || ''}{state.mode ? ` · ${state.mode} data` : ''}</span>
      </div>
      {state.error && <div className="HPAG-study-error">{state.error}</div>}

      <div className="HPAG-map-frame" ref={measureRef}>
        <div className="HPAG-map-scroll" onScroll={() => { if (!pinned) setHovered(null); }}>
          <div className="HPAG-map" style={{ width: layout.width, height: layout.height }}>
            <svg className="HPAG-map-edges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
              {state.islands.map(i => (i.inputs || []).map(p => {
                const from = layout.positions.get(p);
                const to = layout.positions.get(i.key);
                if (!from || !to) return null;
                const hot = focus && (p === focus || i.key === focus);
                return <path key={`${p}>${i.key}`} className={`HPAG-map-edge ${hot ? 'HPAG-map-edge-hot' : ''} ${focus && !hot ? 'HPAG-map-edge-dim' : ''} ${i.type === 'plan' || i.type === 'note' || i.type === 'finish' ? 'HPAG-map-edge-soft' : ''}`} d={edgePath(from, to)} />;
              }))}
            </svg>
            {state.islands.map(i => {
              const p = layout.positions.get(i.key);
              if (!p) return null;
              const dim = focus && !linked.has(i.key);
              const label = i.type === 'query' ? 'query' : i.type === 'data' || i.type === 'figure' ? (i.title || i.size || i.type) : i.type === 'agent' ? i.label : i.type === 'tool' ? i.tool : i.label;
              return (
                <div
                  key={i.key}
                  className={`HPAG-map-island HPAG-map-type-${i.type} HPAG-map-status-${i.status} ${focus === i.key ? 'HPAG-map-focus' : ''} ${dim ? 'HPAG-map-dim' : ''}`}
                  style={{ left: p.x - CELL_W / 2, top: p.y - ICON / 2, width: CELL_W }}
                  onMouseEnter={() => enter(i.key)}
                  onMouseLeave={leave}
                  onClick={() => setPinned(pinned === i.key ? null : i.key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPinned(pinned === i.key ? null : i.key); } }}
                  aria-label={`${i.key} ${label}`}
                >
                  <span className="HPAG-map-icon"><FontAwesomeIcon icon={iconFor(i)} /></span>
                  <span className="HPAG-map-key">{i.key === 'query' ? '' : i.key}</span>
                  <span className="HPAG-map-label">{truncate(label, 36)}</span>
                </div>
              );
            })}
            {focusIsland && focusPos && (
              <div className="HPAG-map-panel" style={{ left: panelLeft, top: panelTop }} onMouseEnter={() => enter(focus)} onMouseLeave={leave}>
                <Panel island={focusIsland} state={state} />
              </div>
            )}
          </div>
        </div>
        {state.plan.length > 0 && (
          <div className="HPAG-map-plan">
            <div className="HPAG-map-plan-head">Plan</div>
            <ol className="HPAG-map-plan-list">
              {state.plan.map((p, i) => <li key={i} className={`HPAG-map-plan-${p.status}`}>{p.text} <span className="HPAG-map-plan-kind">{kindLabel(p.kind)}</span></li>)}
            </ol>
          </div>
        )}
      </div>
      {state.finish?.summary && <div className="HPAG-study-summary"><ReactMarkdown remarkPlugins={[remarkGfm]}>{state.finish.summary}</ReactMarkdown></div>}
    </div>
  );
}
