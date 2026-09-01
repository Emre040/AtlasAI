'use strict';

const { readBearerToken, readCookie, tokenHashMatches } = require('../../security/tokens');

function createAuthenticationMiddleware(sessionService, config) {
  async function optionalAuthentication(req, res, next) {
    try {
      const authorization = req.headers.authorization;
      let accessToken;
      let transport;
      if (authorization) {
        if (!/^Bearer\s/i.test(authorization)) return next();
        accessToken = readBearerToken(authorization);
        transport = 'bearer';
        if (!accessToken) return res.status(401).json({ error: 'unauthorized' });
      } else {
        accessToken = readCookie(req.headers.cookie, config.accessCookieName);
        transport = 'cookie';
        if (!accessToken) return next();
      }

      const auth = await sessionService.authenticateAccessToken(accessToken);
      if (!auth) {
        if (transport === 'cookie') return next();
        return res.status(401).json({ error: 'unauthorized' });
      }

      req.auth = { ...auth, transport };
      next();
    } catch (error) {
      next(error);
    }
  }

  function requireAuthentication(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'unauthorized' });
    return next();
  }

  function requireCsrf(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'unauthorized' });
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.auth.transport === 'bearer') return next();
    if (!tokenHashMatches(req.headers['x-csrf-token'], req.auth.csrfTokenHash, 'CSRF token')) {
      return res.status(403).json({ error: 'invalid_csrf' });
    }
    return next();
  }

  return { optionalAuthentication, requireAuthentication, requireCsrf };
}

module.exports = { createAuthenticationMiddleware };
