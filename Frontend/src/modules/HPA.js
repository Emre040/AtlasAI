import React, { useState, useEffect, useRef, useMemo } from 'react';
import './HPA.css';
import ReactMarkdown from 'react-markdown';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCopy,
  faThumbsUp,
  faThumbsDown,
  faDna,
  faMicroscope,
  faVirus,
  faNetworkWired,
  faDroplet,
  faFlask,
  faCubes,
  faBrain,
  faFileCode,
  faChevronDown,
  faChevronRight,
  faSpinner,
  faReply,
  faTimes,
  faExternalLinkAlt,
  faSearch,
  faTag,
  faChartBar,
  faHashtag,
  faCheckCircle,
  faList,
  faDownload
} from '@fortawesome/free-solid-svg-icons';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import {
  authenticatedDownload,
  authenticatedFetch,
  getVisitorId,
  initializeHPAAuth
} from './hpaAuth';
import { getApiBaseUrl, getApiEndpoint, getRuntimeConfig, getUiConfig } from './hpaConfig';
import { liveToolEventFromSse, timelineToUiMessages } from './hpaTimeline';
import DictionaryCarousel from './DictionaryCarousel';

const RUNTIME_CONFIG = getRuntimeConfig();
const UI_CONFIG = getUiConfig();
const debugLog = (...args) => {
  if (RUNTIME_CONFIG.isLocal) console.log(...args);
};

const Plot = createPlotlyComponent(Plotly);

const PLOTLY_COLORS = ['#636efa','#ef553b','#00cc96','#ab63fa','#ffa15a','#19d3f3','#ff6692','#b6e880','#ff97ff','#fecb52'];

