'use strict';

const express = require('express');

function usdPerMillion(microUsd) {
  return microUsd === null ? null : microUsd / 1_000_000;
}

function publicModel(model, visitorProviders) {
  return {
    config_key: model.configKey,
    display_name: model.displayName,
    provider: model.providerKey,
    provider_display_name: model.providerDisplayName,
    reasoning: model.supportsReasoning,
    reasoning_effort: model.reasoningEffort,
    max_context_tokens: model.maxContextTokens,
    input_price_usd_per_million: usdPerMillion(model.inputPriceMicroUsdPerMillion),
    cached_input_price_usd_per_million: usdPerMillion(model.cachedInputPriceMicroUsdPerMillion),
    output_price_usd_per_million: usdPerMillion(model.outputPriceMicroUsdPerMillion),
    visitor_key: visitorProviders.has(model.providerKey)
  };
}

// The visitor-facing model catalog: what "auto" resolves to, what can be picked, and which
// providers the visitor has their own key for.
function createRouter({ gateway, platformConfig, providerKeys }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const config = platformConfig.current();
      const [{ model: active }, selectable, providers, keys] = await Promise.all([
        gateway.resolveActiveModel(),
        gateway.listSelectableModels(),
        gateway.listEnabledProviders(),
        providerKeys.list(req.auth.visitorId)
      ]);
      const visitorProviders = new Set(keys.map(key => key.provider));
      const selectableProviders = new Set(selectable.map(model => model.providerKey));
      return res.json({
        selection_enabled: config.visitorModelSelectionEnabled,
        provider_keys_enabled: config.visitorProviderKeysEnabled,
        visitor_keys_bypass_spend_limits: config.visitorKeysBypassSpendLimits,
        active: publicModel(active, visitorProviders),
        models: selectable.map(model => publicModel(model, visitorProviders)),
        providers: providers.filter(provider => selectableProviders.has(provider.providerKey)).map(provider => ({
          provider_key: provider.providerKey,
          display_name: provider.displayName,
          visitor_key: keys.find(key => key.provider === provider.providerKey) || null
        }))
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createRouter };
