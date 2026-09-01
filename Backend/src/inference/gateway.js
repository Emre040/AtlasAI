'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createInferenceAdapter, isSupportedAdapter } = require('./adapters');
const { InferenceCallRepository } = require('../database/repositories/inferenceCalls');

const ACTIVE_MODEL_SQL = `
  SELECT
    m.id,
    m.provider_id,
    m.config_key,
    m.model_id,
    m.supports_streaming,
    m.supports_tools,
    m.supports_json_mode,
    m.supports_tool_role_messages,
    m.supports_vision,
    m.supports_reasoning,
    m.reasoning_effort,
    m.max_context_tokens,
    m.max_output_tokens,
    m.default_output_tokens,
    m.request_timeout_ms,
    m.max_retries,
    m.revision AS model_revision,
    p.provider_key,
    p.adapter_key,
    p.api_base_url,
    p.credential_env_key,
    p.status AS provider_status,
    p.revision AS provider_revision
  FROM \`atlasai\`.\`inference_models\` m
  JOIN \`atlasai\`.\`inference_providers\` p ON p.id = m.provider_id
  WHERE m.active_singleton = 1
  ORDER BY m.id
  LIMIT 2
`;

const PURPOSES = new Set(['router', 'preface', 'synthesis', 'answer', 'agent', 'batch', 'manual']);

function asBoolean(value) {
  return Number(value) === 1;
}

function validateProvider(row) {
  if (row.provider_status !== 'enabled') {
    throw new Error(`Active model provider '${row.provider_key}' is disabled.`);
  }
  if (!isSupportedAdapter(row.adapter_key)) {
    throw new Error(`Unsupported inference adapter '${row.adapter_key}'.`);
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(row.credential_env_key)) {
    throw new Error('The active provider has an invalid credential_env_key.');
  }

  let apiUrl;
  try {
    apiUrl = new URL(row.api_base_url);
  } catch {
    throw new Error('The active provider has an invalid API base URL.');
  }
  if (apiUrl.protocol !== 'https:') {
    throw new Error('The active provider API base URL must use HTTPS.');
  }

  const apiKey = process.env[row.credential_env_key];
  if (!apiKey) {
    throw new Error(`Missing credential required by the active provider: ${row.credential_env_key}.`);
  }
  return apiKey;
}

function rowToModel(row) {
  return Object.freeze({
    id: row.id,
    providerId: row.provider_id,
    configKey: row.config_key,
    modelId: row.model_id,
    providerKey: row.provider_key,
    adapterKey: row.adapter_key,
    apiBaseUrl: row.api_base_url,
    credentialEnvKey: row.credential_env_key,
    requestTimeoutMs: Number(row.request_timeout_ms),
    maxRetries: Number(row.max_retries),
    maxContextTokens: row.max_context_tokens === null ? null : Number(row.max_context_tokens),
    maxOutputTokens: row.max_output_tokens === null ? null : Number(row.max_output_tokens),
    defaultOutputTokens: Number(row.default_output_tokens),
    modelRevision: Number(row.model_revision),
    providerRevision: Number(row.provider_revision),
    supportsStreaming: asBoolean(row.supports_streaming),
    supportsTools: asBoolean(row.supports_tools),
    supportsJsonMode: asBoolean(row.supports_json_mode),
    supportsToolRoleMessages: asBoolean(row.supports_tool_role_messages),
    supportsVision: asBoolean(row.supports_vision),
    supportsReasoning: asBoolean(row.supports_reasoning),
    reasoningEffort: row.reasoning_effort ?? null
  });
}

function validateModel(model) {
  if (!model.supportsStreaming || !model.supportsTools) {
    throw new Error(`Active model '${model.configKey}' lacks streaming or tool-call support required by AtlasAI.`);
  }
  if (!Number.isInteger(model.defaultOutputTokens) || model.defaultOutputTokens <= 0) {
    throw new Error(`Active model '${model.configKey}' has an invalid default_output_tokens value.`);
  }
  if (model.maxOutputTokens !== null && model.defaultOutputTokens > model.maxOutputTokens) {
    throw new Error(`Active model '${model.configKey}' has default_output_tokens above its maximum.`);
  }
}

