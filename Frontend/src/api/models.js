import { authenticatedFetch } from './auth';
import { getApiEndpoint } from './config';

const MODEL_STORAGE_KEY = 'atlasai.model';
export const AUTO_MODEL = 'auto';

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The catalog the backend exposes to this visitor: the active model, selectable models with
// prices, and which providers the visitor has stored a key for.
export async function fetchModelCatalog() {
  const response = await authenticatedFetch(getApiEndpoint('models'));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function saveProviderKey(providerKey, apiKey) {
  const response = await authenticatedFetch(`${getApiEndpoint('providerKeys')}/${encodeURIComponent(providerKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey })
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const error = new Error(payload?.detail || payload?.error || `HTTP ${response.status}`);
    error.code = payload?.error || 'request_failed';
    throw error;
  }
  return payload;
}

export async function removeProviderKey(providerKey) {
  const response = await authenticatedFetch(`${getApiEndpoint('providerKeys')}/${encodeURIComponent(providerKey)}`, {
    method: 'DELETE'
  });
  if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
}

export function loadSelectedModel() {
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY) || AUTO_MODEL;
  } catch {
    return AUTO_MODEL;
  }
}

export function storeSelectedModel(configKey) {
  try {
    if (!configKey || configKey === AUTO_MODEL) window.localStorage.removeItem(MODEL_STORAGE_KEY);
    else window.localStorage.setItem(MODEL_STORAGE_KEY, configKey);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for the page only.
  }
}

const REFUSAL_MESSAGES = {
  platform_budget_day: 'The platform has reached its daily spending budget. Add your own provider key to keep going, or try again later.',
  platform_budget_week: 'The platform has reached its weekly spending budget. Add your own provider key to keep going, or try again later.',
  platform_budget_month: 'The platform has reached its monthly spending budget. Add your own provider key to keep going, or try again later.',
  visitor_budget_day: 'You have reached your daily spending allowance on the platform key. Add your own provider key to keep going.',
  visitor_budget_week: 'You have reached your weekly spending allowance on the platform key. Add your own provider key to keep going.',
  visitor_budget_month: 'You have reached your monthly spending allowance on the platform key. Add your own provider key to keep going.',
  visitor_requests_minute: 'Too many requests in the last minute. Please wait a moment.',
  visitor_requests_hour: 'Too many requests in the last hour. Please try again later.',
  visitor_requests_day: 'You have reached today’s request limit.',
  visitor_tokens_day: 'You have reached today’s token allowance.',
  visitor_runs_day: 'You have reached today’s limit for tool runs.',
  visitor_aso_runs_day: 'You have reached today’s limit for ASO analyses.',
  visitor_concurrent_runs: 'You already have the maximum number of analyses running. Wait for one to finish.',
  visitor_batch_queries_day: 'You have reached today’s batch query limit.',
  global_requests_minute: 'The platform is busy right now. Please retry in a minute.',
  global_concurrent_runs: 'The platform is running at capacity. Please retry shortly.',
  unpriced_model: 'This model has no published price and budgets are enforced, so it cannot be used with the platform key.',
  model_selection_disabled: 'Choosing a model is currently disabled. Select Auto to continue.',
  provider_key_required: 'Add and verify your own API key for this provider to use that model, or select Auto.',
  model_not_selectable: 'That model is not available. Pick another one or use Auto.'
};

// Turns a non-OK response into a message the chat can show. Returns null when the body is not a
// policy refusal so callers keep their generic handling.
export async function describeRefusal(response) {
  const payload = await readJson(response);
  if (!payload) return null;
  if (payload.error === 'policy_refused') {
    const base = REFUSAL_MESSAGES[payload.reason] || 'The request was refused by the platform policy.';
    const wait = payload.retry_after_seconds
      ? ` (retry in about ${payload.retry_after_seconds < 120 ? `${payload.retry_after_seconds} s` : `${Math.round(payload.retry_after_seconds / 60)} min`})`
      : '';
    return { code: payload.reason, message: `${base}${wait}` };
  }
  if (payload.error === 'provider_unavailable') {
    return { code: payload.error, message: `The ${payload.provider} provider is not configured on the platform. Add your own key for it or pick another model.` };
  }
  if (payload.error === 'query_too_large') {
    return { code: payload.error, message: `Your message is too long (limit ${payload.limit} characters).` };
  }
  return null;
}
