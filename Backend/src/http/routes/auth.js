'use strict';

const express = require('express');
const { AuthenticationError } = require('../../security/sessionService');
const { readCookie } = require('../../security/tokens');

function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}

function publicSessionPayload(session) {
  return {
    sessionId: session.sessionPublicId,
    visitorId: session.visitorPublicId,
    csrfToken: session.csrfToken,
    accessExpiresUnixMs: session.accessExpiresUnixMs,
    idleExpiresUnixMs: session.idleExpiresUnixMs,
    absoluteExpiresUnixMs: session.absoluteExpiresUnixMs
  };
}

function createRouter({ sessionService, requireAuthentication, requireCsrf, config }) {
  const router = express.Router();
  router.use(noStore);

  const cookieOptions = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    partitioned: config.cookiePartitioned,
    priority: 'high',
    path: config.refreshCookiePath
  };

  const accessCookieOptions = {
    ...cookieOptions,
    path: config.accessCookiePath
  };

  function setAccessCookie(res, session) {
    res.cookie(config.accessCookieName, session.accessToken, {
      ...accessCookieOptions,
      maxAge: Math.max(0, session.accessExpiresUnixMs - Date.now())
    });
  }

  function setRefreshCookie(res, session) {
    res.cookie(config.refreshCookieName, session.refreshToken, {
      ...cookieOptions,
      maxAge: Math.max(0, session.absoluteExpiresUnixMs - Date.now())
    });
  }

  function clearRefreshCookie(res) {
    res.clearCookie(config.refreshCookieName, cookieOptions);
  }

  function clearAccessCookie(res) {
    res.clearCookie(config.accessCookieName, accessCookieOptions);
  }

  router.post('/session', async (req, res, next) => {
    try {
      const session = await sessionService.createSession();
      req.auth = session;
      setAccessCookie(res, session);
      setRefreshCookie(res, session);
      return res.status(201).json(publicSessionPayload(session));
    } catch (error) {
      next(error);
    }
  });

  router.post('/refresh', async (req, res, next) => {
    try {
      const refreshToken = readCookie(req.headers.cookie, config.refreshCookieName);
      const csrfToken = req.headers['x-csrf-token'];
      const session = await sessionService.refreshSession(refreshToken, csrfToken);
      req.auth = session;
      setAccessCookie(res, session);
      setRefreshCookie(res, session);
      return res.json(publicSessionPayload(session));
    } catch (error) {
      if (error instanceof AuthenticationError) {
        clearRefreshCookie(res);
        clearAccessCookie(res);
        return res.status(401).json({ error: 'unauthorized' });
      }
      next(error);
    }
  });

  router.get('/session', requireAuthentication, (req, res) => {
    res.json({
      sessionId: req.auth.sessionPublicId,
      visitorId: req.auth.visitorPublicId,
      accessExpiresUnixMs: req.auth.accessExpiresUnixMs,
      idleExpiresUnixMs: req.auth.idleExpiresUnixMs,
      absoluteExpiresUnixMs: req.auth.absoluteExpiresUnixMs
    });
  });

  router.post('/logout', requireAuthentication, requireCsrf, async (req, res, next) => {
    try {
      await sessionService.revokeSession(req.auth.sessionId, 'logout');
      clearRefreshCookie(res);
      clearAccessCookie(res);
      return res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createRouter };
