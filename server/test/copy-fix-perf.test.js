// The speed fixes of an as-is copy (C3, copy/perfAsIs.js) and their proof (preserve/stage.js fixAndProve). Each is planned from
// the copy before its fixes, measured in a real browser at 375 and 1440 px (preserve/check.js perfProbe), and kept only when the
// gate, at both widths, finds the page unchanged AND the look is conclusive (stage.js proven). Here: the largest image gets
// fetchpriority and loses loading="lazy"; only images below the first screen at both widths get loading="lazy" (never a slide
// in a scrolling box, a lazy-library image, or an image a script duplicates); a page whose own CSS reacts to the attribute loses
// that one fix; a lossless WebP is kept only with the same pixels, never for a PNG with a gamma chunk or one it would not
// shrink, and the PNG stays; a dropped WebP is removed unless a page or a file still names it; a stylesheet shared by four pages
// is minified only when all four stay the same, else every byte is put back; integrity and script-named stylesheets are left;
// speed: false changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';
import { losslessWebp } from '../src/copy/perfAsIs.js';

const SITE = 'https://www.example-original.dev/';
const TEXT = 'This page is about the work we do for our customers and the people who use what we make every day.';
// A head that already states what the markup fixes would add (lang, description, og tags, homepage data), so only speed fixes
// are made, and every image has alt text (no alt fix).
const head = (css, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Speed test page title</title>
<meta name="description" content="A page made to test which speed fixes are kept and which are undone, for the speed test.">
<meta property="og:title" content="Speed test page title">
<meta property="og:description" content="A page made to test which speed fixes are kept and which are undone, for the speed test.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":["Organization","WebSite"],"name":"Speed"}</script>
<style>body{margin:0;font:18px sans-serif;background:#fff}img{display:block}${css}</style>${extra}</head>`;

/** A PNG that shrinks a lot as lossless WebP: stripes, stored without compression (and no colour or gamma chunk). */
async function stripes(w, h, seed = 0) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const band = Math.floor((x + seed) / 16) % 4;
    raw[i] = [200, 40, 30, 240][band]; raw[i + 1] = [120, 160, 30, 240][band]; raw[i + 2] = [40, 200, 90, 240][band];
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}
/** Bytes that cannot be compressed and are the same on every run: SHA-256 of a counter. */
function noiseBytes(n, seed = 'noise') {
  const out = Buffer.alloc(n);
  for (let i = 0, c = 0; i < n; c++) i += createHash('sha256').update(`${seed}:${c}`).digest().copy(out, i);
  return out;
}
/**
 * A PNG of noise that lossless WebP cannot make 10 % smaller. Checked in isolation on 2026-11-01: at 200 x 150 the PNG is
 * 90 396 bytes and its lossless WebP 90 080 (99.7 %), so losslessWebp skips it.
 */
const noise = (w, h) => sharp(noiseBytes(w * h * 3), { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
/**
 * A JPEG with detail in it. Chrome leaves out of the Largest Contentful Paint an image with too little detail for its size on
 * screen (a flat colour shown 1400 px wide is not counted at 1440 px, measured), so the largest image of a test page is this one.
 * Checked in isolation on 2026-11-01 with perfProbe on the pages of the first two tests: this image is the LCP at 375 and 1440 px.
 */
const detailedJpg = (w, h, seed) => sharp(noiseBytes(w * h * 3, seed), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 70 }).toBuffer();
/** The same PNG with a gAMA chunk added after IHDR (a browser applies it; WebP would not). */
function withGamma(png) {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(45455);
  const type = Buffer.from('gAMA', 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(4);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])));
  return Buffer.concat([png.subarray(0, 33), len, type, data, crc, png.subarray(33)]);
}

