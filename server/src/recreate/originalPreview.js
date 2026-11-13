// @ts-check
// The live original under the app's own address, so Compare can show it live next to the copy and scroll both together.
// A page cannot reach into a frame of another site (its scroll position included), and many sites refuse to be framed at
// all, so the original is served the way the copy is: GET /preview/<token>/<path> (recreate/previewRoute.js) for a token of
// kind 'original' fetches <site><path> from the live site and sends it on.
//
// - Only the token's own site is ever fetched (its origin + the requested path), through the SSRF-guarded fetch that checks
//   every hop and the address each connection lands on (audit/http.js guardedFetch): it is not a proxy to anywhere.
// - The page runs its own script inside the same sealed frame as an as-is copy (`sandbox allow-scripts`, an opaque origin:
//   no cookie, storage or API of the app), with the preview's shim first, which moves the addresses its script builds and
//   lets the app scroll it. Its framing refusals (X-Frame-Options, its own policy) and its cookies are not passed on.
// - Its pages and stylesheets have their addresses moved under the preview like a copy's, the site's own absolute ones
//   ("https://site/x") first made root-relative, so its files come through here too (fonts and modules need it: from an
//   opaque origin they are cross-origin requests, which the site itself would refuse).
import { Readable } from 'node:stream';
import { guardedFetch } from '../audit/http.js';
import { issuePreviewToken, previewPath, resolvePreviewToken } from './previewTokens.js';

/** How long one file of the original may take. */
export const FETCH_LIMIT_MS = 30000;
/** The largest page / stylesheet / script read to rewrite its addresses; larger ones are sent as they are. */
export const MAX_REWRITE_BYTES = 15 * 1024 * 1024;

const hostKey = (host) => host.toLowerCase().replace(/^www\./, '');

/** @type {Map<string, string>} project + site origin → token */
const tokens = new Map();

/**
 * The address under which the project's live site is shown (one token per project and site, kept while the server runs).
 * @param {string} projectId @param {string} siteUrl
 * @returns {{ url: string, site: string }}
 */
export function originalPreview(projectId, siteUrl) {
  const site = new URL(siteUrl).origin;
  const key = `${projectId}|${site}`;
  let token = tokens.get(key);
  if (!token || !resolvePreviewToken(token)) {
    token = issuePreviewToken({ root: '', kind: 'original', scripts: true, site });
    tokens.set(key, token);
  }
  return { url: previewPath(token), site };
}

/** What a response is, from its type (an address need not end in its extension), else from the address. */
export function extOf(contentType, pathname) {
  const t = String(contentType).toLowerCase();
  if (/text\/html|application\/xhtml/.test(t)) return '.html';
  if (t.includes('image/svg')) return '.svg';
  if (t.includes('text/css')) return '.css';
  if (/javascript|ecmascript/.test(t)) return '.js';
  const m = pathname.match(/\.[a-z0-9]+$/i);
  return m ? m[0].toLowerCase() : '';
}

/**
 * The site's own absolute addresses where an address is written (an attribute value, url(…), a srcset candidate) made
 * root-relative, so the preview moves them under itself. Text that only mentions the address is left alone.
 * @param {string} text @param {string} host  the site's host (with or without www.)
 */
export function relativizeSite(text, host) {
  const name = hostKey(host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`((?:=\\s*["']?)|(?:url\\(\\s*["']?)|(?:,\\s*))(?:https?:)?//(?:www\\.)?${name}(?::\\d+)?(?=[/"'?#)\\s,>]|$)(/?)`, 'gi');
  return text.replace(re, (_all, head) => `${head}/`);
}

/**
 * One file of the original, sent as the preview sends a file. `rewrite` is previewRoute.js's rewriteFile; `headersFor` its
 * previewFileHeaders with the request's origin filled in.
 * @param {{ req: import('express').Request, res: import('express').Response, entry: any, prefix: string, raw: string,
 *   rewrite: (o: any) => string, headersFor: (ext: string) => Record<string, string>, send: (status: number, text: string) => any }} o
 */
export async function serveOriginal({ req, res, entry, prefix, raw, rewrite, headersFor, send }) {
  const site = new URL(entry.site);
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = new URL(`${raw}${query}`, site);
  const headers = { Accept: String(req.headers.accept ?? '*/*') };
  if (req.headers['accept-language']) headers['Accept-Language'] = String(req.headers['accept-language']);
  if (req.headers.range) headers.Range = String(req.headers.range);
  // A framework's own page-data requests (Next.js: RSC, Next-Router-*), so moving between pages works as on the site.
  for (const [name, value] of Object.entries(req.headers)) {
    if (/^(rsc|next-router-[a-z-]+|next-url)$/i.test(name) && typeof value === 'string') headers[name] = value;
  }
  const hop = await guardedFetch(target.toString(), { method: req.method === 'HEAD' ? 'HEAD' : 'GET', signal: AbortSignal.timeout(FETCH_LIMIT_MS), headers });
  if (hop.error || !hop.res) {
    console.log(`[original] ${target.href}: ${hop.error ?? 'no answer'}`);
    return send(502, `The original site did not answer (${hop.error ?? 'error'}).`);
  }
  if (extOf(hop.res.headers.get('content-type') ?? '', target.pathname) === '.html') console.log(`[original] page ${target.href} → ${hop.res.status}`);
  const upstream = hop.res;
  const final = new URL(hop.url);
  // Sent to another page of the site (/about → /about/): the frame goes there under the preview, so the page's relative
  // addresses resolve as they do on the site.
  if (hop.redirects.length && hostKey(final.hostname) === hostKey(site.hostname) && `${final.pathname}${final.search}` !== `${target.pathname}${target.search}`) {
    await upstream.body?.cancel().catch(() => {});
    return res.redirect(302, `${prefix.replace(/\/$/, '')}${final.pathname}${final.search}`);
  }
  const type = upstream.headers.get('content-type') ?? '';
  const ext = extOf(type, final.pathname);
  const size = Number(upstream.headers.get('content-length') ?? 0);
  const out = { ...headersFor(ext), ...(type && { 'Content-Type': type }) };
  // The site's own files may be kept a few minutes (a page is always asked for again: it is what the person is looking at).
  if (ext !== '.html') out['Cache-Control'] = 'private, max-age=300';
  const rewritten = ['.html', '.svg', '.css', '.js', '.mjs'].includes(ext) && !(size > MAX_REWRITE_BYTES) && upstream.status !== 206;
  if (!rewritten) {
    for (const h of ['content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    }
    res.status(upstream.status).set(out);
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    // @ts-ignore a web stream from undici
    return Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  }
  let text = await upstream.text();
  if (ext !== '.js' && ext !== '.mjs') text = relativizeSite(text, site.hostname);
  const dir = raw.slice(0, raw.lastIndexOf('/') + 1) || '/';
  const body = Buffer.from(rewrite({ ext, text, prefix, dir, scripts: true }), 'utf8');
  res.status(upstream.status).set({ ...out, 'Content-Length': String(body.length) });
  return res.end(req.method === 'HEAD' ? undefined : body);
}
