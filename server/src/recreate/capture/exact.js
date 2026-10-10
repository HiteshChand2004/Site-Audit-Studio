// The original, at every viewport an exact copy is measured at. One visit per slot, with the shared loading recipe
// and the shared freeze, saving what the comparison needs: a full-page shot, the index of what the page paints, the
// page's height, and the console errors and failed requests of that visit.
//
// The original's truth is collected here rather than fetched again at compare time (the user's decision): a
// correction round then costs no network, works when the site is down, and can be repeated offline as many times as
// the loop needs. The price is that a baseline can go stale, so every page also gets a fingerprint cheap enough to
// re-check with one conditional request (recreate/exactCapture.js).
//
// Screenshots are taken with `scale: 'css'`, one image pixel per CSS pixel, while the page still believes it is a
// dpr-3 phone. That keeps the layout and the srcset choice honest and the comparison affordable - and it avoids a
// hard wall: WebP cannot hold an image past 16383 px, which at dpr 3 is reached by any page taller than 5461 CSS px.
// A page taller than one band is stored as several, at the same offsets the copy will be shot at.
import { gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { MAX_HEIGHT, MOBILE_UA } from '../../audit/screenshots.js';
import { USER_AGENT } from '../../audit/http.js';
import { collectExactBoxes } from '../verify/exact/boxes.js';
import { fingerprintOf } from '../verify/exact/fingerprint.js';
import { freezePage, freezeTimers } from '../verify/exact/freeze.js';
import { settleExact } from '../verify/exact/recipe.js';

export const EXACT_DIR = 'exact';
/** Bands of MAX_HEIGHT CSS px each: four is 32 000 px of page, past which a tail is reported, never silently cut. */
export const MAX_BANDS = 4;
export const SLOT_TIMEOUT_MS = 90000;
const MAX_CONSOLE = 20;

export const exactDir = (workspace, slug) => path.join(workspace, 'capture', slug, EXACT_DIR);
export const bandFile = (slotId, band) => (band === 0 ? `${slotId}-full.webp` : `${slotId}-b${band}.webp`);
export const boxesFile = (slotId) => `${slotId}-boxes.json.gz`;

/**
 * What a cheap staleness check compares against later. Taken from the response **as the server sent it**, not from
 * the rendered DOM: the check re-reads the page with one conditional request and has only that to compare, so both
 * sides must be the same measurement (verify/exact/fingerprint.js).
 */
export async function pageFingerprint(response) {
  if (!response) return null;
  const [headers, html] = await Promise.all([
    response.allHeaders().catch(() => ({})),
    response.text().catch(() => ''),
  ]);
  if (!html) return null;
  return fingerprintOf(html, headers, response.status());
}

/** The page in bands of MAX_HEIGHT CSS px, at the offsets the copy will be shot at too. */
async function shootBands(page, slot, pageHeight, dir, slotId) {
  const bands = [];
  const wanted = Math.min(pageHeight, MAX_HEIGHT * MAX_BANDS);
  for (let band = 0; band * MAX_HEIGHT < wanted; band++) {
    const top = band * MAX_HEIGHT;
    const height = Math.min(MAX_HEIGHT, wanted - top);
    const png = await page.screenshot({
      type: 'png',
      fullPage: true,
      scale: 'css',
      animations: 'allow',
      clip: { x: 0, y: top, width: slot.width, height },
    });
    const file = bandFile(slotId, band);
    const info = await sharp(png).webp({ quality: 85 }).toFile(path.join(dir, file));
    bands.push({ band, top, height, file, bytes: info.size });
  }
  return bands;
}

/**
 * One slot of one page.
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {object} slot  from verify/exact/slots.js
 * @param {string} dir   the page's exact/ folder
 * @param {{ cache?: object, timeout?: number, deadline?: number, boxes?: boolean, fingerprint?: boolean, write?: boolean }} [o]
 */
export async function visitSlot(browser, url, slot, dir, {
  cache = null, timeout = SLOT_TIMEOUT_MS, deadline = Infinity, boxes = true, fingerprint = false, write = true,
} = {}) {
  const started = Date.now();
  const context = await browser.newContext({
    viewport: { width: slot.width, height: slot.height },
    deviceScaleFactor: slot.dpr,
    isMobile: slot.mobile,
    hasTouch: slot.hasTouch,
    userAgent: slot.mobile ? MOBILE_UA : USER_AGENT,
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });
  const consoleErrors = [];
  const failed = [];
  try {
    // Before any of the page's own script: no interval, no timer of a second or more (verify/exact/freeze.js).
    await context.addInitScript(freezeTimers);
    await cache?.attach(context);
    context.on('requestfailed', (req) => {
      if (failed.length < MAX_CONSOLE) failed.push({ url: req.url().slice(0, 300), reason: req.failure()?.errorText ?? 'failed' });
    });
    const page = await context.newPage();
    // Console messages are not recorded anywhere else in the pipeline, and a copy that throws is a defect.
    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return;
      if (consoleErrors.length < MAX_CONSOLE) consoleErrors.push({ type: msg.type(), text: msg.text().slice(0, 300) });
    });
    page.on('pageerror', (err) => {
      if (consoleErrors.length < MAX_CONSOLE) consoleErrors.push({ type: 'pageerror', text: String(err.message).slice(0, 300) });
    });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const recipe = await settleExact(page, slot, { cap: MAX_HEIGHT * MAX_BANDS, deadline });
    const frozen = await freezePage(page);
    const print = fingerprint ? await pageFingerprint(response) : null;

    const pageHeight = recipe.height;
    const bands = write ? await shootBands(page, slot, pageHeight, dir, slot.id) : [];
    let index = null;
    if (boxes) {
      index = await page.evaluate(collectExactBoxes, {});
      if (write) {
        await writeFile(path.join(dir, boxesFile(slot.id)), gzipSync(Buffer.from(JSON.stringify(index))));
      }
    }

    return {
      id: slot.id,
      width: slot.width,
      height: slot.height,
      dpr: slot.dpr,
      origin: slot.origin,
      pageHeight,
      scrollWidth: recipe.scrollWidth,
      truncated: pageHeight > MAX_HEIGHT * MAX_BANDS,
      bands,
      ...(index && {
        boxes: {
          ...(write && { file: boxesFile(slot.id) }),
          count: index.boxes.length,
          truncated: index.truncated,
          counts: index.counts,
          ...(!write && { list: index.boxes }),
        },
      }),
      recipe,
      frozen,
      ...(consoleErrors.length && { consoleErrors }),
      ...(failed.length && { failed }),
      ...(print && { fingerprint: print }),
      bytes: bands.reduce((n, b) => n + b.bytes, 0),
      ms: Date.now() - started,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Every slot of one page, one at a time unless there is memory for two. A slot that fails is reported for that slot:
 * a page missing one viewport is still worth the nineteen it has.
 * @param {{ slots: object[], cache?: object, deadline?: number, atOnce?: number, noise?: boolean, progress?: Function }} o
 */
export async function captureExactPage(browser, pageInfo, workspace, {
  slots, cache = null, deadline = Infinity, atOnce = 1, noise = false, progress = null, timeout = SLOT_TIMEOUT_MS,
} = {}) {
  const dir = exactDir(workspace, pageInfo.slug);
  await mkdir(dir, { recursive: true });
  const done = [];
  const errors = [];
  let fingerprint = null;
  let noiseFloor = null;

  const queue = [...slots];
  const runner = async () => {
    for (;;) {
      const slot = queue.shift();
      if (!slot) return;
      if (Date.now() > deadline) {
        errors.push({ slot: slot.id, message: 'Skipped: out of time.' });
        continue;
      }
      try {
        const first = await visitSlot(browser, pageInfo.url, slot, dir, {
          cache, timeout, deadline, fingerprint: !fingerprint,
        });
        fingerprint ??= first.fingerprint ?? null;
        // The same original, visited twice: how much a page differs from itself is the floor below which no
        // difference between the original and the copy means anything (recreate/exactCapture.js reads this).
        if (noise) {
          const again = await visitSlot(browser, pageInfo.url, slot, dir, {
            cache, timeout, deadline, boxes: false, write: false,
          });
          first.noise = { pageHeight: again.pageHeight, sameHeight: again.pageHeight === first.pageHeight };
        }
        done.push(first);
        progress?.(done.length / slots.length, `Measuring the original at ${slot.width}px (${done.length} of ${slots.length})`);
      } catch (err) {
        errors.push({ slot: slot.id, message: String(err.message ?? err).split('\n')[0].slice(0, 200) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, atOnce) }, runner));

  done.sort((a, b) => b.width - a.width || b.height - a.height);
  const manifest = {
    slug: pageInfo.slug,
    path: pageInfo.path,
    url: pageInfo.url,
    capturedAt: new Date().toISOString(),
    slots: done,
    errors,
    fingerprint,
    bytes: done.reduce((n, s) => n + s.bytes, 0),
  };
  await writeFile(path.join(dir, 'index.json'), JSON.stringify(manifest, null, 1));
  return { ...manifest, noiseFloor };
}
