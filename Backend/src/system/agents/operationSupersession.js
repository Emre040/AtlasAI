'use strict';

const SUPERSESSION_SCHEMA = { type: 'array', description: 'Explicitly replace failed internal operation outputs with complete saved results returned in this finish. This does not discharge assigned or unavailable source requirements. Omit to retain pending failures.', items: { type: 'object', properties: {
  output: { type: 'string', description: 'Exact pending operation output name from unfinished_requirements.' },
  replacements: { type: 'array', items: { type: 'string' }, description: 'Complete saved result names also included in finish.results. No unresolved dependencies.' },
  reason: { type: 'string', description: 'Why the alternative saved computation replaces this internal attempt. This explanation is recorded, not treated as verified scientific evidence.' }
}, required: ['output', 'replacements', 'reason'], additionalProperties: false } };

class OperationLedger {
  #pending = new Map();
  #failures = new Map();
  constructor({ fulfilled = () => false } = {}) { this.fulfilled = fulfilled; }
  set(output, issue, failure) {
    if (!failure || typeof failure.tool !== 'string' || !failure.arguments) throw new Error('An operation failure requires its exact tool and arguments');
    this.#pending.set(output, { ...issue, output });
    const attempts = this.#failures.get(output) || [];
    attempts.push(structuredClone({ ...failure, output })); this.#failures.set(output, attempts);
  }
  delete(output) { return this.#pending.delete(output); }
  *[Symbol.iterator]() { for (const [output, issue] of this.#pending) if (!this.fulfilled(output)) yield [output, issue]; }
  *values() { for (const [, issue] of this) yield issue; }
  snapshot() { return [...this].map(([output, issue]) => structuredClone({ output, issue, failures: this.#failures.get(output) })); }
}

function prepareSupersession(entries = [], { results, selected, ledgers }) {
  if (!Array.isArray(entries)) throw new Error('finish.superseded_operations must be an array');
  const snapshots = ledgers.map(ledger => ({ ledger, records: ledger.snapshot() }));
  const pending = new Map();
  for (const { records } of snapshots) for (const record of records) pending.set(record.output, [...(pending.get(record.output) || []), record]);
  const chosen = new Set(selected), superseded = new Set(), dispositions = [], verified = new Set();
  const complete = (name, ancestors = new Set()) => {
    if (pending.has(name)) throw new Error(`Supersession replacement depends on unresolved output ${name}`);
    if (ancestors.has(name)) throw new Error(`Supersession replacement has cyclic dependency ${name}`);
    if (verified.has(name)) return;
    const table = results.get(name);
    if (!table || !Array.isArray(table.rows) || !Array.isArray(table.columns)) throw new Error(`Supersession replacement ${name} must be a complete saved table`);
    if (table.status === 'partial' || table.execution?.status === 'partial') throw new Error(`Supersession replacement ${name} has partial execution`);
    if (table.remaining_for_aso?.length || table.not_in_release?.length) throw new Error(`Supersession replacement ${name} has unresolved requirements`);
    const parents = new Set([
      ...(table.operations || []).flatMap(operation => Object.values(operation.inputs || {})),
      ...(table.reductions || []).flatMap(reduction => [reduction.from, reduction.source_result])
    ]);
    ancestors.add(name);
    try { for (const parent of parents) complete(parent, ancestors); }
    finally { ancestors.delete(name); }
    verified.add(name);
  };
  for (const entry of entries) {
    if (!entry || Object.keys(entry).some(key => !['output', 'replacements', 'reason'].includes(key)) || typeof entry.output !== 'string' || !pending.has(entry.output)) throw new Error(`Supersession must name an exact pending operation output: ${entry?.output}`);
    if (superseded.has(entry.output)) throw new Error(`Repeated superseded output ${entry.output}`);
    if (!Array.isArray(entry.replacements) || !entry.replacements.length || entry.replacements.some(name => typeof name !== 'string') || new Set(entry.replacements).size !== entry.replacements.length) throw new Error('Supersession replacements must be a nonempty list of distinct saved result names');
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error('Supersession requires an explicit reason');
    for (const name of entry.replacements) {
      if (!chosen.has(name)) throw new Error(`Supersession replacement ${name} must be included in finish.results`);
      complete(name);
    }
    superseded.add(entry.output);
    dispositions.push({ status: 'superseded', output: entry.output, replacements: [...entry.replacements], reason: entry.reason,
      failures: pending.get(entry.output).flatMap(record => record.failures), previous_requirements: pending.get(entry.output).map(record => record.issue) });
  }
  const unfinished = snapshots.flatMap(({ records }) => records.filter(record => !superseded.has(record.output)).map(record => record.issue));
  return { unfinished, dispositions, commit() {
    // Validate all snapshots before changing any ledger, even if a future caller
    // introduces an asynchronous boundary between preparation and commitment.
    for (const { ledger, records } of snapshots) if (JSON.stringify(ledger.snapshot()) !== JSON.stringify(records)) throw new Error('Pending operations changed before supersession was committed');
    for (const { ledger, records } of snapshots) for (const record of records) if (superseded.has(record.output)) ledger.delete(record.output);
  } };
}

module.exports = { SUPERSESSION_SCHEMA, OperationLedger, prepareSupersession };
