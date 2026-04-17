'use strict';

const express = require('express');

const TBL_COOKIES = process.env.HPA_TBL_COOKIES;
const TBL_CONV = process.env.HPA_TBL_CONVERSATIONS;
const TBL_MSG  = process.env.HPA_TBL_MESSAGES;
const ADMIN_USER = process.env.HPA_ADMIN_USERNAME;
const ADMIN_PASS = process.env.HPA_ADMIN_PASSWORD;

function requireAdminEnv() {
  if (!ADMIN_USER || !ADMIN_PASS) {
    throw new Error('Admin credentials (HPA_ADMIN_USERNAME / HPA_ADMIN_PASSWORD) must be configured.');
  }
}

function basicAuth(req, res, next) {
  requireAdminEnv();
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="HPA Admin"');
    return res.status(401).send('Unauthorized');
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="HPA Admin"');
    return res.status(401).send('Unauthorized');
  }
  next();
}

exports.createRouter = function(db) {
  const router = express.Router();

  router.get('/summary', basicAuth, async (req, res, next) => {
    try {
      const [totals] = await db.query(
        `SELECT
           COUNT(DISTINCT cookie_value) AS cookies,
           COUNT(*) AS conversations
         FROM ??
        `, [TBL_CONV]
      );
      const [messages] = await db.query(
        `SELECT
           COUNT(*) AS message_count,
           SUM(token_count) AS total_tokens
         FROM ??
        `, [TBL_MSG]
      );
      res.json({
        cookies: totals?.[0]?.cookies || 0,
        conversations: totals?.[0]?.conversations || 0,
        messages: messages?.[0]?.message_count || 0,
        tokens: messages?.[0]?.total_tokens || 0
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/geo', basicAuth, async (req, res, next) => {
    try {
      const [rows] = await db.query(
        `SELECT
           JSON_EXTRACT(cf_meta, '$.ipCountry') AS country,
           COUNT(*) AS sessions
         FROM ??
         GROUP BY country
        `, [TBL_COOKIES]
      );
      const formatted = rows.map(r => ({
        country: (r.country || '').replace(/"/g, '') || 'UNKNOWN',
        sessions: r.sessions
      }));
      res.json({ points: formatted });
    } catch (err) {
      next(err);
    }
  });

  router.get('/cookies', basicAuth, async (req, res, next) => {
    try {
      const [rows] = await db.query(
        `SELECT
           cookie_value,
           access_count,
           last_seen,
           last_ip,
           last_user_agent,
           block_fingerprint,
           block_ip,
           JSON_UNQUOTE(JSON_EXTRACT(cf_meta, '$.ipCountry')) AS country
         FROM ??
         ORDER BY last_seen DESC
         LIMIT 50
        `, [TBL_COOKIES]
      );
      res.json({ cookies: rows || [] });
    } catch (err) {
      next(err);
    }
  });

  router.post('/block', basicAuth, async (req, res, next) => {
    try {
      const { cookieId, action } = req.body || {};
      if (!cookieId || !action) return res.status(400).json({ error: 'cookieId and action are required.' });

      const actions = {
        block_fingerprint: { column: 'block_fingerprint', value: 1 },
        unblock_fingerprint: { column: 'block_fingerprint', value: 0 },
        block_ip: { column: 'block_ip', value: 1 },
        unblock_ip: { column: 'block_ip', value: 0 }
      };
      const cfg = actions[action];
      if (!cfg) return res.status(400).json({ error: 'Invalid action.' });

      const sql = `UPDATE ?? SET ${cfg.column} = ? WHERE cookie_value = ? LIMIT 1`;
      await db.query(sql, [TBL_COOKIES, cfg.value, cookieId]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
