'use strict';

const { extractRequestContext } = require('../requestContext/cloudflare');

function createRequestEventMiddleware(repository, cloudflareConfig) {
  return function requestEvents(req, res, next) {
    if (req.method === 'OPTIONS' || req.path === '/healthz') return next();

    const startedAt = process.hrtime.bigint();
    const receivedUnixMs = Date.now();
    req.requestContext = extractRequestContext(req, cloudflareConfig, startedAt);

    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const context = extractRequestContext(req, cloudflareConfig, startedAt);
      context.values.received_unix_ms = receivedUnixMs;
      repository.record(context, req.auth).catch(error => {
        console.error('[REQUEST_EVENT_WRITE_FAILED]', error?.code || error?.message || String(error));
      });
    };

    res.once('finish', record);
    res.once('close', record);
    next();
  };
}

module.exports = { createRequestEventMiddleware };
