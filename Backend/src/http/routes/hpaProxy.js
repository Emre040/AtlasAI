'use strict';

// Narrow proxy for allowlisted Human Protein Atlas endpoints.

const express = require('express');
const https = require('https');

const HPA_HOST = 'www.proteinatlas.org';
const JSON_LIMIT_BYTES = 64 * 1024 * 1024;
const HTML_LIMIT_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;

function requireHpaUrl(value, { searchOnly = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Invalid HPA URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== HPA_HOST ||
    url.port ||
    url.username ||
    url.password ||
    (searchOnly && !url.pathname.startsWith('/search/'))
  ) {
    throw new TypeError('URL is not an allowlisted HPA URL.');
  }
  return url;
}

function readResponse(url, { parseJson, maxBytes, redirects = 0 }) {
  const safeUrl = requireHpaUrl(url);
  return new Promise((resolve, reject) => {
    const request = https.get(safeUrl, response => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location &&
        redirects > 0
      ) {
        response.resume();
        const redirectUrl = new URL(response.headers.location, safeUrl);
        try {
          requireHpaUrl(redirectUrl);
        } catch (error) {
          reject(error);
          return;
        }
        readResponse(redirectUrl, { parseJson, maxBytes, redirects: redirects - 1 })
          .then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HPA returned HTTP ${response.statusCode}.`));
        return;
      }

      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          request.destroy(new Error('HPA response exceeded the configured size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(parseJson ? JSON.parse(text) : text);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('HPA request timed out.')));
    request.on('error', reject);
  });
}

/**
 * Fetch HPA search results as JSON
 * HPA supports ?format=json&download=yes on search URLs
 */
function httpGetJson(url) {
  return readResponse(url, { parseJson: true, maxBytes: JSON_LIMIT_BYTES });
}

function httpGetHtml(url, maxRedirects = 3) {
  return readResponse(url, { parseJson: false, maxBytes: HTML_LIMIT_BYTES, redirects: maxRedirects });
}

/**
 * Parse gene page HTML to extract tabrow thumbnails
 * Returns object with section -> { img, link, title }
 */
function parseGeneThumbnails(html, ensgId) {
  const thumbnails = {};
  const sections = ['tissue', 'brain', 'single+cell', 'subcellular', 'cancer', 'blood', 'cell+line', 'structure', 'interaction'];

  // Extract the full gene ID (e.g., ENSG00000121410-A1BG) from the HTML
  const fullIdMatch = html.match(new RegExp(`(${ensgId}-[A-Z0-9]+)`, 'i'));
  const fullId = fullIdMatch ? fullIdMatch[1] : ensgId;

  for (const section of sections) {
    // Match the <a> tag for this section - handle ENSG-GeneName format
    // Escape + in section names (single+cell, cell+line) for regex
    const escapedSection = section.replace(/\+/g, '\\+');
    const linkPattern = new RegExp(`<a[^>]+href="/${fullId}/${escapedSection}"[^>]*>([\\s\\S]*?)</a>`, 'i');
    const linkMatch = html.match(linkPattern);

    if (linkMatch) {
      const block = linkMatch[0]; // Use full match including the <a> tag for title extraction
      const innerBlock = linkMatch[1];

      // Extract all URLs from background-image (there can be two: white.gif and the actual image)
      const bgMatch = innerBlock.match(/background-image:[^;]*/i);
      let imgUrl = null;

      if (bgMatch) {
        // Find all url() in the background-image
        const urlMatches = bgMatch[0].match(/url\(['"]?([^'")\s]+)['"]?\)/gi);
        if (urlMatches) {
          for (const urlMatch of urlMatches) {
            const extracted = urlMatch.match(/url\(['"]?([^'")\s]+)['"]?\)/i);
            if (extracted && extracted[1] && !extracted[1].includes('white.gif')) {
              imgUrl = extracted[1];
              break;
            }
          }
        }
      }

      // Fix relative URLs
      if (imgUrl) {
        if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
        else if (imgUrl.startsWith('/')) imgUrl = 'https://www.proteinatlas.org' + imgUrl;
      }

      // Extract title
      const titleMatch = block.match(/title="([^"]+)"/i);

      // Normalize section name
      const sectionKey = section.replace(/\+/g, '_');
      thumbnails[sectionKey] = {
        img: imgUrl,
        link: `https://www.proteinatlas.org/${fullId}/${section}`,
        title: titleMatch ? titleMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, ' ').trim() : null
      };
    }
  }

  return thumbnails;
}

async function fetchHpaSearchResults(searchUrl) {
  // HPA's ?format=json&download=yes returns ALL results at once (not paginated)
  const url = requireHpaUrl(searchUrl, { searchOnly: true });
  url.searchParams.set('format', 'json');
  url.searchParams.set('download', 'yes');

  const data = await httpGetJson(url);
  const rows = Array.isArray(data) ? data : (data?.rows || []);
  return rows;
}

/**
 * Create Express router for HPA proxy endpoints
 */
function createRouter() {
  const router = express.Router();

  router.get('/search-results', async (req, res) => {
    try {
      const { url } = req.query;

      if (!url) {
        return res.status(400).json({ error: 'url parameter required' });
      }

      // HPA JSON download returns complete result set in one request
      const rows = await fetchHpaSearchResults(url);

      res.json({
        rows,
        totalCount: rows.length
      });
    } catch (err) {
      if (err instanceof TypeError) return res.status(400).json({ error: 'invalid_hpa_url' });
      console.error('[HPA_PROXY] Search request failed:', err?.message || err);
      return res.status(502).json({ error: 'hpa_upstream_failed' });
    }
  });

  // Fetch thumbnails for a single gene
  router.get('/gene-thumbnails', async (req, res) => {
    try {
      const { ensg } = req.query;
      if (!/^ENSG\d{11}$/i.test(String(ensg || ''))) {
        return res.status(400).json({ error: 'ensg parameter required' });
      }

      const normalizedEnsg = String(ensg).toUpperCase();
      const url = `https://${HPA_HOST}/${normalizedEnsg}`;

      const html = await httpGetHtml(url);
      const thumbnails = parseGeneThumbnails(html, normalizedEnsg);

      res.json({ ensg: normalizedEnsg, thumbnails });
    } catch (err) {
      console.error('[HPA_PROXY] Gene thumbnails request failed:', err?.message || err);
      res.status(502).json({ error: 'hpa_upstream_failed' });
    }
  });

  // Batch fetch thumbnails for multiple genes (up to 10)
  router.get('/gene-thumbnails-batch', async (req, res) => {
    try {
      const { genes } = req.query;
      if (!genes) {
        return res.status(400).json({ error: 'genes parameter required' });
      }

      const geneList = [...new Set(genes.split(',').map(gene => gene.trim().toUpperCase()))].slice(0, 10);
      if (geneList.some(gene => !/^ENSG\d{11}$/.test(gene))) {
        return res.status(400).json({ error: 'invalid_ensg' });
      }
      const results = {};

      await Promise.all(geneList.map(async (ensg) => {
        try {
          const url = `https://${HPA_HOST}/${ensg}`;
          const html = await httpGetHtml(url);
          results[ensg] = parseGeneThumbnails(html, ensg);
        } catch (err) {
          console.error(`[HPA_PROXY] Failed to fetch ${ensg}:`, err.message);
          results[ensg] = null;
        }
      }));

      res.json(results);
    } catch (err) {
      console.error('[HPA_PROXY] Batch thumbnails request failed:', err?.message || err);
      res.status(502).json({ error: 'hpa_upstream_failed' });
    }
  });

  return router;
}

module.exports = { createRouter, fetchHpaSearchResults };
