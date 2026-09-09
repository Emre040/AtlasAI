'use strict';

// Pure view-model builders over the conversation tables. `buildTimeline` is what the frontend
// renders; `buildModelHistory` is the context the model sees. Both take repository objects
// (ConversationRepository.listMessages / history, RunRepository.listForConversation).

function baseName(storageUri) {
  const text = String(storageUri || '');
  const index = text.lastIndexOf('/');
  return index === -1 ? text : text.slice(index + 1);
}

function runsByRequestMessage(runs) {
  const map = new Map();
  for (const run of runs) {
    const list = map.get(run.requestMessageId) || [];
    list.push(run);
    map.set(run.requestMessageId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.id - b.id);
  return map;
}

function runByResponseMessage(runs) {
  const map = new Map();
  for (const run of runs) {
    if (run.responseMessageId !== null && run.responseMessageId !== undefined) map.set(run.responseMessageId, run);
  }
  return map;
}

// The attachments query.js streams next to an assistant answer, derived from the run's result.
function runAttachments(run) {
  const result = run?.result && typeof run.result === 'object' ? run.result : null;
  const attachments = {
    search_url: run?.searchUrl ?? null,
    resources: null,
    dictionary_images: null,
    aso_charts: null,
    questionnaire: null,
    reader: null
  };
  if (!result) return attachments;

  if (run.toolKey === 'clarify_hpa' && Array.isArray(result.questions) && result.questions.length > 0) {
    attachments.questionnaire = { reason: result.reason ?? null, questions: result.questions };
  }
  if (run.toolKey === 'dictionary_expert_hpa' && result.mode === 'reader') {
    attachments.reader = { question: result.question ?? null, text: result.text || '', citations: result.citations || [], pages: result.pages || [], dropped_sentences: result.dropped_sentences || [], not_found: result.not_found || '' };
  }

  if (Array.isArray(result.resources) && result.resources.length > 0) {
    attachments.resources = result.resources;
  }
  if (run.toolKey === 'dictionary_expert_hpa' && Array.isArray(result.images) && result.images.length > 0) {
    attachments.dictionary_images = {
      dictionary_url: result.dictionary_url ?? null,
      matched_category: result.matched_category ?? null,
      category_type: result.category_type ?? null,
      isMultiTopic: Boolean(result.isMultiTopic),
      categories: Array.isArray(result.categories) ? result.categories : [],
      images: result.images,
      related_links: Array.isArray(result.related_links) ? result.related_links : []
    };
  }
  if (run.toolKey === 'aso_hpa' && Array.isArray(result.artifacts) && run.workspacePublicId) {
    const charts = result.artifacts
      .filter(artifact => artifact?.kind === 'figure' && /\.json$/.test(String(artifact.storage_uri || '')))
      .map(artifact => ({
        artifact_uuid: artifact.artifact_uuid,
        url: `/workspaces/${run.workspacePublicId}/artifacts/${baseName(artifact.storage_uri)}`,
        summary: artifact.summary ?? null
      }));
    if (charts.length > 0) attachments.aso_charts = charts;
  }
  return attachments;
}

function runItem(run) {
  return {
    type: 'run',
    id: run.publicId,
    tool: run.toolKey,
    status: run.status,
    model: run.modelConfigKey ?? null,
    started_at: run.startedUnixMs,
    completed_at: run.completedUnixMs,
    step_count: run.stepCount,
    arguments: run.arguments,
    search_url: run.searchUrl,
    rows_found: run.rowsFound,
    validation_passed: run.validationPassed,
    attempts: run.attempts,
    workspace_id: run.workspacePublicId,
    error: run.errorMessage,
    events: run.events.map(event => ({
      seq: event.sequenceNo,
      kind: event.eventKind,
      stage: event.stage,
      label: event.label,
      message: event.message,
      url: event.url,
      visual: event.visual,
      detail: event.detail,
      created_at: event.createdUnixMs
    }))
  };
}

function messageItem(message, run) {
  const item = {
    type: 'message',
    id: message.publicId,
    role: message.role,
    text: message.text,
    created_at: message.createdUnixMs,
    run_id: run ? run.publicId : null,
    inference: message.inference
      ? {
          model: message.inference.modelConfigKey,
          finish_reason: message.inference.finishReason,
          input_tokens: message.inference.inputTokens,
          cached_input_tokens: message.inference.cachedInputTokens,
          output_tokens: message.inference.outputTokens,
          reasoning_tokens: message.inference.reasoningTokens,
          total_tokens: message.inference.totalTokens,
          first_token_latency_ms: message.inference.firstTokenLatencyMs,
          total_latency_ms: message.inference.totalLatencyMs,
          output_tokens_per_second: message.inference.outputTokensPerSecond
        }
      : null,
    ...runAttachments(run)
  };
  return item;
}

function preambleItem(run) {
  return {
    type: 'message',
    id: `${run.publicId}:preamble`,
    role: 'assistant',
    text: run.preambleText,
    created_at: run.startedUnixMs,
    run_id: run.publicId,
    preamble_for_run: run.publicId,
    inference: null,
    search_url: null,
    resources: null,
    dictionary_images: null,
    aso_charts: null
  };
}

function buildTimeline(messages, runs) {
  const byRequest = runsByRequestMessage(runs);
  const byResponse = runByResponseMessage(runs);
  const items = [];
  for (const message of messages) {
    items.push(messageItem(message, message.role === 'assistant' ? byResponse.get(message.id) || null : null));
    if (message.role !== 'user') continue;
    for (const run of byRequest.get(message.id) || []) {
      if (run.preambleText) items.push(preambleItem(run));
      items.push(runItem(run));
    }
  }
  return items;
}

// Chronological context for the model: user text, the assistant's pre-tool sentence, a note
// about each completed search (so follow-up filters can reuse it), and the assistant's answer.
const REPLY_MARKER_NEW = /^⟪HPA▸GENE:(ENSG\d+):([^⟫]+)⟫\s*/;
const REPLY_MARKER_COMPAT = /^\[\[REPLY:(ENSG\d+):([^\]]+)\]\]\s*/;

// Both reply-marker wire formats become plain text for the model.
function modelUserText(text) {
  return String(text || '')
    .replace(REPLY_MARKER_NEW, '[Regarding gene $2 ($1)] ')
    .replace(REPLY_MARKER_COMPAT, '[Regarding gene $2 ($1)] ');
}

function buildModelHistory(historyRows, runs) {
  const byRequest = runsByRequestMessage(runs);
  const context = [];
  for (const row of historyRows) {
    context.push({ role: row.role, content: row.role === 'user' ? modelUserText(row.text) : row.text });
    if (row.role !== 'user') continue;
    for (const run of byRequest.get(row.id) || []) {
      if (run.preambleText) context.push({ role: 'assistant', content: run.preambleText });
      if (run.searchUrl) {
        const goal = run.arguments?.goal || row.text;
        context.push({ role: 'assistant', content: `[SEARCH COMPLETED for "${goal}" - I sent the user: ${run.searchUrl}]` });
      }
    }
  }
  return context;
}

module.exports = { buildTimeline, buildModelHistory, runAttachments };
