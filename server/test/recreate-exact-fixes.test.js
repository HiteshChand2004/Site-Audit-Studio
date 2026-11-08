// Step 9d: an exact copy keeps the original's markup (ir/asis.js), which threw away every fix the generate step made on
// the rebuilt tree. Its built pages now go through the fixes "Copy my site" makes (copy/fixAsIs.js) and their proof
// (preserve/stage.js fixAndProve: each page compared with itself before the fixes at 375 and 1440 px, a fix that changes a
// pixel undone), in the job's own browser (build/index.js fixExactCopy).
// Through the real pipeline (capture, assets, generate, build; the measuring steps stubbed), exact mode, two pages with
// problems the fixes answer without changing the look: an image without alt text, the same title on both pages, no
// description. The fixes are in dist/, every kept page was proved, and the copy is still the original pixel for pixel.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { db, projectDir } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { servePreview } from '../src/recreate/preview.js';
import { seedProject } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
const PORT = 4264;
const origin = `http://localhost:${PORT}`;

// A small GIF (a 40 × 24 orange box) the pages show. A GIF, because the assets step re-encodes a PNG / JPEG as lossy WebP
// in every mode (assets/optimize.js), which already differs from the original by a few pixels before any fix; this test
// measures the fixes alone.
const PNG = await sharp({ create: { width: 40, height: 24, channels: 3, background: '#c2410c' } }).gif().toBuffer();
const page = (heading, link) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme</title>
<style>body { margin: 0; font: 16px/1.4 Arial, sans-serif; color: #111 } header, main { padding: 24px } img { display: block; width: 40px; height: 24px }</style></head>
<body><header><img src="/logo.gif"><a href="${link}">${link === '/' ? 'Home' : 'About us'}</a></header>
<main><h1>${heading}</h1><p>This page is about ${heading.toLowerCase()} and the work behind it, in a few plain sentences for a visitor.</p></main></body></html>`;
const PAGES = { '/': page('Welcome', '/about'), '/about': page('About', '/') };

let site;
let browser;
let dir;
let report;
const projectIds = [];

before(async () => {
  site = createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/logo.gif') return res.writeHead(200, { 'content-type': 'image/gif' }).end(PNG);
    if (PAGES[p]) return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGES[p]);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise((resolve) => { site.listen(PORT, resolve); });
  browser = await launchBrowser();
  const id = randomUUID();
  projectIds.push(id);
  seedProject(db, { id, name: 'exact-fixes', url: `${origin}/`, stack: 'html', authorized: 1, recreatePages: -1, analysis: true });
  const recreateId = randomUUID();
  const stub = async () => {};
  report = await runRecreate({
    project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id), recreateId, exact: true, progress: () => {},
    stages: { ...STAGES, sweep: stub, exactCapture: stub, exact: stub, preview: stub, responsive: stub, stack: stub },
  });
  dir = recreateDir(id, recreateId);
});
after(async () => {
  await browser?.close().catch(() => {});
  site?.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

/** Pixels that differ between two screenshots (any channel off by more than 2); a size mismatch is reported as such. */
async function differing(a, b) {
  const [x, y] = await Promise.all([a, b].map((buf) => sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (x.info.width !== y.info.width || x.info.height !== y.info.height) return `size ${x.info.width}x${x.info.height} vs ${y.info.width}x${y.info.height}`;
  let n = 0;
  const box = [Infinity, Infinity, -1, -1];
  for (let i = 0; i < x.data.length; i += 4) {
    if (Math.abs(x.data[i] - y.data[i]) > 2 || Math.abs(x.data[i + 1] - y.data[i + 1]) > 2 || Math.abs(x.data[i + 2] - y.data[i + 2]) > 2) {
      n++;
      const px = (i / 4) % x.info.width;
      const py = Math.floor(i / 4 / x.info.width);
      box[0] = Math.min(box[0], px);
      box[1] = Math.min(box[1], py);
      box[2] = Math.max(box[2], px);
      box[3] = Math.max(box[3], py);
    }
  }
  if (n) console.log(`# ${n} px differ inside x ${box[0]}-${box[2]}, y ${box[1]}-${box[3]}`);
  return n;
}

test('the exact copy\'s pages get the fixes, each page proved unchanged, in dist/', async () => {
  const fx = report.exactFixes;
  console.log(`# exact fixes: kept ${JSON.stringify(fx?.counts)}, pages reverted ${fx?.reverted}, dropped ${fx?.dropped}, looks ${fx?.looks}, ${fx?.ms} ms`);
  assert.ok(fx && !fx.error, JSON.stringify(fx));
  assert.ok(fx.total > 0, `fixes kept: ${JSON.stringify(fx.counts)}`);
  assert.ok(fx.looks > 0, 'every kept fix was looked at');
  assert.ok(fx.counts.alt > 0 || fx.counts['alt-text'] > 0 || Object.keys(fx.counts).some((k) => /alt/.test(k)), `the image got alt text: ${JSON.stringify(fx.counts)}`);
  const home = await readFile(path.join(dir, 'dist', 'index.html'), 'utf8');
  const about = await readFile(path.join(dir, 'dist', 'about', 'index.html'), 'utf8').catch(() => readFile(path.join(dir, 'dist', 'about.html'), 'utf8'));
  assert.match(home, /<img[^>]*\balt="[^"]+"/, 'alt text in the built page');
  const title = (h) => h.match(/<title>([^<]*)<\/title>/)?.[1];
  assert.notEqual(title(home), title(about), 'the two pages no longer share one title');
  // The proof's copy of the unfixed pages is gone; nothing else was left in the workspace by it.
  assert.equal((await readdir(dir)).includes('dist-unfixed'), false);
  // The fixed site still passed the safety gate and the verification (the job would have failed otherwise).
  assert.equal(report.safety.safe, true);
});

test('the fixed exact copy is the original, pixel for pixel, at 375 and 1440 px', async () => {
  const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
  const base = served.origin ?? `http://127.0.0.1:${served.port}`;
  const results = {};
  try {
    for (const [p, file] of [['/', 'index.html'], ['/about', 'about/']]) {
      for (const width of [375, 1440]) {
        const shots = [];
        for (const url of [`${origin}${p}`, `${base}/${file}`]) {
          const context = await browser.newContext({ viewport: { width, height: 700 } });
          const pg = await context.newPage();
          await pg.goto(url, { waitUntil: 'load' });
          await pg.waitForTimeout(300);
          shots.push(await pg.screenshot({ fullPage: true }));
          await context.close();
        }
        results[`${p} ${width}`] = await differing(...shots);
      }
    }
  } finally {
    await served.close?.();
  }
  if (process.env.SAS_KEEP_DIST) {
    const { cp } = await import('node:fs/promises');
    await cp(path.join(dir, 'dist'), process.env.SAS_KEEP_DIST, { recursive: true });
  }
  console.log(`# pixels differing from the original: ${JSON.stringify(results)}`);
  assert.deepEqual(Object.values(results), [0, 0, 0, 0], JSON.stringify(results));
});
