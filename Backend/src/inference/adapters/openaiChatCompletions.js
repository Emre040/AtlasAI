'use strict';

const OpenAI = require('openai');

class OpenAIChatCompletionsAdapter {
  constructor({ apiKey, baseURL, timeout, maxRetries, client } = {}) {
    this.client = client || new OpenAI({
      apiKey,
      baseURL,
      timeout,
      maxRetries
    });
  }

  async create(request, model) {
    // prompt_cache is the gateway's hint for adapters with explicit caching; OpenAI caches
    // repeated prefixes on its own.
    const { prompt_cache: _promptCache, reasoning_effort: requestedEffort, ...rest } = request;
    const effort = requestedEffort || model.reasoningEffort;
    const body = {
      ...rest,
      model: model.modelId,
      // Catalog-driven: e.g. GPT-5.6 on Chat Completions only accepts function tools with 'none'.
      ...(effort ? { reasoning_effort: effort } : {})
    };
    // Some hosts (Groq) validate the model's tool-call arguments against the tool schema and
    // answer 400 when the model emitted a bad call, instead of returning the call for the caller
    // to reject. The model is not deterministic, so the same request is asked again a few times.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.client.chat.completions.create(body);
      } catch (error) {
        if (!isRejectedToolCall(error) || attempt > TOOL_CALL_REJECTION_RETRIES) throw error;
      }
    }
  }
}

const TOOL_CALL_REJECTION_RETRIES = 3;

function isRejectedToolCall(error) {
  return Number(error?.status) === 400 && /tool call validation failed/i.test(String(error?.message || ''));
}

module.exports = { OpenAIChatCompletionsAdapter, isRejectedToolCall };
