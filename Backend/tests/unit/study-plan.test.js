'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../../src/system/aso/studyPlan');

test('plan items need a description and a known kind', () => {
  assert.throws(() => plan.createItem({ step: '', kind: 'table' }, 0), /plan item 1 needs a step/);
  assert.throws(() => plan.createItem({ step: 'x', kind: 'measure' }, 1), /plan item 2 kind must be one of/);
  assert.deepEqual(plan.createItem({ step: 'A heatmap', kind: 'heatmap' }, 0), { text: 'A heatmap', kind: 'heatmap', status: 'todo', artifacts: [] });
});

test('a finish covers a chart item only with a rendered figure of that type, and not_done skips an item', () => {
  const items = [plan.createItem({ step: 'measurements', kind: 'table' }, 0), plan.createItem({ step: 'heatmap', kind: 'heatmap' }, 1), plan.createItem({ step: 'scatter', kind: 'scatter' }, 2), plan.createItem({ step: 'cohort', kind: 'gene_set' }, 3)];
  const byId = new Map([['a1', { tool: 'investigator_hpa' }], ['a5', { tool: 'deep_research_hpa' }]]);
  assert.deepEqual(plan.uncovered(items, { tables: [{ artifact: 'a1' }], figures: [{ figure: { type: 'heatmap' } }], claims: [], notDone: [{ item: 3 }] }, byId), [], 'a cited table delivers a table item and a cohort item; not_done skips the scatter');
  assert.deepEqual(plan.uncovered(items, { tables: [], figures: [{ figure: { type: 'heatmap' } }, { figure: { type: 'scatter' } }], claims: [], notDone: [] }, byId), ['1. measurements (table)', '4. cohort (gene_set)']);
  assert.deepEqual(plan.uncovered(items, { tables: [{ artifact: 'a5' }], figures: [{ figure: { type: 'heatmap' } }, { figure: { type: 'scatter' } }], claims: [], notDone: [] }, byId), []);
  assert.match(plan.planText(items), /^1\. \[todo\] measurements \| table\n2\. \[todo\] heatmap \| heatmap/);
  assert.match(plan.planText([plan.createItem({ step: 'kidney cohort', kind: 'gene_set' }, 0)], { gene_set: 'gene_set ← deep_research_hpa' }), /^1\. \[todo\] kidney cohort \| gene_set ← deep_research_hpa$/, 'the plan says who delivers a cohort');
});
