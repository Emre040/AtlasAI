'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { loadRuntimeConfig } = require('../../src/config/runtime');
const { createDatabaseClient } = require('../../src/database/client');
const { initializeInferenceGateway } = require('../../src/inference/gateway');
const { configureWorkspaceRoot } = require('../../src/system/aso/workspaceStore');

async function initializeManualRuntime() {
  const runtime = loadRuntimeConfig(path.join(__dirname, '..', '..'));
  const db = await createDatabaseClient();
  try {
    const inferenceGateway = await initializeInferenceGateway(db);
    configureWorkspaceRoot(runtime.workspaceRoot);
    return {
      db,
      runtime,
      async withActiveModel(work) {
        const { model } = await inferenceGateway.resolveActiveModel();
        return inferenceGateway.runWithActiveModel(model, () => work(model));
      }
    };
  } catch (error) {
    await db.end();
    throw error;
  }
}

module.exports = { initializeManualRuntime };
