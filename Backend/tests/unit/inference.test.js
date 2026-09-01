'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AnthropicMessagesAdapter,
  buildRequest,
  normalizeResponse,
  normalizeStream
} = require('../../src/inference/adapters/anthropicMessages');
const { OpenAIChatCompletionsAdapter } = require('../../src/inference/adapters/openaiChatCompletions');
const { InferenceGateway, costMicroUsd } = require('../../src/inference/gateway');

const anthropicModel = Object.freeze({
  configKey: 'anthropic-claude-sonnet-5',
  modelId: 'claude-sonnet-5',
  defaultOutputTokens: 8192
});

function activeRow(overrides = {}) {
  return {
    id: 1,
    provider_id: 1,
    config_key: 'openai-gpt-4.1-mini-2025-04-14',
    model_id: 'gpt-4.1-mini-2025-04-14',
    supports_streaming: 1,
    supports_tools: 1,
    supports_json_mode: 1,
    supports_tool_role_messages: 1,
    supports_vision: 1,
    supports_reasoning: 0,
    reasoning_effort: null,
    max_context_tokens: 100000,
    max_output_tokens: 32000,
    default_output_tokens: 8192,
    request_timeout_ms: 120000,
    max_retries: 2,
    model_revision: 1,
    provider_key: 'openai',
    adapter_key: 'openai_chat_completions',
    api_base_url: 'https://api.openai.com/v1',
    credential_env_key: 'ATLAS_TEST_PROVIDER_KEY',
    provider_status: 'enabled',
    provider_revision: 1,
    ...overrides
  };
}

test('Anthropic request conversion preserves system, tools, tool results, and JSON mode', () => {
  const request = buildRequest({
    messages: [
      { role: 'system', content: 'Primary instruction.' },
      { role: 'user', content: 'Find TP53.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'tool-1',
          type: 'function',
          function: { name: 'search_hpa', arguments: '{"gene":"TP53"}' }
        }]
      },
      { role: 'tool', tool_call_id: 'tool-1', content: '{"found":true}' },
      { role: 'system', content: 'Return the final answer.' }
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    top_p: 1
  }, anthropicModel);

  assert.equal(request.params.model, 'claude-sonnet-5');
  assert.equal(request.params.max_tokens, 8192);
  // Claude Opus 5 / Sonnet 5 reject sampling parameters with HTTP 400; the adapter must never forward them.
  assert.equal('temperature' in request.params, false);
  assert.equal('top_p' in request.params, false);
  assert.match(request.params.system, /Primary instruction/);
  assert.match(request.params.system, /Return the final answer/);
  assert.match(request.params.system, /valid JSON object/);
  assert.deepEqual(request.params.messages[1].content[0], {
    type: 'tool_use',
    id: 'tool-1',
    name: 'search_hpa',
    input: { gene: 'TP53' }
  });
  assert.deepEqual(request.params.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: '{"found":true}'
  });
  assert.equal(request.jsonObjectMode, true);
});

test('Anthropic native responses normalize to the internal chat-completion contract', () => {
  const response = normalizeResponse({
    id: 'msg_1',
    model: 'claude-sonnet-5',
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'search_hpa', input: { gene: 'TP53' } }
    ],
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 }
  }, false);

  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.equal(response.choices[0].message.content, 'Checking.');
  assert.deepEqual(response.choices[0].message.tool_calls[0], {
    id: 'call_1',
    type: 'function',
    function: { name: 'search_hpa', arguments: '{"gene":"TP53"}' }
  });
  // Anthropic's input_tokens exclude cache reads; the internal contract counts the whole prompt.
  assert.deepEqual(response.usage, {
    prompt_tokens: 14,
    completion_tokens: 7,
    total_tokens: 21,
    prompt_tokens_details: { cached_tokens: 3 }
  });
});

test('Anthropic json_object mode unwraps one markdown fence and rejects prose around the object', () => {
  const fenced = normalizeResponse({
    id: 'msg_2',
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '```json\n{"tool":"deep_research_hpa","goal":"heart"}\n```' }],
    usage: { input_tokens: 5, output_tokens: 9 }
  }, true);
  assert.equal(fenced.choices[0].message.content, '{"tool":"deep_research_hpa","goal":"heart"}');

  const bare = normalizeResponse({
    id: 'msg_3',
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: ' {"ok":true} ' }],
    usage: { input_tokens: 5, output_tokens: 3 }
  }, true);
  assert.equal(bare.choices[0].message.content, '{"ok":true}');

  assert.throws(() => normalizeResponse({
    id: 'msg_4',
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Here is the plan: {"ok":true}' }],
    usage: { input_tokens: 5, output_tokens: 3 }
  }, true), /invalid JSON for json_object mode/);
});

test('Anthropic streams normalize text, fragmented tool arguments, finish reason, and usage', async () => {
  async function* nativeStream() {
    yield { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 5 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' } };
    yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_2', name: 'inspect', input: {} } };
    yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"id":' } };
    yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '7}' } };
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } };
    yield { type: 'message_stop' };
  }

  const chunks = [];
  for await (const chunk of normalizeStream(nativeStream(), 'claude-sonnet-5')) chunks.push(chunk);

  assert.equal(chunks[0].choices[0].delta.content, 'Working');
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.name, 'inspect');
  assert.equal(chunks[2].choices[0].delta.tool_calls[0].function.arguments, '{"id":');
  assert.equal(chunks[3].choices[0].delta.tool_calls[0].function.arguments, '7}');
  assert.equal(chunks[4].choices[0].finish_reason, 'tool_calls');
  assert.equal(chunks[4].usage.total_tokens, 14);
});

