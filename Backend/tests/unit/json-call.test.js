'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs } = require('../helpers/deskStudyFixture');

test('a JSON-mode reply that is a function call with no text is asked once more, as text, and both calls are counted', async () => {
  const requests = [];
  const replies = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'default:open', arguments: '{"page":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    { choices: [{ message: { role: 'assistant', content: '{"open":[{"page":1,"sections":[0]}]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 14, completion_tokens: 6, total_tokens: 20 } }
  ];
  const { jsonCall } = await loadWithStubs('src/inference/jsonCall.js', {
    './gateway': { inference: { getContext: () => ({}), chat: { completions: { async create(request) { requests.push(request); return replies.shift(); } } } } },
    '../config/runtime': { requireBoolean: () => false }
  });
  const stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, perStep: {} };
  const parsed = await jsonCall('rules', 'what next?', null, 'turn 1', stats);
  assert.deepEqual(parsed, { open: [{ page: 1, sections: [0] }] });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[1].content, 'what next?');
  assert.equal(requests[1].messages[1].content, 'what next?\n\nReply with the JSON object as text; there is no function to call.');
  assert.equal(requests[1].tools, undefined, 'a JSON-mode call offers no function');
  assert.deepEqual([stats.promptTokens, stats.completionTokens, stats.totalTokens], [24, 8, 32], 'both calls are on the account');
  assert.deepEqual(stats.perStep['turn 1'], { prompt: 24, completion: 8, total: 32 });
});

test('a text reply is taken as it is, with one call', async () => {
  const requests = [];
  const { jsonCall } = await loadWithStubs('src/inference/jsonCall.js', {
    './gateway': { inference: { getContext: () => ({ reasoningEffort: 'low' }), chat: { completions: { async create(request) { requests.push(request); return { choices: [{ message: { role: 'assistant', content: 'here: {"answer":{"text":"x"}}' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }; } } } } },
    '../config/runtime': { requireBoolean: () => false }
  });
  const parsed = await jsonCall('rules', 'go', null, 'final', null);
  assert.deepEqual(parsed, { answer: { text: 'x' } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reasoning_effort, 'low', 'the context effort reaches the call');
});