async function siteOf(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-perf-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-unfixed`, { recursive: true, force: true }); });
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
  return dir;
}
const pagesOf = (...outPaths) => outPaths.map((outPath) => ({ outPath, url: new URL(outPath.replace(/index\.html$/, ''), SITE).href }));
const prove = (dir, pages = pagesOf('index.html'), speed = true) => fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages, siteUrl: SITE, newSiteUrl: null, speed });
// The speed kinds a page kept (markup fixes, if a fixture ever gets one, do not count here).
const SPEED = ['lcp', 'lazy', 'webp'];
const kinds = (page) => (page.reverted ? [] : [...new Set(page.fixes.map((f) => f.kind))].filter((k) => SPEED.includes(k))).sort();
const read = (dir, rel) => readFile(path.join(dir, rel), 'utf8');
const imgTag = (html, src) => html.match(new RegExp(`<img[^>]*src="${src.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*>`))?.[0] ?? '';

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

test('the largest image gets fetchpriority="high" and loses loading="lazy"; images below the first screen at both widths get loading="lazy", nothing else does', { timeout: 10 * 60000 }, async (t) => {
  // A 120 px spacer keeps the hero inside the first screen at 375 and 1440 px; "far" sits 3000 px down at both widths.
  // Left alone: a slide placed to the right inside an overflow-hidden track (in a scroller, not inside the window), an image a
  // lazy-loading library manages (data-src), and an image a script shows twice (its markup count is not the page's count).
  const body = `<body><div style="height:120px">${TEXT}</div>
    <img id="hero" src="/img/hero.jpg" alt="Hero" loading="lazy" style="width:100%;height:auto;max-width:1400px">
    <div style="height:3000px"></div>
    <img src="/img/far.jpg" alt="Far" width="300" height="200">
    <div style="width:300px;height:200px;overflow:hidden;position:relative"><div style="position:absolute;left:600px;top:0;width:300px"><img src="/img/slide.jpg" alt="Slide" width="300" height="200"></div></div>
    <img src="/img/lib.jpg" data-src="/img/lib.jpg" alt="Lib" width="300" height="200">
    <img src="/img/twice.jpg" alt="Twice" width="300" height="200"><div id="again"></div>
    <script>document.getElementById('again').innerHTML = '<img src="/img/twice.jpg" alt="Twice again" width="300" height="200">';</script>
    </body></html>`;
  const jpg = (w, h, rgb) => sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).jpeg().toBuffer();
  const dir = await siteOf(t, {
    'index.html': head('') + body,
    'img/hero.jpg': await detailedJpg(1400, 700, 'hero'),
    'img/far.jpg': await jpg(300, 200, { r: 160, g: 60, b: 30 }),
    'img/slide.jpg': await jpg(300, 200, { r: 60, g: 160, b: 30 }),
    'img/lib.jpg': await jpg(300, 200, { r: 90, g: 90, b: 90 }),
    'img/twice.jpg': await jpg(300, 200, { r: 200, g: 200, b: 40 }),
  });
  const r = await prove(dir);
  const home = r.pages.find((p) => p.path === '/');
  assert.equal(home.reverted, undefined, JSON.stringify(r.gate));
  assert.deepEqual(kinds(home), ['lazy', 'lcp'], JSON.stringify(home));
  const html = await read(dir, 'index.html');
  const hero = imgTag(html, '/img/hero.jpg');
  assert.match(hero, /fetchpriority="high"/);
  assert.doesNotMatch(hero, /loading=/, 'the largest image is never lazy');
  assert.match(imgTag(html, '/img/far.jpg'), /loading="lazy"/);
  for (const src of ['/img/slide.jpg', '/img/lib.jpg', '/img/twice.jpg']) assert.doesNotMatch(imgTag(html, src), /loading=|fetchpriority=/, src);
  assert.equal(r.counts.lcp, 1);
  assert.equal(r.counts.lazy, 1);
  assert.ok(r.open.some((o) => o.kind === 'lazy' && /twice\.jpg is left without lazy loading on purpose/.test(o.detail)), JSON.stringify(r.open));
});

