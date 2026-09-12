'use strict';

// The plan is the list of deliverables the study owes: what each one is (a gene set, a table, a
// figure of a given type, an interpretation) so the finish can be checked against it.
const CHART_KINDS = ['bar', 'lollipop', 'dot_plot', 'diverging_bar', 'grouped_bar', 'scatter', 'bubble', 'heatmap', 'radar', 'line', 'volcano'];
const KINDS = ['gene_set', 'table', 'interpretation', ...CHART_KINDS];

function createItem(input, index) {
  const text = String(input?.step || '').trim();
  if (!text) throw new Error(`plan item ${index + 1} needs a step describing the deliverable`);
  if (!KINDS.includes(input.kind)) throw new Error(`plan item ${index + 1} kind must be one of ${KINDS.join(', ')}`);
  // What the deliverable needs from the agents rides with it: the study loop starts those
  // summons when the plan is recorded.
  const needs = Array.isArray(input.needs) ? input.needs.filter(n => n && typeof n === 'object' && typeof n.agent === 'string') : [];
  return { text, kind: input.kind, status: 'todo', artifacts: [], needs };
}

// The plan on the desk; labels name who delivers a kind (a cohort comes from the search agent).
function planText(plan, labels = {}) {
  return plan.map((p, i) => `${i + 1}. [${p.status}] ${p.text} | ${labels[p.kind] || p.kind}${p.artifacts.length ? ` → ${p.artifacts.join(', ')}` : ''}`).join('\n') || '(no plan yet: call plan with the deliverables)';
}

// Which plan items a finish covers: a chart item needs a rendered figure of its type among the
// figures; a gene set needs a search result; a table needs a table or a claim on one; an
// interpretation needs a claim.
function uncovered(plan, { tables = [], figures = [], claims = [], notDone = [] }, byId) {
  const figureTypes = figures.map(a => a.figure?.type);
  const tableIds = new Set([...tables.map(t => String(t.artifact).trim()), ...claims.flatMap(c => [c.artifact, ...(c.evidence || []).map(e => e.artifact)]).filter(Boolean).map(id => String(id).trim())]);
  const skipped = new Set(notDone.map(item => item.item));
  return plan.map((p, i) => ({ p, n: i + 1 })).filter(({ p, n }) => {
    if (skipped.has(n)) return false;
    if (CHART_KINDS.includes(p.kind)) return !figureTypes.includes(p.kind);
    if (p.kind === 'interpretation') return !claims.length;
    // A cohort or a table is delivered by any cited table; a supplied list is a cohort too.
    return ![...tableIds].some(id => byId.has(id));
  }).map(({ p, n }) => `${n}. ${p.text} (${p.kind})`);
}

module.exports = { KINDS, CHART_KINDS, createItem, planText, uncovered };
