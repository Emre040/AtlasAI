'use strict';

/**
 * Manual ASO test runner
 * Usage:
 *  node scripts/manual/test_aso.js <visitor-uuid> "goal text"
 */

const { initializeManualRuntime } = require('./runtime');
const aso = require('../../src/system/agents/aso');
const { uuidStringToBuffer } = require('../../src/shared/ids');

async function run() {
  const visitorPublicId = process.argv[2];
  if (!visitorPublicId) {
    throw new Error('Usage: node scripts/manual/test_aso.js <visitor-uuid> [goal text]');
  }
  const goal = process.argv.slice(3).join(' ') || 'Find transporters enriched in kidney but not brain.';
  const { db, withActiveModel } = await initializeManualRuntime();
  try {
    const [rows] = await db.execute(
      `SELECT id FROM \`atlasai\`.\`visitors\` WHERE public_id = ? AND status = 'active' LIMIT 1`,
      [uuidStringToBuffer(visitorPublicId)]
    );
    if (!rows[0]) throw new Error('The requested active AtlasAI visitor does not exist.');

    const result = await withActiveModel(() => aso({
      goal,
      max_steps: 25,
      // top_x defaults to DEFAULT_TOP_X (0 = all) in aso.js
      parallel_limit: 2,
      allow_search: true
    }, {
      db,
      rawQuery: goal,
      visitorId: rows[0].id
    }));

    console.log('\nASO RESULT');
    console.log('==========');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.end();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
