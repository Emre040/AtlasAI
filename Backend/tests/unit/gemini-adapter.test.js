'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiGenerateContentAdapter, buildRequest, convertSchema, normalizeResponse, normalizeStream, normalizeUsage } = require('../../src/inference/adapters/geminiGenerateContent');

const model = Object.freeze({ configKey: 'gemini-3.8-flash', modelId: 'gemini-3.8-flash', defaultOutputTokens: 4096, reasoningEffort: 'low' });

test('schemas become the Gemini dialect: upper-case types, no additionalProperties, free objects as text', () => {
  const schema = convertSchema({ type: 'object', properties: { a: { type: 'string', description: 'id' }, n: { type: 'integer' }, where: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['=', '>'] }, value: {} } } }, rename: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['a', 'missing'], additionalProperties: false });
  assert.equal(schema.type, 'OBJECT');
  assert.deepEqual(schema.required, ['a']);
  assert.equal(schema.properties.n.type, 'INTEGER');
  assert.equal(schema.properties.where.items.properties.op.enum[1], '>');
  assert.equal(schema.properties.where.items.properties.value.type, 'STRING');
  assert.equal(schema.properties.rename.type, 'STRING');
  assert.equal(JSON.stringify(schema).includes('additionalProperties'), false);
});

test('messages map to contents with a system instruction, tool calls and tool results', () => {
  const built = buildRequest({
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'measure', arguments: '{"artifact":"a1"}' }, thought_signature: 'sig' }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"rows":8}' }
    ],
    tools: [{ type: 'function', function: { name: 'measure', description: 'm', parameters: { type: 'object', properties: { artifact: { type: 'string' } }, required: ['artifact'] } } }],
    temperature: 0,
    response_format: { type: 'json_object' }
  }, model);
  assert.equal(built.system, 'rules');
  assert.deepEqual(built.contents.map(c => c.role), ['user', 'model', 'user']);
  assert.deepEqual(built.contents[1].parts[0], { functionCall: { name: 'measure', args: { artifact: 'a1' } }, thoughtSignature: 'sig' });
  assert.deepEqual(built.contents[2].parts[0], { functionResponse: { name: 'measure', response: { result: { rows: 8 } } } });
  assert.equal(built.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
  assert.equal(built.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(built.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

test('a replayed tool call without a signature skips the validator', () => {
  const built = buildRequest({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }] }, model);
  assert.equal(built.contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.deepEqual(built.contents[2].parts[0].functionResponse.response, { result: 'ok' });
});

test('responses normalize to the OpenAI shape with cached and reasoning tokens', () => {
  const response = normalizeResponse({
    responseId: 'r1', modelVersion: 'gemini-3.8-flash',
    candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'hello ' }, { functionCall: { name: 'finish', args: { summary: 's' } }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 6036, cachedContentTokenCount: 6025, candidatesTokenCount: 10, thoughtsTokenCount: 5 }
  }, 'gemini-3.8-flash');
  const message = response.choices[0].message;
  assert.equal(message.content, 'hello ');
  assert.equal(message.tool_calls[0].function.name, 'finish');
  assert.equal(message.tool_calls[0].function.arguments, '{"summary":"s"}');
  assert.equal(message.tool_calls[0].thought_signature, 'sig');
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(response.usage, { prompt_tokens: 6036, completion_tokens: 15, total_tokens: 6051, prompt_tokens_details: { cached_tokens: 6025 }, completion_tokens_details: { reasoning_tokens: 5 } });
});

test('usage without a cache has no cached_tokens', () => {
  assert.deepEqual(normalizeUsage({ promptTokenCount: 10, candidatesTokenCount: 2 }), { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
});

test('server-sent events with CRLF separators stream as chunks that end with usage', async () => {
  const events = [
    'data: {"candidates":[{"content":{"parts":[{"text":"one, "}],"role":"model"},"index":0}],"responseId":"r9"}\r\n\r\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"two"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":14,"candidatesTokenCount":4,"totalTokenCount":18}}\r\n\r\n'
  ];
  const body = (async function* () { for (const e of events) yield Buffer.from(e); })();
  const chunks = [];
  for await (const chunk of normalizeStream({ body }, 'gemini-3.8-flash')) chunks.push(chunk);
  assert.equal(chunks.map(c => c.choices[0].delta.content || '').join(''), 'one, two');
  assert.equal(chunks[0].id, 'r9');
  const last = chunks[chunks.length - 1];
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.deepEqual(last.usage, { prompt_tokens: 14, completion_tokens: 4, total_tokens: 18 });
});

test('the adapter creates a cache once for a repeated prefix and sends only contents afterwards', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/cachedContents')) return { ok: true, json: async () => ({ name: 'cachedContents/abc', expireTime: new Date(Date.now() + 3600_000).toISOString() }) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6000, cachedContentTokenCount: 5990, candidatesTokenCount: 1 } }) };
  };
  const adapter = new GeminiGenerateContentAdapter({ apiKey: 'k', fetchImpl });
  const big = 'x'.repeat(7000);
  const request = { messages: [{ role: 'system', content: big }, { role: 'user', content: 'turn' }], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }], prompt_cache: { key: 'study 1' } };
  await adapter.create(request, model);
  await adapter.create(request, model);
  assert.equal(calls.filter(c => c.url.endsWith('/cachedContents')).length, 1);
  const generate = calls.filter(c => c.url.includes(':generateContent'));
  assert.equal(generate.length, 2);
  assert.equal(generate[0].body.cachedContent, 'cachedContents/abc');
  assert.equal(generate[0].body.systemInstruction, undefined);
  assert.equal(generate[0].body.tools, undefined);
  assert.equal(calls[0].body.ttl, '3600s');
});

test('without the cache hint the prefix travels inline', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: {} }) }; };
  const adapter = new GeminiGenerateContentAdapter({ apiKey: 'k', fetchImpl });
  await adapter.create({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }] }, model);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.systemInstruction.parts[0].text, 'rules');
});
