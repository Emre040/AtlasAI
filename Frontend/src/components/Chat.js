import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import './Chat.css';
import ReactMarkdown from 'react-markdown';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCopy,
  faBars,
  faThumbsUp,
  faThumbsDown,
  faMagnifyingGlass,
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
  faDownload
} from '@fortawesome/free-solid-svg-icons';
import {
  authenticatedDownload,
  authenticatedFetch,
  getVisitorId,
  initializeHPAAuth
} from '../api/auth';
import { getApiBaseUrl, getApiEndpoint, getRuntimeConfig, getUiConfig } from '../api/config';
import { AUTO_MODEL, describeRefusal, loadSelectedModel, storeSelectedModel } from '../api/models';
import ModelMenu from './ModelMenu';
import StudyOutputs from './StudyOutputs';
import StudyAnswer from './StudyAnswer';
import { studyRunsById } from './studyCitations';
import StudyRun, { studyStatusLine } from './StudyRun';
import { liveToolEventFromSse, timelineToUiMessages } from '../api/timeline';
import DictionaryCarousel from './DictionaryCarousel';
import Questionnaire from './Questionnaire';
import ReaderPanel, { readerLiveNext } from './ReaderPanel';
import {hpaIcon} from "../assets/icons/hpaIcon";

const RUNTIME_CONFIG = getRuntimeConfig();
const UI_CONFIG = getUiConfig();
const debugLog = (...args) => {
  if (RUNTIME_CONFIG.isLocal) console.log(...args);
};