test('Anthropic and OpenAI adapters call their native clients with the selected database model', async () => {
  let anthropicParams;
  const anthropic = new AnthropicMessagesAdapter({
    client: {
      messages: {
        async create(params) {
          anthropicParams = params;
          return {
            id: 'msg_3',
            model: params.model,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done.' }],
            usage: { input_tokens: 2, output_tokens: 1 }
          };
        }
      }
    }
  });
  const anthropicResponse = await anthropic.create({
    messages: [{ role: 'user', content: 'Go.' }]
  }, anthropicModel);
  assert.equal(anthropicParams.model, 'claude-sonnet-5');
  assert.equal(anthropicResponse.choices[0].message.content, 'Done.');

  let openAiParams;
  const openai = new OpenAIChatCompletionsAdapter({
    client: {
      chat: {
        completions: {
          async create(params) {
            openAiParams = params;
            return { ok: true };
          }
        }
      }
    }
  });
  await openai.create({ messages: [{ role: 'user', content: 'Go.' }] }, {
    modelId: 'openai/gpt-oss-120b',
    reasoningEffort: null
  });
  assert.equal(openAiParams.model, 'openai/gpt-oss-120b');
  assert.equal('reasoning_effort' in openAiParams, false);

  await openai.create({ messages: [{ role: 'user', content: 'Go.' }] }, {
    modelId: 'gpt-5.6-luna',
    reasoningEffort: 'none'
  });
  assert.equal(openAiParams.reasoning_effort, 'none');
});

test('gateway resolves and binds exactly one database model for a complete HTTP request', async () => {
  process.env.ATLAS_TEST_PROVIDER_KEY = 'test-only-key';
  const rows = [
    activeRow(),
    activeRow({
      id: 2,
      config_key: 'groq-gpt-oss-120b',
      model_id: 'openai/gpt-oss-120b',
      provider_id: 4,
      provider_key: 'groq',
      api_base_url: 'https://api.groq.com/openai/v1'
    })
  ];
  let databaseReads = 0;
  const db = {
    async execute() {
      const row = rows[Math.min(databaseReads, rows.length - 1)];
      databaseReads += 1;
      return [[row]];
    }
  };
  const calls = [];
  const gateway = new InferenceGateway(db, {
    adapterFactory() {
      return {
        async create(request, model) {
          calls.push(model.configKey);
          return { model: model.modelId };
        }
      };
    },
    // Inference-call rows are covered by inference-calls.test.js; keep this fake database
    // dedicated to model resolution reads.
    callRepository: { async record() { return { id: 1, publicId: 'call-1' }; } }
  });
  await gateway.initialize();

  // The policy middleware resolves the model once per request and binds it for the whole
  // async scope; every completion inside reuses that binding without another database read.
  const { model } = await gateway.resolveActiveModel();
  await gateway.runWithActiveModel(model, async () => {
    assert.equal(gateway.getActiveModel().configKey, 'groq-gpt-oss-120b');
    assert.equal(gateway.getBinding().credentialSource, 'platform');
    assert.equal(gateway.getBinding().modelSelection, 'auto');
    await gateway.createChatCompletion({ messages: [{ role: 'user', content: 'One.' }] });
    await gateway.createChatCompletion({ messages: [{ role: 'user', content: 'Two.' }] });
  });

  assert.equal(databaseReads, 2);
  assert.deepEqual(calls, ['groq-gpt-oss-120b', 'groq-gpt-oss-120b']);
  delete process.env.ATLAS_TEST_PROVIDER_KEY;
});

test('gateway prices completed calls from the bound model and stamps the binding on the row', async () => {
  process.env.ATLAS_TEST_PROVIDER_KEY = 'test-only-key';
  const row = activeRow({
    input_price_microusd_per_million_tokens: 440000,
    cached_input_price_microusd_per_million_tokens: 14000,
    output_price_microusd_per_million_tokens: 1320000
  });
  const db = { async execute() { return [[row]]; } };
  const recorded = [];
  const gateway = new InferenceGateway(db, {
    adapterFactory() {
      return {
        async create() {
          return {
            id: 'resp-1',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 } }
          };
        }
      };
    },
    callRepository: { async record(fields) { recorded.push(fields); return { id: recorded.length, publicId: `call-${recorded.length}` }; } }
  });
  await gateway.initialize();
  const { model } = await gateway.resolveActiveModel();

  await gateway.runWithBinding({ model, apiKey: 'visitor-key', credentialSource: 'visitor', modelSelection: 'visitor' }, () => (
    gateway.withContext({ visitorId: '42', purpose: 'answer' }, () => (
      gateway.createChatCompletion({ messages: [{ role: 'user', content: 'Price me.' }] })
    ))
  ));

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].visitor_id, 42);
  assert.equal(recorded[0].credential_source, 'visitor');
  assert.equal(recorded[0].model_selection, 'visitor');
  // 800 uncached x 0.44 + 200 cached x 0.014 + 500 output x 1.32 = 352 + 2.8 + 660 micro-USD
  assert.equal(recorded[0].cost_microusd, 1015);
  assert.equal(costMicroUsd(model, { input_tokens: null, output_tokens: 5, cached_input_tokens: null }), null);
  delete process.env.ATLAS_TEST_PROVIDER_KEY;
});
