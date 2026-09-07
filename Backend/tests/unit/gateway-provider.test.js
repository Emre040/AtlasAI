'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateHost, validateProviderRow } = require('../../src/inference/gateway');

test('a provider on a private network may use plain HTTP; anything else must use HTTPS', () => {
  const row = (api_base_url) => ({ provider_key: 'local', provider_status: 'enabled', adapter_key: 'openai_chat_completions', credential_env_key: 'LOCAL_API_KEY', api_base_url });
  assert.doesNotThrow(() => validateProviderRow(row('http://100.96.186.12:18300/v1')), 'tailnet address');
  assert.doesNotThrow(() => validateProviderRow(row('http://192.168.0.36:8000/v1')), 'LAN address');
  assert.doesNotThrow(() => validateProviderRow(row('http://localhost:8000/v1')));
  assert.doesNotThrow(() => validateProviderRow(row('https://api.openai.com/v1')));
  assert.throws(() => validateProviderRow(row('http://api.example.com/v1')), /must use HTTPS/);
  assert.throws(() => validateProviderRow(row('http://8.8.8.8/v1')), /must use HTTPS/);
  assert.equal(isPrivateHost('100.63.255.255'), false, 'just below the CGNAT range');
  assert.equal(isPrivateHost('100.127.0.1'), true, 'top of the CGNAT range');
  assert.equal(isPrivateHost('172.32.0.1'), false);
  assert.equal(isPrivateHost('10.1.2.3'), true);
});
