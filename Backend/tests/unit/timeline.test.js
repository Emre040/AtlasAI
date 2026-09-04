'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTimeline, buildModelHistory, runAttachments } = require('../../src/http/timeline');

function message(id, role, text, extra = {}) {
  return {
    id,
    publicId: `msg-${id}`,
    parentMessageId: role === 'assistant' ? extra.parentMessageId ?? null : null,
    role,
    text,
    createdUnixMs: 1_000 + id,
    inference: extra.inference ?? null
  };
}

function run(id, overrides = {}) {
  return {
    id,
    publicId: `run-${id}`,
    conversationId: 1,
    requestMessageId: overrides.requestMessageId,
    responseMessageId: overrides.responseMessageId ?? null,
    inferenceModelId: 1,
    modelConfigKey: 'deepseek-v4-flash',
    toolKey: overrides.toolKey || 'deep_research_hpa',
    toolCallId: 'call_1',
    arguments: overrides.arguments ?? { goal: 'heart enriched proteins' },
    preambleText: overrides.preambleText ?? 'Let me search.',
    status: overrides.status || 'completed',
    stepCount: 2,
    searchUrl: 'searchUrl' in overrides ? overrides.searchUrl : 'https://www.proteinatlas.org/search/x',
    rowsFound: 32,
    validationPassed: true,
    attempts: 1,
    workspaceId: overrides.workspaceId ?? null,
    workspacePublicId: overrides.workspacePublicId ?? null,
    result: overrides.result ?? { status: 'ok', result: { rows_found: 32 } },
    summaryMd: null,
    errorMessage: null,
    startedUnixMs: 1_500 + id,
    completedUnixMs: 1_600 + id,
    events: [
      { id: 1, sequenceNo: 0, eventKind: 'started', stage: 'start', label: null, message: null, url: null, visual: null, detail: null, createdUnixMs: 1 },
      { id: 2, sequenceNo: 1, eventKind: 'progress', stage: 'planning_step', label: 'Plan', message: 'Creating plan', url: null, visual: null, detail: null, createdUnixMs: 2 },
      { id: 3, sequenceNo: 2, eventKind: 'completed', stage: 'complete', label: 'Complete', message: null, url: null, visual: null, detail: { steps: 1 }, createdUnixMs: 3 }
    ]
  };
}

test('timeline interleaves user message, preamble, run, and the assistant answer with run attachments', () => {
  const messages = [
    message(1, 'user', 'find me heart enriched proteins'),
    message(2, 'assistant', 'I found 32 heart-enriched proteins!', { parentMessageId: 1, inference: {
      callPublicId: 'call-pub', modelConfigKey: 'deepseek-v4-flash', finishReason: 'stop', inputTokens: 100,
      cachedInputTokens: null, outputTokens: 20, reasoningTokens: null, totalTokens: 120,
      firstTokenLatencyMs: 300, totalLatencyMs: 900, outputTokensPerSecond: 33.33
    } }),
    message(3, 'user', 'thanks'),
    message(4, 'assistant', 'You are welcome.', { parentMessageId: 3 })
  ];
  const runs = [run(10, { requestMessageId: 1, responseMessageId: 2 })];

  const items = buildTimeline(messages, runs);
  assert.deepEqual(items.map(item => `${item.type}:${item.id}`), [
    'message:msg-1', 'message:run-10:preamble', 'run:run-10', 'message:msg-2', 'message:msg-3', 'message:msg-4'
  ]);
  assert.equal(items[1].text, 'Let me search.');
  assert.equal(items[1].preamble_for_run, 'run-10');
  assert.equal(items[2].tool, 'deep_research_hpa');
  assert.equal(items[2].events.length, 3);
  assert.equal(items[2].events[2].detail.steps, 1);
  assert.equal(items[3].run_id, 'run-10');
  assert.equal(items[3].search_url, 'https://www.proteinatlas.org/search/x');
  assert.equal(items[3].inference.output_tokens_per_second, 33.33);
  assert.equal(items[5].run_id, null);
  assert.equal(items[5].inference, null);
});

test('run attachments mirror what query.js streams live for each tool', () => {
  const dictionary = runAttachments(run(1, {
    toolKey: 'dictionary_expert_hpa',
    searchUrl: null,
    result: { status: 'ok', dictionary_url: 'https://www.proteinatlas.org/learn/dictionary/x', matched_category: 'Liver', images: [{ url: 'a.jpg' }] }
  }));
  assert.equal(dictionary.search_url, null);
  assert.deepEqual(dictionary.dictionary_images.images, [{ url: 'a.jpg' }]);
  assert.equal(dictionary.dictionary_images.isMultiTopic, false);
  assert.deepEqual(dictionary.dictionary_images.categories, []);

  const investigator = runAttachments(run(2, {
    toolKey: 'investigator_hpa',
    searchUrl: null,
    result: { status: 'ok', answer: 'x', resources: [{ url: 'https://www.proteinatlas.org/ENSG1' }] }
  }));
  assert.equal(investigator.resources.length, 1);

  const aso = runAttachments(run(3, {
    toolKey: 'aso_hpa',
    searchUrl: null,
    workspacePublicId: '0192aaaa-0000-7000-8000-000000000000',
    // A chart node stores its specification (json) and its rendered image (png); only the
    // specification is a chart attachment, the image sits next to it in the workspace.
    result: { status: 'ok', artifacts: [
      { artifact_uuid: 'a1', kind: 'figure', storage_uri: 'artifacts/a1.json', summary: { node: 'n7', label: 'Heatmap' } },
      { artifact_uuid: 'a3', kind: 'figure', storage_uri: 'artifacts/n7.png', summary: { node: 'n7', label: 'Heatmap', image: 'artifacts/n7.png' } },
      { artifact_uuid: 'a2', kind: 'dataset', storage_uri: 'artifacts/data.json' }
    ] }
  }));
  assert.deepEqual(aso.aso_charts, [{
    artifact_uuid: 'a1',
    url: '/workspaces/0192aaaa-0000-7000-8000-000000000000/artifacts/a1.json',
    summary: { node: 'n7', label: 'Heatmap' }
  }]);
});

test('model history carries the preamble and completed-search note and cleans reply markers', () => {
  const rows = [
    { id: 1, parentMessageId: null, role: 'user', text: '⟪HPA▸GENE:ENSG00000141510:TP53⟫ what is it' },
    { id: 2, parentMessageId: 1, role: 'assistant', text: 'TP53 is a tumor suppressor.' },
    { id: 3, parentMessageId: null, role: 'user', text: 'find me heart enriched proteins' },
    { id: 4, parentMessageId: 3, role: 'assistant', text: 'I found 32.' }
  ];
  const history = buildModelHistory(rows, [run(7, { requestMessageId: 3, responseMessageId: 4 })]);
  assert.deepEqual(history, [
    { role: 'user', content: '[Regarding gene TP53 (ENSG00000141510)] what is it' },
    { role: 'assistant', content: 'TP53 is a tumor suppressor.' },
    { role: 'user', content: 'find me heart enriched proteins' },
    { role: 'assistant', content: 'Let me search.' },
    { role: 'assistant', content: '[SEARCH COMPLETED for "heart enriched proteins" - I sent the user: https://www.proteinatlas.org/search/x]' },
    { role: 'assistant', content: 'I found 32.' }
  ]);
});
