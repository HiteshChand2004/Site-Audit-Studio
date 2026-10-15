// The targeted script lift (CLONER_SPEC decision 1, Phase 2 item 2): every script the original loaded is classified from
// the job's network record; on pages that keep the original markup, a library that starts by itself from that markup ships
// byte for byte and drives it - the copy's own rebuilt behaviour stands aside there - while trackers and the site's own
// code never ship. Everything local: the "library" below is written for this test and carries the markers the real one
// ships (detection/rules/alpine.json), so it is classified as that library.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { servePreview } from '../src/recreate/preview.js';
import { seedProject, skipStages } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

// Starts itself: binds every [x-data] area on load; a button in it toggles the area's [x-show] panel.
const LIBRARY = `/* tiny self-starting UI library for the lift test */
(function () {
  var err = 'Alpine Expression Error';
  function start() {
    document.dispatchEvent(new CustomEvent('alpine:init'));
    document.querySelectorAll('[x-data]').forEach(function (area) {
      var panel = area.querySelector('[x-show]');
      var button = area.querySelector('button');
      if (!panel || !button) return;
      button.addEventListener('click', function () { panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden)); });
    });
  }
  window.Alpine = { start: start, version: 'test', error: err };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
`;
// A tracker: only sends data (never lifted).
const TRACKER = "window.GoogleAnalyticsObject = 'ga'; (window.dataLayer = window.dataLayer || []).push({ event: 'page_view' });";
// The site's own small script (never lifted on sight: it needs the measured-role rule).
const SITE = "document.documentElement.dataset.site = 'ran';";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lift</title>
<style>body { margin: 0; font-family: system-ui, sans-serif; } .faq { padding: 40px; } .faq button { padding: 8px 14px; } .faq p { margin: 12px 0; }</style>
<script src="/vendor/alpine.min.js" defer></script>
<script src="/analytics.js" async></script>
<script src="/site.js" defer></script>
</head><body>
<section class="faq" x-data><button type="button" aria-expanded="false">What is it?</button><p x-show hidden>It is a test of the lift.</p></section>
<footer style="height: 400px">Footer</footer>
</body></html>`;

let server;
let site;
let browser;
before(async () => {
  server = http.createServer((req, res) => {
    const body = { '/': PAGE, '/vendor/alpine.min.js': LIBRARY, '/analytics.js': TRACKER, '/site.js': SITE }[req.url];
    if (body == null) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://localhost:${server.address().port}`;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

const recreate = async (exact) => {
  const project = seedProject(db, { name: 'lift', url: `${site}/`, recreatePages: -1, analysis: true });
  const recreateId = randomUUID();
  const report = await runRecreate({
    project, recreateId, progress: () => {}, ...(exact && { exact: true }),
    stages: { ...STAGES, ...skipStages('sweep', 'exactCapture', 'exact', 'responsive', 'stack') },
  });
  return { report, dir: recreateDir(project.id, recreateId) };
};

// Clicks the question twice and reads whether the answer shows after each click.
async function toggles(url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const shown = () => page.evaluate(() => {
      const p = [...document.querySelectorAll('p')].find((e) => e.textContent.includes('test of the lift'));
      return Boolean(p && !p.hidden && getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().height > 0);
    });
    const before = await shown();
    await page.getByRole('button', { name: 'What is it?' }).click();
    await page.waitForTimeout(300);
    const once = await shown();
    await page.getByRole('button', { name: 'What is it?' }).click();
    await page.waitForTimeout(300);
    return [before, once, await shown()];
  } finally {
    await page.close();
  }
}

