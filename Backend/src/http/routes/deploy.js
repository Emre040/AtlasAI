'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');

function createRouter({ deploymentService }) {
  const router = express.Router();
  router.use(rateLimit({
    windowMs: 60_000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler(req, res) {
      res.status(429).json({ error: 'deployment_rate_limit_exceeded' });
    }
  }));

  router.use((req, res, next) => {
    if (!deploymentService.isAuthorized(req.get('x-deploy-secret'))) {
      return res.status(401).json({ error: 'invalid_deployment_secret' });
    }
    return next();
  });

  router.post('/github', (req, res, next) => {
    try {
      const result = deploymentService.queue(req.body);
      return res.status(result.queued ? 202 : 200).json(result.status);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/github/:sha', (req, res) => {
    const status = deploymentService.readStatus(req.params.sha);
    if (!status) return res.status(404).json({ error: 'deployment_not_found' });
    return res.json(status);
  });

  return router;
}

module.exports = { createRouter };
