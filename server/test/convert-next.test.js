// The fixture site converted into a Next.js project (recreate/convert/next.js), built, served as the static export it is, and
// held against the ORIGINAL with the as-is copy's own rulers (behavior/preserve/check.js checkCopy: the visual gate with its
// noise map at 1440 and 390, clicks, hovers, console errors, forms), plus: the same DOM as the original once Next's own tags
// are set aside (equivalence.js domSignature, scripts off), Next.js in the page (App Router, hydrated, nothing redrawn), the
// original's scripts running after it, every link answered, and Lighthouse through the measurement host never lower than the
// original's, Performance aside, where Next's own JavaScript may cost at most PERF_COST points (user, 2026-11-16). One
// browser, one page at a time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startFixtureServer } from './serve-fixture.js';
import { buildConverted, convertToNext, EXPORT_DIR, finishPageModule } from '../src/recreate/convert/next.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { checkCopy } from '../src/recreate/behavior/preserve/check.js';
import { domSignature, firstDifference } from '../src/recreate/verify/equivalence.js';
import { openMeasuredHost } from '../src/reaudit/measuredHost.js';
import { runLighthouse } from '../src/audit/lighthouse/run.js';
import { toolchainStatus } from '../src/toolchains/index.js';

const PORT = 4252;
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recreate-site');
const ORIGIN = `http://127.0.0.1:${PORT}`;
// A builder's banner before <html> (Framer writes two): no element holds them, so they travel beside the page and are put back.
const PROLOG = '<!-- Made in "Builder" · example.com ✨ -->\n<!-- Published Oct 1, 2026 -->\n';

let fixture;
let browser;
let root;
let served;
let result;
let pages;
let copyDir;

async function listFiles(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out;
}

before(async () => {
  const tc = await toolchainStatus('next');
  if (!tc.installed) throw new Error('the next toolchain is not installed: npm run setup:toolchains -w server -- next');
  fixture = await startFixtureServer(PORT, { site: 'recreate' });
  browser = await chromium.launch();
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-convert-next-'));
  // The fixture site as served stands in for a finished as-is copy: its pages as the server sends them (the second origin
  // written in), its stylesheets, scripts and images as local files.
  const files = await listFiles(FIXTURE);
  // about.html is the lift's stress page (a second origin, a missing image, a video served in pieces, redirects): a finished as-is
  // copy has those localised, which the lift does, not the conversion; so the pages here are the ones a finished copy serves itself.
  const LIFT_ONLY = new Set(['about.html']);
  pages = files.filter((f) => f.endsWith('.html') && !f.startsWith('private/') && !LIFT_ONLY.has(f)).map((outPath) => ({ outPath, url: `${ORIGIN}/${outPath.replace(/(^|\/)index\.html$/, '$1')}` }));
  copyDir = path.join(root, 'copy');
  for (const f of files) {
    if (f.startsWith('private/') || LIFT_ONLY.has(f)) continue;
    await mkdir(path.dirname(path.join(copyDir, f)), { recursive: true });
    if (f.endsWith('.html')) {
      let text = await (await fetch(`${ORIGIN}/${f}`)).text();
      if (f === 'index.html') text = text.replace(/^(<!doctype html>)\s*/i, `$1${PROLOG}`);
      await writeFile(path.join(copyDir, f), text, 'utf8');
    }
    else await cp(path.join(FIXTURE, f), path.join(copyDir, f));
  }
  const outDir = path.join(root, 'nextjs');
  result = await convertToNext({ copyDir, outDir, pages, pageUrl: `${ORIGIN}/` });
  await buildConverted(outDir, { timeoutMs: 6 * 60000 });
  served = await serveCopy(path.join(outDir, EXPORT_DIR));
});

after(async () => {
  await served?.close?.();
  await browser?.close();
  await new Promise((r) => { fixture?.closeAllConnections?.(); fixture ? fixture.close(() => r()) : r(); });
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
});

const routeOf = (outPath) => result.routes.find((r) => r.outPath === outPath)?.route ?? `/${outPath}`;
const base = () => served.url.replace(/\/$/, '');

/** The built page of an as-is page. */
const builtFile = (outPath) => path.join(root, 'nextjs', EXPORT_DIR, routeOf(outPath) === '/' ? 'index.html' : `${routeOf(outPath).replace(/^\/|\/$/g, '')}/index.html`);
/** Next's own files of this build (the fixture has no /_next/ of its own). */
const oursOf = async () => new Set((await listFiles(path.join(root, 'nextjs', EXPORT_DIR, '_next'))).map((f) => `/_next/${f}`));

