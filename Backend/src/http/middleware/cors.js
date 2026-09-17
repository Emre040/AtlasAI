'use strict';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// A page served from the machine making the request cannot be reached by anyone
// else, so a development frontend is allowed on any loopback port rather than
// listing each one. Every other origin must be named in HPA_CORS_ORIGINS.
function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.origin === origin && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function createCorsOptions(allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new TypeError('At least one explicit CORS origin is required.');
  }

  const allowlist = new Set(allowedOrigins);
  return {
    origin(origin, callback) {
      // Origin-less clients are outside the browser CORS security model. Route
      // authentication and rate limits still apply to them.
      if (!origin || allowlist.has(origin) || isLoopbackOrigin(origin)) return callback(null, true);

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
