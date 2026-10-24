// What the packaged copy actually serves, measured on its own running server after packaging: a fix counts only where it takes
// effect (docs/COPY-MY-SITE.md §2). Three things are asked of the server:
//   headers  which security headers its home page answers with — counted as applied only for a stack that ships its own server
//            (copy/securityHeaders.js HEADERS_TAKE_EFFECT): a static stack's local preview server is not its host, so its
//            `_headers` is "prepared, depends on the host" and becomes an open item with reason e, never a fix;
//   files    robots.txt, sitemap.xml, llms.txt: served (status 200) or not;
//   pages    every page whose fixes were kept: is the served HTML the fixed file? (a stack that rewrote or replaced it would
//            leave the fixes on disk only).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SECURITY_HEADERS, HEADERS_TAKE_EFFECT } from './securityHeaders.js';

const TIMEOUT_MS = 15000;
const get = async (url) => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * @param {object} o
 * @param {string} o.base        the running copy (no trailing slash)
 * @param {string} o.stack
 * @param {string} o.copyDir     the fixed copy on disk
 * @param {{ path: string, outPath: string }[]} o.fixedPages   pages whose fixes were kept
 * @param {string[]} [o.files]   site files the fixes wrote
 */
export async function measureServed({ base, stack, copyDir, fixedPages = [], files = [], takeEffect = null }) {
  const out = { stack, takeEffect: takeEffect ?? HEADERS_TAKE_EFFECT[stack] ?? 'host', headers: { sent: [], missing: [] }, files: {}, pages: [] };
  try {
    const home = await get(`${base}/`);
    for (const [name] of SECURITY_HEADERS) (home.headers.get(name) ? out.headers.sent : out.headers.missing).push(name);
  } catch (err) {
    out.headers.error = String(err?.message ?? err).slice(0, 160);
  }
  for (const f of files.filter((x) => x !== '_headers')) {
    out.files[f] = await get(`${base}/${f}`).then((r) => r.status, () => 'no answer');
  }
  for (const p of fixedPages) {
    const onDisk = await readFile(path.join(copyDir, p.outPath), 'utf8').catch(() => null);
    const served = await get(`${base}${p.path}`).catch(() => null);
    out.pages.push({ path: p.path, status: served?.status ?? 'no answer', servedAsFixed: Boolean(onDisk && served && squash(served.text) === squash(onDisk)) });
  }
  return out;
}

/**
 * What the measurement means for the report: the security headers counted as applied, and the open items for what does not
 * take effect (reason e for the host-dependent `_headers`; the others name a real gap).
 */
export function servedOutcome(m) {
  const open = [];
  let applied = [];
  if (m.takeEffect === 'server') {
    applied = m.headers.sent;
    if (m.headers.missing.length) {
      open.push({ check: 'security headers', values: `not sent by the copy's own server: ${m.headers.missing.join(', ')}`, tried: 'measured on the packaged copy\'s server', reason: 'deploy' });
    }
  } else {
    open.push({
      check: 'security headers',
      values: 'prepared in _headers; applied only by hosts that read it (Netlify, Cloudflare Pages), not by Vercel, GitHub Pages or S3',
      tried: 'the static copy has no server of its own, so this cannot be measured before it is hosted',
      reason: 'deploy',
    });
  }
  for (const [f, status] of Object.entries(m.files)) {
    if (status !== 200) open.push({ check: `site file ${f}`, values: `the packaged copy answers ${status} for /${f}`, tried: 'written into the copy', reason: 'unresolved' });
  }
  for (const p of m.pages) {
    if (!p.servedAsFixed) open.push({ page: p.path, check: 'fixes served', values: `the packaged copy does not serve the fixed page (status ${p.status})`, tried: 'the fixes are in the copy\'s files', reason: 'unresolved' });
  }
  return { applied, open };
}
