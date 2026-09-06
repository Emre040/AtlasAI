'use strict';

// Google Gemini through its native generateContent API. Speaks the gateway's OpenAI-shaped
// contract (messages, tools, response_format, stream) and adds what the OpenAI-compatible
// endpoint cannot do: explicit context caching of a stable prefix (system prompt plus tool
// declarations), so a loop that sends the same contract on every turn pays the cached price.

const crypto = require('node:crypto');

const DEFAULT_CACHE_TTL_SECONDS = 3600;
const CACHE_REFRESH_MARGIN_MS = 60_000;
const MIN_CACHE_CHARS = 6000; // below Google's minimum cache size a create is refused; skip the attempt

function asText(value, label) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new Error(`${label} must be text.`);
  return value.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string') throw new Error(`${label} contains an unsupported content block.`);
    return block.text;
  }).join('');
}

function parseJsonObject(raw, fallback) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

// Gemini's schema dialect: an OpenAPI subset with upper-case types and no additionalProperties.
// Anything it cannot express (a free-form object, an untyped value) becomes a string the tool
// side parses as JSON.
function convertSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'STRING' };
  const out = {};
  const type = typeof schema.type === 'string' ? schema.type.toLowerCase() : null;
  if (schema.description) out.description = String(schema.description);
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.length) throw new Error('Gemini schema anyOf must contain at least one alternative');
    out.anyOf = schema.anyOf.map(convertSchema);
    return out;
  }
  if (type === 'null') { out.type = 'NULL'; return out; }
  if (Array.isArray(schema.enum)) { out.type = 'STRING'; out.enum = schema.enum.map(String); return out; }
  if (type === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
    if (!properties || Object.keys(properties).length === 0) {
      return { type: 'STRING', description: `${out.description ? out.description + '; ' : ''}a JSON object written as text` };
    }
    out.type = 'OBJECT';
    out.properties = {};
    for (const [name, sub] of Object.entries(properties)) out.properties[name] = convertSchema(sub);
    if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required.filter(r => out.properties[r]);
    return out;
  }
  if (type === 'array') { out.type = 'ARRAY'; out.items = convertSchema(schema.items); return out; }
  if (type === 'integer') { out.type = 'INTEGER'; return out; }
  if (type === 'number') { out.type = 'NUMBER'; return out; }
  if (type === 'boolean') { out.type = 'BOOLEAN'; return out; }
  out.type = 'STRING';
  if (!type) out.description = `${out.description ? out.description + '; ' : ''}a value (number or text)`;
  return out;
}

function convertTools(tools) {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) throw new Error('tools must be an array.');
  if (tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map(tool => {
      if (tool?.type !== 'function' || !tool.function?.name) throw new Error('Gemini adapter received an invalid function tool.');
      return {
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        parameters: convertSchema(tool.function.parameters || { type: 'object', properties: {} })
      };
    })
  }];
}

function convertToolChoice(toolChoice, hasTools) {
  if (toolChoice === undefined || !hasTools) return undefined;
  if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (toolChoice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (toolChoice?.type === 'function' && toolChoice.function?.name) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.function.name] } };
  }
  throw new Error('Gemini adapter received an unsupported tool_choice.');
}

