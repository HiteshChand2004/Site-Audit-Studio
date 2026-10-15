// Continuous animation, end to end: one page with every kind of motion that does not wait for the visitor, run through the
// real pipeline (capture → IR → emit → build), then the original and the copy are watched side by side at the same viewport
// over the same 3 s: does each item move, how far, how fast, does its content keep changing.
// When an item is lost the failure says at which stage: not captured (motion.json has no entry for it), captured but not
// rebuilt (the IR's skip reason), or rebuilt but not moving in the copy. Canvas is the unsupported case: it must be
// reported as such, not passed off as copied.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { servePreview } from '../src/recreate/preview.js';
import { seedProject } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
const PORT = 4244;
const origin = `http://localhost:${PORT}`;

// Each item: a unique label (how it is found on both sides, class names change in a rebuilt copy), what it does, and
// what is measured. `kind` names the mechanism, for the diagnostics.
export const ITEMS = [
  { label: 'CSS SPIN', kind: 'css-animation', expect: 'moves' },
  { label: 'BG FLOW', kind: 'css-animation (background)', expect: 'styles' },
  { label: 'PSEUDO SHEET', kind: 'css-animation (::after, stylesheet)', expect: 'styles' },
  { label: 'PSEUDO WAAPI', kind: 'waapi (::after)', expect: 'styles' },
  { label: 'WAAPI SLIDE', kind: 'waapi', expect: 'moves' },
  { label: 'RAF SPIN', kind: 'script (requestAnimationFrame, rotate)', expect: 'moves' },
  { label: 'JS PULSE', kind: 'script (scale oscillation)', expect: 'moves' },
  { label: 'JS ROCK', kind: 'script (rotation oscillation)', expect: 'moves' },
  { label: 'PARTICLE', kind: 'script (style.left / style.top)', expect: 'moves' },
  { label: 'MARQUEE A', kind: 'script (ticker drift with wrap)', expect: 'moves' },
  { label: 'HUE', kind: 'script (filter)', expect: 'styles' },
  { label: 'COUNT', kind: 'timer (text)', expect: 'text' },
  { label: 'FEED', kind: 'timer (inserted elements)', expect: 'text' },
  { label: 'SMIL', kind: 'svg (SMIL animateTransform)', expect: 'moves' },
  { label: 'SVG ATTR', kind: 'svg (attribute set by script)', expect: 'moves' },
  { label: 'WANDER', kind: 'script (no repeating pattern)', expect: 'moves' },
  { label: 'SLOW LOOP', kind: 'script (a 14 s loop)', expect: 'moves' },
];

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Animation lab</title><style>
body { margin: 0; font: 15px/1.4 Arial, sans-serif; color: #111 }
h1 { margin: 16px 24px }
.grid { display: grid; grid-template-columns: repeat(4, 300px); gap: 16px; padding: 0 24px 40px }
.cell { position: relative; height: 130px; border: 1px solid #ddd; overflow: hidden }
.box { position: absolute; left: 100px; top: 40px; width: 90px; height: 44px; background: #c2410c; color: #fff; display: grid; place-items: center; font-size: 11px }
.spin { animation: spin 2s linear infinite }
@keyframes spin { to { transform: rotate(360deg) } }
.flow { inset: 0; width: auto; height: auto; left: 0; top: 0; background: linear-gradient(90deg, #fde68a, #f97316, #fde68a); background-size: 200% 100%; animation: flow 3s linear infinite; color: #111 }
@keyframes flow { from { background-position: 0% 0 } to { background-position: 200% 0 } }
.dot::after { content: ""; position: absolute; right: -16px; top: 12px; width: 12px; height: 12px; border-radius: 50%; background: #111; animation: blink 1s ease-in-out infinite alternate }
@keyframes blink { from { opacity: 1; transform: scale(1) } to { opacity: .2; transform: scale(.4) } }
.wdot::after { content: ""; position: absolute; right: -16px; top: 12px; width: 12px; height: 12px; border-radius: 50%; background: #2563eb }
.strip { position: absolute; top: 40px; left: 0; display: flex; white-space: nowrap }
.strip span { width: 120px; flex: none; padding: 8px 0; background: #0f172a; color: #fff; text-align: center; border-right: 1px solid #fff }
.feed { position: absolute; inset: 8px; margin: 0; padding: 0 0 0 18px; font-size: 12px }
canvas { display: block; margin: 0 auto }
</style></head><body>
<h1>Animation lab</h1>
<div class="grid">
  <div class="cell"><div class="box spin">CSS SPIN</div></div>
  <div class="cell"><div class="box flow">BG FLOW</div></div>
  <div class="cell"><div class="box dot">PSEUDO SHEET</div></div>
  <div class="cell"><div class="box wdot" id="wdot">PSEUDO WAAPI</div></div>
  <div class="cell"><div class="box" id="slide">WAAPI SLIDE</div></div>
  <div class="cell"><div class="box" id="raf">RAF SPIN</div></div>
  <div class="cell"><div class="box" id="pulse">JS PULSE</div></div>
  <div class="cell"><div class="box" id="rock">JS ROCK</div></div>
  <div class="cell"><div class="box" id="particle" style="width:70px">PARTICLE</div></div>
  <div class="cell"><div class="strip" id="strip"><span>MARQUEE A</span><span>MARQUEE B</span><span>MARQUEE C</span><span>MARQUEE A</span><span>MARQUEE B</span><span>MARQUEE C</span></div></div>
  <div class="cell"><div class="box" id="hue" style="background:#16a34a">HUE</div></div>
  <div class="cell"><div class="box" style="background:#334155">COUNT <b id="count">0</b></div></div>
  <div class="cell"><ul class="feed" id="feed"><li>FEED item 1</li><li>FEED item 2</li><li>FEED item 3</li></ul></div>
  <div class="cell"><svg width="300" height="130" viewBox="0 0 300 130"><g><animateTransform attributeName="transform" type="rotate" from="0 150 65" to="360 150 65" dur="3s" repeatCount="indefinite"/><rect x="110" y="45" width="80" height="40" fill="#7c3aed"/><text x="128" y="70" fill="#fff" font-size="12">SMIL</text></g></svg></div>
  <div class="cell"><svg width="300" height="130" viewBox="0 0 300 130"><text id="svgtext" x="40" y="70" font-size="14">SVG ATTR</text></svg></div>
  <div class="cell"><canvas id="cv" width="280" height="120"></canvas></div>
  <div class="cell"><div class="box" id="wander">WANDER</div></div>
  <div class="cell"><div class="box" id="slow">SLOW LOOP</div></div>
  <div class="cell"><div class="box" id="par" style="background:#0e7490">PARALLAX</div></div>
</div>
<section style="height:1800px;background:linear-gradient(#fff,#e2e8f0)"><p style="padding:24px">More of the page, to scroll through.</p></section>
<script>
document.getElementById('slide').animate([{ transform: 'translateX(-60px)' }, { transform: 'translateX(60px)' }], { duration: 1200, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
document.getElementById('wdot').animate([{ opacity: 1 }, { opacity: 0.1 }], { duration: 700, iterations: Infinity, direction: 'alternate', pseudoElement: '::after' });
var raf = document.getElementById('raf'), pulse = document.getElementById('pulse'), rock = document.getElementById('rock');
var particle = document.getElementById('particle'), strip = document.getElementById('strip'), hue = document.getElementById('hue');
var svgtext = document.getElementById('svgtext'), cv = document.getElementById('cv'), cx = cv.getContext('2d');
var t0 = performance.now(), deg = 0, x = 0;
(function frame(now) {
  var t = (now - t0) / 1000;
  deg = (deg + 2) % 360; raf.style.transform = 'rotate(' + deg + 'deg)';
  pulse.style.transform = 'scale(' + (1 + 0.35 * Math.sin(t * Math.PI)) + ')';
  rock.style.transform = 'rotate(' + (25 * Math.sin(t * Math.PI * 1.25)) + 'deg)';
  particle.style.left = (110 + 80 * Math.sin(t * Math.PI * 0.8)) + 'px';
  particle.style.top = (40 + 25 * Math.cos(t * Math.PI * 0.8)) + 'px';
  x = (x + 1.2) % 360; strip.style.transform = 'translateX(' + (-x) + 'px)';
  hue.style.filter = 'hue-rotate(' + Math.round((t * 120) % 360) + 'deg)';
  svgtext.setAttribute('x', String(40 + 90 + 90 * Math.sin(t * Math.PI * 0.9)));
  cx.fillStyle = '#e2e8f0'; cx.fillRect(0, 0, 280, 120); cx.fillStyle = '#0ea5e9'; cx.fillRect(20 + 200 * (0.5 + 0.5 * Math.sin(t * 2)), 40, 40, 40);
  requestAnimationFrame(frame);
})(t0);
var wander = document.getElementById('wander'), slow = document.getElementById('slow'), par = document.getElementById('par');
(function frame2(now) {
  var t = (now - t0) / 1000;
  // Two waves out of step (no common period within the watch): motion with no repeating pattern.
  wander.style.transform = 'translate(' + (50 * Math.sin(t * 1.3) + 25 * Math.sin(t * 3.71 + 1)) + 'px, ' + (18 * Math.sin(t * 2.17)) + 'px)';
  // One back-and-forth every 14 s: longer than a short recording.
  slow.style.transform = 'translateX(' + (90 * Math.sin((t * 2 * Math.PI) / 14)) + 'px)';
  requestAnimationFrame(frame2);
})(t0);
// Tied to the scroll position: a layer that slides as the page scrolls.
var onScroll = function () { par.style.transform = 'translateY(' + Math.round(window.scrollY * 0.25) + 'px)'; };
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();
var n = 0; setInterval(function () { document.getElementById('count').textContent = String(++n); }, 500);
var k = 3; setInterval(function () { var li = document.createElement('li'); li.textContent = 'FEED item ' + (++k); var f = document.getElementById('feed'); f.insertBefore(li, f.firstChild); if (f.children.length > 4) f.removeChild(f.lastElementChild); }, 700);
</script></body></html>`;

let server;
let browser;
const projectIds = [];
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (req.url === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    res.writeHead(404).end();
  });
  await new Promise((r) => { server.listen(PORT, r); });
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

/** Page function: each label's trace over `ms` - its box, the animatable styles around it, its effective opacity, its text. */
export async function watchLabels({ labels, ms = 3000, every = 100 }) {
  const find = (label) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes(label)) return n;
    return null;
  };
  const PROPS = ['transform', 'translate', 'rotate', 'scale', 'opacity', 'filter', 'background-position', 'left', 'top'];
  const read = (label) => {
    const node = find(label);
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    const host = node.parentElement;
    const styles = [];
    let opacity = 1;
    for (let el = host, depth = 0; el && el !== document.body && depth < 4; el = el.parentElement, depth++) {
      const cs = getComputedStyle(el);
      opacity *= Number(cs.opacity);
      styles.push(PROPS.map((p) => cs.getPropertyValue(p)).join('|'));
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content && ps.content !== 'none') styles.push(`${pseudo}:${ps.opacity}|${ps.transform}`);
      }
    }
    const box = host.closest('.cell, li, div, svg') ?? host;
    // The text a visitor sees (innerText): textContent would also read the states a copy keeps hidden in the page.
    // (An SVG element has no innerText: its textContent then, which is all it draws.)
    const holder = box.closest('.cell') ?? box;
    return { x: r.left, y: r.top, w: r.width, h: r.height, opacity, styles: styles.join('#'), text: String(holder.innerText ?? holder.textContent).replace(/\s+/g, ' ').trim().slice(0, 120) };
  };
  const out = Object.fromEntries(labels.map((l) => [l, []]));
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    for (const l of labels) out[l].push(read(l));
    await new Promise((r) => setTimeout(r, every));
  }
  return out;
}

/** What a trace says: does it move, how far, does its styling or text keep changing. */
export function summarizeTrace(samples) {
  const s = samples.filter(Boolean);
  if (s.length < 3) return { found: false };
  const range = (k) => Math.max(...s.map((p) => p[k])) - Math.min(...s.map((p) => p[k]));
  const distinct = (k) => new Set(s.map((p) => p[k])).size;
  const geometry = range('x') + range('y') + range('w') + range('h');
  return {
    found: true,
    moves: geometry > 3,
    geometry: Math.round(geometry),
    opacityRange: Math.round(range('opacity') * 100) / 100,
    styleStates: distinct('styles'),
    textStates: distinct('text'),
  };
}

/** Does the copy do what the original does, by the kind of evidence the item is judged on? */
export function matches(item, o, c) {
  if (!c.found) return 'not found in the copy';
  if (item.expect === 'moves') {
    if (!c.moves && !(o.opacityRange > 0.1 && c.opacityRange > 0.05)) return 'stands still in the copy';
    if (o.geometry > 10 && (c.geometry < o.geometry * 0.4 || c.geometry > o.geometry * 2.5)) return `moves ${c.geometry} px in the copy vs ${o.geometry} px on the original`;
  }
  if (item.expect === 'styles' && c.styleStates < 3 && c.opacityRange < 0.05 && !c.moves) return 'its look does not change in the copy';
  if (item.expect === 'text' && c.textStates < 3) return 'its content does not change in the copy';
  return null;
}

/** Where an item was lost: was it captured, was it rebuilt, and why not. */
function diagnose(item, motion, report) {
  const has = (entry) => JSON.stringify(entry ?? '').toUpperCase().includes(item.label.split(' ')[0]);
  const loop = (motion.loops?.loops ?? []).find(has);
  const feed = (motion.feeds?.areas ?? []).length;
  if (!loop && item.expect !== 'text') return `capture: no loop recorded for it (${item.kind})`;
  if (item.expect === 'text' && !feed) return 'capture: no part that changes by itself was recorded';
  const skipped = report.generate?.motion?.loops?.skipped ?? [];
  return loop ? `captured as ${loop.source}/${loop.pattern}; IR skipped: ${JSON.stringify(skipped.filter((x) => x.pattern === loop.pattern))}` : 'captured';
}

const stub = async () => {};
for (const mode of ['normal', 'exact']) {
  test(`${mode} copy: every continuous animation keeps running like the original, measured over 3 s at 1280 px`, async () => {
    const id = randomUUID();
    projectIds.push(id);
    const now = new Date().toISOString();
    const project = seedProject(db, { id, name: 'anim', url: `${origin}/`, stack: 'html', authorized: 1, recreatePages: -1, analysis: true });
    const recreateId = randomUUID();
    const report = await runRecreate({
      project, recreateId, progress: () => {}, ...(mode === 'exact' && { exact: true }),
      stages: { ...STAGES, sweep: stub, exactCapture: stub, exact: stub, responsive: stub, stack: stub },
    });
    const dir = recreateDir(id, recreateId);
    const motion = JSON.parse(await readFile(path.join(dir, 'capture', 'index', 'motion.json'), 'utf8'));
    const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
    const labels = ITEMS.map((i) => i.label);
    const watch = async (url) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForTimeout(800);
      const traces = await page.evaluate(watchLabels, { labels });
      // The canvas over time: does it keep changing (a recording of what it drew), or stand still?
      const shot = async () => sharp(await page.locator('canvas').first().screenshot()).resize({ width: 96 }).removeAlpha().raw().toBuffer();
      const c1 = await shot().catch(() => null);
      await page.waitForTimeout(700);
      const c2 = await shot().catch(() => null);
      const canvasMoves = Boolean(c1 && c2 && c1.length === c2.length && c1.some((v, i) => Math.abs(v - c2[i]) > 24));
      // The scroll-linked layer at three scroll positions, in page coordinates.
      const parallax = [];
      for (const share of [0, 0.5, 1]) {
        await page.evaluate((s) => window.scrollTo(0, Math.round((document.documentElement.scrollHeight - innerHeight) * s)), share);
        await page.waitForTimeout(350);
        parallax.push(await page.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes('PARALLAX')) return Math.round(n.parentElement.getBoundingClientRect().top + scrollY);
          return null;
        }));
      }
      await context.close();
      return { traces: Object.fromEntries(Object.entries(traces).map(([k, v]) => [k, summarizeTrace(v)])), canvasMoves, parallax };
    };
    let original;
    let copy;
    try {
      original = await watch(`${origin}/`);
      copy = await watch(`${served.origin}/`);
    } finally {
      await served.close();
    }
    const failures = [];
    for (const item of ITEMS) {
      const o = original.traces[item.label];
      assert.ok(o.found && (o.moves || o.styleStates >= 3 || o.textStates >= 3 || o.opacityRange > 0.1), `the fixture's ${item.label} must animate on the original: ${JSON.stringify(o)}`);
      const why = matches(item, o, copy.traces[item.label]);
      if (why) failures.push(`${item.label} (${item.kind}): ${why} — ${diagnose(item, motion, report)} | original ${JSON.stringify(o)} copy ${JSON.stringify(copy.traces[item.label])}`);
    }
    // Scroll-linked: at the same scroll positions the layer is where the original's was (within 25 % of its travel).
    const travel = Math.abs(original.parallax[2] - original.parallax[0]);
    assert.ok(travel > 100, `the fixture's parallax layer must move with the scroll: ${JSON.stringify(original.parallax)}`);
    const off = copy.parallax.map((p, i) => Math.abs((p ?? -9999) - original.parallax[i]));
    if (off.some((d) => d > travel * 0.25)) {
      failures.push(`PARALLAX (scroll-linked): copy ${JSON.stringify(copy.parallax)} vs original ${JSON.stringify(original.parallax)} — capture: ${JSON.stringify(motion.scrollLinked?.elements?.map((e) => e.path) ?? null)}; IR: ${JSON.stringify(report.generate?.motion?.scrollLinked ?? null)}`);
    }
    // The canvas cannot be rebuilt without its script: reported, and showing a recording of what it drew, not a still box.
    const canvas = report.motion?.unsupported?.canvas ?? [];
    if (!canvas.length || !canvas[0].animated) failures.push(`canvas: not reported as unsupported (${JSON.stringify(report.motion?.unsupported ?? null)})`);
    else if (!canvas[0].recordedLoop) failures.push(`canvas: no recording of what it drew (${JSON.stringify(canvas[0])})`);
    if (original.canvasMoves && !copy.canvasMoves) failures.push('canvas: stands still in the copy while the original keeps drawing');
    assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
  });
}
