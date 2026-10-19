// Exact mode, phase B2: every probe on every view. A page whose menu only exists on a phone, whose carousel only a
// tablet shows and whose hover only a wide window has is captured in both modes, and the two are compared.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { capturePage, motionFile } from '../src/recreate/capture/index.js';
import { readPageMotion } from '../src/recreate/ir/motion.js';

const PORT = 4208;

// Three layouts, each with an interactive part the others do not have.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Layouts</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body { margin: 0; font: 16px/1.5 system-ui; }
  .wide-only, .pad-only, .phone-only { display: none; }
  .panel { display: none; }
  .panel.open { display: block; }
  /* A hover only a wide window has. */
  @media (min-width: 1100px) {
    .wide-only { display: block; }
    .wide-only a:hover { background: rgb(250, 230, 200); color: rgb(120, 40, 0); }
  }
  /* A tablet collapses the nav into a button of its own. */
  @media (min-width: 700px) and (max-width: 1099px) { .pad-only { display: block; } }
  /* A phone has a hamburger instead. */
  @media (max-width: 699px) { .phone-only { display: block; } }
  .bar { height: 50px; background: #123; }
  .tall { height: 1600px; }
</style></head><body>
  <div class="bar"></div>
  <nav class="wide-only"><a href="#one">One</a> <a href="#two">Two</a></nav>
  <div class="pad-only">
    <button type="button" id="pad-toggle" aria-expanded="false">Sections</button>
    <div class="panel" id="pad-panel">Tablet sections</div>
  </div>
  <div class="phone-only">
    <button type="button" id="burger" aria-expanded="false">Menu</button>
    <div class="panel" id="burger-panel">Phone menu</div>
  </div>
  <div class="tall"></div>
<script>
  for (const [b, p] of [['pad-toggle', 'pad-panel'], ['burger', 'burger-panel']]) {
    const button = document.getElementById(b);
    const panel = document.getElementById(p);
    if (!button) continue;
    button.addEventListener('click', function () {
      const open = panel.classList.toggle('open');
      button.setAttribute('aria-expanded', String(open));
    });
  }
</script></body></html>`;

let server;
let browser;
let dir;
const page = { path: '/', slug: 'index', url: `http://127.0.0.1:${PORT}/` };

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-probes-'));
});

after(async () => {
  await browser?.close().catch(() => {});
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const budgets = { motionBudgetMs: 6000, clickBudgetMs: 8000, timeout: 30000 };

test('an ordinary copy probes the desktop view, and clicks the narrow ones briefly', async () => {
  const work = path.join(dir, 'normal');
  const r = await capturePage(browser, page, work, budgets);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const files = await readdir(path.join(work, 'capture', 'index'));
  // One motion file, from the desktop view, and a short click pass for the two narrow views.
  assert.ok(files.includes('motion.json'));
  assert.ok(!files.some((f) => f.endsWith('-motion.json')), JSON.stringify(files));
  assert.ok(files.includes('mobile-clicks.json'));
  assert.ok(files.includes('tablet-clicks.json'));
  // Only the desktop view carries a motion summary.
  assert.ok(r.views.desktop.motion);
  assert.equal(r.views.tablet.motion, undefined);
  assert.equal(r.views.mobile.motion, undefined);
});

test('an exact copy probes every view, and each writes its own findings', async () => {
  const work = path.join(dir, 'exact');
  const r = await capturePage(browser, page, work, { ...budgets, exact: true });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const files = await readdir(path.join(work, 'capture', 'index'));
  for (const view of ['laptop', 'tablet', 'mobile']) {
    assert.ok(files.includes(motionFile(view)), `${view}: ${JSON.stringify(files)}`);
    assert.ok(r.views[view].motion, `${view} has a summary of its own`);
    assert.equal(r.views[view].motion.view, view);
  }
  assert.ok(files.includes('motion.json'));
  // The short narrow-view pass is not run as well: the full probe already clicked those views.
  assert.ok(!files.includes('mobile-clicks.json'), JSON.stringify(files));
});

test('the control a phone has and the desktop does not is found on the phone', async () => {
  const work = path.join(dir, 'exact');
  const phone = JSON.parse(await readFile(path.join(work, 'capture', 'index', motionFile('mobile')), 'utf8'));
  const desktop = JSON.parse(await readFile(path.join(work, 'capture', 'index', 'motion.json'), 'utf8'));
  const texts = (m) => (m.clicks?.widgets ?? []).map((w) => String(w.text ?? '').toLowerCase()).join(' ');
  // The hamburger exists only under 700 px, so only the phone's probe can have opened it.
  assert.match(texts(phone), /menu/, JSON.stringify((phone.clicks?.widgets ?? []).map((w) => w.text)));
  assert.ok(!/menu/.test(texts(desktop)), 'and the desktop probe never saw it');
  // The tablet has a control of its own, which is neither of those.
  const tablet = JSON.parse(await readFile(path.join(work, 'capture', 'index', motionFile('tablet')), 'utf8'));
  assert.match(texts(tablet), /sections/);
});

test('the hover only a wide window has is found on a wide view', async () => {
  const work = path.join(dir, 'exact');
  const desktop = JSON.parse(await readFile(path.join(work, 'capture', 'index', 'motion.json'), 'utf8'));
  // The rule is inside a min-width query, so a narrow view cannot see it at all.
  const rules = JSON.stringify(desktop.rules ?? []);
  assert.match(rules, /wide-only/);
  const phone = JSON.parse(await readFile(path.join(work, 'capture', 'index', motionFile('mobile')), 'utf8'));
  assert.ok(!/rgb\(250, 230, 200\)/.test(JSON.stringify(phone.hover ?? [])), 'the phone has no such hover to find');
});

test('the narrow-layout controls still reach the IR, and what cannot be rebuilt yet is named', async () => {
  const work = path.join(dir, 'exact');
  const motion = await readPageMotion(work, page);
  // The path the IR has always used for a narrow view's controls keeps working, now fed by the per-view file.
  assert.ok(motion.clicksMobile, 'the phone controls are where the IR looks for them');
  assert.ok(motion.clicksTablet);
  // And every view says what it found, with the kinds this builder does not place yet listed rather than dropped.
  assert.ok(motion.byView.mobile, JSON.stringify(Object.keys(motion.byView ?? {})));
  assert.deepEqual(motion.byView.mobile.rebuilt, ['clicks']);
  assert.ok(Array.isArray(motion.byView.mobile.notRebuilt));
  assert.ok(motion.byView.laptop, 'the laptop view is probed too');
  // The laptop has no path map, so even its controls are listed as not rebuilt - said, not hidden.
  assert.deepEqual(motion.byView.laptop.rebuilt, []);
});

test('an ordinary copy keeps exactly the behaviour it had', async () => {
  const work = path.join(dir, 'normal');
  const motion = await readPageMotion(work, page);
  assert.ok(motion.clicksMobile, 'from the short narrow-view pass, as before');
  assert.equal(motion.byView, undefined, 'and no per-view findings, because no other view was probed');
});
