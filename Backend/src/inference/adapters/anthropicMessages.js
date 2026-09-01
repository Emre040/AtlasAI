'use strict';

const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default || AnthropicModule;
const JSON_OBJECT_INSTRUCTION = 'Return exactly one valid JSON object and no surrounding text.';

function asText(value, label) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new Error(`${label} must be text.`);

  return value.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      throw new Error(`${label} contains an unsupported content block.`);
    }
    return block.text;
  }).join('');
}

function parseToolArguments(raw, toolName) {
  try {
    const value = JSON.parse(raw || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`Tool call '${toolName}' has invalid JSON arguments.`);
  }
}

function appendMessage(messages, role, blocks) {
  if (blocks.length === 0) return;
  const previous = messages[messages.length - 1];
  if (previous?.role === role) {
    previous.content.push(...blocks);
    return;
  }
  messages.push({ role, content: blocks });
}

function convertMessages(inputMessages, { jsonObjectMode = false } = {}) {
  if (!Array.isArray(inputMessages) || inputMessages.length === 0) {
    throw new Error('Anthropic Messages requests require at least one message.');
  }

  const system = [];
  const messages = [];

  for (const message of inputMessages) {
    if (!message || typeof message.role !== 'string') throw new Error('Invalid chat message.');

    if (message.role === 'system') {
      system.push(asText(message.content, 'System message'));
      continue;
    }

    if (message.role === 'user') {
      appendMessage(messages, 'user', [{ type: 'text', text: asText(message.content, 'User message') }]);
      continue;
    }

    if (message.role === 'assistant') {
      const blocks = [];
      if (message.content !== null && message.content !== undefined && message.content !== '') {
        blocks.push({ type: 'text', text: asText(message.content, 'Assistant message') });
      }
      for (const toolCall of message.tool_calls || []) {
        if (toolCall?.type !== 'function' || !toolCall.id || !toolCall.function?.name) {
          throw new Error('Invalid assistant tool call.');
        }
        blocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments, toolCall.function.name)
        });
      }
      appendMessage(messages, 'assistant', blocks);
      continue;
    }

    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('Tool result is missing tool_call_id.');
      appendMessage(messages, 'user', [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: asText(message.content, 'Tool result')
      }]);
      continue;
    }

    throw new Error(`Unsupported chat message role '${message.role}'.`);
  }

  if (jsonObjectMode) system.push(JSON_OBJECT_INSTRUCTION);
  if (messages.length === 0) throw new Error('Anthropic Messages requests require a user or assistant message.');

  return {
    system: system.length > 0 ? system.join('\n\n') : undefined,
    messages
  };
}

function convertTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw new Error('tools must be an array.');
  return tools.map(tool => {
    if (tool?.type !== 'function' || !tool.function?.name || !tool.function?.parameters) {
      throw new Error('Anthropic adapter received an invalid function tool.');
    }
    return {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
      ...(tool.function.strict === undefined ? {} : { strict: Boolean(tool.function.strict) })
    };
  });
}

function convertToolChoice(toolChoice, hasTools) {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === 'none') return undefined;
  if (!hasTools) throw new Error('tool_choice requires at least one tool.');
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice?.type === 'function' && toolChoice.function?.name) {
    return { type: 'tool', name: toolChoice.function.name };
  }
  throw new Error('Anthropic adapter received an unsupported tool_choice.');
}

function convertResponseFormat(responseFormat) {
  if (responseFormat === undefined) return { jsonObjectMode: false, outputConfig: undefined };
  if (responseFormat?.type === 'json_object') {
    return { jsonObjectMode: true, outputConfig: undefined };
  }
  if (responseFormat?.type === 'json_schema' && responseFormat.json_schema?.schema) {
    return {
      jsonObjectMode: false,
      outputConfig: {
        format: {
          type: 'json_schema',
          schema: responseFormat.json_schema.schema
        }
      }
    };
  }
  throw new Error('Anthropic adapter received an unsupported response_format.');
}

function mapFinishReason(reason) {
  if (reason === null || reason === undefined) return null;
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'refusal') return 'content_filter';
  if (reason === 'end_turn' || reason === 'stop_sequence' || reason === 'pause_turn') return 'stop';
  return reason;
}

// Anthropic reports uncached input, cache reads, and cache writes separately; the internal
// contract follows the OpenAI shape where prompt_tokens is the whole prompt and
// prompt_tokens_details.cached_tokens is the cached subset.
function normalizeUsage(usage = {}) {
  const uncachedTokens = Number(usage.input_tokens || 0);
  const cachedTokens = Number(usage.cache_read_input_tokens || 0);
  const cacheWriteTokens = Number(usage.cache_creation_input_tokens || 0);
  const promptTokens = uncachedTokens + cachedTokens + cacheWriteTokens;
  const completionTokens = Number(usage.output_tokens || 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {})
  };
}

