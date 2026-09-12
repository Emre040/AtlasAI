'use strict';

// The plan is the list of deliverables the study owes: what each one is (a gene set, a table, a
// figure of a given type, an interpretation) so the finish can be checked against it.
const CHART_KINDS = ['bar', 'lollipop', 'dot_plot', 'diverging_bar', 'grouped_bar', 'scatter', 'bubble', 'heatmap', 'radar', 'line', 'volcano'];
const KINDS = ['gene_set', 'table', 'interpretation', ...CHART_KINDS];
// A chart item is delivered by a figure of its family: a bar chart of counts per cancer drawn as
// a grouped bar, a scatter drawn as a bubble, are the figure asked for.
const CHART_FAMILIES = [['bar', 'grouped_bar', 'lollipop', 'diverging_bar', 'dot_plot'], ['scatter', 'bubble', 'volcano'], ['heatmap'], ['radar'], ['line']];
const sameFamily = (kind, type) => kind === type || CHART_FAMILIES.some(family => family.includes(kind) && family.includes(type));

function createItem(input, index) {
  const text = String(input?.step || '').trim();
  if (!text) throw new Error(`plan item ${index + 1} needs a step describing the deliverable`);
  if (!KINDS.includes(input.kind)) throw new Error(`plan item ${index + 1} kind must be one of ${KINDS.join(', ')}`);
  const description = String(input.description || '').trim();
  // An item declined when the plan is written carries the reason; it is delivered as a limitation.
  const notDone = String(input.not_done || '').trim();
  return { text, kind: input.kind, status: notDone ? 'not_done' : 'todo', artifacts: [], ...(description ? { description } : {}), ...(notDone ? { not_done: notDone } : {}) };
}

// The plan on the desk; labels name who delivers a kind (a cohort comes from the search agent).
function planText(plan, labels = {}) {
  return plan.map((p, i) => `${i + 1}. [${p.status}] ${p.text} | ${labels[p.kind] || p.kind}${p.not_done ? ` (not computed: ${p.not_done})` : ''}${p.artifacts.length ? ` → ${p.artifacts.join(', ')}` : ''}`).join('\n') || '(no plan yet: call plan with the deliverables)';
}

// Which plan items a finish covers: a chart item needs a rendered figure of its type among the
// figures; a gene set needs a search result; a table needs a table or a claim on one; an
// interpretation needs a claim.
function uncovered(plan, { tables = [], figures = [], claims = [], notDone = [] }, byId) {
  const figureTypes = figures.map(a => a.figure?.type);
  const tableIds = new Set([...tables.map(t => String(t.artifact).trim()), ...claims.flatMap(c => [c.artifact, ...(c.evidence || []).map(e => e.artifact)]).filter(Boolean).map(id => String(id).trim())]);
  const skipped = new Set([...notDone.map(item => item.item), ...plan.map((p, i) => (p.not_done ? i + 1 : null)).filter(Boolean)]);
  return plan.map((p, i) => ({ p, n: i + 1 })).filter(({ p, n }) => {
    if (skipped.has(n)) return false;
    if (CHART_KINDS.includes(p.kind)) return !figureTypes.some(type => sameFamily(p.kind, type));
    if (p.kind === 'interpretation') return !claims.length;
    // A cohort or a table is delivered by any cited table; a supplied list is a cohort too.
    return ![...tableIds].some(id => byId.has(id));
  }).map(({ p, n }) => `${n}. ${p.text} (${p.kind})`);
}

module.exports = { KINDS, CHART_KINDS, CHART_FAMILIES, sameFamily, createItem, planText, uncovered };
