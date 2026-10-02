// Downloads one asset to a temporary file under the SSRF guard (audit/http.js guardedFetch: the URL
// precheck and the connect-time IP check run on every redirect hop). Enforces a byte limit (the
// Content-Length header first, then the bytes actually received) and a time limit that covers the
// whole transfer, and hashes the body while it streams, so the caller can dedupe by content.
// A file the browsers of the job already loaded (the shared cache, audit/sharedCache.js) is taken from there instead:
// it is the response the captured pages were rendered with, and it passes the same checks as a download.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, guardedFetch } from '../../audit/http.js';

const ACCEPT = {
  image: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  icon: 'image/avif,image/webp,image/svg+xml,image/*,*/*;q=0.8',
  font: 'font/woff2,font/woff,font/ttf,font/otf,*/*;q=0.8',
  media: 'video/*,audio/*,*/*;q=0.8',
  stylesheet: 'text/css,*/*;q=0.1',
};

// Error pages and API answers served in place of an asset.
const NOT_AN_ASSET = /^(text\/html|application\/xhtml\+xml|application\/json|application\/problem\+json)$/i;
const HTML_START = /^\s*(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i;

export const REASONS = {
  'too-large': 'Larger than the size limit for this kind of file.',
  timeout: 'Did not download within the time limit.',
  blocked: 'Blocked by the SSRF guard (not a public address).',
  dns: 'The host name does not resolve.',
  refused: 'The connection was refused or reset.',
  ssl: 'TLS certificate error.',
  'too-many-redirects': 'Too many redirects.',
  'unsupported-protocol': 'Not an http(s) URL.',
  'not-an-asset': 'The server answered with a web page or JSON, not a file.',
  empty: 'The response was empty.',
  budget: 'Skipped: the total asset count or size limit for one recreate was reached.',
  'time-limit': 'Skipped: the time limit of the assets step was reached.',
  error: 'Download failed.',
};
export const reasonDetail = (reason) => REASONS[reason] ?? (reason.startsWith('http-') ? `The server answered HTTP ${reason.slice(5)}.` : REASONS.error);

// The file as the job's browsers received it, when it is one this step would accept. Anything else (not kept, too large,
// a web page in place of a file, a read error) is left to the download below, which decides and reports as always.
async function fromCache(url, { cache, dir, kind, maxBytes }) {
  const entry = cache?.lookup(url);
  if (!entry || entry.status !== 200 || !entry.bytes || entry.bytes > maxBytes) return null;
  const mime = (entry.headers['content-type'] || '').split(';')[0].trim().toLowerCase() || null;
  if (mime && NOT_AN_ASSET.test(mime) && kind !== 'stylesheet') return null;
  let tmp;
  try {
    const body = await readFile(entry.file);
    if (!body.length || body.length > maxBytes) return null;
    if (kind !== 'stylesheet' && HTML_START.test(body.subarray(0, 64).toString('latin1'))) return null;
    tmp = path.join(dir, `.part-${randomUUID()}`);
    await writeFile(tmp, body);
    return { ok: true, tmp, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length, mime, head: Buffer.from(body.subarray(0, 16)), finalUrl: url, redirects: [], cached: true };
  } catch {
    if (tmp) await rm(tmp, { force: true }).catch(() => {});
    return null;
  }
}

/**
 * @param {string} url
 * @param {object} o
 * @param {string} o.dir         folder for the temporary file
 * @param {string} o.kind        image | icon | font | media | stylesheet
 * @param {number} o.maxBytes
 * @param {number} o.timeout     ms for the whole transfer, redirects included
 * @param {AbortSignal} [o.signal]
 * @param {string} [o.referer]   the site's own origin; some CDNs refuse hotlinked requests without it
 * @param {object} [o.cache]     the job's shared cache: a file it holds is not downloaded again (`cached: true`)
 * @returns {Promise<{ ok: true, tmp: string, sha256: string, bytes: number, mime: string|null, head: Buffer, finalUrl: string, redirects: string[], cached?: boolean }
 *   | { ok: false, reason: string, detail?: string, finalUrl: string, bytes?: number }>}
 */
export async function downloadAsset(url, { dir, kind, maxBytes, timeout, signal, referer, cache = null }) {
  const cached = await fromCache(url, { cache, dir, kind, maxBytes });
  if (cached) return cached;
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const hop = await guardedFetch(url, {
    signal: combined,
    headers: { Accept: ACCEPT[kind] ?? '*/*', ...(referer && { Referer: referer }) },
  });
  if (hop.error) return { ok: false, reason: hop.error, ...(hop.message && { detail: hop.message }), finalUrl: hop.url };
  const { res } = hop;
  const fail = async (reason, extra) => {
    await res.body?.cancel().catch(() => {});
    return { ok: false, reason, finalUrl: hop.url, ...extra };
  };

  if (res.status !== 200) return fail(`http-${res.status}`);
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || null;
  if (mime && NOT_AN_ASSET.test(mime) && kind !== 'stylesheet') return fail('not-an-asset');
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) return fail('too-large', { bytes: declared });
  if (!res.body) return { ok: false, reason: 'empty', finalUrl: hop.url };

  const tmp = path.join(dir, `.part-${randomUUID()}`);
  const hash = createHash('sha256');
  let bytes = 0;
  let head = null;
  let file;
  try {
    file = await open(tmp, 'w');
    for await (const chunk of res.body) {
      if (bytes === 0 && kind !== 'stylesheet' && HTML_START.test(Buffer.from(chunk.subarray(0, 64)).toString('latin1'))) {
        throw Object.assign(new Error('not an asset'), { reason: 'not-an-asset' });
      }
      head ??= Buffer.from(chunk.subarray(0, 16));
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw Object.assign(new Error('too large'), { reason: 'too-large' });
      hash.update(chunk);
      await file.write(chunk);
    }
    await file.close();
    file = null;
    if (!bytes) throw Object.assign(new Error('empty'), { reason: 'empty' });
    return { ok: true, tmp, sha256: hash.digest('hex'), bytes, mime, head, finalUrl: hop.url, redirects: hop.redirects };
  } catch (err) {
    await res.body.cancel().catch(() => {});
    await file?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    const reason = err.reason ?? errorCode(err);
    return { ok: false, reason, finalUrl: hop.url, ...(reason === 'too-large' && { bytes }) };
  }
}