// OpenAI-shaped messages to Gemini contents. Tool results need the function's name, which the
// preceding assistant call supplies.
function convertMessages(inputMessages) {
  if (!Array.isArray(inputMessages) || inputMessages.length === 0) throw new Error('Gemini requests require at least one message.');
  const system = [];
  const contents = [];
  const callNames = new Map();
  const push = (role, parts) => {
    if (!parts.length) return;
    const previous = contents[contents.length - 1];
    if (previous && previous.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of inputMessages) {
    if (!message || typeof message.role !== 'string') throw new Error('Invalid chat message.');
    if (message.role === 'system') { system.push(asText(message.content, 'System message')); continue; }
    if (message.role === 'user') { push('user', [{ text: asText(message.content, 'User message') }]); continue; }
    if (message.role === 'assistant') {
      const parts = [];
      if (message.content !== null && message.content !== undefined && message.content !== '') parts.push({ text: asText(message.content, 'Assistant message') });
      for (const call of message.tool_calls || []) {
        if (!call?.function?.name) throw new Error('Invalid assistant tool call.');
        if (call.id) callNames.set(call.id, call.function.name);
        // Gemini's thinking models want the signature they issued with the call; a call replayed
        // without one (the chat keeps only name and arguments) skips the check as Google documents.
        parts.push({ functionCall: { name: call.function.name, args: parseJsonObject(call.function.arguments, {}) }, thoughtSignature: call.thought_signature || 'skip_thought_signature_validator' });
      }
      push('model', parts);
      continue;
    }
    if (message.role === 'tool') {
      const name = callNames.get(message.tool_call_id) || message.name;
      if (!name) throw new Error('Tool result cannot be matched to a tool call.');
      const text = asText(message.content, 'Tool result');
      push('user', [{ functionResponse: { name, response: { result: parseJsonObject(text, null) ?? text } } }]);
      continue;
    }
    throw new Error(`Unsupported chat message role '${message.role}'.`);
  }
  if (contents.length === 0) throw new Error('Gemini requests require a user or assistant message.');
  return { system: system.length ? system.join('\n\n') : undefined, contents };
}

// Catalog reasoning_effort to Gemini's thinking configuration.
function thinkingConfig(effort) {
  if (!effort) return undefined;
  const level = String(effort).toLowerCase();
  if (level === 'none') return { thinkingBudget: 0 };
  if (level === 'minimal' || level === 'low') return { thinkingLevel: 'low' };
  if (level === 'medium') return { thinkingLevel: 'medium' };
  if (level === 'high') return { thinkingLevel: 'high' };
  return undefined;
}

function mapFinishReason(reason) {
  if (!reason) return null;
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT' || reason === 'SPII') return 'content_filter';
  return String(reason).toLowerCase();
}

function normalizeUsage(meta = {}) {
  const prompt = Number(meta.promptTokenCount || 0);
  const cached = Number(meta.cachedContentTokenCount || 0);
  const completion = Number(meta.candidatesTokenCount || 0);
  const thoughts = Number(meta.thoughtsTokenCount || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion + thoughts,
    total_tokens: prompt + completion + thoughts,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(thoughts > 0 ? { completion_tokens_details: { reasoning_tokens: thoughts } } : {})
  };
}

let callCounter = 0;
function callId() { callCounter += 1; return `call_${Date.now().toString(36)}_${callCounter}`; }

function partsToMessage(parts) {
  let text = '';
  const toolCalls = [];
  for (const part of parts || []) {
    if (part.thought) continue;
    if (typeof part.text === 'string') text += part.text;
    if (part.functionCall) toolCalls.push({ id: part.functionCall.id || callId(), type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }, ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}) });
  }
  return { text, toolCalls };
}