test('exact copy: the self-starting library ships byte for byte and drives its markup; tracker and site code never ship', async () => {
  const { report, dir } = await recreate(true);
  const scripts = report.scripts;
  assert.ok(scripts, 'scripts are classified');
  assert.equal(scripts.byRole.library, 1, JSON.stringify(scripts));
  assert.equal(scripts.byRole.tracker, 1, JSON.stringify(scripts));
  assert.deepEqual(scripts.lift.lifted.map((l) => l.lib), ['alpine']);
  const lifted = (await readdir(path.join(dir, 'dist', 'js', 'lift')));
  assert.equal(lifted.length, 1);
  assert.match(lifted[0], /^alpine-[0-9a-f]{10}\.js$/);
  assert.equal(await readFile(path.join(dir, 'dist', 'js', 'lift', lifted[0]), 'utf8'), LIBRARY, 'byte for byte, unminified');
  const html = await readFile(path.join(dir, 'dist', 'index.html'), 'utf8');
  assert.match(html, /<script src="js\/lift\/alpine-[0-9a-f]{10}\.js" defer><\/script>/);
  assert.doesNotMatch(html, /analytics|site\.js/, 'the tracker and the site\'s own script are not in the copy');
  assert.equal(report.safety.safe, true, JSON.stringify(report.safety.issues));

  const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
  try {
    // One click opens, the next closes - exactly as on the original: one script drives the area, never two.
    assert.deepEqual(await toggles(`${site}/`), [false, true, false], 'the original');
    assert.deepEqual(await toggles(`${served.origin}/`), [false, true, false], 'the copy');
  } finally {
    await served.close();
  }
});

// A static server for a built app (no CSP: the behaviour is what is checked; the stack builds run their own safety scan).
async function serveStatic(root) {
  const s = http.createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    for (const c of p.endsWith('/') ? [`${p}index.html`] : [p, `${p}/index.html`, `${p}.html`]) {
      try {
        const body = await readFile(path.join(root, c));
        res.writeHead(200, { 'content-type': c.endsWith('.html') ? 'text/html; charset=utf-8' : c.endsWith('.js') ? 'text/javascript' : c.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
        return res.end(body);
      } catch {
        // next candidate
      }
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) };
}

test('React + Vite, Next.js and MERN: the lifted library is injected after mount, once, and drives the same markup', async () => {
  const { toolchainStatus } = await import('../src/toolchains/index.js');
  const { buildStackOutput } = await import('../src/recreate/export/fromIr.js');
  const ready = [];
  for (const [stack, toolchain] of [['react-vite', 'react-vite'], ['nextjs', 'next'], ['mern', 'mern']]) {
    if ((await toolchainStatus(toolchain)).installed) ready.push(stack);
  }
  if (!ready.length) return;
  const { report, dir } = await recreate(true);
  for (const stack of ready) {
    const output = await buildStackOutput({ dir, stack, report });
    assert.equal(output.status, 'ready', stack);
    const served = await serveStatic(path.join(dir, 'stacks', stack, output.dist));
    try {
      assert.deepEqual(await toggles(`${served.origin}/`), [false, true, false], stack);
    } finally {
      await served.close();
    }
  }
});

test('the safety gate refuses a lifted file that is not the recorded library it is named after', async () => {
  const { scanSite } = await import('../src/recreate/verify/safety.js');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-lift-'));
  try {
    await mkdir(path.join(root, 'js', 'lift'), { recursive: true });
    await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><script src="js/lift/alpine-0123456789.js" defer></script></head><body></body></html>');
    await writeFile(path.join(root, 'js', 'lift', 'alpine-0123456789.js'), 'fetch("https://elsewhere.example/")');
    const result = await scanSite(root, { app: 'motion' });
    assert.equal(result.safe, false);
    assert.ok(result.issues.some((i) => /not the recorded library/.test(i.detail)), JSON.stringify(result.issues));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('normal copy: scripts are classified and reported, nothing is lifted (the markup is the copy\'s own)', async () => {
  const { report, dir } = await recreate(false);
  assert.ok(report.scripts?.total >= 3, JSON.stringify(report.scripts));
  assert.equal(report.scripts.lift, undefined);
  const html = await readFile(path.join(dir, 'dist', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /js\/lift\//);
});
