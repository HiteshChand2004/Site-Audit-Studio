// Re-audit 4b.8: motion in the fix checklist (reaudit/motion.js). The recreated pages are measured with the same probes the
// capture ran on the original and compared by kind: scroll reveals by count, hover by tag + text, loops by pattern.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureNewMotion, motionItems, summarize } from '../src/reaudit/motion.js';
import { compareAudits } from '../src/reaudit/compare/index.js';
import { measureMotion } from '../src/recreate/capture/measure.js';
import { launchBrowser } from '../src/audit/render.js';
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
  assert.deepEqual(s.hover.keys, ['a|home']); // tag + lower-case text without white space (hoverKey)
  assert.deepEqual(s.loops.keys, ['spin']);
});

test('every channel of a hover is compared, each kept apart from the others', () => {
  // A hover that dims the cards beside it is an extra channel of the same entry, so the element count does not
  // change - only what the copy has to reproduce. Without naming the channels, a copy that changed opacity on the
  // hovered element instead of on its neighbours would have counted as a match.
  const s = summarize({
    reveal: { elements: [] },
    loops: { loops: [] },
    hover: [{
      tag: 'a',
      text: 'Card',
      changes: { color: ['a', 'b'] },
      kids: [{ path: 'body>a:1>span:1', changes: { opacity: ['0', '1'] } }],
      sibs: [{ path: 'body>a:2', rel: 'next', changes: { opacity: ['1', '0.4'] } }],
      pseudo: { after: { width: ['0px', '100%'] } },
    }],
  });
  assert.deepEqual(s.hover.keys, ['a|card'], 'the entry count is unchanged');
  assert.deepEqual(s.hover.props.get('a|card').sort(), ['after:width', 'color', 'kid:opacity', 'next:opacity']);
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
  assert.deepEqual(a.hover.keys, ['a|services']);
  assert.deepEqual(b.hover.keys, ['a|services']);
  assert.deepEqual(a.loops.keys, b.loops.keys);
  assert.equal(a.loops.count, 1);

  const { items } = motionItems(original, recreated);
  assert.deepEqual(items.map((i) => [i.key, i.preset]), [['motion.reveal', 'pass'], ['motion.hover', 'pass'], ['motion.hover-match', 'pass'], ['motion.loops', 'pass']]);
});

test('a recreate that lost its effects is reported as regressed', async () => {
  const { items } = motionItems(await measure(0), await measure(2));
  assert.deepEqual(items.map((i) => [i.key, i.preset]), [['motion.reveal', 'regressed'], ['motion.hover', 'regressed'], ['motion.loops', 'regressed']]);
  assert.match(items[0].after.detail, /^0 found/);
});

test('the re-audit probes hover without the Tab walk (the comparison never reads focus); the capture keeps it', async () => {
  const browser = await launchBrowser();
  try {
    const run = async (i, focus) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${servers[i].origin}/`, { waitUntil: 'load' });
      const m = await measureMotion(page, { budgetMs: 10000, focus });
      await page.close();
      return m;
    };
    // The plain link of the static page is a Tab stop the walk probes (a link with a :hover rule is not a probe candidate).
    assert.ok((await run(2, true)).stats.focused > 0);
    assert.equal((await run(2, false)).stats.focused, 0);
    // What the checklist compares is the same with or without it.
    const [a, b] = [summarize(await run(1, true)), summarize(await run(1, false))];
    assert.deepEqual(b.hover.keys, a.hover.keys);
    assert.deepEqual(b.loops.keys, a.loops.keys);
    assert.equal(b.reveal.count, a.reveal.count);
  } finally {
    await browser.close();
  }
  // measureNewMotion (the re-audit) runs without it.
  const t0 = Date.now();
  const measured = (await measure(2)).get('index');
  console.log(`# re-audit motion of the static page: ${Date.now() - t0} ms`);
  assert.equal(measured.stats.focused, 0);
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

test('hover end states and timing: same values within rounding, a different end or a slower effect is named', async () => {
  const { sameValue, hoverDifferences, hoverDuration, motionItems } = await import('../src/reaudit/motion.js');
  assert.ok(sameValue('rgb(10, 20, 30)', 'rgb(11, 20, 30)'));
  assert.ok(sameValue('matrix(1, 0, 0, 1, 0, -8)', 'matrix(1, 0, 0, 1, 0, -8.4)'));
  assert.ok(!sameValue('rgb(10, 20, 30)', 'rgb(40, 20, 30)'));
  assert.ok(!sameValue('none', 'matrix(1, 0, 0, 1, 0, -8)'));
  assert.equal(hoverDuration({ transition: { duration: '0.2s, 300ms' } }), 300);
  assert.equal(hoverDuration({ scriptedMs: 450, transition: { duration: '0s' } }), 450);
  const was = { changes: { color: ['rgb(0, 0, 0)', 'rgb(200, 0, 0)'], transform: ['none', 'matrix(1, 0, 0, 1, 0, -8)'] }, pseudo: { after: { width: ['0px', '40px'] } }, transition: { duration: '0.3s' } };
  assert.deepEqual(hoverDifferences(was, { ...was }), []);
  const diff = hoverDifferences(was, { changes: { color: ['rgb(0, 0, 0)', 'rgb(0, 0, 200)'] }, pseudo: { after: { width: ['0px', '40px'] } }, transition: { duration: '0s' } });
  assert.deepEqual(diff, ['color ends at rgb(0, 0, 200) (original rgb(200, 0, 0))', 'transform does not change', 'takes 0 ms (original 300 ms)']);

  const page = (hover) => new Map([['home', { hover }]]);
  const a = { tag: 'a', text: 'Contact', ...was };
  const b = { tag: 'button', text: 'Go', changes: { opacity: ['1', '0.8'] }, transition: { duration: '0.2s' } };
  const { items, summary } = motionItems(page([a, b]), page([{ ...a }, { ...b, changes: { opacity: ['1', '0.5'] } }]));
  const row = items.find((i) => i.key === 'motion.hover-match');
  assert.equal(row.after.count, 1);
  assert.match(row.after.detail, /1 of them end in the same values, at the same speed\. Differs: button "Go": opacity ends at 0\.5 \(original 0\.8\)/);
  assert.deepEqual([summary.hover.matched, summary.hover.sameEnd], [2, 1]);
});

test('parts that change by themselves: each original one needs a copy one at about the same pace', async () => {
  const { motionItems } = await import('../src/reaudit/motion.js');
  const old = new Map([['home', { feeds: { areas: [{ path: 'body>ul:1', ms: 600 }, { path: 'body>p:1', ms: 700 }, { path: 'body>ul:2', ms: 3000 }] } }]]);
  const now = new Map([['home', { feeds: [{ path: 'body>ul:1', ms: 620 }, { path: 'body>span:1', ms: 690 }, { path: 'body>ul:9', ms: 1200 }] }]]);
  const row = motionItems(old, now).items.find((i) => i.key === 'motion.feeds');
  assert.equal(row.before.count, 3);
  assert.equal(row.after.count, 2, 'the 3 s one has no counterpart: 1.2 s is not its pace');
  assert.equal(row.preset, 'open');
  assert.match(row.after.detail, /every 620 ms \(original 600 ms\), 690 ms \(original 700 ms\)/);
  assert.equal(motionItems(new Map([['home', {}]]), new Map([['home', {}]])).items.find((i) => i.key === 'motion.feeds'), undefined, 'no row when the original has none');
});
