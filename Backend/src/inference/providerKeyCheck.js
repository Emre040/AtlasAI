'use strict';

// Live, zero-generation check that a provider API key is accepted, using each provider's
// model-listing endpoint. Returns the number of models the key can see.

async function checkOpenAiCompatibleKey(apiBaseUrl, apiKey, timeoutMs) {
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/models`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw Object.assign(new Error(`Provider rejected the key (HTTP ${response.status}): ${body}`), { status: response.status });
  }
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data.length : 0;
}

async function checkAnthropicKey(apiBaseUrl, apiKey, timeoutMs) {
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/v1/models?limit=1`;
  const response = await fetch(url, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw Object.assign(new Error(`Provider rejected the key (HTTP ${response.status}): ${body}`), { status: response.status });
  }
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data.length : 0;
}

async function checkProviderKey(provider, apiKey, { timeoutMs = 15000 } = {}) {
  if (provider.adapter_key === 'anthropic_messages') return checkAnthropicKey(provider.api_base_url, apiKey, timeoutMs);
  if (provider.adapter_key === 'openai_chat_completions') return checkOpenAiCompatibleKey(provider.api_base_url, apiKey, timeoutMs);
  throw new Error(`Unsupported inference adapter '${provider.adapter_key}'.`);
}

module.exports = { checkProviderKey };
