
const apiBaseOverride = process.env.REACT_APP_HPA_API_BASE;

const hpaConfig = {
  api: {
    baseUrl: apiBaseOverride || 'https://p9000.greenaurem.org',

    endpoints: {
      webserverCookie: '/auth/cookie',           
      query: '/query',                            
      createConversation: '/conversations',      
      listConversations: '/conversations',        
      getMessages: '/conversations/messages',      
      queryStream: '/query/stream',               
      adminSummary: '/hpa-admin/summary',
      adminGeo: '/hpa-admin/geo',
      adminCookies: '/hpa-admin/cookies',
      adminBlock: '/hpa-admin/block',
      authCheck: '/auth/check',
      hpaSearchResults: '/hpa-proxy/search-results',
      hpaGeneThumbnails: '/hpa-proxy/gene-thumbnails-batch'
    }
  },

  ui: {
    maxConversationTitleLength: 50,
    messageTimestampFormat: {
      hour: 'numeric',
      minute: '2-digit'
    }
  }
};


export function getApiBaseUrl() {
  return hpaConfig.api.baseUrl;
}


export function getApiEndpoint(endpointKey) {
  const baseUrl = hpaConfig.api.baseUrl;
  const path = hpaConfig.api.endpoints[endpointKey];
  if (!path) {
    console.error(`API endpoint key "${endpointKey}" not found in hpaConfig.`);
    return baseUrl; // Return a sensible default
  }
  return `${baseUrl}${path}`;
}


export function getUiConfig() {
  return hpaConfig.ui;
}

export default hpaConfig;
