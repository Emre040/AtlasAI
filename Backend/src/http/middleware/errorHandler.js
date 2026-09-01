'use strict';

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = typeof error?.code === 'string'
    ? error.code
    : (status >= 500 ? 'internal_server_error' : 'request_failed');

  if (status >= 500) {
    console.error('[HTTP_ERROR]', {
      code,
      method: req.method,
      path: req.path,
      message: error?.message || String(error)
    });
  }

  return res.status(status).json({ error: code });
}

module.exports = { errorHandler };
