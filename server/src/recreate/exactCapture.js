// The step that measures the original at every exact viewport (capture/exact.js), and the cheap check that says
// whether a baseline still matches the live site.
//
// Resumable without a new checkpoint bucket: a page's own exact/index.json is the record. A page whose manifest
// already holds every slot is reused as it is, a page that holds some of them has only the rest visited, and
// clearUnfinished keeps the capture folders of finished pages on a resume - so an interrupted run of fifteen hours
// continues where it stopped, per page and per slot.
import { readFile, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parallelism } from '../audit/resources.js';
import { guardedFetch } from '../audit/http.js';
import { launchBrowser } from '../audit/render.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { captureExactPage, exactDir } from './capture/exact.js';
import { RECIPE_VERSION } from './verify/exact/recipe.js';
import { FREEZE_VERSION } from './verify/exact/freeze.js';
import { exactSlots } from './verify/exact/slots.js';
import { compareFingerprint } from './verify/exact/fingerprint.js';

/** Memory one slot's visit is counted with: a loaded page plus a full-page shot being encoded. */
export const SLOT_MB = 700;
/** Never more than this at once, however much memory there seems to be: a long run must not die of it. */
export const SLOTS_AT_ONCE = 2;
/** Pages the original is visited twice at, to measure how much it differs from itself. */
export const NOISE_PAGES = 1;
/** Below this much free disk the step does not start: a slot is megabytes and a site is hundreds of them. */
export const MIN_DISK_GB = 10;
/** A baseline older than this is worth re-checking even when the page looks unchanged. */
export const BASELINE_STALE_DAYS = 7;

const gb = (bytes) => Math.round((bytes / 1073741824) * 10) / 10;

/** Free space where the workspace lives; unknown (null) on a platform that cannot say. */
export async function freeDiskGB(dir) {
  try {
    const fs = await statfs(dir);
    return gb(Number(fs.bavail) * Number(fs.bsize));
  } catch {
    return null;
  }
}

/** The media queries the capture recorded for the homepage: what the slot list ranks the site's breakpoints by. */
async function homepageQueries(ctx) {
  const home = ctx.pages?.[0];
  if (!home) return {};
  for (const view of ['desktop', 'laptop', 'tablet', 'mobile']) {
    try {
      const data = JSON.parse(await readFile(path.join(ctx.dir, 'capture', home.slug, `${view}.json`), 'utf8'));
      if (data?.mediaRules?.length || data?.mediaQueries?.length) {
        return { mediaRules: data.mediaRules ?? [], mediaQueries: data.mediaQueries ?? [] };
      }
    } catch {
      // that view was not captured; try the next
    }
  }
  return {};
}

