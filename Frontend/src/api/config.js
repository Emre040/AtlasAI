const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);

// Checks that `value` is a bare origin (HTTPS unless local) and returns the API settings it implies.
// `source` names where the value came from, so the error says what to fix.
function resolveApiBase(value, source) {
  const apiBaseValue = typeof value === 'string' ? value.trim() : '';
  if (!apiBaseValue) {
    throw new Error(`${source} is required.`);
  }

  let apiUrl;
  try {
    apiUrl = new URL(apiBaseValue);
  } catch {
    throw new Error(`${source} must be a valid URL origin.`);
  }
  if (apiUrl.origin !== apiBaseValue || apiUrl.username || apiUrl.password) {
    throw new Error(`${source} must be an origin without credentials, path, query, or fragment.`);
  }

  const isLocal = localHostnames.has(apiUrl.hostname);
  if (!isLocal && apiUrl.protocol !== 'https:') {
    throw new Error(`${source} must use HTTPS outside localhost.`);
  }

  return Object.freeze({
    baseUrl: apiUrl.origin,
    runtime: Object.freeze({ isLocal }),
  });
}

// Resolved on first use rather than at import, so an embedder can call setApiBaseUrl() first
// and a build without VITE_HPA_API_BASE still works when the base is passed at runtime.
let apiState = null;

function getApiState() {
  if (!apiState) {
    apiState = resolveApiBase(import.meta.env.VITE_HPA_API_BASE, 'VITE_HPA_API_BASE');
  }
  return apiState;
}

// Overrides VITE_HPA_API_BASE for the rest of the page's life. Call it before rendering any
// component that talks to the API.
export function setApiBaseUrl(value) {
  apiState = resolveApiBase(value, 'apiBase');
}

const endpoints = Object.freeze({
  authSession: '/auth/session',
  authRefresh: '/auth/refresh',
  authLogout: '/auth/logout',
  query: '/query',
  createConversation: '/conversations',
  listConversations: '/conversations',
  getMessages: '/conversations/messages',
  queryStream: '/query/stream',
  models: '/models',
  providerKeys: '/keys',
  hpaSearchResults: '/hpa-proxy/search-results',
  hpaGeneThumbnails: '/hpa-proxy/gene-thumbnails-batch'
});

const ui = Object.freeze({
  maxConversationTitleLength: 50,
  messageTimestampFormat: Object.freeze({
    hour: 'numeric',
    minute: '2-digit'
  })
});

const hpaConfig = Object.freeze({
  get runtime() {
    return getApiState().runtime;
  },
  api: Object.freeze({
    get baseUrl() {
      return getApiState().baseUrl;
    },
    endpoints,
  }),
  ui,
});


export function getApiBaseUrl() {
  return getApiState().baseUrl;
}


export function getApiEndpoint(endpointKey) {
  const path = endpoints[endpointKey];
  if (!path) {
    throw new Error(`API endpoint key "${endpointKey}" is not configured.`);
  }
  return `${getApiState().baseUrl}${path}`;
}


export function getUiConfig() {
  return ui;
}

export function getRuntimeConfig() {
  return getApiState().runtime;
}

export default hpaConfig;