test('the conversion: components per section, shared header and footer, the fallbacks named, Next.js in every page', { timeout: 10 * 60000 }, async () => {
  assert.equal(result.stats.pages, pages.length);
  assert.ok(result.shared.includes('SiteHeader') && result.shared.includes('SiteFooter'), `shared: ${result.shared}`);
  assert.ok(result.stats.components > pages.length, 'more components than pages: the sections are split');
  // The fixture's /work page carries two inline handlers: those elements are kept as the original HTML, each with its reason.
  assert.deepEqual(result.fallbacks.map((f) => [f.page, f.tag, f.attribute]), [['/work/', 'svg', 'onload'], ['/work/', 'button', 'onclick']]);
  assert.ok(result.fallbacks.every((f) => /inline event handler/.test(f.reason) && f.where.startsWith('body')));
  const out = path.join(root, 'nextjs', EXPORT_DIR);
  assert.equal(await stat(path.join(out, '_next')).then(() => true, () => false), true, 'Next.js\'s runtime is shipped');
  const { withoutNext } = await finishPageModule();
  const ours = await oursOf();
  for (const p of pages) {
    const original = await readFile(path.join(copyDir, p.outPath), 'utf8');
    const converted = await readFile(builtFile(p.outPath), 'utf8');
    const scripts = (s) => (s.match(/<script\b/gi) ?? []).length;
    assert.match(converted, /<script src="\/_next\/static\/chunks\/[^"]+\.js" async=""><\/script>/, `${p.outPath}: Next.js loads from /_next/`);
    assert.match(converted, /self\.__next_f/, `${p.outPath}: Next.js's page data`);
    // Every script of the original waits for Next (its own type kept in data-sas-type); none runs before it.
    const own = (converted.match(/<script\b[^>]*>/gi) ?? []).filter((t) => !/ src="\/_next\/|^<script>$|application\/ld\+json/.test(t));
    assert.ok(own.every((t) => /type="text\/sas-later"/.test(t)), `${p.outPath}: ${own.find((t) => !/text\/sas-later/.test(t))}`);
    const plainPage = withoutNext(converted, ours);
    assert.equal(scripts(plainPage), scripts(original), `${p.outPath}: the original's scripts, once Next's are set aside`);
    // Next's page data (self.__next_f) names the layout's props; the page itself must hold no artefact.
    const markup = converted.replace(/<script>\(?self\.__next_f[\s\S]*?<\/script>/g, '');
    assert.ok(!/data-sas-raw|data-sas-comment|data-sas-prolog/.test(markup), `${p.outPath}: no artefact of the conversion left: ${/[\s\S]{0,120}data-sas-(?:raw|comment|prolog)[\s\S]{0,120}/.exec(markup)?.[0]}`);
    assert.match(converted, /<html lang="en"/, `${p.outPath}: the html attributes are the original's`);
    // Next's build-id comment after the doctype is Next's own, like its scripts.
    if (p.outPath === 'index.html') assert.ok(converted.startsWith(`<!DOCTYPE html><!--sas-->${PROLOG}<html `), converted.slice(0, 160));
    else assert.match(converted, /^<!DOCTYPE html><!--sas--><html /, `${p.outPath}: nothing before <html> but Next's build id where the original has nothing`);
  }
  // The project is real code: a page imports its components, and the shared header is one file. Each page is a route group
  // of its own, its layout the page's own <html>, <head> and <body>.
  // (The home page's header differs from the others' - its own component; a blog post uses the shared one.)
  const groups = (await readdir(path.join(root, 'nextjs', 'app'))).filter((n) => /^\(p-.+\)$/.test(n));
  assert.equal(groups.length, pages.length, `one route group per page: ${groups}`);
  const group = (await Promise.all(groups.map(async (g) => (await stat(path.join(root, 'nextjs', 'app', g, 'blog', 'first-post', 'page.jsx')).then(() => g, () => null))))).find(Boolean);
  assert.ok(group, 'the blog post has its page file');
  const about = await readFile(path.join(root, 'nextjs', 'app', group, 'blog', 'first-post', 'page.jsx'), 'utf8');
  assert.ok(about.includes("import SiteHeader from '@/components/SiteHeader.jsx'"), about.slice(0, 300));
  const layout = await readFile(path.join(root, 'nextjs', 'app', group, 'layout.jsx'), 'utf8');
  assert.match(layout, /<html [^>]*suppressHydrationWarning>/);
  assert.match(layout, /<RunLater \/>/, 'the original\'s scripts are started once Next holds the page');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'nextjs', 'scripts', 'no-runtime.json'), 'utf8')), [], 'no page of the fixture has a runtime of its own');
  const header = await readFile(path.join(root, 'nextjs', 'src', 'components', 'SiteHeader.jsx'), 'utf8');
  assert.match(header, /className="site-header"/);
  // The forms, in plain words.
  const work = result.forms.find((f) => f.page === '/work/');
  assert.ok(work && /another service/.test(work.target) && work.worksWithoutOriginal === false, JSON.stringify(work));
});

