'use strict';
// Runs the offline search executor on fixed filters, no planner: node scripts/manual/search_fixed.js '<filters JSON>'
const path = require('node:path');
const backend = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(backend, '.env'), quiet: true });
const mysql = require('mysql2/promise');
(async () => {
  const connection = await mysql.createConnection({ host: process.env.HPA_DB_HOST, user: process.env.HPA_DB_USER, password: process.env.HPA_DB_PASS, database: process.env.HPA_DB_NAME });
  await connection.query('START TRANSACTION READ ONLY');
  const db = { query: (...a) => connection.query(...a), execute: (...a) => connection.execute(...a) };
  const config = await require(backend + '/src/policy/config').initializePlatformConfig(db);
  const runtime = require(backend + '/src/config/runtime').loadRuntimeConfig(backend);
  require(backend + '/src/hpa/localData').localData.configure({ root: runtime.dataLocalRoot, db });
  const v = config.current().activeHpaVersion;
  await require(backend + '/src/hpa/duckStore').duckStore.ensure({ root: runtime.dataLocalRoot, version: v, datasets: await require(backend + '/src/hpa/localData').localData.datasets.listReady(v), log: () => {} });
  const adapter = require(backend + '/src/hpa/searchAdapter');
  const filters = JSON.parse(process.argv[2]);
  const r = await adapter.execute(filters, '', 'offline');
  const key = row => row.Ensembl || row.ensembl || row.Gene || row.gene;
  const ids = new Set(r.rows.map(key));
  console.log(`${r.rows.length} rows, ${ids.size} distinct genes; context_columns=${JSON.stringify(r.context_columns || [])}`);
  for (const want of ['ENSG00000107611', 'ENSG00000160801', 'ENSG00000160951']) console.log(want, ids.has(want) ? 'present' : 'MISSING');
  await connection.end(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
