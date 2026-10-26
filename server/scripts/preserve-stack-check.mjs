// Packages one lifted copy into one app stack (or serves the plain copy as it is), builds and runs it, and checks it:
//   offline    a cold first visit (fresh browser context, no service worker) makes no request off the copy's own server;
//              responses of 400 or more are listed by address
//   visual     full-page screenshots against the original at 1440 and 390 px (raw pixel difference)
//   controls   every visible button / summary / [aria-expanded] / tab is clicked on both sides; does the page change the same way?
//              a control the original shows that the copy does not is "excluded by rule" when it is a fixed-position widget
//              whose third-party script the lift excluded; otherwise it is "missing"
//   hovers     the first links and buttons: does a hover change colour or background on both sides the same way?
//   forms      every form is filled with a test value and submitted: nothing may leave the copy; the note it shows is recorded
//   lighthouse one desktop run (a sanity check, not the 5-run protocol)
// Usage: node scripts/preserve-stack-check.mjs <stack|html> <copyDir> <originalUrl> <outDir> <port>
import { spawn } from 'node:child_process';
import { mkdir, readFile, rmdir, symlink, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { packLifted } from '../src/recreate/behavior/preserve/pack.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { exactDiff } from '../src/recreate/verify/exact/pixels.js';
import { scriptCandidates } from '../src/recreate/behavior/preserve/extract.js';
import { readRecordIndex, classifyScripts, recordBodyReader } from '../src/recreate/behavior/scripts.js';
import { runToolchain } from '../src/recreate/build/toolchain.js';
import { runLighthouse } from '../src/audit/lighthouse/run.js';

const [stack, copyDir, originalUrl, outDir, portArg] = process.argv.slice(2);
const port = Number(portArg ?? 4300);
const CAPTURE = path.resolve(process.env.CAPTURE_ROOT ?? '../data/preserve/work/nyaayai/capture');
const SERVER = path.resolve('.');
const toolchainOf = { 'react-vite': 'react-vite', nextjs: 'next', mern: 'mern' };
// The stack's address; "html" checks the plain copy served as it is (serve.js), not a packed stack.
let base = `http://127.0.0.1:${port}`;
const isLocal = (url) => url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:');

const log = (...a) => console.error('[check]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (f) => stat(f).then(() => true, () => false);

/** Starts a packed stack's own server on the port; resolves with a stop function once it answers. */
async function start(dir) {
  // Every stack runs with its toolchain's packages linked in (removed again when the server stops).
  const modules = path.join(dir, 'node_modules');
  await symlink(path.join(SERVER, 'toolchains', toolchainOf[stack], 'node_modules'), modules, 'junction');
  const args = {
    'react-vite': ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    nextjs: ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'],
    mern: ['server/src/index.js'],
  }[stack];
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: { ...process.env, PORT: String(port), NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const stop = async () => {
    child.kill();
    await sleep(500);
    await rmdir(modules).catch(() => unlink(modules)).catch(() => {});
  };
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/`);
      if (res.status < 500) return { stop };
    } catch { /* not yet */ }
    await sleep(1000);
  }
  await stop();
  throw new Error(`the ${stack} server did not answer on ${base}: ${out.slice(-800)}`);
}

async function build(dir) {
  if (stack === 'react-vite') {
    return runToolchain({ dir, toolchain: 'react-vite', timeoutMs: 6 * 60000, steps: [{ label: 'vite build', args: ['vite', 'build'] }] });
  }
  if (stack === 'nextjs') {
    return runToolchain({ dir, toolchain: 'next', timeoutMs: 8 * 60000, steps: [{ label: 'next build', args: ['node_modules/next/dist/bin/next', 'build'] }] });
  }
  return null; // MERN: nothing to build
}

/** Opens the page and scrolls it the way a visitor does (the lazy parts load). */
async function openAndScroll(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(1500);
  for (let y = 0; y < 14000; y += 400) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
}

async function rgbOf(buf) {
  const img = sharp(buf);
  const { width, height } = await img.metadata();
  const raw = await img.removeAlpha().raw().toBuffer();
  return { raw, width, height };
}

/** A context whose requests off the copy's own server are refused, and recorded. */
async function isolated(browser, viewport, outside) {
  const context = await browser.newContext(viewport);
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isLocal(url)) return route.continue();
    outside.push(url);
    return route.abort();
  });
  return context;
}

async function offlineCheck(browser) {
  const outside = [];
  const errors = [];
  const failed = [];
  const context = await isolated(browser, { viewport: { width: 1440, height: 900 } }, outside);
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(base, '')}`); });
    await openAndScroll(page, `${base}/`);
    const sw = await page.evaluate(() => (navigator.serviceWorker?.controller ? 'controlled' : 'not controlled')).catch(() => 'n/a');
    return { external: [...new Set(outside)], errors, failed: [...new Set(failed)], serviceWorker: sw };
  } finally {
    await context.close();
  }
}