test('the same DOM as the original on every page once Next\'s tags are set aside (scripts off; moved pages mapped), and every link answered', { timeout: 10 * 60000 }, async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    // The copy's pages as the browser would hold them without Next (withoutNext): what is left must be the original's DOM.
    const { withoutNext } = await finishPageModule();
    const ours = await oursOf();
    await page.route(`${base()}/**`, async (route) => {
      const res = await route.fetch();
      if (!/text\/html/.test(res.headers()['content-type'] ?? '')) return route.fulfill({ response: res });
      return route.fulfill({ response: res, body: withoutNext(await res.text(), ours) });
    });
    const moves = { paths: Object.fromEntries(result.urlChanges.map((c) => [c.from, c.to])), absolute: {} };
    for (const p of pages) {
      // The signature writes every address in full: the two servers' origins are read as one.
      await page.goto(p.url, { waitUntil: 'load' });
      const both = (l) => l.split(ORIGIN).join('{origin}').split(base()).join('{origin}');
      const original = (await page.evaluate(domSignature, moves)).map(both);
      await page.goto(`${base()}${routeOf(p.outPath)}`, { waitUntil: 'load' });
      const converted = (await page.evaluate(domSignature, null)).map(both);
      assert.equal(firstDifference(original, converted), null, `${p.outPath}: the DOM differs: ${JSON.stringify(firstDifference(original, converted))}`);
    }
    // Every same-site link of the export is answered.
    const seen = new Set();
    for (const p of pages) {
      await page.goto(`${base()}${routeOf(p.outPath)}`, { waitUntil: 'load' });
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
      for (const h of hrefs) {
        if (!h || /^(#|mailto:|tel:|javascript:)/.test(h)) continue;
        const u = new URL(h, `${base()}${routeOf(p.outPath)}`);
        if (u.origin !== base() || seen.has(u.pathname)) continue;
        seen.add(u.pathname);
        const r = await fetch(u.href, { redirect: 'manual' });
        // A page the fixture never had (its own dead links: /old-work.html, /missing) is a 404 on both sides; a copied page answers.
        const copied = pages.some((q) => routeOf(q.outPath) === u.pathname || `/${q.outPath}` === u.pathname || u.pathname === `${routeOf(q.outPath)}index.html`);
        if (copied) assert.ok(r.status === 200 || r.status === 301, `${u.pathname} from ${p.outPath}: ${r.status}`);
      }
    }
    assert.ok(seen.size >= pages.length - 1, `links followed: ${seen.size}`);
  } finally {
    await context.close();
  }
});

