'use strict';

// The Google Cloud parts both Vertex adapters need: where the endpoint lives, which project to
// bill, and a bearer token. Vertex has no API key. Credentials are always Application Default
// Credentials, which means the service account file named by GOOGLE_APPLICATION_CREDENTIALS, or
// the metadata server when the backend runs on a Google VM.

const { GoogleAuth } = require('google-auth-library');

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// Vertex has three endpoint shapes, and the location is part of the hostname in all of them. The
// provider's API base URL is the single source of truth for it, so a database row and an
// environment variable can never disagree about where a call goes.
//
//   global        https://aiplatform.googleapis.com                -> global
//   multi-region  https://aiplatform.eu.rep.googleapis.com         -> eu
//   regional      https://europe-west1-aiplatform.googleapis.com   -> europe-west1
//
// Regional endpoints carry a 10% premium and serve Claude Sonnet 4.6 and older only; the newer
// Claude models are on the global and multi-region endpoints.
function regionFromBaseUrl(baseURL) {
  let hostname;
  try {
    ({ hostname } = new URL(String(baseURL)));
  } catch {
    throw new Error(`'${baseURL}' is not a valid Vertex AI base URL.`);
  }
  if (hostname === 'aiplatform.googleapis.com') return 'global';
  const multiRegion = /^aiplatform\.([a-z]+)\.rep\.googleapis\.com$/.exec(hostname);
  if (multiRegion) return multiRegion[1];
  const regional = /^([a-z0-9-]+)-aiplatform\.googleapis\.com$/.exec(hostname);
  if (regional) return regional[1];
  throw new Error(`'${hostname}' is not a Vertex AI endpoint.`);
}

// The project named in the environment, if any. Both adapters read the same two names; when
// neither is set the project is taken from the active credentials instead.
function configuredProjectId() {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.ANTHROPIC_VERTEX_PROJECT_ID || null;
}

// Resolves the project once and hands out access tokens. google-auth-library refreshes a token
// before it expires, so asking for one per request is the intended usage.
class VertexCredentials {
  constructor({ projectId, auth } = {}) {
    this.configuredProject = projectId || configuredProjectId();
    this.auth = auth || new GoogleAuth({ scopes: SCOPE });
    this.resolvedProject = null;
    this.clientPromise = null;
  }

  client() {
    this.clientPromise = this.clientPromise || this.auth.getClient();
    return this.clientPromise;
  }

  async project() {
    if (this.configuredProject) return this.configuredProject;
    if (!this.resolvedProject) {
      // Present on a service account file and on the metadata server; absent for a bare user login.
      this.resolvedProject = await this.auth.getProjectId().catch(() => null);
    }
    if (!this.resolvedProject) {
      throw new Error('Vertex AI needs a Google Cloud project: set GOOGLE_CLOUD_PROJECT.');
    }
    return this.resolvedProject;
  }

  async authHeaders() {
    const client = await this.client();
    const token = await client.getAccessToken();
    const value = typeof token === 'string' ? token : token?.token;
    if (!value) {
      throw new Error('Google Application Default Credentials returned no access token for Vertex AI.');
    }
    return { authorization: `Bearer ${value}` };
  }
}

module.exports = { regionFromBaseUrl, configuredProjectId, VertexCredentials, SCOPE };
