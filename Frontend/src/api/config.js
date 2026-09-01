const apiBaseValue = process.env.REACT_APP_HPA_API_BASE?.trim();
if (!apiBaseValue) {
  throw new Error('REACT_APP_HPA_API_BASE is required.');
}

let apiUrl;
try {
  apiUrl = new URL(apiBaseValue);
} catch {
  throw new Error('REACT_APP_HPA_API_BASE must be a valid URL origin.');
}
if (apiUrl.origin !== apiBaseValue || apiUrl.username || apiUrl.password) {
  throw new Error('REACT_APP_HPA_API_BASE must be an origin without credentials, path, query, or fragment.');
}

const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLocal = localHostnames.has(apiUrl.hostname);
if (!isLocal && apiUrl.protocol !== 'https:') {
  throw new Error('REACT_APP_HPA_API_BASE must use HTTPS outside localhost.');
}

const hpaConfig = Object.freeze({
  runtime: Object.freeze({ isLocal }),
  api: Object.freeze({
    baseUrl: apiUrl.origin,

    endpoints: Object.freeze({
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
    })
  }),

  ui: Object.freeze({
    maxConversationTitleLength: 50,
    messageTimestampFormat: Object.freeze({
      hour: 'numeric',
      minute: '2-digit'
    })
  })
});


export function getApiBaseUrl() {
  return hpaConfig.api.baseUrl;
}


export function getApiEndpoint(endpointKey) {
  const baseUrl = hpaConfig.api.baseUrl;
  const path = hpaConfig.api.endpoints[endpointKey];
  if (!path) {
    throw new Error(`API endpoint key "${endpointKey}" is not configured.`);
  }
  return `${baseUrl}${path}`;
}


export function getUiConfig() {
  return hpaConfig.ui;
}

export function getRuntimeConfig() {
  return hpaConfig.runtime;
}

export default hpaConfig;
