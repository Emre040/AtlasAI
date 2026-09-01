'use strict';

function requireValue(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required.`);
  return value;
}

function requirePositiveInteger(name) {
  const value = Number(requireValue(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function requireBoolean(name) {
  const value = requireValue(name);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function loadSessionConfig() {
  const config = {
    accessTtlMs: requirePositiveInteger('ATLAS_AUTH_ACCESS_TTL_MS'),
    idleTtlMs: requirePositiveInteger('ATLAS_AUTH_IDLE_TTL_MS'),
    absoluteTtlMs: requirePositiveInteger('ATLAS_AUTH_ABSOLUTE_TTL_MS'),
    accessCookieName: requireValue('ATLAS_AUTH_ACCESS_COOKIE_NAME'),
    accessCookiePath: requireValue('ATLAS_AUTH_ACCESS_COOKIE_PATH'),
    refreshCookieName: requireValue('ATLAS_AUTH_REFRESH_COOKIE_NAME'),
    refreshCookiePath: requireValue('ATLAS_AUTH_REFRESH_COOKIE_PATH'),
    cookieSecure: requireBoolean('ATLAS_AUTH_COOKIE_SECURE'),
    cookieSameSite: requireValue('ATLAS_AUTH_COOKIE_SAME_SITE').toLowerCase(),
    cookiePartitioned: requireBoolean('ATLAS_AUTH_COOKIE_PARTITIONED')
  };

  if (config.accessTtlMs >= config.idleTtlMs) {
    throw new Error('ATLAS_AUTH_ACCESS_TTL_MS must be less than ATLAS_AUTH_IDLE_TTL_MS.');
  }
  if (config.idleTtlMs > config.absoluteTtlMs) {
    throw new Error('ATLAS_AUTH_IDLE_TTL_MS must not exceed ATLAS_AUTH_ABSOLUTE_TTL_MS.');
  }
  if (!['strict', 'lax', 'none'].includes(config.cookieSameSite)) {
    throw new Error('ATLAS_AUTH_COOKIE_SAME_SITE must be strict, lax, or none.');
  }
  if (!config.accessCookiePath.startsWith('/') || !config.refreshCookiePath.startsWith('/')) {
    throw new Error('Authentication cookie paths must be absolute.');
  }
  if (
    config.cookieSecure &&
    (!config.accessCookieName.startsWith('__Secure-') || !config.refreshCookieName.startsWith('__Secure-'))
  ) {
    throw new Error('Authentication cookie names must use the __Secure- prefix when secure cookies are enabled.');
  }
  if ((config.cookieSameSite === 'none' || config.cookiePartitioned) && !config.cookieSecure) {
    throw new Error('SameSite=None and Partitioned cookies require ATLAS_AUTH_COOKIE_SECURE=true.');
  }

  return Object.freeze(config);
}

module.exports = { loadSessionConfig, requirePositiveInteger };
