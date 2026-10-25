// The fixture site converted into a MERN project (recreate/convert/mern.js), built, run by its own Express server (as "Copy my
// site" runs it: startStack) and held against the ORIGINAL with the as-is copy's own rulers (behavior/preserve/check.js
// checkCopy: the visual gate with its noise map at 1440 and 390, clicks, hovers, console errors), plus: the same DOM as the
// original (equivalence.js domSignature, scripts off), not one script added (the pages are prerendered and never hydrated), every
// link answered, the original's scripts still running, Lighthouse through the measurement host never lower than the original's
// (medians of three, phone and computer), and the forms in a real browser: one that went to the original's own server is sent
// by the copy's form guard to the copy's server and saved, one of another service is not, and without script a form posts to
// its own address and lands on /thanks. One browser, one page at a time. The no-browser half is convert-mern-build.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startFixtureServer } from './serve-fixture.js';
import { buildConvertedMern, convertToMern, MERN_EXPORT_DIR, verifyConvertedMern } from '../src/recreate/convert/mern.js';
import { routeOf } from '../src/recreate/convert/react.js';
import { FORM_GUARD, HOLD_FORMS } from '../src/recreate/behavior/preserve/complete.js';
import { startStack } from '../src/recreate/behavior/preserve/serveStack.js';
import { checkCopy } from '../src/recreate/behavior/preserve/check.js';
import { domSignature, firstDifference } from '../src/recreate/verify/equivalence.js';
import { openMeasuredHost } from '../src/reaudit/measuredHost.js';
import { runLighthouse } from '../src/audit/lighthouse/run.js';
import { toolchainDir, toolchainStatus } from '../src/toolchains/index.js';

const PORT = 4261;
const STACK_PORT = 4262;
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recreate-site');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CATEGORIES = ['performance', 'seo', 'accessibility', 'best-practices'];
// Comments before <html>, as a builder writes them: the converted page must start with them too.
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

/** The console errors the ORIGINAL page shows as it loads (as checkCopy records them, not cut, the address as {origin}). */
async function consoleErrorsOf(url) {
  const context = await browser.newContext();
  const errors = [];
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
  } finally {
    await context.close();
  }
  return errors.map((e) => e.split(ORIGIN).join('{origin}'));
}

const outDir = () => path.join(root, 'mern');
const base = () => served.url.replace(/\/$/, '');

before(async () => {
  const tc = await toolchainStatus('mern');
  if (!tc.installed) throw new Error('the mern toolchain is not installed: npm run setup:toolchains -w server -- mern');
  fixture = await startFixtureServer(PORT, { site: 'recreate' });
  browser = await chromium.launch();
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-convert-mern-'));
  // The fixture site as served stands in for a finished as-is copy (built as convert-react.test.js builds it): its pages as the
  // server sends them, its stylesheets, scripts and images as local files; about.html is the lift's stress page, left to the lift.
  const files = await listFiles(FIXTURE);
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
    } else await cp(path.join(FIXTURE, f), path.join(copyDir, f));
  }
  result = await convertToMern({ copyDir, outDir: outDir(), pages, pageUrl: `${ORIGIN}/` });
  await buildConvertedMern(outDir());
  await verifyConvertedMern({ copyDir, outDir: outDir(), pages });
  served = await startStack('mern', outDir(), STACK_PORT, { env: { FORMS_STORE: 'memory', MONGODB_URI: '' } });
});

after(async () => {
  await served?.stop?.();
  await browser?.close();
  await new Promise((r) => { fixture?.closeAllConnections?.(); fixture ? fixture.close(() => r()) : r(); });
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
});

