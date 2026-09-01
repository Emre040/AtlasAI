'use strict';

const { extractRequestContext } = require('../requestContext/cloudflare');

function createRequestEventMiddleware(repository, cloudflareConfig) {
  return async function requestEvents(req, res, next) {
    if (req.method === 'OPTIONS' || req.path === '/healthz') return next();

    const startedAt = process.hrtime.bigint();
    const receivedUnixMs = Date.now();
    req.requestContext = extractRequestContext(req, cloudflareConfig, startedAt);
    req.requestEventId = null;

    try {
      const started = await repository.begin(req.requestContext, receivedUnixMs);
      req.requestEventId = started.id;
      req.requestEventPublicId = started.publicId;
    } catch (error) {
      console.error('[REQUEST_EVENT_WRITE_FAILED]', error?.code || error?.message || String(error));
    }

    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      if (!req.requestEventId) return;
      const context = extractRequestContext(req, cloudflareConfig, startedAt);
      context.values.received_unix_ms = receivedUnixMs;
      repository.finish(req.requestEventId, context, req.auth).catch(error => {
        console.error('[REQUEST_EVENT_WRITE_FAILED]', error?.code || error?.message || String(error));
      });
    };

    res.once('finish', record);
    res.once('close', record);
    return next();
  };
}

module.exports = { createRequestEventMiddleware };