function validateRequest(request, model) {
  if (!request || !Array.isArray(request.messages)) throw new Error('Inference request messages are required.');
  if (request.model && request.model !== model.modelId) {
    throw new Error('Inference requests cannot override the database-selected active model.');
  }
  if (request.stream && !model.supportsStreaming) {
    throw new Error(`Active model '${model.configKey}' does not support streaming.`);
  }
  if (request.tools && !model.supportsTools) {
    throw new Error(`Active model '${model.configKey}' does not support tools.`);
  }
  if (request.response_format && !model.supportsJsonMode) {
    throw new Error(`Active model '${model.configKey}' does not support JSON mode.`);
  }
}

const CONTEXT_ID_KEYS = ['requestEventId', 'conversationId', 'runId', 'batchQueryId', 'workspaceId'];

// Row ids arrive as numbers (insertId) or digit strings (BIGINT columns); store them as numbers.
function contextId(value, key) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value);
  throw new TypeError(`Inference context ${key} must be an integer id.`);
}

// Validates and normalizes a context object in place.
function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('Inference context must be an object.');
  }
  if (context.purpose !== undefined && !PURPOSES.has(context.purpose)) {
    throw new TypeError(`Unknown inference purpose '${context.purpose}'.`);
  }
  for (const key of CONTEXT_ID_KEYS) {
    if (context[key] !== undefined) context[key] = contextId(context[key], key);
  }
  if (context.agentKey !== undefined && context.agentKey !== null && typeof context.agentKey !== 'string') {
    throw new TypeError('Inference context agentKey must be a string.');
  }
  return context;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

function elapsedMs(startedAt, endedAt = process.hrtime.bigint()) {
  return Number((endedAt - startedAt) / 1000n) / 1000;
}

function roundMs(value) {
  return value === null ? null : Math.max(0, Math.round(value));
}

function tokenNumber(value) {
  return Number.isFinite(Number(value)) && value !== null && value !== undefined ? Math.round(Number(value)) : null;
}

function usageFields(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_tokens: null, total_tokens: null };
  }
  const input = tokenNumber(usage.prompt_tokens);
  const output = tokenNumber(usage.completion_tokens);
  const total = tokenNumber(usage.total_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: tokenNumber(usage.prompt_tokens_details?.cached_tokens),
    output_tokens: output,
    reasoning_tokens: tokenNumber(usage.completion_tokens_details?.reasoning_tokens),
    total_tokens: total ?? (input !== null && output !== null ? input + output : null)
  };
}

function providerRequestId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 255 ? text.slice(0, 255) : text;
}

class InferenceGateway {
  constructor(db, { adapterFactory = createInferenceAdapter, callRepository = null } = {}) {
    this.db = db;
    this.adapterFactory = adapterFactory;
    this.adapters = new Map();
    this.modelContext = new AsyncLocalStorage();
    this.callContext = new AsyncLocalStorage();
    this.calls = callRepository || new InferenceCallRepository(db);
    this.model = null;
  }

  adapterCacheKey(model) {
    return [
      model.providerId,
      model.providerRevision,
      model.adapterKey,
      model.apiBaseUrl,
      model.credentialEnvKey,
      model.requestTimeoutMs,
      model.maxRetries
    ].join(':');
  }

  getAdapter(model, apiKey) {
    const key = this.adapterCacheKey(model);
    let adapter = this.adapters.get(key);
    if (!adapter) {
      adapter = this.adapterFactory(model.adapterKey, {
        apiKey,
        baseURL: model.apiBaseUrl,
        timeout: model.requestTimeoutMs,
        maxRetries: model.maxRetries
      });
      this.adapters.set(key, adapter);
    }
    return adapter;
  }

  async resolveActiveModel() {
    const [rows] = await this.db.execute(ACTIVE_MODEL_SQL);
    if (rows.length !== 1) {
      throw new Error(`Exactly one active inference model is required; found ${rows.length}.`);
    }

    const row = rows[0];
    const apiKey = validateProvider(row);
    const model = rowToModel(row);
    validateModel(model);
    const adapter = this.getAdapter(model, apiKey);
    this.model = model;
    return { model, adapter };
  }

