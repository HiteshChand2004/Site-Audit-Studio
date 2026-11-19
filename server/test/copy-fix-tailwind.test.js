// Tailwind's Play CDN replaced by the CSS it writes (copy/tailwindAsIs.js). A small stand-in compiler plays the CDN: like it,
// it reads window.tailwind.config, watches the page's classes and writes their rules into a <style> at the end of the head.
// The copy's built stylesheet must draw the page the same without any compiler, hold the rule of a class only a script adds
// (a menu opening), and nothing changes where another script uses the `tailwind` global or the pages' configs differ.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { isTailwindPlay, planTailwind, replaceTailwindPlay } from '../src/copy/tailwindAsIs.js';

// The stand-in: the markers isTailwindPlay looks for, a config read through the global, rules only for classes on the page.
const FAKE_CDN = `/*! tailwindcss v3.4.17 | MIT License */
console.warn("cdn.tailwindcss.com should not be used in production.");
(function(){var T="text/tailwindcss",S=null;window.tailwind={config:{}};
var RULES={"tw-red":"color:rgb(200, 0, 0)","tw-big":"font-size:40px","tw-pad":"padding:24px","tw-open":"background-color:rgb(0, 0, 200)"};
function run(){var seen={};document.querySelectorAll("[class]").forEach(function(el){el.classList.forEach(function(c){seen[c]=1})});
var out="*,::before,::after{box-sizing:border-box}body{margin:0}";for(var c in seen){if(RULES[c])out+="."+c+"{"+RULES[c]+"}";
if(c==="tw-brand")out+=".tw-brand{color:"+((window.tailwind.config.theme||{}).brand||"black")+"}"}
if(!S||!S.isConnected){S=document.createElement("style");document.head.append(S)}if(S.textContent!==out)S.textContent=out}
new MutationObserver(run).observe(document.documentElement,{attributes:true,attributeFilter:["class"],childList:true,subtree:true});
if(document.body)run();else document.addEventListener("DOMContentLoaded",run)})();`;
const CONFIG = '<script id="tailwind-config">\n  tailwind.config = { theme: { brand: "rgb(0, 128, 0)" } }\n</script>';
const pageHtml = (body, { config = CONFIG, extra = '' } = {}) => `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.tailwindcss.com?plugins=forms"></script>${config}${extra}</head><body>${body}<script src="/app.js"></script></body></html>`;
const APP = 'document.addEventListener("click",function(){document.querySelector("#menu").className="tw-open tw-pad"});';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function withCopy(pages, fn, { app = APP } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-tailwind-'));
  try {
    await writeFile(path.join(dir, '3.4~abc.17.js'), FAKE_CDN);
    await writeFile(path.join(dir, 'app.js'), app);
    for (const [outPath, html] of Object.entries(pages)) {
      await mkdir(path.dirname(path.join(dir, outPath)), { recursive: true });
      await writeFile(path.join(dir, outPath), html);
    }
    const list = Object.keys(pages).map((outPath) => ({ outPath, path: outPath === 'index.html' ? '/' : `/${outPath.replace(/index\.html$/, '')}` }));
    return await fn(dir, list);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Styles of the page's elements, from HTML served by routing (the CDN address answered by its local file, or by nothing). */
async function stylesOf(dir, html, { click = false, withCdn = true } = {}) {
  const context = await browser.newContext();
  try {
    await context.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === 'cdn.tailwindcss.com') return withCdn ? route.fulfill({ body: FAKE_CDN, contentType: 'text/javascript' }) : route.abort();
      if (u.hostname !== 'copy.test') return route.abort();
      if (u.pathname === '/') return route.fulfill({ body: html, contentType: 'text/html' });
      const body = await readFile(path.join(dir, decodeURIComponent(u.pathname))).catch(() => null);
      return body ? route.fulfill({ body, contentType: u.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }) : route.fulfill({ status: 404, body: '' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://copy.test/');
    await page.waitForTimeout(400);
    if (click) {
      await page.mouse.click(5, 5);
      await page.waitForTimeout(400);
    }
    const read = await page.evaluate(() => Object.fromEntries(['#title', '#brand', '#menu'].map((s) => {
      const c = getComputedStyle(document.querySelector(s));
      return [s, { color: c.color, fontSize: c.fontSize, background: c.backgroundColor, padding: c.paddingTop }];
    })));
    return { read, errors };
  } finally {
    await context.close();
  }
}

const BODY = '<h1 id="title" class="tw-red tw-big">Hello</h1><p id="brand" class="tw-brand">Brand</p><div id="menu" class="closed">Menu</div>';

test('the stand-in is taken for the Play CDN, a plain script is not', () => {
  assert.equal(isTailwindPlay(FAKE_CDN), true);
  assert.equal(isTailwindPlay(APP), false);
});

test('without the compiler the page is drawn the same, and a class only a script adds has its rule', () => withCopy({ 'index.html': pageHtml(BODY) }, async (dir, list) => {
  const { plan, open } = await planTailwind({ browser, copyDir: dir, pages: list });
  assert.deepEqual(open, []);
  assert.ok(plan, 'a plan');
  const css = await readFile(path.join(dir, plan.file), 'utf8');
  assert.match(css, /\.tw-open\{background-color:rgb\(0, ?0, ?200\)\}/, 'the class the script adds');
  assert.match(css, /\.tw-brand\{color:rgb\(0, ?128, ?0\)\}/, 'the page\'s config');

  const $ = load(await readFile(path.join(dir, 'index.html'), 'utf8'));
  const r = replaceTailwindPlay($, list[0], dir, plan);
  assert.equal(r.fixed.length, 1);
  assert.equal(r.fixed[0].removed, 2);
  assert.equal($('script[src*="tailwindcss"]').length, 0);
  assert.equal($('#tailwind-config').length, 0);
  assert.equal($('head > link[rel="stylesheet"]').last().attr('href'), plan.href);

  const original = await stylesOf(dir, pageHtml(BODY));
  const copy = await stylesOf(dir, $.html(), { withCdn: false });
  assert.deepEqual(copy.read, original.read);
  assert.deepEqual(copy.errors, []);
  const originalOpen = await stylesOf(dir, pageHtml(BODY), { click: true });
  const copyOpen = await stylesOf(dir, $.html(), { click: true, withCdn: false });
  assert.equal(originalOpen.read['#menu'].background, 'rgb(0, 0, 200)');
  assert.deepEqual(copyOpen.read, originalOpen.read);
}));

test('another script using the `tailwind` global keeps the compiler: in the copy\'s files, or inline on one page', async () => {
  await withCopy({ 'index.html': pageHtml(BODY) }, async (dir, list) => {
    const r = await planTailwind({ browser, copyDir: dir, pages: list });
    assert.equal(r.plan, null);
    assert.match(r.open[0].detail, /app\.js uses its `tailwind` global/);
  }, { app: 'tailwind.config.theme.brand = "red";' });
  await withCopy({ 'index.html': pageHtml(BODY, { extra: '<script>console.log(tailwind.config)</script>' }) }, async (dir, list) => {
    const { plan } = await planTailwind({ browser, copyDir: dir, pages: list });
    const $ = load(await readFile(path.join(dir, 'index.html'), 'utf8'));
    const r = replaceTailwindPlay($, list[0], dir, plan);
    assert.equal(r.fixed.length, 0);
    assert.match(r.open[0].detail, /another of its scripts uses the `tailwind` global/);
    assert.equal($('script[src*="tailwindcss"]').length, 1);
  });
});

test('pages with different configs keep the compiler, and the report says why', () => withCopy({
  'index.html': pageHtml(BODY),
  'about/index.html': pageHtml(BODY, { config: '<script>tailwind.config = { theme: { brand: "red" } }</script>' }),
}, async (dir, list) => {
  const r = await planTailwind({ browser, copyDir: dir, pages: list });
  assert.equal(r.plan, null);
  assert.match(r.open[0].detail, /different `tailwind\.config` settings/);
}));