test('a page whose own CSS reacts to loading="lazy" loses only that fix, with the width it changed at', { timeout: 10 * 60000 }, async (t) => {
  // The site gives lazy images a frame: adding the attribute draws a border far down the page. The largest image is untouched
  // by that rule, so its fix stays.
  const body = `<body><div style="height:120px">${TEXT}</div>
    <img src="/img/hero.jpg" alt="Hero" style="width:100%;height:auto;max-width:1400px">
    <div style="height:3000px"></div><img src="/img/far.jpg" alt="Far" width="300" height="200"></body></html>`;
  const dir = await siteOf(t, {
    'index.html': head('img[loading=lazy]{outline:6px solid #e11d48}') + body,
    'img/hero.jpg': await detailedJpg(1400, 700, 'hero'),
    'img/far.jpg': await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 160, g: 60, b: 30 } } }).jpeg().toBuffer(),
  });
  const r = await prove(dir);
  const home = r.pages.find((p) => p.path === '/');
  assert.deepEqual(home.dropped?.map((d) => d.group), ['lazy'], JSON.stringify(r.gate));
  assert.match(home.dropped[0].why, /at (375|1440) px/);
  const html = await read(dir, 'index.html');
  assert.doesNotMatch(imgTag(html, '/img/far.jpg'), /loading=/, 'the image is as lifted');
  assert.match(imgTag(html, '/img/hero.jpg'), /fetchpriority="high"/, 'the fix that changes nothing is kept');
});

test('a lossless WebP is kept only with the very same pixels; a gamma chunk or too small a saving keeps the PNG; the PNG file always stays', { timeout: 10 * 60000 }, async (t) => {
  const plain = await stripes(400, 300);
  assert.ok(!plain.includes(Buffer.from('gAMA')) && !plain.includes(Buffer.from('iCCP')), 'the fixture PNG has no colour chunk');
  const gamma = withGamma(await stripes(400, 300, 8));
  const rough = await noise(200, 150);
  const body = `<body><p>${TEXT}</p><img src="/img/plain.png" alt="Plain" width="400" height="300">
    <img src="/img/gamma.png" alt="Gamma" width="400" height="300"><img src="/img/rough.png" alt="Rough" width="200" height="150"></body></html>`;
  const dir = await siteOf(t, { 'index.html': head('') + body, 'img/plain.png': plain, 'img/gamma.png': gamma, 'img/rough.png': rough });
  const r = await prove(dir);
  const home = r.pages.find((p) => p.path === '/');
  assert.equal(home.reverted, undefined, JSON.stringify(r.gate));
  const html = await read(dir, 'index.html');
  const webp = home.fixes.filter((f) => f.kind === 'webp');
  assert.deepEqual(webp.map((f) => f.src), ['/img/plain.png'], JSON.stringify(r.open));
  assert.match(imgTag(html, webp[0].value), /alt="Plain"/);
  const made = await readFile(path.join(dir, webp[0].file));
  const [a, b] = await Promise.all([plain, made].map((x) => sharp(x).ensureAlpha().raw().toBuffer()));
  assert.ok(a.equals(b), 'every decoded pixel is the same');
  assert.ok(made.length <= plain.length * 0.9);
  assert.deepEqual(await readFile(path.join(dir, 'img/plain.png')), plain, 'the PNG is kept as it was');
  assert.match(imgTag(html, '/img/gamma.png'), /alt="Gamma"/, 'a PNG with gAMA is left');
  assert.match(imgTag(html, '/img/rough.png'), /alt="Rough"/, 'a PNG WebP cannot shrink by 10 % is left');
  const reasons = r.open.filter((o) => o.kind === 'webp').map((o) => o.detail).join('\n');
  assert.match(reasons, /gamma\.png.*gAMA/);
  assert.match(reasons, /rough\.png.*would be \d+ %/);
  assert.deepEqual((await readdir(path.join(dir, 'img'))).filter((f) => f.endsWith('.webp')).length, 1, 'no WebP left for the skipped PNGs');
});