test('the conversion: components per section, the fallbacks named, the same scripts as the original and no other', async () => {
  assert.equal(result.stats.pages, pages.length);
  assert.ok(result.stats.components > pages.length, 'the pages are split into sections');
  assert.deepEqual(result.fallbacks.map((f) => [f.page, f.tag, f.attribute]), [['/work.html', 'svg', 'onload'], ['/work.html', 'button', 'onclick']]);
  for (const p of pages) {
    const original = await readFile(path.join(copyDir, p.outPath), 'utf8');
    const converted = await readFile(path.join(outDir(), MERN_EXPORT_DIR, p.outPath), 'utf8');
    const scripts = (s) => (s.match(/<script\b/gi) ?? []).length;
    // The page's own doctype as written, then the comments before <html> exactly as the original has them.
    if (p.outPath === 'index.html') assert.ok(converted.startsWith(`<!doctype html>${PROLOG}<html `), converted.slice(0, 160));
    assert.equal(scripts(converted), scripts(original), `${p.outPath}: the same number of scripts, none of React's`);
  }
  // The fixture's forms: /work's builder form service (another service: it goes there, as on the original) and /login's
  // sign-in, on a page without the copy's form guard (the pages as served, not lifted): it goes where the original sent it.
  // Neither is stored by the copy's server, each said in words.
  assert.equal(result.wiredForms, 0);
  assert.deepEqual(result.forms.map((f) => [f.page, f.goesTo]).sort(), [['/login.html', 'as-original'], ['/work.html', 'service']]);
  assert.ok(result.forms.every((f) => f.note), JSON.stringify(result.forms));
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
    // Nothing asked off the copy that the as-is page does not name itself, and no console error the original does not show on
    // the same page (as convert-react.test.js: work.html carries the fixture's unsafe-SVG seed; checkCopy cuts a message at 160
    // characters, so the two sides are compared by prefix with the address written as {origin}).
    const asIsPage = pages.find((q) => routeOf(q.outPath) === p.path);
    const asIs = await readFile(path.join(copyDir, asIsPage.outPath), 'utf8');
    assert.deepEqual((p.offline.external ?? []).filter((u) => !asIs.includes(u)), [], `${p.path}: nothing asked off the copy that the page does not name`);
    const originalErrors = await consoleErrorsOf(asIsPage.url);
    const own = (e) => originalErrors.some((o) => o.startsWith(e.slice(0, Math.max(20, e.length - 12))));
    assert.deepEqual((p.offline.errors ?? []).map((e) => e.split(base()).join('{origin}')).filter((e) => !own(e)), [], `${p.path}: no console error the original does not have (${JSON.stringify(originalErrors)})`);
  }
});

