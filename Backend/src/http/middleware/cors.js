'use strict';

function createCorsOptions(allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new TypeError('At least one explicit CORS origin is required.');
  }

  const allowlist = new Set(allowedOrigins);
  return {
    origin(origin, callback) {
      // Origin-less clients are outside the browser CORS security model. Route
      // authentication and rate limits still apply to them.
      if (!origin || allowlist.has(origin)) return callback(null, true);

      const error = new Error('CORS origin denied.');
      error.status = 403;
      error.code = 'cors_origin_denied';
      return callback(error);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Accept',
      'Authorization',
      'Cache-Control',
      'Content-Type',
      'X-Batch-Secret',
      'X-CSRF-Token'
    ],
    exposedHeaders: ['RateLimit', 'RateLimit-Policy', 'Retry-After'],
    maxAge: 600,
    optionsSuccessStatus: 204
  };
}

module.exports = { createCorsOptions };
