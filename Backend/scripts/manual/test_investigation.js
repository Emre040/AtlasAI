'use strict';

/**
 * Runs the gene-reading agent (investigator_hpa) once and prints its trail.
 * Usage: node scripts/manual/test_investigation.js GENE "question"
 */

const { initializeManualRuntime } = require('./runtime');
const investigatorTrail = require('../../src/system/agents/investigatorTrail');
const { inference } = require('../../src/inference/gateway');

function onStep(step) {
  const label = step.label ? `[${step.label}]` : '';
  console.log(`${String(step.stage || '').toUpperCase().padEnd(16)} ${label.padEnd(18)} ${String(step.message || '').slice(0, 400)}`);
}

async function run() {
  const gene = process.argv[2];
  const question = process.argv[3];
  if (!gene || !question) throw new Error('Usage: node scripts/manual/test_investigation.js GENE "question"');
  const { withActiveModel, end } = await initializeManualRuntime();
  try {
    const result = await withActiveModel(model => {
      console.log(`model: ${model.configKey}`);
      return inference.withContext({ purpose: 'manual' }, () => investigatorTrail({ gene, question, mode: 'offline' }, { onStep }));
    });
    console.log(`\n== found ${result.found}${result.error ? ' | error: ' + result.error : ''}`);
    console.log(`answer: ${result.answer}`);
    if (result.cited_row) console.log(`cited row: ${result.cited_row}`);
    if (result.source_section) console.log(`source: ${result.source_section}`);
    if (result.tokens) console.log(`tokens ${JSON.stringify(result.tokens.total || result.tokens)}`);
  } finally {
    await end();
  }
}

run().catch(error => { console.error(error); process.exit(1); });
