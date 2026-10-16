// @ts-check
// Step (b), HTML stack: each preserved component rendered on its own, offline, and checked against the original
// (CLONER_SPEC Phase 6 items 4 and 6: offline check, visual, hover, loops). A component is its shell (the ancestors as
// empty elements) + its markup + its CSS + its local files. Served from the component's folder on 127.0.0.1; every other
// request is aborted and counted, so a leak to the original site or a CDN is visible, never silent.
// The reference is the original as the exact baseline saved it (capture/exact bands, frozen), not a new capture.
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.gif': 'image/gif', '.json': 'application/json', '.avif': 'image/avif' };

/** Visual difference above this share of pixels fails a component (CLONER_SPEC: default threshold 3%). */
export const DIFF_LIMIT_PCT = 3;
/** Per-channel difference that counts a pixel as different. */
const CHANNEL_DELTA = 24;

/**
 * Writes render.html for a component: its shell, its markup in place of the marker, and a head that loads its own CSS.
 * @param {string} dir  the component folder (preserved/<id>)
 * @returns {Promise<{ file: string, rootRel: string }>}
 */
export async function writeRenderPage(dir) {
  const shell = await readFile(path.join(dir, 'shell.html'), 'utf8');
  const markup = await readFile(path.join(dir, 'markup.html'), 'utf8');
  // The component's own element gets a marker attribute, so the render step finds it without a selector.
  const marked = markup.replace(/^<([a-zA-Z0-9-]+)/, '<$1 data-sas-root=""');
  const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="styles.css">';
  const body = shell.replace('<!--sas-component-->', marked);
  const doc = /^<html[^>]*>/i.test(body)
    ? `<!doctype html>${body.replace(/^(<html[^>]*>)/i, `$1<head>${head}</head>`)}`
    : `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
  const file = path.join(dir, 'render.html');
  await writeFile(file, doc, 'utf8');
  return { file, rootRel: 'data-sas-root' };
}

/**
 * A static server for one folder on 127.0.0.1 (the render page and its files only).
 * @param {string} dir
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function serveFolder(dir) {
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'render.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(path.normalize(dir))) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r(undefined))) });
    });
  });
}

/**
 * Pixel difference of two same-size RGB images (share of pixels with a channel off by more than CHANNEL_DELTA).
 * @param {Buffer} a  raw RGB
 * @param {Buffer} b  raw RGB, same length
 */
export function pixelDiffPct(a, b) {
  const pixels = Math.min(a.length, b.length) / 3;
  if (!pixels) return 100;
  let diff = 0;
  for (let i = 0; i < pixels * 3; i += 3) {
    if (Math.abs(a[i] - b[i]) > CHANNEL_DELTA || Math.abs(a[i + 1] - b[i + 1]) > CHANNEL_DELTA || Math.abs(a[i + 2] - b[i + 2]) > CHANNEL_DELTA) diff++;
  }
  return Math.round((diff / pixels) * 10000) / 100;
}

/**
 * The original's pixels for a rectangle, from the exact baseline bands at the given width (the bands stack top to bottom).
 * @param {string} baselineDir  capture/<slug>/exact
 * @param {number} width
 * @param {number[]} rect       [x, y, w, h] in page px
 * @returns {Promise<{ data: Buffer, width: number, height: number }|null>} raw RGB of the rectangle, or null when the baseline does not cover it
 */
export async function referenceRect(baselineDir, width, rect) {
  const index = JSON.parse(await readFile(path.join(baselineDir, 'index.json'), 'utf8'));
  const slot = index.slots?.find((s) => Number(s.id) === width) ?? index.slots?.find((s) => s.width === width);
  if (!slot) return null;
  const [x, y, w, h] = rect.map((v) => Math.round(v));
  const bands = [...(slot.bands ?? [])].sort((p, q) => p.top - q.top);
  const covering = bands.filter((b) => b.top < y + h && b.top + b.height > y);
  if (!covering.length) return null;
  const pieces = [];
  for (const band of covering) {
    const top = Math.max(0, y - band.top);
    const bottom = Math.min(band.height, y + h - band.top);
    if (bottom <= top) continue;
    const piece = await sharp(path.join(baselineDir, band.file))
      .extract({ left: Math.max(0, x), top, width: Math.min(w, width - Math.max(0, x)), height: bottom - top })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    pieces.push(piece.data);
  }
  if (!pieces.length) return null;
  const width2 = Math.min(w, width - Math.max(0, x));
  const height2 = pieces.reduce((sum, p) => sum + p.length / 3 / width2, 0);
  return { data: Buffer.concat(pieces), width: width2, height: Math.round(height2) };
}

/** A file list of a folder (for the leak scan of the copy itself). */
export async function fileList(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await fileList(full)));
    else out.push(full);
  }
  return out;
}

/** Whether a stored copy file refers to an absolute address (an http(s) URL): a copy must not. */
export function absoluteRefs(text) {
  return [...text.matchAll(/(?:src|href|srcset|poster)\s*=\s*["']\s*https?:\/\/[^"']+|url\(\s*["']?https?:\/\/[^)"']+/gi)].map((m) => m[0]);
}

/** Steps of a capture path below its root: `body>section:1>div:2` under `body>section:1` → [`div:2`]. */
export function relSteps(rootPath, path) {
  if (!path.startsWith(`${rootPath}>`)) return null;
  return path.slice(rootPath.length + 1).split('>');
}

/**
 * In the page: the element at the relative steps below the marked root.
 * Runs inside the page (defined as a function for page.evaluate).
 */
export function elementAt(/** @type {string[]} */ steps) {
  let el = document.querySelector('[data-sas-root]');
  for (const step of steps) {
    const [tag, index] = step.split(':');
    const kids = Array.from(el?.children ?? []).filter((c) => c.tagName.toLowerCase() === tag);
    el = kids[Number(index) - 1] ?? null;
    if (!el) return null;
  }
  return el;
}

/**
 * Renders one component in a browser, offline, and measures it. Returns the measurements; nothing is written except its
 * screenshots next to the component (render/ folder).
 * @param {{ browser: import('playwright').Browser, dir: string, component: any, manifest: any, baselineDir: string,
 *   width?: number, outDir: string }} o
 */
export async function renderComponent({ browser, dir, component, manifest, baselineDir, width = 1440, outDir }) {
  await writeRenderPage(dir);
  const server = await serveFolder(dir);
  const leaks = [];
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  try {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(server.url)) return route.continue();
      leaks.push(url.split('?')[0].slice(0, 160));
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
    await page.goto(`${server.url}render.html`, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => document.fonts?.ready);
    await page.addScriptTag({ content: `window.__elementAt = ${elementAt.toString()};` });
    await page.waitForTimeout(600);

    // Loops: how many CSS animations of this component are running (the capture recorded them as declared).
    const expectedLoops = (manifest.signals ?? []).filter((s) => s.kind === 'loop' && s.driver === 'css').length;
    const running = await page.evaluate(() => {
      const root = document.querySelector('[data-sas-root]');
      if (!root) return -1;
      return root.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length;
    });

    // Hover: the end values the capture read, reproduced by the copy's own CSS.
    const hovers = (manifest.signals ?? []).filter((s) => s.kind === 'hover' && s.driver === 'css' && s.expect);
    const hoverResults = [];
    for (const h of hovers) {
      const steps = relSteps(component.root, h.path);
      if (!steps) continue;
      const box = await page.evaluate((st) => {
        const el = (/** @type {any} */ window).__elementAt?.(st) ?? null;
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, steps).catch(() => null);
      if (!box) {
        hoverResults.push({ path: h.path, status: 'not-found' });
        continue;
      }
      await page.mouse.move(box.x, box.y);
      await page.waitForTimeout(700);
      const seen = await page.evaluate((arg) => {
        const el = (/** @type {any} */ window).__elementAt?.(arg.steps) ?? null;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return Object.fromEntries(Object.keys(arg.expect).map((p) => [p, cs.getPropertyValue(p)]));
      }, { steps, expect: h.expect }).catch(() => null);
      await page.mouse.move(0, 0);
      const bad = Object.entries(h.expect).filter(([p, want]) => normalize(seen?.[p]) !== normalize(want));
      hoverResults.push({ path: h.path, text: h.text ?? '', status: bad.length ? 'differs' : 'same', differs: bad.map(([p, want]) => ({ prop: p, want, got: seen?.[p] ?? null })) });
    }
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);

    // Visual: the component as the copy draws it, against the original's pixels at the same place.
    const shot = await page.locator('[data-sas-root]').first().screenshot({ animations: 'disabled', type: 'png' });
    const copyRaw = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const reference = await referenceRect(baselineDir, width, component.rect).catch(() => null);
    let diffPct = null;
    let refPng = null;
    if (reference) {
      // Both to the copy's size (the rectangle is rounded to whole pixels).
      const ref = await sharp(reference.data, { raw: { width: reference.width, height: reference.height, channels: 3 } })
        .resize(copyRaw.info.width, copyRaw.info.height).raw().toBuffer();
      diffPct = pixelDiffPct(copyRaw.data, ref);
      refPng = path.join(outDir, `${component.id}-original.png`);
      await sharp(ref, { raw: { width: copyRaw.info.width, height: copyRaw.info.height, channels: 3 } }).png().toFile(refPng);
    }
    await mkdir(outDir, { recursive: true });
    const copyFile = path.join(outDir, `${component.id}-copy.png`);
    await writeFile(copyFile, shot);

    const leakOfCopy = await leakScan(dir);
    return {
      id: component.id,
      root: component.root,
      rect: component.rect,
      leaks: leaks.length,
      leakSamples: leaks.slice(0, 5),
      copyLinks: leakOfCopy,
      pageErrors: errors.slice(0, 5),
      diffPct,
      referenceCovered: Boolean(reference),
      loops: { expected: expectedLoops, running },
      hover: { checked: hoverResults.length, same: hoverResults.filter((r) => r.status === 'same').length, results: hoverResults },
      screenshots: { copy: copyFile, original: refPng },
    };
  } finally {
    await context.close();
    await server.close();
  }
}

/** Colour and value strings compared the way a browser reports them. */
export function normalize(value) {
  return String(value ?? '').replace(/\s+/g, '').replace(/rgba?\(([^)]+)\)/g, (_m, inner) => {
    const parts = inner.split(',').map((p) => p.trim());
    return `rgb(${parts.slice(0, 3).map((p) => Math.round(Number(p))).join(',')}${parts[3] !== undefined && Number(parts[3]) < 1 ? `,${parts[3]}` : ''})`;
  }).toLowerCase();
}

/** Absolute references left in the copy's own files (must be none). */
async function leakScan(dir) {
  const hits = [];
  for (const file of await fileList(dir)) {
    if (!/\.(html|css)$/i.test(file)) continue;
    const text = await readFile(file, 'utf8');
    const found = absoluteRefs(text);
    if (found.length) hits.push({ file: path.relative(dir, file), count: found.length, sample: found[0].slice(0, 120) });
  }
  return hits;
}

/**
 * One verdict per component, from its measurements. Order matters: a leak or a missing file is the first thing to say.
 * - `leaks`: the copy asked the original (or any host) for something while it rendered.
 * - `blocked-assets`: a file it loads is not in the capture and could not be fetched.
 * - `static-driver-missing`: its movement comes from a script the copy does not carry yet (step b decides how).
 * - `loops-missing` / `hover-differs` / `diff`: the CSS part is there but does not match the original.
 * - `pass`: offline, the visuals within DIFF_LIMIT_PCT, its loops run and its hovers end where the original's did.
 * @param {{ leaks: number, assetsOffline: boolean, driver: string, diffPct: number|null, loops: { expected: number, running: number }, hover: { checked: number, same: number } }} r
 */
export function verdictOf(r) {
  if (r.leaks > 0) return 'leaks';
  if (!r.assetsOffline) return 'blocked-assets';
  if (r.driver !== 'css') return 'static-driver-missing';
  if (r.diffPct === null) return 'no-reference';
  if (r.loops.expected > 0 && r.loops.running === 0) return 'loops-missing';
  if (r.hover.checked > 0 && r.hover.same < r.hover.checked) return 'hover-differs';
  return r.diffPct <= DIFF_LIMIT_PCT ? 'pass' : 'diff';
}
