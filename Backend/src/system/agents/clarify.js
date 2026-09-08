'use strict';

// Asks the user what an ambiguous request means. The router calls this instead of a data agent
// when the request could be read in ways that change what would be done (which tissue or cell
// type, RNA or protein, enriched or enhanced or detected, which cancer cohort, list or count or
// figure). It writes up to three multiple-choice questions, each with three short options; the
// chat shows them as cards with a fourth free-text option, and the answers come back as the next
// user message, which the router then reads together with the original request.
const { jsonCall } = require('../../inference/jsonCall');

const MAX_QUESTIONS = 3;
const OPTIONS_PER_QUESTION = 3;

const SYSTEM = `You write clarification questions for a request made to AtlasAI, an assistant over the Human Protein Atlas (gene lists, expression per tissue and cell type at RNA and protein level, specificity categories such as tissue enriched, group enriched, tissue enhanced, low tissue specificity and not detected, cancer prognostics per TCGA cohort, subcellular locations, blood concentrations, studies with figures).
Ask only what changes the work. Typical open points: which tissue or cell type; RNA or protein; which specificity category; which cancer cohort; a list, a count or a figure; which threshold. Never ask what the request already states, never ask for information you could look up, and never ask more than needed: one question when one thing is unclear.
Each question has exactly ${OPTIONS_PER_QUESTION} short options in the atlas's own terms that cover the likely readings; the user can also type an answer, so the options need not be exhaustive.
Answer with JSON only: {"reason": "<one sentence, what is unclear>", "questions": [{"question": "<the question>", "options": ["<option>", "<option>", "<option>"]}]} with at most ${MAX_QUESTIONS} questions.`;

function cleanOptions(options) {
  const seen = new Set();
  const out = [];
  for (const option of Array.isArray(options) ? options : []) {
    const text = String(option ?? '').trim().slice(0, 120);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length === OPTIONS_PER_QUESTION) break;
  }
  return out;
}

async function clarify({ query, ambiguity, context }, { onStep } = {}) {
  const request = String(query || '').trim();
  if (!request) throw new Error('clarify needs the request text');
  await onStep?.({ stage: 'start', message: `Clarifying: "${request.slice(0, 120)}"` });
  const user = [
    `Request: ${request}`,
    ambiguity ? `What the router found unclear: ${String(ambiguity).trim()}` : '',
    context ? `Earlier in the conversation:\n${String(context).trim().slice(0, 4000)}` : ''
  ].filter(Boolean).join('\n\n');
  const parsed = await jsonCall(SYSTEM, user, onStep, 'clarify');
  const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .map((q, i) => ({ id: `q${i + 1}`, question: String(q?.question ?? '').trim().slice(0, 300), options: cleanOptions(q?.options) }))
    .filter(q => q.question && q.options.length === OPTIONS_PER_QUESTION)
    .slice(0, MAX_QUESTIONS);
  if (!questions.length) throw new Error('no clarification question could be written for this request');
  const reason = String(parsed.reason ?? ambiguity ?? '').trim().slice(0, 300) || null;
  await onStep?.({ stage: 'complete', label: 'Done', message: `${questions.length} question${questions.length === 1 ? '' : 's'} for the user` });
  return {
    status: 'ok',
    mode: 'clarify',
    query: request,
    reason,
    questions,
    summary_md: [reason ? `What is unclear: ${reason}` : null, ...questions.map((q, i) => `Q${i + 1}: ${q.question} (${q.options.join(' / ')})`)].filter(Boolean).join('\n')
  };
}

// The text the chat sends back as the user's next message once the cards are answered; the
// router recognises its first line.
const ANSWERED_PREFIX = 'The user just answered a questionnaire';

module.exports = clarify;
module.exports.ANSWERED_PREFIX = ANSWERED_PREFIX;
