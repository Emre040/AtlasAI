#!/usr/bin/env node
'use strict';

// Brings the release database (hpa-<version>.duckdb beside the files in HPA_DATA_LOCAL_DIR) in
// step with the ready files of the active release: every ready TSV is a table, loaded once and
// again only when its file changes; a file that left the release is dropped. Run by the
// deployment after scripts/sync-hpa-data.js, and by hand. The server runs the same check before
// it answers, so a deployment that skipped this only moves the work to the server's start.
//
//   node scripts/build-hpa-duckdb.js

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { loadRuntimeConfig } = require('../src/config/runtime');
const { createDatabaseClient } = require('../src/database/client');
const { HpaDatasetRepository } = require('../src/database/repositories/hpaDatasets');
const { PlatformConfig } = require('../src/policy/config');
const { duckStore } = require('../src/hpa/duckStore');

function log(message) {
  console.log(`[HPA-DUCKDB ${new Date().toISOString()}] ${message}`);
}

async function main() {
  const runtime = loadRuntimeConfig(path.join(__dirname, '..'));
  const root = runtime.dataLocalRoot;
  const db = await createDatabaseClient();
  try {
    const config = await new PlatformConfig(db).reload();
    const datasets = new HpaDatasetRepository(db);
    const ready = await datasets.listReady(config.activeHpaVersion);
    log(`active HPA version ${config.activeHpaVersion}: ${ready.length} ready files, root ${root}`);
    const meta = await duckStore.ensure({ root, version: config.activeHpaVersion, datasets: ready, log });
    const tables = Object.entries(meta.tables);
    const failed = tables.filter(([, t]) => t.error);
    log(`done: ${tables.length - failed.length}/${tables.length} tables loaded${failed.length ? `; failed: ${failed.map(([file, t]) => `${file} (${t.error})`).join(', ')}` : ''}`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await duckStore.close();
    await db.end();
  }
}

main().catch(error => {
  console.error('[HPA-DUCKDB] fatal:', error?.message || error);
  process.exitCode = 2;
});
