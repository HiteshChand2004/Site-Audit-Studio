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
// Server-side steps of the same job may read what the browsers loaded (lookup): Recreate's asset step takes its files
// from here instead of downloading each one a twelfth time.
//
// It is also the job's ONE network recorder (CLONER_SPEC: the mirror capture; before this, four places listened to the
// network on their own). Every context it is attached to gets a tap (`attach` returns it, `tapContext` makes one for a
// context without the cache): the resources that context loaded, its failed requests and, when asked, its stylesheet
// texts. With `recordDir`, every response of the original is also kept on disk for the mirror (see `createRecordStore`):
// GET bodies content-addressed, redirects as hops, other methods / WebSocket as unreproducible, failures with their reason.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/** A stylesheet longer than this is not kept as text by a tap (the as-is capture reads it from the CSSOM instead). */
export const MAX_SHEET_BYTES = 8 * 1024 * 1024;
export const RECORD_VERSION = 1;
/** One recorded file larger than this is listed, not kept (a video); the whole record stops growing past the budget. */
export const RECORD_MAX_FILE_BYTES = 40 * 1024 * 1024;
export const RECORD_MAX_TOTAL_BYTES = Number(process.env.SAS_RECORD_MB ?? 2048) * 1024 * 1024;

const KINDS = {
  document: 'document', stylesheet: 'style', script: 'script', font: 'font', image: 'image', media: 'media',
  xhr: 'data', fetch: 'data', manifest: 'other', texttrack: 'other', other: 'other',
};
export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/**
 * The record of everything the original's pages loaded, kept in `dir` (`files/<sha256>` + `index.json` on `save()`).
 * Each URL is kept once (its first body; a later different body counts as a `variant`, a part that changes with every
 * request). From the recorder of branch `mirror-mode-wip` (`capture/mirror.js createMirrorStore`), recorder only.
 */
