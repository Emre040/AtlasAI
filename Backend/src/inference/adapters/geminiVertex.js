'use strict';

// Gemini through Google Cloud Vertex AI. The request and response bodies are the same
// generateContent shapes as the AI Studio endpoint, so this reuses geminiGenerateContent.js whole
// and replaces only its three seams: a Google OAuth token instead of an API key, a project-scoped
// URL, and a fully qualified model name when creating a context cache.
//
//   AI Studio  https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
//   Vertex     https://<region>-aiplatform.googleapis.com/v1/projects/<project>/locations/<region>
//                /publishers/google/models/<model>:generateContent
//
// Context caches are project and region scoped on Vertex and live under the same locations path.

const { GeminiGenerateContentAdapter } = require('./geminiGenerateContent');
const { regionFromBaseUrl, VertexCredentials } = require('./vertex');

class GeminiVertexAdapter extends GeminiGenerateContentAdapter {
  constructor({ baseURL, timeout, maxRetries, fetchImpl, projectId, credentials } = {}) {
    super({ baseURL, timeout, maxRetries, fetchImpl });
    this.region = regionFromBaseUrl(baseURL);
    this.credentials = credentials || new VertexCredentials({ projectId });
  }

  authHeaders() {
    return this.credentials.authHeaders();
  }

  async endpoint(pathname, stream) {
    const scope = `${this.baseURL}/v1/projects/${await this.credentials.project()}/locations/${this.region}`;
    // Model calls sit under a publisher; cachedContents sits directly under the location.
    const path = pathname.startsWith('models/') ? `publishers/google/${pathname}` : pathname;
    return `${scope}/${path}${stream ? '?alt=sse' : ''}`;
  }

  async cacheModelRef(modelId) {
    return `projects/${await this.credentials.project()}/locations/${this.region}/publishers/google/models/${modelId}`;
  }
}

module.exports = { GeminiVertexAdapter };
