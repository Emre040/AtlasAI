// HPA benchmark runner. See ../README.md for the recorded protocol and execution commands.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : []).filter(Boolean));
if (!args.model) throw new Error('--model is required');
const model = args.model;
const wanted = (args.questions || 'all').split(',');
// Adaptive thinking at the given effort; none when no effort is given.
const effort = args.effort || null;
const thinkingBudget = effort ? 1 : 0;
const maxCalls = Number(args['max-calls'] || 30);
const maxTurns = Number(args['max-turns'] || 30);
const resultChars = Number(args['result-chars'] || 20000);
const prices = JSON.parse(fs.readFileSync(path.join(here, 'prices.json'), 'utf8'));

// The provider key comes from the backend's environment file; it is never printed.
const envText = fs.readFileSync(process.env.HPA_BENCH_ENV_FILE, 'utf8');
const envValue = name => { const m = envText.match(new RegExp(`^${name}=(.*)$`, 'm')); if (!m) throw new Error(`${name} not in the backend environment`); return m[1].trim().replace(/^"|"$/g, ''); };
const provider = args.provider || (model.startsWith('claude') ? 'anthropic' : 'openai');
const anthropic = provider === 'anthropic' ? new Anthropic({ apiKey: envValue('ANTHROPIC_API_KEY') }) : null;
// --base-url points the OpenAI client at any OpenAI-compatible server (a local vLLM, for one); the key is then a placeholder.
// With --base-url the key is the named backend environment variable (--api-key-env) or a placeholder.
const openai = provider === 'openai' ? new OpenAI({ apiKey: args['base-url'] ? (args['api-key-env'] ? envValue(args['api-key-env']) : (args['api-key'] || 'local')) : envValue('OPENAI_API_KEY'), baseURL: args['base-url'] || undefined, timeout: 20 * 60 * 1000, maxRetries: 8 }) : null;   // hosts with a few requests per minute answer 429 with retry-after; the client waits it out
const maxOutput = Number(args['max-output'] || 32000);
// --call-gap-ms: a pause before every model call, for hosts with a low requests-per-minute limit (the Gemini API's Gemma models).
const callGapMs = Number(args['call-gap-ms'] || 0);
const pace = () => callGapMs ? new Promise(r => setTimeout(r, callGapMs)) : Promise.resolve();

const serverKind = args.server || 'mcp';
if (!['mcp', 'sql', 'web'].includes(serverKind)) throw new Error('--server must be mcp, sql or web');
const HPA_SYSTEM = "You answer questions about human genes and proteins using the Human Protein Atlas through the tools provided. Use the tools to obtain the data; base every number and every gene list on tool results. State the final answer clearly, with the exact values. If something cannot be determined with the tools available, say so rather than estimating.";
// The web arm: the same loop with a search and a page opener instead of the atlas tools.
const WEB_SYSTEM = "You answer questions about the Human Protein Atlas using the tools provided: a web search and a page opener. Base every statement on a page you opened and give the URL of the page each statement rests on. If the pages you reach do not answer a part of the question, say so plainly. State the final answer plainly.";
const SYSTEM = serverKind === 'web' ? WEB_SYSTEM : HPA_SYSTEM;
const serverPath = serverKind === 'sql'
  ? path.join(here, '..', 'servers', 'sql', 'index.mjs')
  : serverKind === 'web' ? path.join(here, '..', 'servers', 'web', 'index.mjs')
  : path.join(here, '..', 'servers', 'mcp', 'build', 'index.js');
