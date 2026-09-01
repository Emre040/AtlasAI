'use strict';

const { initializeManualRuntime } = require('./runtime');
const deepResearch = require('../../src/system/agents/deepResearch.js');

// Simple step logger
function onStep(step) {
  const { stage, label, message } = step;
  const labelStr = label ? `[${label}]` : '';
  console.log(`${stage.toUpperCase().padEnd(16)} ${labelStr.padEnd(20)} ${message || ''}`);
}

async function main() {
  const { db, withActiveModel } = await initializeManualRuntime();
  // Accept goal from command line or use default
  const goal = process.argv[2] || 'voltage-gated ion channels expressed in heart muscle and brain but absent from lung and stomach';

  console.log('\n========================================');
  console.log(`Testing deepResearch with goal: "${goal}"`);
  console.log('========================================\n');

  try {
    const result = await withActiveModel(() => deepResearch({ goal }, { onStep }));

    console.log('\n========================================');
    console.log('FINAL RESULT:');
    console.log('========================================');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await db.end();
  }
}

main();
