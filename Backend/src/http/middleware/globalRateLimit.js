'use strict';

const { rateLimit } = require('express-rate-limit');

function createGlobalRateLimit({ windowMs, max }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: req => req.method === 'OPTIONS' || req.path === '/healthz',
    handler(req, res) {
      res.status(429).json({ error: 'rate_limit_exceeded' });
    }
  });
}

module.exports = { createGlobalRateLimit };