/** What is already on disk for this page, so a resumed run visits only the slots it still needs. */
async function existing(ctx, page) {
  try {
    const manifest = JSON.parse(await readFile(path.join(exactDir(ctx.dir, page.slug), 'index.json'), 'utf8'));
    return manifest?.slots?.length ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * The step. Only an exact copy runs it; it measures, never fails the job (an exact compare with fewer slots is worth
 * more than a lost recreate).
 */
export async function exactCaptureStage(ctx, local = {}) {
  if (!ctx.exact) return;
  const { report } = ctx;
  const progress = local.progress ?? ctx.progress;
  const deadline = local.stepDeadline ?? ctx.stepDeadline ?? Infinity;
  const pages = ctx.pages ?? [];
  if (!pages.length) return;

  const free = await freeDiskGB(ctx.dir);
  if (free !== null && free < MIN_DISK_GB) {
    report.warnings.push(`The exact measurement of the original was skipped: only ${free} GB of disk is free, and it needs at least ${MIN_DISK_GB} GB.`);
    report.exact = { ...report.exact, baseline: { status: 'skipped', reason: 'disk', freeGB: free } };
    return;
  }

  const { slots, rejected, bounds } = exactSlots(await homepageQueries(ctx));
  const atOnce = Math.min(SLOTS_AT_ONCE, parallelism({ perUnitMB: SLOT_MB, max: SLOTS_AT_ONCE, min: 1 }));
  // Chromium reaches the site through the job's own SSRF egress proxy, like every other step that opens a page.
  const proxy = await startEgressProxy(ctx.netPolicy);
  const browser = await launchBrowser({ proxy: proxy.url });

  const done = [];
  const errors = [];
  let reusedPages = 0;
  let bytes = 0;
  try {
    for (const [i, page] of pages.entries()) {
      if (ctx.signal?.aborted) break;
      progress?.(i / pages.length, `Measuring the original: ${page.path} (${i + 1} of ${pages.length})`);
      const already = await existing(ctx, page);
      const have = new Set((already?.slots ?? []).map((s) => s.id));
      const want = slots.filter((s) => !have.has(s.id));
      if (already && !want.length) {
        done.push(already);
        bytes += already.bytes ?? 0;
        reusedPages++;
        continue;
      }
      try {
        const result = await captureExactPage(browser, page, ctx.dir, {
          slots: want,
          cache: ctx.netCache,
          deadline,
          atOnce: Math.min(atOnce, Math.max(1, parallelism({ perUnitMB: SLOT_MB, max: SLOTS_AT_ONCE, min: 1 }))),
          noise: i < NOISE_PAGES,
          progress: (f, message) => progress?.((i + f) / pages.length, message),
        });
        // A page that was partly done keeps what it had: the manifest is the union.
        if (already) {
          result.slots = [...already.slots, ...result.slots].sort((a, b) => b.width - a.width || b.height - a.height);
          result.errors = [...(already.errors ?? []), ...result.errors];
          result.fingerprint ??= already.fingerprint;
          result.bytes = (already.bytes ?? 0) + result.bytes;
          await writeFile(path.join(exactDir(ctx.dir, page.slug), 'index.json'), JSON.stringify(result, null, 1));
        }
        done.push(result);
        bytes += result.bytes ?? 0;
        for (const e of result.errors) errors.push({ page: page.path, ...e });
      } catch (err) {
        errors.push({ page: page.path, message: String(err.message ?? err).split('\n')[0].slice(0, 200) });
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await proxy.close().catch(() => {});
  }

  const measured = done.reduce((n, p) => n + p.slots.length, 0);
  // How much the original differs from itself, per slot: the scale every later number is read against.
  const noiseFloor = {};
  for (const p of done) {
    for (const s of p.slots) if (s.noise?.pct !== undefined) noiseFloor[s.id] = Math.max(noiseFloor[s.id] ?? 0, s.noise.pct);
  }
  const freeAfter = await freeDiskGB(ctx.dir);
  ctx.exactBaseline = { slots, pages: done, noiseFloor };
  report.exact = {
    ...report.exact,
    recipeVersion: RECIPE_VERSION,
    freezeVersion: FREEZE_VERSION,
    slots: { list: slots.map((s) => ({ id: s.id, width: s.width, height: s.height, dpr: s.dpr, origin: s.origin })), rejected, bounds },
    baseline: {
      status: errors.length && !measured ? 'failed' : 'ready',
      capturedAt: new Date().toISOString(),
      pages: done.length,
      reusedPages,
      slotsPerPage: slots.length,
      measured,
      errors: errors.slice(0, 40),
      errorCount: errors.length,
    },
    noiseFloor,
    disk: { bytes, perPage: done.length ? Math.round(bytes / done.length) : 0, freeBeforeGB: free, freeAfterGB: freeAfter },
  };
  if (errors.length) {
    report.warnings.push(`The original could not be measured at ${errors.length} ${errors.length === 1 ? 'viewport' : 'viewports'}; the rest were measured.`);
  }
}

/**
 * Has the original changed since its baseline? One conditional request per page, no browser, cheapest check first.
 * Never decides on its own to capture again: the app offers that.
 * @param {{ pages: object[], recipeVersion?: number, slotIds?: string[] }} baseline
 * @returns {Promise<{ status: 'fresh'|'maybe-stale'|'stale'|'unknown', reasons: string[], pages: object[] }>}
 */
export async function checkBaseline(baseline, { now = Date.now(), fetch: fetcher = guardedFetch, days = BASELINE_STALE_DAYS } = {}) {
  const reasons = [];
  const pages = [];
  if (baseline?.recipeVersion !== undefined && baseline.recipeVersion !== RECIPE_VERSION) {
    // Nothing needs asking: the baseline was taken a different way, so it is not comparable.
    return { status: 'stale', reasons: ['the way a page is loaded for measuring has changed'], pages: [] };
  }
  let stale = 0;
  let unknown = 0;
  for (const page of baseline?.pages ?? []) {
    const print = page.fingerprint;
    if (!print) {
      pages.push({ path: page.path, status: 'unknown', reason: 'no fingerprint was saved' });
      unknown++;
      continue;
    }
    const headers = {};
    if (print.etag) headers['If-None-Match'] = print.etag;
    if (print.lastModified) headers['If-Modified-Since'] = print.lastModified;
    const hop = await fetcher(page.url, { headers, timeout: 15000 }).catch(() => ({ error: 'error' }));
    if (hop.error || !hop.res) {
      pages.push({ path: page.path, status: 'unknown', reason: 'the page could not be read' });
      unknown++;
      continue;
    }
    if (hop.res.status === 304) {
      pages.push({ path: page.path, status: 'fresh', reason: 'unchanged since the baseline' });
      await hop.res.body?.cancel().catch(() => {});
      continue;
    }
    const html = await hop.res.text().catch(() => '');
    const verdict = compareFingerprint(print, html);
    pages.push({ path: page.path, ...verdict });
    if (verdict.status === 'stale') stale++;
  }
  const age = baseline?.capturedAt ? (now - new Date(baseline.capturedAt).getTime()) / 86400000 : 0;
  if (stale) reasons.push(`${stale} ${stale === 1 ? 'page has' : 'pages have'} changed since the baseline`);
  if (!stale && age > days) reasons.push(`the baseline is ${Math.floor(age)} days old`);
  if (unknown) reasons.push(`${unknown} ${unknown === 1 ? 'page' : 'pages'} could not be checked`);
  const status = stale ? 'stale' : (age > days ? 'maybe-stale' : (unknown && unknown === pages.length ? 'unknown' : 'fresh'));
  return { status, reasons, pages };
}
