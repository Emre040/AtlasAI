// Pure mapping from the backend's conversation timeline (GET /conversations/messages) and the
// live query stream (POST /query/stream) to the message list the HPA view renders.
// No React, no fetch: everything here is testable in isolation.
import { parseAnswers } from './questionnaire';

const INVESTIGATOR = 'investigator_hpa';
const STUDY = 'aso_hpa';

export function formatTimestamp(unixMs) {
  const date = Number.isFinite(unixMs) ? new Date(unixMs) : new Date();
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function startLabel(toolName) {
  if (toolName === INVESTIGATOR) return 'Investigating gene';
  if (toolName === STUDY) return 'Study started';
  return 'Deep Research initiated';
}

function startMessage(toolName, live) {
  if (toolName === INVESTIGATOR) return 'Resolving gene in HPA…';
  if (toolName === STUDY) return 'Planning the study…';
  return live ? 'Reading the search schema…' : 'Starting research…';
}

function completeLabel(toolName) {
  if (toolName === INVESTIGATOR) return 'Investigation complete';
  if (toolName === STUDY) return 'Study complete';
  return 'Deep Research complete';
}

function finishedMessage(steps) {
  return `Finished in ${steps ?? 'several'} steps.`;
}

// A stored run event as the tool-event object the timeline renderer consumes.
export function toolEventFromRunEvent(run, event) {
  const toolName = run.tool;
  const base = {
    toolName,
    runId: run.id,
    stage: event.stage || 'info',
    meta: { url: event.url || null, visual: event.visual || null },
    detail: event.detail || null,
    createdAt: event.created_at
  };
  if (event.kind === 'started') {
    return {
      ...base,
      kind: 'status',
      status: 'started',
      label: event.label || startLabel(toolName),
      message: event.message || startMessage(toolName, false)
    };
  }
  if (event.kind === 'completed' || event.kind === 'failed') {
    const steps = event.detail?.steps ?? run.step_count;
    return {
      ...base,
      kind: 'status',
      status: 'completed',
      failed: event.kind === 'failed',
      label: event.kind === 'failed' ? 'Failed' : (event.label && event.label !== 'Complete' ? event.label : completeLabel(toolName)),
      message: event.kind === 'failed' ? (event.message || run.error || 'The tool failed.') : finishedMessage(steps)
    };
  }
  // ASO events carry a structured payload; the renderer reads it as JSON text in `message`.
  return {
    ...base,
    kind: 'progress',
    label: event.label || '',
    message: event.detail ? JSON.stringify(event.detail) : (event.message || '')
  };
}

function messageFromItem(item) {
  const message = {
    id: item.id,
    type: item.role === 'user' ? 'user' : 'ai',
    text: item.text || '',
    timestamp: formatTimestamp(item.created_at),
    runId: item.run_id || null,
    inference: item.inference || null
  };
  if (item.search_url) message.searchUrl = item.search_url;
  if (Array.isArray(item.resources) && item.resources.length > 0) message.resources = item.resources;
  if (item.dictionary_images?.images?.length > 0) message.dictionaryImages = item.dictionary_images;
  if (Array.isArray(item.aso_charts) && item.aso_charts.length > 0) message.asoCharts = item.aso_charts;
  if (item.questionnaire?.questions?.length > 0) message.questionnaire = item.questionnaire;
  if (item.reader && Array.isArray(item.reader.citations)) message.reader = item.reader;
  return message;
}

function toolLinesFromRun(run) {
  if (run.tool === 'clarify_hpa') return [];   // a clarification shows as its card, not as tool lines
  if (run.tool === 'dictionary_expert_hpa' && run.arguments?.question) return [];   // a reader run shows as its panel
  const events = Array.isArray(run.events) ? run.events : [];
  return events.map(event => ({
    id: `${run.id}:${event.seq}`,
    type: 'tool',
    toolEvent: toolEventFromRunEvent(run, event),
    timestamp: formatTimestamp(event.created_at)
  }));
}

// Timeline items -> flat message list (user/ai bubbles and tool lines grouped later by runId).
export function timelineToUiMessages(items) {
  const messages = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      messages.push(messageFromItem(item));
    } else if (item.type === 'run') {
      messages.push(...toolLinesFromRun(item));
    }
  }
  // A clarification card stays answerable until a later user message exists; when that message
  // is the sent questionnaire, its answers become the recap.
  messages.forEach((message, i) => {
    if (!message.questionnaire) return;
    const later = messages.slice(i + 1).find(m => m.type === 'user');
    if (later) message.questionnaireAnswered = parseAnswers(message.questionnaire, later.text) || true;
  });
  return messages;
}

// A `tool` payload from the live SSE stream -> the tool-event object pushed as a tool line.
export function liveToolEventFromSse(tool) {
  const t = tool || {};
  const toolName = t.name || 'tool';
  const runId = t.run_id || `${toolName}-${Date.now()}`;
  if (t.status === 'started') {
    return {
      toolName,
      runId,
      kind: 'status',
      status: 'started',
      stage: 'start',
      label: startLabel(toolName),
      message: startMessage(toolName, true),
      meta: { url: null, visual: null }
    };
  }
  if (t.status === 'completed' || t.status === 'failed') {
    const failed = t.status === 'failed';
    return {
      toolName,
      runId,
      kind: 'status',
      status: 'completed',
      failed,
      stage: 'complete',
      label: failed ? 'Failed' : completeLabel(toolName),
      message: failed ? (t.error || 'The tool failed.') : finishedMessage(t.result_meta?.steps),
      meta: { url: null, visual: null }
    };
  }
  const s = t.step || {};
  return {
    toolName,
    runId,
    kind: 'progress',
    stage: s.stage || 'info',
    label: s.label || (s.stage === 'execution_step' ? 'Executing search' : 'Planning'),
    message: s.message || s.stdout || '',
    meta: s
  };
}
