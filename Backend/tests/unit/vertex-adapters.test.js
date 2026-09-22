'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { regionFromBaseUrl, VertexCredentials } = require('../../src/inference/adapters/vertex');
const { GeminiVertexAdapter } = require('../../src/inference/adapters/geminiVertex');
const { AnthropicVertexAdapter } = require('../../src/inference/adapters/anthropicVertex');
const { createInferenceAdapter, isSupportedAdapter, adapterNeedsPlatformCredential } = require('../../src/inference/adapters');
const { InferenceGateway } = require('../../src/inference/gateway');

const model = Object.freeze({ configKey: 'vertex-gemini-3.8-flash', modelId: 'gemini-3.8-flash', defaultOutputTokens: 4096, reasoningEffort: 'low' });

// Credentials that never touch Google: a fixed project and a fixed token.
function fakeCredentials(project = 'hpa-atlas') {
  return {
    project: async () => project,
    authHeaders: async () => ({ authorization: 'Bearer test-token' })
  };
}

function recordingFetch(body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

test('the region comes from the base URL, for all three Vertex endpoint shapes', () => {
  assert.equal(regionFromBaseUrl('https://aiplatform.googleapis.com'), 'global');
  assert.equal(regionFromBaseUrl('https://aiplatform.eu.rep.googleapis.com'), 'eu');
  assert.equal(regionFromBaseUrl('https://aiplatform.us.rep.googleapis.com'), 'us');
  assert.equal(regionFromBaseUrl('https://europe-west1-aiplatform.googleapis.com'), 'europe-west1');
  assert.equal(regionFromBaseUrl('https://us-east5-aiplatform.googleapis.com'), 'us-east5');
  assert.throws(() => regionFromBaseUrl('https://api.anthropic.com'), /not a Vertex AI endpoint/);
  assert.throws(() => regionFromBaseUrl('not a url'), /not a valid Vertex AI base URL/);
});

test('both Vertex adapters are registered and neither needs a platform API key', () => {
  assert.equal(isSupportedAdapter('anthropic_vertex'), true);
  assert.equal(isSupportedAdapter('gemini_vertex'), true);
  assert.equal(adapterNeedsPlatformCredential('anthropic_vertex'), false);
  assert.equal(adapterNeedsPlatformCredential('gemini_vertex'), false);
  assert.equal(adapterNeedsPlatformCredential('gemini_generate_content'), true);
  assert.equal(adapterNeedsPlatformCredential('anthropic_messages'), true);
});

test('a Gemini call goes to the project and region path with a bearer token', async () => {
  const { calls, fetchImpl } = recordingFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } });
  const adapter = new GeminiVertexAdapter({
    baseURL: 'https://europe-west1-aiplatform.googleapis.com',
    fetchImpl,
    credentials: fakeCredentials()
  });

  const result = await adapter.create({ messages: [{ role: 'user', content: 'go' }] }, model);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://europe-west1-aiplatform.googleapis.com/v1/projects/hpa-atlas/locations/europe-west1/publishers/google/models/gemini-3.8-flash:generateContent'
  );
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
  assert.equal(calls[0].init.headers['x-goog-api-key'], undefined);
  assert.equal(result.choices[0].message.content, 'ok');
  assert.equal(result.usage.prompt_tokens, 10);
});

test('a streamed Gemini call asks for server-sent events on the same path', async () => {
  const { calls, fetchImpl } = recordingFetch({});
  // A short timeout because the fake response carries no stream to end, and the adapter clears its
  // abort timer when the stream does. Only the URL the request was addressed to matters here.
  const adapter = new GeminiVertexAdapter({ baseURL: 'https://aiplatform.googleapis.com', timeout: 50, fetchImpl, credentials: fakeCredentials() });
  await adapter.create({ messages: [{ role: 'user', content: 'go' }], stream: true }, model).catch(() => {});
  assert.equal(
    calls[0].url,
    'https://aiplatform.googleapis.com/v1/projects/hpa-atlas/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse'
  );
});

test('a context cache is created under the location and names the model in full', async () => {
  const cacheBody = { name: 'projects/hpa-atlas/locations/europe-west1/cachedContents/9', expireTime: new Date(Date.now() + 3_600_000).toISOString() };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const isCache = url.endsWith('/cachedContents');
    return {
      ok: true,
      status: 200,
      json: async () => (isCache ? cacheBody : { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: {} }),
      text: async () => ''
    };
  };
  const adapter = new GeminiVertexAdapter({ baseURL: 'https://europe-west1-aiplatform.googleapis.com', fetchImpl, credentials: fakeCredentials() });

  await adapter.create({
    messages: [{ role: 'system', content: 'r'.repeat(7000) }, { role: 'user', content: 'go' }],
    prompt_cache: { key: 'study' }
  }, model);

  assert.equal(calls[0].url, 'https://europe-west1-aiplatform.googleapis.com/v1/projects/hpa-atlas/locations/europe-west1/cachedContents');
  assert.equal(calls[0].body.model, 'projects/hpa-atlas/locations/europe-west1/publishers/google/models/gemini-3.8-flash');
  // The second call sends the cache by name instead of repeating the system instruction.
  assert.equal(calls[1].body.cachedContent, cacheBody.name);
  assert.equal(calls[1].body.systemInstruction, undefined);
});

test('the Claude adapter reuses the Messages conversions and puts the model in the URL', async () => {
  const sent = [];
  const client = {
    messages: {
      create: async params => {
        sent.push(params);
        return { id: 'msg_1', model: params.model, content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 1 } };
      }
    }
  };
  const adapter = new AnthropicVertexAdapter({ client });
  const claude = { configKey: 'vertex-claude-opus-5', modelId: 'claude-opus-5', defaultOutputTokens: 4096 };

  const result = await adapter.create({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'go' }] }, claude);

  assert.equal(sent[0].model, 'claude-opus-5');
  assert.equal(sent[0].system, 'rules');
  assert.equal(result.choices[0].message.content, 'hello');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.usage.prompt_tokens, 4);
});

test('the factory builds a Vertex adapter from a provider row', () => {
  const adapter = createInferenceAdapter('gemini_vertex', { baseURL: 'https://us-east5-aiplatform.googleapis.com', apiKey: '', timeout: 1000, maxRetries: 0 });
  assert.equal(adapter.region, 'us-east5');
  assert.equal(adapter.apiKey, null);
});

test('a project must be configured or discoverable, and the error says which variable to set', async () => {
  const credentials = new VertexCredentials({ auth: { getProjectId: async () => null, getClient: async () => ({}) } });
  credentials.configuredProject = null;
  await assert.rejects(() => credentials.project(), /GOOGLE_CLOUD_PROJECT/);
});

test('a Vertex model binds with no API key, and a key-based model still requires one', () => {
  const gateway = new InferenceGateway(null);
  const vertex = { ...model, adapterKey: 'gemini_vertex' };
  const studio = { ...model, configKey: 'gemini-3.8-flash', adapterKey: 'gemini_generate_content' };
  const bind = (m, apiKey) => gateway.runWithBinding(
    { model: m, apiKey, credentialSource: 'platform', modelSelection: 'auto' },
    () => gateway.getBinding().model.adapterKey
  );

  // This is the shape platformCredential() hands back for a self-authenticating adapter.
  assert.equal(bind(vertex, ''), 'gemini_vertex');
  assert.equal(bind(studio, 'AIza-test'), 'gemini_generate_content');
  assert.throws(() => bind(studio, ''), /requires an API key/);
  assert.throws(() => bind(vertex, undefined), /requires an API key/);
});