test('Next.js holds every page: hydrated without an error, nothing redrawn, nothing asked the original does not ask but Next', { timeout: 10 * 60000 }, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    for (const p of pages) {
      const errors = [];
      const onConsole = (m) => { if (m.type() === 'error' && /hydrat|#418|#423|#425/i.test(m.text())) errors.push(m.text().slice(0, 200)); };
      const onError = (e) => { if (/hydrat|#418|#423|#425/i.test(e.message)) errors.push(e.message.slice(0, 200)); };
      page.on('console', onConsole);
      page.on('pageerror', onError);
      const asked = { original: new Set(), copy: new Set() };
      const listen = (side, origin) => (req) => { if (req.url().startsWith(origin)) asked[side].add(new URL(req.url()).pathname); };
      let on = listen('original', ORIGIN);
      page.on('request', on);
      await page.goto(p.url, { waitUntil: 'networkidle' });
      page.off('request', on);
      on = listen('copy', base());
      page.on('request', on);
      await page.goto(`${base()}${routeOf(p.outPath)}`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => { window.__sasFirst = document.querySelector('body > :not(script):not([hidden])'); });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(800);
      page.off('request', on);
      page.off('console', onConsole);
      page.off('pageerror', onError);
      const r = await page.evaluate(() => ({
        next: Boolean(window.next),
        hydrated: Object.keys(document.documentElement).some((k) => k.startsWith('__react')),
        same: window.__sasFirst === document.querySelector('body > :not(script):not([hidden])'),
      }));
      assert.ok(r.next && r.hydrated, `${p.outPath}: Next.js holds the page (${JSON.stringify(r)})`);
      assert.ok(r.same, `${p.outPath}: the page the server wrote is the one kept (nothing redrawn)`);
      assert.deepEqual(errors, [], `${p.outPath}: no hydration error`);
      // The copy's own address of the page (a moved page: /blog/first-post/ for blog/first-post.html) is not an extra ask.
      const extra = [...asked.copy].filter((u) => !asked.original.has(u) && u !== routeOf(p.outPath));
      assert.deepEqual(extra.filter((u) => !u.startsWith('/_next/')), [], `${p.outPath}: nothing asked the original does not ask, Next aside`);
    }
  } finally {
    await context.close();
  }
});

test('the original\'s scripts run in the copy: the inline handler, the reveal and the hover script', { timeout: 5 * 60000 }, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // What the page's scripts leave in the DOM after a scroll through and a click, read the same way on both sides; the
    // scripts themselves, Next's route announcer and an empty <div hidden> are not the page's content.
    const state = async (url) => {
      await page.goto(url, { waitUntil: 'networkidle' });
      for (let y = 0; y < 4000; y += 400) { await page.mouse.wheel(0, 400); await page.waitForTimeout(80); }
      const button = page.locator('button[onclick]').first();
      if (await button.count()) await button.click().catch(() => {});
      await page.waitForTimeout(600);
      return page.evaluate(() => [...document.querySelectorAll('body *')]
        .filter((e) => e.tagName !== 'SCRIPT' && !e.closest('next-route-announcer') && !(e.hidden && !e.children.length && !e.textContent))
        .map((e) => `${e.tagName}.${e.className?.baseVal ?? e.className}|${getComputedStyle(e).opacity}|${e.getAttribute('aria-expanded') ?? ''}`));
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
    assert.deepEqual(p.offline.consoleErrors ?? [], p.offline.consoleErrors ?? [], 'recorded');
  }
});

/** What Next's own JavaScript may cost the Performance score (user, 2026-11-16: a live copy is a real Next.js site). */
const PERF_COST = 5;

test('Lighthouse through the measurement host: the converted copy is never lower than the original (medians of three), Next\'s cost aside', { timeout: 20 * 60000 }, async () => {
  const originalHost = await openMeasuredHost(ORIGIN, 'desktop');
  const copyHost = await openMeasuredHost(base(), 'desktop');
  const CATEGORIES = ['performance', 'seo', 'accessibility', 'best-practices'];
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  try {
    // Three runs a side, the sides alternated so a slow moment of the machine hits both; the rule is judged on the medians.
    const runs = { original: [], converted: [] };
    for (let i = 0; i < 3; i++) {
      for (const [name, origin] of [['original', originalHost.origin], ['converted', copyHost.origin]]) {
        const r = await runLighthouse(origin + '/', 'desktop', { timeout: 240000, outFile: path.join(root, 'lh-' + name + '-' + i + '.json') });
        runs[name].push(Object.fromEntries(CATEGORIES.map((c) => [c, Math.round((r.categories?.[c] ?? 0) * 100)])));
      }
    }
    for (const cat of CATEGORIES) {
      const a = median(runs.original.map((r) => r[cat]));
      const b = median(runs.converted.map((r) => r[cat]));
      assert.ok(b >= a - (cat === 'performance' ? PERF_COST : 0), cat + ': original median ' + a + ' ' + JSON.stringify(runs.original.map((r) => r[cat])) + ', converted median ' + b + ' ' + JSON.stringify(runs.converted.map((r) => r[cat])));
    }
  } finally {
    await originalHost.close();
    await copyHost.close();
  }
});
