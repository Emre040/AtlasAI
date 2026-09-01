'use strict';

/**
 * Manual ASO test runner
 * Usage:
 *  node test_aso_manual.js "goal text"
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'config.env') });
const { createDbClient } = require('./modules/dbClient');
const aso = require('./modules/functions/aso');

async function run() {
  const goal = process.argv.slice(2).join(' ') || 'Find transporters enriched in kidney but not brain.';
  const db = await createDbClient();

  const result = await aso({
    goal,
    max_steps: 25,
    // top_x defaults to DEFAULT_TOP_X (0 = all) in aso.js
    parallel_limit: 2,
    allow_search: true
  }, {
    db,
    rawQuery: goal,
    cookieId: 'manual-test'
  });

  console.log('\nASO RESULT');
  console.log('==========');
  console.log(JSON.stringify(result, null, 2));

  if (db?.pool?.end) await db.pool.end().catch(() => {});
  else if (db?.end) await db.end().catch(() => {});
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
