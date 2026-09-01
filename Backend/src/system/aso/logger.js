'use strict';

// Writes structured ASO workspace logs.

const fs = require('fs');
const { promisify } = require('util');
const appendFile = promisify(fs.appendFile);
const writeFile = promisify(fs.writeFile);

const DEFAULT_LIMITS = {
  maxString: 500,
  maxArray: 20,
  maxKeys: 40,
  maxDepth: 4
};

function sanitize(value, limits = DEFAULT_LIMITS, depth = 0) {
  const { maxString, maxArray, maxKeys, maxDepth } = limits;

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length <= maxString) return value;
    return `${value.slice(0, maxString)}…`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const trimmed = value.slice(0, maxArray).map(v => sanitize(v, limits, depth + 1));
    if (value.length > maxArray) {
      trimmed.push({ _truncated: value.length - maxArray });
    }
    return trimmed;
  }
  if (typeof value === 'object') {
    if (depth >= maxDepth) return '[Object]';
    const keys = Object.keys(value);
    const out = {};
    for (const k of keys.slice(0, maxKeys)) {
      out[k] = sanitize(value[k], limits, depth + 1);
    }
    if (keys.length > maxKeys) {
      out._truncated_keys = keys.length - maxKeys;
    }
    return out;
  }
  return String(value);
}

function createLogger(logPath, options = {}) {
  const limits = options.limits || DEFAULT_LIMITS;
  const prettyPath = options.prettyPath || null;
  const prettyFormatter = options.prettyFormatter || null;
  let seq = 0;
  let prettyInit = false;
  let prettyClosed = false;
  let queue = Promise.resolve();

  const writePretty = async (payload) => {
    if (!prettyPath) return;
    const formatted = prettyFormatter ? prettyFormatter(payload) : payload;
    if (formatted === null || formatted === undefined) return;
    if (!prettyInit) {
      await writeFile(prettyPath, '[\n');
      prettyInit = true;
    } else {
      await appendFile(prettyPath, ',\n');
    }
    await appendFile(prettyPath, JSON.stringify(formatted, null, 2));
  };

  const logEvent = async ({ level = 'info', event = 'log', data = null, meta = null } = {}) => {
    const payload = {
      unix_ms: Date.now(),
      seq: seq++,
      event,
      data: sanitize(data, limits)
    };
    queue = queue.then(async () => {
      await appendFile(logPath, JSON.stringify(payload) + '\n');
      await writePretty(payload);
    });
    return queue;
  };

  // Backwards-compatible shim
  const log = async (event = {}) => {
    const name = event.stage
      ? `${event.stage}.${event.action || 'log'}`
      : (event.action || 'log');
    return logEvent({
      level: event.level || 'info',
      event: name,
      data: event.summary || null,
      meta: event.meta || null
    });
  };

  const close = async () => {
    queue = queue.then(async () => {
      if (!prettyPath || !prettyInit || prettyClosed) return;
      await appendFile(prettyPath, '\n]\n');
      prettyClosed = true;
    });
    return queue;
  };

  return { logEvent, log, close };
}

module.exports = { createLogger };
