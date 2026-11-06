// Lossless WebP for every PNG an image can show (Step 8a, copy/perfAsIs.js fixPngImages), through the real fix and proof
// (preserve/stage.js fixAndProve). Only the files change: srcset, sizes, media, the order and the descriptors stay as written,
// so the browser chooses the same candidate on the fixed copy as on the unfixed one at 375 px (screen density 1 and 2) and at
// 1440 px, and every candidate has the very same pixels. All or none per image; a typed <picture> source is left; PNGs of the
// page's own CSS are converted too; the PNG files stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { srcsetParts } from '../src/copy/perfAsIs.js';

const SITE = 'https://www.example-original.dev/';
const TEXT = 'This page is about the work we do for our customers and the people who use what we make every day.';
const HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Image test page title</title>
<meta name="description" content="A page made to test which image files the copy may swap, and that the browser still picks the same one.">
<meta property="og:title" content="Image test page title">
<meta property="og:description" content="A page made to test which image files the copy may swap, and that the browser still picks the same one.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":["Organization","WebSite"],"name":"Images"}</script>
<style>body{margin:0;font:18px sans-serif;background:#fff}img{display:block}.tile{width:200px;height:100px;background:url(/img/bg-style.png)}</style></head>`;

/** A PNG that shrinks a lot as lossless WebP (stripes, stored uncompressed, no colour or gamma chunk); `seed` makes each one unique. */
async function stripes(w, h, seed = 0) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const band = Math.floor((x + seed) / 16) % 4;
    raw[i] = [200, 40, 30, 240][band]; raw[i + 1] = [120, 160, 30, 240][band]; raw[i + 2] = [40, 200, 90, 240][band];
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}
/** The same PNG with a gAMA chunk (a browser applies it; WebP would not): it can never be converted. */
function withGamma(png) {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(45455);
  const type = Buffer.from('gAMA', 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(4);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])));
  return Buffer.concat([png.subarray(0, 33), len, type, data, crc, png.subarray(33)]);
}

const BODY = `<body><p>${TEXT}</p>
<img id="sizes" src="/img/s-800.png" srcset="/img/s-400.png 400w,  /img/s-800.png 800w" sizes="(max-width: 600px) 100vw, 400px" alt="Sizes" width="400" height="200">
<picture id="art"><source media="(max-width: 600px)" srcset="/img/a-small.png 1x, /img/a-small2x.png 2x"><img src="/img/a-big.png" alt="Art" width="400" height="200"></picture>
<picture id="typed"><source type="image/png" srcset="/img/t-small.png"><img src="/img/t-big.png" alt="Typed" width="400" height="200"></picture>
<img id="mixed" src="/img/m-1.png" srcset="/img/m-1.png 1x, /img/m-2-gamma.png 2x" alt="Mixed" width="400" height="200">
<div class="tile"></div><div style="width:200px;height:100px;background-image:url('/img/bg-attr.png')"></div>
</body></html>`;

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

test('srcsetParts keeps every character around the addresses', () => {
  const s = ' /a.png 400w,\n /b.png 800w ,/c.png 2x';
  const parts = srcsetParts(s);
  assert.deepEqual(parts.map((p) => p.url), ['/a.png', '/b.png', '/c.png']);
  assert.equal(parts.map((p) => `${p.before}${p.url}${p.after}`).join(','), s);
});

