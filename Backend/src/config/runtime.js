'use strict';

const fs = require('node:fs');
const path = require('node:path');

function requireString(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function requirePositiveInteger(name) {
  const value = Number(requireString(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function requireBoolean(name) {
  const value = requireString(name);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function requirePort(name) {
  const value = requirePositiveInteger(name);
  if (value > 65535) throw new Error(`${name} must be at most 65535.`);
  return value;
}

function requireOrigins(name, nodeEnv) {
  const values = requireString(name).split(',').map(value => value.trim());
  if (values.some(value => value === '' || value === '*')) {
    throw new Error(`${name} must contain explicit origins and cannot contain '*'.`);
  }

  const origins = values.map(value => {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} contains an invalid origin.`);
    }
    if (url.origin !== value || url.username || url.password) {
      throw new Error(`${name} entries must be origins without paths, credentials, query strings, or fragments.`);
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
    if (nodeEnv === 'production' && url.protocol !== 'https:' && !loopback) {
      throw new Error(`${name} must use HTTPS in production outside loopback.`);
    }
    return url.origin;
  });

  return Object.freeze([...new Set(origins)]);
}

function requireTrustProxy() {
  const value = requireString('TRUST_PROXY');
  if (value !== 'loopback') {
    throw new Error('TRUST_PROXY must be loopback for the local Cloudflare Tunnel topology.');
  }
  return value;
}

function requireAbsolutePath(name) {
  const value = requireString(name);
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.normalize(value);
}

function requireSecretFile(name) {
  const filePath = requireAbsolutePath(name);
  let contents;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('unsafe secret file');
    contents = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' });
  } catch {
    throw new Error(`${name} must reference a private readable file with mode 0600.`);
  }
  const match = contents.match(/^([a-f0-9]{64})\n?$/);
  if (!match) {
    throw new Error(`${name} must contain exactly one lowercase 256-bit hexadecimal secret.`);
  }
  return match[1];
}

function resolveBackendPath(name, backendRoot) {
  return path.resolve(backendRoot, requireString(name));
}

function loadRuntimeConfig(backendRoot) {
  const nodeEnv = requireString('NODE_ENV');
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }

  const jsonLimit = requireString('HPA_JSON_LIMIT');
  if (!/^\d+(?:b|kb|mb)$/i.test(jsonLimit)) {
    throw new Error('HPA_JSON_LIMIT must be an explicit byte, kb, or mb value.');
  }

  const cloudflareEnrichedHeaders = requireBoolean('ATLAS_CLOUDFLARE_ENRICHED_HEADERS');
  const cloudflareMetadataSecret = cloudflareEnrichedHeaders
    ? requireString('ATLAS_CLOUDFLARE_METADATA_SECRET')
    : null;
  if (cloudflareMetadataSecret && cloudflareMetadataSecret.length < 32) {
    throw new Error('ATLAS_CLOUDFLARE_METADATA_SECRET must contain at least 32 characters.');
  }

  const diagnostics = Object.freeze({
    sse: requireBoolean('HPA_SSE_DEBUG'),
    llmIo: requireBoolean('HPA_LOG_LLM_IO'),
    asoToolSteps: requireBoolean('HPA_ASO_LOG_TOOL_STEPS'),
    verbose: requireBoolean('ATLAS_VERBOSE_DIAGNOSTICS')
  });
  if (nodeEnv === 'production' && Object.values(diagnostics).some(Boolean)) {
    throw new Error('All diagnostic logging flags must be false in production.');
  }

  return Object.freeze({
    nodeEnv,
    appName: requireString('HPA_APP_NAME'),
    host: requireString('HPA_HOST'),
    port: requirePort('HPA_PORT'),
    trustProxy: requireTrustProxy(),
    jsonLimit,
    corsOrigins: requireOrigins('HPA_CORS_ORIGINS', nodeEnv),
    batchSecret: requireString('HPA_BATCH_SECRET'),
    globalRateLimit: Object.freeze({
      windowMs: requirePositiveInteger('ATLAS_GLOBAL_RATE_LIMIT_WINDOW_MS'),
      max: requirePositiveInteger('ATLAS_GLOBAL_RATE_LIMIT_MAX')
    }),
    deployment: Object.freeze({
      secret: requireSecretFile('ATLAS_DEPLOY_WEBHOOK_SECRET_FILE'),
      repository: requireString('ATLAS_DEPLOY_GITHUB_REPOSITORY'),
      repositoryRoot: requireAbsolutePath('ATLAS_DEPLOY_REPOSITORY_ROOT')
    }),
    providerKeySecret: requireSecretFile('ATLAS_PROVIDER_KEY_SECRET_FILE'),
    cloudflare: Object.freeze({
      enrichedHeaders: cloudflareEnrichedHeaders,
      metadataSecret: cloudflareMetadataSecret
    }),
    diagnostics,
    workspaceRoot: resolveBackendPath('HPA_ASO_WORKSPACES_DIR', backendRoot),
    dataLocalRoot: resolveBackendPath('HPA_DATA_LOCAL_DIR', backendRoot)
  });
}

module.exports = {
  loadRuntimeConfig,
  requireAbsolutePath,
  requirePositiveInteger,
  requireBoolean,
  requireString
};
