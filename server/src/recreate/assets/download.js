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

// Reasons worth another try: the network or the server was momentarily unable, not the file being wrong. A 404, a file
// that is too large and a web page in place of an asset are answers, not failures, and are never retried.
const RETRY_REASONS = new Set(['timeout', 'dns', 'refused', 'error', 'http-408', 'http-425', 'http-429', 'http-500', 'http-502', 'http-503', 'http-504']);
// Waiting between attempts: 1.5 s, then 3 s, then 6 s, so a server that is briefly overloaded is not hammered.
const BACKOFF_MS = 1500;
// Below this there is nothing worth asking the server to continue from.
const MIN_RESUME_BYTES = 64 * 1024;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

/**
 * One attempt at one file.
 * @param {string} url
 * @param {object} o
 * @param {string} o.dir         folder for the temporary file
 * @param {string} o.kind        image | icon | font | media | stylesheet | document
 * @param {number} o.maxBytes
 * @param {number} o.timeout     ms for the whole transfer, redirects included
 * @param {AbortSignal} [o.signal]
 * @param {string} [o.referer]   the site's own origin; some CDNs refuse hotlinked requests without it
 * @param {number} [o.idleMs]    when set, a transfer is given up only after this long with no byte arriving, instead of
 *   after a fixed time: a large file on a slow line finishes, while a connection that died is still dropped
 * @param {{ tmp: string, bytes: number, head?: Buffer }} [o.resumeFrom]  continue a transfer that broke off (Range)
 */
async function attemptDownload(url, { dir, kind, maxBytes, timeout, signal, referer, idleMs = 0, resumeFrom = null }) {
  const resuming = Boolean(resumeFrom?.bytes);
  // The watchdog: with idleMs every chunk (and the headers arriving) resets the clock, so what is given up on is a
  // connection that stopped moving, not a slow one. Without it the whole transfer keeps its fixed limit, as before.
  const controller = new AbortController();
  let idle = null;
  const tick = () => {
    if (!idleMs) return;
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new DOMException('idle', 'TimeoutError')), idleMs);
  };
  const parts = [controller.signal];
  if (signal) parts.push(signal);
  if (!idleMs && Number.isFinite(timeout)) parts.push(AbortSignal.timeout(timeout));
  const combined = parts.length > 1 ? AbortSignal.any(parts) : parts[0];
  tick();
  const hop = await guardedFetch(url, {
    signal: combined,
    headers: {
      Accept: ACCEPT[kind] ?? '*/*',
      ...(referer && { Referer: referer }),
      ...(resuming && { Range: `bytes=${resumeFrom.bytes}-` }),
    },
  });
  if (hop.error) {
    clearTimeout(idle);
    return { ok: false, reason: hop.error, ...(hop.message && { detail: hop.message }), finalUrl: hop.url };
  }
  const { res } = hop;
  const acceptsRanges = /bytes/i.test(res.headers.get('accept-ranges') || '') || res.status === 206;
  const fail = async (reason, extra) => {
    clearTimeout(idle);
    await res.body?.cancel().catch(() => {});
    return { ok: false, reason, finalUrl: hop.url, ...extra };
  };

  // 206 only when this attempt asked to continue; a server that ignores Range answers 200, and the file starts over.
  if (res.status !== 200 && !(resuming && res.status === 206)) return fail(`http-${res.status}`);
  const continued = resuming && res.status === 206;
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || null;
  if (mime && NOT_AN_ASSET.test(mime) && kind !== 'stylesheet') return fail('not-an-asset');
  const declared = Number(res.headers.get('content-length'));
  if (declared + (continued ? resumeFrom.bytes : 0) > maxBytes) return fail('too-large', { bytes: declared });
  if (!res.body) {
    clearTimeout(idle);
    return { ok: false, reason: 'empty', finalUrl: hop.url };
  }

  const tmp = continued ? resumeFrom.tmp : path.join(dir, `.part-${randomUUID()}`);
  const hash = createHash('sha256');
  let bytes = continued ? resumeFrom.bytes : 0;
  let head = continued ? resumeFrom.head ?? null : null;
  let file;
  try {
    file = await open(tmp, continued ? 'a' : 'w');
    tick();
    for await (const chunk of res.body) {
      tick();
      if (bytes === 0 && kind !== 'stylesheet' && HTML_START.test(Buffer.from(chunk.subarray(0, 64)).toString('latin1'))) {
        throw Object.assign(new Error('not an asset'), { reason: 'not-an-asset' });
      }
      head ??= Buffer.from(chunk.subarray(0, 16));
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw Object.assign(new Error('too large'), { reason: 'too-large' });
      if (!continued) hash.update(chunk);
      await file.write(chunk);
    }
    await file.close();
    file = null;
    clearTimeout(idle);
    if (!bytes) throw Object.assign(new Error('empty'), { reason: 'empty' });
    // A continued transfer cannot hash as it streams (its first part arrived in an earlier attempt), so the finished
    // file is hashed once from disk.
    const sha256 = continued ? createHash('sha256').update(await readFile(tmp)).digest('hex') : hash.digest('hex');
    return { ok: true, tmp, sha256, bytes, mime, head, finalUrl: hop.url, redirects: hop.redirects };
  } catch (err) {
    clearTimeout(idle);
    await res.body.cancel().catch(() => {});
    await file?.close().catch(() => {});
    const reason = err.reason ?? errorCode(err);
    // What arrived stays on disk only when another attempt could continue it; anything else is removed at once.
    const keep = RETRY_REASONS.has(reason) && acceptsRanges && bytes >= MIN_RESUME_BYTES && bytes < maxBytes;
    if (!keep) await rm(tmp, { force: true }).catch(() => {});
    return {
      ok: false,
      reason,
      finalUrl: hop.url,
      ...(reason === 'too-large' && { bytes }),
      ...(keep && { partial: { tmp, bytes, head, acceptsRanges } }),
    };
  }
}

