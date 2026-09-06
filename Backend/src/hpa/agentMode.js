'use strict';

// The requested data source is a constraint. An unavailable local release is an error;
// it must never turn an offline request into network access.

const { platformConfig } = require('../policy/config');
const { localData } = require('./localData');

const MODES = new Set(['online', 'offline']);

function normalizeMode(value) {
  return MODES.has(value) ? value : null;
}

async function resolveAgentMode(requested, requiredFiles) {
  if (normalizeMode(requested) !== 'offline') return { mode: 'online', note: null, hpaVersion: null };
  const config = platformConfig();
  if (!config.offlineAgentsEnabled) {
    throw Object.assign(new Error('Offline mode is disabled in the platform configuration. No online request was made.'), { reason: 'offline_unavailable' });
  }
  const missing = await localData.missing(requiredFiles);
  if (missing.length > 0) {
    throw Object.assign(new Error(`Local HPA data is not ready (${missing.join(', ')}). No online request was made.`), { reason: 'offline_unavailable', missing_files: missing });
  }
  return { mode: 'offline', note: null, hpaVersion: config.activeHpaVersion };
}

module.exports = { resolveAgentMode, normalizeMode };
