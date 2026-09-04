'use strict';

/**
 * Runs one study (the aso_hpa tool) against the local HPA release and prints the graph as it runs.
 * Usage: node scripts/manual/test_study.js "goal text" [parallel]
 */

const { initializeManualRuntime } = require('./runtime');
const asoStudy = require('../../src/system/agents/asoStudy');
const { inference } = require('../../src/inference/gateway');

async function run() {
  const goal = process.argv[2];
  if (!goal) throw new Error('Usage: node scripts/manual/test_study.js "goal text" [parallel]');
  const parallel = Number(process.argv[3]) || undefined;
  const { db, withActiveModel, end } = await initializeManualRuntime();
  const since = Date.now();
  try {
    const result = await withActiveModel(model => {
      console.log(`model: ${model.configKey}`);
      return inference.withContext({ purpose: 'manual' }, () => asoStudy({ goal, mode: 'offline', parallel_limit: parallel }, {
        db, visitorId: 1,
        onStep: async p => {
          if (/^(node\.|plan|reflect|final|error|start|report)/.test(p.stage || '')) {
            console.log(`${((Date.now() - since) / 1000).toFixed(1).padStart(6)}s ${p.stage.padEnd(14)} ${String(p.message || '').slice(0, 200)}`);
          }
        }
      }));
    });
    console.log('\n== nodes');
    for (const n of result.nodes || []) console.log(`${n.id.padEnd(5)} ${n.op.padEnd(14)} ${n.status.padEnd(7)} ${String(n.rows ?? '').padStart(6)} rows  ${n.label}${n.error ? '  <- ' + n.error : ''}`);
    console.log(`\n== ${result.status}${result.error ? ': ' + result.error : ''} | ${result.seconds ?? ((Date.now() - since) / 1000).toFixed(1)}s | tokens ${JSON.stringify(result.tokens)} | workspace ${result.workspace_uuid}`);
    if (result.summary) console.log(`\n${result.summary}`);
  } finally {
    await end();
  }
}

run().catch(error => { console.error(error); process.exit(1); });
