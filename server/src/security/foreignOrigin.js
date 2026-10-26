// @ts-check
// The API answers the app and nothing that merely shares its address. A sandboxed preview (recreate/previewRoute.js) is a
// document of ours with an opaque origin: its requests arrive with `Origin: null` and `Sec-Fetch-Site: cross-site`, as do
// requests any other site makes. Both are refused here for every method, before any session is read — so even if a browser
// ever sent a cookie with such a request, the API would not act on it. A request without these headers (a script, curl,
// the app's own same-origin requests, a typed address) passes; the session gate decides for it as before.
/** @type {import('express').RequestHandler} */
export function foreignOriginCheck(req, res, next) {
  if (req.headers.origin === 'null' || req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({ error: 'This request did not come from the app.' });
  }
  next();
}
