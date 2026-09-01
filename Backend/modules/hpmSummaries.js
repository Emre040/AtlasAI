'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');

const DEFAULT_PATH = path.join(__dirname, '..', 'runtime-data', 'hpm_summaries.json');

function createRouter(options = {}) {
  const filePath = options.path || process.env.HPM_SUMMARIES_PATH || DEFAULT_PATH;
  const router = express.Router();

  let DATA = {};
  let BY_SYMBOL = new Map();
  let loadedAt = null;
  let fileStats = null;

  function load() {
    const start = Date.now();
    fileStats = fs.statSync(filePath);
    DATA = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    BY_SYMBOL = new Map();
    let withSymbol = 0;
    for (const [key, record] of Object.entries(DATA)) {
      if (!record || typeof record !== 'object') continue;
      const sym = record.gene_symbol || record.symbol || record.gene_name;
      if (sym) {
        BY_SYMBOL.set(String(sym).toUpperCase(), key);
        withSymbol++;
      }
    }
    loadedAt = new Date();

    const keys = Object.keys(DATA);
    const sampleKey = keys[0];
    console.log(`[HPM] Loaded ${filePath}`);
    console.log(`[HPM]   File size:       ${(fileStats.size / (1024 * 1024)).toFixed(1)} MB`);
    console.log(`[HPM]   Records:         ${keys.length}`);
    console.log(`[HPM]   With symbol idx: ${withSymbol}`);
    console.log(`[HPM]   Sample key:      ${sampleKey}`);
    if (sampleKey && DATA[sampleKey] && typeof DATA[sampleKey] === 'object') {
      console.log(`[HPM]   Sample fields:   ${Object.keys(DATA[sampleKey]).join(', ')}`);
    }
    console.log(`[HPM]   Load time:       ${Date.now() - start} ms`);
  }

  load();

  router.get('/_stats', (req, res) => {
    res.json({
      ok: true,
      file: filePath,
      fileSizeBytes: fileStats ? fileStats.size : null,
      recordCount: Object.keys(DATA).length,
      symbolIndexSize: BY_SYMBOL.size,
      loadedAt: loadedAt ? loadedAt.toISOString() : null,
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024))
    });
  });

  router.get('/:key', (req, res) => {
    const key = req.params.key;
    if (!key) return res.status(400).json({ error: 'Missing key' });

    // Try as ENSG first, then fall back to symbol lookup (case-insensitive)
    let record = DATA[key];
    let resolvedId = key;
    if (!record) {
      const id = BY_SYMBOL.get(String(key).toUpperCase());
      if (id) {
        record = DATA[id];
        resolvedId = id;
      }
    }
    if (!record) return res.status(404).json({ error: 'Gene not found', key });

    res.set('Cache-Control', 'public, max-age=3600');
    // Ensure resolved id is visible even if record lacks it
    res.json({ gene_id: resolvedId, ...record });
  });

  return router;
}

module.exports = { createRouter };