// Claude models (Haiku 4.5 in particular) may wrap a JSON reply in one markdown code fence.
// Exactly one fenced block or one bare object is accepted; anything else is an error.
function extractJsonObjectText(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function assertJsonObject(text) {
  const jsonText = extractJsonObjectText(text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Anthropic returned invalid JSON for json_object mode: ${String(text || '').slice(0, 200)}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Anthropic returned a non-object value for json_object mode.');
  }
  return jsonText;
}

function normalizeResponse(message, jsonObjectMode) {
  let text = '';
  const toolCalls = [];

  for (const block of message.content || []) {
    if (block.type === 'text') text += block.text || '';
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      });
    }
  }

  if (jsonObjectMode) text = assertJsonObject(text);

  return {
    id: message.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: message.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      },
      finish_reason: mapFinishReason(message.stop_reason)
    }],
    usage: normalizeUsage(message.usage)
  };
}

async function* normalizeStream(stream, modelId) {
  let messageId = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let nextToolIndex = 0;
  const toolIndexes = new Map();

  for await (const event of stream) {
    if (event.type === 'error') {
      throw new Error(event.error?.message || 'Anthropic stream failed.');
    }

    if (event.type === 'message_start') {
      messageId = event.message?.id || messageId;
      promptTokens = Number(event.message?.usage?.input_tokens || 0);
      continue;
    }

    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'text' && block.text) {
        yield {
          id: messageId,
          object: 'chat.completion.chunk',
          model: modelId,
          choices: [{ index: 0, delta: { content: block.text }, finish_reason: null }]
        };
      }
      if (block?.type === 'tool_use') {
        const toolIndex = nextToolIndex++;
        toolIndexes.set(event.index, toolIndex);
        yield {
          id: messageId,
          object: 'chat.completion.chunk',
          model: modelId,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolIndex,
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: '' }
              }]
            },
            finish_reason: null
          }]
        };
      }
      continue;
    }

    if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        yield {
          id: messageId,
          object: 'chat.completion.chunk',
          model: modelId,
          choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }]
        };
      }
      if (event.delta?.type === 'input_json_delta') {
        const toolIndex = toolIndexes.get(event.index);
        if (toolIndex === undefined) throw new Error('Anthropic streamed tool arguments before a tool start event.');
        yield {
          id: messageId,
          object: 'chat.completion.chunk',
          model: modelId,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolIndex,
                function: { arguments: event.delta.partial_json || '' }
              }]
            },
            finish_reason: null
          }]
        };
      }
      continue;
    }

    if (event.type === 'message_delta') {
      completionTokens = Number(event.usage?.output_tokens || completionTokens);
      yield {
        id: messageId,
        object: 'chat.completion.chunk',
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: mapFinishReason(event.delta?.stop_reason)
        }],
        usage: normalizeUsage({ input_tokens: promptTokens, output_tokens: completionTokens })
      };
    }
  }
}

function buildRequest(request, model) {
  const supportedKeys = new Set([
    'messages',
    'stream',
    'stream_options',
    'tools',
    'tool_choice',
    'temperature',
    'top_p',
    'stop',
    'max_tokens',
    'max_completion_tokens',
    'response_format',
    'model'
  ]);
  const unsupported = Object.keys(request || {}).filter(key => !supportedKeys.has(key));
  if (unsupported.length > 0) {
    throw new Error(`Anthropic adapter does not support request field(s): ${unsupported.join(', ')}.`);
  }

  const { jsonObjectMode, outputConfig } = convertResponseFormat(request.response_format);
  if (jsonObjectMode && request.stream) {
    throw new Error('Anthropic json_object mode cannot be streamed because AtlasAI validates the complete object.');
  }
  const converted = convertMessages(request.messages, { jsonObjectMode });
  const tools = request.tool_choice === 'none' ? undefined : convertTools(request.tools);
  const toolChoice = convertToolChoice(request.tool_choice, Boolean(tools?.length));
  const maxTokens = request.max_completion_tokens ?? request.max_tokens ?? model.defaultOutputTokens;
  if (!Number.isInteger(Number(maxTokens)) || Number(maxTokens) <= 0) {
    throw new Error(`Model '${model.configKey}' requires a positive default_output_tokens value.`);
  }

  return {
    params: {
      model: model.modelId,
      max_tokens: Number(maxTokens),
      messages: converted.messages,
      ...(converted.system ? { system: converted.system } : {}),
      ...(request.stream ? { stream: true } : {}),
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      // Sampling parameters are accepted from the internal contract but never forwarded:
      // Claude Opus 5 and Sonnet 5 reject temperature/top_p with HTTP 400, and the
      // agents only ever send temperature 0 for determinism, which Claude does not need.
      ...(request.stop === undefined ? {} : {
        stop_sequences: Array.isArray(request.stop) ? request.stop : [request.stop]
      }),
      ...(outputConfig ? { output_config: outputConfig } : {})
    },
    jsonObjectMode
  };
}

class AnthropicMessagesAdapter {
  constructor({ apiKey, baseURL, timeout, maxRetries, client } = {}) {
    this.client = client || new Anthropic({
      apiKey,
      baseURL,
      timeout,
      maxRetries
    });
  }

  async create(request, model) {
    const { params, jsonObjectMode } = buildRequest(request, model);
    const result = await this.client.messages.create(params);
    if (request.stream) return normalizeStream(result, model.modelId);
    return normalizeResponse(result, jsonObjectMode);
  }
}

module.exports = {
  AnthropicMessagesAdapter,
  buildRequest,
  convertMessages,
  normalizeResponse,
  normalizeStream
};
