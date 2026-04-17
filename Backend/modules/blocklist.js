'use strict';

const TBL_COOKIES = process.env.HPA_TBL_COOKIES;
const REFRESH_MS = parseInt(process.env.HPA_BLOCKLIST_REFRESH_MS || '10000', 10);

const getClientIp = (req) => {
  const hdr = req.headers || {};
  return (
    hdr['cf-connecting-ip'] ||
    (hdr['x-forwarded-for']?.split(',')[0]?.trim()) ||
    req.ip ||
    null
  );
};

class BlocklistService {
  constructor(db, { refreshMs = REFRESH_MS } = {}) {
    this.db = db;
    this.refreshMs = refreshMs;
    this.blockedIps = new Set();
    this.blockedFingerprints = new Set();
    this.stopped = false;

    if (!TBL_COOKIES) {
      console.warn('[Blocklist] HPA_TBL_COOKIES not configured. Blocking disabled.');
      this.disabled = true;
      return;
    }

    if (db.mode === 'memory') {
      console.warn('[Blocklist] Memory DB detected. Blocking disabled.');
      this.disabled = true;
      return;
    }

    this.disabled = false;
    this.refresh().catch(err => console.error('[Blocklist] initial refresh failed:', err?.message || err));
    this.timer = setInterval(() => {
      this.refresh().catch(err => console.error('[Blocklist] refresh failed:', err?.message || err));
    }, this.refreshMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.stopped = true;
  }

  async refresh() {
    if (this.disabled || this.stopped) return;
    const [rows] = await this.db.query(
      `SELECT cookie_value, last_ip, last_user_agent, block_fingerprint, block_ip
         FROM ??
        WHERE block_fingerprint = 1 OR block_ip = 1`,
      [TBL_COOKIES]
    );

    const nextIps = new Set();
    const nextFingerprints = new Set();

    (rows || []).forEach(row => {
      if (row.block_ip && row.last_ip) {
        nextIps.add(row.last_ip);
      }
      if (row.block_fingerprint && row.cookie_value) {
        const fingerprintKey = this.buildFingerprintKey({
          cookieId: row.cookie_value,
          ip: row.last_ip,
          userAgent: row.last_user_agent
        });
        if (fingerprintKey) nextFingerprints.add(fingerprintKey);
      }
    });

    this.blockedIps = nextIps;
    this.blockedFingerprints = nextFingerprints;
    console.log(`[Blocklist] refreshed: ${nextIps.size} IPs, ${nextFingerprints.size} fingerprints.`);
  }

  buildFingerprintKey({ cookieId, ip, userAgent }) {
    if (!cookieId) return null;
    return `${cookieId}||${ip || ''}||${userAgent || ''}`;
  }

  middleware() {
    if (this.disabled) return (req, res, next) => next();

    return (req, res, next) => {
      const ip = getClientIp(req);
      if (ip && this.blockedIps.has(ip)) {
        return res.status(403).json({ error: 'blocked_ip' });
      }

      const cookieId = req.body?.cookieId || req.query?.cookieId || req.headers['x-cookie-id'] || null;
      if (cookieId) {
        const userAgent = req.headers['user-agent'] || '';
        const fingerprintKey = this.buildFingerprintKey({ cookieId, ip, userAgent });
        if (fingerprintKey && this.blockedFingerprints.has(fingerprintKey)) {
          return res.status(403).json({ error: 'blocked_fingerprint' });
        }
      }
      next();
    };
  }
}

module.exports = { BlocklistService };