function normalizeResponse(body, modelId) {
  const candidate = body?.candidates?.[0];
  if (!candidate) {
    const blocked = body?.promptFeedback?.blockReason;
    throw new Error(blocked ? `Gemini blocked the prompt: ${blocked}` : 'Gemini returned no candidates.');
  }
  const { text, toolCalls } = partsToMessage(candidate.content?.parts);
  return {
    id: body.responseId || `gemini_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.modelVersion || modelId,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? 'tool_calls' : mapFinishReason(candidate.finishReason)
    }],
    usage: normalizeUsage(body.usageMetadata)
  };
}

// Server-sent events from streamGenerateContent, as OpenAI-shaped chunks.
async function* normalizeStream(response, modelId) {
  const decoder = new TextDecoder();
  let buffer = '';
  let id = null;
  let toolIndex = 0;
  let sawToolCall = false;
  let finish = null;
  let usage = null;
  const emit = (delta, finishReason = null, extra = {}) => ({ id: id || `gemini_${Date.now()}`, object: 'chat.completion.chunk', model: modelId, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra });
  const handle = function* (event) {
    if (!event) return;
    if (!id && event.responseId) id = event.responseId;
    const candidate = event.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      if (part.thought) continue;
      if (typeof part.text === 'string' && part.text) yield emit({ content: part.text });
      if (part.functionCall) {
        sawToolCall = true;
        yield emit({ tool_calls: [{ index: toolIndex++, id: part.functionCall.id || callId(), type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }, ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}) }] });
      }
    }
    if (candidate?.finishReason) finish = candidate.finishReason;
    if (event.usageMetadata) usage = normalizeUsage(event.usageMetadata);
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (!data) continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.error) throw new Error(event.error.message || 'Gemini stream failed.');
      yield* handle(event);
    }
  }
  if (buffer.trim()) {
    const data = buffer.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    if (data) { try { yield* handle(JSON.parse(data)); } catch { /* trailing partial event */ } }
  }
  yield emit({}, sawToolCall ? 'tool_calls' : mapFinishReason(finish) || 'stop', usage ? { usage } : {});
}

function buildRequest(request, model) {
  const converted = convertMessages(request.messages);
  const tools = request.tool_choice === 'none' ? undefined : convertTools(request.tools);
  const toolConfig = convertToolChoice(request.tool_choice, Boolean(tools));
  const generationConfig = {};
  const maxTokens = request.max_completion_tokens ?? request.max_tokens ?? model.defaultOutputTokens;
  if (Number.isInteger(Number(maxTokens)) && Number(maxTokens) > 0) generationConfig.maxOutputTokens = Number(maxTokens);
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.top_p !== undefined) generationConfig.topP = request.top_p;
  if (request.stop !== undefined) generationConfig.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  if (request.response_format?.type === 'json_object') generationConfig.responseMimeType = 'application/json';
  if (request.response_format?.type === 'json_schema' && request.response_format.json_schema?.schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = convertSchema(request.response_format.json_schema.schema);
  }
  const thinking = thinkingConfig(request.reasoning_effort || model.reasoningEffort);
  if (thinking) generationConfig.thinkingConfig = thinking;
  return {
    system: converted.system,
    contents: converted.contents,
    tools,
    toolConfig,
    generationConfig
  };
}

class GeminiGenerateContentAdapter {
  constructor({ apiKey, baseURL, timeout, maxRetries, fetchImpl } = {}) {
    if (!apiKey) throw new Error('Gemini adapter requires an API key.');
    this.apiKey = apiKey;
    this.baseURL = String(baseURL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    this.timeout = Number(timeout) > 0 ? Number(timeout) : 120_000;
    this.maxRetries = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : 2;
    this.fetch = fetchImpl || globalThis.fetch;
    this.caches = new Map(); // prefix hash → { name, expiresAt }
    this.uncacheable = new Set();
  }

  async request(method, pathname, body, { stream = false } = {}) {
    const url = `${this.baseURL}/v1beta/${pathname}${stream ? '?alt=sse' : ''}`;
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      let response;
      try {
        response = await this.fetch(url, {
          method,
          headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) { attempt += 1; await new Promise(r => setTimeout(r, 500 * attempt)); continue; }
        throw new Error(`Gemini request failed: ${error.message}`);
      }
      if (response.ok) {
        if (stream) { response.body.once?.('end', () => clearTimeout(timer)); return response; }
        clearTimeout(timer);
        return response.json();
      }
      const text = await response.text().catch(() => '');
      clearTimeout(timer);
      let message = text;
      try { message = JSON.parse(text)?.error?.message || text; } catch { /* plain text */ }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) { attempt += 1; await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
      const error = new Error(`Gemini ${response.status}: ${String(message).slice(0, 500)}`);
      error.status = response.status;
      throw error;
    }
  }

  // A cached prefix for (model, system, tools): created once, reused until it expires.
  async cachedPrefix(model, built, options) {
    const material = JSON.stringify({ model: model.modelId, system: built.system, tools: built.tools, toolConfig: built.toolConfig });
    if (material.length < MIN_CACHE_CHARS) return null;
    const hash = crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    if (this.uncacheable.has(hash)) return null;
    const existing = this.caches.get(hash);
    if (existing && existing.expiresAt - Date.now() > CACHE_REFRESH_MARGIN_MS) return existing.name;
    const ttl = Number(options?.ttl_seconds) > 0 ? Number(options.ttl_seconds) : DEFAULT_CACHE_TTL_SECONDS;
    try {
      const created = await this.request('POST', 'cachedContents', {
        model: `models/${model.modelId}`,
        displayName: `atlasai ${String(options?.key || 'prefix').slice(0, 60)}`,
        ...(built.system ? { systemInstruction: { parts: [{ text: built.system }] } } : {}),
        ...(built.tools ? { tools: built.tools } : {}),
        ...(built.toolConfig ? { toolConfig: built.toolConfig } : {}),
        ttl: `${ttl}s`
      });
      const expiresAt = created.expireTime ? Date.parse(created.expireTime) : Date.now() + ttl * 1000;
      this.caches.set(hash, { name: created.name, expiresAt });
      return created.name;
    } catch (error) {
      // Too small, unsupported for this model, or a transient failure: proceed without the cache.
      if (error.status && error.status < 500) this.uncacheable.add(hash);
      return null;
    }
  }

  async create(request, model) {
    const built = buildRequest(request, model);
    const cacheName = request.prompt_cache ? await this.cachedPrefix(model, built, request.prompt_cache) : null;
    const body = {
      contents: built.contents,
      generationConfig: built.generationConfig,
      ...(cacheName ? { cachedContent: cacheName } : {
        ...(built.system ? { systemInstruction: { parts: [{ text: built.system }] } } : {}),
        ...(built.tools ? { tools: built.tools } : {}),
        ...(built.toolConfig ? { toolConfig: built.toolConfig } : {})
      })
    };
    const method = request.stream ? 'streamGenerateContent' : 'generateContent';
    let result;
    try {
      result = await this.request('POST', `models/${model.modelId}:${method}`, body, { stream: Boolean(request.stream) });
    } catch (error) {
      // A cache that vanished server-side: forget it and send the prefix inline once.
      if (cacheName && error.status && [400, 403, 404].includes(error.status)) {
        for (const [hash, entry] of this.caches) if (entry.name === cacheName) this.caches.delete(hash);
        return this.create({ ...request, prompt_cache: undefined }, model);
      }
      throw error;
    }
    if (request.stream) return normalizeStream(result, model.modelId);
    return normalizeResponse(result, model.modelId);
  }
}

module.exports = { GeminiGenerateContentAdapter, buildRequest, convertMessages, convertSchema, convertTools, normalizeResponse, normalizeStream, normalizeUsage };
