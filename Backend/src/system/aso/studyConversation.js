'use strict';

const { bytes } = require('./studyContext');
const size = messages => bytes(JSON.stringify(messages));

function planText(plan) {
  return plan.map((p, i) => `${i + 1}. [${p.status}] ${p.text}${p.kind ? ` | ${p.kind}` : ''}${p.inputs ? ` <- ${p.inputs}` : ''}${p.artifacts.length ? ` | evidence ${p.artifacts.join(',')}` : ''}${p.note ? ` | ${p.note}` : ''}`).join('\n') || '(no plan yet)';
}

function runningText(running) {
  return [...running.values()].map(j => `${j.id} ${j.tool} ${JSON.stringify(j.args)}`).join('\n') || '(none)';
}

class StudyConversation {
  constructor({ goal, archive, resultBytes = 8192 }) {
    this.goal = { role: 'user', content: `GOAL\n${goal}` };
    this.resultBytes = resultBytes;
    this.archive = archive;
    this.blocks = [];
    this.compactions = 0;
  }

  // Budget one result across every observation belonging to that call. Intermediate batch
  // receipts are not attached here; they remain directly retrievable by observation ID.
  result(ids, allowance = this.resultBytes) {
    const parts = [], deliveries = [];
    let remaining = Math.max(0, allowance - 256);
    const unique = [...new Set(ids)];
    const demands = unique.map(id => bytes(this.archive.records.get(id).record.text.slice(this.archive.pending.get(id) || 0)) + 160);
    let demand = demands.reduce((n, value) => n + value, 0);
    for (const [index, id] of unique.entries()) {
      if (remaining < 256) { parts.push(`Further observations: ${unique.slice(index).join(', ')}; recall id to inspect.`); break; }
      const available = Math.min(demands[index], Math.floor(remaining * demands[index] / demand));
      const view = this.archive.read(id, Math.max(64, available - 160));
      demand -= demands[index];
      parts.push(view.text); deliveries.push(view.delivery); remaining -= bytes(view.text) + 2;
    }
    return { text: parts.join('\n\n'), deliveries };
  }

  append(message, results) {
    this.blocks.push({ sent: false, messages: [message, ...results.map(r => r.message)], deliveries: results.flatMap(r => r.deliveries) });
  }

  prepare(state, maxTurns) {
    const scheduled = new Set(this.blocks.flatMap(b => b.deliveries.map(d => `${d.id}:${d.offset}`)));
    const pending = [...this.archive.pending.keys()].filter(id => !scheduled.has(`${id}:${this.archive.pending.get(id)}`));
    const inbox = this.result(pending);
    // Newly arrived source evidence belongs in history. The changing control frame below
    // does not: keeping every previous plan/running snapshot would duplicate bookkeeping.
    if (inbox.text) this.blocks.push({ sent: false, messages: [{ role: 'user', content: `NEW RESULTS\n${inbox.text}` }], deliveries: inbox.deliveries });
    const unfinished = state.plan.map((p, i) => ({ p, n: i + 1 })).filter(({ p }) => !['done', 'dropped'].includes(p.status));
    const work = unfinished.map(({ p, n }) => `${n}. [${p.status}] ${p.text}`).join('\n');
    const update = { role: 'user', content: `TURN ${state.turn}/${maxTurns}\nREMAINING PLAN (item numbers are labels, not execution dependencies; start independent work together)\n${work || (state.plan.length ? '(all items resolved; finish when results have been inspected)' : '(record the requested results with set_plan; independent tools may start in the same response)')}\nRUNNING\n${runningText(state.running)}` };
    // Bound individual deliveries, not working memory. Preserve every native exchange,
    // including corrections and provider signatures, in its original order.
    const current = [this.goal, ...this.blocks.flatMap(b => b.messages), update], used = size(current);
    const deliveries = this.blocks.filter(b => !b.sent).flatMap(b => b.deliveries);
    const included = [...new Set(this.blocks.flatMap(b => b.deliveries.map(d => d.id)))];
    return { messages: current, deliveries, blocks: [...this.blocks], manifest: { budget_bytes: null, bytes: used, message_count: current.length, compactions: 0, included, omitted: [...this.archive.records.keys()].filter(id => !included.includes(id)), deliveries, pending: [...this.archive.pending.keys()] } };
  }

  acknowledge(snapshot) {
    snapshot.blocks.forEach(b => { b.sent = true; });
    this.archive.acknowledge(snapshot);
  }
}

module.exports = { StudyConversation, planText, runningText };
