'use strict';

const express = require('express');

const TBL_COOKIES = process.env.HPA_TBL_COOKIES;

// --- Helper Functions ---
const tryParseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
const numOrNull = v => (v == null ? null : (isNaN(+v) ? null : +v));
function extractRequestMeta(req) {
    const h = req.headers || {};
    const realIp = h['cf-connecting-ip'] || (h['x-forwarded-for']?.split(',')[0]?.trim()) || req.ip || null;
    const cfMeta = { ipCountry: h['cf-ipcountry'] || null, asn: numOrNull(h['cf-asn']), ray: h['cf-ray'] || null };
    const clientMeta = { userAgent: h['user-agent'] || null, referer: h['referer'] || null };
    return { realIp, cfMeta, clientMeta };
}

exports.createRouter = function(db) {
    const router = express.Router();

    // The full URL will be POST /auth/cookie
    router.post('/cookie', async (req, res, next) => {
        try {
            const { cookieId } = req.body || {};
            if (!cookieId || typeof cookieId !== 'string' || !cookieId.trim()) {
                return res.status(400).json({ error: 'Missing or invalid cookieId.' });
            }
            const id = cookieId.trim();
            const { realIp, cfMeta, clientMeta } = extractRequestMeta(req);

            const sql = `
                INSERT INTO ?? (cookie_value, access_count, last_seen, last_ip, last_user_agent, cf_meta, client_meta)
                VALUES (?, 1, CURRENT_TIMESTAMP, ?, ?, CAST(? AS JSON), CAST(? AS JSON))
                ON DUPLICATE KEY UPDATE
                  access_count = access_count + 1, last_seen = CURRENT_TIMESTAMP, last_ip = VALUES(last_ip),
                  last_user_agent = VALUES(last_user_agent),
                  cf_meta = COALESCE(JSON_MERGE_PATCH(cf_meta, VALUES(cf_meta)), VALUES(cf_meta)),
                  client_meta = COALESCE(JSON_MERGE_PATCH(client_meta, VALUES(client_meta)), VALUES(client_meta));
            `;
            await db.query(sql, [TBL_COOKIES, id, realIp, clientMeta.userAgent, JSON.stringify(cfMeta), JSON.stringify(clientMeta)]);
            res.status(200).json({ message: 'Cookie tracked.', cookieId: id });
        } catch (err) {
            next(err);
        }
    });

    router.get('/check', (req, res) => {
        const cookieId = String(req.query?.cookieId || '').trim();
        if (!cookieId) return res.status(400).json({ error: 'Missing cookieId.' });
        res.json({ ok: true, cookieId });
    });

    return router;
};
