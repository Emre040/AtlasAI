// Development only (create-react-app loads this file for `npm start`; builds ignore it).
// The dev server forwards the API to a local backend, so the browser sees one origin and the
// session cookies work. The browser's Origin header is passed through unchanged: the backend's
// CORS allowlist names the dev origin, and the built-in `proxy` field would have rewritten it.
const { createProxyMiddleware } = require('http-proxy-middleware');

const API_PATHS = ['/auth', '/conversations', '/query', '/models', '/keys', '/batch', '/workspaces', '/hpa-proxy', '/hpm', '/healthz'];

module.exports = function setupProxy(app) {
  const target = process.env.REACT_APP_LOCAL_BACKEND || 'http://localhost:8015';
  app.use(API_PATHS, createProxyMiddleware({ target, changeOrigin: false, ws: false, logLevel: 'warn' }));
};
