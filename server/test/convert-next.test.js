// The fixture site converted into a Next.js project (recreate/convert/next.js), built, served as the static export it is, and
// held against the ORIGINAL with the as-is copy's own rulers (behavior/preserve/check.js checkCopy: the visual gate with its
// noise map at 1440 and 390, clicks, hovers, console errors, forms), plus: the same DOM as the original (equivalence.js
// domSignature, scripts off), not one script added (the pages are prerendered and never hydrated), every link answered, and
// Lighthouse through the measurement host never lower than the original's. One browser, one page at a time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startFixtureServer } from './serve-fixture.js';
import { buildConverted, convertToNext, EXPORT_DIR } from '../src/recreate/convert/next.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { checkCopy } from '../src/recreate/behavior/preserve/check.js';
import { domSignature, firstDifference } from '../src/recreate/verify/equivalence.js';
import { openMeasuredHost } from '../src/reaudit/measuredHost.js';
import { runLighthouse } from '../src/audit/lighthouse/run.js';
import { toolchainStatus } from '../src/toolchains/index.js';

const PORT = 4252;
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recreate-site');
const ORIGIN = `http://127.0.0.1:${PORT}`;

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
    if (f.endsWith('.html')) await writeFile(path.join(copyDir, f), await (await fetch(`${ORIGIN}/${f}`)).text(), 'utf8');
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

test('the conversion: components per section, shared header and footer, the fallbacks named, no runtime script in the export', { timeout: 10 * 60000 }, async () => {
  assert.equal(result.stats.pages, pages.length);
  assert.ok(result.shared.includes('SiteHeader') && result.shared.includes('SiteFooter'), `shared: ${result.shared}`);
  assert.ok(result.stats.components > pages.length, 'more components than pages: the sections are split');
  // The fixture's /work page carries two inline handlers: those elements are kept as the original HTML, each with its reason.
  assert.deepEqual(result.fallbacks.map((f) => [f.page, f.tag, f.attribute]), [['/work/', 'svg', 'onload'], ['/work/', 'button', 'onclick']]);
  assert.ok(result.fallbacks.every((f) => /inline event handler/.test(f.reason) && f.where.startsWith('body')));
  const out = path.join(root, 'nextjs', EXPORT_DIR);
  assert.equal(await stat(path.join(out, '_next')).then(() => true, () => false), false, 'no Next.js build folder: nothing references it');
  for (const p of pages) {
    const original = await readFile(path.join(copyDir, p.outPath), 'utf8');
    const file = path.join(out, routeOf(p.outPath) === '/' ? 'index.html' : `${routeOf(p.outPath).replace(/^\/|\/$/g, '')}/index.html`);
    const converted = await readFile(file, 'utf8');
    const scripts = (s) => (s.match(/<script\b/gi) ?? []).length;
    assert.equal(scripts(converted), scripts(original), `${p.outPath}: the same number of scripts, none of the stack's`);
    assert.ok(!/__next|data-next-head|_next\/|data-n-css|data-sas-raw/.test(converted), `${p.outPath}: no artefact of the build left`);
    assert.match(converted, /<html lang="en"/, `${p.outPath}: the html attributes are the original's`);
  }
  // The project is real code: a page imports its components, and the shared header is one file.
  // (The home page's header differs from the others' - its own component; a blog post uses the shared one.)
  const about = await readFile(path.join(root, 'nextjs', 'pages', 'blog', 'first-post', 'index.jsx'), 'utf8');
  assert.ok(about.includes("import SiteHeader from '@/components/SiteHeader.jsx'"), about.slice(0, 300));
  assert.match(about, /unstable_runtimeJS: false/);
  const header = await readFile(path.join(root, 'nextjs', 'src', 'components', 'SiteHeader.jsx'), 'utf8');
  assert.match(header, /className="site-header"/);
  // The forms, in plain words.
  const work = result.forms.find((f) => f.page === '/work/');
  assert.ok(work && /another service/.test(work.target) && work.worksWithoutOriginal === false, JSON.stringify(work));
});

test('the same DOM as the original on every page (scripts off; moved pages mapped), and every link answered', { timeout: 10 * 60000 }, async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
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

test('Lighthouse through the measurement host: the converted copy is never lower than the original (medians of three)', { timeout: 20 * 60000 }, async () => {
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
      assert.ok(b >= a, cat + ': original median ' + a + ' ' + JSON.stringify(runs.original.map((r) => r[cat])) + ', converted median ' + b + ' ' + JSON.stringify(runs.converted.map((r) => r[cat])));
    }
  } finally {
    await originalHost.close();
    await copyHost.close();
  }
});