function specToPlotly(chart) {
  const t = chart.type;
  const data = [];
  const layout = {
    title: chart.title || '',
    xaxis: { title: { text: chart.x_label || '', standoff: 10 } },
    yaxis: { title: { text: chart.y_label || '', standoff: 10 } },
    margin: { t: 20, r: 20, b: 60, l: 70 },
    font: { size: 11 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    showlegend: false,
    autosize: true
  };

  if (t === 'bar') {
    data.push({ type: 'bar', x: chart.data.map(d => d.label), y: chart.data.map(d => d.value), marker: { color: PLOTLY_COLORS[0] } });
  } else if (t === 'lollipop') {
    const labels = chart.data.map(d => d.label);
    const values = chart.data.map(d => d.value);
    for (let li = 0; li < labels.length; li++) {
      data.push({ type: 'scatter', mode: 'lines', x: [labels[li], labels[li]], y: [0, values[li]], line: { color: PLOTLY_COLORS[0], width: 2 }, showlegend: false, hoverinfo: 'skip' });
    }
    data.push({ type: 'scatter', mode: 'markers', x: labels, y: values, marker: { color: PLOTLY_COLORS[0], size: 10 }, showlegend: false });
  } else if (t === 'diverging_bar') {
    data.push({ type: 'bar', y: chart.data.map(d => d.label), x: chart.data.map(d => d.value), orientation: 'h',
      marker: { color: chart.data.map(d => d.value >= 0 ? PLOTLY_COLORS[2] : PLOTLY_COLORS[1]) } });
    layout.xaxis.zeroline = true;
  } else if (t === 'dot_plot') {
    data.push({ type: 'scatter', mode: 'markers', y: chart.data.map(d => d.label), x: chart.data.map(d => d.value),
      marker: { color: PLOTLY_COLORS[0], size: 9 } });
  } else if (t === 'waterfall') {
    data.push({ type: 'waterfall', x: chart.data.map(d => d.label), y: chart.data.map(d => d.value),
      connector: { line: { color: '#94a3b8' } },
      increasing: { marker: { color: PLOTLY_COLORS[2] } },
      decreasing: { marker: { color: PLOTLY_COLORS[1] } } });
  } else if (t === 'scatter') {
    const series = {};
    for (const d of chart.data) { const s = d.series || '_'; if (!series[s]) series[s] = { x: [], y: [], text: [] }; series[s].x.push(d.x); series[s].y.push(d.y); series[s].text.push(d.label || ''); }
    const keys = Object.keys(series);
    keys.forEach((s, i) => data.push({ type: 'scatter', mode: 'markers', x: series[s].x, y: series[s].y, text: series[s].text, name: s === '_' ? '' : s, marker: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
    if (keys.length > 1) layout.showlegend = true;
  } else if (t === 'bubble') {
    const maxSize = Math.max(...chart.data.map(d => d.size || 1));
    data.push({ type: 'scatter', mode: 'markers', x: chart.data.map(d => d.x), y: chart.data.map(d => d.y), text: chart.data.map(d => d.label || ''),
      marker: { size: chart.data.map(d => Math.max(4, (d.size / maxSize) * 50)), color: chart.data.map(d => d.color ?? d.size), colorscale: 'Viridis', showscale: !!chart.color_label, colorbar: { title: chart.color_label || '' } } });
  } else if (t === 'volcano') {
    const fc = chart.fc_threshold || 1.0;
    const sig = chart.sig_threshold || 1.3;
    const colors = chart.data.map(d => Math.abs(d.x) >= fc && d.y >= sig ? (d.x > 0 ? PLOTLY_COLORS[1] : PLOTLY_COLORS[2]) : '#94a3b8');
    data.push({ type: 'scatter', mode: 'markers', x: chart.data.map(d => d.x), y: chart.data.map(d => d.y), text: chart.data.map(d => d.label || ''),
      marker: { color: colors, size: 5 } });
    layout.shapes = [
      { type: 'line', x0: -fc, x1: -fc, y0: 0, y1: 1, yref: 'paper', line: { dash: 'dash', color: '#94a3b8' } },
      { type: 'line', x0: fc, x1: fc, y0: 0, y1: 1, yref: 'paper', line: { dash: 'dash', color: '#94a3b8' } },
      { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: sig, y1: sig, line: { dash: 'dash', color: '#94a3b8' } }
    ];
  } else if (t === 'line') {
    const series = {};
    for (const d of chart.data) { const s = d.series || '_'; if (!series[s]) series[s] = { x: [], y: [] }; series[s].x.push(d.x); series[s].y.push(d.y); }
    const keys = Object.keys(series);
    keys.forEach((s, i) => data.push({ type: 'scatter', mode: 'lines+markers', x: series[s].x, y: series[s].y, name: s === '_' ? '' : s, line: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
    if (keys.length > 1) layout.showlegend = true;
  } else if (t === 'grouped_bar') {
    const groups = {};
    for (const d of chart.data) { if (!groups[d.group]) groups[d.group] = { labels: [], values: [] }; groups[d.group].labels.push(d.label); groups[d.group].values.push(d.value); }
    Object.entries(groups).forEach(([g, v], i) => data.push({ type: 'bar', x: v.labels, y: v.values, name: g, marker: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
    layout.barmode = 'group'; layout.showlegend = true;
  } else if (t === 'stacked_bar') {
    const stacks = {};
    for (const d of chart.data) { if (!stacks[d.stack]) stacks[d.stack] = { labels: [], values: [] }; stacks[d.stack].labels.push(d.label); stacks[d.stack].values.push(d.value); }
    Object.entries(stacks).forEach(([s, v], i) => data.push({ type: 'bar', x: v.labels, y: v.values, name: s, marker: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
    layout.barmode = 'stack'; layout.showlegend = true;
  } else if (t === 'heatmap') {
    data.push({ type: 'heatmap', z: chart.matrix, x: chart.col_labels, y: chart.row_labels, colorscale: 'YlOrRd', reversescale: true });
    layout.yaxis.autorange = 'reversed';
    layout.margin.l = 100;
  } else if (t === 'radar') {
    for (let i = 0; i < chart.series.length; i++) {
      const s = chart.series[i];
      data.push({ type: 'scatterpolar', r: [...s.values, s.values[0]], theta: [...chart.axes, chart.axes[0]], fill: 'toself', name: s.label, line: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } });
    }
    layout.showlegend = chart.series.length > 1;
    delete layout.xaxis; delete layout.yaxis;
    layout.polar = { radialaxis: { visible: true } };
  } else if (t === 'box') {
    chart.series.forEach((s, i) => data.push({ type: 'box', y: s.values, name: s.label, marker: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
  } else if (t === 'ridge') {
    chart.series.forEach((s, i) => data.push({ type: 'violin', y: s.values, name: s.label, box: { visible: true }, meanline: { visible: true }, line: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
  } else {
    // Fallback: try bar if data has label+value
    if (chart.data?.length) {
      data.push({ type: 'bar', x: chart.data.map(d => d.label || ''), y: chart.data.map(d => d.value || 0) });
    }
  }
  return { data, layout };
}

function AsoChart({ apiBaseUrl, workspaceUuid, artifactId, title, sourceDatasetId, onArtifactEnter, onArtifactLeave }) {
  const [spec, setSpec] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!workspaceUuid || !artifactId) return;
    let cancelled = false;
    authenticatedFetch(`${apiBaseUrl}/workspaces/${workspaceUuid}/artifacts/${artifactId}.json`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(json => { if (!cancelled) setSpec(json); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [apiBaseUrl, workspaceUuid, artifactId]);

  if (error) return <div className="HPAG-aso-chart-error">Chart failed to load</div>;
  if (!spec) return <div className="HPAG-aso-chart-loading"><FontAwesomeIcon icon={faSpinner} spin /> Loading chart...</div>;

  const chart = spec.charts?.[0];
  if (!chart) return null;
  const { data, layout } = specToPlotly(chart);
  const chartTitle = title || chart.title || '';
  return (
    <div className="HPAG-aso-chart-item" style={{ position: 'relative' }}>
      <Plot data={data} layout={{ ...layout, title: '' }} useResizeHandler style={{ width: '100%', height: 380 }}
        config={{ displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d','select2d'], responsive: true }} />
      {sourceDatasetId && (
        <span className="HPAG-aso-data-chip HPAG-aso-data-chip-artifact HPAG-aso-chart-source"
          onMouseEnter={e => onArtifactEnter?.(e, { artifactId: sourceDatasetId, format: 'json' }, workspaceUuid)}
          onMouseLeave={() => onArtifactLeave?.()}>
          <FontAwesomeIcon icon={faFileCode} /> {sourceDatasetId.slice(0, 8)}
        </span>
      )}
      {chartTitle && <div className="HPAG-aso-chart-caption">{chartTitle}</div>}
    </div>
  );
}

function HPA() {
  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [collapsedRuns, setCollapsedRuns] = useState({}); // Track collapsed state per runId
  const [searchResults, setSearchResults] = useState({}); // Map of searchUrl -> { rows, loading, error, currentPage }
  const [replyTo, setReplyTo] = useState(null); // { ensg, geneName } for reply context
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const modelDropdownRef = useRef(null);
  const toolRunRefs = useRef({}); // Refs for auto-scroll within each run container
  const [isBlocked, setIsBlocked] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState(null);
  const artifactLeaveTimer = useRef(null);
  const apiBaseUrl = getApiBaseUrl();
  const isLocalEnv = RUNTIME_CONFIG.isLocal;
  const maxConversationTitleLength = UI_CONFIG.maxConversationTitleLength;

  const REPLY_MARKER_NEW = /^⟪HPA▸GENE:(ENSG\d+):([^⟫]+)⟫\s*/;
  const REPLY_MARKER_COMPAT = /^\[\[REPLY:(ENSG\d+):([^\]]+)\]\]\s*/;
  const extractReplyContext = (t = '') => {
    let match = t.match(REPLY_MARKER_NEW);
    let regex = REPLY_MARKER_NEW;
    if (!match) {
      match = t.match(REPLY_MARKER_COMPAT);
      regex = REPLY_MARKER_COMPAT;
    }
    if (match) {
      return { ensg: match[1], geneName: match[2], textWithoutReply: t.replace(regex, '') };
    }
    return null;
  };

  // Title case: lowercase everything, then capitalize first letter of each word
  const titleCase = (str = '') => str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  const cleanPreviewText = (text = '') => String(text || '').replace(/\s+/g, ' ').trim();

  const stripReplyMarker = (text = '') => {
    const cleaned = cleanPreviewText(text);
    if (!cleaned) return '';
    const extracted = extractReplyContext(cleaned);
    return cleanPreviewText(extracted ? extracted.textWithoutReply : cleaned);
  };

  const truncateText = (text = '', maxLen = 50) => {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    if (maxLen <= 3) return text.slice(0, maxLen);
    return `${text.slice(0, maxLen - 3)}...`;
  };

  const buildTitleFromText = (text = '') => {
    const cleaned = cleanPreviewText(text);
    if (!cleaned) return '';
    return truncateText(cleaned, maxConversationTitleLength);
  };

  const getFirstUserMessageText = (conv) => {
    const messages = Array.isArray(conv?.messages) ? conv.messages : [];
    const firstUserMessage = messages.find(msg => msg?.type === 'user' && cleanPreviewText(msg.text));
    if (!firstUserMessage) return '';
    return stripReplyMarker(firstUserMessage.text);
  };

  const buildConversationTitle = (conv) => {
    const explicitTitle = cleanPreviewText(conv?.title);
    const hasCustomTitle = explicitTitle && explicitTitle.toLowerCase() !== 'new conversation';
    if (hasCustomTitle) return truncateText(explicitTitle, maxConversationTitleLength);

    const firstUserText = getFirstUserMessageText(conv);
    if (firstUserText) return buildTitleFromText(firstUserText);

    const previewText = stripReplyMarker(conv?.preview);
    if (previewText) return buildTitleFromText(previewText);

    return explicitTitle || 'New Conversation';
  };

  const TOOL_STAGE_META = {
    start: { label: 'Start', css: 'start', description: 'Research agent activated.' },
    planning_step: { label: 'Plan', css: 'planning', description: 'Building search strategy.' },
    reasoning_step: { label: 'Think', css: 'reasoning', description: 'Analyzing options.' },
    selection_step: { label: 'Select', css: 'selection', description: 'Locking in choice.' },
    execution_step: { label: 'Run', css: 'execution', description: 'Executing query.' },
    fallback: { label: 'Fallback', css: 'fallback', description: 'Trying backup.' },
    error: { label: 'Error', css: 'error', description: 'Issue detected.' },
    complete: { label: 'Done', css: 'complete', description: 'Research complete.' },
    info: { label: 'Info', css: 'info', description: 'Status update.' },
    'measure.scout': { label: 'Agent', css: 'execution', description: 'Calibrating gene lookup.' },
    'measure.scout_result': { label: 'Agent', css: 'complete', description: 'Calibration result.' },
    'tool.invoke': { label: 'Invoke', css: 'execution', description: 'Tool invocation.' },
    'measure.batch': { label: 'Target', css: 'target', description: 'Batch data acquisition.' },
    'tool.result': { label: 'Info', css: 'info', description: 'Tool result.' },
    'state.snapshot': { label: 'Info', css: 'info', description: 'State snapshot.' },
    think: { label: 'Think', css: 'reasoning', description: 'Planning steps.' },
    'understand.objective': { label: 'Think', css: 'reasoning', description: 'Understanding objective.' },
    'final.complete': { label: 'Info', css: 'complete', description: 'ASO completed.' },
    'final.report': { label: 'Info', css: 'complete', description: 'Compiling report.' },
    'start.workspace_created': { label: 'Info', css: 'start', description: 'Workspace initialized.' },
    tokens: { label: null, css: null, description: null }
  };

  const stageMetaFor = (event = {}) => {
    if (!event) return TOOL_STAGE_META.info;
    if (event.status === 'started') return TOOL_STAGE_META.start;
    if (event.status === 'completed') return TOOL_STAGE_META.complete;
    const key = (event.stage || '').toLowerCase();
    return TOOL_STAGE_META[key] || TOOL_STAGE_META.info;
  };

  // Compute the display label for a tool event (shared by shimmer + timeline)
  const getStepDisplayLabel = (evt, isAso) => {
    if (!evt) return 'Update';
    const meta = stageMetaFor(evt);
    let label = titleCase(evt.label || meta?.label || 'Update');

    if (isAso && evt.message) {
      try {
        const d = JSON.parse(evt.message);
        const stage = (evt.stage || '').toLowerCase();
        if (stage === 'think' && d.text) label = 'Planning';
        else if (stage === 'measure.scout') label = `Calibrating ${d.gene || '?'} · ${d.tissue || '?'}`;
        else if (stage === 'measure.scout_result') label = d.exact_label ? `Found ${d.exact_label}` : `Result · ${d.gene || '?'}`;
        else if (stage === 'measure.batch') label = 'Batch Data Acquisition';
        else if (stage === 'tool.invoke' && d.name) label = `Invoking ${titleCase(d.name.replace(/_/g, ' '))}`;
        else if (stage === 'tool.result' && d.name) label = 'Tool Result';
        else if (stage === 'state.snapshot') label = 'State Snapshot';
        else if (stage === 'start.workspace_created') label = 'Workspace Initialized';
        else if (stage === 'final.complete') label = 'Completion';
        else if (stage === 'final.report') label = 'Compiling Report';
        else if (stage === 'understand.objective') label = 'Understanding Objective';
        else if (stage === 'measure.invoke' && d.mode?.includes('direct+scout')) label = `Measuring ${d.gene || '?'}`;
      } catch (_) {}
    }
    return label;
  };

  const linkifyInline = (text = '') => {
    if (!text) return '';
    const regex = /(https?:\/\/[^\s)]+)/gi;
    const segments = [];
    let lastIndex = 0;
    let match;
    let key = 0;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push(<span key={`text-${key++}`}>{text.slice(lastIndex, match.index)}</span>);
      }
      const rawUrl = match[1];
      const url = rawUrl.replace(/[),.;]+$/, '');
      segments.push(
        <a key={`url-${key++}`} href={url} target="_blank" rel="noopener noreferrer" className="HPAG-tool-inline-link">
          {url}
        </a>
      );
      lastIndex = match.index + rawUrl.length;
    }

    if (lastIndex < text.length) {
      segments.push(<span key={`text-${key++}`}>{text.slice(lastIndex)}</span>);
    }

    return segments.length ? segments : text;
  };

  const extractOptionsForEvent = (event) => {
    if (!event || !event.message) return [];
    const label = (event.label || '').toLowerCase();
    const shouldParse = /\boptions\b/i.test(label);
    if (!shouldParse) return [];
    const parts = event.message
      .split(/[,;]/)
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length < 2) return [];
    return parts;
  };

  const extractSelectionsForEvent = (event) => {
    if (!event || !event.message) return [];
    const stage = (event.stage || '').toLowerCase();
    if (stage !== 'selection_step') return [];
    // Don't split URLs or long paths
    if (event.message.includes('http') || event.message.includes('→')) return [];
    const parts = event.message
      .split(/,/)
      .map(s => s.trim())
      .filter(Boolean);
    return parts;
  };

  const groupMessagesIntoRuns = (messages) => {
    const groups = [];
    let currentRun = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const toolEvent = msg.type === 'tool' ? (msg.toolEvent) : null;

      if (msg.type === 'tool' && toolEvent?.runId) {
        // This is part of a tool run
        if (!currentRun || currentRun.runId !== toolEvent.runId) {
          // Start a new run
          if (currentRun) groups.push(currentRun);
          currentRun = {
            type: 'run',
            runId: toolEvent.runId,
            messages: [msg],
            startTime: Date.now(),
            isComplete: toolEvent.status === 'completed'
          };
        } else {
          // Add to existing run
          currentRun.messages.push(msg);
          if (toolEvent.status === 'completed') {
            currentRun.isComplete = true;
          }
        }
      } else {
        // Not part of a tool run
        if (currentRun) {
          groups.push(currentRun);
          currentRun = null;
        }
        groups.push({ type: 'message', message: msg, index: i });
      }
    }

    if (currentRun) groups.push(currentRun);

    return groups;
  };

  // Artifact preview popover handlers
  const handleArtifactChipEnter = async (e, chip, workspaceUuid) => {
    if (!chip.artifactId || !workspaceUuid) return;
    if (artifactLeaveTimer.current) { clearTimeout(artifactLeaveTimer.current); artifactLeaveTimer.current = null; }
    const rect = e.currentTarget.getBoundingClientRect();
    setArtifactPreview({ rect, artifactId: chip.artifactId, format: chip.format || 'json', workspaceUuid, data: null, loading: true, error: null, showRaw: false });
    try {
      const ext = chip.format || 'json';
      const filename = `${chip.artifactId}.${ext}`;
      const url = `${apiBaseUrl}/workspaces/${workspaceUuid}/artifacts/${filename}`;
      const resp = await authenticatedFetch(url);
      if (!resp.ok) throw new Error(`${resp.status}`);
      let data;
      if (ext === 'png') {
        const blob = await resp.blob();
        data = { type: 'image', url: URL.createObjectURL(blob) };
      } else if (ext === 'md') {
        const text = await resp.text();
        data = { type: 'markdown', text };
      } else {
        const json = await resp.json();
        data = { type: 'json', json };
      }
      setArtifactPreview(prev => prev?.artifactId === chip.artifactId ? { ...prev, data, loading: false } : prev);
    } catch (err) {
      setArtifactPreview(prev => prev?.artifactId === chip.artifactId ? { ...prev, error: err.message, loading: false } : prev);
    }
  };

  const handleArtifactChipLeave = () => {
    artifactLeaveTimer.current = setTimeout(() => {
      setArtifactPreview(prev => {
        if (prev?.data?.type === 'image' && prev.data.url) URL.revokeObjectURL(prev.data.url);
        return null;
      });
    }, 150);
  };

  const handlePopoverEnter = () => {
    if (artifactLeaveTimer.current) { clearTimeout(artifactLeaveTimer.current); artifactLeaveTimer.current = null; }
  };

  const toggleArtifactRawView = () => {
    setArtifactPreview(prev => prev ? { ...prev, showRaw: !prev.showRaw } : null);
  };

  const downloadWorkspace = async (workspaceUuid) => {
    try {
      await authenticatedDownload(
        `${apiBaseUrl}/workspaces/${workspaceUuid}/download`,
        `workspace-${workspaceUuid}.tar.gz`
      );
    } catch (error) {
      console.error('[FE] Workspace download failed:', error.message);
    }
  };

  const downloadArtifact = async (preview) => {
    const filename = `${preview.artifactId}.${preview.format}`;
    try {
      await authenticatedDownload(
        `${apiBaseUrl}/workspaces/${preview.workspaceUuid}/artifacts/${filename}`,
        filename
      );
    } catch (error) {
      console.error('[FE] Artifact download failed:', error.message);
    }
  };

  const renderArtifactTable = (json) => {
    let rows = [];
    if (Array.isArray(json)) { rows = json; }
    else if (json?.rows && Array.isArray(json.rows)) { rows = json.rows; }
    else {
      return (
        <table className="HPAG-artifact-table">
          <tbody>
            {Object.entries(json).map(([k, v]) => (
              <tr key={k}><td className="HPAG-artifact-table-key">{k}</td><td>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td></tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (!rows.length) return <div className="HPAG-artifact-popover-empty">No data rows</div>;
    const cols = Object.keys(rows[0]);
    const displayRows = rows.slice(0, 20);
    return (
      <table className="HPAG-artifact-table">
        <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {displayRows.map((row, ri) => (
            <tr key={ri}>{cols.map(c => <td key={c}>{row[c] != null ? String(row[c]) : ''}</td>)}</tr>
          ))}
        </tbody>
        {rows.length > 20 && (
          <tfoot><tr><td colSpan={cols.length} className="HPAG-artifact-table-more">…and {rows.length - 20} more rows</td></tr></tfoot>
        )}
      </table>
    );
  };

  // Toggle collapsed state for a run
  const toggleRunCollapsed = (runId) => {
    setCollapsedRuns(prev => ({
      ...prev,
      [runId]: prev[runId] === false ? true : false
    }));
  };

  // Extract HPA URLs from message text
  const extractHPAUrls = (text) => {
    const urlRegex = /https?:\/\/www\.proteinatlas\.org\/[^\s)]+/g;
    const matches = text.match(urlRegex) || [];
    const uniqueUrls = [...new Set(matches)];

    // Filter out URLs with + EXCEPT for our known sub-pages
    const knownSubPages = ['/single+cell', '/cell+line', '/structure+interaction'];
    const filteredUrls = uniqueUrls.filter(url => {
      // If it has a +, only keep it if it's one of our known sub-pages
      if (url.includes('+')) {
        return knownSubPages.some(subPage => url.includes(subPage));
      }
      return true;
    });

    return filteredUrls.map(url => {
      if (url.includes('/search/')) {
        const geneName = url.split('/search/')[1]?.split(/[?&#]/)[0] || 'Search';
        return {
          url,
          type: 'search',
          label: geneName,
          icon: faDna
        };
      }

      // Parse the URL to determine the type
      let type = 'summary';
      let label = 'Summary';
      let icon = faDna;

      // Check if it's an ENSG protein page (e.g., ENSG00000121410-A1BG)
      const ensgMatch = url.match(/ENSG\d+-([A-Z0-9]+)/);
      if (ensgMatch && !url.includes('/tissue') && !url.includes('/brain') && !url.includes('/single+cell') &&
          !url.includes('/subcellular') && !url.includes('/cancer') && !url.includes('/blood') &&
          !url.includes('/cell+line') && !url.includes('/structure+interaction')) {
        // It's a base protein page, use the gene name
        label = ensgMatch[1];
      }

      if (url.includes('/tissue')) {
        type = 'tissue';
        label = 'Tissue';
        icon = faMicroscope;
      } else if (url.includes('/brain')) {
        type = 'brain';
        label = 'Brain';
        icon = faBrain;
      } else if (url.includes('/single+cell')) {
        type = 'single_cell';
        label = 'Single Cell';
        icon = faVirus;
      } else if (url.includes('/subcellular')) {
        type = 'subcellular';
        label = 'Subcellular';
        icon = faCubes;
      } else if (url.includes('/cancer')) {
        type = 'cancer';
        label = 'Cancer';
        icon = faVirus;
      } else if (url.includes('/blood')) {
        type = 'blood';
        label = 'Blood';
        icon = faDroplet;
      } else if (url.includes('/cell+line')) {
        type = 'cell_line';
        label = 'Cell Line';
        icon = faFlask;
      } else if (url.includes('/structure+interaction')) {
        type = 'structure_interaction';
        label = 'Structure';
        icon = faNetworkWired;
      } else if (url.endsWith('.xml')) {
        type = 'xml';
        label = 'XML';
        icon = faFileCode;
      }

      return { url, type, label, icon };
    });
  };

  // Format date to human-readable relative time
  const formatRelativeTime = (dateString) => {
    if (!dateString) return 'Just now';

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;

    // Check if yesterday
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    // Check if this week (within last 7 days)
    if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;

    // Check if last week (7-14 days ago)
    if (diffDays < 14) return 'Last week';

    // Check if this month
    if (date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()) {
      return 'This month';
    }

    // Otherwise show date
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Fetch HPA search results for a given URL
  const fetchSearchResults = async (searchUrl) => {
    if (!searchUrl || searchResults[searchUrl]?.rows) return; // Already fetched

    setSearchResults(prev => ({
      ...prev,
      [searchUrl]: { loading: true, rows: null, error: null, currentPage: 0, thumbnails: {} }
    }));

    try {
      const response = await authenticatedFetch(
        `${getApiEndpoint('hpaSearchResults')}?url=${encodeURIComponent(searchUrl)}`
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      setSearchResults(prev => ({
        ...prev,
        [searchUrl]: { loading: false, rows: data.rows || [], totalCount: data.totalCount, currentPage: 0, error: null, thumbnails: {} }
      }));
    } catch (err) {
      console.error('[FE] Failed to fetch search results:', err);
      setSearchResults(prev => ({
        ...prev,
        [searchUrl]: { loading: false, rows: null, error: err.message, currentPage: 0, thumbnails: {} }
      }));
    }
  };

  const THUMB_LOAD_KEY = '__loaded';

  // Fetch thumbnails for visible genes (5 second timeout)
  const fetchThumbnails = async (searchUrl, geneIds) => {
    if (!geneIds.length) return;

    // Filter out already fetched
    const existing = searchResults[searchUrl]?.thumbnails || {};
    const toFetch = geneIds.filter(id => !existing[id]);
    if (!toFetch.length) return;

    // Mark as loading per gene so we can swap shimmer -> N/A on timeout
    const loadingMarkers = {};
    toFetch.forEach(id => { loadingMarkers[id] = { [THUMB_LOAD_KEY]: false }; });
    setSearchResults(prev => ({
      ...prev,
      [searchUrl]: {
        ...prev[searchUrl],
        thumbnails: { ...prev[searchUrl]?.thumbnails, ...loadingMarkers }
      }
    }));

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const response = await authenticatedFetch(
        `${getApiEndpoint('hpaGeneThumbnails')}?genes=${encodeURIComponent(toFetch.join(','))}`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error('Failed to fetch');
      const data = await response.json();

      const normalized = {};
      toFetch.forEach(id => {
        const raw = data?.[id];
        if (raw && typeof raw === 'object') {
          normalized[id] = { ...raw, [THUMB_LOAD_KEY]: true };
        } else {
          normalized[id] = { [THUMB_LOAD_KEY]: true };
        }
      });

      setSearchResults(prev => ({
        ...prev,
        [searchUrl]: {
          ...prev[searchUrl],
          thumbnails: { ...prev[searchUrl]?.thumbnails, ...normalized }
        }
      }));
    } catch (err) {
      console.error('[FE] Failed to fetch thumbnails (timeout or error):', err);
      // On timeout/error, mark all as loaded so we show N/A
      const failedMarkers = {};
      toFetch.forEach(id => { failedMarkers[id] = { [THUMB_LOAD_KEY]: true }; });
      setSearchResults(prev => ({
        ...prev,
        [searchUrl]: {
          ...prev[searchUrl],
          thumbnails: { ...prev[searchUrl]?.thumbnails, ...failedMarkers }
        }
      }));
    }
  };

  const THUMB_SECTIONS = [
    { key: 'tissue', label: 'Tissue', color: '#0083C4' },
    { key: 'brain', label: 'Brain', color: '#ffdd00' },
    { key: 'single_cell', label: 'Single cell', color: '#6aa692' },
    { key: 'subcellular', label: 'Subcell', color: '#97cf16' },
    { key: 'cancer', label: 'Cancer', color: '#ffaabf' },
    { key: 'blood', label: 'Blood', color: '#cf161a' },
    { key: 'cell_line', label: 'Cell line', color: '#ffa500' },
    { key: 'structure', label: 'Structure', color: '#69008c' }
  ];

  // Render search results table
  const SearchResultsView = ({ searchUrl }) => {
    const data = searchResults[searchUrl];
    const ITEMS_PER_PAGE = 5;
    const [filterText, setFilterText] = useState('');

    // Trigger fetch on mount if not already loaded
    useEffect(() => {
      if (searchUrl && !data) {
        fetchSearchResults(searchUrl);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchUrl]);

    // Fetch thumbnails for visible rows when page changes (only fetches 5 at a time!)
    useEffect(() => {
      if (data?.rows && !data.loading) {
        const startIdx = (data.currentPage || 0) * ITEMS_PER_PAGE;
        const visibleRows = data.rows.slice(startIdx, startIdx + ITEMS_PER_PAGE);
        const geneIds = visibleRows.map(r => r.Ensembl || r.Gene).filter(Boolean);
        fetchThumbnails(searchUrl, geneIds);
      }
    }, [searchUrl, data?.currentPage, data?.loading, data?.rows]);

    if (!data || data.loading) {
      return (
        <div className="HPAG-search-results HPAG-search-results-loading">
          <div className="HPAG-search-results-header">
            <input type="text" className="HPAG-search-filter" placeholder="Filter genes..." disabled />
            <a href={searchUrl} target="_blank" rel="noopener noreferrer" className="HPAG-search-external" title="Open in HPA">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M11 7.5v4a1 1 0 01-1 1H2.5a1 1 0 01-1-1V4a1 1 0 011-1h4M8.5 1.5h4m0 0v4m0-4l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </a>
          </div>
          <div className="HPAG-search-results-table">
            <div className="HPAG-search-results-thead">
              <div className="HPAG-search-th HPAG-search-th-gene">Gene</div>
              {THUMB_SECTIONS.map(s => (
                <div key={s.key} className="HPAG-search-th HPAG-search-th-thumb">{s.label}</div>
              ))}
            </div>
            {[...Array(5)].map((_, i) => (
              <div key={i} className="HPAG-search-tr HPAG-shimmer-row">
                <div className="HPAG-search-td HPAG-search-td-gene">
                  <div className="HPAG-shimmer-text" style={{ width: '140px' }} />
                  <div className="HPAG-shimmer-text" style={{ width: '200px', marginTop: '4px' }} />
                </div>
                {THUMB_SECTIONS.map(s => (
                  <div key={s.key} className="HPAG-search-td HPAG-search-td-thumb">
                    <div className="HPAG-thumb-shimmer" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (data.error) {
      return <div className="HPAG-search-results-error">Failed to load results</div>;
    }

    if (!data.rows || data.rows.length === 0) {
      return <div className="HPAG-search-results-empty">No results found</div>;
    }

    // Filter rows by search text
    const filteredRows = filterText
      ? data.rows.filter(r => {
          const gene = (r['Gene name'] || r.Gene || '').toLowerCase();
          const ensg = (r.Ensembl || '').toLowerCase();
          const desc = (r['Gene description'] || '').toLowerCase();
          const q = filterText.toLowerCase();
          return gene.includes(q) || ensg.includes(q) || desc.includes(q);
        })
      : data.rows;

    const totalPages = Math.ceil(filteredRows.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(data.currentPage || 0, Math.max(0, totalPages - 1));
    const startIdx = currentPage * ITEMS_PER_PAGE;
    const visibleRows = filteredRows.slice(startIdx, startIdx + ITEMS_PER_PAGE);

    const goToPage = (page) => {
      setSearchResults(prev => ({
        ...prev,
        [searchUrl]: { ...prev[searchUrl], currentPage: page }
      }));
    };

    return (
      <div className="HPAG-search-results">
        <div className="HPAG-search-results-header">
          <input
            type="text"
            className="HPAG-search-filter"
            placeholder={`Filter ${data.rows.length} genes...`}
            value={filterText}
            onChange={(e) => { setFilterText(e.target.value); goToPage(0); }}
          />
          <a href={searchUrl} target="_blank" rel="noopener noreferrer" className="HPAG-search-external" title="Open in HPA">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M11 7.5v4a1 1 0 01-1 1H2.5a1 1 0 01-1-1V4a1 1 0 011-1h4M8.5 1.5h4m0 0v4m0-4l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </a>
        </div>
        <div className="HPAG-search-results-table">
          <div className="HPAG-search-results-thead">
            <div className="HPAG-search-th HPAG-search-th-gene">Gene</div>
            {THUMB_SECTIONS.map(s => (
              <div key={s.key} className="HPAG-search-th HPAG-search-th-thumb" style={{ borderBottomColor: s.color }}>{s.label}</div>
            ))}
          </div>
          {visibleRows.map((row, idx) => {
            const ensg = row.Ensembl || row.Gene || '';
            const geneName = row['Gene name'] || row.Gene || '—';
            const desc = row['Gene description'] || '';
            const thumbs = data.thumbnails?.[ensg] || {};

            return (
              <div key={idx} className="HPAG-search-tr">
                <div className="HPAG-search-td HPAG-search-td-gene">
                  <button
                    className="HPAG-reply-btn"
                    onClick={() => {
                      setReplyTo({ ensg, geneName });
                      setTimeout(() => {
                        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                        inputRef.current?.focus();
                      }, 100);
                    }}
                    title={`Ask about ${geneName}`}
                  >
                    <FontAwesomeIcon icon={faReply} />
                  </button>
                  <a href={`https://www.proteinatlas.org/${ensg}`} target="_blank" rel="noopener noreferrer" className="HPAG-gene-link">
                    <span className="HPAG-gene-title"><span className="HPAG-search-result-symbol">{geneName}</span><span className="HPAG-gene-dot">·</span><span className="HPAG-search-result-ensg">{ensg}</span></span>
                    {desc && <span className="HPAG-search-result-desc">{desc}</span>}
                  </a>
                </div>
                {THUMB_SECTIONS.map(s => {
                  const thumb = thumbs[s.key];
                  const hasLoaded = thumbs?.[THUMB_LOAD_KEY] === true || thumb !== undefined;
                  const hasImage = thumb?.img;
                  const tooltipText = thumb?.title || s.label;
                  return (
                    <div key={s.key} className="HPAG-search-td HPAG-search-td-thumb">
                      {hasImage ? (
                        <a href={thumb.link} target="_blank" rel="noopener noreferrer" className="HPAG-thumb-link">
                          <img src={thumb.img} alt={s.label} className="HPAG-thumb-img" style={{ borderColor: s.color }} />
                          <div className="HPAG-thumb-hover">
                            <span className="HPAG-thumb-hover-text">{tooltipText}</span>
                          </div>
                        </a>
                      ) : hasLoaded ? (
                        <div className="HPAG-thumb-na">N/A</div>
                      ) : (
                        <div className="HPAG-thumb-shimmer" />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {totalPages > 1 && (
          <div className="HPAG-search-results-footer">
            <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 0} className="HPAG-pagination-btn">Prev</button>
            <span className="HPAG-pagination-info">{currentPage + 1} / {totalPages}</span>
            <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= totalPages - 1} className="HPAG-pagination-btn">Next</button>
          </div>
        )}
      </div>
    );
  };

  useEffect(() => {
    if (!isLoading && inputRef.current) inputRef.current.focus();
  }, [isLoading, selectedConversation]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target)) {
        setShowModelDropdown(false);
      }
    };
    if (showModelDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showModelDropdown]);

  // Initialize the anonymous server-issued session and load its conversations.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initializeHPAAuth();
        debugLog('[FE] load conversations…');
        const response = await authenticatedFetch(getApiEndpoint('listConversations'));
        if (response.ok && !cancelled) {
          const data = await response.json();
          const withMessages = data.map(conv => ({ ...conv, messages: [] }));
          setConversations(withMessages);
          // Start with blank state instead of selecting the first conversation
          // if (withMessages.length > 0) setSelectedConversation(withMessages[0].id);
        } else {
          console.warn('[FE] listConversations failed:', response.status);
        }
      } catch (e) { console.error('conv load failed', e); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkBlockStatus = async () => {
      if (cancelled) return;
      try {
        const resp = await authenticatedFetch(getApiEndpoint('authSession'), {
          method: 'GET',
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (resp.status === 403) {
          setIsBlocked(true);
          return;
        }
        if (resp.ok) setIsBlocked(false);
      } catch (err) {
        console.warn('[FE] block-check failed', err);
      }
    };

    checkBlockStatus();
    const timer = setInterval(checkBlockStatus, UI_CONFIG.blockPollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // load messages for selected convo (once)
  useEffect(() => {
    if (selectedConversation === null) return;
    const current = conversations.find(c => c.id === selectedConversation);
    if (current && current.messages.length > 0) return;

    (async () => {
      try {
        debugLog('[FE] load messages…', selectedConversation);
        const response = await authenticatedFetch(`${getApiEndpoint('getMessages')}?conversationId=${selectedConversation}`);
        if (response.ok) {
          // The backend returns the ordered timeline: messages carry their run's search URL,
          // resources, and dictionary images; runs expand into tool lines grouped by run id.
          const timeline = await response.json();
          const processed = timelineToUiMessages(timeline);
          debugLog('[FE] timeline loaded', { items: Array.isArray(timeline) ? timeline.length : 0, messages: processed.length });
          setConversations(convs => convs.map(c => (c.id === selectedConversation ? { ...c, messages: processed } : c)));
        } else {
          console.warn('[FE] getMessages failed:', response.status);
        }
      } catch (e) { console.error('messages load failed', e); }
    })();
  // Message hydration is intentionally keyed only by the selected conversation.
  // Including conversations would retrigger this effect after it hydrates the state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversation]);

  const currentMessages = useMemo(
    () => conversations.find(c => c.id === selectedConversation)?.messages || [],
    [conversations, selectedConversation]
  );
  const messageGroups = groupMessagesIntoRuns(currentMessages);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages]);

  // Auto-scroll within tool run containers when expanded
  useEffect(() => {
    messageGroups.forEach(group => {
      if (group.type === 'run' && collapsedRuns[group.runId] === false) {
        const ref = toolRunRefs.current[group.runId];
        if (ref) {
          ref.scrollTo({
            top: ref.scrollHeight,
            behavior: 'smooth'
          });
        }
      }
    });
  // Scroll only when the selected conversation receives a message. Collapse
  // toggles already trigger their own render and should not restart this effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMessages.length]);

  const appendToAI = (aiId, extraText, targetConvId) => {
    if (!extraText) return;
    setConversations(convs => convs.map(conv => {
      if (conv.id !== targetConvId) return conv;
      const msgs = conv.messages.map(m => (m.id === aiId ? { ...m, text: m.text + extraText } : m));
      return { ...conv, messages: msgs };
    }));
  };

  // push a separate tool line (progress log)
  const pushToolLine = (eventPayload, targetConvId) => {
    if (!eventPayload || !targetConvId) return;
    setConversations(convs => convs.map(conv => {
      if (conv.id !== targetConvId) return conv;
      const evt = {
        id: Date.now() + Math.random(),
        type: 'tool',
        text: eventPayload.rawText || '',
        toolEvent: eventPayload,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      };
      return { ...conv, messages: [...conv.messages, evt] };
    }));
  };

  const handleNewChat = () => {

    debugLog('[FE] New chat - resetting to blank slate');
    setSelectedConversation(null);
    setInputValue('');
  };

  const handleSend = async () => {
    if (inputValue.trim() === '' || isLoading) return;

    const now = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    let conversationId = selectedConversation;
    const draftTitle = buildTitleFromText(inputValue) || 'New Conversation';

    // If no conversation exists, create one now
    if (!conversationId) {
      try {
        debugLog('[FE] No conversation exists, creating one…');
        const response = await authenticatedFetch(getApiEndpoint('createConversation'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: draftTitle })
        });
        if (response.ok) {
          const newConv = await response.json();
          conversationId = newConv.conversationId;
          const row = {
            id: conversationId,
            title: newConv.title,
            created_at: new Date().toISOString(),
            messages: []
          };
          setConversations([row, ...conversations]);
          setSelectedConversation(conversationId);
          debugLog('[FE] Created conversation:', conversationId);
        } else {
          console.error('[FE] Failed to create conversation:', response.status);
          return;
        }
      } catch (e) {
        console.error('Failed to create conversation:', e);
        return;
      }
    }

    const userMessageText = replyTo
      ? `⟪HPA▸GENE:${replyTo.ensg}:${replyTo.geneName}⟫ ${inputValue}`
      : inputValue;
    const userMessage = {
      id: Date.now(),
      type: 'user',
      text: userMessageText,
      timestamp: now(),
      replyContext: replyTo ? { ensg: replyTo.ensg, geneName: replyTo.geneName } : null
    };
    setConversations(convs => convs.map(conv =>
      conv.id === conversationId ? { ...conv, messages: [...conv.messages, userMessage] } : conv
    ));

    const queryText = userMessageText;
    setInputValue('');
    setReplyTo(null); // Clear reply context after sending
    requestAnimationFrame(() => inputRef.current?.focus());
    setIsLoading(true);

    try {

      // This will be the ID of the first bubble (for the preface).
      const initialAiId = Date.now() + 1;
      setConversations(convs => convs.map(conv =>
        conv.id === conversationId
          ? { ...conv, messages: [...conv.messages, { id: initialAiId, type: 'ai', text: '', timestamp: now() }] }
          : conv
      ));

      let currentAiMessageId = initialAiId;
      let finalAnswerBubbleCreated = false;
      let toolHasRun = false;
      let pendingResources = null; // Store resources until final answer bubble is created

      debugLog(`[FE] POST queryStream… Initial AI bubble ID: ${currentAiMessageId}`);
      const response = await authenticatedFetch(getApiEndpoint('queryStream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryText, conversationId })
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) { debugLog('[FE] stream done'); break; }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        let isStreamFinished = false;

        for (const frame of parts) {
          const line = frame.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let payload = null;
          try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
          debugLog('[FE] SSE frame:', payload);

          if (payload.error) { appendToAI(currentAiMessageId, `\n\n❌ ${payload.error}`, conversationId); continue; }

          if (payload.phase === 'pre' && payload.delta) {
            appendToAI(currentAiMessageId, payload.delta, conversationId);
            continue;
          }

          if (payload.tool) {
            toolHasRun = true;
            // The backend names the run; live lines and reloaded lines share that id.
            pushToolLine(liveToolEventFromSse(payload.tool), conversationId);
            continue;
          }

          if (payload.token) {
            if (toolHasRun && !finalAnswerBubbleCreated) {
              debugLog('[FE] First token after tool run. Creating new AI bubble.');
              const finalAnswerId = Date.now() + Math.random();

              const newMessage = { id: finalAnswerId, type: 'ai', text: '', timestamp: now() };
              if (pendingResources) {
                newMessage.resources = pendingResources;
                debugLog('[FE] Attaching pending resources to final answer bubble');
                pendingResources = null;
              }

              setConversations(convs => convs.map(conv =>
                conv.id === conversationId
                  ? { ...conv, messages: [...conv.messages, newMessage] }
                  : conv
              ));

              currentAiMessageId = finalAnswerId; // Switch target to the new bubble
              finalAnswerBubbleCreated = true;
              debugLog(`[FE] Switched streaming target to new bubble ID: ${currentAiMessageId}`);
            }

            appendToAI(currentAiMessageId, payload.token, conversationId);
            continue;
          }

          if (payload.search_url) {
            debugLog('[FE] Received search_url:', payload.search_url);
            const targetAiMessageId = currentAiMessageId;
            setConversations(convs => convs.map(conv => {
              if (conv.id !== conversationId) return conv;
              return {
                ...conv,
                messages: conv.messages.map(m =>
                  m.id === targetAiMessageId ? { ...m, searchUrl: payload.search_url } : m
                )
              };
            }));
            continue;
          }

          if (payload.resources) {
            debugLog('[FE] Received resources:', payload.resources);
            // Store resources to attach to final answer bubble (created on first token)
            if (toolHasRun && !finalAnswerBubbleCreated) {
              pendingResources = payload.resources;
              debugLog('[FE] Storing pending resources for final answer bubble');
            } else {
              const targetAiMessageId = currentAiMessageId;
              setConversations(convs => convs.map(conv => {
                if (conv.id !== conversationId) return conv;
                return {
                  ...conv,
                  messages: conv.messages.map(m =>
                    m.id === targetAiMessageId ? { ...m, resources: payload.resources } : m
                  )
                };
              }));
            }
            continue;
          }

          // Handle dictionary images (sent before synthesis starts)
          if (payload.dictionary_images) {
            debugLog('[FE] Received dictionary_images:', payload.dictionary_images);
            const targetAiMessageId = currentAiMessageId;
            setConversations(convs => convs.map(conv => {
              if (conv.id !== conversationId) return conv;
              return {
                ...conv,
                messages: conv.messages.map(m =>
                  m.id === targetAiMessageId ? { ...m, dictionaryImages: payload.dictionary_images } : m
                )
              };
            }));
            continue;
          }

          if (payload.done) { isStreamFinished = true; }
        }
        
        if (isStreamFinished) { break; }
      }
    } catch (err) {
      console.error('Failed to stream message:', err);
      const errorMessage = {
        id: Date.now() + 2,
        type: 'ai',
        text: 'Sorry, there was an error connecting to the server. Please try again.',
        timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      };
      setConversations(convs => convs.map(conv =>
        conv.id === conversationId ? { ...conv, messages: [...conv.messages, errorMessage] } : conv
      ));
    } finally {
      setIsLoading(false);
    }
  };

  if (isBlocked) {
    return (
      <div className="HPAG-blocked">
        <div className="HPAG-blocked-card">
          <h1>Access Restricted</h1>
          <p>Your session has been disabled by the administrators. If you believe this is an error, please contact the HPA team.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="HPAG-container">
      <div className="HPAG-sidebar">
        <div className="HPAG-sidebar-logo">
          <img src="https://www.proteinatlas.org/images_static/logo.svg" alt="Human Protein Atlas" />
        </div>
        <div className="HPAG-sidebar-header">
          <h2>Conversations</h2>
          <button className="HPAG-new-chat-btn" onClick={handleNewChat}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7 1V13M1 7H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            New
          </button>
        </div>

        <div className="HPAG-conversations-list">
          {conversations.map(conv => (
            <div
              key={conv.id}
              className={`HPAG-conversation-item ${selectedConversation === conv.id ? 'HPAG-active' : ''}`}
              onClick={() => setSelectedConversation(conv.id)}
            >
              <div className="HPAG-conversation-title">{buildConversationTitle(conv)}</div>
              <div className="HPAG-conversation-date">{formatRelativeTime(conv.created_at || conv.date)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="HPAG-chat-area">
        <div className="HPAG-chat-header">
          <div className="HPAG-model-selector" ref={modelDropdownRef}>
            <button
              className="HPAG-model-button"
              onClick={() => setShowModelDropdown(!showModelDropdown)}
            >
              <span className="HPAG-model-name">AtlasAI</span>
              <span className="HPAG-model-version">1.47</span>
              <i className="fas fa-chevron-down"></i>
            </button>
            {showModelDropdown && (
              <div className="HPAG-model-dropdown">
                <div className="HPAG-model-item HPAG-model-active">
                  <div className="HPAG-model-item-name">AtlasAI 1.47</div>
                  <div className="HPAG-model-item-desc">
                    Specialized agent for Human Protein Atlas data analysis and research
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="HPAG-header-actions">
            {isLocalEnv && (
              <div className="HPAG-env-indicator" title={`Connected to ${apiBaseUrl}`}>
                LOCAL
              </div>
            )}
            <div
              className="HPAG-account-info"
              onMouseEnter={() => setShowAccountModal(true)}
              onMouseLeave={() => setShowAccountModal(false)}
            >
              <i className="fas fa-user-circle"></i>
              {showAccountModal && (
                <div className="HPAG-account-modal">
                  <div className="HPAG-account-modal-item">
                    <div className="HPAG-account-modal-label">STATUS</div>
                    <div className="HPAG-account-modal-value">
                      <span className="HPAG-status-active">Active</span>
                    </div>
                  </div>
                  <div className="HPAG-account-modal-item">
                    <div className="HPAG-account-modal-label">SESSION ID</div>
                    <div className="HPAG-account-modal-value">{getVisitorId() || 'Session unavailable'}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="HPAG-messages-container">
          <div className="HPAG-messages-container-inner">
            {currentMessages.length === 0 ? (
              <div className="HPAG-empty-state">
                <div className="HPAG-empty-icon"><div className="HPAG-orb"></div></div>
                <h3>Start a new conversation</h3>
                <p>Your Human Protein Atlas Agent</p>
              </div>
            ) : (
              messageGroups.map((group, groupIndex) => {
                if (group.type === 'run') {
                  // Render a collapsible tool run container - starts collapsed by default
                  // Detect run type from first message tool name
                  const firstToolEvent = group.messages[0]?.toolEvent;
                  const isInvestigatorRun = firstToolEvent?.toolName === 'investigator_hpa';
                  const isAsoRun = firstToolEvent?.toolName === 'aso_hpa';
                  const runTitle = isAsoRun ? 'ASO Analysis' : isInvestigatorRun ? 'Investigator' : 'Deep Research';

                  // Extract workspace UUID from start.workspace_created event
                  let runWorkspaceUuid = null;
                  if (isAsoRun) {
                    for (const m of group.messages) {
                      const evt = m.toolEvent;
                      if ((evt?.stage || '').toLowerCase() === 'start.workspace_created' && evt?.message) {
                        try { const pd = JSON.parse(evt.message); if (pd.workspace_uuid) { runWorkspaceUuid = pd.workspace_uuid; break; } } catch (_) {}
                      }
                    }
                  }

                  // Get latest step label for shimmer text (identical to HPAG-tool-line-label)
                  const lastStepMsg = (() => {
                    for (let mi = group.messages.length - 1; mi >= 0; mi--) {
                      const evt = group.messages[mi].toolEvent;
                      if (evt && evt.status !== 'started' && evt.status !== 'completed') {
                        return getStepDisplayLabel(evt, isAsoRun);
                      }
                    }
                    return runTitle;
                  })();

                  const isExpanded = collapsedRuns[group.runId] === false;

                  return (
                    <React.Fragment key={group.runId}>
                    <div
                      className={`HPAG-shimmer-bar ${group.isComplete ? 'HPAG-shimmer-done' : ''}`}
                      onClick={() => toggleRunCollapsed(group.runId)}
                    >
                      <span className="HPAG-shimmer-text">
                        {group.isComplete ? `${runTitle} complete` : <>Working<span className="HPAG-shimmer-dot">{'\u00B7'}</span>{lastStepMsg}</>}
                      </span>
                      <FontAwesomeIcon icon={isExpanded ? faChevronDown : faChevronRight} className="HPAG-shimmer-chevron" />
                    </div>
                    {isExpanded && (
                    <div className="HPAG-tool-run-container">
                      <div
                        className="HPAG-tool-run-content"
                        ref={el => { toolRunRefs.current[group.runId] = el; }}
                      >
                        {(() => {
                          // For ASO runs: collapse consecutive measure.invoke direct+scout into single timeline rows
                          if (!isAsoRun) return null;

                          const items = [];
                          let i = 0;
                          while (i < group.messages.length) {
                            const msg = group.messages[i];
                            const evt = msg.toolEvent;
                            const stage = (evt?.stage || '').toLowerCase();
                            let parsed = null;
                            if (evt?.message) { try { parsed = JSON.parse(evt.message); } catch (_) {} }

                            // Skip tokens events entirely
                            if (stage === 'tokens') { i++; continue; }

                            if (stage === 'measure.invoke' && parsed?.mode?.includes('direct+scout')) {
                              // Collect consecutive direct+scout genes
                              const genes = [];
                              const startIdx = i;
                              while (i < group.messages.length) {
                                const m = group.messages[i];
                                const e = m.toolEvent;
                                const s = (e?.stage || '').toLowerCase();
                                let p = null;
                                if (e?.message) { try { p = JSON.parse(e.message); } catch (_) {} }
                                if (s === 'measure.invoke' && p?.mode?.includes('direct+scout')) {
                                  genes.push(p.gene || '?');
                                  i++;
                                } else break;
                              }
                              items.push({ type: 'swarm', genes, id: group.messages[startIdx].id, startIdx });
                            } else {
                              items.push({ type: 'msg', msg, origIdx: i });
                              i++;
                            }
                          }

                          return items.map((item, itemIdx) => {
                            const isFirst = itemIdx === 0;
                            const isLast = itemIdx === items.length - 1;

                            if (item.type === 'swarm') {
                              return (
                                <div key={item.id} className="HPAG-tool-line">
                                  <div className={`HPAG-tool-timeline ${!isFirst ? 'HPAG-has-line-above' : ''} ${!isLast ? 'HPAG-has-line-below' : ''}`}>
                                    <div className="HPAG-tool-timeline-dot" />
                                  </div>
                                  <div className="HPAG-tool-stage-badge HPAG-tool-stage-dispatch">Dispatch</div>
                                  <div className="HPAG-tool-line-body">
                                    <div className="HPAG-tool-line-label">{item.genes.length} agents deployed</div>
                                    <div className="HPAG-aso-swarm-chips">
                                      {item.genes.map((g, gi) => (
                                        <span key={gi} className="HPAG-ASO-tool-option-chip" style={{ animationDelay: `${Math.min(gi * 0.02, 2)}s` }}>{g}</span>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              );
                            }

                            // Normal message — standard timeline rendering
                            const message = item.msg;
                            const msgIndex = item.origIdx;
                            const nextMsg = group.messages[msgIndex + 1];
                            const nextEvent = nextMsg?.type === 'tool' ? (nextMsg.toolEvent) : null;
                            const nextSelections = nextEvent ? extractSelectionsForEvent(nextEvent) : [];
                            const selectionsForThisRow = new Set(nextSelections.map(s => s.toLowerCase().trim()));

                            const toolEvent = message.toolEvent;
                            const toolStageMeta = toolEvent ? stageMetaFor(toolEvent) : null;
                            const stageBadgeClass = toolStageMeta?.css ? `HPAG-tool-stage-${toolStageMeta.css}` : '';
                            const toolMetaLine = toolEvent
                              ? [toolStageMeta?.description || null, toolEvent.toolName || null].filter(Boolean).join(' • ')
                              : '';
                            const toolOptions = toolEvent ? extractOptionsForEvent(toolEvent) : [];
                            const toolSelections = toolEvent ? extractSelectionsForEvent(toolEvent) : [];
                            const hasScanVisual = toolEvent?.meta?.visual === 'scan';
                            const hasUrl = toolEvent?.meta?.url;
                            const shouldShowToolMessage = toolEvent?.message && toolOptions.length === 0 && toolSelections.length === 0 && !hasScanVisual && !hasUrl;

                            // ASO label + chip overrides
                            let displayLabel = titleCase(toolEvent?.label || toolStageMeta?.label || 'Update');
                            let displayBadge = toolStageMeta?.label || 'Info';
                            const evtStage = (toolEvent?.stage || '').toLowerCase();
                            let asoChips = [];
                            let asoTextContent = null;
                            if (toolEvent?.message) {
                              try {
                                const d = JSON.parse(toolEvent.message);
                                if (evtStage === 'think' && d.text) {
                                  displayBadge = 'Think';
                                  displayLabel = 'Planning';
                                  asoTextContent = d.text;
                                } else if (evtStage === 'measure.scout') {
                                  displayLabel = `Calibrating ${d.gene || '?'} · ${d.tissue || '?'}`;
                                  const fieldMap = {
                                    gene: { label: 'Gene', icon: faDna },
                                    tissue: { label: 'Tissue', icon: faMicroscope },
                                    page: { label: 'Page', icon: faFileCode }
                                  };
                                  for (const [key, meta] of Object.entries(fieldMap)) {
                                    if (d[key] !== undefined && d[key] !== null && d[key] !== '') {
                                      asoChips.push({ label: meta.label, icon: meta.icon, value: String(d[key]) });
                                    }
                                  }
                                } else if (evtStage === 'measure.scout_result') {
                                  displayLabel = d.exact_label ? `Found ${d.exact_label}` : `Result · ${d.gene || '?'}`;
                                  const fieldMap = {
                                    gene: { label: 'Gene', icon: faDna },
                                    chart_id: { label: 'Chart ID', icon: faChartBar },
                                    exact_label: { label: 'Label', icon: faTag },
                                    value: { label: 'Value', icon: faHashtag }
                                  };
                                  for (const [key, meta] of Object.entries(fieldMap)) {
                                    if (d[key] !== undefined && d[key] !== null && d[key] !== '') {
                                      asoChips.push({ label: meta.label, icon: meta.icon, value: String(d[key]) });
                                    }
                                  }
                                } else if (evtStage === 'measure.batch') {
                                  displayBadge = 'Target';
                                  displayLabel = 'Batch Data Acquisition';
                                  const fieldMap = {
                                    count: { label: 'Count', icon: faHashtag },
                                    tissue: { label: 'Tissue', icon: faMicroscope },
                                    mode: { label: 'Mode', icon: faTag },
                                    label: { label: 'Label', icon: faTag }
                                  };
                                  for (const [key, meta] of Object.entries(fieldMap)) {
                                    if (d[key] !== undefined && d[key] !== null && d[key] !== '') {
                                      asoChips.push({ label: meta.label, icon: meta.icon, value: String(d[key]) });
                                    }
                                  }
                                } else if (evtStage === 'tool.invoke' && d.name) {
                                  displayBadge = 'Agent';
                                  displayLabel = `Invoking ${titleCase(d.name.replace(/_/g, ' '))}`;
                                  const argIcons = { tissue: faMicroscope, page: faFileCode, value_type: faHashtag, unit: faHashtag, gene: faDna, chart_type: faChartBar, mode: faTag, label: faTag, top_x: faHashtag, dataset_id: faFileCode, dataset_a: faFileCode, dataset_b: faFileCode, source_ids: faFileCode, source_dataset: faFileCode };
                                  const artifactArgKeys = new Set(['dataset_id', 'dataset_a', 'dataset_b', 'source_dataset', 'source_ids']);
                                  if (d.args) {
                                    for (const [key, val] of Object.entries(d.args)) {
                                      if (val === null || val === undefined || val === '') continue;
                                      const lbl = titleCase(key.replace(/_/g, ' '));
                                      if (Array.isArray(val)) {
                                        for (const item of val) {
                                          if (item && typeof item === 'object') {
                                            const chip = { label: lbl, icon: argIcons[key] || faTag, value: item.label || item.dataset_id || JSON.stringify(item) };
                                            if (item.dataset_id) { chip.artifactId = item.dataset_id; chip.format = 'json'; }
                                            asoChips.push(chip);
                                          } else {
                                            const chip = { label: lbl, icon: argIcons[key] || faTag, value: String(item) };
                                            if (artifactArgKeys.has(key)) { chip.artifactId = String(item); chip.format = 'json'; }
                                            asoChips.push(chip);
                                          }
                                        }
                                      } else {
                                        const chip = { label: lbl, icon: argIcons[key] || faTag, value: String(val) };
                                        if (artifactArgKeys.has(key)) { chip.artifactId = String(val); chip.format = 'json'; }
                                        asoChips.push(chip);
                                      }
                                    }
                                  }
                                } else if (evtStage === 'tool.result' && d.name) {
                                  displayLabel = 'Tool Result';
                                  const resultIcons = { ok: faCheckCircle, artifact_id: faFileCode, rows_found: faHashtag, row_count: faHashtag, search_url: faSearch, validation_passed: faCheckCircle, chart_count: faChartBar, type: faTag, title: faTag, images_rendered: faChartBar, label: faTag, numeric_count: faHashtag, mode: faTag, investigator_calls: faHashtag, page_fetches: faHashtag };
                                  const skipKeys = new Set(['name', 'datasets', 'sample', 'scout', 'top_3']);
                                  for (const [key, val] of Object.entries(d)) {
                                    if (skipKeys.has(key) || val === null || val === undefined || val === '') continue;
                                    const lbl = titleCase(key.replace(/_/g, ' '));
                                    if (typeof val === 'boolean') {
                                      asoChips.push({ label: lbl, icon: resultIcons[key] || faTag, value: val ? 'Yes' : 'No' });
                                    } else if (typeof val === 'object') {
                                      continue;
                                    } else {
                                      const chip = { label: lbl, icon: resultIcons[key] || faTag, value: String(val) };
                                      if (key === 'artifact_id') {
                                        chip.artifactId = String(val);
                                        chip.format = (d.images_rendered || d.type === 'heatmap' || d.type === 'bar' || d.type === 'scatter') ? 'json' : 'json';
                                      }
                                      asoChips.push(chip);
                                    }
                                  }
                                  if (d.datasets && Array.isArray(d.datasets)) {
                                    for (const ds of d.datasets) {
                                      asoChips.push({ label: 'Dataset', icon: faCubes, value: ds.label || 'Untitled' });
                                      if (ds.row_count !== undefined) {
                                        asoChips.push({ label: 'Rows', icon: faHashtag, value: String(ds.row_count) });
                                      }
                                      if (ds.sample_genes?.length) {
                                        asoChips.push({ label: 'Sample', icon: faDna, value: ds.sample_genes.slice(0, 3).join(', ') + (ds.sample_genes.length > 3 ? '…' : '') });
                                      }
                                    }
                                  }
                                } else if (evtStage === 'state.snapshot') {
                                  displayLabel = 'State Snapshot';
                                  const countIcons = { tool_results: faCheckCircle, datasets: faCubes, measurements: faHashtag, analyses: faList, charts: faChartBar };
                                  if (d.counts) {
                                    for (const [key, val] of Object.entries(d.counts)) {
                                      const lbl = titleCase(key.replace(/_/g, ' '));
                                      asoChips.push({ label: lbl, icon: countIcons[key] || faTag, value: String(val) });
                                    }
                                  }
                                } else if (evtStage === 'start.workspace_created') {
                                  displayLabel = 'Workspace Initialized';
                                  if (d.workspace_uuid) {
                                    asoChips.push({ label: 'Workspace', icon: faFileCode, value: d.workspace_uuid });
                                  }
                                } else if (evtStage === 'final.complete' && d.summary) {
                                  displayLabel = 'Completion';
                                  asoTextContent = d.summary;
                                } else if (evtStage === 'final.report') {
                                  displayLabel = 'Compiling Report';
                                  if (d.report_written) {
                                    asoChips.push({ label: 'Status', icon: faCheckCircle, value: 'OK' });
                                  }
                                } else if (evtStage === 'understand.objective' && d.objective) {
                                  displayBadge = 'Think';
                                  displayLabel = 'Understanding Objective';
                                  asoTextContent = d.objective;
                                }
                              } catch (_) {}
                            }

                            return (
                              <div key={message.id} className="HPAG-tool-line">
                                <div className={`HPAG-tool-timeline ${!isFirst ? 'HPAG-has-line-above' : ''} ${!isLast ? 'HPAG-has-line-below' : ''}`}>
                                  <div className="HPAG-tool-timeline-dot" />
                                </div>
                                <div className={`HPAG-tool-stage-badge ${stageBadgeClass}`}>
                                  {displayBadge}
                                </div>
                                <div className="HPAG-tool-line-body">
                                  <div className="HPAG-tool-line-label">
                                    {displayLabel}
                                  </div>
                                  {hasUrl && (
                                    <a href={toolEvent.meta.url} target="_blank" rel="noopener noreferrer" className="HPAG-navigate-box">
                                      <FontAwesomeIcon icon={faExternalLinkAlt} className="HPAG-navigate-box-icon" />
                                      <span className="HPAG-navigate-box-page">{toolEvent.message || 'Page'}</span>
                                    </a>
                                  )}
                                  {hasScanVisual && (
                                    <div className="HPAG-scan-box">
                                      <div className="HPAG-scan-box-icon"><FontAwesomeIcon icon={faSearch} /></div>
                                      <span className="HPAG-scan-box-text">{toolEvent.message || 'Searching...'}</span>
                                    </div>
                                  )}
                                  {asoTextContent ? (
                                    <div className="HPAG-aso-think-text" style={{ whiteSpace: 'pre-line', fontSize: '12px', color: '#374151', marginTop: '4px', lineHeight: '1.5' }}>{asoTextContent}</div>
                                  ) : asoChips.length > 0 ? (
                                    <div className="HPAG-tool-options-row">
                                      {asoChips.sort((a, b) => a.value.length - b.value.length).map((chip, ci) => (
                                        <span key={ci} className="HPAG-aso-chip-group">
                                          <span className="HPAG-aso-chip-label">{chip.label}</span>
                                          <span
                                            className={`HPAG-aso-data-chip ${chip.artifactId ? 'HPAG-aso-data-chip-artifact' : ''}`}
                                            onMouseEnter={chip.artifactId ? (e) => handleArtifactChipEnter(e, chip, runWorkspaceUuid) : undefined}
                                            onMouseLeave={chip.artifactId ? handleArtifactChipLeave : undefined}
                                          >
                                            <FontAwesomeIcon icon={chip.icon} style={{ marginRight: '3px', fontSize: '10px' }} />{chip.value}
                                          </span>
                                        </span>
                                      ))}
                                    </div>
                                  ) : shouldShowToolMessage ? (
                                    <div className="HPAG-tool-line-message">{linkifyInline(toolEvent.message)}</div>
                                  ) : null}
                                  {toolOptions.length > 0 && (
                                    <div className="HPAG-tool-options-row">
                                      {toolOptions.map((opt, idx) => {
                                        const isSelected = selectionsForThisRow.has(opt.toLowerCase().trim());
                                        return (
                                          <span key={idx} className={`HPAG-tool-option-chip ${isSelected ? 'HPAG-selected' : ''}`}>{titleCase(opt)}</span>
                                        );
                                      })}
                                    </div>
                                  )}
                                  {toolSelections.length > 0 && (
                                    <div className="HPAG-tool-selections-row">
                                      {toolSelections.map((sel, idx) => (
                                        <span key={idx} className="HPAG-tool-selection-chip" style={{ animationDelay: `${idx * 0.1}s` }}>{titleCase(sel)}</span>
                                      ))}
                                    </div>
                                  )}
                                  {toolMetaLine && (
                                    <div className="HPAG-tool-line-meta">{toolMetaLine}</div>
                                  )}
                                </div>
                              </div>
                            );
                          });
                        })()}
                        {/* Non-ASO runs: original per-message timeline */}
                        {!isAsoRun && group.messages.map((message, msgIndex) => {
                          const nextMsg = group.messages[msgIndex + 1];
                          const nextEvent = nextMsg?.type === 'tool' ? (nextMsg.toolEvent) : null;
                          const nextSelections = nextEvent ? extractSelectionsForEvent(nextEvent) : [];
                          const selectionsForThisRow = new Set(nextSelections.map(s => s.toLowerCase().trim()));

                          const toolEvent = message.toolEvent;
                          const toolStageMeta = toolEvent ? stageMetaFor(toolEvent) : null;
                          const stageBadgeClass = toolStageMeta?.css ? `HPAG-tool-stage-${toolStageMeta.css}` : '';
                          const toolMetaLine = toolEvent
                            ? [toolStageMeta?.description || null, toolEvent.toolName || null].filter(Boolean).join(' • ')
                            : '';
                          const toolOptions = toolEvent ? extractOptionsForEvent(toolEvent) : [];
                          const toolSelections = toolEvent ? extractSelectionsForEvent(toolEvent) : [];
                          const hasScanVisual = toolEvent?.meta?.visual === 'scan';
                          const hasUrl = toolEvent?.meta?.url;
                          const shouldShowToolMessage = toolEvent?.message && toolOptions.length === 0 && toolSelections.length === 0 && !hasScanVisual && !hasUrl;

                          return (
                            <div key={message.id} className="HPAG-tool-line">
                              <div className={`HPAG-tool-timeline ${msgIndex > 0 ? 'HPAG-has-line-above' : ''} ${msgIndex < group.messages.length - 1 ? 'HPAG-has-line-below' : ''}`}>
                                <div className="HPAG-tool-timeline-dot" />
                              </div>
                              <div className={`HPAG-tool-stage-badge ${stageBadgeClass}`}>
                                {toolStageMeta?.label || 'Info'}
                              </div>
                              <div className="HPAG-tool-line-body">
                                <div className="HPAG-tool-line-label">
                                  {titleCase(toolEvent?.label || toolStageMeta?.label || 'Update')}
                                </div>
                                {hasUrl && (
                                  <a href={toolEvent.meta.url} target="_blank" rel="noopener noreferrer" className="HPAG-navigate-box">
                                    <FontAwesomeIcon icon={faExternalLinkAlt} className="HPAG-navigate-box-icon" />
                                    <span className="HPAG-navigate-box-page">{toolEvent.message || 'Page'}</span>
                                  </a>
                                )}
                                {hasScanVisual && (
                                  <div className="HPAG-scan-box">
                                    <div className="HPAG-scan-box-icon"><FontAwesomeIcon icon={faSearch} /></div>
                                    <span className="HPAG-scan-box-text">{toolEvent.message || 'Searching...'}</span>
                                  </div>
                                )}
                                {shouldShowToolMessage && (
                                  <div className="HPAG-tool-line-message">{linkifyInline(toolEvent.message)}</div>
                                )}
                                {toolOptions.length > 0 && (
                                  <div className="HPAG-tool-options-row">
                                    {toolOptions.map((opt, idx) => {
                                      const isSelected = selectionsForThisRow.has(opt.toLowerCase().trim());
                                      return (
                                        <span key={idx} className={`HPAG-tool-option-chip ${isSelected ? 'HPAG-selected' : ''}`}>{titleCase(opt)}</span>
                                      );
                                    })}
                                  </div>
                                )}
                                {toolSelections.length > 0 && (
                                  <div className="HPAG-tool-selections-row">
                                    {toolSelections.map((sel, idx) => (
                                      <span key={idx} className="HPAG-tool-selection-chip" style={{ animationDelay: `${idx * 0.1}s` }}>{titleCase(sel)}</span>
                                    ))}
                                  </div>
                                )}
                                {toolMetaLine && (
                                  <div className="HPAG-tool-line-meta">{toolMetaLine}</div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    )}
                    {/* ASO charts + download button outside run container */}
                    {isAsoRun && (() => {
                      const charts = [];
                      let lastChartInvokeSource = null;
                      for (const m of group.messages) {
                        const evt = m.toolEvent;
                        const st = (evt?.stage || '').toLowerCase();
                        if (st === 'tool.invoke' && evt?.message) {
                          try { const iv = JSON.parse(evt.message); if (iv.name === 'chart') lastChartInvokeSource = iv.args?.source_dataset || null; } catch (_) {}
                        }
                        if (st === 'tool.result' && evt?.message) {
                          try {
                            const rd = JSON.parse(evt.message);
                            if (rd.name === 'chart' && rd.artifact_id) {
                              charts.push({ artifactId: rd.artifact_id, title: rd.title || '', sourceDatasetId: lastChartInvokeSource });
                              lastChartInvokeSource = null;
                            }
                          } catch (_) {}
                        }
                      }
                      if (!charts.length && !(group.isComplete && runWorkspaceUuid)) return null;
                      return (
                        <>
                          {charts.length > 0 && runWorkspaceUuid && (
                            <div className="HPAG-aso-run-charts">
                              {charts.map((c, ci) => (
                                <AsoChart key={c.artifactId || ci} apiBaseUrl={apiBaseUrl} workspaceUuid={runWorkspaceUuid} artifactId={c.artifactId} title={c.title} sourceDatasetId={c.sourceDatasetId} onArtifactEnter={handleArtifactChipEnter} onArtifactLeave={handleArtifactChipLeave} />
                              ))}
                            </div>
                          )}
                          {group.isComplete && runWorkspaceUuid && (
                            <button
                              type="button"
                              onClick={() => downloadWorkspace(runWorkspaceUuid)}
                              className="HPAG-tool-run-download"
                            >
                              <FontAwesomeIcon icon={faDownload} /> Download Workspace
                            </button>
                          )}
                        </>
                      );
                    })()}
                    </React.Fragment>
                  );
                } else {
                  // Render a normal message
                  const message = group.message;
                  const index = group.index;
                  const isLastMessage = index === currentMessages.length - 1;
                  const showActions = message.type === 'ai' && message.text !== '' && !(isLoading && isLastMessage);
                  const showLoadingDot = isLoading && isLastMessage && message.type === 'ai' && message.text === '';
                  const hpaUrls = message.type === 'ai' ? extractHPAUrls(message.text) : [];

                  // Parse reply context from message - always extract from text to get clean display
                  const extractedReply = extractReplyContext(message.text);
                  const replyCtx = extractedReply || message.replyContext;
                  const displayText = extractedReply ? extractedReply.textWithoutReply : message.text;

                  return (
                    <React.Fragment key={message.id}>
                      {/* Show reply context above user message */}
                      {message.type === 'user' && replyCtx && (
                        <div className="HPAG-message-reply-context">
                          <FontAwesomeIcon icon={faReply} className="HPAG-message-reply-icon" />
                          <span>Re: <strong>{replyCtx.geneName}</strong> <span className="HPAG-message-reply-ensg">{replyCtx.ensg}</span></span>
                        </div>
                      )}
                      <div
                        className={`HPAG-message HPAG-message-${message.type} ${isLastMessage && !message.searchUrl ? 'HPAG-message-last' : ''}`}
                      >
                        <div className="HPAG-message-avatar">
                          {message.type === 'user' ? (
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                              <path d="M8 8a3 3 0 100-6 3 3 0 000 6zm2-3a2 2 0 11-4 0 2 2 0 014 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z"/>
                            </svg>
                          ) : null}
                        </div>
                        <div className="HPAG-message-content">
                          {showLoadingDot && (<div className="HPAG-loading-dot"></div>)}
                          {/* Render investigator resources ABOVE the synthesis message */}
                          {message.type === 'ai' && message.resources && message.resources.length > 0 && (
                            <div className="HPAG-resources-used HPAG-resources-above">
                              <div className="HPAG-resources-used-label">Resources Used</div>
                              <div className="HPAG-resources-used-links">
                                {message.resources.map((res, idx) => (
                                  <a
                                    key={idx}
                                    href={res.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="HPAG-resources-used-link"
                                  >
                                    <span className="HPAG-resources-used-num">{idx + 1}</span>
                                    <span className="HPAG-resources-used-name">{res.label || 'Page'}</span>
                                    <FontAwesomeIcon icon={faExternalLinkAlt} className="HPAG-resources-used-icon" />
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}
                          <div className="HPAG-message-text">
                            {message.type === 'ai' ? (
                              <ReactMarkdown>{message.text}</ReactMarkdown>
                            ) : (
                              displayText
                            )}
                          </div>
                            {hpaUrls.length > 0 && (
                            <div className="HPAG-url-references">
                              {hpaUrls.map((urlData, idx) => (
                                <a
                                  key={idx}
                                  href={urlData.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="HPAG-url-reference-box"
                                >
                                  <FontAwesomeIcon icon={urlData.icon} className="HPAG-url-reference-icon" />
                                  <span className="HPAG-url-reference-label">{urlData.label}</span>
                                </a>
                              ))}
                            </div>
                          )}
                          <div className="HPAG-message-footer">
                            {showActions && (
                              <div className="HPAG-message-actions">
                                <button className="HPAG-action-btn" onClick={() => navigator.clipboard.writeText(message.text)} title="Copy">
                                  <FontAwesomeIcon icon={faCopy} />
                                </button>
                                <button className="HPAG-action-btn" title="Good response">
                                  <FontAwesomeIcon icon={faThumbsUp} />
                                </button>
                                <button className="HPAG-action-btn" title="Bad response">
                                  <FontAwesomeIcon icon={faThumbsDown} />
                                </button>
                              </div>
                            )}
                            <div className="HPAG-message-timestamp">{message.timestamp}</div>
                          </div>
                        </div>
                      </div>
                      {/* Render search results full-width, outside the message bubble */}
                      {message.searchUrl && (
                        <SearchResultsView searchUrl={message.searchUrl} />
                      )}
                      {/* Render dictionary tissue images carousel */}
                      {message.dictionaryImages && message.dictionaryImages.images?.length > 0 && (
                        <DictionaryCarousel dictionaryImages={message.dictionaryImages} />
                      )}
                    </React.Fragment>
                  );
                }
              })
            )}
            <div ref={messagesEndRef} className="HPAG-messages-end-spacer" />
          </div>
        </div>

        {replyTo && (
          <div className="HPAG-reply-bar">
            <FontAwesomeIcon icon={faReply} className="HPAG-reply-bar-icon" />
            <span className="HPAG-reply-bar-text">
              Asking about <strong>{replyTo.geneName}</strong> <span className="HPAG-reply-bar-ensg">{replyTo.ensg}</span>
            </span>
            <button className="HPAG-reply-bar-close" onClick={() => setReplyTo(null)} title="Remove">
              <FontAwesomeIcon icon={faTimes} />
            </button>
          </div>
        )}
        <div className="HPAG-input-area">
          <input
            ref={inputRef}
            type="text"
            className="HPAG-input"
            placeholder="Ask your Human Protein Atlas Agent..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            disabled={isLoading}
          />
          <button className="HPAG-send-btn" onClick={handleSend} disabled={isLoading}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M15.854 7.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708-.708L14.293 8.5H.5a.5.5 0 0 1 0-1h13.793L8.146 1.354a.5.5 0 1 1 .708-.708l7 7z"/>
            </svg>
          </button>
        </div>
      </div>
      {artifactPreview && (
        <div
          className="HPAG-artifact-popover"
          style={{
            position: 'fixed',
            top: artifactPreview.rect.top - 8,
            left: artifactPreview.rect.left + artifactPreview.rect.width / 2,
            transform: 'translate(-50%, -100%)',
            zIndex: 200
          }}
          onMouseEnter={handlePopoverEnter}
          onMouseLeave={handleArtifactChipLeave}
        >
          <div className="HPAG-artifact-popover-header">
            <span className="HPAG-artifact-popover-title">
              {artifactPreview.format === 'png' ? 'Chart Preview' : 'Artifact Preview'}
            </span>
            <div className="HPAG-artifact-popover-actions">
              {artifactPreview.data?.type === 'json' && (
                <button className="HPAG-artifact-popover-toggle" onClick={toggleArtifactRawView}>
                  {artifactPreview.showRaw ? 'Pretty' : 'Raw'}
                </button>
              )}
              <button
                type="button"
                onClick={() => downloadArtifact(artifactPreview)}
                className="HPAG-artifact-popover-download"
                title="Download artifact"
              >
                <FontAwesomeIcon icon={faDownload} />
              </button>
            </div>
          </div>
          <div className="HPAG-artifact-popover-body">
            {artifactPreview.loading && (
              <div className="HPAG-artifact-popover-loading"><FontAwesomeIcon icon={faSpinner} spin /> Loading...</div>
            )}
            {artifactPreview.error && (
              <div className="HPAG-artifact-popover-error">Failed to load artifact</div>
            )}
            {artifactPreview.data?.type === 'image' && (
              <img src={artifactPreview.data.url} alt="Chart" className="HPAG-artifact-popover-image" />
            )}
            {artifactPreview.data?.type === 'json' && !artifactPreview.showRaw && renderArtifactTable(artifactPreview.data.json)}
            {artifactPreview.data?.type === 'json' && artifactPreview.showRaw && (
              <pre className="HPAG-artifact-popover-raw">{JSON.stringify(artifactPreview.data.json, null, 2)}</pre>
            )}
            {artifactPreview.data?.type === 'markdown' && (
              <ReactMarkdown>{artifactPreview.data.text}</ReactMarkdown>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default HPA;
