// Re-audit 4b.8: motion in the fix checklist (reaudit/motion.js). The recreated pages are measured with the same probes the
// capture ran on the original and compared by kind: scroll reveals by count, hover by tag + text, loops by pattern.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureNewMotion, motionItems, summarize } from '../src/reaudit/motion.js';
import { compareAudits } from '../src/reaudit/compare/index.js';
import { startSiteServer } from '../src/recreate/verify/server.js';

const GAP = '<div style="height: 1300px">top</div>';
const CARDS = ['Alpha', 'Beta', 'Gamma'];

// The "original": a hover colour on the nav link, three cards revealed by an IntersectionObserver, a CSS spinner.
const ORIGINAL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Original</title><style>
body { margin: 0; font: 16px sans-serif; }
a.nav { color: #111111; transition: color 0.2s; } a.nav:hover { color: #e11d48; }
.card { height: 80px; margin: 10px; background: #ddd; opacity: 0; transform: translateY(24px); transition: opacity 0.5s ease-out, transform 0.5s ease-out; }
.card.in { opacity: 1; transform: none; }
.spin { width: 30px; height: 30px; background: #0f766e; animation: spin 2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style></head><body><nav><a class="nav" href="#a">Services</a></nav><div class="spin"></div>${GAP}
${CARDS.map((c) => `<div class="card">${c}</div>`).join('')}${GAP}
<script>new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add('in'); }), { threshold: 0.2 }).observe(document.querySelector('.card'));
document.querySelectorAll('.card').forEach((c) => new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && c.classList.add('in'))).observe(c));</script></body></html>`;

// The "recreate": other class names and another mechanism (tokens + keyframes), same behaviour.
const RECREATED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Recreated</title><style>
body { margin: 0; font: 16px sans-serif; }
.main-nav-link { color: #111111; transition: color 0.2s; } .main-nav-link:hover { color: #e11d48; }
.js-motion .tile:not(.is-in) { opacity: 0; translate: 0 24px; }
.js-motion .tile.is-in { animation: m-r1 500ms ease-out backwards; }
@keyframes m-r1 { from { opacity: 0; translate: 0 24px; } }
.tile { height: 80px; margin: 10px; background: #ddd; }
.badge { width: 30px; height: 30px; background: #0f766e; animation: turn 2s linear infinite; }
@keyframes turn { to { transform: rotate(360deg); } }
</style></head><body><nav><a class="main-nav-link" href="#a">Services</a></nav><div class="badge"></div>${GAP}
${CARDS.map((c) => `<div class="tile">${c}</div>`).join('')}${GAP}
<script>document.documentElement.classList.add('js-motion');
document.querySelectorAll('.tile').forEach((t) => new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && t.classList.add('is-in'))).observe(t));</script></body></html>`;

