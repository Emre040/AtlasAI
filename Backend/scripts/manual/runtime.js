'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { loadRuntimeConfig } = require('../../src/config/runtime');
const { createDatabaseClient } = require('../../src/database/client');
const { initializeInferenceGateway } = require('../../src/inference/gateway');
const { initializePlatformConfig } = require('../../src/policy/config');
const { localData } = require('../../src/hpa/localData');
const { configureWorkspaceRoot } = require('../../src/system/aso/workspaceStore');

async function initializeManualRuntime() {
  const runtime = loadRuntimeConfig(path.join(__dirname, '..', '..'));
  const db = await createDatabaseClient();
  try {
    const inferenceGateway = await initializeInferenceGateway(db);
    const platformConfig = await initializePlatformConfig(db);
    configureWorkspaceRoot(runtime.workspaceRoot);
    localData.configure({ root: runtime.dataLocalRoot, db });
    return {
      db,
      runtime,
      async withActiveModel(work) {
        const { model } = await inferenceGateway.resolveActiveModel();
        return inferenceGateway.runWithActiveModel(model, () => work(model));
      },
      async end() {
        platformConfig.stopRefreshing();
        await db.end();
      }
    };
  } catch (error) {
    await db.end();
    throw error;
  }
}

module.exports = { initializeManualRuntime };
