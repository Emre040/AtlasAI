'use strict';

const { bytes } = require('./studyContext');
const size = messages => bytes(JSON.stringify(messages));

function planText(plan) {
  return plan.map((p, i) => `${i + 1}. [${p.status}] ${p.text}${p.kind ? ` | ${p.kind}` : ''}${p.inputs ? ` <- ${p.inputs}` : ''}${p.artifacts.length ? ` | evidence ${p.artifacts.join(',')}` : ''}${p.note ? ` | ${p.note}` : ''}`).join('\n') || '(no plan yet)';
}

function runningText(running, plan) {
  return [...running.values()].map(j => {
    const owner = j.planItem ? (plan[j.node - 1] === j.planItem ? `owns plan item ${j.node}` : `started for previous plan item ${j.node}`) : 'no plan item assigned';
    return `${j.id} ${j.tool} (${owner}) ${JSON.stringify(j.args)}`;
  }).join('\n') || '(none)';
}

// The artifact registry is the live result directory. Values and execution recipes
// remain in the artifact store; a card contains only its identity, shape and origin.
function artifactCard(a, { schema = true } = {}) {
  const meta = a.meta || {};
  const sourceFiles = [...new Set([meta.source_file, ...(meta.source_files || []), ...(meta.lookups || []).map(lookup => lookup.table)].filter(Boolean))];
  const card = { id: a.id, label: a.label, kind: a.kind,
    ...(a.rows ? { rows: a.rows.length, ...(schema ? { columns: a.columns } : { column_count: a.columns.length }) } : a.matrix ? { shape: [a.matrix.row_labels.length, a.matrix.col_labels.length] } : {}),
    source: { tool: a.tool, inputs: a.inputs || [], ...(sourceFiles.length ? { files: sourceFiles } : {}) },
    ...(meta.coverage?.length ? { coverage: meta.coverage } : {}),
    ...(meta.lookups?.length ? { lookups: meta.lookups } : {}),
    ...(Number.isInteger(meta.unresolved_inputs) ? { unresolved_inputs: meta.unresolved_inputs } : {}),
    ...(meta.execution?.status ? { status: meta.execution.status } : meta.status ? { status: meta.status } : {}) };
  if (a.kind === 'figure') {
    card.rendered_images = a.images.length;
    if (meta.omitted_rows) card.omitted_rows = meta.omitted_rows;
  }
  if (Array.isArray(meta.record_rows)) card.record_rows = meta.record_rows.filter(Boolean).length;
  return card;
}

function archivedMessage(message, deliveries, pinned) {
  if (message.role !== 'tool') return message;
  const result = JSON.parse(message.content);
  if (result.observations === undefined) return message;
  if (deliveries.some(d => pinned.has(d.id))) return message;
  const { observations, ...receipt } = result;
  return { ...message, content: JSON.stringify({ ...receipt, archived_observations: [...new Set(deliveries.map(d => d.id))] }) };
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
    this.blocks.push({ sent: false, messages: [message, ...results.map(r => r.message)], deliveries: results.flatMap(r => r.deliveries), deliveryRefs: Object.fromEntries(results.map(r => [r.message.tool_call_id, r.deliveries])) });
  }

  prepare(state, maxTurns) {
    const scheduled = new Set(this.blocks.flatMap(b => b.deliveries.map(d => `${d.id}:${d.offset}`)));
    const pending = [...this.archive.pending.keys()].filter(id => !scheduled.has(`${id}:${this.archive.pending.get(id)}`));
    const inbox = this.result(pending);
    // Automatic artifact payloads are not announced. This inbox carries control
    // feedback and explicitly requested observations, never the artifact directory.
    if (inbox.text) this.blocks.push({ sent: false, messages: [{ role: 'user', content: `FEEDBACK\n${inbox.text}` }], deliveries: inbox.deliveries });
    const unfinished = state.plan.map((p, i) => ({ p, n: i + 1 })).filter(({ p }) => !['done', 'dropped'].includes(p.status));
    const work = unfinished.map(({ p, n }) => `${n}. [${p.status}] ${p.text}`).join('\n');
    const artifactIds = (state.artifacts || []).map(artifact => artifact.id);
    // The directory is rebuilt each turn, so schemas must remain here. Archiving
    // row observations must not erase the column names needed to operate on data.
    const artifacts = (state.artifacts || []).map(artifact => artifactCard(artifact));
    const update = { role: 'user', content: `TURN ${state.turn}/${maxTurns}\nREMAINING PLAN (item numbers are labels, not execution dependencies; start independent work together)\n${work || (state.plan.length ? '(all items resolved; finish with the requested saved tables and figures)' : '(record the requested results with set_plan; independent tools may start in the same response)')}\nRUNNING\n${runningText(state.running, state.plan)}\nARTIFACTS (current saved results; schemas and coverage support operations directly; open when a decision needs values)\n${artifacts.map(card => JSON.stringify(card)).join('\n') || '(none)'}${state.notes?.length ? `\nNOTES\n${state.notes.map((note, i) => `${i + 1}. ${note}`).join('\n')}` : ''}` };
    // Keep native call/response pairing and provider signatures. An explicit read
    // is delivered to the next decision once; its full payload stays in the archive.
    const visible = new Set();
    const history = this.blocks.flatMap(block => block.messages.map(message => {
      const refs = message.role === 'tool' ? block.deliveryRefs[message.tool_call_id] : block.deliveries;
      const shown = block.sent ? archivedMessage(message, refs, this.archive.pinned) : message;
      if (shown === message && message.role !== 'assistant') refs.forEach(delivery => visible.add(delivery.id));
      return shown;
    }));
    const current = [this.goal, ...history, update], used = size(current);
    const deliveries = this.blocks.filter(b => !b.sent).flatMap(b => b.deliveries);
    const included = [...visible];
    return { messages: current, deliveries, blocks: [...this.blocks], artifactIds, manifest: { budget_bytes: null, bytes: used, message_count: current.length, compactions: 0, included, omitted: [...this.archive.records.keys()].filter(id => !included.includes(id)), deliveries, pending: [...this.archive.pending.keys()], artifacts: artifactIds, schemas: artifacts.filter(artifact => artifact.columns).map(artifact => artifact.id) } };
  }

  acknowledge(snapshot) {
    snapshot.blocks.forEach(b => { b.sent = true; });
    this.archive.acknowledge(snapshot);
  }
}

module.exports = { StudyConversation, planText, runningText, artifactCard };
