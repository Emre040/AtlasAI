'use strict';
const path = require('path');
const zlib = require('zlib');
const fs = require('fs');
const tarfs = require('tar-fs');
require('dotenv').config({ path: path.join(__dirname, 'config.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createDbClient } = require('./modules/dbClient');
const { createRouter: createAuthRouter } = require('./modules/auth');
const { createRouter: createQueryRouter } = require('./modules/query');
const { createRouter: createConversationRouter } = require('./modules/conversation');
const { createRouter: createAnalyticsRouter } = require('./modules/adminAnalytics');
const { createRouter: createHpaProxyRouter } = require('./modules/hpaProxy');
const { createRouter: createBatchRouter } = require('./modules/batch');
const { BlocklistService } = require('./modules/blocklist');
const { resolveWorkspaceRoot } = require('./modules/aso/workspaceStore');
const { createRouter: createHpmRouter } = require('./modules/hpmSummaries');
async function bootstrap() {
  const db = await createDbClient();
  const app = express();

  const authRouter = createAuthRouter(db);
  const queryRouter = createQueryRouter(db);
  const conversationRouter = createConversationRouter(db);
  const analyticsRouter = createAnalyticsRouter(db);
  const blocklistService = new BlocklistService(db);

  // Debug: Log CORS config
  const corsOriginsRaw = process.env.HPA_CORS_ORIGINS;
  console.log('[CORS] Raw HPA_CORS_ORIGINS:', corsOriginsRaw);
  
  if (!corsOriginsRaw) {
    console.error('[CORS] WARNING: HPA_CORS_ORIGINS is undefined!');
  }
  
  const corsOrigins = corsOriginsRaw ? corsOriginsRaw.split(',').map(o => o.trim()) : ['*'];
  console.log('[CORS] Parsed origins:', corsOrigins);

  const corsOptions = {
    origin: (origin, callback) => {
      console.log('[CORS] Incoming request origin:', origin);
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) {
        console.log('[CORS] No origin header - allowing');
        return callback(null, true);
      }
      if (corsOrigins.includes('*') || corsOrigins.includes(origin)) {
        console.log('[CORS] Origin allowed:', origin);
        return callback(null, true);
      }
      console.log('[CORS] Origin BLOCKED:', origin, '| Allowed:', corsOrigins);
      callback(new Error('CORS not allowed'));
    },
    credentials: true
  };

  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: process.env.HPA_JSON_LIMIT }));
  app.use(blocklistService.middleware());

  app.use('/auth', authRouter);
  app.use('/query', queryRouter);
  app.use('/conversations', conversationRouter);
  app.use('/hpa-admin', analyticsRouter);
  app.use('/hpa-proxy', createHpaProxyRouter());
  app.use('/batch', createBatchRouter(db));
  app.use('/hpm', createHpmRouter());

  // Serve ASO workspace artifacts (chart PNGs, reports)
  const workspaceRoot = resolveWorkspaceRoot();
  app.get('/workspaces/:uuid/artifacts/:filename', (req, res) => {
    const { uuid, filename } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
      return res.status(400).json({ error: 'Invalid workspace ID' });
    }
    if (!/^[\w.-]+$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(workspaceRoot, uuid, 'artifacts', filename);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Artifact not found' });
    });
  });

  // Download entire workspace as tar.gz
  app.get('/workspaces/:uuid/download', (req, res) => {
    const { uuid } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
      return res.status(400).json({ error: 'Invalid workspace ID' });
    }
    const wsDir = path.join(workspaceRoot, uuid);
    if (!fs.existsSync(wsDir)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="workspace-${uuid}.tar.gz"`);
    const pack = tarfs.pack(wsDir, {
      ignore: (name) => {
        const rel = path.relative(wsDir, name);
        return rel === 'scratch' || rel.startsWith('scratch/');
      }
    });
    const gzip = zlib.createGzip();
    pack.pipe(gzip).pipe(res);
    pack.on('error', (err) => {
      console.error(`[ERROR] Workspace download pack error for ${uuid}:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Archive failed' });
    });
    gzip.on('error', (err) => {
      console.error(`[ERROR] Workspace download gzip error for ${uuid}:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Compression failed' });
    });
  });

  app.get('/healthz', (req, res) => res.json({
    ok: true,
    app: process.env.HPA_APP_NAME,
    dbMode: db.mode
  }));

  app.use((err, req, res, next) => {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
    if (process.env.NODE_ENV !== 'production') console.error(err.stack);
    if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
  });

  const port = parseInt(process.env.HPA_PORT, 10) || 9012;
  const host = process.env.HPA_HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`[SERVER] ${process.env.HPA_APP_NAME} listening on ${host}:${port} (db: ${db.mode})`);
  });
}

bootstrap().catch(err => {
  console.error('[FATAL] HPA Agent failed to start.', err);
  process.exit(1);
});