// A recreate that lost every effect.
const STATIC = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Static</title><style>
body { margin: 0; font: 16px sans-serif; } .tile { height: 80px; margin: 10px; background: #ddd; }
</style></head><body><nav><a href="#a">Services</a></nav>${GAP}${CARDS.map((c) => `<div class="tile">${c}</div>`).join('')}${GAP}</body></html>`;

let dirs;
let servers;
before(async () => {
  dirs = [];
  servers = [];
  for (const html of [ORIGINAL, RECREATED, STATIC]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-reaudit-motion-'));
    await writeFile(path.join(dir, 'index.html'), html);
    dirs.push(dir);
    servers.push(await startSiteServer(dir));
  }
});
after(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const measure = async (i) => (await measureNewMotion({ origin: servers[i].origin, pages: [{ slug: 'index', urlPath: '' }] })).pages;

test('summarize counts scroll reveals, hover elements by tag + text, and loops by pattern', () => {
  const s = summarize({
    reveal: { elements: [{ trigger: { kind: 'scroll' }, timing: { duration: 700 }, replay: true }, { trigger: { kind: 'timed' }, timing: { duration: 700 } }] },
    hover: [{ tag: 'a', text: 'Home', changes: { color: ['a', 'b'] } }],
    loops: { loops: [{ pattern: 'spin', timing: { duration: 2000 } }, { pattern: 'dash', timeline: 'ScrollTimeline', timing: {} }] },
  });
  assert.deepEqual([s.reveal.count, s.reveal.replay], [1, 1]);
  assert.deepEqual(s.hover.keys, ['a|Home']);
  assert.deepEqual(s.loops.keys, ['spin']);
});

test('motionItems: reproduced = pass, partly = open, mostly lost = regressed; nothing in the original = no row', () => {
  const old = new Map([['index', {
    reveal: { elements: Array.from({ length: 10 }, () => ({ trigger: { kind: 'scroll' }, timing: { duration: 700 } })) },
    hover: [{ tag: 'a', text: 'A', changes: { color: [1, 2] } }, { tag: 'a', text: 'B', changes: { color: [1, 2] } }],
    loops: { loops: [{ pattern: 'spin', timing: { duration: 2000 } }] },
  }]]);
  const next = new Map([['index', {
    reveal: { elements: Array.from({ length: 7 }, () => ({ trigger: { kind: 'scroll' }, timing: { duration: 650 } })) },
    hover: [{ tag: 'a', text: 'A', changes: { color: [1, 2] } }],
    loops: { loops: [{ pattern: 'spin', timing: { duration: 2000 } }] },
  }]]);
  const { items, summary } = motionItems(old, next);
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.equal(by['motion.reveal'].preset, 'open'); // 7 of 10
  assert.match(by['motion.reveal'].after.detail, /Typical duration 650 ms \(original 700 ms\)/);
  assert.equal(by['motion.hover'].preset, 'open'); // 1 of 2
  assert.equal(by['motion.loops'].preset, 'pass');
  assert.deepEqual(summary.reveal, { before: 10, after: 7 });
  assert.equal(motionItems(new Map([['index', { reveal: { elements: [] }, hover: [], loops: { loops: [] } }]]), next).items.length, 0);
  assert.equal(motionItems(old, new Map()).items.length, 0, 'pages measured on only one side are not compared');
});

test('the recreated pages are measured like the original: same effects found with other markup', async () => {
  const [original, recreated] = [await measure(0), await measure(1)];
  const a = summarize(original.get('index'));
  const b = summarize(recreated.get('index'));
  assert.equal(a.reveal.count, 3, JSON.stringify(a.reveal));
  assert.equal(b.reveal.count, 3, JSON.stringify(b.reveal));
  assert.deepEqual(a.hover.keys, ['a|Services']);
  assert.deepEqual(b.hover.keys, ['a|Services']);
  assert.deepEqual(a.loops.keys, b.loops.keys);
  assert.equal(a.loops.count, 1);

  const { items } = motionItems(original, recreated);
  assert.deepEqual(items.map((i) => [i.key, i.preset]), [['motion.reveal', 'pass'], ['motion.hover', 'pass'], ['motion.loops', 'pass']]);
});

test('a recreate that lost its effects is reported as regressed', async () => {
  const { items } = motionItems(await measure(0), await measure(2));
  assert.deepEqual(items.map((i) => [i.key, i.preset]), [['motion.reveal', 'regressed'], ['motion.hover', 'regressed'], ['motion.loops', 'regressed']]);
  assert.match(items[0].after.detail, /^0 found/);
});

test('a page that cannot be measured is listed, never thrown', async () => {
  const result = await measureNewMotion({ origin: 'http://127.0.0.1:9', pages: [{ slug: 'index', urlPath: '' }] });
  assert.equal(result.pages.size, 0);
  assert.equal(result.failed.length, 1);
  const none = await measureNewMotion({ origin: servers[0].origin, pages: [] });
  assert.equal(none.pages.size, 0);
});

test('the checklist carries the motion rows in their own category, and the totals', () => {
  const side = { audit: { url: 'https://o.test/', seo: [], aeo: [], crawl: {}, accessibility: [], brokenLinks: { broken: [] }, techStack: [], manualRebuild: [] }, crawl: null, lighthouse: {} };
  const motion = {
    items: [{ key: 'motion.reveal', category: 'motion', title: 'Scroll-reveal animations kept', preset: 'pass', before: { status: 'pass', detail: 'x' }, after: { status: 'pass', detail: 'y' } }],
    summary: { pages: 1, reveal: { before: 3, after: 3 } }, failed: [], skipped: [],
  };
  const checklist = compareAudits({ old: side, next: side, report: { pages: [], manual: [] }, newOrigin: 'http://127.0.0.1:1', motion });
  assert.ok(checklist.categories.some((c) => c.id === 'motion' && c.label === 'Motion'));
  const row = checklist.items.find((i) => i.key === 'motion.reveal');
  assert.equal(row.status, 'pass');
  assert.equal(row.category, 'motion');
  assert.deepEqual(checklist.motion, { pages: 1, reveal: { before: 3, after: 3 }, failed: [], skipped: [] });
  assert.equal(compareAudits({ old: side, next: side, report: { pages: [], manual: [] }, newOrigin: 'http://127.0.0.1:1' }).motion, null);
});
