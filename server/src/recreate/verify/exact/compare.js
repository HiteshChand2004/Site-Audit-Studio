// The comparison: the copy rendered at the same viewports the original was measured at, by the same recipe and the
// same freeze, and the two sides put side by side pixel for pixel and box for box.
//
// The copy is rendered with its JavaScript running. Every other measurement in the pipeline renders it with JS off,
// deliberately, for determinism - but our own js/motion.js is what materialises state templates, parks the parts the
// stylesheet hides at the current width and plays load entrances, so with JS off the page being measured is one no
// visitor ever sees. The safety gate has already proved that the only script present is that one fixed file
// (verify/safety.js fails the job otherwise), so there is nothing new to trust here; determinism comes from the
// freeze instead of from disabling the script. A copy that ships no script renders the same either way.
//
// Everything else about the render stays as strict as it was: a context per slot, every request to another origin
// aborted, service workers blocked.
import { mkdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import sharp from 'sharp';
import { MAX_HEIGHT, MOBILE_UA } from '../../../audit/screenshots.js';
import { USER_AGENT } from '../../../audit/http.js';
import { launchBrowser } from '../../../audit/render.js';
import { startSiteServer } from '../server.js';
import { bandFile, boxesFile, exactDir, shootBands, MAX_BANDS, SLOT_TIMEOUT_MS } from '../../capture/exact.js';
import { collectExactBoxes, compareBoxes } from './boxes.js';
import { freezePage, freezeTimers, frozenSummary } from './freeze.js';
import { settleExact } from './recipe.js';
import { diffRegions, exactDiff, writeDiffMap } from './pixels.js';

/** Acceptance, from the user: the page is as tall, the pixels agree, and every box is where it should be. */
export const DIFF_LIMIT_PCT = 0.5;
/** A page whose height is this far out is not a slot with a few wrong boxes; it is a different page. */
export const HEIGHT_TOLERANCE_PX = 1;
/** Crops kept for a slot that failed, biggest difference first. */
export const MAX_CROPS = 3;
export const CROP_ZOOM = 3;
export const CROP_PAD = 24;

export const fidelityExactDir = (workspace, slug) => path.join(workspace, 'fidelity', slug, 'exact');
export const copyBand = (slotId, band) => `copy-${bandFile(slotId, band)}`;
export const mapFile = (slotId) => `${slotId}-map.webp`;
export const cropFile = (slotId, n) => `${slotId}-crop${n}.webp`;

/** The copy, served locally and opened per slot with its own emulation. */
export async function openExactRenderer(root, { scripts = true } = {}) {
  const server = await startSiteServer(root);
  const browser = await launchBrowser();
  return {
    origin: server.origin,
    server,
    browser,
    async context(slot) {
      const context = await browser.newContext({
        viewport: { width: slot.width, height: slot.height },
        deviceScaleFactor: slot.dpr,
        isMobile: slot.mobile,
        hasTouch: slot.hasTouch,
        userAgent: slot.mobile ? MOBILE_UA : USER_AGENT,
        javaScriptEnabled: scripts,
        ignoreHTTPSErrors: true,
        serviceWorkers: 'block',
      });
      await context.addInitScript(freezeTimers);
      // The copy must load nothing from anywhere else; if it tries, that is a defect and the request is recorded.
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(server.origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
        return route.abort();
      });
      return context;
    },
    async close() {
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

/** A magnified look at one difference: the original above, the copy below, at the pixels that were compared. */
async function writeCrop(originalFile, copyFile, region, out, { width, height }) {
  const x = Math.max(0, Math.round(region.x) - CROP_PAD);
  const y = Math.max(0, Math.round(region.y) - CROP_PAD);
  const w = Math.min(width - x, Math.round(region.w) + CROP_PAD * 2);
  const h = Math.min(height - y, Math.round(region.h) + CROP_PAD * 2);
  if (w < 2 || h < 2) return null;
  const take = async (file) => sharp(await readFile(file))
    .extract({ left: x, top: y, width: w, height: h })
    // Nearest neighbour: a magnified look at the pixels that were compared, not a smoothed guess at them.
    .resize({ width: w * CROP_ZOOM, height: h * CROP_ZOOM, kernel: 'nearest' })
    .png()
    .toBuffer();
  const [a, b] = await Promise.all([take(originalFile), take(copyFile)]);
  const gap = 8;
  await sharp({
    create: {
      width: w * CROP_ZOOM, height: h * CROP_ZOOM * 2 + gap, channels: 3, background: { r: 240, g: 240, b: 240 },
    },
  })
    .composite([{ input: a, top: 0, left: 0 }, { input: b, top: h * CROP_ZOOM + gap, left: 0 }])
    .webp({ quality: 85 })
    .toFile(out);
  return { file: path.basename(out), x, y, w, h, zoom: CROP_ZOOM, pixels: region.pixels };
}

/** The boxes the pixel count must not blame the copy for: a third-party frame, a canvas, a video. */
const maskAreas = (boxes) => boxes
  .filter((b) => b.kind === 'frame' || b.kind === 'media')
  .map((b) => ({ x: b.rect[0], y: b.rect[1], w: b.rect[2], h: b.rect[3], cause: b.kind === 'frame' ? 'third-party-frame' : 'image-content' }));

/**
 * One page at one slot.
 * @param {{ renderer: object, slot: object, baseline: object, page: object, workspace: string, deadline?: number,
 *   cpathOf?: Function, noise?: number }} o  baseline: the slot's entry from the capture's exact/index.json
 */
export async function compareSlot({
  renderer, slot, baseline, page, workspace, deadline = Infinity, cpathOf = null, noise = 0, excludedTexts = null,
}) {
  const started = Date.now();
  const outDir = fidelityExactDir(workspace, page.slug);
  const inDir = exactDir(workspace, page.slug);
  await mkdir(outDir, { recursive: true });
  const context = await renderer.context(slot);
  const consoleErrors = [];
  const failed = [];
  try {
    const p = await context.newPage();
    p.on('console', (m) => {
      if ((m.type() === 'error' || m.type() === 'warning') && consoleErrors.length < 20) {
        consoleErrors.push({ type: m.type(), text: m.text().slice(0, 300) });
      }
    });
    p.on('pageerror', (e) => {
      if (consoleErrors.length < 20) consoleErrors.push({ type: 'pageerror', text: String(e.message).slice(0, 300) });
    });
    context.on('requestfailed', (req) => {
      // A request the copy makes to another origin is aborted by the route above: that is the defect, not the abort.
      if (failed.length < 20) failed.push({ url: req.url().slice(0, 300), reason: req.failure()?.errorText ?? 'failed' });
    });

    await p.goto(`${renderer.origin}/${page.outPath}`, { waitUntil: 'domcontentloaded', timeout: SLOT_TIMEOUT_MS });
    const recipe = await settleExact(p, slot, { cap: MAX_HEIGHT * MAX_BANDS, deadline });
    const frozen = await freezePage(p);
    const index = await p.evaluate(collectExactBoxes, {});

    // Shot by the same function as the original, into the fidelity folder, at the same band offsets.
    const bands = await shootBands(p, slot, recipe.height, outDir, `copy-${slot.id}`);

    // The original's index, read before anything is compared: what the copy left out on purpose (ir/exclude.js)
    // must not be counted against it, neither as a missing box nor as a differing pixel.
    let theirs = null;
    let excludedBoxes = 0;
    const exclude = maskAreas(index.boxes);
    if (baseline.boxes?.file) {
      const saved = JSON.parse(gunzipSync(await readFile(path.join(inDir, baseline.boxes.file))));
      theirs = saved.boxes;
      if (excludedTexts?.size) {
        const keep = [];
        for (const b of theirs) {
          if (b.key && excludedTexts.has(b.key)) {
            excludedBoxes++;
            exclude.push({ x: b.rect[0], y: b.rect[1], w: b.rect[2], h: b.rect[3], cause: 'excluded' });
          } else keep.push(b);
        }
        theirs = keep;
      }
    }

    // Pixels, band by band, so a tall page never holds more than one band of each side in memory.
    let diff = 0;
    let antialiased = 0;
    let masked = 0;
    let compared = 0;
    let regions = [];
    let blocks = null;
    const bandRows = Math.min(baseline.bands.length, bands.length);
    for (let band = 0; band < bandRows; band++) {
      const theirs = path.join(inDir, baseline.bands[band].file);
      const ours = path.join(outDir, bands[band].file);
      const r = await exactDiff(theirs, ours, { exclude, offsetY: baseline.bands[band].top });
      diff += r.diff;
      antialiased += r.antialiased;
      masked += r.masked;
      compared += r.compared;
      if (band === 0) {
        blocks = r.blocks;
        regions = diffRegions(r).map((x) => ({ ...x, y: x.y + baseline.bands[band].top }));
      }
    }
    const heightOriginal = baseline.pageHeight;
    const heightCopy = recipe.height;
    const heightOnlyOne = Math.abs(heightOriginal - heightCopy) * slot.width;
    const total = compared + heightOnlyOne;
    const diffRaw = total ? Math.round(((diff + heightOnlyOne) / total) * 1e6) / 1e4 : 0;

    // Boxes, against the index saved with the baseline.
    const boxes = theirs ? compareBoxes(theirs, index.boxes, { cpathOf }) : null;

    // Only a slot that failed keeps pictures: a map of where, and the worst few places magnified.
    const limit = Math.max(DIFF_LIMIT_PCT, noise * 2);
    const heightOk = Math.abs(heightOriginal - heightCopy) <= HEIGHT_TOLERANCE_PX;
    const pixelsOk = diffRaw <= limit;
    const boxesOk = !boxes || (boxes.missing === 0 && boxes.extra === 0 && boxes.within === boxes.paired);
    const accepted = heightOk && pixelsOk && boxesOk;
    const crops = [];
    let map = null;
    if (!accepted && blocks) {
      map = (await writeDiffMap({ blocks }, path.join(outDir, mapFile(slot.id))).catch(() => null))?.file
        ?? null;
      if (map) map = mapFile(slot.id);
      for (const [i, region] of regions.slice(0, MAX_CROPS).entries()) {
        const crop = await writeCrop(
          path.join(inDir, baseline.bands[0].file),
          path.join(outDir, bands[0].file),
          region,
          path.join(outDir, cropFile(slot.id, i + 1)),
          { width: slot.width, height: Math.min(baseline.bands[0].height, bands[0].height) },
        ).catch(() => null);
        if (crop) crops.push(crop);
      }
    }

    return {
      id: slot.id,
      width: slot.width,
      height: slot.height,
      dpr: slot.dpr,
      origin: slot.origin,
      heightOriginal,
      heightCopy,
      bands: bands.length,
      bandsOriginal: baseline.bands.length,
      diffRaw,
      diffPixels: diff,
      antialiased,
      masked,
      masks: exclude.reduce((acc, a) => {
        acc[a.cause] = (acc[a.cause] ?? 0) + 1;
        return acc;
      }, {}),
      compared,
      limit,
      noise,
      ...(boxes && { boxes }),
      ...(excludedBoxes && { excludedBoxes }),
      heightOk,
      pixelsOk,
      boxesOk,
      accepted,
      frozen: frozenSummary(baseline.frozen, frozen),
      ...(consoleErrors.length && { consoleErrors }),
      ...(failed.length && { failedRequests: failed }),
      ...(map && { map }),
      ...(crops.length && { crops }),
      recipe: { steps: recipe.steps, reachedBottom: recipe.reachedBottom, stoppedBy: recipe.stoppedBy },
      ...(recipe.origin?.hover && { hoverAtOrigin: true }),
      ms: Date.now() - started,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Every page at every slot the baseline has.
 *
 * A page costs about four minutes here, so a finished one can be handed to `onPage` and given back through `done` on
 * a later attempt: a pass interrupted on its last page then costs that page instead of all of them.
 * @param {{ root: string, workspace: string, baseline: object, pages: object[], scripts?: boolean,
 *   cpathOf?: Function, deadline?: number, progress?: Function, noise?: object,
 *   done?: (slug: string) => object|null, onPage?: (result: object) => Promise<void> }} o
 */
export async function compareExact({
  root, workspace, baseline, pages, scripts = true, cpathOf = null, deadline = Infinity, progress = null, noise = {},
  excluded = [], done = null, onPage = null, overrides = null,
}) {
  const renderer = await openExactRenderer(root, { scripts });
  // Pages served from memory instead of from disk: the same build with element ids added, so a box can be paired
  // with the one it was built from. Everything else - the stylesheet, the images, the fonts - still comes from the
  // build on disk, and the attribute cannot paint.
  for (const [outPath, html] of overrides ?? []) renderer.server.overrides.set(outPath, html);
  const out = [];
  const errors = [];
  let reused = 0;
  try {
    for (const [i, page] of pages.entries()) {
      const saved = baseline.pages.find((b) => b.slug === page.slug);
      if (!saved) {
        errors.push({ page: page.path, message: 'The original was not measured for this page.' });
        continue;
      }
      // Measured on an earlier attempt, with its evidence still on disk (checkpoint.js clearFidelity keeps it).
      const already = done?.(page.slug);
      if (already?.slots?.length) {
        out.push({ ...already, reused: true });
        for (const e of already.errors ?? []) errors.push(e);
        reused++;
        progress?.((i + 1) / pages.length, `Keeping the comparison of ${page.path} from the interrupted attempt`);
        continue;
      }
      const slots = [];
      for (const slotBaseline of saved.slots) {
        if (Date.now() > deadline) {
          errors.push({ page: page.path, slot: slotBaseline.id, message: 'Skipped: out of time.' });
          continue;
        }
        const slot = baseline.slots.find((s) => s.id === slotBaseline.id);
        if (!slot) continue;
        try {
          slots.push(await compareSlot({
            renderer, slot, baseline: slotBaseline, page, workspace, deadline, cpathOf, noise: noise[slot.id] ?? 0,
            excludedTexts: excludedFor(excluded, page.path),
          }));
        } catch (err) {
          errors.push({ page: page.path, slot: slotBaseline.id, message: String(err.message ?? err).split('\n')[0].slice(0, 200) });
        }
        progress?.((i + slots.length / Math.max(1, saved.slots.length)) / pages.length,
          `Comparing ${page.path} at ${slot?.width ?? ''}px`);
      }
      const result = { page: page.path, slug: page.slug, outPath: page.outPath, slots };
      out.push(result);
      // Written before the next page starts, so an interruption costs this pass one page at most. Its own errors
      // travel with it, or a kept page would come back looking cleaner than it was.
      if (slots.length) await onPage?.({ ...result, errors: errors.filter((e) => e.page === page.path) });
    }
  } finally {
    await renderer.close();
  }
  return { pages: out, errors, reused, ...summarise(out) };
}

/**
 * The text an excluded part painted, as the box index keys it (ir/exclude.js records the text; boxes.js lowercases
 * and collapses it). Used to take those boxes and their pixels out of the comparison on the original's side.
 */
export function excludedFor(excluded, pagePath) {
  const texts = new Set();
  for (const e of excluded ?? []) {
    if (e.page && e.page !== pagePath) continue;
    const key = String(e.text ?? '').replace(/s+/g, ' ').trim().toLowerCase();
    if (key) texts.add(key.slice(0, 120));
  }
  return texts;
}

/** One honest set of numbers for the report, and the causes of what is left. */
export function summarise(pages) {
  const slots = pages.flatMap((p) => p.slots);
  const accepted = slots.filter((s) => s.accepted).length;
  const causes = {};
  const bump = (cause, n = 1) => { causes[cause] = (causes[cause] ?? 0) + n; };
  for (const s of slots) {
    if (s.accepted) continue;
    if (!s.heightOk) bump('page-height');
    if (s.boxes?.missing) bump('missing-element', s.boxes.missing);
    if (s.boxes?.extra) bump('extra-element', s.boxes.extra);
    if (s.boxes && s.boxes.within < s.boxes.paired) bump('box-out-of-place', s.boxes.paired - s.boxes.within);
    if (!s.pixelsOk && s.heightOk) bump('pixels');
    if (s.consoleErrors?.length) bump('console-error', s.consoleErrors.length);
    if (s.failedRequests?.length) bump('failed-request', s.failedRequests.length);
    if (s.frozen?.loopsOnlyOriginal) bump('loop-missing', s.frozen.loopsOnlyOriginal);
  }
  const worst = [...slots]
    .filter((s) => !s.accepted)
    .sort((a, b) => b.diffRaw - a.diffRaw)
    .slice(0, 10)
    .map((s) => ({ slot: s.id, diffRaw: s.diffRaw, heightOriginal: s.heightOriginal, heightCopy: s.heightCopy, missing: s.boxes?.missing ?? 0 }));
  return {
    slots: slots.length,
    accepted,
    pct: slots.length ? Math.round((accepted / slots.length) * 100) : 0,
    diffWorst: slots.length ? Math.max(...slots.map((s) => s.diffRaw)) : 0,
    diffMean: slots.length ? Math.round((slots.reduce((n, s) => n + s.diffRaw, 0) / slots.length) * 1e4) / 1e4 : 0,
    causes,
    worst,
  };
}