async function visualCheck(browser, width) {
  const mobile = width < 600;
  const opts = { viewport: { width, height: mobile ? 844 : 900 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile };
  const outside = [];
  const copy = await isolated(browser, opts, outside);
  const original = await browser.newContext(opts);
  try {
    const cp = await copy.newPage();
    await openAndScroll(cp, `${base}/`);
    const op = await original.newPage();
    await openAndScroll(op, originalUrl);
    // The app's one picture ruler (verify/exact/pixels.js), as the as-is check uses it.
    const d = await exactDiff(await op.screenshot({ fullPage: true, type: 'png' }), await cp.screenshot({ fullPage: true, type: 'png' }));
    return { width, copyHeight: d.heights[1], originalHeight: d.heights[0], diffPct: d.widthMismatch ? null : d.commonPct };
  } finally {
    await copy.close();
    await original.close();
  }
}

/** Clicks each control in turn on a fresh load; records whether the page's text changed and whether the control is fixed-position. */
async function clickProfile(browser, url, isCopy) {
  const outside = [];
  const context = isCopy ? await isolated(browser, { viewport: { width: 1440, height: 900 } }, outside) : await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    const page = await context.newPage();
    const selector = 'button, summary, [aria-expanded], [role="tab"]';
    await openAndScroll(page, url);
    const count = Math.min(await page.locator(selector).count(), 24);
    for (let i = 0; i < count; i++) {
      await page.goto(url, { waitUntil: 'load', timeout: 120000 });
      await page.waitForTimeout(800);
      const el = page.locator(selector).nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) { results.push({ i, visible: false }); continue; }
      const label = (await el.innerText().catch(() => '')).trim().slice(0, 40) || (await el.getAttribute('aria-label').catch(() => '')) || '';
      const fixed = await el.evaluate((e) => {
        for (let p = e; p; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return true;
        return false;
      }).catch(() => false);
      const before = await page.evaluate(() => document.body.innerText);
      await el.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => document.body.innerText);
      results.push({ i, visible: true, label, fixed, changed: before !== after });
    }
  } finally {
    await context.close();
  }
  return results;
}

