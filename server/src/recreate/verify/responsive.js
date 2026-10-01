// Responsive sweep, recreated side and comparison. The recreated site (dist/) is rendered at the same
// widths as the original was screenshotted (capture/sweep.js): locally only, page JavaScript off, like
// the fidelity check. Per width the two full-page screenshots are compared by
//   visual   = the perceptual score of the visual diff (visualDiff.js),
//   height   = generated page height against the original's,
//   overflow = a horizontal scrollbar the recreate has and the original does not.
// A width is flagged as drift when its visual score is under the visual-diff threshold (fidelity.js DIFF_THRESHOLD),
// its page height is off, or the recreate overflows sideways where the original does not; the sweep never fails a job.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { USER_AGENT } from '../../audit/http.js';
import { launchBrowser } from '../../audit/render.js';
import { encode, MAX_HEIGHT, MOBILE_UA } from '../../audit/screenshots.js';
import { sweepFile, sweepView } from '../capture/sweep.js';
import { DIFF_THRESHOLD } from './fidelity.js';
import { loadLazyImages } from './layout.js';
import { visualDiff } from './visualDiff.js';
import { startSiteServer } from './server.js';

export const SWEEP_WEIGHTS = { visual: 0.65, height: 0.35 };
const OVERFLOW_PENALTY = 15;
// An overflow this share of the screen width (or more) costs the whole penalty.
const OVERFLOW_FULL = 0.15;
// A page taller or shorter by more than this share (and 80 px) is flagged.
const HEIGHT_TOLERANCE = 0.08;
const OVERFLOW_SLACK = 2;

/** Chromium plus one context per sweep width, bound to a local server for `root`. */
export async function openSweepRenderer(root, widths) {
  const server = await startSiteServer(root);
  let browser;
  try {
    browser = await launchBrowser();
    const contexts = {};
    for (const width of widths) {
      const view = sweepView(width);
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        deviceScaleFactor: 1,
        isMobile: view.mobile,
        hasTouch: view.mobile,
        userAgent: view.mobile ? MOBILE_UA : USER_AGENT,
        javaScriptEnabled: false,
        serviceWorkers: 'block',
      });
      await context.route('**/*', (route) => (route.request().url().startsWith(`${server.origin}/`) ? route.continue() : route.abort('blockedbyclient')));
      contexts[width] = context;
    }
    return {
      server,
      contexts,
      close: async () => {
        await browser.close().catch(() => {});
        await server.close();
      },
    };
  } catch (err) {
    await browser?.close().catch(() => {});
    await server.close();
    throw err;
  }
}

