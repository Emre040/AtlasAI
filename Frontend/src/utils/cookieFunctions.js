
export function getCookie(cookie_name) {
  const all = parseCookies();
  const val = all[cookie_name];
  if (val) {
    const [id] = val.split('|');
    return id;
  } else {
    return null;
  }
}

export function setCookie(cookie_name, id, expiryMs) {
  const value = `${id}|${expiryMs}`;
  document.cookie = `${cookie_name}=${value}; path=/; expires=${new Date(expiryMs).toUTCString()}; samesite=strict`;
}

export function parseCookies() {
  return Object.fromEntries(document.cookie.split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k, v.join('=')];
  }));
}