const remotePath = serverKind === 'sql' ? '~/hpa-sql-mcp/index.mjs' : '~/ProteinAtlas-MCP-Server/build/index.js';
async function connectMcp() {
  // --server-host <ssh host>: the MCP server runs on that machine over ssh stdio (its outbound IP makes
  // the proteinatlas.org calls); the server code must be under the home directory there, node in ~/node/bin.
  const transport = args['server-host']
    ? new StdioClientTransport({ command: 'ssh', args: ['-o', 'BatchMode=yes', args['server-host'], '~/node/bin/node', remotePath], stderr: 'pipe' })
    : new StdioClientTransport({ command: 'node', args: [serverPath], stderr: 'pipe', env: { HPA_DATA_DIR: process.env.HPA_DATA_DIR } });
  const client = new Client({ name: 'atlasai-baseline', version: '0.1.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools };
}

// The server process died mid-run once (on buildbox) and every later call in that process failed with
// "Not connected"; now the connection is rebuilt once and the call repeated.
async function callTool(mcp, name, argumentsObject) {
  try { return await mcp.client.callTool({ name, arguments: argumentsObject }); }
  catch (error) {
    if (!/not connected/i.test(String(error?.message || ''))) throw error;
    console.error('MCP server connection lost; reconnecting');
    const fresh = await connectMcp(); mcp.client = fresh.client; mcp.tools = fresh.tools;
    return mcp.client.callTool({ name, arguments: argumentsObject });
  }
}

const text = content => (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

function cost(usage) {
  const p = prices[model];
  if (!p) return null;
  const uncached = (usage.input_tokens || 0);
  const cached = (usage.cache_read_input_tokens || 0);
  const written = (usage.cache_creation_input_tokens || 0);
  return (uncached * p.input + cached * p.cached_input + written * p.input + (usage.output_tokens || 0) * p.output) / 1e6 / 1e6;
}

// The same loop over the OpenAI Responses API (reasoning models take function tools there):
// function calls come back as output items and their results go back as function_call_output
// items on the next request, chained by previous_response_id.
async function runQuestionOpenAI(q, mcp, outDir) {
  const tools = mcp.tools.map(t => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.inputSchema, strict: false }));
  const trace = { id: q.id, kind: q.task_type, question: q.text, model, effort, turns: [], tool_calls: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 }, started_unix_ms: Date.now() };
  let final = null, calls = 0, stop = null, previous = null;
  let input = [{ role: 'user', content: q.text }];
  const account = u => { trace.usage.input_tokens += u.input_tokens || 0; trace.usage.output_tokens += u.output_tokens || 0; trace.usage.cache_read_input_tokens += u.input_tokens_details?.cached_tokens || 0; trace.usage.reasoning_tokens += u.output_tokens_details?.reasoning_tokens || 0; };
  for (let turn = 1; turn <= maxTurns; turn++) {
    const request = { model, instructions: SYSTEM, tools, input, max_output_tokens: maxOutput, store: true };
    if (effort) request.reasoning = { effort };
    if (previous) request.previous_response_id = previous;
    const t0 = Date.now();
    const res = await openai.responses.create(request);
    previous = res.id;
    account(res.usage || {});
    const uses = (res.output || []).filter(o => o.type === 'function_call');
    const said = res.output_text || '';
    trace.turns.push({ turn, ms: Date.now() - t0, stop_reason: res.status, usage: res.usage, text: said.slice(0, 4000), tool_uses: uses.map(c => ({ name: c.name, input: c.arguments })) });
    if (!uses.length) { final = said; stop = res.status; break; }
    input = [];
    for (const c of uses) {
      calls++;
      const c0 = Date.now();
      let parsed = {}, body, error = null;
      try { parsed = JSON.parse(c.arguments || '{}'); } catch (e) { error = `arguments: ${e.message}`; }
      if (!error) {
        try {
          const r = await callTool(mcp, c.name, parsed);
          body = (r.content || []).map(b => b.type === 'text' ? b.text : JSON.stringify(b)).join('\n');
          if (r.isError) error = 'tool reported an error';
        } catch (e) { body = `Tool error: ${e.message}`; error = e.message; }
      } else body = `Tool error: ${error}`;
      const full = body.length;
      const shown = body.length > resultChars ? `${body.slice(0, resultChars)}\n[truncated: ${resultChars} of ${full} characters shown]` : body;
      trace.tool_calls.push({ turn, name: c.name, input: parsed, ms: Date.now() - c0, result_chars: full, truncated: full > resultChars, error, result_head: body.slice(0, 600) });
      fs.writeFileSync(path.join(outDir, `${q.id}.tool${String(calls).padStart(2, '0')}.${c.name}.txt`), body);
      input.push({ type: 'function_call_output', call_id: c.call_id, output: shown });
    }
    if (calls >= maxCalls) { stop = 'max_calls'; input.push({ role: 'user', content: 'You have used the tool-call budget. Give your final answer now from what you have.' }); }
  }
  if (final === null && stop === 'max_calls') {
    const res = await openai.responses.create({ model, instructions: SYSTEM, input, previous_response_id: previous, max_output_tokens: 8000 });
    account(res.usage || {});
    final = res.output_text || '';
  }
  trace.final_answer = final; trace.stop = stop; trace.tool_call_count = calls;
  trace.seconds = (Date.now() - trace.started_unix_ms) / 1000;
  trace.model_calls = trace.turns.length + (stop === 'max_calls' ? 1 : 0);
  trace.cost_usd = cost(trace.usage);
  fs.writeFileSync(path.join(outDir, `${q.id}.json`), JSON.stringify(trace, null, 1));
  fs.writeFileSync(path.join(outDir, `${q.id}.answer.md`), `# ${q.id} (${q.task_type})\n\n**Q:** ${q.text}\n\n**${model}${effort ? `, reasoning effort ${effort}` : ''}:**\n\n${final}\n\n---\nmodel calls ${trace.model_calls}, tool calls ${calls}, tokens in ${trace.usage.input_tokens} (cached ${trace.usage.cache_read_input_tokens}) out ${trace.usage.output_tokens} (reasoning ${trace.usage.reasoning_tokens}), ${trace.seconds.toFixed(1)} s, cost ${trace.cost_usd === null ? 'n/a' : `$${trace.cost_usd.toFixed(4)}`}, stop ${stop}\n`);
  return trace;
}

