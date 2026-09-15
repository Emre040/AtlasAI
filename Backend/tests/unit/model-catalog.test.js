'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouter } = require('../../src/http/routes/models');

test('public catalog only lists key providers used by visitor-selectable models', async () => {
  const model = { configKey: 'public-model', providerKey: 'public', displayName: 'Public model', providerDisplayName: 'Public Provider', inputPriceMicroUsdPerMillion: null, cachedInputPriceMicroUsdPerMillion: null, outputPriceMicroUsdPerMillion: null };
  const providerNames = ['public', 'vigil2', 'cerebras', 'openai-responses'];
  const router = createRouter({
    gateway: {
      resolveActiveModel: async () => ({ model: { ...model, providerKey: 'vigil2' } }),
      listSelectableModels: async () => [model],
      listEnabledProviders: async () => providerNames.map(providerKey => ({ providerKey, displayName: providerKey }))
    },
    platformConfig: { current: () => ({ visitorModelSelectionEnabled: true, visitorProviderKeysEnabled: true }) },
    providerKeys: { list: async () => [{ provider: 'public', suffix: 'test' }, { provider: 'vigil2', suffix: 'test' }] }
  });
  const handler = router.stack.find(layer => layer.route?.path === '/').route.stack[0].handle;
  let payload;
  await handler({ auth: { visitorId: 1 } }, { json: value => { payload = value; } }, error => { throw error; });
  assert.deepEqual(payload.providers.map(provider => provider.provider_key), ['public']);
  assert.equal(payload.providers[0].visitor_key.suffix, 'test');
  assert.equal(payload.models[0].visitor_key, true);
  assert.equal(payload.active.provider, 'vigil2', 'Auto remains independently configured');
});
