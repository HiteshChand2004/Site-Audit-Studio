// A cache of static sub-resources shared by the browser contexts of one job.
//
// A page is captured in many browser contexts (Recreate: 4 views and 7 sweep widths per page), and contexts share nothing:
// every one of them downloads the page's stylesheets, scripts, images and fonts again, 11 times per page. On a slow
// connection that is where a capture loses its time. With this cache the first context that asks for a file loads it the
// way it always did (the browser's own request, through the egress proxy and its SSRF guard); the response is kept, and
// every other context of the job is answered with it. Contexts asking while the first one is still loading wait for it.
// Nothing is ever fetched by the cache itself, so a file reaches a page exactly as the browser received it once.
//
// What is shared is what one visitor's browser cache would hold during one visit: GET requests for stylesheets, scripts,
// images and fonts that answered 200. Everything else goes to the network as before: documents and frames, XHR / fetch,
// media and range requests, redirects (the browser follows them itself, and it fetches what a redirect leads to without
// asking the cache, so a file behind a redirect is loaded by every context), errors, responses that set a cookie, say
// `no-store`, or vary by anything but Accept / Accept-Encoding / Origin (a response that depends on the user agent or on
// client hints belongs to one view only). A load that fails, hangs or belongs to a context that was closed is left to
// each browser, so a file is never missing because of the cache.
//
// Bodies are stored as files in a temporary folder (not in memory, not in the job's workspace) and removed by close().
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SHARED_TYPES = new Set(['stylesheet', 'script', 'image', 'font']);
const VARY_OK = new Set(['accept', 'accept-encoding', 'origin']);
// The stored body is decoded, and its length is set again when it is served.
const DROPPED_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
// How long a context waits for a file another context is still loading before it loads the file itself.
const WAIT_MS = 15000;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

/** Off with SAS_SHARED_CACHE=0 (every context loads everything itself, as before). */
export const sharedCacheEnabled = (env = process.env) => env.SAS_SHARED_CACHE !== '0';

/** May a request be answered from the cache at all? */
export function isShareable(request) {
  if (request.method() !== 'GET' || !SHARED_TYPES.has(request.resourceType())) return false;
  if (!/^https?:/i.test(request.url())) return false;
  const headers = request.headers();
  return !headers.range && !request.isNavigationRequest();
}

/** May a response be kept for the other contexts? */
export function isStorable(status, headers) {
  if (status !== 200) return false;
  if (headers['set-cookie']) return false;
  if (/\bno-store\b/i.test(headers['cache-control'] ?? '')) return false;
  const vary = (headers.vary ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  return vary.every((v) => VARY_OK.has(v));
}

/**
 * @param {{ maxEntryBytes?: number, maxTotalBytes?: number, waitMs?: number }} [o]
 * @returns {{ attach: (context: import('playwright').BrowserContext) => Promise<void>, stats: () => object, close: () => Promise<void> }}
 */
export function createSharedCache({ maxEntryBytes = MAX_ENTRY_BYTES, maxTotalBytes = MAX_TOTAL_BYTES, waitMs = WAIT_MS } = {}) {
  // url → Promise<{ status, headers, file, bytes } | null>; null = not shared, every context asks the network itself.
  const entries = new Map();
  const stats = { requests: 0, served: 0, servedBytes: 0, loaded: 0, stored: 0, storedBytes: 0, notShared: 0, failed: 0 };
  let dir = null;
  let files = 0;
  let closed = false;
  const folder = () => (dir ??= mkdtemp(path.join(os.tmpdir(), 'sas-cache-')));

  // Keeps the response of the request that loaded a file first. Returns the entry for the other contexts, or null.
  async function keep(request) {
    const response = await request.response();
    if (!response) return null;
    const headers = await response.allHeaders();
    if (!isStorable(response.status(), headers) || Number(headers['content-length']) > maxEntryBytes) {
      stats.notShared++;
      return null;
    }
    const body = await response.body();
    if (closed || body.length > maxEntryBytes || stats.storedBytes + body.length > maxTotalBytes) {
      stats.notShared++;
      return null;
    }
    const file = path.join(await folder(), String(files++));
    await writeFile(file, body);
    stats.stored++;
    stats.storedBytes += body.length;
    const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !DROPPED_HEADERS.has(name.toLowerCase())));
    return { status: response.status(), headers: kept, file, bytes: body.length };
  }

  /** Routes the context's requests through the cache. Call before the first page of the context is opened. */
  async function attach(context) {
    // Requests of this context that are loading a file first: request → { url, resolve }.
    const loading = new Map();
    const settle = (request, entry) => {
      const load = loading.get(request);
      if (!load) return;
      loading.delete(request);
      // Nothing to share and the load did not even finish: the next context that asks tries again.
      if (!entry && load.retry) entries.delete(load.url);
      load.resolve(entry);
    };
    context.on('requestfinished', (request) => {
      if (!loading.has(request)) return;
      stats.loaded++;
      keep(request).then((entry) => settle(request, entry), () => {
        stats.failed++;
        settle(request, null);
      });
    });
    context.on('requestfailed', (request) => {
      if (!loading.has(request)) return;
      stats.failed++;
      loading.get(request).retry = true;
      settle(request, null);
    });
    // A context closed in the middle of a load (an abandoned view) never reports it: whoever waits is released.
    context.on('close', () => {
      for (const request of [...loading.keys()]) {
        loading.get(request).retry = true;
        settle(request, null);
      }
    });

    const handle = async (route) => {
      const request = route.request();
      if (closed || !isShareable(request)) return route.continue();
      stats.requests++;
      const url = request.url();
      const pending = entries.get(url);
      if (!pending) {
        // The first to ask: the browser loads the file itself, as it would without the cache.
        entries.set(url, new Promise((resolve) => loading.set(request, { url, resolve })));
        return route.continue();
      }
      let timer;
      const entry = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(resolve, waitMs, null); })]);
      clearTimeout(timer);
      if (!entry) return route.continue();
      let body;
      try {
        body = await readFile(entry.file);
      } catch {
        return route.continue();
      }
      stats.served++;
      stats.servedBytes += entry.bytes;
      return route.fulfill({ status: entry.status, headers: entry.headers, body });
    };
    // A route whose page or context is gone rejects: nothing is left to answer.
    await context.route(/^https?:/i, (route) => handle(route).catch(() => {}));
  }

  return {
    attach,
    stats: () => ({ ...stats, files }),
    async close() {
      closed = true;
      entries.clear();
      if (dir) await rm(await dir, { recursive: true, force: true }).catch(() => {});
      dir = null;
    },
  };
}
