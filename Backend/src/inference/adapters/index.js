'use strict';

const { AnthropicMessagesAdapter } = require('./anthropicMessages');
const { AnthropicVertexAdapter } = require('./anthropicVertex');
const { GeminiGenerateContentAdapter } = require('./geminiGenerateContent');
const { GeminiVertexAdapter } = require('./geminiVertex');
const { OpenAIChatCompletionsAdapter } = require('./openaiChatCompletions');
const { OpenAIResponsesAdapter } = require('./openaiResponses');

const ADAPTERS = Object.freeze({
  anthropic_messages: AnthropicMessagesAdapter,
  anthropic_vertex: AnthropicVertexAdapter,
  gemini_generate_content: GeminiGenerateContentAdapter,
  gemini_vertex: GeminiVertexAdapter,
  openai_chat_completions: OpenAIChatCompletionsAdapter,
  openai_responses: OpenAIResponsesAdapter
});

// Adapters that authenticate with Google Application Default Credentials instead of a key held in
// the environment. Their provider row still names a credential env key, because the column is
// required, but the gateway does not insist that it is set.
const SELF_AUTHENTICATING = Object.freeze(new Set(['anthropic_vertex', 'gemini_vertex']));

function adapterNeedsPlatformCredential(adapterKey) {
  return !SELF_AUTHENTICATING.has(adapterKey);
}

function createInferenceAdapter(adapterKey, options) {
  const Adapter = ADAPTERS[adapterKey];
  if (!Adapter) throw new Error(`Unsupported inference adapter '${adapterKey}'.`);
  return new Adapter(options);
}

function isSupportedAdapter(adapterKey) {
  return Object.hasOwn(ADAPTERS, adapterKey);
}

module.exports = { createInferenceAdapter, isSupportedAdapter, adapterNeedsPlatformCredential };
