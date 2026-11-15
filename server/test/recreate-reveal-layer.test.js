// A reveal in a layer that moves with the window (a fixed header, a stuck sticky bar) is never a scroll reveal: its page
// position follows the scroll, so the capture's "below the screen before the step, on it after" reads it as coming into view
// when it never moved on the screen (motionrepo, 2026-11-15: the pill marking a header's current link). The capture records
// the layer (capture/reveal.js triggerOf → `trigger.layer`, kind 'timed'), and the IR also finds it from the merged tree for
// a capture made before that (ir/motion.js inWindowLayer). An ordinary section revealed by scrolling stays a scroll reveal.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { settle } from '../src/recreate/capture/index.js';
import { processReveal, triggerOf } from '../src/recreate/capture/reveal.js';
import { inWindowLayer, isScrollReveal } from '../src/recreate/ir/motion.js';
import { startSiteServer } from '../src/recreate/verify/server.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Layers</title>
<style>
body { margin: 0; font: 16px sans-serif; }
header { position: fixed; top: 0; left: 0; right: 0; height: 60px; background: #fff; z-index: 2; }
header nav { position: relative; }
.pill { position: absolute; top: 8px; left: 100px; width: 80px; height: 40px; background: #fc0; opacity: 0; transition: opacity 0.3s; }
.pill.on { opacity: 1; }
.bar { position: sticky; top: 60px; height: 40px; background: #eee; z-index: 1; }
.badge { display: inline-block; opacity: 0; transition: opacity 0.3s; }
.badge.on { opacity: 1; }
.gap { height: 1200px; }
.box { height: 80px; margin: 10px; background: #ddd; opacity: 0; transition: opacity 0.5s; }
.box.in { opacity: 1; }
</style></head><body>
<header><nav><a href="/">Home</a><span class="pill" id="pill"></span></nav></header>
<div class="gap" style="height: 100px"></div>
<div class="bar"><span>Bar</span> <span class="badge" id="badge">new</span></div>
<div class="gap"></div>
<div class="box" id="section">section revealed by scrolling</div>
<div class="gap"></div>
<script>
// The header's pill and the bar's badge light up once the page is scrolled (as a scroll-spy does).
addEventListener('scroll', () => {
  if (scrollY > 600) { document.getElementById('pill').classList.add('on'); document.getElementById('badge').classList.add('on'); }
}, { passive: true });
new IntersectionObserver((es, o) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); o.unobserve(e.target); } }), { threshold: 0.2 })
  .observe(document.getElementById('section'));
</script></body></html>`;

let dir;
let site;
let browser;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-reveal-layer-'));
  await writeFile(path.join(dir, 'index.html'), PAGE);
  site = await startSiteServer(dir);
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('the trigger of an element in a window layer reads the same place before and after the step', () => {
  const ev = { rect: [0, 1546, 81, 40], y: 1530, prevY: 0, vh: 900, step: 2 };
  assert.equal(triggerOf(ev).kind, 'scroll', 'without the layer: read as entering (the old reading)');
  const t = triggerOf({ ...ev, layer: 'fixed' });
  assert.equal(t.kind, 'timed');
  assert.equal(t.layer, 'fixed');
  assert.equal(t.topBefore, t.topAfter);
  assert.equal(isScrollReveal({ trigger: t, rect: ev.rect }), false, 'never a scroll reveal, below the first screen or not');
});

test('the merged tree says so for a capture made before the layer was recorded', () => {
  const node = (position, top) => ({ views: { desktop: { style: position ? { position } : {}, rect: [0, top, 100, 40] } } });
  const nodes = new Map([
    ['body>header:1', node('fixed', 0)],
    ['body>header:1>nav:1', node('relative', 0)],
    ['body>header:1>nav:1>span:1', node('absolute', 8)],
    ['body>div:1', node('sticky', 100)],
    ['body>div:1>span:2', node(null, 100)],
    ['body>div:9', node('sticky', 3000)],
    ['body>div:9>span:1', node(null, 3000)],
    ['body>section:1>div:1', node(null, 2400)],
  ]);
  const reveal = (p) => ({ path: p, trigger: { kind: 'scroll' }, rect: [0, 1546, 81, 40] });
  assert.equal(inWindowLayer(reveal('body>header:1>nav:1>span:1'), nodes), true, 'inside a fixed header');
  assert.equal(inWindowLayer(reveal('body>div:1>span:2'), nodes), true, 'inside a sticky bar on the first screen');
  assert.equal(inWindowLayer(reveal('body>div:9>span:1'), nodes), false, 'a sticky box far down the page is scrolled to');
  assert.equal(inWindowLayer(reveal('body>section:1>div:1'), nodes), false, 'an ordinary section');
  assert.equal(inWindowLayer({ path: 'body>x:1', trigger: { kind: 'timed', layer: 'sticky' } }, new Map()), true, 'the capture said so');
});

test('the capture records the layer: the header pill and the stuck bar\'s badge are timed, the section a scroll reveal', async () => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto(`${site.origin}/`, { waitUntil: 'load' });
    const { events } = await settle(page, { width: 1000, height: 700 }, 20000, { observe: true });
    const r = processReveal(events);
    const byPath = (re) => r.elements.find((e) => re.test(e.path));
    const pill = byPath(/header:1>nav:1>span:1$/);
    const badge = byPath(/div:2>span:2$/);
    const section = r.elements.find((e) => e.text?.startsWith('section revealed'));
    assert.ok(pill && badge && section, JSON.stringify(r.elements.map((e) => [e.path, e.trigger])));
    assert.equal(pill.trigger.layer, 'fixed');
    assert.equal(pill.trigger.kind, 'timed');
    assert.equal(isScrollReveal(pill), false);
    assert.equal(badge.trigger.layer, 'sticky');
    assert.equal(isScrollReveal(badge), false);
    assert.equal(section.trigger.layer, undefined);
    assert.equal(section.trigger.kind, 'scroll');
    assert.equal(isScrollReveal(section), true);
  } finally {
    await context.close();
  }
});
