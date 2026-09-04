'use strict';

/**
 * Runs the search agent (deep_research_hpa) once and prints its trail.
 * Usage: node scripts/manual/test_deep_research.js "goal text" [online|offline]
 */

const { initializeManualRuntime } = require('./runtime');
const deepResearchTrail = require('../../src/system/agents/deepResearchTrail');
const { inference } = require('../../src/inference/gateway');

function onStep(step) {
  const label = step.label ? `[${step.label}]` : '';
  console.log(`${String(step.stage || '').toUpperCase().padEnd(16)} ${label.padEnd(18)} ${step.message || ''}`);
}

async function run() {
  const goal = process.argv[2];
  if (!goal) throw new Error('Usage: node scripts/manual/test_deep_research.js "goal text" [online|offline]');
  const mode = process.argv[3] === 'online' ? 'online' : 'offline';
  const { withActiveModel, end } = await initializeManualRuntime();
  try {
    const result = await withActiveModel(model => {
      console.log(`model: ${model.configKey} | mode ${mode}`);
      return inference.withContext({ purpose: 'manual' }, () => deepResearchTrail({ goal, mode }, { onStep }));
    });
    console.log(`\n== ${result.status}${result.error ? ': ' + result.error : ''}`);
    if (result.result) console.log(`${result.result.rows_found} rows | ${result.result.search_urls[0]} | ${result.result.plan}`);
    if (result.tokens) console.log(`tokens ${JSON.stringify(result.tokens)}`);
  } finally {
    await end();
  }
}

run().catch(error => { console.error(error); process.exit(1); });
