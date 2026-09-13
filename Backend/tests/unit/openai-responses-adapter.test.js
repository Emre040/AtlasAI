'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAIResponsesAdapter, buildRequest, normalizeResponse } = require('../../src/inference/adapters/openaiResponses');

const model = Object.freeze({ configKey: 'openai-gpt-5.6-luna-r', modelId: 'gpt-5.6-luna', defaultOutputTokens: 8192, reasoningEffort: 'none' });

test('a chat request becomes a Responses request: instructions, input items, function tools, reasoning', () => {
  const body = buildRequest({
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'measure', arguments: '{"artifact":"a1"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"rows":8}' }
    ],
    tools: [{ type: 'function', function: { name: 'measure', description: 'm', parameters: { type: 'object', properties: { artifact: { type: 'string' } }, required: ['artifact'] } } }],
    temperature: 0,
    reasoning_effort: 'low'
  }, model);
  assert.equal(body.model, 'gpt-5.6-luna');
  assert.equal(body.instructions, 'rules');
  assert.equal(body.store, false);
  assert.deepEqual(body.input, [
    { role: 'user', content: 'go' },
    { type: 'function_call', call_id: 'c1', name: 'measure', arguments: '{"artifact":"a1"}' },
    { type: 'function_call_output', call_id: 'c1', output: '{"rows":8}' }
  ]);
  assert.deepEqual(body.tools[0], { type: 'function', name: 'measure', description: 'm', parameters: { type: 'object', properties: { artifact: { type: 'string' } }, required: ['artifact'] } });
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal(body.temperature, undefined, 'a reasoning request carries no temperature');
  assert.equal(body.max_output_tokens, 8192);
});

test('without reasoning the temperature stands, JSON mode maps to the text format, and the model default effort applies', () => {
  const body = buildRequest({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], temperature: 0, response_format: { type: 'json_object' } }, model);
  assert.equal(body.reasoning, undefined);
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.text, { format: { type: 'json_object' } });
});

test('a response becomes one chat completion: text, tool calls, finish reason and usage in chat names', () => {
  const chat = normalizeResponse({
    id: 'resp_1', created_at: 1, model: 'gpt-5.6-luna', status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'plan', arguments: '{"items":[]}' },
      { type: 'message', content: [{ type: 'output_text', text: 'done' }] }
    ],
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 30 } }
  }, model);
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(chat.choices[0].message.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'plan', arguments: '{"items":[]}' } }]);
  assert.equal(chat.choices[0].message.content, 'done');
  assert.deepEqual(chat.usage, { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 30 } });
  const cut = normalizeResponse({ status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: 'half' }] }], usage: {} }, model);
  assert.equal(cut.choices[0].finish_reason, 'length');
  assert.equal(cut.choices[0].message.content, 'half');
});

test('the adapter sends the built request through the client and returns the chat shape', async () => {
  const seen = [];
  const client = { responses: { create: async body => { seen.push(body); return { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } }; } } };
  const adapter = new OpenAIResponsesAdapter({ client });
  const out = await adapter.create({ messages: [{ role: 'user', content: 'hi' }] }, model);
  assert.equal(seen[0].input[0].content, 'hi');
  assert.equal(out.choices[0].message.content, 'ok');
  await assert.rejects(adapter.create({ messages: [], stream: true }, model), /does not stream/);
});
