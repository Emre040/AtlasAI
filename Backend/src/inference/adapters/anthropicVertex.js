'use strict';

// Claude through Google Cloud Vertex AI. Vertex serves the same Messages API as api.anthropic.com,
// so every conversion in anthropicMessages.js applies unchanged and only the client differs: the
// model moves into the URL path and Google Application Default Credentials replace the API key.
//
// Vertex model ids are not always the first-party ids. Dated snapshots use an '@' separator
// (claude-opus-4-5@20251101, not claude-opus-4-5-20251101), so the model_id column, not this file,
// decides what is called.

const { AnthropicVertex } = require('@anthropic-ai/vertex-sdk');
const { AnthropicMessagesAdapter } = require('./anthropicMessages');
const { regionFromBaseUrl, configuredProjectId } = require('./vertex');

class AnthropicVertexAdapter extends AnthropicMessagesAdapter {
  constructor({ baseURL, timeout, maxRetries, projectId, client } = {}) {
    if (client) {
      super({ client });
      return;
    }
    const project = projectId || configuredProjectId();
    super({
      client: new AnthropicVertex({
        region: regionFromBaseUrl(baseURL),
        // Left unset the SDK takes the project from the credentials, which is what a backend
        // running on a Google VM should do.
        ...(project ? { projectId: project } : {}),
        timeout,
        maxRetries
      })
    });
  }
}

module.exports = { AnthropicVertexAdapter };
