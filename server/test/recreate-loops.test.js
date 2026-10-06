// Recreate 4b.3: continuous motion capture (capture/loops.js) on a local page with known loops.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { analyzeSeries, captureLoops, classifyKeyframes, keyframeValues } from '../src/recreate/capture/loops.js';
import { startSiteServer } from '../src/recreate/verify/server.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loops</title>
<style>
body { margin: 0; font: 16px sans-serif; }
.b { width: 120px; height: 40px; margin: 10px; background: #ddd; }
.spin { animation: spin 2s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.wrap { width: 400px; overflow: hidden; }
.track { display: flex; width: max-content; animation: marquee 20s linear infinite; }
@keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.pulse { animation: pulse 1.5s ease-in-out infinite alternate; }
@keyframes pulse { from { opacity: 0.4; transform: scale(1); } to { opacity: 1; transform: scale(1.15); } }
.after::after { content: ''; display: block; width: 20px; height: 20px; border: 3px solid #333; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; }
.paused { animation: spin 3s linear infinite; animation-play-state: paused; }
.shake { animation: shake 0.3s ease-in-out 3; }
@keyframes shake { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(6px); } }
.once { animation: once 0.5s ease-out 1 forwards; }
@keyframes once { from { opacity: 0; } to { opacity: 1; } }
.tr { transition: transform 3s; }
.tr.go { transform: translateX(100px); }
</style></head><body>
<div class="b spin" id="spin">spinner</div>
<div class="wrap"><div class="track" id="marquee"><span>alpha beta gamma</span><span>alpha beta gamma</span></div></div>
<div class="b pulse" id="pulse">pulse</div>
<div class="b after" id="after">pseudo</div>
<div class="b paused" id="paused">paused</div>
<div class="b shake" id="shake">shake</div>
<div class="b once" id="once">one shot</div>
<div class="b tr" id="tr">transition</div>
<div class="b" id="waapi">waapi float</div>
<div class="b" id="jsspin">script spin</div>
<div style="width: 400px; overflow: hidden"><div class="b" id="jsmarquee" style="width: 100px">script marquee</div></div>
<div class="b" id="jssine">script oscillate</div>
<div class="b" id="jsfloat">slow float</div>
<script>
document.getElementById('waapi').animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-12px)' }], { duration: 1200, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
setTimeout(() => document.getElementById('tr').classList.add('go'), 50);
const spin = document.getElementById('jsspin');
const mq = document.getElementById('jsmarquee');
const sine = document.getElementById('jssine');
const float = document.getElementById('jsfloat');
const tick = (now) => {
  spin.style.transform = 'rotate(' + ((now / 1000) * 180) + 'deg)';
  mq.style.transform = 'translateX(' + ((now / 1000) * 120 % 300) + 'px)';
  sine.style.transform = 'translateY(' + (20 * Math.sin((now / 1000) * Math.PI)) + 'px)';
  // A shape floating 12 px up and down every 5 s: in a short recording it only goes one way.
  float.style.transform = 'translateY(' + (12 * Math.sin((now / 1000) * (2 * Math.PI / 5))) + 'px)';
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
</script></body></html>`;

let dir;
let site;
let browser;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-loops-'));
  await writeFile(path.join(dir, 'index.html'), PAGE);
  site = await startSiteServer(dir);
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('keyframes are classified: spin, marquee (percent kept), pulse, float, dash, background', () => {
  const kf = (...props) => props.map((p, i) => ({ offset: i / (props.length - 1), props: p }));
  const lin = { easing: 'linear', direction: 'normal' };
  assert.equal(classifyKeyframes(kf({ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }), lin).pattern, 'spin');
  assert.equal(classifyKeyframes(kf({ rotate: '0turn' }, { rotate: '1turn' }), lin).params.degrees, 360);
  const mq = classifyKeyframes(kf({ transform: 'translateX(0px)' }, { transform: 'translateX(-50%)' }), lin);
  assert.equal(mq.pattern, 'marquee');
  assert.deepEqual(mq.params.distance, { px: 0, percent: -50 });
  assert.equal(classifyKeyframes(kf({ transform: 'translateY(0)' }, { transform: 'translateY(-12px)' }), { easing: 'ease', direction: 'alternate' }).pattern, 'float');
  assert.equal(classifyKeyframes(kf({ opacity: '0.4', transform: 'scale(1)' }, { opacity: '1', transform: 'scale(1.15)' }), { direction: 'alternate' }).pattern, 'pulse');
  assert.equal(classifyKeyframes(kf({ opacity: '0.2' }, { opacity: '1' }), { direction: 'alternate' }).pattern, 'blink');
  assert.equal(classifyKeyframes(kf({ 'stroke-dashoffset': '100' }, { 'stroke-dashoffset': '0' }), lin).pattern, 'dash');
  assert.equal(classifyKeyframes(kf({ 'background-position': '0 0' }, { 'background-position': '200% 0' }), lin).pattern, 'background-scroll');
  // A round trip through the keyframes (0 -> -6px -> 0) floats; holds make a rotator a cycle.
  const bob = classifyKeyframes(kf({ transform: 'translate(-50%, -50%) translateY(0px)' }, { transform: 'translate(-50%, -50%) translateY(-6px)' }, { transform: 'translate(-50%, -50%) translateY(0px)' }), lin);
  assert.equal(bob.pattern, 'float');
  const cycle = classifyKeyframes(kf({ transform: 'translateX(0px)' }, { transform: 'translateX(0px)' }, { transform: 'translateX(54px)' }, { transform: 'translateX(54px)' }, { transform: 'translateX(79px)' }, { transform: 'translateX(79px)' }), lin);
  assert.equal(cycle.pattern, 'cycle');
  assert.equal(cycle.params.stops, 4);
  assert.equal(keyframeValues({ transform: 'translate(10px, 20px) rotate(45deg) scale(2)' }).ty, 20);
});

test('recorded series are analysed: spin rate, drift with wrap-around, oscillation', () => {
  const frames = (fn, ms = 1400) => Array.from({ length: Math.floor(ms / 16.7) }, (_, i) => {
    const t = i * 16.7;
    const v = fn(t / 1000);
    return [t, v.transform ?? 'none', String(v.opacity ?? 1), 'none', 'none', 'none'];
  });
  const rot = (deg) => { const r = (deg * Math.PI) / 180; return `matrix(${Math.cos(r)}, ${Math.sin(r)}, ${-Math.sin(r)}, ${Math.cos(r)}, 0, 0)`; };
  const spin = analyzeSeries(frames((s) => ({ transform: rot(s * 180) })));
  assert.equal(spin.pattern, 'spin');
  assert.ok(Math.abs(spin.rate - 180) < 8, JSON.stringify(spin));
  const drift = analyzeSeries(frames((s) => ({ transform: `matrix(1, 0, 0, 1, ${(s * 400) % 200}, 0)` })));
  assert.equal(drift.pattern, 'drift');
  assert.ok(Math.abs(drift.rate - 400) < 30 && drift.wrap, JSON.stringify(drift));
  assert.ok(Math.abs(drift.periodMs - 500) < 60 || drift.periodMs == null, JSON.stringify(drift));
  const sine = analyzeSeries(frames((s) => ({ transform: `matrix(1, 0, 0, 1, 0, ${20 * Math.sin(s * Math.PI)})` }), 2400));
  assert.equal(sine.pattern, 'oscillate');
  assert.ok(Math.abs(sine.periodMs - 2000) < 200 && Math.abs(sine.amplitude - 20) < 2, JSON.stringify(sine));
  assert.equal(analyzeSeries(frames(() => ({ transform: 'none' }))), null);
});

test('declared and script-driven loops are found; one-shot animations and transitions are not', async () => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  await page.goto(`${site.origin}/`, { waitUntil: 'load' });
  await page.waitForTimeout(700); // the one-shot animation has ended
  const { loops, stats } = await captureLoops(page);
  const at = (id) => loops.find((l) => l.text?.startsWith(id));
  const byPath = (re) => loops.filter((l) => re.test(l.path));

  const spin = at('spinner');
  assert.equal(spin.source, 'css-animation');
  assert.equal(spin.name, 'spin');
  assert.equal(spin.inStylesheet, true);
  assert.equal(spin.pattern, 'spin');
  assert.equal(spin.timing.duration, 2000);
  assert.equal(spin.timing.iterations, 'infinite');
  assert.equal(spin.timing.easing, 'linear');

  const mq = loops.find((l) => l.name === 'marquee');
  assert.equal(mq.pattern, 'marquee');
  assert.equal(mq.timing.duration, 20000);
  assert.equal(mq.params.distance.percent, -50);

  const pulse = at('pulse');
  assert.equal(pulse.pattern, 'pulse');
  assert.match(pulse.timing.direction, /alternate/);

  const pseudo = loops.find((l) => l.pseudo === '::after');
  assert.ok(pseudo && pseudo.pattern === 'spin', JSON.stringify(loops.map((l) => [l.pseudo, l.pattern])));

  const paused = at('paused');
  assert.equal(paused.timing.playState, 'paused');

  const shake = at('shake');
  assert.equal(shake.timing.iterations, 3);

  const waapi = at('waapi');
  assert.equal(waapi.source, 'waapi');
  assert.equal(waapi.pattern, 'float');
  assert.equal(waapi.timing.duration, 1200);

  assert.ok(!at('one shot'), 'a one-shot animation is not a loop');
  assert.ok(!at('transition'), 'a transition is not a loop');

  const scriptSpin = at('script spin');
  assert.equal(scriptSpin.source, 'script');
  assert.equal(scriptSpin.pattern, 'spin');
  assert.ok(Math.abs(scriptSpin.params.rate - 180) < 20, JSON.stringify(scriptSpin.params));
  const scriptMq = at('script marquee');
  assert.equal(scriptMq.pattern, 'drift');
  assert.ok(Math.abs(scriptMq.params.rate - 120) < 20, JSON.stringify(scriptMq.params));
  const scriptSine = at('script oscillate');
  assert.equal(scriptSine.pattern, 'oscillate');
  assert.ok(Math.abs(scriptSine.params.periodMs - 2000) < 300, JSON.stringify(scriptSine.params));

  const slowFloat = at('slow float');
  assert.equal(slowFloat.pattern, 'oscillate', `watched longer, a slow float turns: ${JSON.stringify(slowFloat.params)}`);
  assert.ok(Math.abs(slowFloat.params.periodMs - 5000) < 800, JSON.stringify(slowFloat.params));

  assert.ok(stats.css >= 5 && stats.waapi === 1 && stats.script === 4 && stats.paused === 1, JSON.stringify(stats));
  assert.equal(byPath(/./).length, loops.length);
  await context.close();
});
