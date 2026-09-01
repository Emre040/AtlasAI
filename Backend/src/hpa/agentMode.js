'use strict';

// Decides whether an agent runs against the local HPA release or proteinatlas.org. A request
// for offline mode is honoured only when the platform allows it and every file the agent needs
// is ready; otherwise the agent runs online and says why.

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
    return { mode: 'online', note: 'Offline mode is disabled in the platform configuration; using proteinatlas.org.', hpaVersion: null };
  }
  const missing = await localData.missing(requiredFiles);
  if (missing.length > 0) {
    return { mode: 'online', note: `Local HPA data is not ready (${missing.join(', ')}); using proteinatlas.org.`, hpaVersion: null };
  }
  return { mode: 'offline', note: null, hpaVersion: config.activeHpaVersion };
}

module.exports = { resolveAgentMode, normalizeMode };
