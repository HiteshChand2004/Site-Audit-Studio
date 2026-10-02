// Recreate 4b.2: scroll-reveal capture (capture/reveal.js) on a local page with known effects.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { settle } from '../src/recreate/capture/index.js';
import { bezierAt, comparePaths, decomposeTransform, EASINGS, fitEasing, processReveal } from '../src/recreate/capture/reveal.js';
import { startSiteServer } from '../src/recreate/verify/server.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reveal</title>
<style>
body { margin: 0; font: 16px sans-serif; }
.gap { height: 1100px; }
.box { height: 80px; margin: 10px; background: #ddd; }
.css { opacity: 0; transform: translateY(40px); transition: opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1), transform 0.6s cubic-bezier(0.16, 1, 0.3, 1); }
.css.in { opacity: 1; transform: none; }
.list > div { opacity: 0; transform: translateY(20px); transition: opacity 0.4s ease-out, transform 0.4s ease-out; }
.list.in > div { opacity: 1; transform: none; }
.list.in > div:nth-child(2) { transition-delay: 120ms; }
.list.in > div:nth-child(3) { transition-delay: 240ms; }
.list.in > div:nth-child(4) { transition-delay: 360ms; }
.kf { opacity: 0; }
.kf.in { animation: pop 0.5s linear forwards; }
@keyframes pop { from { opacity: 0; transform: scale(0.8); } to { opacity: 1; transform: scale(1); } }
.js { opacity: 0; }
</style></head><body>
<div class="gap">top</div>
<div class="box css" id="css">css transition</div>
<div class="gap"></div>
<div class="list" id="list"><div class="box">one</div><div class="box">two</div><div class="box">three</div><div class="box">four</div></div>
<div class="gap"></div>
<div class="box kf" id="kf">css animation</div>
<div class="gap"></div>
<div class="box js" id="waapi">waapi</div>
<div class="gap"></div>
<div class="box js" id="raf">script driven</div>
<div class="gap"></div>
<div>end</div>
<script>
const io = (el, fn) => new IntersectionObserver((es, o) => es.forEach((e) => { if (e.isIntersecting) { fn(e.target); o.unobserve(e.target); } }), { threshold: 0.2 }).observe(el);
io(document.getElementById('css'), (el) => el.classList.add('in'));
io(document.getElementById('list'), (el) => el.classList.add('in'));
io(document.getElementById('kf'), (el) => el.classList.add('in'));
io(document.getElementById('waapi'), (el) => el.animate([{ opacity: 0, transform: 'translateX(-30px)' }, { opacity: 1, transform: 'none' }], { duration: 700, delay: 50, easing: 'ease-in-out', fill: 'forwards' }));
io(document.getElementById('raf'), (el) => {
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / 500);
    const eased = 1 - Math.pow(1 - p, 3);
    el.style.opacity = String(eased);
    el.style.transform = 'translateY(' + (30 * (1 - eased)) + 'px)';
    if (p < 1) requestAnimationFrame(tick);
  };
  el.style.transform = 'translateY(30px)';
  requestAnimationFrame(tick);
});
</script></body></html>`;

let dir;
let site;
let browser;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-reveal-'));
  await writeFile(path.join(dir, 'index.html'), PAGE);
  site = await startSiteServer(dir);
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('bezier, easing fit, matrix decomposition, path order', () => {
  assert.equal(bezierAt(EASINGS.linear, 0.3).toFixed(3), '0.300');
  assert.ok(bezierAt(EASINGS['ease-out'], 0.5) > 0.5);
  for (const name of ['ease-out', 'ease-in-out', 'cubic-bezier(0.16, 1, 0.3, 1)', 'linear']) {
    const pts = Array.from({ length: 20 }, (_, i) => [(i + 1) / 20, bezierAt(EASINGS[name], (i + 1) / 20)]);
    assert.equal(fitEasing(pts).css, name);
  }
  // A curve between the named ones is fitted to a cubic-bezier with a small error.
  const odd = [0.3, 0.9, 0.6, 1];
  const pts = Array.from({ length: 30 }, (_, i) => [(i + 1) / 30, bezierAt(odd, (i + 1) / 30)]);
  const fit = fitEasing(pts);
  assert.ok(fit.error < 0.03, JSON.stringify(fit));
  assert.deepEqual(decomposeTransform('matrix(1, 0, 0, 1, 0, 40)'), { translate: [0, 40], scale: [1, 1], rotate: 0 });
  assert.deepEqual(decomposeTransform('none'), { translate: [0, 0], scale: [1, 1], rotate: 0 });
  assert.equal(decomposeTransform('matrix(0, 1, -1, 0, 0, 0)').rotate, 90);
  assert.ok(comparePaths('body>div:2', 'body>div:10') < 0);
  assert.ok(comparePaths('body>div:1', 'body>div:1>p:1') < 0);
});

test('processReveal groups siblings and finds a constant stagger', () => {
  const ev = (i) => ({
    path: `body>ul:1>li:${i}`, tag: 'li', text: '', from: { opacity: 0, transform: 'matrix(1, 0, 0, 1, 0, 20)', filter: 'none' }, to: { opacity: 1, transform: 'none', filter: 'none' },
    step: 2, y: 1000, prevY: 200, vh: 900, rect: [0, 1200 + i * 50, 100, 40], replay: false,
    anims: [{ kind: 'transition', props: ['opacity'], duration: 400, delay: i * 100, endDelay: 0, easing: 'ease-out', start: 5000 + i * 100, keyframes: [] }], series: null,
  });
  const r = processReveal([1, 2, 3, 4].map(ev));
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].stagger, { stepMs: 100, jitterMs: 0, order: 'forward' });
  assert.deepEqual(r.elements.map((e) => e.offsetMs), [0, 100, 200, 300]);
  assert.equal(r.elements[0].timing.easing.css, 'ease-out');
  assert.deepEqual(r.elements[0].from.motion.translate, [0, 20]);
  assert.equal(r.stats.staggered, 1);
  assert.equal(r.elements[0].trigger.kind, 'scroll'); // 1200 - 200 > 900
  // Already on screen before the step: a timer, not the scroll.
  const timed = processReveal([{ ...ev(1), rect: [0, 300, 100, 40] }]);
  assert.equal(timed.elements[0].trigger.kind, 'timed');
  assert.equal(timed.stats.timed, 1);
  // Two neighbours are not enough to call it a stagger.
  assert.equal(processReveal([1, 2].map(ev)).groups[0].stagger, null);
});

test('reveal effects are recorded with their timing, easing, stagger and trigger', async () => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  await page.goto(`${site.origin}/`, { waitUntil: 'load' });
  const { events, ...stats } = await settle(page, { width: 1000, height: 700 }, 20000, { observe: true });
  assert.ok(stats.revealed >= 7, JSON.stringify(stats));
  const r = processReveal(events);
  const el = (text) => r.elements.find((e) => e.text.startsWith(text));

  const css = el('css transition');
  assert.equal(css.timing.source, 'transition');
  assert.equal(css.timing.duration, 600);
  assert.equal(css.timing.easing.css, 'cubic-bezier(0.16, 1, 0.3, 1)');
  assert.equal(css.from.opacity, 0);
  assert.deepEqual(css.from.motion.translate, [0, 40]);
  assert.equal(css.to.opacity, 1);
  assert.ok(css.trigger.topBefore > 1 && css.trigger.topAfter < 1.05, JSON.stringify(css.trigger));

  const kf = el('css animation');
  assert.equal(kf.timing.source, 'animation');
  assert.equal(kf.timing.duration, 500);
  assert.equal(kf.from.motion.scale[0], 0.8);

  const waapi = el('waapi');
  assert.equal(waapi.timing.source, 'waapi');
  assert.equal(waapi.timing.duration, 700);
  assert.equal(waapi.timing.delay, 50);
  assert.equal(waapi.timing.easing.css, 'ease-in-out');
  assert.deepEqual(waapi.from.motion.translate, [-30, 0]);

  const raf = el('script driven');
  assert.equal(raf.timing.source, 'sampled');
  assert.ok(raf.timing.duration >= 400 && raf.timing.duration <= 600, JSON.stringify(raf.timing));
  assert.ok(raf.timing.easing.error < 0.1, JSON.stringify(raf.timing.easing));

  const items = ['one', 'two', 'three', 'four'].map(el);
  assert.ok(items.every((e) => e && e.group === items[0].group), JSON.stringify(items.map((e) => e?.group)));
  const group = r.groups.find((g) => g.id === items[0].group);
  assert.ok(group.stagger && group.stagger.stepMs >= 100 && group.stagger.stepMs <= 140, JSON.stringify(group));
  assert.ok(r.stats.declared >= 6, JSON.stringify(r.stats));
  await context.close();
});

test('without observe nothing is recorded and the end state is still pinned', async () => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  await page.goto(`${site.origin}/`, { waitUntil: 'load' });
  const out = await settle(page, { width: 1000, height: 700 }, 20000);
  assert.equal(out.events, undefined);
  assert.ok(out.revealed >= 7);
  await context.close();
});
