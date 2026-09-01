'use strict';

function createAccessControlMiddleware(accessRules) {
  return async function accessControl(req, res, next) {
    try {
      const values = req.requestContext?.values || {};
      const rule = await accessRules.findEffective({
        visitorPublicId: req.auth?.visitorPublicId || null,
        ip: values.client_ip,
        asn: values.cf_asn,
        country: values.cf_country_code,
        ja3: values.cf_ja3_hash,
        ja4: values.cf_ja4_fingerprint
      });
      req.accessRule = rule;
      if (!rule || rule.action === 'allow' || rule.action === 'log') return next();
      if (rule.action === 'challenge') {
        return res.status(403).json({ error: 'challenge_required' });
      }
      return res.status(403).json({ error: 'access_denied' });
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { createAccessControlMiddleware };