// The same loop over the Chat Completions API (--api chat), for OpenAI-compatible servers such as
// vLLM that keep no response state between requests: the whole conversation is sent each turn.
async function runQuestionChat(q, mcp, outDir) {
  const tools = mcp.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema } }));
  const trace = { id: q.id, kind: q.task_type, question: q.text, model, effort, turns: [], tool_calls: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 }, started_unix_ms: Date.now() };
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: q.text }];
  let final = null, calls = 0, stop = null;
  const account = u => { trace.usage.input_tokens += u.prompt_tokens || 0; trace.usage.output_tokens += u.completion_tokens || 0; trace.usage.cache_read_input_tokens += u.prompt_tokens_details?.cached_tokens || 0; trace.usage.reasoning_tokens += u.completion_tokens_details?.reasoning_tokens || 0; };
  for (let turn = 1; turn <= maxTurns; turn++) {
    await pace();
    const t0 = Date.now();
    // --effort on the Chat Completions API is the standard reasoning_effort field (DeepSeek honours low/high/max).
    const res = await openai.chat.completions.create({ model, messages, tools, max_tokens: maxOutput, ...(effort ? { reasoning_effort: effort } : {}) });
    account(res.usage || {});
    const choice = res.choices[0];
    const msg = choice.message;
    const uses = msg.tool_calls || [];
    const said = msg.content || '';
    trace.turns.push({ turn, ms: Date.now() - t0, stop_reason: choice.finish_reason, usage: res.usage, text: said.slice(0, 4000), tool_uses: uses.map(c => ({ name: c.function.name, input: c.function.arguments })) });
    // Gemini's OpenAI layer attaches a thought signature to each tool call and rejects the next
    // request without it, so a call that carries extra content goes back as it came.
    messages.push({ role: 'assistant', content: msg.content ?? null, ...(uses.length ? { tool_calls: uses.map(c => c.extra_content ? c : { id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } }) } : {}) });
    if (!uses.length) { final = said; stop = choice.finish_reason; break; }
    for (const c of uses) {
      calls++;
      const c0 = Date.now();
      let parsed = {}, body, error = null;
      try { parsed = JSON.parse(c.function.arguments || '{}'); } catch (e) { error = `arguments: ${e.message}`; }
      if (!error) {
        try {
          const r = await callTool(mcp, c.function.name, parsed);
          body = (r.content || []).map(b => b.type === 'text' ? b.text : JSON.stringify(b)).join('\n');
          if (r.isError) error = 'tool reported an error';
        } catch (e) { body = `Tool error: ${e.message}`; error = e.message; }
      } else body = `Tool error: ${error}`;
      const full = body.length;
      const shown = body.length > resultChars ? `${body.slice(0, resultChars)}\n[truncated: ${resultChars} of ${full} characters shown]` : body;
      trace.tool_calls.push({ turn, name: c.function.name, input: parsed, ms: Date.now() - c0, result_chars: full, truncated: full > resultChars, error, result_head: body.slice(0, 600) });
      fs.writeFileSync(path.join(outDir, `${q.id}.tool${String(calls).padStart(2, '0')}.${c.function.name}.txt`), body);
      messages.push({ role: 'tool', tool_call_id: c.id, content: shown });
    }
    if (calls >= maxCalls) { stop = 'max_calls'; messages.push({ role: 'user', content: 'You have used the tool-call budget. Give your final answer now from what you have.' }); }
  }
  if (final === null && stop === 'max_calls') {
    await pace();
    const res = await openai.chat.completions.create({ model, messages, max_tokens: maxOutput });
    account(res.usage || {});
    final = res.choices[0].message.content || '';
  }
  trace.final_answer = final; trace.stop = stop; trace.tool_call_count = calls;
  trace.seconds = (Date.now() - trace.started_unix_ms) / 1000;
  trace.model_calls = trace.turns.length + (stop === 'max_calls' ? 1 : 0);
  trace.cost_usd = cost(trace.usage);
  fs.writeFileSync(path.join(outDir, `${q.id}.json`), JSON.stringify(trace, null, 1));
  fs.writeFileSync(path.join(outDir, `${q.id}.answer.md`), `# ${q.id} (${q.task_type})\n\n**Q:** ${q.text}\n\n**${model}:**\n\n${final}\n\n---\nmodel calls ${trace.model_calls}, tool calls ${calls}, tokens in ${trace.usage.input_tokens} (cached ${trace.usage.cache_read_input_tokens}) out ${trace.usage.output_tokens} (reasoning ${trace.usage.reasoning_tokens}), ${trace.seconds.toFixed(1)} s, cost ${trace.cost_usd === null ? 'n/a' : `$${trace.cost_usd.toFixed(4)}`}, stop ${stop}\n`);
  return trace;
}

