'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// This is a UTF-8 byte budget for the changing study brief, not a tokenizer estimate.
// System instructions and tool schemas are accounted for separately in each request manifest.
const bytes = text => Buffer.byteLength(text, 'utf8');

class ContextBudgetError extends Error {
  constructor(required, budget) {
    super(`Required study state and unsent exchanges need ${required} context bytes; budget is ${budget}. Shorten retained notes/state or explicitly increase context_budget_bytes.`);
    this.code = 'context_budget_exceeded';
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

// Offset is a JS string offset. Never split a surrogate pair; a returned next_offset is safe
// to pass straight back to recall. Even a single enormous cell can be read without data loss.
function page(text, offset, maxBytes) {
  let lo = offset, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(text.slice(offset, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  if (lo < text.length && lo > offset && /[\uD800-\uDBFF]/.test(text[lo - 1])) lo--;
  return { text: text.slice(offset, lo), end: lo };
}

class StudyContext {
  constructor({ budgetBytes } = {}) {
    this.budgetBytes = budgetBytes === undefined ? null : positiveInteger(budgetBytes, 'context_budget_bytes');
    this.records = new Map();
    this.pending = new Map();
    this.pinned = new Set();
    this.clock = 0;
    this.persisted = 0;
    this.ids = 0;
  }

  add(text, { turn = 0, source = 'result', refs = [], projection = null, kind = 'evidence', announce = true } = {}) {
    const record = Object.freeze({ id: `o${++this.ids}`, turn, source, kind, refs: [...refs], projection: projection ? [...projection].sort() : null, text: String(text) });
    this.records.set(record.id, { record, touched: ++this.clock, delivered: false });
    if (announce) this.pending.set(record.id, 0);
    return record.id;
  }

  recall({ id, query, offset = 0, keep, limit = 12 } = {}) {
    if (!id) {
      if (!query || !String(query).trim()) throw new Error('recall requires id or a nonempty query');
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Search offset must be a nonnegative integer');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new Error('Search limit must be between 1 and 30');
      const matches = [...this.records.values()].filter(({ record: r }) => r.kind === 'evidence' && words.every(w => `${r.source} ${r.refs.join(' ')} ${r.text}`.toLowerCase().includes(w))).reverse();
      const selected = matches.slice(offset, offset + limit);
      const lines = selected.map(({ record: r }) => {
        const lower = r.text.toLowerCase();
        const hit = words.map(w => lower.indexOf(w)).find(at => at >= 0);
        const start = Math.max(0, (hit === undefined ? 0 : hit) - 80);
        return `${r.id} turn ${r.turn} ${r.source} ${r.refs.join(' ')}: ${page(r.text, start, 400).text.replace(/\s+/g, ' ')}`;
      });
      return this.add(`${matches.length} evidence observations match ${JSON.stringify(query)}; results ${offset + 1}–${offset + selected.length}.${offset + selected.length < matches.length ? ` Next search offset=${offset + selected.length}.` : ' End of results.'}\n${lines.join('\n') || '(none)'}`, { source: 'recall search', kind: 'search' });
    }
    const entry = this.records.get(id);
    if (!entry) throw new Error(`No observation ${id}; use recall query to search saved observations`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.record.text.length) throw new Error(`offset must be between 0 and ${entry.record.text.length}`);
    if (offset && /[\uD800-\uDBFF]/.test(entry.record.text[offset - 1])) throw new Error('offset splits a Unicode character; use the returned next_offset');
    if (keep === true) this.pinned.add(id);
    if (keep === false) this.pinned.delete(id);
    this.pending.set(id, offset);
    entry.touched = ++this.clock;
    return id;
  }

  read(id, maxBytes, offset = this.pending.get(id) || 0) {
    const entry = this.records.get(id);
    if (!entry) throw new Error(`No observation ${id}`);
    const r = entry.record;
    const part = page(r.text, offset, maxBytes);
    return { text: `${id} ${r.source} [${part.end < r.text.length ? `offset=${offset}; next_offset=${part.end}; recall id to continue` : offset ? 'last page' : 'complete'}]\n${part.text}`, delivery: { id, offset, end: part.end } };
  }

  // Only the exact pages present in a successful inference request are acknowledged. A job
  // completing during inference remains pending; it cannot be cleared by the next turn.
  acknowledge(snapshot) {
    for (const item of snapshot.deliveries) {
      const entry = this.records.get(item.id);
      if (this.pending.get(item.id) !== item.offset) continue;
      this.pending.delete(item.id);
      entry.delivered = true;
    }
  }

  async flush(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (let n = this.persisted + 1; n <= this.ids; n++) {
      const { record } = this.records.get(`o${n}`);
      await fs.writeFile(path.join(directory, `${record.id}.json`), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      this.persisted = n;
    }
  }

  render({ goal, plan, notes, running, artifacts, turn, maxTurns, notice = '' }) {
    if (this.budgetBytes === null) throw new Error('The archived brief renderer requires an explicit byte budget');
    const active = plan.findIndex(p => !['done', 'dropped'].includes(p.status));
    const planText = plan.length ? plan.map((p, i) => {
      const detail = !['done', 'dropped'].includes(p.status);
      return `${i + 1}. [${p.status}] ${p.text}${detail && p.op ? ` | ${p.op} ${p.inputs || ''} -> ${p.produces || ''}` : ''}${p.note ? ` | ${p.note}` : ''}`;
    }).join('\n') : 'Call set_plan alone: the next few steps, revisable as evidence arrives.';
    const jobs = [...running.values()].map(j => `${j.id} ${j.tool} ${JSON.stringify(j.args)}`).join('\n') || '(none)';
    const sections = [
      ['goal', `GOAL\n${goal}`],
      ['plan', `PLAN\n${planText}\n${active >= 0 ? `Next unfinished item: ${active + 1}; use node=${active + 1} or revise the plan.` : plan.length ? 'All current steps done/dropped: finish or extend the plan.' : ''}`],
      ['notes', `NOTES (your decisions; not independently verified data)\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n') || '(none)'}`],
      ['running', `RUNNING\n${jobs}`],
      ['control', `TURN ${turn}/${maxTurns}${notice ? `\n${notice}` : ''}\nSaved observations: ${this.records.size}; pending observations: ${this.pending.size}. recall id retrieves one; recall query searches all. open reads artifact rows/provenance; datasets discovers source files. Omitted content stays in the workspace.`]
    ];
    const reserve = 320; // Headings and the final accounting footer, measured again below.
    let used = bytes(sections.map(([, text]) => text).join('\n\n')) + reserve;
    if (used > this.budgetBytes) throw new ContextBudgetError(used, this.budgetBytes);
    const deliveries = [], included = [], omittedArtifacts = [];
    const add = (kind, text) => {
      const cost = bytes(text) + 2;
      if (used + cost > this.budgetBytes) return false;
      sections.push([kind, text]); used += cost; return true;
    };
    // Announce every result before allocating space to bodies, so a large discovery page
    // cannot hide the completion of another tool. Unshown bodies remain pending.
    for (const id of this.pending.keys()) {
      const r = this.records.get(id).record;
      if (!add('inbox', `NEW ${r.id}: ${r.source}${r.refs.length ? ` (${r.refs.join(', ')})` : ''}`)) break;
    }

    const consumed = new Set(artifacts.filter(a => a.kind !== 'figure').flatMap(a => a.inputs));
    const frontier = new Set(artifacts.filter(a => !consumed.has(a.id)).map(a => a.id));
    const focusText = plan.filter(p => !['done', 'dropped'].includes(p.status)).map(p => `${p.inputs || ''} ${p.note || ''}`).join(' ');
    const focused = ref => focusText.split(/[\s,;()]+/).includes(ref);
    // A compact registry has no samples, repeated query strings, or arguments. Full provenance
    // lives with the artifact. Newest artifacts are discoverable even in a very long study.
    const index = [];
    const registryBudget = Math.floor((this.budgetBytes - used) / 4);
    let registryBytes = 0;
    for (const a of [...artifacts].reverse()) {
      const line = `${a.id} ${a.kind} ${a.size} | ${a.tool} <- ${a.inputs.join(', ') || 'source'}${frontier.has(a.id) || focused(a.id) ? ` | ${a.columns.slice(0, 7).join(', ')}${a.columns.length > 7 ? ` (${a.columns.length} columns; describe/open for more)` : ''}` : ' (intermediate)'}`;
      if (registryBytes + bytes(line) <= registryBudget) { index.push(line); registryBytes += bytes(line) + 1; }
      else omittedArtifacts.push(a.id);
    }
    add('artifacts', `ARTIFACT INDEX (${artifacts.length} total; ${omittedArtifacts.length} omitted, recover with recall query)\n${index.reverse().join('\n') || '(none shown)'}`);

    const latestBySource = new Map();
    const sourceKey = r => `${r.source}|${JSON.stringify(r.projection)}`;
    for (const entry of this.records.values()) latestBySource.set(sourceKey(entry.record), entry.record.id);
    const eligible = [...this.records.values()].filter(({ record: r }) => {
      if (this.pending.has(r.id) || this.pinned.has(r.id)) return true;
      if (latestBySource.get(sourceKey(r)) !== r.id) return false;
      if (r.refs.some(focused) || frontier.has(r.refs[0])) return true;
      // Keep the last decision and schema/lookup reads. Superseded intermediate artifacts,
      // discovery lists and resolved control feedback stay in the archive, not every prompt.
      return r.source === 'last decision' || (/^(describe|open) /.test(r.source) && !/^a\d+$/.test(r.refs[0] || ''));
    });
    const priority = ({ record: r }) => this.pending.has(r.id) ? 4 : this.pinned.has(r.id) ? 3 : r.refs.some(focused) ? 2 : 1;
    eligible.sort((a, b) => priority(b) - priority(a) || (this.pending.has(a.record.id) && this.pending.has(b.record.id) ? a.touched - b.touched : b.touched - a.touched));
    for (const { record: r } of eligible) {
      const offset = this.pending.get(r.id) || 0;
      const header = `${r.id} turn ${r.turn} ${r.source}${this.pinned.has(r.id) ? ' [kept]' : ''}`;
      const remaining = this.budgetBytes - used - bytes(header) - 140;
      const pendingAfter = eligible.filter(e => this.pending.has(e.record.id) && !included.includes(e.record.id) && e.record.id !== r.id).length;
      const available = this.pending.has(r.id) && pendingAfter ? Math.floor(remaining / 2) : remaining;
      if (available < 256) break;
      // Older observations enter only whole. A large new response gets an explicit page and
      // retrieval cursor, not a stream of unsolicited pages that crowds out subsequent work.
      if (!this.pending.has(r.id) && bytes(r.text) > available) continue;
      const part = page(r.text, offset, available);
      const partial = offset > 0 || part.end < r.text.length;
      const text = `${header}${partial ? ` [offset ${offset}; ${part.end < r.text.length ? `next_offset=${part.end}; recall to continue` : 'last page'}]` : ' [complete observation]'}\n${part.text}`;
      if (!add('observations', text)) continue;
      included.push(r.id);
      if (this.pending.has(r.id)) deliveries.push({ id: r.id, offset, end: part.end });
    }
    const omitted = [...this.records.keys()].filter(id => !included.includes(id));
    const body = sections.map(([, text]) => text).join('\n\n');
    const footer = `\n\nCONTEXT: ${included.length}/${this.records.size} observations included; ${omitted.length} omitted (retrievable); budget ${this.budgetBytes} UTF-8 bytes.`;
    const text = body + footer;
    if (bytes(text) > this.budgetBytes) throw new ContextBudgetError(bytes(text), this.budgetBytes);
    return { text, deliveries, manifest: { budget_bytes: this.budgetBytes, bytes: bytes(text), sections: Object.fromEntries([...new Set(sections.map(([k]) => k))].map(k => [k, sections.filter(([name]) => name === k).reduce((n, [, t]) => n + bytes(t), 0)])), included, deliveries, omitted, omitted_artifacts: omittedArtifacts, pending: [...this.pending.keys()], pinned: [...this.pinned] } };
  }
}

module.exports = { StudyContext, ContextBudgetError, bytes, page };
