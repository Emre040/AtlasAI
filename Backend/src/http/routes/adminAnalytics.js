'use strict';

const crypto = require('node:crypto');
const express = require('express');

function constantTimeEqual(actual, expected) {
  const actualHash = crypto.createHash('sha256').update(actual, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function createBasicAuthentication({ username, password }) {
  return function basicAuthentication(req, res, next) {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="AtlasAI Admin", charset="UTF-8"');
      return res.status(401).json({ error: 'unauthorized' });
    }

    let decoded;
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      decoded = '';
    }
    const separator = decoded.indexOf(':');
    const suppliedUsername = separator === -1 ? '' : decoded.slice(0, separator);
    const suppliedPassword = separator === -1 ? '' : decoded.slice(separator + 1);
    if (
      !constantTimeEqual(suppliedUsername, username) ||
      !constantTimeEqual(suppliedPassword, password)
    ) {
      res.set('WWW-Authenticate', 'Basic realm="AtlasAI Admin", charset="UTF-8"');
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
}

function createRouter({ analytics, accessRules, admin }) {
  const router = express.Router();
  router.use(createBasicAuthentication(admin));

  router.get('/summary', async (req, res, next) => {
    try {
      return res.json(await analytics.summary());
    } catch (error) {
      return next(error);
    }
  });

  router.get('/geo', async (req, res, next) => {
    try {
      return res.json({ points: await analytics.geo() });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/visitors', async (req, res, next) => {
    try {
      return res.json({ visitors: await analytics.visitors() });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/block', async (req, res, next) => {
    try {
      const visitorPublicId = String(req.body?.visitorId || '').trim();
      const action = String(req.body?.action || '');
      if (!visitorPublicId || !action) {
        return res.status(400).json({ error: 'visitor_id_and_action_required' });
      }

      const visitor = await analytics.visitor(visitorPublicId);
      if (!visitor) return res.status(404).json({ error: 'visitor_not_found' });

      if (action === 'block_fingerprint') {
        await accessRules.create({
          type: 'visitor',
          value: visitor.publicId,
          visitorId: visitor.id,
          action: 'block',
          reason: 'Blocked by AtlasAI administrator',
          createdBy: 'admin_api'
        });
      } else if (action === 'unblock_fingerprint') {
        await accessRules.revoke('visitor', visitor.publicId);
      } else if (action === 'block_ip') {
        if (!visitor.lastIp) return res.status(409).json({ error: 'visitor_has_no_ip' });
        await accessRules.create({
          type: 'ip',
          value: visitor.lastIp,
          action: 'block',
          reason: 'Blocked by AtlasAI administrator',
          createdBy: 'admin_api'
        });
      } else if (action === 'unblock_ip') {
        if (!visitor.lastIp) return res.status(409).json({ error: 'visitor_has_no_ip' });
        await accessRules.revoke('ip', visitor.lastIp);
      } else {
        return res.status(400).json({ error: 'invalid_action' });
      }

      return res.json({ ok: true });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'access_rule_already_active' });
      }
      if (error instanceof TypeError) return res.status(400).json({ error: 'invalid_identifier' });
      return next(error);
    }
  });

  return router;
}

module.exports = { createRouter };
