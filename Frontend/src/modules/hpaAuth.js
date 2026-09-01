import { getApiEndpoint } from './hpaConfig';

const STORAGE_KEY = 'atlas-auth-session';
const EXPIRY_SKEW_MS = 10_000;
let session = readStoredSession();
let pendingAuthentication = null;
let pendingForceRefresh = false;

class AuthRequestError extends Error {
  constructor(status) {
    super(`Authentication request failed with HTTP ${status}.`);
    this.status = status;
  }
}

function validSession(value) {
  return Boolean(
    value &&
    typeof value.sessionId === 'string' &&
    typeof value.visitorId === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value.csrfToken || '') &&
    Number.isFinite(value.accessExpiresUnixMs) &&
    Number.isFinite(value.idleExpiresUnixMs) &&
    Number.isFinite(value.absoluteExpiresUnixMs)
  );
}

function readStoredSession() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    return validSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeSession(nextSession) {
  if (!validSession(nextSession)) throw new Error('Backend returned an invalid authentication session.');
  session = nextSession;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
  return session;
}

function clearSession() {
  session = null;
  window.localStorage.removeItem(STORAGE_KEY);
}

window.addEventListener('storage', event => {
  if (event.key === STORAGE_KEY) session = readStoredSession();
});

async function parseSessionResponse(response) {
  if (!response.ok) throw new AuthRequestError(response.status);
  return storeSession(await response.json());
}

async function createSession() {
  const response = await fetch(getApiEndpoint('authSession'), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' }
  });
  return parseSessionResponse(response);
}

async function refreshSession() {
  if (!session?.csrfToken) throw new AuthRequestError(401);
  const response = await fetch(getApiEndpoint('authRefresh'), {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'X-CSRF-Token': session.csrfToken
    }
  });
  return parseSessionResponse(response);
}

async function establishSession({ forceRefresh = false, failedCsrfToken = null } = {}) {
  session = readStoredSession();
  if (forceRefresh && failedCsrfToken && session?.csrfToken !== failedCsrfToken) {
    return session;
  }
  if (
    !forceRefresh &&
    session &&
    session.accessExpiresUnixMs > Date.now() + EXPIRY_SKEW_MS
  ) {
    return session;
  }

  try {
    return await refreshSession();
  } catch (error) {
    if (!(error instanceof AuthRequestError) || error.status !== 401) throw error;
    clearSession();
    return createSession();
  }
}

function coordinateAuthentication(options) {
  if (!window.navigator.locks?.request) return establishSession(options);
  return window.navigator.locks.request(STORAGE_KEY, () => establishSession(options));
}

export function initializeHPAAuth(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  if (pendingAuthentication && forceRefresh && !pendingForceRefresh) {
    return pendingAuthentication.then(() => initializeHPAAuth(options));
  }
  if (!pendingAuthentication) {
    pendingForceRefresh = forceRefresh;
    pendingAuthentication = coordinateAuthentication(options).finally(() => {
      pendingAuthentication = null;
      pendingForceRefresh = false;
    });
  }
  return pendingAuthentication;
}

export function getVisitorId() {
  return session?.visitorId || null;
}

export async function authenticatedFetch(url, options = {}) {
  await initializeHPAAuth();

  const execute = () => {
    const headers = new Headers(options.headers || {});
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers.set('X-CSRF-Token', session.csrfToken);
    }
    headers.set('Accept', headers.get('Accept') || 'application/json');
    return fetch(url, { ...options, method, headers, credentials: 'include' });
  };

  let response = await execute();
  if (response.status === 401) {
    await initializeHPAAuth({ forceRefresh: true, failedCsrfToken: session?.csrfToken });
    response = await execute();
  } else if (response.status === 403) {
    const payload = await response.clone().json().catch(() => null);
    if (payload?.error === 'invalid_csrf') {
      await initializeHPAAuth({ forceRefresh: true, failedCsrfToken: session?.csrfToken });
      response = await execute();
    }
  }
  return response;
}

export async function authenticatedDownload(url, filename) {
  const response = await authenticatedFetch(url);
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);

  const safeFilename = String(filename || 'download').replace(/[^A-Za-z0-9_.-]/g, '_');
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = safeFilename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
