// Pictures of an as-is copy's pages, for the app's side-by-side views (the page gallery, Compare's "Picture"). The final check
// compares the copy with the original but keeps no picture of the copy, so one is taken when the app first asks for it: the
// copy is served from its folder and pictured the way the check pictures a site (audit/screenshots.js captureView: a
// scroll-through that lets sections that fade in on scroll appear, then the shot from the top). It is saved where a rebuilt
// copy's pictures are (fidelity/<slug>/<view>-full.webp), so the same address serves both.
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { VIEWS, captureView } from '../../../audit/screenshots.js';
import { serveCopy } from './serve.js';
import { ASIS_DIR } from './stage.js';

/** The views pictured on demand: the computer and the phone, the two widths the final check measures. */
export const PICTURED_VIEWS = new Set(['desktop', 'mobile']);

const exists = (file) => stat(file).then((s) => s.isFile(), () => false);

// One picture at a time on this server (a browser per picture is heavy); the same picture asked twice is made once.
let chain = Promise.resolve();
const making = new Map();

/**
 * Makes `<recreateDir>/fidelity/<slug>/<view>-full.webp` from the copy if it is not there yet. Resolves when it is made (or
 * failed: the picture is then simply missing and the next request tries again).
 * @param {{ dir: string, slug: string, pagePath: string, view: string }} o  dir: the copy's job folder; pagePath: "/about/"
 * @returns {Promise<boolean>}  whether the picture exists now
 */
export function makeCopyPicture({ dir, slug, pagePath, view }) {
  const spec = VIEWS.find((v) => v.id === view);
  if (!spec || !PICTURED_VIEWS.has(view)) return Promise.resolve(false);
  const outDir = path.join(dir, 'fidelity', slug);
  const file = path.join(outDir, `${view}-full.webp`);
  const key = file;
  if (making.has(key)) return making.get(key);
  const job = (chain = chain.then(async () => {
    if (await exists(file)) return true;
    const copyDir = path.join(dir, ASIS_DIR, 'copy');
    if (!(await stat(copyDir).then((s) => s.isDirectory(), () => false))) return false;
    await mkdir(outDir, { recursive: true });
    const served = await serveCopy(copyDir);
    const browser = await chromium.launch();
    try {
      await captureView(browser, `${served.url.replace(/\/$/, '')}${pagePath}`, spec, outDir, 30000, null);
      return exists(file);
    } catch {
      return false;
    } finally {
      await browser.close().catch(() => {});
      await served.close().catch(() => {});
    }
  }).catch(() => false)).finally(() => making.delete(key));
  making.set(key, job);
  return job;
}

/** Whether a picture of this view is being made now (the app is told to ask again shortly). */
export const isMaking = (dir, slug, view) => making.has(path.join(dir, 'fidelity', slug, `${view}-full.webp`));

/**
 * A picture of the ORIGINAL page that the copy's job folder lacks (capture/<slug>/<view>-<fold|full>.webp): a copy made with
 * "Rebuild from the last visit" does not visit the site, so it has no capture of its own, and the job it was rebuilt from may
 * be gone (only the latest copies keep their folders). Its as-is/baseline folder still holds the original's pictures (the
 * capture's full page, and the final check's pictures at 1440 and 390): the missing one is made from those and kept.
 * @param {string} dir   the copy's job folder
 * @param {string} slug
 * @param {string} file  e.g. "desktop-fold.webp"
 * @returns {Promise<boolean>}  whether the picture exists now
 */
export async function restoreOriginalPicture(dir, slug, file) {
  const m = file.match(/^(desktop|mobile)-(fold|full)\.webp$/);
  if (!m) return false;
  const [, view, kind] = m;
  const target = path.join(dir, 'capture', slug, file);
  if (await exists(target)) return true;
  const baseline = path.join(dir, ASIS_DIR, 'baseline');
  const sources = view === 'desktop' ? [`${slug}.webp`, `${slug}@1440.png`] : [`${slug}@390.png`];
  let source = null;
  for (const name of sources) if (await exists(path.join(baseline, name))) { source = path.join(baseline, name); break; }
  if (!source) return false;
  const { default: sharp } = await import('sharp');
  const meta = await sharp(source).metadata();
  // The first screen: 1440 × 900 on a computer, 375 × 812 on a phone, at the picture's own width.
  const foldRatio = view === 'desktop' ? 900 / 1440 : 812 / 375;
  const height = kind === 'fold' ? Math.min(meta.height, Math.round(meta.width * foldRatio)) : meta.height;
  await mkdir(path.dirname(target), { recursive: true });
  await sharp(source).extract({ left: 0, top: 0, width: meta.width, height }).webp({ quality: 75 }).toFile(target);
  return true;
}
