'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { loadRuntimeConfig } = require('./src/config/runtime');
const { createDatabaseClient } = require('./src/database/client');
const { AccessRuleRepository } = require('./src/database/repositories/accessRules');
const { AdminAnalyticsRepository } = require('./src/database/repositories/adminAnalytics');
const { BatchRepository } = require('./src/database/repositories/batches');
const { ConversationRepository } = require('./src/database/repositories/conversations');
const { RequestEventRepository } = require('./src/database/repositories/requestEvents');
const { WorkspaceRepository } = require('./src/database/repositories/workspaces');
const {
  createActiveModelMiddleware,
  initializeInferenceGateway,
  resolveActiveModel
} = require('./src/inference/gateway');
const { loadSessionConfig } = require('./src/security/config');
const { SessionService } = require('./src/security/sessionService');
const { configureWorkspaceRoot } = require('./src/system/aso/workspaceStore');
const { DeploymentService } = require('./src/system/deployment/service');
const { createAccessControlMiddleware } = require('./src/http/middleware/accessControl');
const { createAuthenticationMiddleware } = require('./src/http/middleware/authenticate');
const { createCorsOptions } = require('./src/http/middleware/cors');
const { errorHandler } = require('./src/http/middleware/errorHandler');
const { createGlobalRateLimit } = require('./src/http/middleware/globalRateLimit');
const { createRequestEventMiddleware } = require('./src/http/middleware/requestEvents');
const { createRouter: createAdminRouter } = require('./src/http/routes/adminAnalytics');
const { createRouter: createAuthRouter } = require('./src/http/routes/auth');
const { createRouter: createBatchRouter } = require('./src/http/routes/batch');
const { createRouter: createConversationsRouter } = require('./src/http/routes/conversations');
const { createRouter: createDeployRouter } = require('./src/http/routes/deploy');
const { createRouter: createHpaProxyRouter } = require('./src/http/routes/hpaProxy');
const { createRouter: createHpmRouter } = require('./src/http/routes/hpmSummaries');
const { createRouter: createQueryRouter } = require('./src/http/routes/query');
const { createRouter: createWorkspaceRouter } = require('./src/http/routes/workspaces');

async function bootstrap() {
  const runtime = loadRuntimeConfig(__dirname);
  const sessionConfig = loadSessionConfig();
  const db = await createDatabaseClient();
  await initializeInferenceGateway(db);
  configureWorkspaceRoot(runtime.workspaceRoot);

  const accessRules = new AccessRuleRepository(db);
  const analytics = new AdminAnalyticsRepository(db);
  const batches = new BatchRepository(db);
  const conversations = new ConversationRepository(db);
  const requestEvents = new RequestEventRepository(db);
  const workspaces = new WorkspaceRepository(db);
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
  app.use(createAccessControlMiddleware(accessRules));

  app.use('/auth', createAuthRouter({
    sessionService,
    requireAuthentication,
    requireCsrf,
    config: sessionConfig
  }));
  app.use('/hpa-admin', createAdminRouter({ analytics, accessRules, admin: runtime.admin }));

  const bindActiveModel = createActiveModelMiddleware();
  app.use('/conversations', requireAuthentication, requireCsrf, createConversationsRouter({ conversations }));
  app.use('/query', requireAuthentication, requireCsrf, bindActiveModel, createQueryRouter({ db, conversations }));
  app.use('/batch', requireAuthentication, requireCsrf, bindActiveModel, createBatchRouter({
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
