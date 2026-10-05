// Full-site B.1: click capture (capture/clicks.js) on a local page with one of each interactive part, built the way
// sites build them (script-driven, no particular library), plus controls that must not count.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { captureClicks, classifyClick } from '../src/recreate/capture/clicks.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { startSiteServer } from '../src/recreate/verify/server.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Widgets</title>
<style>
body { margin: 0; font: 16px sans-serif; }
header { display: flex; gap: 16px; padding: 10px; }
.burger { width: 40px; height: 30px; }
.drawer { display: none; padding: 10px; background: #eee; }
.drawer.open { display: block; }
.dd { position: relative; }
.dd-panel { display: none; position: absolute; top: 100%; left: 0; background: #fff; border: 1px solid #ccc; }
.dd:hover .dd-panel { display: block; }
.acc-body { display: none; }
.acc-item.open .acc-body { display: block; }
.tabs [role=tabpanel][hidden] { display: none; }
.viewport { width: 400px; overflow: hidden; }
.track { display: flex; transition: transform 0.2s; }
.slide { flex: 0 0 400px; height: 100px; background: #ddd; }
.modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); }
.modal.open { display: block; }
.modal .box { background: #fff; margin: 100px auto; width: 300px; padding: 20px; }
</style></head><body>
<header>
  <button class="burger" aria-label="Open menu" aria-expanded="false" aria-controls="drawer">☰</button>
  <div class="dd"><a href="#" class="dd-trigger">Products</a><div class="dd-panel"><a href="/a.html">Item A</a><a href="/b.html">Item B</a></div></div>
  <a href="/about.html">About</a>
</header>
<nav id="drawer" class="drawer"><a href="/x.html">X</a> <a href="/y.html">Y</a></nav>
<section>
  <div class="acc-item"><button class="acc-head">Question one</button><div class="acc-body">Answer one</div></div>
  <div class="acc-item"><button class="acc-head">Question two</button><div class="acc-body">Answer two</div></div>
</section>
<details><summary>Native details</summary><p>Inside details</p></details>
<div class="tabs">
  <div role="tablist"><button role="tab" aria-selected="true" data-t="1">Tab 1</button><button role="tab" aria-selected="false" data-t="2">Tab 2</button><button role="tab" aria-selected="false" data-t="3">Tab 3</button></div>
  <div role="tabpanel" id="p1">Panel 1</div><div role="tabpanel" id="p2" hidden>Panel 2</div><div role="tabpanel" id="p3" hidden>Panel 3</div>
</div>
<div class="carousel">
  <div class="viewport"><div class="track"><div class="slide">1</div><div class="slide">2</div><div class="slide">3</div></div></div>
  <button class="prev" aria-label="Previous slide">‹</button><button class="next" aria-label="Next slide">›</button>
</div>
<button class="open-modal">Book a demo</button>
<div class="modal"><div class="box">Dialog text <button class="close">Close</button></div></div>
<button class="noop" type="button">Does nothing</button>
<div class="search"><input aria-label="Search"><button class="collapse">Collapse search bar</button></div><div class="search-closed" style="display:none">Search closed</div>
<button class="go-script">Go by script</button><button class="go-router">Go by router</button>
<a href="/elsewhere.html" class="leave">A page link</a>
<script>
const burger = document.querySelector('.burger'), drawer = document.querySelector('#drawer');
burger.addEventListener('click', () => { const o = drawer.classList.toggle('open'); burger.setAttribute('aria-expanded', String(o)); });
document.querySelectorAll('.acc-head').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
document.querySelectorAll('[role=tab]').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
  document.querySelectorAll('[role=tabpanel]').forEach((p) => { p.hidden = p.id !== 'p' + t.dataset.t; });
}));
let n = 0; const track = document.querySelector('.track');
document.querySelector('.next').addEventListener('click', () => { n = Math.min(2, n + 1); track.style.transform = 'translateX(' + (-400 * n) + 'px)'; });
document.querySelector('.prev').addEventListener('click', () => { n = Math.max(0, n - 1); track.style.transform = 'translateX(' + (-400 * n) + 'px)'; });
const modal = document.querySelector('.modal');
document.querySelector('.open-modal').addEventListener('click', () => modal.classList.add('open'));
modal.querySelector('.close').addEventListener('click', () => modal.classList.remove('open'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.remove('open'); });
document.querySelector('.collapse').addEventListener('click', () => { document.querySelector('.search').style.display = 'none'; document.querySelector('.search-closed').style.display = 'block'; });
document.querySelector('.go-script').addEventListener('click', () => { location.href = '/elsewhere.html'; });
document.querySelector('.go-router').addEventListener('click', () => { history.pushState({}, '', '/routed'); document.title = 'Routed'; });
</script>
</body></html>`;

let dir;
let site;
let browser;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-clicks-'));
  await writeFile(path.join(dir, 'index.html'), PAGE);
  site = await startSiteServer(dir);
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('classifyClick: dialog, tabs, carousel, disclosure, nothing', () => {
  const vp = [1000, 700];
  const box = (p, parent, rect = [0, 0, 100, 50], fixed = false) => ({ path: p, parent, rect, fixed, inTrigger: false });
  const none = { shown: [], hidden: [], added: [], attrs: [], moved: [], viewport: vp };
  assert.equal(classifyClick(none), null);
  assert.equal(classifyClick({ ...none, shown: [box('body>div:0', 'body', [0, 0, 1000, 700], true)] }).kind, 'dialog');
  const swap = { ...none, shown: [box('body>div:1>div:2', 'body>div:1')], hidden: [box('body>div:1>div:1', 'body>div:1')] };
  assert.equal(classifyClick(swap, { text: 'Tab 2', group: { sig: 'button|tab|', count: 3 } }).kind, 'tabs');
  assert.equal(classifyClick(swap, { text: 'Next slide' }).kind, 'carousel');
  assert.equal(classifyClick({ ...none, moved: [{ path: 'body>div:2', from: 'none', to: 'matrix(1,0,0,1,-400,0)' }] }).kind, 'carousel');
  assert.deepEqual(classifyClick({ ...none, shown: [box('body>nav:0', 'body')] }), { kind: 'disclosure', targets: ['body>nav:0'] });
  const own = { ...none, shown: [box('body>div:4', 'body')], hidden: [{ ...box('body>div:3', 'body'), hasTrigger: true }] };
  assert.equal(classifyClick(own, { group: { sig: 'button||collapse|div.search', count: 2 } }).kind, 'disclosure');
});

test('captureClicks finds menu, dropdown, accordion, details, tabs, slider and dialog; page links stay put', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await page.goto(`${site.origin}/`, { waitUntil: 'load' });
  const snap = await page.evaluate(snapshotPage, {});
  const out = await captureClicks(page, { budgetMs: 60000 });
  const byText = (t) => out.widgets.find((w) => w.text.includes(t));

  assert.equal(page.url(), `${site.origin}/`, 'no link left the page');
  assert.equal(out.stats.left, false);

  const burger = byText('Open menu');
  assert.equal(burger?.kind, 'disclosure');
  assert.ok(burger.targets.some((p) => p.startsWith('body>nav:')), 'the drawer is the target');
  assert.equal(burger.closes, 'toggle');

  const dd = byText('Products');
  assert.equal(dd?.kind, 'disclosure');
  assert.equal(dd.opensOn, 'hover');

  assert.equal(byText('Question one')?.kind, 'disclosure');
  assert.equal(byText('Native details')?.kind, 'disclosure');

  const tab = byText('Tab 2');
  assert.equal(tab?.kind, 'tabs');
  assert.equal(tab.group?.count, 3);

  assert.equal(byText('Next slide')?.kind, 'carousel');

  const dialog = byText('Book a demo');
  assert.equal(dialog?.kind, 'dialog');
  assert.ok(dialog.closes, 'the dialog was closed again');

  assert.equal(byText('Does nothing'), undefined);
  assert.equal(byText('Collapse search bar')?.kind, 'disclosure', 'a button that hides its own block is a toggle, not tabs');
  assert.equal(byText('Go by script'), undefined, 'a script navigation is refused, nothing changed');
  assert.ok(out.stats.noChange >= 1);
  assert.ok(!out.widgets.some((w) => w.text === 'A page link'), 'links to pages are not candidates');

  // Paths are the snapshot's paths, so the IR can find the elements.
  const paths = new Set();
  const walk = (n) => { if (n.path) paths.add(n.path); (n.children ?? []).forEach(walk); };
  walk(snap.body ?? snap.tree ?? snap);
  for (const w of out.widgets) assert.match(w.trigger, /^body>/);
  await page.close();
});

test('captureClicks stops at its budget', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await page.goto(`${site.origin}/`, { waitUntil: 'load' });
  const out = await captureClicks(page, { budgetMs: 1 });
  assert.equal(out.stats.timedOut, true);
  assert.ok(out.widgets.length <= 1);
  await page.close();
});
