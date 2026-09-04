'use strict';

// One JSON-mode model call through the gateway, with the caller's token accounting.
const { inference } = require('./gateway');
const { requireBoolean } = require('../config/runtime');

const LOG_LLM_IO = requireBoolean('HPA_LOG_LLM_IO');

async function jsonCall(system, user, onStep, label, stats) {
  if (LOG_LLM_IO && onStep) await onStep({ stage: 'planning_step', label: `LLM Request: ${label}`, message: `SYSTEM:\n${system}\n\nUSER:\n${user}` });
  const res = await inference.chat.completions.create({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    response_format: { type: 'json_object' }
  });
  const content = res.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try { parsed = JSON.parse(content); } catch (_) {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end !== -1) { try { parsed = JSON.parse(content.slice(start, end + 1)); } catch (_) { parsed = {}; } }
  }
  if (LOG_LLM_IO && onStep) await onStep({ stage: 'planning_step', label: `LLM Response: ${label}`, message: `RAW:\n${content}\n\nPARSED:\n${JSON.stringify(parsed)}` });
  const usage = res.usage || {};
  if (stats) {
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
