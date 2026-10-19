// @ts-check
// Every picture and video the page offers, recorded in the capture's network record (CLONER_SPEC Phase 1 item 1 and the
// preserve-original rule that every asset a component uses is stored locally). A browser loads only the srcset candidate
// its window needs and streams a video only when it plays, so a copy made from the record alone would miss the others.
// The page itself fetches each one (no-cors: the same cookies and proxy as the page, nothing executed) and the record's
// response tap (audit/sharedCache.js tapContext) stores it like any other response. Nothing in the page changes.

/** Time allowed for all of them together (ms). The rest of the capture is not held up by a slow server. */
export const VARIANTS_BUDGET_MS = 45000;
/** At most this many files are fetched (a page with hundreds of variants is reported, not fetched without end). */
export const MAX_VARIANTS = 400;

/**
 * The absolute URLs of every srcset candidate, picture source, video source and poster on the page.
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}
 */
export async function listMediaUrls(page) {
  return page.evaluate((max) => {
    const out = new Set();
    const add = (/** @type {string|null} */ raw) => {
      if (!raw) return;
      try {
        const url = new URL(raw, document.baseURI).href;
        if (/^https?:/i.test(url)) out.add(url.split('#')[0]);
      } catch {
        // Not a URL.
      }
    };
    for (const el of document.querySelectorAll('img, source, video, audio')) {
      add(el.getAttribute('src'));
      add(el.getAttribute('poster'));
      for (const part of (el.getAttribute('srcset') ?? '').split(',')) add(part.trim().split(/\s+/)[0]);
    }
    return [...out].slice(0, max);
  }, MAX_VARIANTS);
}

/**
 * Makes the page fetch every URL in `urls`, so the record holds them. Returns what was asked and what answered.
 * @param {import('playwright').Page} page
 * @param {string[]} urls
 * @param {{ budgetMs?: number }} [o]
 */
export async function fetchVariants(page, urls, { budgetMs = VARIANTS_BUDGET_MS } = {}) {
  if (!urls.length) return { asked: 0, answered: 0 };
  const run = page.evaluate(async (list) => {
    const answers = await Promise.all(list.map((u) => fetch(u, { mode: 'no-cors', cache: 'no-store' })
      .then(() => true, () => false)));
    return answers.filter(Boolean).length;
  }, urls);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(-1), budgetMs));
  const answered = await Promise.race([run, timeout]);
  return { asked: urls.length, answered: answered < 0 ? 0 : answered, timedOut: answered < 0 };
}

/**
 * The capture step: records every picture and video of the page (the desktop view runs it once per page).
 * @param {import('playwright').Page} page
 */
export async function recordVariants(page) {
  const urls = await listMediaUrls(page);
  // A video above VIDEO_MAX_BYTES is not kept (the copy shows its poster instead, behavior/preserve/fetch.js). A video whose
  // size the server does not say is kept, and the record's own per-file limit still applies.
  const sizes = await Promise.all(urls.map((u) => (MEDIA_EXT.test(u) ? sizeOf(page, u) : Promise.resolve(0))));
  const kept = urls.filter((u, i) => !(sizes[i] > VIDEO_MAX_BYTES));
  const skipped = urls.length - kept.length;
  const result = await fetchVariants(page, kept);
  return { ...result, skippedTooLarge: skipped };
}

/** Video and audio addresses. */
const MEDIA_EXT = /\.(mp4|webm|mov|m4v|ogv|mp3|wav|ogg)(\?|$)/i;
/** Largest video kept for a preserved component (bytes). Mirrors behavior/preserve/fetch.js VIDEO_MAX_BYTES. */
export const VIDEO_MAX_BYTES = 25 * 1024 * 1024;

/** The size the server says a file has (content-length of a HEAD request), or 0 when it does not say. */
async function sizeOf(page, url) {
  try {
    const res = await page.context().request.head(url, { timeout: 5000 });
    return Number(res.headers()['content-length']) || 0;
  } catch {
    return 0;
  }
}
