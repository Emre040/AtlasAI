'use strict';

const OpenAI = require('openai');

// The OpenAI Responses API, for the models that take function tools together with reasoning
// only there (GPT-5.6 on Chat Completions accepts tools only with reasoning_effort 'none').
// The gateway and the agents speak Chat Completions; this adapter translates the request
// there and the response back, so nothing above it changes.
class OpenAIResponsesAdapter {
  constructor({ apiKey, baseURL, timeout, maxRetries, client } = {}) {
    this.client = client || new OpenAI({
      apiKey,
      baseURL,
      timeout,
      maxRetries
    });
  }

  async create(request, model) {
    if (request.stream) throw new Error('The Responses adapter does not stream.');
    const response = await this.client.responses.create(buildRequest(request, model));
    return normalizeResponse(response, model);
  }
}

const text = content => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
  return content === null || content === undefined ? '' : String(content);
};

// System messages become the instructions; user, assistant and tool messages become input
// items, a tool call as a function_call item and its result as a function_call_output item.
function buildRequest(request, model) {
  const { messages = [], tools, tool_choice: toolChoice, temperature, response_format: responseFormat, max_tokens: maxTokens, max_completion_tokens: maxCompletionTokens, reasoning_effort: requestedEffort } = request;
  const effort = requestedEffort || model.reasoningEffort || null;
  const instructions = messages.filter(m => m.role === 'system').map(m => text(m.content)).join('\n\n');
  const input = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') input.push({ role: 'user', content: text(m.content) });
    else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: text(m.content) });
      for (const call of m.tool_calls || []) input.push({ type: 'function_call', call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || '{}' });
    } else if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: text(m.content) });
  }
  const body = { model: model.modelId, store: false, input, ...(instructions ? { instructions } : {}) };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map(t => ({ type: 'function', name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } }));
  }
  if (toolChoice) body.tool_choice = typeof toolChoice === 'string' ? toolChoice : { type: 'function', name: toolChoice.function?.name };
  // Reasoning models take no temperature; without reasoning the caller's temperature stands.
  const reasoning = effort && effort !== 'none';
  if (reasoning) body.reasoning = { effort };
  else if (typeof temperature === 'number') body.temperature = temperature;
  if (responseFormat?.type === 'json_object') {
    body.text = { format: { type: 'json_object' } };
    // The Responses API refuses the JSON format unless an input message says "json"; the
    // instructions do not count, so the last user item gets the word when none has it.
    const lastUser = [...input].reverse().find(item => item.role === 'user');
    if (lastUser && !input.some(item => item.role === 'user' && /json/i.test(item.content))) lastUser.content = `${lastUser.content}\n\nRespond in JSON.`;
  } else if (responseFormat?.type === 'json_schema') {
    const schema = responseFormat.json_schema || {};
    body.text = { format: { type: 'json_schema', name: schema.name || 'response', schema: schema.schema, ...(schema.strict !== undefined ? { strict: schema.strict } : {}) } };
  }
  const maxOutput = maxCompletionTokens || maxTokens || model.defaultOutputTokens;
  if (maxOutput) body.max_output_tokens = maxOutput;
  return body;
}

// A response becomes one chat completion choice: the output text as the content, the
// function_call items as tool calls, and the usage in the chat names.
function normalizeResponse(response, model) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const content = output.filter(o => o.type === 'message').flatMap(o => (o.content || []).filter(c => c.type === 'output_text').map(c => c.text || '')).join('');
  const toolCalls = output.filter(o => o.type === 'function_call').map(o => ({ id: o.call_id || o.id, type: 'function', function: { name: o.name, arguments: o.arguments || '{}' } }));
  const finishReason = toolCalls.length ? 'tool_calls' : response?.status === 'incomplete' ? 'length' : 'stop';
  const usage = normalizeUsage(response?.usage);
  return {
    id: response?.id,
    object: 'chat.completion',
    created: response?.created_at,
    model: response?.model || model.modelId,
    choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finishReason }],
    usage
  };
}

function normalizeUsage(usage) {
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: usage?.total_tokens || input + output,
    prompt_tokens_details: { cached_tokens: usage?.input_tokens_details?.cached_tokens || 0 },
    completion_tokens_details: { reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens || 0 }
  };
}

module.exports = { OpenAIResponsesAdapter, buildRequest, normalizeResponse, normalizeUsage };
