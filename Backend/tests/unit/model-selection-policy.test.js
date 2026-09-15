'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPolicyMiddleware } = require('../../src/policy/middleware');
const { PolicyEngine } = require('../../src/policy/limits');
const active = { id: 1, configKey: 'default', displayName: 'Default', providerId: 10, providerKey: 'default-provider', visitorSelectable: true };
const alternate = { id: 2, configKey: 'alternate', displayName: 'Alternate', providerId: 20, providerKey: 'other-provider', visitorSelectable: true };
function fixture({ keys = new Map(), enabled = true, budget = null } = {}) {
  const config = {
    visitorModelSelectionEnabled: true, visitorProviderKeysEnabled: enabled,
    visitorKeysBypassSpendLimits: true, visitorKeysBypassVolumeLimits: false,
    visitorRequests: { minute: null, hour: null, day: null }, globalRequestsPerMinute: null,
    visitorConcurrentRuns: null, globalConcurrentRuns: null, visitorTokensPerDay: null,
    visitorRunsPerDay: null, visitorAsoRunsPerDay: null, visitorBatchQueriesPerDay: null,
    platformBudgetUsd: { day: budget, week: null, month: null }, visitorBudgetUsd: { day: null, week: null, month: null },
    overBudgetBehaviour: 'fallback_model', fallbackInferenceModelId: 2, budgetWindowMode: 'rolling'
  };
  const platformConfig = { current: () => config };
  const policy = new PolicyEngine({}, platformConfig);
  const calls = { platform: [], used: [], blocked: [], bindings: [], fallbackLoads: 0 };
  policy.record = async (decision, refusal) => calls.blocked.push({ decision, reason: refusal.reason });
  policy.platformSpendUsd = async () => 5;
  const gateway = {
    resolveActiveModel: async () => ({ model: active }),
    loadModel: async key => [active, alternate].find(model => model.configKey === key),
    loadModelById: async () => { calls.fallbackLoads += 1; return alternate; },
    platformCredential: model => { calls.platform.push(model.id); return 'test-platform-key'; },
    runWithBinding: (binding, next) => { calls.bindings.push(binding); return next(); }
  };
  const providerKeys = {
    credential: async (visitorId, providerId) => keys.get(`${visitorId}:${providerId}`) || null,
    recordUse: async id => calls.used.push(id)
  };
  async function run(model, routeKind = 'query', visitorId = 7) {
    const res = { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; }, set() {} };
    let proceeded = false;
    const req = { auth: { visitorId }, body: { model } };
    await createPolicyMiddleware({ gateway, platformConfig, policyEngine: policy, providerKeys, requestEvents: {}, routeKind })(req, res, error => {
      if (error) throw error;
      proceeded = true;
    });
    return { res, proceeded };
  }
  return { calls, run };
}
for (const route of ['query', 'batch']) {
  test(`${route}: explicit choices never use a platform key, including the default model by name`, async () => {
    for (const name of ['alternate', 'default']) {
      const f = fixture();
      const { res, proceeded } = await f.run(name, route);
      assert.equal(res.statusCode, 403);
      assert.equal(res.payload.reason, 'provider_key_required');
      assert.equal(proceeded, false);
      assert.deepEqual(f.calls.platform, []);
      assert.deepEqual(f.calls.bindings, []);
      assert.equal(f.calls.blocked[0].decision, 'blocked');
    }
  });
  test(`${route}: only the current visitor's matching provider key authorizes the choice`, async () => {
    const credential = { id: 9, apiKey: 'test-visitor-key' };
    const f = fixture({ keys: new Map([['7:10', credential], ['8:20', credential]]) });
    assert.equal((await f.run('alternate', route)).res.statusCode, 403);
    assert.equal((await f.run('alternate', route, 8)).proceeded, true);
    assert.equal(f.calls.bindings[0].model.id, alternate.id);
    assert.equal(f.calls.bindings[0].credentialSource, 'visitor');
    assert.equal(f.calls.bindings[0].apiKey, credential.apiKey);
    assert.deepEqual(f.calls.platform, []);
    assert.deepEqual(f.calls.used, [9]);
  });
  test(`${route}: Auto without a visitor key uses exactly the active model`, async () => {
    const f = fixture();
    assert.equal((await f.run('auto', route)).proceeded, true);
    assert.equal((await f.run(undefined, route)).proceeded, true);
    assert.deepEqual(f.calls.platform, [active.id, active.id]);
    assert.ok(f.calls.bindings.every(binding => binding.model.id === active.id && binding.modelSelection === 'auto'));
  });
  test(`${route}: a budget refuses Auto instead of serving a different platform model`, async () => {
    const f = fixture({ budget: 1 });
    const { res, proceeded } = await f.run('auto', route);
    assert.equal(res.statusCode, 429);
    assert.equal(res.payload.reason, 'platform_budget_day');
    assert.equal(proceeded, false);
    assert.equal(f.calls.fallbackLoads, 0);
    assert.deepEqual(f.calls.platform, []);
    assert.deepEqual(f.calls.bindings, []);
    assert.deepEqual(f.calls.blocked, [{ decision: 'blocked', reason: 'platform_budget_day' }]);
  });
}
test('disabling provider keys refuses explicit models even with a stored key', async () => {
  const f = fixture({ enabled: false, keys: new Map([['7:20', { id: 9, apiKey: 'test-visitor-key' }]]) });
  assert.equal((await f.run('alternate')).res.statusCode, 403);
  assert.deepEqual(f.calls.platform, []);
});
test('a removed key cannot continue using the previous model through platform credentials', async () => {
  const keys = new Map([['7:20', { id: 9, apiKey: 'test-visitor-key' }]]);
  const f = fixture({ keys });
  assert.equal((await f.run('alternate')).proceeded, true);
  keys.clear();
  assert.equal((await f.run('alternate')).res.statusCode, 403);
  assert.equal(f.calls.bindings.length, 1);
  assert.deepEqual(f.calls.platform, []);
});
