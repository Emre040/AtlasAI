'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createInferenceAdapter, isSupportedAdapter } = require('./adapters');

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
    supportsReasoning: asBoolean(row.supports_reasoning)
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

class InferenceGateway {
  constructor(db, { adapterFactory = createInferenceAdapter } = {}) {
    this.db = db;
    this.adapterFactory = adapterFactory;
    this.adapters = new Map();
    this.modelContext = new AsyncLocalStorage();
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
    return adapter.create(request, model);
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
  })
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
  InferenceGateway,
  createActiveModelMiddleware,
  getActiveModel,
  getInferenceGateway,
  inference,
  initializeInferenceGateway,
  resolveActiveModel
};
