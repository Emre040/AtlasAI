'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../../src/system/aso/studyPlan');

test('plan items need a description and a known kind', () => {
  assert.throws(() => plan.createItem({ step: '', kind: 'table' }, 0), /plan item 1 needs a step/);
  assert.throws(() => plan.createItem({ step: 'x', kind: 'measure' }, 1), /plan item 2 kind must be one of/);
  assert.deepEqual(plan.createItem({ step: 'A heatmap', kind: 'heatmap' }, 0), { text: 'A heatmap', kind: 'heatmap', status: 'todo', artifacts: [] });
});

test('the chart operation draws 17 types, and a figure of any other type is declined rather than drawn as another', () => {
  assert.equal(plan.CHART_KINDS.length, 17);
  for (const kind of ['stacked_bar', 'waterfall', 'box', 'ridge', 'pca', 'umap']) assert.ok(plan.CHART_KINDS.includes(kind), kind);
  assert.throws(() => plan.createItem({ step: 'A Sankey diagram', kind: 'other_figure' }, 0), /plan item 1 is a figure of a type the chart operation does not draw .*: give not_done naming the type asked for/);
  const declined = plan.createItem({ step: 'A Sankey diagram', kind: 'other_figure', not_done: 'Sankey diagrams are not among the chart types' }, 0);
  assert.equal(declined.status, 'not_done');
  assert.deepEqual(plan.uncovered([declined], { tables: [], figures: [], claims: [], notDone: [] }, new Map()), [], 'a declined figure is reported, not owed');
  assert.deepEqual(plan.uncovered([plan.createItem({ step: 'UMAP of the genes', kind: 'umap' }, 0)], { tables: [], figures: [{ figure: { type: 'pca' } }], claims: [], notDone: [] }, new Map()), ['1. UMAP of the genes (umap)'], 'a PCA does not deliver a UMAP');
});

test('a finish covers a chart item only with a rendered figure of that type, and not_done skips an item', () => {
  const items = [plan.createItem({ step: 'measurements', kind: 'table' }, 0), plan.createItem({ step: 'heatmap', kind: 'heatmap' }, 1), plan.createItem({ step: 'scatter', kind: 'scatter' }, 2), plan.createItem({ step: 'cohort', kind: 'gene_set' }, 3)];
  const byId = new Map([['a1', { tool: 'investigator_hpa' }], ['a5', { tool: 'deep_research_hpa' }]]);
  assert.deepEqual(plan.uncovered(items, { tables: [{ artifact: 'a1' }], figures: [{ figure: { type: 'heatmap' } }], claims: [], notDone: [{ item: 3 }] }, byId), [], 'a cited table delivers a table item and a cohort item; not_done skips the scatter');
  assert.deepEqual(plan.uncovered(items, { tables: [], figures: [{ figure: { type: 'heatmap' } }, { figure: { type: 'scatter' } }], claims: [], notDone: [] }, byId), ['1. measurements (table)', '4. cohort (gene_set)']);
  assert.deepEqual(plan.uncovered(items, { tables: [{ artifact: 'a5' }], figures: [{ figure: { type: 'heatmap' } }, { figure: { type: 'scatter' } }], claims: [], notDone: [] }, byId), []);
  assert.deepEqual(plan.uncovered(items, { tables: [{ artifact: 'a5' }], figures: [{ figure: { type: 'heatmap' } }, { figure: { type: 'bubble' } }], claims: [], notDone: [] }, byId), [], 'a bubble chart delivers a scatter item: the same family');
  assert.deepEqual(plan.uncovered([plan.createItem({ step: 'counts', kind: 'bar' }, 0)], { tables: [], figures: [{ figure: { type: 'grouped_bar' } }], claims: [], notDone: [] }, byId), [], 'a grouped bar delivers a bar item');
  assert.deepEqual(plan.uncovered([plan.createItem({ step: 'counts', kind: 'bar' }, 0)], { tables: [], figures: [{ figure: { type: 'heatmap' } }], claims: [], notDone: [] }, byId), ['1. counts (bar)'], 'a heatmap does not');
  assert.match(plan.planText(items), /^1\. \[todo\] measurements \| table\n2\. \[todo\] heatmap \| heatmap/);
  assert.match(plan.planText([plan.createItem({ step: 'kidney cohort', kind: 'gene_set' }, 0)], { gene_set: 'gene_set ← deep_research_hpa' }), /^1\. \[todo\] kidney cohort \| gene_set ← deep_research_hpa$/, 'the plan says who delivers a cohort');
});
