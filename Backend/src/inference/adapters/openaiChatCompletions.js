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
      model: model.modelId
    });
  }
}

module.exports = { OpenAIChatCompletionsAdapter };
