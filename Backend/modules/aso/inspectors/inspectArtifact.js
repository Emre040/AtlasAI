'use strict';

const https = require('https');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function normalizeValue(v) {
  return String(v ?? '').trim().toLowerCase();
}

function applyFilters(rows, filters = {}) {
  const entries = Object.entries(filters || {}).filter(([k, v]) => v !== undefined && v !== null && String(v).trim() !== '');
  if (entries.length === 0) return rows;
  return rows.filter(row => {
    return entries.every(([key, val]) => {
      const rowVal = normalizeValue(row[key]);
      const cmp = normalizeValue(val);
      if (!rowVal) return false;
      return rowVal.includes(cmp);
    });
  });
}

function pickFields(row, fields) {
  if (!fields || fields.length === 0) return row;
  const out = {};
  for (const f of fields) {
    if (row[f] !== undefined) out[f] = row[f];
  }
  return out;
}

async function inspectSearchUrl(searchUrl, { fields = [], filters = {}, limit = 25 } = {}) {
  if (!searchUrl) return { rows: [], total: 0, limit };
  const url = searchUrl.includes('format=json') ? searchUrl : `${searchUrl}${searchUrl.includes('?') ? '&' : '?'}format=json&download=yes`;
  const raw = await httpGetJson(url);
  const rows = Array.isArray(raw) ? raw : (raw?.rows || []);
  const filtered = applyFilters(rows, filters);
  const slice = filtered.slice(0, Math.max(1, Math.min(limit || 25, 500))).map(r => pickFields(r, fields));
  return { rows: slice, total: filtered.length, limit };
}

module.exports = { inspectSearchUrl };
