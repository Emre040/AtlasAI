'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InferenceGateway } = require('../../src/inference/gateway');
const { INFERENCE_CALL_COLUMNS } = require('../../src/database/repositories/inferenceCalls');

function activeRow() {
  return {
    id: 7,
    provider_id: 1,
    config_key: 'deepseek-v4-flash',
    model_id: 'deepseek-v4-flash',
    supports_streaming: 1,
    supports_tools: 1,
    supports_json_mode: 1,
    supports_tool_role_messages: 1,
    supports_vision: 0,
    supports_reasoning: 1,
    reasoning_effort: null,
    max_context_tokens: 1000000,
    max_output_tokens: 384000,
    default_output_tokens: 8192,
    request_timeout_ms: 120000,
    max_retries: 2,
    model_revision: 1,
    provider_key: 'deepseek',
    adapter_key: 'openai_chat_completions',
    api_base_url: 'https://api.deepseek.com/v1',
    credential_env_key: 'ATLAS_TEST_CALLS_KEY',
    provider_status: 'enabled',
    provider_revision: 1
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeGateway(adapter) {
  process.env.ATLAS_TEST_CALLS_KEY = 'test-only-key';
  const recorded = [];
  const gateway = new InferenceGateway(
    { async execute() { return [[activeRow()]]; } },
    {
      adapterFactory: () => adapter,
      callRepository: {
        async record(fields) {
          for (const name of Object.keys(fields)) assert.ok(INFERENCE_CALL_COLUMNS.includes(name), `unknown column ${name}`);
          recorded.push(fields);
          return { id: recorded.length, publicId: `call-${recorded.length}` };
        }
      }
    }
  );
  return { gateway, recorded };
}

test('a streamed call records first-token latency, usage, tool calls, and the caller context', async () => {
  const adapter = {
    async create() {
      return (async function* stream() {
        await sleep(25);
        yield { id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'deep_research_hpa', arguments: '{"go' } }] } }] };
        yield { id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'al":"x"}' } }] } }] };
        yield { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 8 } } };
      })();
    }
  };
  const { gateway, recorded } = makeGateway(adapter);

  const context = { conversationId: 3, requestEventId: 9, callIds: [] };
  const chunks = [];
  await gateway.withContext({ ...context, purpose: 'router' }, async () => {
    const stream = await gateway.createChatCompletion({
      stream: true,
      tools: [{ type: 'function', function: { name: 'deep_research_hpa', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'go' }]
    });
    for await (const chunk of stream) chunks.push(chunk);
  });

  assert.equal(chunks.length, 3);
  assert.equal(recorded.length, 1);
  const call = recorded[0];
  assert.equal(call.inference_model_id, 7);
  assert.equal(call.conversation_id, 3);
  assert.equal(call.request_event_id, 9);
  assert.equal(call.purpose, 'router');
  assert.equal(call.status, 'completed');
  assert.equal(call.streamed, 1);
  assert.equal(call.message_count, 1);
  assert.equal(call.tool_count, 1);
  assert.equal(call.tool_call_count, 1);
  assert.equal(call.finish_reason, 'tool_calls');
  assert.equal(call.provider_request_id, 'chatcmpl-1');
  assert.equal(call.input_tokens, 120);
  assert.equal(call.cached_input_tokens, 64);
  assert.equal(call.output_tokens, 30);
  assert.equal(call.reasoning_tokens, 8);
  assert.equal(call.total_tokens, 150);
  assert.ok(call.first_token_latency_ms >= 20, `first token latency ${call.first_token_latency_ms}`);
  assert.ok(call.total_latency_ms >= call.first_token_latency_ms);
  assert.equal(call.response_characters, 0);
  assert.equal(call.response_sha256, null);
  assert.equal(call.request_sha256.length, 32);
  assert.ok(call.finished_unix_ms >= call.started_unix_ms);
  assert.deepEqual(context.callIds, [1]);
});

test('nested contexts inherit the outer ids and a failed call is recorded with the provider error', async () => {
  const adapter = {
    async create() {
      const error = new Error('402 Insufficient Balance');
      error.status = 402;
      error.code = 'insufficient_balance';
      throw error;
    }
  };
  const { gateway, recorded } = makeGateway(adapter);
  const outer = { conversationId: 5, requestEventId: 2, callIds: [] };

  await assert.rejects(
    gateway.withContext({ ...outer, purpose: 'router' }, () =>
      gateway.withContext({ purpose: 'agent', runId: 11, agentKey: 'deep_research_hpa' }, () =>
        gateway.createChatCompletion({ messages: [{ role: 'user', content: 'go' }] }))),
    /Insufficient Balance/
  );

  assert.equal(recorded.length, 1);
  const call = recorded[0];
  assert.equal(call.status, 'failed');
  assert.equal(call.purpose, 'agent');
  assert.equal(call.agent_key, 'deep_research_hpa');
  assert.equal(call.run_id, 11);
  assert.equal(call.conversation_id, 5);
  assert.equal(call.request_event_id, 2);
  assert.equal(call.error_status, 402);
  assert.equal(call.error_code, 'insufficient_balance');
  assert.match(call.error_message, /Insufficient Balance/);
  assert.equal(call.streamed, 0);
  assert.deepEqual(outer.callIds, [1]);
});

test('non-streamed JSON calls record the response hash and the manual purpose by default', async () => {
  const adapter = {
    async create() {
      return {
        id: 'resp_1',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"tool":"deep_research_hpa"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      };
    }
  };
  const { gateway, recorded } = makeGateway(adapter);
  const response = await gateway.createChatCompletion({
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: 'plan' }]
  });
  assert.equal(response.choices[0].message.content, '{"tool":"deep_research_hpa"}');
  const call = recorded[0];
  assert.equal(call.purpose, 'manual');
  assert.equal(call.response_format, 'json_object');
  assert.equal(call.response_characters, 28);
  assert.equal(call.response_sha256.length, 32);
  assert.equal(call.total_tokens, 15);
  assert.equal(call.provider_request_id, 'resp_1');
  assert.equal(call.finish_reason, 'stop');
  assert.throws(() => gateway.withContext({ purpose: 'nope' }, () => null), /Unknown inference purpose/);
});