async function hoverProfile(browser, url, isCopy) {
  const outside = [];
  const context = isCopy ? await isolated(browser, { viewport: { width: 1440, height: 900 } }, outside) : await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    const page = await context.newPage();
    await openAndScroll(page, url);
    const selector = 'a, button';
    const count = Math.min(await page.locator(selector).count(), 20);
    for (let i = 0; i < count; i++) {
      const el = page.locator(selector).nth(i);
      if (!(await el.isVisible().catch(() => false))) { results.push({ i, visible: false }); continue; }
      const style = () => page.evaluate((s) => {
        const e = document.querySelectorAll(s.q)[s.i];
        if (!e) return null;
        const c = getComputedStyle(e);
        return [c.color, c.backgroundColor, c.textDecorationLine, c.opacity, c.transform].join('|');
      }, { q: selector, i });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(350);
      const rest = await style();
      await el.hover({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(700);
      const hovered = await style();
      await page.mouse.move(0, 0);
      results.push({ i, visible: true, changed: rest !== hovered });
    }
  } finally {
    await context.close();
  }
  return results;
}

/**
 * Submits every form of the copy with a test value. Nothing may leave the copy: any request off its server is refused and
 * counted here. The note the form shows afterwards is recorded.
 */
async function formCheck(browser) {
  const outside = [];
  const context = await isolated(browser, { viewport: { width: 1440, height: 900 } }, outside);
  const forms = [];
  let count = 0;
  try {
    const page = await context.newPage();
    await openAndScroll(page, `${base}/`);
    count = await page.locator('form').count();
    for (let i = 0; i < count; i++) {
      const form = page.locator('form').nth(i);
      const fields = form.locator('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea');
      const n = await fields.count();
      for (let j = 0; j < n; j++) {
        const field = fields.nth(j);
        if (!(await field.isVisible().catch(() => false))) continue;
        const type = (await field.getAttribute('type')) ?? '';
        await field.fill(type === 'email' ? 'check@example.test' : 'Test value').catch(() => {});
      }
      const before = outside.length;
      await form.locator('button[type=submit], input[type=submit], button:not([type])').first().click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const note = await form.locator('[data-sas-form-note]').textContent().catch(() => null);
      forms.push({ i, fields: n, attempts: outside.length - before, note: note?.trim() ?? null });
    }
  } finally {
    await context.close();
  }
  return { count, forms, outsideAttempts: outside.length };
}

const summarize = (rs) => ({
  visible: rs.filter((r) => r.visible).length,
  changed: rs.filter((r) => r.changed).length,
});

/** The controls the original shows that the copy does not, split into missing and excluded by rule. */
function controlGaps(copy, original, excludedHosts) {
  const copyLabels = new Set(copy.filter((r) => r.visible).map((r) => r.label));
  const missing = original.filter((o) => o.visible && !copyLabels.has(o.label));
  const excludedByRule = missing.filter((o) => o.fixed && excludedHosts.length > 0);
  return {
    missing: missing.filter((o) => !excludedByRule.includes(o)).map((o) => ({ label: o.label, fixed: o.fixed })),
    excludedByRule: excludedByRule.map((o) => ({ label: o.label || '(icon)', why: 'a fixed-position widget; its third-party script is excluded by rule', hosts: excludedHosts })),
  };
}

/** The third-party hosts the lift excluded by rule (trackers, chat widgets, the builder's editor): from the capture's record. */
async function excludedHostsOf() {
  const dir = path.join(CAPTURE, '.network');
  if (!(await exists(path.join(dir, 'index.json')))) return [];
  const siteHost = new URL(originalUrl).hostname.replace(/^www\./, '');
  const index = await readRecordIndex(dir);
  const classes = await classifyScripts(index, recordBodyReader(dir), { origin: originalUrl });
  return [...new Set(scriptCandidates(classes, siteHost).filter((s) => s.status === 'excluded').map((s) => new URL(s.url).hostname))];
}

async function main() {
  const dir = path.resolve(outDir);
  let serving;
  let needsAPerson = [];
  if (stack === 'html') {
    const served = await serveCopy(path.resolve(copyDir));
    base = served.url.replace(/\/$/, '');
    serving = { stop: served.close };
    const html = await readFile(path.join(path.resolve(copyDir), 'index.html'), 'utf8');
    const forms = (html.match(/<form[\s>]/gi) ?? []).length;
    if (forms) needsAPerson = [{ kind: 'form', count: forms, why: 'its data is never sent to the original site; connect FORM_ENDPOINT in sas-forms.json' }];
    log('serving the plain copy at', base);
  } else {
    log('packing', stack);
    const packed = await packLifted({ stack, copyDir: path.resolve(copyDir), outDir: dir, pageUrl: originalUrl });
    needsAPerson = packed.needsAPerson;
    const built = await build(dir);
    if (built) log('built', JSON.stringify(built.steps.map((s) => `${s.label} ${s.ms}ms`)));
    serving = await start(dir);
  }
  const browser = await chromium.launch();
  const report = { stack, url: base, needsAPerson };
  try {
    report.offline = await offlineCheck(browser);
    log('offline', JSON.stringify(report.offline).slice(0, 300));
    report.visual = [];
    for (const width of [1440, 390]) {
      report.visual.push(await visualCheck(browser, width));
      log('visual', JSON.stringify(report.visual.at(-1)));
    }
    // CHECK_ONLY=visual stops after the screenshots (a quick look at one stack's visual difference).
    if (process.env.CHECK_ONLY === 'visual') {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const copyClicks = await clickProfile(browser, `${base}/`, true);
    const origClicks = await clickProfile(browser, originalUrl, false);
    const mismatch = [];
    for (let i = 0; i < Math.max(copyClicks.length, origClicks.length); i++) {
      const a = copyClicks[i];
      const b = origClicks[i];
      if (a?.visible && b?.visible && Boolean(a.changed) !== Boolean(b.changed)) mismatch.push({ i, copy: a.changed, original: b.changed, label: b.label });
    }
    const excludedHosts = await excludedHostsOf();
    report.controls = { copy: summarize(copyClicks), original: summarize(origClicks), mismatch, ...controlGaps(copyClicks, origClicks, excludedHosts) };
    log('controls', JSON.stringify(report.controls).slice(0, 400));
    const copyHover = await hoverProfile(browser, `${base}/`, true);
    const origHover = await hoverProfile(browser, originalUrl, false);
    const hm = [];
    for (let i = 0; i < Math.max(copyHover.length, origHover.length); i++) {
      const a = copyHover[i];
      const b = origHover[i];
      if (a?.visible && b?.visible && Boolean(a.changed) !== Boolean(b.changed)) hm.push({ i, copy: a.changed, original: b.changed });
    }
    report.hovers = { copy: summarize(copyHover), original: summarize(origHover), mismatch: hm };
    log('hovers', JSON.stringify(report.hovers).slice(0, 300));
    report.forms = await formCheck(browser);
    log('forms', JSON.stringify(report.forms).slice(0, 300));
  } finally {
    await browser.close();
    await serving.stop();
  }
  // Lighthouse once, desktop, on the same served stack (started again: the server above is stopped).
  const again = stack === 'html' ? await serveCopy(path.resolve(copyDir)) : null;
  if (again) base = again.url.replace(/\/$/, '');
  const served2 = stack === 'html' ? { stop: again.close } : await start(dir);
  try {
    const lhFile = path.join(path.resolve('../data/preserve/work'), `lh-stack-${stack}-desktop.json`);
    await mkdir(path.dirname(lhFile), { recursive: true });
    await runLighthouse(`${base}/`, 'desktop', { timeout: 240000, outFile: lhFile });
    const j = JSON.parse(await readFile(lhFile, 'utf8'));
    report.lighthouseDesktop = {
      perf: Math.round(j.categories.performance.score * 100),
      seo: Math.round(j.categories.seo.score * 100),
      a11y: Math.round(j.categories.accessibility.score * 100),
      bp: Math.round(j.categories['best-practices'].score * 100),
      lcp: Math.round(j.audits['largest-contentful-paint'].numericValue),
    };
  } finally {
    await served2.stop();
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
