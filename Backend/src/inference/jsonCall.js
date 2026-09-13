'use strict';

// One JSON-mode model call through the gateway, with the caller's token accounting.
const { inference } = require('./gateway');
const { requireBoolean } = require('../config/runtime');

const LOG_LLM_IO = requireBoolean('HPA_LOG_LLM_IO');

async function jsonCall(system, user, onStep, label, stats) {
  if (LOG_LLM_IO && onStep) await onStep({ stage: 'planning_step', label: `LLM Request: ${label}`, message: `SYSTEM:\n${system}\n\nUSER:\n${user}` });
  // A study's reasoning effort reaches every call made on its behalf through the call context.
  const effort = inference.getContext?.()?.reasoningEffort || null;
  const create = text => inference.chat.completions.create({
    messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
    temperature: 0,
    response_format: { type: 'json_object' },
    ...(effort ? { reasoning_effort: effort } : {})
  });
  let res = await create(user);
  let message = res.choices?.[0]?.message;
  const usages = [res.usage || {}];
  // A JSON-mode call offers no function. A reply that comes back as a function call with no text
  // (a model turning the JSON shape it was shown into a call) is asked once more, as text.
  if (!message?.content && Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    if (LOG_LLM_IO && onStep) await onStep({ stage: 'planning_step', label: `LLM Response: ${label}`, message: `FUNCTION CALL INSTEAD OF TEXT:\n${JSON.stringify(message.tool_calls).slice(0, 2000)}` });
    res = await create(`${user}\n\nReply with the JSON object as text; there is no function to call.`);
    message = res.choices?.[0]?.message;
    usages.push(res.usage || {});
  }
  const content = message?.content || '{}';
  let parsed = {};
  try { parsed = JSON.parse(content); } catch (_) {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end !== -1) { try { parsed = JSON.parse(content.slice(start, end + 1)); } catch (_) { parsed = {}; } }
  }
  if (LOG_LLM_IO && onStep) await onStep({ stage: 'planning_step', label: `LLM Response: ${label}`, message: `RAW:\n${content}\n\nPARSED:\n${JSON.stringify(parsed)}` });
  if (stats) for (const usage of usages) {
    const p = usage.prompt_tokens || 0;
    const c = usage.completion_tokens || 0;
    stats.promptTokens += p;
    stats.completionTokens += c;
    stats.totalTokens += p + c;
    stats.perStep[label] = stats.perStep[label] || { prompt: 0, completion: 0, total: 0 };
    stats.perStep[label].prompt += p;
    stats.perStep[label].completion += c;
    stats.perStep[label].total += p + c;
  }
  return parsed && typeof parsed === 'object' ? parsed : {};
}

module.exports = { jsonCall };