async function runQuestion(q, mcp, outDir) {
  if (provider === 'openai') return (args.api === 'chat' ? runQuestionChat : runQuestionOpenAI)(q, mcp, outDir);
  const tools = mcp.tools.map(t => ({ name: t.name, description: t.description || '', input_schema: t.inputSchema }));
  const messages = [{ role: 'user', content: q.text }];
  const trace = { id: q.id, kind: q.task_type, question: q.text, model, effort, turns: [], tool_calls: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, started_unix_ms: Date.now() };
  let final = null, calls = 0, stop = null;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const request = { model, max_tokens: effort ? 32000 : 8000, system: SYSTEM, tools, messages };
    if (effort) { request.thinking = { type: 'adaptive' }; request.output_config = { effort }; }
    const t0 = Date.now();
    // Long requests must stream; the final message is assembled from the stream.
    const res = await anthropic.messages.stream(request).finalMessage();
    for (const k of Object.keys(trace.usage)) trace.usage[k] += res.usage?.[k] || 0;
    const uses = res.content.filter(b => b.type === 'tool_use');
    trace.turns.push({ turn, ms: Date.now() - t0, stop_reason: res.stop_reason, usage: res.usage, text: text(res.content).slice(0, 4000), tool_uses: uses.map(u => ({ name: u.name, input: u.input })) });
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use' || !uses.length) { final = text(res.content); stop = res.stop_reason; break; }
    const results = [];
    for (const u of uses) {
      calls++;
      const c0 = Date.now();
      let body, error = null;
      try {
        const r = await callTool(mcp, u.name, u.input);
        body = (r.content || []).map(b => b.type === 'text' ? b.text : JSON.stringify(b)).join('\n');
        if (r.isError) error = 'tool reported an error';
      } catch (e) { body = `Tool error: ${e.message}`; error = e.message; }
      const full = body.length;
      const shown = body.length > resultChars ? `${body.slice(0, resultChars)}\n[truncated: ${resultChars} of ${full} characters shown]` : body;
      trace.tool_calls.push({ turn, name: u.name, input: u.input, ms: Date.now() - c0, result_chars: full, truncated: full > resultChars, error, result_head: body.slice(0, 600) });
      fs.writeFileSync(path.join(outDir, `${q.id}.tool${String(calls).padStart(2, '0')}.${u.name}.txt`), body);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: shown, ...(error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
    if (calls >= maxCalls) { stop = 'max_calls'; messages.push({ role: 'user', content: 'You have used the tool-call budget. Give your final answer now from what you have.' }); }
  }
  if (final === null && stop === 'max_calls') {
    const res = await anthropic.messages.stream({ model, max_tokens: 8000, system: SYSTEM, messages }).finalMessage();
    for (const k of Object.keys(trace.usage)) trace.usage[k] += res.usage?.[k] || 0;
    final = text(res.content);
  }
  trace.final_answer = final;
  trace.stop = stop;
  trace.tool_call_count = calls;
  trace.seconds = (Date.now() - trace.started_unix_ms) / 1000;
  trace.model_calls = trace.turns.length + (stop === 'max_calls' ? 1 : 0);
  trace.cost_usd = cost(trace.usage);
  fs.writeFileSync(path.join(outDir, `${q.id}.json`), JSON.stringify(trace, null, 1));
  fs.writeFileSync(path.join(outDir, `${q.id}.answer.md`), `# ${q.id} (${q.task_type})\n\n**Q:** ${q.text}\n\n**${model}${effort ? `, adaptive thinking, effort ${effort}` : ''}:**\n\n${final}\n\n---\nmodel calls ${trace.model_calls}, tool calls ${calls}, tokens in ${trace.usage.input_tokens} (cache read ${trace.usage.cache_read_input_tokens}) out ${trace.usage.output_tokens}, ${trace.seconds.toFixed(1)} s, cost ${trace.cost_usd === null ? 'n/a' : `$${trace.cost_usd.toFixed(4)}`}, stop ${stop}\n`);
  return trace;
}

// Read the canonical question catalog; send only q.text to the model.
const questions = JSON.parse(fs.readFileSync(args['questions-file'] ? path.resolve(args['questions-file']) : path.join(here, '..', '..', 'questions', 'questions.json'), 'utf8')).filter(q => wanted.includes('all') || wanted.includes(q.id));
if (!args.out) throw new Error('--out is required; choose a new output directory');
const outDir = path.resolve(args.out);
fs.mkdirSync(outDir, { recursive: true });
const mcp = await connectMcp();
console.log(`MCP tools: ${mcp.tools.map(t => t.name).join(', ')}`);
for (const q of questions) {
  process.stdout.write(`${q.id} ${model}… `);
  try {
    const t = await runQuestion(q, mcp, outDir);
    console.log(`done: ${t.model_calls} model calls, ${t.tool_call_count} tool calls, ${t.usage.input_tokens + t.usage.output_tokens + t.usage.cache_read_input_tokens} tokens, ${t.seconds.toFixed(0)} s, ${t.cost_usd === null ? 'cost n/a' : `$${t.cost_usd.toFixed(3)}`}, stop ${t.stop}`);
  } catch (e) { console.log(`FAILED: ${e.message}`); }
}
await mcp.client.close();
