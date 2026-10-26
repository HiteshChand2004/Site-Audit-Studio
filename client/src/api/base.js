// Where the API is. Every request, stream, download and picture URL the app builds goes through here, so moving the API (a
// hosted address, a prefix) is one line. VITE_API_BASE overrides it at build time.
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/+$/, '');

/** An API path ('/projects/x') as a URL the browser can load. */
export const apiUrl = (path) => `${API_BASE}${path}`;

/**
 * A URL the server built with its own '/api/…' prefix (screenshots in a stored audit), moved onto API_BASE. Anything else is
 * returned as it is.
 */
export const fromServerUrl = (url) => (typeof url === 'string' && url.startsWith('/api/') ? `${API_BASE}${url.slice(4)}` : url);

// Where the marketing site's sign-in page is (same origin, scripts/local.mjs). Used when the API says the session is gone.
export const SIGN_IN_URL = '/auth';

/** Sends the visitor to sign in (or to finish verifying), coming back to where they were. */
export function goToSignIn(reason) {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`${SIGN_IN_URL}?mode=signin${reason === 'verify' ? '&verify=1' : ''}&next=${encodeURIComponent(next)}`);
}
