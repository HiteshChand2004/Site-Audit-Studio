// The fixture site converted into a React + Vite project (recreate/convert/react.js), built, served by its own server (vite
// preview, as "Copy my site" runs it) and held against the ORIGINAL with the as-is copy's own rulers (behavior/preserve/check.js
// checkCopy: the visual gate with its noise map at 1440 and 390, clicks, hovers, console errors, forms), plus: the same DOM as the
// original (equivalence.js domSignature, scripts off), not one script added (the pages are prerendered and never hydrated), every
// link answered, the original's scripts still running (hovers, animations, clicks), and Lighthouse through the measurement host
// never lower than the original's, on phone and computer. One browser, one page at a time. The no-browser half is
// convert-react-build.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startFixtureServer } from './serve-fixture.js';
import { buildConvertedReact, convertToReact, REACT_EXPORT_DIR, routeOf, verifyConverted } from '../src/recreate/convert/react.js';
import { startStack } from '../src/recreate/behavior/preserve/serveStack.js';
import { checkCopy } from '../src/recreate/behavior/preserve/check.js';
import { domSignature, firstDifference } from '../src/recreate/verify/equivalence.js';
import { openMeasuredHost } from '../src/reaudit/measuredHost.js';
import { runLighthouse } from '../src/audit/lighthouse/run.js';
import { toolchainStatus } from '../src/toolchains/index.js';

const PORT = 4253;
const PREVIEW_PORT = 4254;
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recreate-site');
const ORIGIN = `http://127.0.0.1:${PORT}`;

let fixture;
let browser;
let root;
let served;
let result;
let pages;

async function listFiles(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out;
}

const outDir = () => path.join(root, 'react-vite');
const base = () => served.url.replace(/\/$/, '');

before(async () => {
  const tc = await toolchainStatus('react-vite');
  if (!tc.installed) throw new Error('the react-vite toolchain is not installed: npm run setup:toolchains -w server -- react-vite');
  fixture = startFixtureServer(PORT, { site: 'recreate' });
  browser = await chromium.launch();
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-convert-react-'));
  // The fixture's own pages stand in for a finished as-is copy (its pages, stylesheets and scripts are already local files).
  const files = await listFiles(FIXTURE);
  pages = files.filter((f) => f.endsWith('.html') && !f.startsWith('private/')).map((outPath) => ({ outPath, url: `${ORIGIN}/${outPath.replace(/(^|\/)index\.html$/, '$1')}` }));
  result = await convertToReact({ copyDir: FIXTURE, outDir: outDir(), pages, pageUrl: `${ORIGIN}/` });
  await buildConvertedReact(outDir());
  await verifyConverted({ copyDir: FIXTURE, outDir: outDir(), pages });
  served = await startStack('react-vite', outDir(), PREVIEW_PORT);
});

after(async () => {
  await served?.stop?.();
  await browser?.close();
  fixture?.close?.();
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
});

test('the conversion: components per section, the fallbacks named, the same scripts as the original and no other', async () => {
  assert.equal(result.stats.pages, pages.length);
  assert.ok(result.stats.components > pages.length, 'the pages are split into sections');
  // The fixture's /work page carries two inline handlers: those elements are kept as the original HTML, each with its reason.
  assert.deepEqual(result.fallbacks.map((f) => [f.page, f.tag, f.attribute]), [['/work.html', 'svg', 'onload'], ['/work.html', 'button', 'onclick']]);
  assert.ok(result.fallbacks.every((f) => /inline event handler/.test(f.reason) && f.where.startsWith('body')));
  for (const p of pages) {
    const original = await readFile(path.join(FIXTURE, p.outPath), 'utf8');
    const converted = await readFile(path.join(outDir(), REACT_EXPORT_DIR, p.outPath), 'utf8');
    const scripts = (s) => (s.match(/<script\b/gi) ?? []).length;
    assert.equal(scripts(converted), scripts(original), `${p.outPath}: the same number of scripts, none of React's`);
  }
  const work = result.forms.find((f) => f.page === '/work.html');
  assert.ok(!work || work.target, 'a form is described in words');
});

test('in a browser: the same DOM as the original on every page (scripts off), no React in the page, every link answered', { timeout: 10 * 60000 }, async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    for (const p of pages) {
      await page.goto(p.url, { waitUntil: 'load' });
      const original = (await page.evaluate(domSignature, null)).map((l) => l.split(ORIGIN).join('{origin}'));
      await page.goto(`${base()}${routeOf(p.outPath)}`, { waitUntil: 'load' });
      const converted = (await page.evaluate(domSignature, null)).map((l) => l.split(base()).join('{origin}'));
      assert.equal(firstDifference(original, converted), null, `${p.outPath}: the DOM differs: ${JSON.stringify(firstDifference(original, converted))}`);
    }
  } finally {
    await context.close();
  }
  // With scripts on: what the page loads is what the original loads (no request the original does not make).
  const live = await browser.newContext();
  try {
    const page = await live.newPage();
    const seen = new Set();
    for (const p of pages) {
      const asked = { original: new Set(), copy: new Set() };
      const listen = (side, origin) => (req) => { if (req.url().startsWith(origin)) asked[side].add(new URL(req.url()).pathname); };
      let on = listen('original', ORIGIN);
      page.on('request', on);
      await page.goto(p.url, { waitUntil: 'networkidle' });
      page.off('request', on);
      on = listen('copy', base());
      page.on('request', on);
      await page.goto(`${base()}${routeOf(p.outPath)}`, { waitUntil: 'networkidle' });
      page.off('request', on);
      const extra = [...asked.copy].filter((u) => !asked.original.has(u));
      assert.deepEqual(extra, [], `${p.outPath}: the copy asks for nothing the original does not`);
      assert.equal(await page.evaluate(() => Boolean(window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size || document.querySelector('[data-reactroot]'))), false, `${p.outPath}: no React in the page`);
      // Every same-site link of the page answers (a link the fixture itself left dead is a 404 on both sides).
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
      for (const h of hrefs) {
        if (!h || /^(#|mailto:|tel:|javascript:)/.test(h)) continue;
        const u = new URL(h, `${base()}${routeOf(p.outPath)}`);
        if (u.origin !== base() || seen.has(u.pathname)) continue;
        seen.add(u.pathname);
        const [copyStatus, originalStatus] = await Promise.all([
          fetch(u.href, { redirect: 'manual' }).then((r) => r.status),
          fetch(`${ORIGIN}${u.pathname}`, { redirect: 'manual' }).then((r) => r.status),
        ]);
        const copied = pages.some((q) => routeOf(q.outPath) === u.pathname || u.pathname === `${routeOf(q.outPath)}index.html`);
        if (copied) assert.equal(copyStatus, 200, `${u.pathname} from ${p.outPath}`);
        else if (originalStatus === 404) assert.equal(copyStatus, 404, `${u.pathname}: dead on both sides`);
      }
    }
    assert.ok(seen.size >= pages.length - 1, `links followed: ${seen.size}`);
  } finally {
    await live.close();
  }
});

