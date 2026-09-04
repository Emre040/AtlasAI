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

  create(request, model) {
    // prompt_cache is the gateway's hint for adapters with explicit caching; OpenAI caches
    // repeated prefixes on its own.
    const { prompt_cache: _promptCache, reasoning_effort: requestedEffort, ...rest } = request;
    const effort = requestedEffort || model.reasoningEffort;
    return this.client.chat.completions.create({
      ...rest,
      model: model.modelId,
      // Catalog-driven: e.g. GPT-5.6 on Chat Completions only accepts function tools with 'none'.
      ...(effort ? { reasoning_effort: effort } : {})
    });
  }
}

module.exports = { OpenAIChatCompletionsAdapter };