/** Renders one page of the recreated site at `width`. */
export async function renderSweepPage(renderer, outPath, width, { timeout = 15000 } = {}) {
  const page = await renderer.contexts[width].newPage();
  try {
    const response = await page.goto(`${renderer.server.origin}/${outPath}`, { waitUntil: 'load', timeout });
    if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status() ?? 0}`);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await loadLazyImages(page);
    const size = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    }));
    const png = await page.screenshot({
      type: 'png',
      fullPage: true,
      animations: 'disabled',
      clip: { x: 0, y: 0, width, height: Math.max(1, Math.min(size.height, MAX_HEIGHT)) },
    });
    return { ...size, png };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Score and drift flags of one width.
 * @param {number} width
 * @param {{ height: number, scrollWidth: number }} original
 * @param {{ height: number, scrollWidth: number }} generated
 * @param {number|null} visual  0–1, null when a screenshot is missing
 */
export function compareWidth(width, original, generated, visual, threshold = DIFF_THRESHOLD) {
  const ratio = original.height > 0 ? generated.height / original.height : 1;
  const heightScore = Math.max(0, 1 - Math.abs(1 - ratio) * 4);
  // Sideways overflow the recreate has and the original does not, in px. The penalty grows with it (up to
  // OVERFLOW_PENALTY at OVERFLOW_FULL of the screen width, at least 1 point for any), so a partial fix shows.
  const excess = (m) => Math.max(0, m.scrollWidth - width - OVERFLOW_SLACK);
  const overflowPx = Math.max(0, excess(generated) - excess(original));
  const newOverflow = overflowPx > 0;
  const penalty = newOverflow ? Math.max(1, Math.round(OVERFLOW_PENALTY * Math.min(1, overflowPx / (OVERFLOW_FULL * width)))) : 0;
  const raw = visual == null ? heightScore : visual * SWEEP_WEIGHTS.visual + heightScore * SWEEP_WEIGHTS.height;
  const score = Math.max(0, Math.round(raw * 100) - penalty);
  const flags = [];
  if (Math.abs(generated.height - original.height) > 80 && Math.abs(1 - ratio) > HEIGHT_TOLERANCE) flags.push(ratio > 1 ? 'taller' : 'shorter');
  if (newOverflow) flags.push('overflow');
  if (visual != null && visual * 100 < threshold) flags.push('visual');
  return {
    width,
    score,
    visual,
    height: { original: original.height, generated: generated.height, ratio: Math.round(ratio * 1000) / 1000 },
    scrollWidth: { original: original.scrollWidth, generated: generated.scrollWidth },
    overflowPx,
    flags,
    low: flags.length > 0,
  };
}

/** Compares the original sweep of one page with its recreated render and stores the generated shots. */
export async function compareSweepPage({ renderer, workspace, page, original, widths }) {
  const dir = path.join(workspace, 'fidelity', page.slug, 'sweep');
  await mkdir(dir, { recursive: true });
  const out = {};
  for (const width of widths) {
    const o = original.widths[width];
    if (!o) {
      out[width] = { width, error: original.errors.find((e) => e.width === width)?.message ?? 'The original could not be captured at this width.' };
      continue;
    }
    try {
      const g = await renderSweepPage(renderer, page.outPath, width);
      await encode(g.png, path.join(dir, sweepFile(width)));
      const visual = await visualDiff(path.join(workspace, 'capture', page.slug, o.file), g.png).then((d) => d.score, () => null);
      out[width] = { ...compareWidth(width, o, g, visual), original: o.file, generatedFile: `fidelity/${page.slug}/sweep/${sweepFile(width)}`, truncated: o.truncated };
    } catch (err) {
      out[width] = { width, error: `The recreated page could not be rendered at this width: ${err.message.split('\n')[0]}` };
    }
  }
  return out;
}

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * Assembles report.responsive from the per-page results.
 * @param {{ path: string, outPath: string, slug: string, widths: Record<number, object> }[]} pages
 * @returns {{ responsive: object, warnings: string[] }}
 */
export function summarizeSweep(pages, widths, { skipped = [], threshold = DIFF_THRESHOLD } = {}) {
  const rows = pages.map((p) => {
    const measured = Object.values(p.widths).filter((w) => w.score != null);
    return {
      path: p.path,
      outPath: p.outPath,
      slug: p.slug,
      score: mean(measured.map((w) => w.score)),
      drift: measured.filter((w) => w.low).map((w) => w.width),
      widths: p.widths,
    };
  });
  const all = rows.flatMap((p) => Object.values(p.widths).filter((w) => w.score != null).map((w) => ({ path: p.path, ...w })));
  const byWidth = Object.fromEntries(widths.map((w) => [w, mean(all.filter((x) => x.width === w).map((x) => x.score))]));
  const worst = all.filter((w) => w.low).sort((a, b) => a.score - b.score).slice(0, 8)
    .map((w) => ({ path: w.path, width: w.width, score: w.score, flags: w.flags }));
  const responsive = {
    status: 'done',
    method: 'Screenshots of the original and of the recreated site (JavaScript off) at each sweep width, compared by rough visual similarity, page height and horizontal overflow.',
    weights: SWEEP_WEIGHTS,
    widths,
    threshold,
    score: mean(all.map((w) => w.score)),
    byWidth,
    driftCount: all.filter((w) => w.low).length,
    measured: all.length,
    worst,
    pages: rows,
    skipped,
  };
  const warnings = [];
  if (responsive.driftCount) {
    const list = worst.slice(0, 4).map((w) => `${w.path} at ${w.width}px (${w.score})`).join(', ');
    warnings.push(`The layout drifts from the original at ${responsive.driftCount} of ${responsive.measured} measured page widths between the captured sizes: ${list}${worst.length > 4 ? ', …' : ''}.`);
  }
  if (skipped.length) {
    warnings.push(`The responsive sweep was not run for ${skipped.length} ${skipped.length === 1 ? 'page' : 'pages'} (time limit): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}.`);
  }
  return { responsive, warnings };
}
