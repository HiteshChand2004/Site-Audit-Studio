// @ts-check
// The session cookie, the Origin check on requests that change something, and a small in-memory limiter for sign-in attempts.
//
// Cookie: HttpOnly, SameSite=Lax, Path=/, Secure from config (config/index.js cookieSecure). With Secure the name carries the
// __Host- prefix, which the browser only accepts for a Secure, Path=/ cookie with no Domain: no subdomain can set or shadow it.
import { cookieSecure, publicOrigin } from '../config/index.js';
import { SESSION_DAYS } from './store.js';

export const cookieName = () => (cookieSecure() ? '__Host-sas_session' : 'sas_session');

/** @param {import('express').Request} req */
export function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const name = cookieName();
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

const attrs = (maxAge) => ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(cookieSecure() ? ['Secure'] : []), `Max-Age=${maxAge}`].join('; ');

/** @param {import('express').Response} res @param {string} token */
export const setSessionCookie = (res, token) => res.append('Set-Cookie', `${cookieName()}=${token}; ${attrs(SESSION_DAYS * 86400)}`);

/** @param {import('express').Response} res */
export const clearSessionCookie = (res) => res.append('Set-Cookie', `${cookieName()}=; ${attrs(0)}`);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A request that changes something must come from the app itself. SameSite=Lax already keeps the cookie off a cross-site form
 * post; this refuses one whose Origin is another site's (a browser always sends Origin on such requests). Without an Origin
 * header (a script, curl) the request is let through: it carries no visitor's cookie by accident.
 * @type {import('express').RequestHandler}
 */
export function originCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (!origin) return site === 'cross-site' ? refuse(res) : next();
  const app = publicOrigin();
  // The app's address, its localhost / 127.0.0.1 twin (both reach a local dev server), and the address the request was sent to.
  const twin = app.includes('://localhost') ? app.replace('://localhost', '://127.0.0.1') : app.replace('://127.0.0.1', '://localhost');
  const allowed = new Set([app, twin, `${req.protocol}://${req.headers.host}`]);
  return allowed.has(String(origin).replace(/\/+$/, '')) ? next() : refuse(res);
}
const refuse = (res) => res.status(403).json({ error: 'This request did not come from the app.' });

/**
 * At most `max` events per key in `windowMs`. In memory: a restart forgets it, which is fine for one process (hosted: shared store).
 * @param {{ max: number, windowMs: number }} o
 */
export function limiter({ max, windowMs }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  const recent = (key) => (hits.get(key) ?? []).filter((t) => Date.now() - t < windowMs);
  return {
    /** Seconds until another try is allowed, or 0. */
    blocked(key) {
      const list = recent(key);
      hits.set(key, list);
      return list.length >= max ? Math.ceil((windowMs - (Date.now() - list[0])) / 1000) : 0;
    },
    hit(key) {
      const list = recent(key);
      list.push(Date.now());
      hits.set(key, list);
      if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((t) => Date.now() - t < windowMs)) hits.delete(k);
    },
    reset(key) { hits.delete(key); },
  };
}