export function createRecordStore(dir, { maxFileBytes = RECORD_MAX_FILE_BYTES, maxTotalBytes = RECORD_MAX_TOTAL_BYTES } = {}) {
  const files = path.join(dir, 'files');
  const entries = new Map();
  const unreproducible = new Map();
  const failed = new Map();
  const pending = new Set();
  let total = 0;
  // A record continued (a resumed or rebuilt job reusing this folder) keeps what it already holds.
  try {
    const before = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    for (const e of before.entries ?? []) entries.set(e.url, e);
    for (const u of before.unreproducible ?? []) unreproducible.set(`${u.method === 'WEBSOCKET' ? 'WS' : u.method} ${u.url.split('?')[0]}`, u);
    for (const f of before.failed ?? []) failed.set(f.url.split('?')[0], f);
    total = before.bytes ?? 0;
  } catch {
    // no earlier record
  }
  let ready = null;
  const ensure = () => (ready ??= mkdir(files, { recursive: true }));
  const note = (map, key, value) => {
    const had = map.get(key);
    if (!had) return void map.set(key, { ...value, count: 1 });
    had.count++;
    for (const p of value.pages ?? []) if (!had.pages.includes(p)) had.pages.push(p);
  };

  async function keep(response, page) {
    const request = response.request();
    const url = request.url();
    if (!/^https?:/i.test(url)) return;
    const status = response.status();
    const kind = KINDS[request.resourceType()] ?? 'other';
    const pages = page ? [page] : [];
    if (request.method() !== 'GET') {
      note(unreproducible, `${request.method()} ${url.split('?')[0]}`, { method: request.method(), url: url.slice(0, 300), host: hostOf(url), kind, pages });
      return;
    }
    const known = entries.get(url);
    if (known && page && !known.pages.includes(page)) known.pages.push(page);
    if (status >= 300 && status < 400) {
      const location = await response.headerValue('location').catch(() => null);
      if (!known && location) entries.set(url, { url, status, redirect: new URL(location, url).href, kind, pages });
      return;
    }
    if (status !== 200 && status !== 203) return;
    let body;
    try {
      body = await response.body();
    } catch {
      return; // no body to keep (an aborted or streamed response)
    }
    if (body.length > maxFileBytes || total + body.length > maxTotalBytes) {
      if (!known) entries.set(url, { url, status, kind, skipped: body.length > maxFileBytes ? 'too-large' : 'budget', bytes: body.length, pages });
      return;
    }
    const sha = createHash('sha256').update(body).digest('hex');
    if (known) {
      if (known.sha && known.sha !== sha) known.variants = (known.variants ?? 0) + 1;
      return;
    }
    const type = ((await response.headerValue('content-type').catch(() => null)) ?? '').split(';')[0].trim().toLowerCase();
    entries.set(url, { url, status, kind, type, sha, bytes: body.length, pages, frame: response.frame()?.parentFrame() ? 'child' : 'main' });
    total += body.length;
    await ensure();
    const file = path.join(files, sha);
    if (!(await stat(file).catch(() => null))) {
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, file).catch(() => rm(tmp, { force: true }));
    }
  }

  return {
    dir,
    /** Called by a tap for every response of its context. */
    response(response, page) {
      const task = keep(response, page).catch(() => {});
      pending.add(task);
      task.finally(() => pending.delete(task));
    },
    failure(request, page) {
      const url = request.url();
      if (!/^https?:/i.test(url)) return;
      note(failed, url.split('?')[0], { url: url.slice(0, 300), host: hostOf(url), reason: request.failure()?.errorText ?? 'failed', kind: KINDS[request.resourceType()] ?? 'other', pages: page ? [page] : [] });
    },
    socket(url, page) {
      note(unreproducible, `WS ${url.split('?')[0]}`, { method: 'WEBSOCKET', url: url.slice(0, 300), host: hostOf(url), kind: 'socket', pages: page ? [page] : [] });
    },
    /** The recorded response of `url` (after redirects): { status, type, file, bytes }, or null. */
    entryOf(url) {
      let entry = entries.get(url);
      for (let hops = 0; entry?.redirect && hops < 10; hops++) entry = entries.get(entry.redirect);
      return entry?.sha ? { status: entry.status, type: entry.type, file: path.join(files, entry.sha), bytes: entry.bytes } : null;
    },
    async flush() {
      while (pending.size) await Promise.all([...pending]);
    },
    async save(extra = {}) {
      await this.flush();
      await mkdir(dir, { recursive: true });
      const index = {
        version: RECORD_VERSION,
        savedAt: new Date().toISOString(),
        entries: [...entries.values()],
        unreproducible: [...unreproducible.values()],
        failed: [...failed.values()].slice(0, 500),
        bytes: total,
        ...extra,
      };
      await writeFile(path.join(dir, 'index.json'), JSON.stringify(index));
      return { entries: index.entries.length, unreproducible: index.unreproducible.length, failed: failed.size, bytes: total };
    },
    get size() { return entries.size; },
    get bytes() { return total; },
  };
}

/**
 * What one browser context loaded, for the step that owns it: `resources` (url → { url, type, status, mime, bytes }),
 * `failed` ([{ url, type, error }]) and, with `sheets`, the text of every stylesheet it received (`sheets`, url → text).
 * With a `store`, every response is recorded there too. Call before the context's first page is opened.
 * @param {import('playwright').BrowserContext} context
 * @param {{ store?: ReturnType<typeof createRecordStore> | null, page?: string | null, sheets?: boolean }} [o]
 */
