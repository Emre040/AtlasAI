'use strict';

import { getApiEndpoint } from './hpaConfig';

const COOKIE_NAME = 'hpacookie';
let HPA_COOKIE_ID = null; 
function parseCookies() {
  return Object.fromEntries(document.cookie.split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k, v.join('=')];
  }));
}

function setCookie(id, expiryMs) {
  const value = `${id}|${expiryMs}`;
  document.cookie = `${COOKIE_NAME}=${value}; path=/; expires=${new Date(expiryMs).toUTCString()}; samesite=strict`;
}

function notifyBackend(id) {
  if (!id) return;
  fetch(getApiEndpoint('webserverCookie'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookieId: id })
  }).catch((err) => {
    console.error('hpa-cookie notification error', err);
  });
}


export function initializeHPACookie() {
  if (HPA_COOKIE_ID) {
    return HPA_COOKIE_ID;
  }

  const all = parseCookies();
  const val = all[COOKIE_NAME];

  if (val) {
    const [id] = val.split('|');
    HPA_COOKIE_ID = id;
    notifyBackend(id);
    return id;
  }

  const id = Math.random().toString(36).substring(2, 10);
  const expiry = Date.now() + 180 * 24 * 60 * 60 * 1000;
  setCookie(id, expiry);
  HPA_COOKIE_ID = id;
  notifyBackend(id); 
  return id;
}

export function getCookieId() {
  if (!HPA_COOKIE_ID) {
    const all = parseCookies();
    const val = all[COOKIE_NAME];
    if (val) {
      const [id] = val.split('|');
      HPA_COOKIE_ID = id;
    } else {
        return initializeHPACookie();
    }
  }
  return HPA_COOKIE_ID;
}