test('a WebP whose fix is dropped is removed, unless another page or another file of the copy still names it', { timeout: 15 * 60000 }, async (t) => {
  // The site styles images by their .png address: on /a/ the WebP address loses that rule, so the fix is dropped there. /b/ has
  // no such rule and keeps the same WebP: the file must stay. A second PNG is only shown on /a/, and its WebP name is also in
  // data/files.json: it must stay as well. A third, shown only on /a/ and named nowhere else, is removed.
  const one = await stripes(400, 300, 1);
  const two = await stripes(400, 300, 2);
  const three = await stripes(400, 300, 3);
  const nameOf = async (png, base) => {
    const w = await losslessWebp(png);
    return `${base}.sas-${createHash('sha256').update(w.data).digest('hex').slice(0, 10)}.webp`;
  };
  const twoName = await nameOf(two, 'two');
  const a = `<body><p>${TEXT}</p><img src="/img/one.png" alt="One" width="400" height="300"><img src="/img/two.png" alt="Two" width="400" height="300">
    <img src="/img/three.png" alt="Three" width="400" height="300"></body></html>`;
  const b = `<body><p>${TEXT}</p><img src="/img/one.png" alt="One" width="400" height="300"></body></html>`;
  const dir = await siteOf(t, {
    'index.html': head('') + `<body><p>${TEXT}</p></body></html>`,
    'a/index.html': head('img[src$=".png"]{outline:4px solid #0a0}') + a,
    'b/index.html': head('') + b,
    'img/one.png': one, 'img/two.png': two, 'img/three.png': three,
    'data/files.json': JSON.stringify({ images: [`/img/${twoName}`] }),
  });
  const r = await prove(dir, pagesOf('index.html', 'a/index.html', 'b/index.html'));
  const pa = r.pages.find((p) => p.path === '/a/');
  const pb = r.pages.find((p) => p.path === '/b/');
  assert.ok(pa.dropped?.some((d) => d.group === 'webp') || pa.reverted, JSON.stringify(pa));
  assert.ok(!pa.reverted ? !kinds(pa).includes('webp') : true);
  // /b/'s only image is also its largest, so it gets the lcp fix too.
  assert.deepEqual(kinds(pb), ['lcp', 'webp'], JSON.stringify(pb));
  const files = await readdir(path.join(dir, 'img'));
  const oneName = await nameOf(one, 'one');
  const threeName = await nameOf(three, 'three');
  assert.ok(files.includes(oneName), 'still shown by /b/');
  assert.ok(files.includes(twoName), 'still named by data/files.json');
  assert.ok(!files.includes(threeName), 'named by nothing: removed');
  for (const f of ['one.png', 'two.png', 'three.png']) assert.ok(files.includes(f), `${f} stays`);
  assert.ok((await read(dir, 'b/index.html')).includes(`/img/${oneName}`), '/b/ points at the WebP');
  assert.doesNotMatch(await read(dir, 'a/index.html'), /\.webp/, '/a/ is as lifted');
});

/** A stylesheet of at least 2 KB with indentation and comments (well over 5 % to gain). */
const CSS = Array.from({ length: 60 }, (_, i) => `/* block ${i} */\n.b${i} {\n    color: #333;\n    margin: 0 0 ${i % 7}px 0;\n    padding: 4px;\n}\n`).join('\n')
  + '\nbody {\n    color: #111;\n}\n';
const cssPage = (n, extra = '') => `${head('', '<link rel="stylesheet" href="/css/site.css">')}<body><p class="b${n}">${TEXT}</p>${extra}</body></html>`;

test('a stylesheet shared by four pages is minified when all four are pictured the same at 375 and 1440 px', { timeout: 15 * 60000 }, async (t) => {
  const dir = await siteOf(t, {
    'index.html': cssPage(1), 'two/index.html': cssPage(2), 'three/index.html': cssPage(3), 'four/index.html': cssPage(4), 'css/site.css': CSS,
  });
  const r = await prove(dir, pagesOf('index.html', 'two/index.html', 'three/index.html', 'four/index.html'));
  assert.deepEqual(r.css.files.map((f) => f.file), ['css/site.css'], JSON.stringify(r.css));
  assert.deepEqual([...r.css.files[0].pages].sort(), ['/', '/four/', '/three/', '/two/']);
  assert.deepEqual([...new Set(r.css.looks.map((l) => l.path))].sort(), ['/', '/four/', '/three/', '/two/'], 'every page that loads it was looked at');
  assert.ok(r.css.looks.every((l) => l.ok));
  const now = await read(dir, 'css/site.css');
  assert.ok(now.length < CSS.length * 0.95);
  assert.doesNotMatch(now, /\/\* block/);
});

