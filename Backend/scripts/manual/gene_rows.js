'use strict';
// Prints chosen master-table columns for a few genes, straight from the release database, no model.
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
  const { duckStore } = require(backend + '/src/hpa/duckStore');
  await duckStore.ensure({ root: runtime.dataLocalRoot, version: v, datasets: await require(backend + '/src/hpa/localData').localData.datasets.listReady(v), log: () => {} });
  const [file, ...rest] = process.argv.slice(2);
  const columns = rest.filter(a => a.startsWith('col=')).map(a => a.slice(4));
  const values = rest.filter(a => !a.startsWith('col=') && !a.startsWith('by='));
  const by = (rest.find(a => a.startsWith('by=')) || 'by=Gene').slice(3);
  for await (const row of duckStore.rows(file, { where: [{ column: by, values }] })) console.log(JSON.stringify(Object.fromEntries((columns.length ? columns : Object.keys(row)).map(c => [c, row[c]]))));
  await connection.end(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