  async initialize() {
    const { model } = await this.resolveActiveModel();
    console.log(`[Inference] Active model: ${model.configKey} (${model.providerKey}).`);
    return model;
  }

  getActiveModel() {
    const contextualModel = this.modelContext.getStore();
    if (contextualModel) return contextualModel;
    if (!this.model) throw new Error('Inference gateway is not initialized.');
    return this.model;
  }

  runWithActiveModel(model, callback) {
    return this.modelContext.run(model, callback);
  }

  // Call context: what a model request is for and which records it belongs to. Nested contexts
  // inherit the outer values; `callIds` collects the inference_calls ids recorded inside.
  withContext(context, callback) {
    validateContext(context);
    const parent = this.callContext.getStore() || {};
    const merged = { ...parent, ...context, callIds: context.callIds || parent.callIds || [] };
    return this.callContext.run(merged, callback);
  }

  getContext() {
    return this.callContext.getStore() || null;
  }

  // Mutates the current context in place so later calls in the same async scope see the value
  // (used when a record such as an ASO workspace is created after the context was opened).
  assignContext(values) {
    validateContext(values);
    const store = this.callContext.getStore();
    if (!store) return false;
    Object.assign(store, values);
    return true;
  }

  async createChatCompletion(request) {
    const contextualModel = this.modelContext.getStore();
    let model;
    let adapter;

    if (contextualModel) {
      model = contextualModel;
      const apiKey = process.env[model.credentialEnvKey];
      if (!apiKey) throw new Error(`Missing credential required by the active provider: ${model.credentialEnvKey}.`);
      adapter = this.getAdapter(model, apiKey);
    } else {
      ({ model, adapter } = await this.resolveActiveModel());
    }

    validateRequest(request, model);

    const context = this.callContext.getStore() || {};
    const record = {
      inference_model_id: model.id,
      request_event_id: context.requestEventId ?? null,
      conversation_id: context.conversationId ?? null,
      run_id: context.runId ?? null,
      batch_query_id: context.batchQueryId ?? null,
      workspace_id: context.workspaceId ?? null,
      purpose: context.purpose ?? 'manual',
      agent_key: context.agentKey ?? null,
      streamed: request.stream ? 1 : 0,
      message_count: request.messages.length,
      tool_count: Array.isArray(request.tools) ? request.tools.length : 0,
      response_format: request.response_format?.type ?? null,
      request_sha256: sha256(JSON.stringify({
        model: model.modelId,
        messages: request.messages,
        tools: request.tools ?? null,
        tool_choice: request.tool_choice ?? null,
        response_format: request.response_format ?? null
      })),
      started_unix_ms: Date.now()
    };
    const startedAt = process.hrtime.bigint();

    let result;
    try {
      result = await adapter.create(request, model);
    } catch (error) {
      await this.recordFailure(record, startedAt, null, error, context);
      throw error;
    }

    if (request.stream) return this.instrumentStream(result, record, startedAt, context);

    const choice = result?.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    // Time to first token only exists for streams; a whole-response call reports NULL and its
    // tokens-per-second is then plain throughput over the full latency.
    await this.recordCompletion(record, context, {
      startedAt,
      firstTokenAt: null,
      providerRequestId: result?.id,
      finishReason: choice?.finish_reason ?? null,
      toolCallCount: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls.length : 0,
      responseText: text,
      usage: result?.usage
    });
    return result;
  }