test('when only the fourth page using a stylesheet is not the same, every byte of it is put back', { timeout: 15 * 60000 }, async (t) => {
  // Page four prints the stylesheet's length (its script reads the file as text): the rules are the same, the page is not.
  const reader = '<p id="n"></p><script>fetch("/css/site.css").then((r) => r.text()).then((t) => { document.getElementById("n").textContent = String(t.length); });</script>';
  const dir = await siteOf(t, {
    'index.html': cssPage(1), 'two/index.html': cssPage(2), 'three/index.html': cssPage(3), 'four/index.html': cssPage(4, reader), 'css/site.css': CSS,
  });
  const r = await prove(dir, pagesOf('index.html', 'two/index.html', 'three/index.html', 'four/index.html'));
  assert.equal(await read(dir, 'css/site.css'), CSS, 'the original bytes');
  assert.deepEqual(r.css.files, []);
  assert.ok(r.css.looks.some((l) => l.path === '/four/' && !l.ok), JSON.stringify(r.css.looks));
  assert.ok(r.open.some((o) => o.kind === 'css' && o.page === '/four/'), JSON.stringify(r.open));
});

test('a stylesheet loaded with an integrity hash, named by a script, or loadable by an HTML file that is not a measured page, is never minified', { timeout: 10 * 60000 }, async (t) => {
  const sri = `sha384-${createHash('sha384').update(CSS).digest('base64')}`;
  const page1 = `${head('', `<link rel="stylesheet" href="/css/locked.css" integrity="${sri}">`)}<body><p class="b1">${TEXT}</p></body></html>`;
  const page2 = `${head('', '<link rel="stylesheet" href="/css/themed.css"><script src="/js/theme.js"></script>')}<body><p class="b2">${TEXT}</p></body></html>`;
  // /three/ is measured and links outer.css, which @imports inner.css; notice/index.html is in the copy but not in the page list
  // and links outer.css too: neither stylesheet may be minified, because no look covers the notice page.
  const page3 = `${head('', '<link rel="stylesheet" href="/css/outer.css">')}<body><p class="b3">${TEXT}</p></body></html>`;
  const notice = `${head('', '<link rel="stylesheet" href="/css/outer.css">')}<body><p class="b4">${TEXT}</p></body></html>`;
  const outer = `@import url("/css/inner.css");\n${CSS}`;
  const dir = await siteOf(t, {
    'index.html': page1, 'two/index.html': page2, 'three/index.html': page3, 'notice/index.html': notice,
    'css/locked.css': CSS, 'css/themed.css': CSS, 'css/outer.css': outer, 'css/inner.css': CSS,
    'js/theme.js': 'window.themeSheet = "/css/themed.css";',
  });
  const r = await prove(dir, pagesOf('index.html', 'two/index.html', 'three/index.html'));
  assert.equal(await read(dir, 'css/locked.css'), CSS);
  assert.equal(await read(dir, 'css/themed.css'), CSS);
  assert.equal(await read(dir, 'css/outer.css'), outer);
  assert.equal(await read(dir, 'css/inner.css'), CSS);
  assert.deepEqual(r.css.files, []);
  const why = r.open.filter((o) => o.kind === 'css').map((o) => o.detail).join('\n');
  assert.match(why, /locked\.css.*integrity/);
  assert.match(why, /themed\.css.*script/);
  assert.match(why, /outer\.css.*not one of the measured pages/);
  assert.match(why, /inner\.css.*not one of the measured pages/);
});

test('speed: false makes no speed fix, writes no file and minifies nothing', { timeout: 10 * 60000 }, async (t) => {
  const png = await stripes(400, 300, 4);
  const body = `<body><div style="height:120px">${TEXT}</div><img src="/img/hero.png" alt="Hero" loading="lazy" width="400" height="300">
    <div style="height:3000px"></div><img src="/img/hero.png" alt="Again" width="400" height="300"></body></html>`;
  const html = head('', '<link rel="stylesheet" href="/css/site.css">') + body;
  const dir = await siteOf(t, { 'index.html': html, 'img/hero.png': png, 'css/site.css': CSS });
  const r = await prove(dir, pagesOf('index.html'), false);
  assert.equal(r.css, undefined);
  assert.deepEqual(kinds(r.pages[0]), []);
  const tags = (h) => h.match(/<img[^>]*>/g);
  assert.deepEqual(tags(await read(dir, 'index.html')), tags(html), 'every image tag as lifted');
  assert.doesNotMatch(await read(dir, 'index.html'), /fetchpriority|\.webp/);
  assert.equal(await read(dir, 'css/site.css'), CSS);
  assert.deepEqual(await readdir(path.join(dir, 'img')), ['hero.png']);
});
