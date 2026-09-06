'use strict';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = value => Array.isArray(value) ? value.map(normalized) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])])) : value;
const fingerprint = value => JSON.stringify(normalized(value));

class AgentStop extends Error {
  constructor(reason, message) { super(message); this.name = 'AgentStop'; this.reason = reason; }
}

// Callers record validator classes and validated/evidence state, never another spelling
// of an invalid value. New evidence or validated requirements permit further repair.
class RepairProgress {
  constructor() { this.seen = new Set(); }
  record(state, message) {
    const key = fingerprint(state);
    if (this.seen.has(key)) throw new AgentStop('no_progress_cycle', message);
    this.seen.add(key);
  }
}

function createAgentControl({ ctx = {}, stats, agentKey }) {
  if (typeof agentKey !== 'string' || !agentKey.trim()) throw new Error('agentKey must identify the agent');
  const budget = ctx.budget;
  if (budget !== undefined) {
    if (!object(budget) || Object.keys(budget).some(key => !['total_tokens', 'deadline_unix_ms'].includes(key))) throw new Error('budget accepts total_tokens and deadline_unix_ms');
    for (const key of Object.keys(budget)) if (!Number.isSafeInteger(budget[key]) || budget[key] < 0) throw new Error(`budget.${key} must be a nonnegative integer`);
  }
  if (ctx.runControl !== undefined && (!object(ctx.runControl) || typeof ctx.runControl.checkpoint !== 'function')) throw new Error('runControl.checkpoint must be a function');
  const checkLocal = beforeInference => {
    if (ctx.signal?.aborted) throw new AgentStop('cancelled', 'The caller cancelled this agent');
    if (budget?.deadline_unix_ms !== undefined && Date.now() >= budget.deadline_unix_ms) throw new AgentStop('deadline_reached', 'The caller deadline was reached');
    if (beforeInference && budget?.total_tokens !== undefined) {
      if (!Number.isSafeInteger(stats?.totalTokens) || stats.totalTokens < 0) throw new Error('stats.totalTokens must be actual nonnegative integer usage');
      if (stats.totalTokens >= budget.total_tokens) throw new AgentStop('token_budget_exhausted', 'The caller token allowance was consumed');
    }
  };
  return { async checkpoint(phase, beforeInference = false) {
    if (typeof phase !== 'string' || !phase || typeof beforeInference !== 'boolean') throw new Error('checkpoint needs a phase and a boolean beforeInference');
    checkLocal(beforeInference);
    // The shared controller uses the gateway ledger. Agent aggregates are not charged
    // again here. Optional direct-call budgets admit whole calls using actual prior usage.
    if (ctx.runControl !== undefined) {
      const decision = await ctx.runControl.checkpoint({ agentKey, phase, beforeInference });
      if (!object(decision) || typeof decision.allowed !== 'boolean') throw new Error('runControl.checkpoint must return an object with allowed: true or allowed: false');
      if (!decision.allowed) throw new AgentStop(decision.reason || 'caller_budget_exhausted', decision.message || 'The shared caller allowance stopped this agent');
      checkLocal(beforeInference);
    }
  } };
}

module.exports = { AgentStop, RepairProgress, createAgentControl, fingerprint };