function HPA() {
  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  // 'auto' follows the platform's active model; anything else is an inference_models config_key.
  const [selectedModel, setSelectedModel] = useState(loadSelectedModel);
  const chooseModel = useCallback(configKey => {
    setSelectedModel(configKey);
    storeSelectedModel(configKey);
  }, []);
  const [collapsedRuns, setCollapsedRuns] = useState({}); // Track collapsed state per runId
  const [studySelection, setStudySelection] = useState(null);
  const [searchResults, setSearchResults] = useState({}); // Map of searchUrl -> { rows, loading, error, totalCount, thumbnails }
  const [replyTo, setReplyTo] = useState(null); // { ensg, geneName } for reply context
  const messagesEndRef = useRef(null);
  const historyDialogRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef(null);
  const toolRunRefs = useRef({}); // Refs for auto-scroll within each run container
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
    start: { label: 'Start', css: 'start', description: 'Agent activated.' },
    planning_step: { label: 'Plan', css: 'planning', description: 'Reading the schema.' },
    reasoning_step: { label: 'Think', css: 'reasoning', description: 'Weighing the options.' },
    selection_step: { label: 'Select', css: 'selection', description: 'Choice made.' },
    execution_step: { label: 'Run', css: 'execution', description: 'Executing.' },
    fallback: { label: 'Fallback', css: 'fallback', description: 'Trying backup.' },
    error: { label: 'Error', css: 'error', description: 'Issue detected.' },
    complete: { label: 'Done', css: 'complete', description: 'Complete.' },
    not_found: { label: 'Not found', css: 'fallback', description: 'No answer in the data.' },
    info: { label: 'Info', css: 'info', description: 'Status update.' }
  };

  const stageMetaFor = (event = {}) => {
    if (!event) return TOOL_STAGE_META.info;
    if (event.status === 'started') return TOOL_STAGE_META.start;
    if (event.status === 'completed') return TOOL_STAGE_META.complete;
    const key = (event.stage || '').toLowerCase();
    return TOOL_STAGE_META[key] || TOOL_STAGE_META.info;
  };

  // Compute the display label for a tool event (shared by shimmer + timeline)
  const getStepDisplayLabel = (evt) => {
    if (!evt) return 'Update';
    const meta = stageMetaFor(evt);
    return titleCase(evt.label || meta?.label || 'Update');
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
    const knownSubPages = ['/single+cell', '/cell+line'];
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
          icon: faMagnifyingGlass
        };
      }

      // Parse the URL to determine the type
      let type = 'summary';
      let label = 'Summary';
      let icon = hpaIcon;

      // Check if it's an ENSG protein page (e.g., ENSG00000121410-A1BG)
      const ensgMatch = url.match(/ENSG\d+-([A-Z0-9]+)/);
      if (ensgMatch && !url.includes('/tissue') && !url.includes('/brain') && !url.includes('/single+cell') &&
          !url.includes('/subcellular') && !url.includes('/cancer') && !url.includes('/blood') &&
          !url.includes('/cell+line') && !url.includes('/structure') && !url.includes('/interaction')) {
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
      } else if (url.includes('/structure')) {
        type = 'structure';
        label = 'Structure';
        icon = faNetworkWired;
      } else if (url.includes('/interaction')) {
        type = 'interaction';
        label = 'Interaction';
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
      [searchUrl]: { loading: true, rows: null, error: null, thumbnails: {} }
    }));

    try {
      const response = await authenticatedFetch(
        `${getApiEndpoint('hpaSearchResults')}?url=${encodeURIComponent(searchUrl)}`
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      setSearchResults(prev => ({
        ...prev,
        [searchUrl]: { loading: false, rows: data.rows || [], totalCount: data.totalCount, error: null, thumbnails: {} }
      }));
    } catch (err) {
      console.error('[FE] Failed to fetch search results:', err);
      setSearchResults(prev => ({
        ...prev,
        [searchUrl]: { loading: false, rows: null, error: err.message, thumbnails: {} }
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
    { key: 'structure', label: 'Structure', color: '#69008c' },
    { key: 'interaction', label: 'Interaction', color: '#c89c79' }
  ];

  // Render search results: the first rows with their thumbnails, and a link to the rest on HPA.
  const SearchResultsView = ({ searchUrl }) => {
    const data = searchResults[searchUrl];
    const SHOWN_ROWS = 5;

    // Trigger fetch on mount if not already loaded
    useEffect(() => {
      if (searchUrl && !data) {
        fetchSearchResults(searchUrl);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchUrl]);

    // Fetch thumbnails for the shown rows only
    useEffect(() => {
      if (data?.rows && !data.loading) {
        const geneIds = data.rows.slice(0, SHOWN_ROWS).map(r => r.Ensembl || r.Gene).filter(Boolean);
        fetchThumbnails(searchUrl, geneIds);
      }
    }, [searchUrl, data?.loading, data?.rows]);

    if (!data || data.loading) {
      return (
        <div className="HPAG-search-results HPAG-search-results-loading">
          <div className="HPAG-search-results-table">
            {[...Array(SHOWN_ROWS)].map((_, i) => (
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

    const visibleRows = data.rows.slice(0, SHOWN_ROWS);
    const moreCount = data.rows.length - visibleRows.length;

    return (
      <div className="HPAG-search-results">
        <div className="HPAG-search-results-table">
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
        {moreCount > 0 && (
          <div className="HPAG-search-results-footer">
            <a href={searchUrl} target="_blank" rel="noopener noreferrer" className="HPAG-search-results-more">
              <span>View <strong>{moreCount}</strong> more</span>
              <FontAwesomeIcon icon={faExternalLinkAlt} />
            </a>
          </div>
        )}
      </div>
    );
  };

  useEffect(() => {
    if (!isLoading && inputRef.current) inputRef.current.focus();
  }, [isLoading, selectedConversation]);

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
  const studyRuns = useMemo(() => studyRunsById(currentMessages), [currentMessages]);

  useEffect(() => {
    stickToBottomRef.current = true;
    setStudySelection(null);
  }, [selectedConversation]);

  const selectStudyArtifact = (runId, artifactId) => {
    stickToBottomRef.current = false;
    setStudySelection({ runId, artifactId });
  };
  useEffect(() => {
    const dialog = historyDialogRef.current;
    if (historyOpen) dialog.showModal();
    else if (dialog.open) dialog.close();
  }, [historyOpen]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 800px)');
    const closeOnDesktop = event => { if (event.matches) setHistoryOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  useEffect(() => {
    if (stickToBottomRef.current) messagesEndRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
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

  // Sends the typed input, or a given text (the answers of a clarification questionnaire).
  const handleSend = async (override) => {
    const textToSend = typeof override === 'string' ? override : inputValue;
    if (textToSend.trim() === '' || isLoading) return;

    const now = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    let conversationId = selectedConversation;
    const draftTitle = buildTitleFromText(textToSend) || 'New Conversation';

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
      ? `⟪HPA▸GENE:${replyTo.ensg}:${replyTo.geneName}⟫ ${textToSend}`
      : textToSend;
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
      let responseRunId = null;
      let pendingResources = null; // Store resources until final answer bubble is created
      let pendingQuestionnaire = null; // Clarification questions, shown under the final answer bubble

      debugLog(`[FE] POST queryStream… Initial AI bubble ID: ${currentAiMessageId}`);
      const response = await authenticatedFetch(getApiEndpoint('queryStream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: queryText,
          conversationId,
          ...(selectedModel !== AUTO_MODEL ? { model: selectedModel } : {})
        })
      });
      if (!response.ok) {
        // Policy refusals arrive as JSON before any stream starts; show their message verbatim.
        const refusal = await describeRefusal(response);
        throw Object.assign(new Error(refusal ? refusal.message : `HTTP ${response.status}`), { userMessage: refusal?.message || null });
      }
      if (!response.body) throw new Error('The response had no body.');

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
            // This request's completed tool names the run that produces its answer.
            // Retain that exact ID, just as hydrated messages retain run_id.
            if (payload.tool.status === 'completed') responseRunId = payload.tool.run_id;
            // The backend names the run; live lines and reloaded lines share that id.
            // A clarification shows as its card, a reader run as its own panel, not as tool lines.
            if (payload.tool.mode === 'reader') {
              const targetAiMessageId = currentAiMessageId; const t = payload.tool;
              setConversations(convs => convs.map(conv => {
                if (conv.id !== conversationId) return conv;
                return { ...conv, messages: conv.messages.map(m => m.id === targetAiMessageId ? { ...m, readerLive: readerLiveNext(m.readerLive, t) } : m) };
              }));
              continue;
            }
            if (payload.tool.name !== 'clarify_hpa') pushToolLine(liveToolEventFromSse(payload.tool), conversationId);
            continue;
          }

          // The reader's verified quotes, rendered as cards on the bubble that showed the reading.
          if (payload.reader) {
            const targetAiMessageId = currentAiMessageId; const reader = payload.reader;
            setConversations(convs => convs.map(conv => {
              if (conv.id !== conversationId) return conv;
              return { ...conv, messages: conv.messages.map(m => m.id === targetAiMessageId ? { ...m, reader } : m) };
            }));
            continue;
          }

          if (payload.token) {
            if (toolHasRun && !finalAnswerBubbleCreated) {
              debugLog('[FE] First token after tool run. Creating new AI bubble.');
              const finalAnswerId = Date.now() + Math.random();

              const newMessage = { id: finalAnswerId, type: 'ai', text: '', timestamp: now(), runId: responseRunId };
              if (pendingResources) {
                newMessage.resources = pendingResources;
                debugLog('[FE] Attaching pending resources to final answer bubble');
                pendingResources = null;
              }
              if (pendingQuestionnaire) {
                newMessage.questionnaire = pendingQuestionnaire;
                pendingQuestionnaire = null;
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

          // Clarification questions arrive before the answer text; they attach to the final bubble.
          if (payload.questionnaire) {
            debugLog('[FE] Received questionnaire:', payload.questionnaire);
            if (toolHasRun && !finalAnswerBubbleCreated) {
              pendingQuestionnaire = payload.questionnaire;
            } else {
              const targetAiMessageId = currentAiMessageId;
              setConversations(convs => convs.map(conv => {
                if (conv.id !== conversationId) return conv;
                return { ...conv, messages: conv.messages.map(m => m.id === targetAiMessageId ? { ...m, questionnaire: payload.questionnaire } : m) };
              }));
            }
            continue;
          }

          if (payload.done) {
            isStreamFinished = true;
            if (pendingQuestionnaire) {   // no answer text came; show the cards under the last bubble
              const targetAiMessageId = currentAiMessageId; const questionnaire = pendingQuestionnaire; pendingQuestionnaire = null;
              setConversations(convs => convs.map(conv => {
                if (conv.id !== conversationId) return conv;
                return { ...conv, messages: conv.messages.map(m => m.id === targetAiMessageId ? { ...m, questionnaire } : m) };
              }));
            }
          }
        }

        if (isStreamFinished) { break; }
      }
    } catch (err) {
      console.error('Failed to stream message:', err);
      const errorMessage = {
        id: Date.now() + 2,
        type: 'ai',
        text: err?.userMessage || 'Sorry, there was an error connecting to the server. Please try again.',
        timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      };
      setConversations(convs => convs.map(conv =>
        conv.id === conversationId ? { ...conv, messages: [...conv.messages, errorMessage] } : conv
      ));
    } finally {
      setIsLoading(false);
    }
  };

  const historyContent = (
    <>
        <div className="HPAG-sidebar-logo">
          <img src="https://www.proteinatlas.org/images_static/logo.svg" alt="Human Protein Atlas" />
        </div>
        <div className="HPAG-sidebar-header">
          <h2>Conversations</h2>
          <button className="HPAG-new-chat-btn" onClick={() => { setHistoryOpen(false); handleNewChat(); }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7 1V13M1 7H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            New
          </button>
        </div>

        <div className="HPAG-conversations-list">
          {conversations.map(conv => (
            <button type="button"
              key={conv.id}
              className={`HPAG-conversation-item ${selectedConversation === conv.id ? 'HPAG-active' : ''}`}
              aria-current={selectedConversation === conv.id ? 'page' : undefined}
              onClick={() => { setSelectedConversation(conv.id); setHistoryOpen(false); }}
            >
              <div className="HPAG-conversation-title">{buildConversationTitle(conv)}</div>
              <div className="HPAG-conversation-date">{formatRelativeTime(conv.created_at || conv.date)}</div>
            </button>
          ))}
        </div>
    </>
  );

  return (
    <div className="HPAG-container">
      <div className="HPAG-sidebar">{historyContent}</div>
      <dialog ref={historyDialogRef} className="HPAG-mobile-history" id="HPAG-mobile-history" aria-label="Conversations" onCancel={event => { event.preventDefault(); setHistoryOpen(false); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX > rect.right) setHistoryOpen(false); } }}>
        <button type="button" className="HPAG-history-close" onClick={() => setHistoryOpen(false)} aria-label="Close conversations"><FontAwesomeIcon icon={faTimes} /></button>
        {historyContent}
      </dialog>
      <div className="HPAG-chat-area">
        <div className="HPAG-chat-header">
          <div className="HPAG-header-model">
            <button type="button" className="HPAG-history-toggle" aria-label="Open conversations" aria-expanded={historyOpen} aria-controls="HPAG-mobile-history" onClick={() => setHistoryOpen(true)}><FontAwesomeIcon icon={faBars} /></button>
            <ModelMenu selectedModel={selectedModel} onSelectModel={chooseModel} />
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

        <div className="HPAG-messages-container" onScroll={event => { const el = event.currentTarget; stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96; }}>
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
                  const runTitle = isAsoRun ? 'Study' : isInvestigatorRun ? 'Investigator' : 'Deep Research';

                  const runEvents = group.messages.map(m => m.toolEvent).filter(Boolean);

                  // Get latest step label for shimmer text (identical to HPAG-tool-line-label)
                  const lastStepMsg = (() => {
                    if (isAsoRun) return studyStatusLine(runEvents);
                    for (let mi = group.messages.length - 1; mi >= 0; mi--) {
                      const evt = group.messages[mi].toolEvent;
                      if (evt && evt.status !== 'started' && evt.status !== 'completed') {
                        return getStepDisplayLabel(evt);
                      }
                    }
                    return runTitle;
                  })();

                  // A study is its map: always open, never folded.
                  const isExpanded = isAsoRun || collapsedRuns[group.runId] === false;

                  return (
                    <React.Fragment key={group.runId}>
                    {!isAsoRun && <div
                      className={`HPAG-shimmer-bar ${group.isComplete ? 'HPAG-shimmer-done' : ''}`}
                      onClick={isAsoRun ? undefined : () => toggleRunCollapsed(group.runId)}
                    >
                      <span className="HPAG-shimmer-text">
                        {group.isComplete ? `${runTitle} complete` : <>Working<span className="HPAG-shimmer-dot">{'\u00B7'}</span>{lastStepMsg}</>}
                      </span>
                      {!isAsoRun && <FontAwesomeIcon icon={isExpanded ? faChevronDown : faChevronRight} className="HPAG-shimmer-chevron" />}
                    </div>}
                    {isExpanded && (
                    <div className={`HPAG-tool-run-container ${isAsoRun ? 'HPAG-tool-run-container-study' : ''}`}>
                      <div
                        className={`HPAG-tool-run-content ${isAsoRun ? 'HPAG-tool-run-content-study' : ''}`}
                        ref={el => { toolRunRefs.current[group.runId] = el; }}
                        data-study-run-id={isAsoRun ? group.runId : undefined}
                      >
                        {isAsoRun && (
                          <StudyRun
                            events={runEvents}
                            apiBaseUrl={apiBaseUrl}
                            isComplete={group.isComplete}
                            selectionRequest={studySelection?.runId === group.runId ? studySelection : null}
                            onArtifactEnter={handleArtifactChipEnter}
                            onArtifactLeave={handleArtifactChipLeave}
                          />
                        )}
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
                    {isAsoRun && group.isComplete && (
                      <StudyOutputs events={runEvents} apiBaseUrl={apiBaseUrl} />
                    )}
                    </React.Fragment>
                  );
                } else {
                  // Render a normal message
                  const message = group.message;
                  const index = group.index;
                  const isLastMessage = index === currentMessages.length - 1;
                  const showActions = message.type === 'ai' && message.text !== '' && !(isLoading && isLastMessage);
                  const showLoadingDot = isLoading && isLastMessage && message.type === 'ai' && message.text === '';
                  // An assistant bubble with nothing in it (no text, no attachment) is not rendered at all,
                  // unless it is the placeholder that shows the loading dot while the answer streams.
                  const hasAttachment = Boolean(message.questionnaire || message.reader || message.readerLive || message.searchUrl || message.resources?.length || message.dictionaryImages?.images?.length || message.asoCharts?.length);
                  if (message.type === 'ai' && message.text === '' && !hasAttachment && !showLoadingDot) return null;
                  const isReader = Boolean(message.readerLive || message.reader);
                  const hpaUrls = message.type === 'ai' && !isReader ? extractHPAUrls(message.text) : [];

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
                        className={`HPAG-message HPAG-message-${message.type} ${isReader ? 'HPAG-message-reader' : ''} ${isLastMessage && !message.searchUrl ? 'HPAG-message-last' : ''}`}
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
                          {message.type === 'ai' && !isReader && message.resources && message.resources.length > 0 && (
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
                          {/* A reader answer is its quote cards; the stored text is the same content for copying and reloads */}
                          {(message.readerLive || message.reader) && (
                            <ReaderPanel live={message.readerLive || null} result={message.reader || null} />
                          )}
                          {!(message.reader || message.readerLive) && (
                          <div className="HPAG-message-text">
                            {message.type === 'ai' ? (
                              <StudyAnswer
                                text={message.text}
                                study={studyRuns.get(message.runId)}
                                onSelectArtifact={artifactId => selectStudyArtifact(message.runId, artifactId)}
                              />
                            ) : (
                              displayText
                            )}
                          </div>
                          )}
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
                          {/* Clarification card, inside the bubble above the footer; the answers go back as the next user message */}
                          {message.questionnaire && (
                            <Questionnaire
                              questionnaire={message.questionnaire}
                              answered={message.questionnaireAnswered || null}
                              disabled={isLoading}
                              onSubmit={(text, picks) => {
                                const answeredId = message.id;
                                setConversations(convs => convs.map(conv =>
                                  conv.id === selectedConversation
                                    ? { ...conv, messages: conv.messages.map(m => m.id === answeredId ? { ...m, questionnaireAnswered: picks } : m) }
                                    : conv
                                ));
                                handleSend(text);
                              }}
                            />
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