test('the original\'s scripts run in the copy: the inline handler, the reveal and the hover script', { timeout: 5 * 60000 }, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
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

// A page of a finished as-is copy with its form guard: a form that went to the original's own server, one without action, and
// one of another service. Its own small copy, converted and built like the fixture, and run in this process (the project's
// own app.js and store.js), so what was stored can be read.
const FORMS_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Forms</title></head>
<body><main><h1>Forms</h1>
<form id="signup" action="/subscribe" method="post"><label>Email <input name="email" type="email" required></label><input type="hidden" name="token" value="x"><button>Send</button></form>
<form class="contact" method="post"><label>Name <input name="name" required></label><textarea name="message"></textarea><button>Write to us</button></form>
<form class="service" action="https://forms.example-service.io/f/abc" method="post"><input name="email" type="email"><input name="company"><button>Join</button></form>
</main><script>${FORM_GUARD}</script></body></html>
`;

test('the forms in a browser: the copy\'s own saved by its server, another service\'s posted to it as on the original (held in the preview), without script to /thanks', { timeout: 10 * 60000 }, async () => {
  const formsRoot = path.join(root, 'forms');
  const copy = path.join(formsRoot, 'copy');
  await cp(path.join(FIXTURE, 'styles.css'), path.join(copy, 'styles.css'));
  await writeFile(path.join(copy, 'index.html'), FORMS_PAGE, 'utf8');
  await writeFile(path.join(copy, 'sas-forms.json'), '{\n  "endpoint": "",\n  "originalHosts": ["example-original.dev"]\n}\n', 'utf8');
  const project = path.join(formsRoot, 'mern');
  const formPages = [{ outPath: 'index.html', url: 'https://www.example-original.dev/' }];
  await convertToMern({ copyDir: copy, outDir: project, pages: formPages, pageUrl: 'https://www.example-original.dev/' });
  await buildConvertedMern(project);
  await verifyConvertedMern({ copyDir: copy, outDir: project, pages: formPages });
  const modules = path.join(project, 'node_modules');
  await symlink(path.join(toolchainDir('mern'), 'node_modules'), modules, 'junction');
  const { createApp } = await import(pathToFileURL(path.join(project, 'server', 'src', 'app.js')).href);
  const { createMemoryStore } = await import(pathToFileURL(path.join(project, 'server', 'src', 'store.js')).href);
  const store = createMemoryStore();
  const forms = JSON.parse(await readFile(path.join(project, 'server', 'forms.json'), 'utf8'));
  const server = createApp({ store, forms, siteDir: path.join(project, MERN_EXPORT_DIR), logger: { error() {} } }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const site = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  const outside = [];
  const toService = [];
  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.url().startsWith(site)) return route.continue();
    // The form service of the page: answered by a stand-in, so the test sees the post without sending it anywhere.
    if (req.url().startsWith('https://forms.example-service.io/')) {
      toService.push({ method: req.method(), url: req.url() });
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Received</title><h1>Received</h1>' });
    }
    outside.push(req.url());
    return route.abort();
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${site}/`, { waitUntil: 'networkidle' });
    await page.fill('#signup input[name=email]', 'ada@example.test');
    await page.click('#signup button');
    await page.locator('#signup [data-sas-form-note]').filter({ hasText: 'Thank you' }).waitFor({ timeout: 10000 });
    assert.equal(store.docs.length, 1);
    assert.equal(store.docs[0].formId, 'home-1');
    assert.deepEqual(store.docs[0].values, { email: 'ada@example.test' });
    await page.fill('.contact input[name=name]', 'Ada');
    await page.fill('.contact textarea', 'Hello');
    await page.click('.contact button');
    await page.locator('.contact [data-sas-form-note]').filter({ hasText: 'Thank you' }).waitFor({ timeout: 10000 });
    assert.equal(store.docs[1].formId, 'home-2');
    assert.deepEqual(outside, [], 'the copy\'s own forms ask nothing off the copy');
    assert.deepEqual(errors, []);
    // Another service's form, in the download: the browser posts it to that service, as on the original (the request is
    // answered here by a stand-in, never sent); the copy's server stores nothing of it.
    await page.fill('.service input[name=email]', 'ada@example.test');
    await Promise.all([page.waitForURL(/forms\.example-service\.io/, { timeout: 10000 }).catch(() => {}), page.click('.service button')]);
    assert.deepEqual(toService, [{ method: 'POST', url: 'https://forms.example-service.io/f/abc' }]);
    assert.equal(store.docs.length, 2);
    // Held (the app's preview, every check): nothing is sent, and the form says where the download sends it.
    const heldContext = await browser.newContext();
    try {
      await heldContext.addInitScript(HOLD_FORMS);
      const sentHeld = [];
      await heldContext.route('**/*', (route) => (route.request().url().startsWith(site) ? route.continue() : (sentHeld.push(route.request().url()), route.abort())));
      const p = await heldContext.newPage();
      await p.goto(`${site}/`, { waitUntil: 'networkidle' });
      await p.fill('.service input[name=email]', 'ada@example.test');
      await p.click('.service button');
      await p.locator('.service [data-sas-form-note]').filter({ hasText: 'Held in this preview: the downloaded copy sends this form to forms.example-service.io' }).waitFor({ timeout: 10000 });
      assert.deepEqual(sentHeld, []);
      assert.equal(store.docs.length, 2);
    } finally {
      await heldContext.close();
    }
    // Without script the form posts to its own address, as on the original, and the visitor lands on /thanks.
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    try {
      const p = await noJs.newPage();
      await p.goto(`${site}/`);
      await p.fill('#signup input[name=email]', 'grace@example.test');
      await Promise.all([p.waitForURL(/\/thanks/), p.click('#signup button')]);
      assert.match(await p.textContent('h1'), /Thank you/);
      assert.equal(store.docs.at(-1).values.email, 'grace@example.test');
    } finally {
      await noJs.close();
    }
  } finally {
    await context.close();
    await new Promise((r) => server.close(r));
    await rmdir(modules).catch(() => unlink(modules)).catch(() => {});
  }
});

const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

test('Lighthouse through the measurement host, phone and computer: medians of three, the MERN copy never lower than the original', { timeout: 40 * 60000 }, async () => {
  for (const device of ['desktop', 'mobile']) {
    const originalHost = await openMeasuredHost(ORIGIN, device);
    const copyHost = await openMeasuredHost(base(), device);
    try {
      const run = (origin, name) => runLighthouse(`${origin}/`, device, { timeout: 240000, outFile: path.join(root, `lh-${device}-${name}.json`) });
      const scores = { original: [], converted: [] };
      // Three runs a side, alternated (original, then copy); the verdict is on the medians, with no tolerance.
      for (let i = 0; i < 3; i++) {
        for (const [side, origin] of [['original', originalHost.origin], ['converted', copyHost.origin]]) {
          const lhr = await run(origin, `${side}-${i}`);
          scores[side].push(Object.fromEntries(CATEGORIES.map((c) => [c, Math.round((lhr.categories?.[c] ?? 0) * 100)])));
        }
      }
      for (const cat of CATEGORIES) {
        const a = median(scores.original.map((s) => s[cat]));
        const b = median(scores.converted.map((s) => s[cat]));
        assert.ok(b >= a, `${device} ${cat}: original ${a}, MERN copy ${b} (runs: ${JSON.stringify(scores)})`);
      }
    } finally {
      await originalHost.close();
      await copyHost.close();
    }
  }
});
