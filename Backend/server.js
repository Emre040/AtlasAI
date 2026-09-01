'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { loadRuntimeConfig } = require('./src/config/runtime');
const { createDatabaseClient } = require('./src/database/client');
const { BatchRepository } = require('./src/database/repositories/batches');
const { ConversationRepository } = require('./src/database/repositories/conversations');
const { RequestEventRepository } = require('./src/database/repositories/requestEvents');
const { RunRepository } = require('./src/database/repositories/runs');
const { WorkspaceRepository } = require('./src/database/repositories/workspaces');
const { localData } = require('./src/hpa/localData');
const { initializeInferenceGateway, resolveActiveModel } = require('./src/inference/gateway');
const { initializePlatformConfig } = require('./src/policy/config');
const { PolicyEngine } = require('./src/policy/limits');
const { createPolicyMiddleware } = require('./src/policy/middleware');
const { loadSessionConfig } = require('./src/security/config');
const { VisitorProviderKeyRepository, encryptionKeyFromHex } = require('./src/security/providerKeys');
const { SessionService } = require('./src/security/sessionService');
const { configureWorkspaceRoot } = require('./src/system/aso/workspaceStore');
const { DeploymentService } = require('./src/system/deployment/service');
const { createAuthenticationMiddleware } = require('./src/http/middleware/authenticate');
const { createCorsOptions } = require('./src/http/middleware/cors');
const { errorHandler } = require('./src/http/middleware/errorHandler');
const { createGlobalRateLimit } = require('./src/http/middleware/globalRateLimit');
const { createRequestEventMiddleware } = require('./src/http/middleware/requestEvents');
const { createRouter: createAuthRouter } = require('./src/http/routes/auth');
const { createRouter: createBatchRouter } = require('./src/http/routes/batch');
const { createRouter: createConversationsRouter } = require('./src/http/routes/conversations');
const { createRouter: createDeployRouter } = require('./src/http/routes/deploy');
const { createRouter: createHpaProxyRouter } = require('./src/http/routes/hpaProxy');
const { createRouter: createHpmRouter } = require('./src/http/routes/hpmSummaries');
const { createRouter: createModelsRouter } = require('./src/http/routes/models');
const { createRouter: createProviderKeysRouter } = require('./src/http/routes/providerKeys');
const { createRouter: createQueryRouter } = require('./src/http/routes/query');
const { createRouter: createWorkspaceRouter } = require('./src/http/routes/workspaces');

async function bootstrap() {
  const runtime = loadRuntimeConfig(__dirname);
  const sessionConfig = loadSessionConfig();
  const db = await createDatabaseClient();
  const gateway = await initializeInferenceGateway(db);
  const platformConfig = await initializePlatformConfig(db);
  configureWorkspaceRoot(runtime.workspaceRoot);
  localData.configure({ root: runtime.dataLocalRoot, db });

  const batches = new BatchRepository(db);
  const conversations = new ConversationRepository(db);
  const requestEvents = new RequestEventRepository(db);
  const runs = new RunRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const providerKeys = new VisitorProviderKeyRepository(db, encryptionKeyFromHex(runtime.providerKeySecret));
  const policyEngine = new PolicyEngine(db, platformConfig);
  const sessionService = new SessionService(db, sessionConfig);
  const deploymentService = new DeploymentService({
    ...runtime.deployment,
    scriptPath: path.join(__dirname, 'deploy', 'production', 'deploy.sh')
  });
  const {
    optionalAuthentication,
    requireAuthentication,
    requireCsrf
  } = createAuthenticationMiddleware(sessionService, sessionConfig);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', runtime.trustProxy);
  app.use(helmet());
  app.use(createRequestEventMiddleware(requestEvents, runtime.cloudflare));
  app.use(cors(createCorsOptions(runtime.corsOrigins)));
  app.use(createGlobalRateLimit(runtime.globalRateLimit));

  app.get('/healthz', async (req, res, next) => {
    try {
      const model = await resolveActiveModel();
      res.json({
        ok: true,
        app: runtime.appName,
        database: db.mode,
        inferenceModel: model.configKey,
        inferenceProvider: model.providerKey
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(express.json({ limit: runtime.jsonLimit, strict: true }));
  app.use('/deploy', createDeployRouter({ deploymentService }));
  app.use(optionalAuthentication);

  app.use('/auth', createAuthRouter({
    sessionService,
    requireAuthentication,
    requireCsrf,
    config: sessionConfig
  }));
  const admitQuery = createPolicyMiddleware({
    gateway, platformConfig, policyEngine, providerKeys, requestEvents, routeKind: 'query'
  });
  const admitBatch = createPolicyMiddleware({
    gateway,
    platformConfig,
    policyEngine,
    providerKeys,
    requestEvents,
    routeKind: 'batch',
    batchQueryCount: req => (Array.isArray(req.body?.queries) ? req.body.queries.length : 0)
  });
  app.use('/conversations', requireAuthentication, requireCsrf, createConversationsRouter({ conversations, runs }));
  app.use('/models', requireAuthentication, requireCsrf, createModelsRouter({ gateway, platformConfig, providerKeys }));
  app.use('/keys', requireAuthentication, requireCsrf, createProviderKeysRouter({ providerKeys, platformConfig }));
  app.use('/query', requireAuthentication, requireCsrf, admitQuery, createQueryRouter({ db, conversations, runs }));
  // Only submissions are admitted by policy; status polls never touch a model.
  const admitBatchSubmission = (req, res, next) => (
    req.method === 'POST' && req.path === '/' ? admitBatch(req, res, next) : next()
  );
  app.use('/batch', requireAuthentication, requireCsrf, admitBatchSubmission, createBatchRouter({
    db,
    batches,
    batchSecret: runtime.batchSecret
  }));
  app.use('/workspaces', requireAuthentication, requireCsrf, createWorkspaceRouter({ workspaces }));
  app.use('/hpa-proxy', requireAuthentication, requireCsrf, createHpaProxyRouter());
  app.use('/hpm', requireAuthentication, requireCsrf, createHpmRouter({ filePath: runtime.hpmSummariesPath }));

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);

  const server = app.listen(runtime.port, runtime.host, () => {
    console.log(`[SERVER] ${runtime.appName} listening on ${runtime.host}:${runtime.port}.`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SERVER] ${signal} received; shutting down.`);
    platformConfig.stopRefreshing();
    server.close(async error => {
      try {
        await db.end();
      } finally {
        process.exit(error ? 1 : 0);
      }
    });
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  return { app, server, db };
}

if (require.main === module) {
  bootstrap().catch(error => {
    console.error('[FATAL] AtlasAI failed to start:', error?.message || error);
    process.exit(1);
  });
}

module.exports = { bootstrap };
