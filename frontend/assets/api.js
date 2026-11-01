// Shared helpers: runtime config, API calls, money formatting.
let configPromise;
export function getConfig() {
  configPromise ??= fetch('/config.json', { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error('Could not load site configuration');
    return r.json();
  });
  return configPromise;
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, token } = {}) {
  const { apiBase = '' } = await getConfig();
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('We could not reach the shop. Please check your connection and try again.', 0, 'NETWORK');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const ref = data.requestId ? ` (reference: ${data.requestId})` : '';
    throw new ApiError((data.error || data.message || 'Something went wrong') + ref, res.status, data.code);
  }
  return data;
}

export function money(cents, currency = 'usd') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const placeholderImage =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 50"><rect width="40" height="50" fill="#f6e3dc"/><path d="M20 18c-3-4-9-2-8 3 1 4 8 9 8 9s7-5 8-9c1-5-5-7-8-3z" fill="#b5543c" opacity=".5"/></svg>');