export function tapContext(context, { store = null, page = null, sheets = false } = {}) {
  const resources = new Map();
  const failed = [];
  const sheetTexts = new Map();
  const pending = new Set();
  context.on('response', (res) => {
    const url = res.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    const req = res.request();
    const headers = res.headers();
    resources.set(url, {
      url,
      type: req.resourceType(),
      status: res.status(),
      mime: (headers['content-type'] || '').split(';')[0].trim() || null,
      bytes: Number(headers['content-length']) || null,
    });
    store?.response(res, page);
    if (sheets && req.resourceType() === 'stylesheet' && res.status() < 400) {
      const job = res.body().then((buf) => {
        if (buf.length <= MAX_SHEET_BYTES) sheetTexts.set(url, buf.toString('utf8'));
      }, () => {}).finally(() => pending.delete(job));
      pending.add(job);
    }
  });
  context.on('requestfailed', (req) => {
    const url = req.url();
    if (url.startsWith('data:')) return;
    failed.push({ url, type: req.resourceType(), error: req.failure()?.errorText ?? 'failed' });
    store?.failure(req, page);
  });
  if (store) context.on('page', (p) => p.on('websocket', (ws) => store.socket(ws.url(), page)));
  return {
    resources,
    failed,
    sheets: sheetTexts,
    /** Waits for the stylesheet texts still being read. */
    settled: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

/**
 * @param {{ maxEntryBytes?: number, maxTotalBytes?: number, waitMs?: number, recordDir?: string | null }} [o]
 *   recordDir: keep every response of the attached contexts there (the job's network record), see `createRecordStore`.
 * @returns {{ attach: (context: import('playwright').BrowserContext, o?: { page?: string, sheets?: boolean }) => Promise<ReturnType<typeof tapContext>>,
 *   lookup: (url: string) => object|null, record: ReturnType<typeof createRecordStore> | null, stats: () => object, close: () => Promise<void> }}
 */
export function createSharedCache({ maxEntryBytes = MAX_ENTRY_BYTES, maxTotalBytes = MAX_TOTAL_BYTES, waitMs = WAIT_MS, recordDir = null, share = true } = {}) {
  const record = recordDir ? createRecordStore(recordDir) : null;
  // url → Promise<{ status, headers, file, bytes } | null>; null = not shared, every context asks the network itself.
  const entries = new Map();
  // url → entry, for the files that are stored (lookup).
  const ready = new Map();
  const stats = { requests: 0, served: 0, servedBytes: 0, loaded: 0, stored: 0, storedBytes: 0, notShared: 0, failed: 0, reused: 0, reusedBytes: 0 };
  let dir = null;
  let files = 0;
  let closed = false;
  const folder = () => (dir ??= mkdtemp(path.join(process.env.SAS_TEMP_DIR || os.tmpdir(), 'sas-cache-')));

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
    const entry = { status: response.status(), headers: kept, file, bytes: body.length };
    ready.set(request.url(), entry);
    return entry;
  }

  /**
   * Routes the context's requests through the cache and returns its tap (what it loaded; recorded with `recordDir`).
   * Call before the first page of the context is opened.
   */
  async function attach(context, { page = null, sheets = false } = {}) {
    const tap = tapContext(context, { store: closed ? null : record, page, sheets });
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
    // A route whose page or context is gone rejects: nothing is left to answer. `share: false` (SAS_SHARED_CACHE=0) keeps
    // the recording and lets every context load everything itself.
    if (share) await context.route(/^https?:/i, (route) => handle(route).catch(() => {}));
    return tap;
  }

  return {
    attach,
    record,
    /**
     * The stored response of `url`, for a step that would otherwise download the file again: { status, headers, file, bytes },
     * or null when no browser context loaded it (or it was not kept). `file` holds the decoded body until close().
     */
    lookup(url) {
      let entry = closed ? null : ready.get(url) ?? null;
      // Not shared (a 203, a redirect target, a file loaded while sharing is off): the network record may still hold it.
      if (!entry && !closed && record) {
        const kept = record.entryOf(url);
        if (kept) entry = { status: kept.status === 203 ? 200 : kept.status, headers: kept.type ? { 'content-type': kept.type } : {}, file: kept.file, bytes: kept.bytes };
      }
      if (entry) {
        stats.reused++;
        stats.reusedBytes += entry.bytes;
      }
      return entry;
    },
    stats: () => ({ ...stats, files, ...(record && { recorded: record.size, recordedBytes: record.bytes }) }),
    /** Writes the network record's index (with `recordDir`); returns its counts, or null. */
    saveRecord: (extra) => (record ? record.save(extra) : Promise.resolve(null)),
    async close() {
      if (record) await record.save().catch(() => {});
      closed = true;
      entries.clear();
      ready.clear();
      if (dir) await rm(await dir, { recursive: true, force: true }).catch(() => {});
      dir = null;
    },
  };
}