test('every PNG candidate gets a pixel-identical WebP, the browser picks the same candidate at 375 (1x, 2x) and 1440 px', { timeout: 15 * 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-images-'));
  t.after(async () => {
    for (const d of [dir, `${dir}-unfixed`, `${dir}-before`]) await rm(d, { recursive: true, force: true });
  });
  const files = {
    'img/s-400.png': await stripes(400, 200, 1), 'img/s-800.png': await stripes(800, 400, 2),
    'img/a-small.png': await stripes(375, 188, 3), 'img/a-small2x.png': await stripes(750, 375, 4), 'img/a-big.png': await stripes(400, 200, 5),
    'img/t-small.png': await stripes(375, 188, 6), 'img/t-big.png': await stripes(400, 200, 7),
    'img/m-1.png': await stripes(400, 200, 8), 'img/m-2-gamma.png': withGamma(await stripes(800, 400, 9)),
    'img/bg-style.png': await stripes(200, 100, 10), 'img/bg-attr.png': await stripes(200, 100, 11),
  };
  await mkdir(path.join(dir, 'img'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) await writeFile(path.join(dir, rel), body);
  await writeFile(path.join(dir, 'index.html'), HEAD + BODY);
  // The copy as written, kept apart: the proof removes its own unfixed folder when it ends.
  await cp(dir, `${dir}-before`, { recursive: true });

  const r = await fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages: [{ outPath: 'index.html', url: SITE }], siteUrl: SITE, newSiteUrl: null, speed: true });
  const home = r.pages.find((p) => p.path === '/');
  assert.equal(home.reverted, undefined, JSON.stringify(r.gate));
  assert.ok(!home.dropped?.some((d) => d.group === 'webp'), JSON.stringify({ dropped: home.dropped, gate: r.gate }).slice(0, 3000));
  const webp = home.fixes.filter((f) => f.kind === 'webp');
  assert.deepEqual(webp.map((f) => f.src).sort(), ['/img/a-big.png', '/img/a-small.png', '/img/a-small2x.png', '/img/bg-attr.png', '/img/bg-style.png',
    '/img/s-400.png', '/img/s-800.png', '/img/s-800.png'].sort(), JSON.stringify(r.open));

  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  // The page's other fixes (a generated icon, the main image's fetchpriority) are not this test's: every image, source and
  // style of the page is compared with the markup as written, PNG names put back.
  const parts = (h) => h.match(/<(img|source|style)\b[^>]*>(?:[^<]*<\/style>)?|style="[^"]*"/g).map((s) => s.replace(/ fetchpriority="high"/, ''));
  assert.deepEqual(parts(html.replace(/\.sas-[0-9a-f]{10}\.webp/g, '.png')), parts(HEAD + BODY), 'only file names changed');
  assert.match(html, /srcset="\/img\/s-400\.sas-[0-9a-f]{10}\.webp 400w,  \/img\/s-800\.sas-[0-9a-f]{10}\.webp 800w" sizes="\(max-width: 600px\) 100vw, 400px"/);
  assert.match(html, /id="typed"><source type="image\/png" srcset="\/img\/t-small\.png"><img src="\/img\/t-big\.png"/, 'a typed source is left');
  assert.match(html, /id="mixed" src="\/img\/m-1\.png" srcset="\/img\/m-1\.png 1x, \/img\/m-2-gamma\.png 2x"/, 'all or none');
  const reasons = r.open.filter((o) => o.kind === 'webp').map((o) => o.detail).join('\n');
  assert.match(reasons, /t-big\.png and its other sizes are not converted to WebP: a <source> of its <picture> names its type/);
  assert.match(reasons, /m-1\.png and its other sizes are not converted to WebP: \/img\/m-2-gamma\.png: it carries gAMA/);
  assert.equal((html.match(/\.sas-[0-9a-f]{10}\.webp/g) ?? []).length, webp.length, JSON.stringify({ ...home, fixes: undefined }).slice(0, 3000));
  for (const f of webp) {
    const made = await readFile(path.join(dir, f.file));
    const [a, b] = await Promise.all([files[f.src.slice(1)], made].map((x) => sharp(x).ensureAlpha().raw().toBuffer()));
    assert.ok(a.equals(b), `${f.file}: the very same pixels`);
  }
  for (const rel of Object.keys(files)) assert.deepEqual(await readFile(path.join(dir, rel)), files[rel], `${rel} stays`);

  // The browser's choice on both copies, as the PNG name it stands for.
  const choices = async (base, width, dpr) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: dpr });
    try {
      const page = await context.newPage();
      await page.goto(`${base}/`, { waitUntil: 'load' });
      return await page.evaluate(() => ['sizes', 'art', 'typed', 'mixed'].map((id) => {
        const img = document.getElementById(id).tagName === 'IMG' ? document.getElementById(id) : document.querySelector(`#${id} img`);
        return new URL(img.currentSrc).pathname.replace(/\.sas-[0-9a-f]{10}\.webp$/, '.png');
      }));
    } finally {
      await context.close();
    }
  };
  const fixedSrv = await serveCopy(dir);
  const unfixedSrv = await serveCopy(`${dir}-before`);
  try {
    const seen = new Set();
    for (const [width, dpr] of [[375, 1], [375, 2], [1440, 1]]) {
      const a = await choices(unfixedSrv.url.replace(/\/$/, ''), width, dpr);
      const b = await choices(fixedSrv.url.replace(/\/$/, ''), width, dpr);
      assert.deepEqual(b, a, `same candidates at ${width} px, density ${dpr}`);
      seen.add(a[0]);
    }
    assert.deepEqual([...seen].sort(), ['/img/s-400.png', '/img/s-800.png'], 'the widths and densities really choose different candidates');
  } finally {
    await fixedSrv.close();
    await unfixedSrv.close();
  }
});
