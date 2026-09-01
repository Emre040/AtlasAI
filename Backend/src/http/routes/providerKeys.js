'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { checkProviderKey } = require('../../inference/providerKeyCheck');

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

function createRouter({ providerKeys, platformConfig }) {
  const router = express.Router();

  const requireEnabled = (req, res, next) => {
    if (!platformConfig.current().visitorProviderKeysEnabled) {
      return res.status(403).json({ error: 'provider_keys_disabled' });
    }
    return next();
  };

  router.get('/', async (req, res, next) => {
    try {
      return res.json({
        enabled: platformConfig.current().visitorProviderKeysEnabled,
        keys: await providerKeys.list(req.auth.visitorId)
      });
    } catch (error) {
      return next(error);
    }
  });

  // Saving a key talks to the provider, so it is rate limited per visitor on its own.
  const saveLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: req => `visitor:${req.auth.visitorId}`,
    handler(req, res) {
      res.status(429).json({ error: 'provider_key_rate_limit_exceeded' });
    }
  });

  router.put('/:provider', requireEnabled, saveLimiter, async (req, res, next) => {
    try {
      const providerKey = String(req.params.provider || '');
      if (!PROVIDER_KEY_PATTERN.test(providerKey)) return res.status(400).json({ error: 'invalid_provider' });
      const provider = await providerKeys.findProvider(providerKey);
      if (!provider || provider.status !== 'enabled') return res.status(404).json({ error: 'provider_not_found' });

      const apiKey = req.body?.api_key;
      if (typeof apiKey !== 'string' || apiKey.trim().length < 8) return res.status(400).json({ error: 'api_key_required' });

      let modelCount;
      try {
        modelCount = await checkProviderKey(provider, apiKey.trim());
      } catch (error) {
        return res.status(422).json({ error: 'api_key_rejected', detail: String(error.message).slice(0, 200) });
      }

      const saved = await providerKeys.save(req.auth.visitorId, provider.id, apiKey, Date.now());
      return res.status(200).json({ provider: providerKey, suffix: saved.suffix, verified_at: saved.verifiedUnixMs, models_visible: modelCount });
    } catch (error) {
      if (error instanceof TypeError) return res.status(400).json({ error: 'invalid_api_key', detail: error.message });
      return next(error);
    }
  });

  router.delete('/:provider', async (req, res, next) => {
    try {
      const providerKey = String(req.params.provider || '');
      if (!PROVIDER_KEY_PATTERN.test(providerKey)) return res.status(400).json({ error: 'invalid_provider' });
      const provider = await providerKeys.findProvider(providerKey);
      if (!provider) return res.status(404).json({ error: 'provider_not_found' });
      const removed = await providerKeys.remove(req.auth.visitorId, provider.id);
      return res.status(removed ? 204 : 404).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createRouter };
