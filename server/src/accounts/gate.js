// @ts-check
// The gate in front of every /api route but /api/auth and /api/health, while SAS_ACCOUNTS=1 (src/index.js): no session → 401,
// an unverified account → 403. Either answer carries `auth: 'signin' | 'verify'`, so the app can send the person to the right
// screen. Everything the app loads goes through /api — SSE streams, screenshots, captures, downloads, reports — and carries the
// cookie, so nothing is reachable around it. The signed-in user is req.user.
import { readSessionCookie } from './http.js';
import { sessionFor } from './store.js';

/** The visitor's session and user, or null. Read once per request. @param {import('express').Request & { _sas?: any }} req */
export function currentSession(req) {
  if (req._sas === undefined) req._sas = sessionFor(readSessionCookie(req));
  return req._sas;
}

/**
 * Who may pass: signed in and verified.
 * @param {import('express').Request} req
 * @returns {null | 'signin' | 'verify'}  null = may pass
 */
export function gateReason(req) {
  const s = currentSession(req);
  if (!s) return 'signin';
  if (!s.user.email_verified_at) return 'verify';
  return null;
}

/** @type {import('express').RequestHandler} */
export function apiGate(req, res, next) {
  const reason = gateReason(req);
  if (reason === 'signin') return res.status(401).json({ error: 'Sign in to continue.', auth: 'signin' });
  if (reason === 'verify') return res.status(403).json({ error: 'Verify your email address to continue.', auth: 'verify' });
  /** @type {any} */ (req).user = currentSession(req).user;
  next();
}
