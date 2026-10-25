// Parts of a page that an outside service serves only to the original's own domain (a chat widget, a booking form, a search
// box): the copy keeps their script exactly as the original has it, but the service refuses every page not on the domains
// listed in its settings (CORS allow-list), so the part never appears in the copy. Nothing the copy can do changes that; the
// owner allows the new domain in that service's settings. This check finds such parts with evidence, never by host name:
//   1. the copy's page is opened with the network on; every request to another site that fails or answers 400 or more is kept;
//   2. the service is then asked the same request twice, server-side, the way a browser would (its preflight, then the request
//      itself, with an Origin): once as the original's domain, once as another domain. Allowed for the original and refused
//      for the other = locked to the original's domain.
import { guardedFetch } from '../../../audit/http.js';
import { openAndScroll } from './check.js';

/** At most this many failing requests are asked about per page. */
const MAX_ASKED = 6;
/** Stands in for "a domain the service does not know" (the new site's domain before the owner allows it). */
const OTHER_ORIGIN = 'https://example.com';
/** Request headers a page may send without a preflight (CORS-safelisted), lower case. */
const SIMPLE_HEADERS = new Set(['accept', 'accept-language', 'content-language', 'content-type', 'range']);
const SIMPLE_TYPE = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/i;
const ASK_TIMEOUT_MS = 10000;

/** The plain words the report uses for a part locked to the original's domain. */
export const lockedText = (host) => `This part (${host}) only loads on the original's domain. It will appear once your new domain is allowed in that service's settings.`;

/** The header names a browser lists in the preflight for these request headers (none = no preflight needed). */
function preflightHeaders(headers) {
  const names = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (name.startsWith(':') || ['origin', 'referer', 'user-agent', 'host', 'connection', 'cookie', 'accept-encoding', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'].includes(name) || name.startsWith('sec-')) continue;
    if (!SIMPLE_HEADERS.has(name) || (name === 'content-type' && !SIMPLE_TYPE.test(v))) names.push(name);
  }
  return names.sort();
}

/** Asks the service as `origin` the way a browser would: is the answer readable by a page on that origin? */
async function askAs(origin, { url, method, headers }) {
  const allows = (res) => {
    const acao = res.headers.get('access-control-allow-origin');
    return res.status < 400 && (acao === '*' || acao === origin);
  };
  const signal = () => AbortSignal.timeout(ASK_TIMEOUT_MS);
  const names = preflightHeaders(headers);
  const simple = ['GET', 'HEAD', 'POST'].includes(method) && !names.length;
  if (!simple) {
    const pre = await guardedFetch(url, { method: 'OPTIONS', signal: signal(), headers: { Origin: origin, 'Access-Control-Request-Method': method, ...(names.length && { 'Access-Control-Request-Headers': names.join(',') }) } });
    if (pre.error) return { allowed: false, step: 'preflight', error: pre.error };
    await pre.res.body?.cancel().catch(() => {});
    if (!allows(pre.res)) return { allowed: false, step: 'preflight', status: pre.res.status, acao: pre.res.headers.get('access-control-allow-origin') };
  }
  // The request itself is only repeated when it changes nothing on the service.
  if (method !== 'GET' && method !== 'HEAD') return { allowed: true, step: 'preflight' };
  const res = await guardedFetch(url, { method, signal: signal(), headers: { Origin: origin } });
  if (res.error) return { allowed: false, step: 'request', error: res.error };
  const body = await res.res.text().catch(() => '');
  return { allowed: allows(res.res), step: 'request', status: res.res.status, acao: res.res.headers.get('access-control-allow-origin'), answer: body.replace(/\s+/g, ' ').slice(0, 120) };
}

/** The original's origin and its www / bare twin (a site answers on both, the service may list either). */
function originsOf(originalUrl) {
  const u = new URL(originalUrl);
  const twin = new URL(u.origin);
  twin.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
  return [u.origin, twin.origin];
}

/**
 * The outside services on a page of the copy that refuse it because it is not on the original's domain.
 * @param {import('playwright').Browser} browser
 * @param {string} base         the copy's address (no trailing slash)
 * @param {string} pagePath
 * @param {string} originalUrl  the page's address on the original
 * @returns {Promise<{ host: string, url: string, method: string, original: object, other: object }[]>}
 */
export async function domainLockedParts(browser, base, pagePath, originalUrl) {
  const copyOrigin = new URL(base).origin;
  const failing = new Map();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const keep = async (req, status) => {
      const url = req.url();
      if (!/^https?:/.test(url) || new URL(url).origin === copyOrigin || failing.has(url)) return;
      failing.set(url, { url, method: req.method(), headers: await req.allHeaders().catch(() => req.headers()), status });
    };
    page.on('requestfailed', (req) => { keep(req, 0); });
    page.on('response', (res) => { if (res.status() >= 400) keep(res.request(), res.status()); });
    await openAndScroll(page, `${base}${pagePath}`);
    await page.waitForTimeout(1500);
  } finally {
    await context.close();
  }
  const origins = originsOf(originalUrl);
  const locked = [];
  for (const req of [...failing.values()].slice(0, MAX_ASKED)) {
    let original = null;
    for (const o of origins) {
      original = { origin: o, ...(await askAs(o, req)) };
      if (original.allowed) break;
    }
    if (!original.allowed) continue;
    const other = { origin: OTHER_ORIGIN, ...(await askAs(OTHER_ORIGIN, req)) };
    if (other.allowed) continue;
    locked.push({ host: new URL(req.url).hostname, url: req.url, method: req.method, original, other });
  }
  return locked;
}

/** One open item per page and service locked to the original's domain (reason a: third-party code outside the copy). */
export function lockedItems(pages) {
  const items = [];
  for (const p of pages) {
    const seen = new Set();
    for (const l of p.domainLocked ?? []) {
      if (seen.has(l.host)) continue;
      seen.add(l.host);
      const said = (a) => (a.status ? `${a.status}${a.answer ? ` ${a.answer}` : ''}` : a.error ?? 'no answer');
      items.push({
        page: p.path,
        check: `outside service ${l.host}`,
        values: lockedText(l.host),
        tried: `the copy keeps the part's script as the original has it; ${l.method} ${l.url} answered the original's domain (${l.original.origin}) and refused another (${l.other.origin}: ${said(l.other)})`,
        reason: 'third_party',
      });
    }
  }
  return items;
}
