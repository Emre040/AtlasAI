'use strict';

const express = require('express');
const https = require('https');

/**
 * Fetch HPA search results as JSON
 * HPA supports ?format=json&download=yes on search URLs
 */
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

function httpGetHtml(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow redirects (301, 302, 307, 308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.proteinatlas.org${res.headers.location}`;
        console.log('[HPA_PROXY] Following redirect:', redirectUrl);
        return httpGetHtml(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
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
  console.log('[HPA_PROXY] Parsing thumbnails for:', fullId);

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

  console.log('[HPA_PROXY] Found thumbnails:', Object.keys(thumbnails).filter(k => thumbnails[k]?.img).join(', '));
  return thumbnails;
}

async function fetchHpaSearchResults(searchUrl) {
  // HPA's ?format=json&download=yes returns ALL results at once (not paginated)
  const url = searchUrl + '?format=json&download=yes';

  console.log('[HPA_PROXY] Fetching:', url);

  const data = await httpGetJson(url);
  const rows = Array.isArray(data) ? data : (data?.rows || []);

  console.log('[HPA_PROXY] Got', rows.length, 'rows');
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
      console.error('[HPA_PROXY] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Fetch thumbnails for a single gene
  router.get('/gene-thumbnails', async (req, res) => {
    try {
      const { ensg } = req.query;
      if (!ensg) {
        return res.status(400).json({ error: 'ensg parameter required' });
      }

      const url = `https://www.proteinatlas.org/${ensg}`;
      console.log('[HPA_PROXY] Fetching gene page:', url);

      const html = await httpGetHtml(url);
      const thumbnails = parseGeneThumbnails(html, ensg);

      res.json({ ensg, thumbnails });
    } catch (err) {
      console.error('[HPA_PROXY] Gene thumbnails error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Batch fetch thumbnails for multiple genes (up to 10)
  router.get('/gene-thumbnails-batch', async (req, res) => {
    try {
      const { genes } = req.query;
      if (!genes) {
        return res.status(400).json({ error: 'genes parameter required' });
      }

      const geneList = genes.split(',').slice(0, 10); // Max 10 at a time
      const results = {};

      await Promise.all(geneList.map(async (ensg) => {
        try {
          const url = `https://www.proteinatlas.org/${ensg}`;
          const html = await httpGetHtml(url);
          results[ensg] = parseGeneThumbnails(html, ensg);
        } catch (err) {
          console.error(`[HPA_PROXY] Failed to fetch ${ensg}:`, err.message);
          results[ensg] = null;
        }
      }));

      res.json(results);
    } catch (err) {
      console.error('[HPA_PROXY] Batch thumbnails error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createRouter, fetchHpaSearchResults };
