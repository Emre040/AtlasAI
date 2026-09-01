'use strict';

// Runs before /query and /batch: picks the model (visitor choice or the active one), picks the
// credential (the visitor's own key for that provider, else the platform's), asks the policy
// engine whether the request may proceed, and binds model + credential for the request scope.

const { PolicyRefusal } = require('./limits');

const CONFIG_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function refusalPayload(refusal) {
  return {
    error: 'policy_refused',
    reason: refusal.reason,
    scope: refusal.scope,
    measured: refusal.measured,
    limit: refusal.limit,
    retry_after_seconds: refusal.retryAfterSeconds
  };
}

function createPolicyMiddleware({
  gateway,
  platformConfig,
  policyEngine,
  providerKeys,
  requestEvents,
  routeKind,
  batchQueryCount = () => 0
}) {
  if (!['query', 'batch'].includes(routeKind)) throw new TypeError(`Unknown policy route kind '${routeKind}'.`);

  return async (req, res, next) => {
    const config = platformConfig.current();
    const visitorId = req.auth.visitorId;
    const requestEventId = Number.isInteger(req.requestEventId) ? req.requestEventId : null;
    const decisionContext = { visitorId, requestEventId, modelId: null, routeKind };

    try {
      if (requestEventId !== null) await requestEvents.attachVisitor(requestEventId, visitorId);

      let model;
      let modelSelection = 'auto';
      const requested = req.body?.model;
      if (requested !== undefined && requested !== null && requested !== '' && requested !== 'auto') {
        if (typeof requested !== 'string' || !CONFIG_KEY_PATTERN.test(requested)) {
          return res.status(400).json({ error: 'invalid_model' });
        }
        if (!config.visitorModelSelectionEnabled) {
          const refusal = new PolicyRefusal('model_selection_disabled', { measured: 0, limit: 0, scope: 'platform' });
          await policyEngine.record('blocked', refusal, decisionContext);
          return res.status(403).json(refusalPayload(refusal));
        }
        model = await gateway.loadModel(requested);
        if (!model || !model.visitorSelectable || model.status === 'disabled') {
          const refusal = new PolicyRefusal('model_not_selectable', { measured: 0, limit: 0, scope: 'platform' });
          await policyEngine.record('blocked', refusal, { ...decisionContext, modelId: model?.id ?? null });
          return res.status(404).json(refusalPayload(refusal));
        }
        modelSelection = 'visitor';
      } else {
        ({ model } = await gateway.resolveActiveModel());
      }
      decisionContext.modelId = model.id;

      let credential = null;
      if (config.visitorProviderKeysEnabled) {
        credential = await providerKeys.credential(visitorId, model.providerId);
      }
      const credentialSource = credential ? 'visitor' : 'platform';

      const admitted = await policyEngine.admit({
        visitorId,
        requestEventId,
        model,
        modelSelection,
        credentialSource,
        routeKind,
        batchQueryCount: batchQueryCount(req),
        loadFallbackModel: id => gateway.loadModelById(id)
      });

      if (admitted.model.id !== model.id) {
        // Budget fallback: the platform pays for the fallback model with its own key.
        model = admitted.model;
        modelSelection = admitted.modelSelection;
        credential = null;
      }

      let apiKey;
      if (credential) {
        apiKey = credential.apiKey;
        await providerKeys.recordUse(credential.id);
      } else {
        try {
          apiKey = gateway.platformCredential(model);
        } catch (error) {
          console.error('[POLICY_CREDENTIAL_MISSING]', error.message);
          return res.status(503).json({ error: 'provider_unavailable', provider: model.providerKey });
        }
      }

      req.modelBinding = {
        configKey: model.configKey,
        displayName: model.displayName,
        provider: model.providerKey,
        credentialSource: credential ? 'visitor' : 'platform',
        modelSelection
      };
      return gateway.runWithBinding({
        model,
        apiKey,
        credentialSource: credential ? 'visitor' : 'platform',
        modelSelection
      }, next);
    } catch (error) {
      if (error instanceof PolicyRefusal) {
        if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
        return res.status(429).json(refusalPayload(error));
      }
      return next(error);
    }
  };
}

module.exports = { createPolicyMiddleware, refusalPayload };
