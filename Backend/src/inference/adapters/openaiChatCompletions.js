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
    return this.client.chat.completions.create({
      ...request,
      model: model.modelId,
      // Catalog-driven: e.g. GPT-5.6 on Chat Completions only accepts function tools with 'none'.
      ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {})
    });
  }
}

module.exports = { OpenAIChatCompletionsAdapter };