  async *instrumentStream(stream, record, startedAt, context) {
    let firstTokenAt = null;
    let text = '';
    let finishReason = null;
    let usage = null;
    let requestId = null;
    const toolCallIndexes = new Set();
    let completed = false;

    try {
      for await (const chunk of stream) {
        if (requestId === null && chunk?.id) requestId = chunk.id;
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta;
        const hasContent = typeof delta?.content === 'string' && delta.content.length > 0;
        const hasToolDelta = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;
        if (firstTokenAt === null && (hasContent || hasToolDelta)) firstTokenAt = process.hrtime.bigint();
        if (hasContent) text += delta.content;
        if (hasToolDelta) {
          for (const call of delta.tool_calls) toolCallIndexes.add(call.index ?? 0);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk?.usage) usage = chunk.usage;
        yield chunk;
      }
      completed = true;
    } catch (error) {
      await this.recordFailure(record, startedAt, firstTokenAt, error, context);
      throw error;
    } finally {
      if (completed) {
        await this.recordCompletion(record, context, {
          startedAt,
          firstTokenAt,
          providerRequestId: requestId,
          finishReason,
          toolCallCount: toolCallIndexes.size,
          responseText: text,
          usage
        });
      }
    }
  }

  async recordCompletion(record, context, { startedAt, firstTokenAt, providerRequestId: requestId, finishReason, toolCallCount, responseText, usage }) {
    const finishedAt = process.hrtime.bigint();
    const row = {
      ...record,
      ...usageFields(usage),
      status: 'completed',
      provider_request_id: providerRequestId(requestId),
      finish_reason: finishReason ? String(finishReason).slice(0, 32) : null,
      tool_call_count: toolCallCount,
      response_characters: responseText.length,
      response_sha256: responseText.length > 0 ? sha256(responseText) : null,
      first_token_latency_ms: firstTokenAt === null ? null : roundMs(elapsedMs(startedAt, firstTokenAt)),
      total_latency_ms: roundMs(elapsedMs(startedAt, finishedAt)),
      finished_unix_ms: Date.now()
    };
    const saved = await this.calls.record(row);
    if (Array.isArray(context.callIds)) context.callIds.push(saved.id);
    return saved;
  }

  async recordFailure(record, startedAt, firstTokenAt, error, context) {
    const finishedAt = process.hrtime.bigint();
    const row = {
      ...record,
      status: 'failed',
      error_status: Number.isInteger(error?.status) ? error.status : null,
      error_code: typeof error?.code === 'string' ? error.code.slice(0, 128) : null,
      error_message: String(error?.message || error || 'Inference request failed.').slice(0, 65535),
      first_token_latency_ms: firstTokenAt === null ? null : roundMs(elapsedMs(startedAt, firstTokenAt)),
      total_latency_ms: roundMs(elapsedMs(startedAt, finishedAt)),
      finished_unix_ms: Date.now()
    };
    const saved = await this.calls.record(row);
    if (Array.isArray(context.callIds)) context.callIds.push(saved.id);
    return saved;
  }

  createActiveModelMiddleware() {
    return async (req, res, next) => {
      try {
        const { model } = await this.resolveActiveModel();
        this.runWithActiveModel(model, next);
      } catch (error) {
        next(error);
      }
    };
  }
}

let gateway = null;

async function initializeInferenceGateway(db) {
  if (gateway) throw new Error('Inference gateway is already initialized.');
  gateway = new InferenceGateway(db);
  await gateway.initialize();
  return gateway;
}

function getInferenceGateway() {
  if (!gateway) throw new Error('Inference gateway is not initialized.');
  return gateway;
}

const inference = Object.freeze({
  chat: Object.freeze({
    completions: Object.freeze({
      create(request) {
        return getInferenceGateway().createChatCompletion(request);
      }
    })
  }),
  withContext(context, callback) {
    return getInferenceGateway().withContext(context, callback);
  },
  getContext() {
    return getInferenceGateway().getContext();
  },
  assignContext(values) {
    return getInferenceGateway().assignContext(values);
  }
});

function getActiveModel() {
  return getInferenceGateway().getActiveModel();
}

function resolveActiveModel() {
  return getInferenceGateway().resolveActiveModel().then(({ model }) => model);
}

function createActiveModelMiddleware() {
  return getInferenceGateway().createActiveModelMiddleware();
}

module.exports = {
  ACTIVE_MODEL_SQL,
  INFERENCE_PURPOSES: PURPOSES,
  InferenceGateway,
  createActiveModelMiddleware,
  getActiveModel,
  getInferenceGateway,
  inference,
  initializeInferenceGateway,
  resolveActiveModel
};