/**
 * Downloads one asset, with as many attempts as it is given. A transfer that broke off part way is continued where it
 * stopped when the server allows it (Range), so a dropped connection does not start a 30 MB file again.
 * @param {string} url
 * @param {object} o  everything attemptDownload takes, plus:
 * @param {object} [o.cache]     the job's shared cache: a file it holds is not downloaded again (`cached: true`)
 * @param {number} [o.attempts]  1 = a single try, as before
 * @param {(o:{ attempt:number, reason:string, waitMs:number, resuming:boolean })=>void} [o.onRetry]
 * @returns {Promise<{ ok: true, tmp: string, sha256: string, bytes: number, mime: string|null, head: Buffer, finalUrl: string, redirects: string[], cached?: boolean, attempts?: number, resumed?: boolean }
 *   | { ok: false, reason: string, detail?: string, finalUrl: string, bytes?: number, attempts?: number }>}
 */
export async function downloadAsset(url, { dir, kind, maxBytes, cache = null, attempts = 1, onRetry = null, ...opts }) {
  const cached = await fromCache(url, { cache, dir, kind, maxBytes });
  if (cached) return cached;
  const tries = Math.max(1, attempts);
  let partial = null;
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) {
      const waitMs = BACKOFF_MS * 2 ** (attempt - 2);
      onRetry?.({ attempt, reason: last.reason, waitMs, resuming: Boolean(partial) });
      await sleep(waitMs);
      if (opts.signal?.aborted) break;
    }
    const r = await attemptDownload(url, { ...opts, dir, kind, maxBytes, resumeFrom: partial });
    if (r.ok) return { ...r, ...(attempt > 1 && { attempts: attempt, resumed: Boolean(partial) }) };
    last = r;
    partial = r.partial ?? partial;
    if (!RETRY_REASONS.has(r.reason) || opts.signal?.aborted) break;
  }
  if (partial) await rm(partial.tmp, { force: true }).catch(() => {});
  const { partial: unusable, ...rest } = last;
  void unusable;
  return { ...rest, ...(tries > 1 && { attempts: tries }) };
}