test('held against the original with the as-is rulers: visual gate at 1440 and 390, clicks, hovers, console errors', { timeout: 15 * 60000 }, async () => {
  const checks = await checkCopy({
    browser, base: base(), excludedHosts: [], originalReachable: true,
    pages: pages.map((p) => ({ path: routeOf(p.outPath), url: p.url })),
  });
  for (const p of checks.pages) {
    for (const v of p.visual) {
      assert.equal(typeof v.diffPct, 'number', `${p.path} at ${v.width}: measured (${v.note ?? ''})`);
      assert.ok(v.diffPct <= 0.05, `${p.path} at ${v.width}: ${v.diffPct} % differs outside the noise map (raw ${v.rawDiffPct})`);
      assert.equal(v.copyHeight, v.originalHeight, `${p.path} at ${v.width}: the same height`);
    }
    assert.deepEqual(p.controls.mismatch, [], `${p.path}: every control behaves like the original's`);
    assert.deepEqual(p.controls.missing, [], `${p.path}: no control missing`);
    assert.deepEqual(p.hovers.mismatch, [], `${p.path}: every hover like the original's`);
    assert.deepEqual(p.offline.external ?? [], [], `${p.path}: nothing asked off the copy`);
    assert.deepEqual(p.offline.errors ?? [], [], `${p.path}: no console error`);
  }
});

test('the original\'s scripts run in the copy: the inline handler, the reveal and the hover script', { timeout: 5 * 60000 }, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // What the page's scripts leave in the DOM after a scroll through and a click, read the same way on both sides.
    const state = async (url) => {
      await page.goto(url, { waitUntil: 'networkidle' });
      for (let y = 0; y < 4000; y += 400) { await page.mouse.wheel(0, 400); await page.waitForTimeout(80); }
      const button = page.locator('button[onclick]').first();
      if (await button.count()) await button.click().catch(() => {});
      await page.waitForTimeout(600);
      return page.evaluate(() => [...document.querySelectorAll('body *')].map((e) => `${e.tagName}.${e.className?.baseVal ?? e.className}|${getComputedStyle(e).opacity}|${e.getAttribute('aria-expanded') ?? ''}`));
    };
    for (const p of pages) {
      const a = await state(p.url);
      const b = await state(`${base()}${routeOf(p.outPath)}`);
      assert.deepEqual(b, a, `${p.outPath}: the page's scripts leave the same state`);
    }
  } finally {
    await context.close();
  }
});

/** The median of a list of numbers. */
const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

test('Lighthouse through the measurement host, phone and computer: the converted copy is never lower than the original', { timeout: 40 * 60000 }, async () => {
  for (const device of ['desktop', 'mobile']) {
    const originalHost = await openMeasuredHost(ORIGIN, device);
    const copyHost = await openMeasuredHost(base(), device);
    try {
      const run = (origin, name) => runLighthouse(`${origin}/`, device, { timeout: 240000, outFile: path.join(root, `lh-${device}-${name}.json`) });
      const scores = { original: [], converted: [] };
      // The same DOM and the same files on both sides: a difference is the run's noise. Measured in pairs (original, then copy) until
      // the medians agree, at most three pairs; the verdict is on the medians.
      for (let i = 0; i < 3; i++) {
        for (const [side, origin] of [['original', originalHost.origin], ['converted', copyHost.origin]]) {
          const lhr = await run(origin, `${side}-${i}`);
          scores[side].push(Object.fromEntries(['performance', 'seo', 'accessibility', 'best-practices'].map((c) => [c, Math.round((lhr.categories?.[c] ?? 0) * 100)])));
        }
        const lower = ['performance', 'seo', 'accessibility', 'best-practices'].filter((c) => median(scores.converted.map((s) => s[c])) < median(scores.original.map((s) => s[c])));
        if (!lower.length) break;
      }
      for (const cat of ['performance', 'seo', 'accessibility', 'best-practices']) {
        const a = median(scores.original.map((s) => s[cat]));
        const b = median(scores.converted.map((s) => s[cat]));
        assert.ok(b >= a, `${device} ${cat}: original ${a}, converted ${b} (runs: ${JSON.stringify(scores)})`);
      }
    } finally {
      await originalHost.close();
      await copyHost.close();
    }
  }
});
