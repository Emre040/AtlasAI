'use strict';

const { AnthropicMessagesAdapter } = require('./anthropicMessages');
const { GeminiGenerateContentAdapter } = require('./geminiGenerateContent');
const { OpenAIChatCompletionsAdapter } = require('./openaiChatCompletions');
const { OpenAIResponsesAdapter } = require('./openaiResponses');

const ADAPTERS = Object.freeze({
  anthropic_messages: AnthropicMessagesAdapter,
  gemini_generate_content: GeminiGenerateContentAdapter,
  openai_chat_completions: OpenAIChatCompletionsAdapter,
  openai_responses: OpenAIResponsesAdapter
});

function createInferenceAdapter(adapterKey, options) {
  const Adapter = ADAPTERS[adapterKey];
  if (!Adapter) throw new Error(`Unsupported inference adapter '${adapterKey}'.`);
  return new Adapter(options);
}

function isSupportedAdapter(adapterKey) {
  return Object.hasOwn(ADAPTERS, adapterKey);
}

module.exports = { createInferenceAdapter, isSupportedAdapter };
