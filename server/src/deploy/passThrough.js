// @ts-check
// Go live, Step 3: the parts of a website the copy does not have — its login, its dashboard, its data calls (/api/…) — keep being
// answered by the old app once the domain points to the copy. The owner gives the old app a second address (app.example.com,
// still on the old server) and the paths that belong to it; every deploy then starts the site's _redirects with one rule per
// path that sends it to that address (Netlify: status 200 = it is fetched from there and shown at the same address, "!" = even
// where the copy has a file of that name). Kept per website in <projectDir>/golive.json, beside its copies (cleanup never
// touches it), so no database change is needed.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from '../config/paths.js';

export const MAX_PATHS = 30;
// The first part of a path that is an app's, never a page: offered when the copy asked its own address for such a path and
// did not have it (its checks, `offline.failed`).
const APP_SEGMENTS = new Set(['api', '_api', 'graphql', 'auth', 'oauth', 'login', 'logout', 'signin', 'sign-in', 'signup', 'sign-up', 'register',
  'account', 'accounts', 'dashboard', 'app', 'admin', 'wp-json', 'wp-admin', 'socket.io', 'rest', 'backend', 'user', 'users', 'session', 'sessions']);

const fileOf = (projectId) => path.join(projectDir(projectId), 'golive.json');

/** @param {string} projectId @returns {Promise<{ target: string, paths: string[] } | null>} */
export async function readPassThrough(projectId) {
  const j = await readFile(fileOf(projectId), 'utf8').then(JSON.parse, () => null);
  const p = j?.passThrough;
  return p && typeof p.target === 'string' && Array.isArray(p.paths) && p.paths.length ? { target: p.target, paths: p.paths } : null;
}

/** Saves (or with null, removes) the website's pass-through. @param {string} projectId @param {{ target: string, paths: string[] } | null} value */
export async function savePassThrough(projectId, value) {
  const file = fileOf(projectId);
  const current = await readFile(file, 'utf8').then(JSON.parse, () => ({}));
  const next = { ...current, passThrough: value };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, file);
}

const PRIVATE_V4 = /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * The old app's address as the owner types it: its origin, or why it cannot be used. `domain` = the site's own domain, which
 * cannot be the target (the request would come back to the copy).
 * @param {unknown} input @param {(string | null)[]} [domains]  the site's own names (its original and its new address)
 */
export function parseTarget(input, domains = []) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Type the old app\'s address, for example https://app.your-site.com.' };
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a web address. Type it like https://app.your-site.com.' };
  }
  const host = u.hostname.toLowerCase();
  if (u.username || u.password || !host.includes('.')) return { ok: false, error: 'That is not a web address. Type it like https://app.your-site.com.' };
  if (host === 'localhost' || PRIVATE_V4.test(host) || host.startsWith('[') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.invalid')) {
    return { ok: false, error: 'That address is only reachable inside a private network. The old app needs an address the internet can reach.' };
  }
  if (host.endsWith('.netlify.app')) return { ok: false, error: 'That is the copy\'s own address. Type the address of the old app.' };
  const bare = (h) => h.replace(/^www\./, '');
  const own = domains.find((d) => d && bare(host) === bare(d.toLowerCase()));
  if (own) {
    return { ok: false, error: `That is the domain the copy goes on. Give the old app an address of its own (for example app.${bare(own)}) that still points to the old server.` };
  }
  return { ok: true, value: u.origin, insecure: u.protocol === 'http:' };
}

/**
 * The paths as the owner lists them ("/api/*", "/login"): cleaned, or why one cannot be used. A path is passed through
 * as it is ("/login") or with everything under it ("/api/*").
 * @param {unknown} input  an array of strings, or one string with one path per line or comma
 */
export function parsePaths(input) {
  const list = (Array.isArray(input) ? input : String(input ?? '').split(/[\n,]/)).map((p) => String(p).trim()).filter(Boolean);
  if (!list.length) return { ok: false, error: 'List at least one path that belongs to the old app, for example /api/*.' };
  if (list.length > MAX_PATHS) return { ok: false, error: `At most ${MAX_PATHS} paths.` };
  const out = [];
  for (let p of list) {
    if (!p.startsWith('/')) p = `/${p}`;
    if (p === '/' || p === '/*') return { ok: false, error: 'Passing every address to the old app would hide the whole copy. List only the app\'s paths.' };
    if (!/^\/[A-Za-z0-9._~\-/]*(?:\/\*)?$/.test(p) || p.includes('//') || p.includes('/../')) {
      return { ok: false, error: `"${p}" is not a path Remastly can pass on. Use letters, numbers and /, and end with /* for everything under it.` };
    }
    if (!out.includes(p)) out.push(p);
  }
  return { ok: true, value: out };
}

/** The _redirects lines for a pass-through (one per path, in the owner's order). @param {{ target: string, paths: string[] }} pt */
export function redirectsFor(pt) {
  return pt.paths.map((p) => (p.endsWith('/*') ? `${p}  ${pt.target}${p.slice(0, -1)}:splat  200!` : `${p}  ${pt.target}${p}  200!`)).join('\n');
}

/**
 * Every address (path and query) the copy asked its own server for and did not have, whose path looks like an app's
 * (/api/…, /login): what only the old app answered. In the order first seen.
 * @param {any} report  a finished copy's report
 * @returns {string[]}
 */
export function appCallsOf(report) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const page of report?.asIs?.checks?.pages ?? []) {
    for (const line of page?.offline?.failed ?? []) {
      const address = String(line).match(/^\d{3}\s+(\/[^\s#]*)/)?.[1];
      const first = address?.split(/[/?]/)[1]?.toLowerCase();
      if (address && first && APP_SEGMENTS.has(first)) found.add(address);
    }
  }
  return [...found];
}

/**
 * The app paths to offer the owner (one per first part: /api/*), each with one address the copy asked for (without its query).
 * @param {any} report  a finished copy's report
 * @returns {{ path: string, seen: string }[]}
 */
export function suggestedPaths(report) {
  /** @type {Map<string, string>} */
  const found = new Map();
  for (const address of appCallsOf(report)) {
    const bare = address.split('?')[0];
    const p = `/${bare.split('/')[1].toLowerCase()}/*`;
    if (!found.has(p)) found.set(p, bare);
  }
  return [...found].map(([p, seen]) => ({ path: p, seen }));
}

/** Whether a pass-through path ("/login", "/api/*") takes this address. @param {string} p @param {string} address */
const takes = (p, address) => {
  const bare = address.split('?')[0];
  return p.endsWith('/*') ? bare.startsWith(p.slice(0, -1)) : bare === p;
};

/**
 * The app calls nothing answers on the live site: neither the content snapshot (by exact address) nor a path passed to the
 * old app. @param {any} report @param {{ passThrough?: { paths: string[] } | null, snapshotAddresses?: string[] }} o
 * @returns {string[]}
 */
export function unansweredAppCalls(report, { passThrough = null, snapshotAddresses = [] } = {}) {
  const snapped = new Set(snapshotAddresses);
  return appCallsOf(report).filter((a) => !snapped.has(a) && !passThrough?.paths.some((p) => takes(p, a)));
}
