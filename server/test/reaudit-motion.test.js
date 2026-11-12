// Re-audit 4b.8: motion in the fix checklist (reaudit/motion.js). The recreated pages are measured with the same probes the
// capture ran on the original and compared by kind: scroll reveals by count, hover by tag + text, loops by pattern.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backendFailures, compareClicks, hoverBudgetFor, hoverFirstFor, jumpTargetsOf, liftedTargets, markJumps, measureNewMotion, missedHovers, motionItems, motionTimeFor, movesByItself, PAGE_BUDGET_MS, pairHovers, readOldMotion, selfMovingFromSnapshot, summarize, useLiftedBefore, withoutChildHovers } from '../src/reaudit/motion.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { FIRST_MS } from '../src/recreate/capture/interactions.js';
import { loopsTimeFor, LOOPS_MAX_MS, scrollStepsFor } from '../src/recreate/capture/loops.js';
import { compareAudits } from '../src/reaudit/compare/index.js';
import { measureLifted, readNewMotion, saveNewMotion } from '../src/reaudit/index.js';
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

test('hover pairing: by name, then the same element at the same path with the same changes under another label', () => {
  const fade = { opacity: ['1', '0.88'] };
  const was = [
    { tag: 'a', text: 'Features', path: 'body>header:1>nav:1>a:1', changes: { color: [1, 2] } },
    { tag: 'a', text: 'Create your free account', path: 'body>main:1>section:5>a:1', source: 'css', changes: fade },
    { tag: 'a', text: 'Sign in', path: 'body>header:1>span:2>a:1', source: 'css', changes: { color: [1, 2], 'background-color': [3, 4] } },
    { tag: 'a', text: 'Pricing', path: 'body>main:1>a:9', changes: fade },
  ];
  const now = [
    { tag: 'a', text: 'Features', path: 'body>header:1>nav:1>a:1', changes: { color: [1, 2] } },
    { tag: 'a', text: 'Start practice meeting', path: 'body>main:1>section:5>a:1', source: 'css', changes: fade },
    // The same path with other changes is another element's hover: never paired.
    { tag: 'a', text: 'Get started', path: 'body>header:1>span:2>a:1', changes: fade },
  ];
  const { pairs, missing } = pairHovers(was, now);
  assert.deepEqual(pairs.map(([a, b, how]) => [a.text, b.text, how]), [['Features', 'Features', 'name'], ['Create your free account', 'Start practice meeting', 'path']]);
  assert.deepEqual(missing.map((h) => h.text), ['Sign in', 'Pricing']);
  assert.deepEqual([...missedHovers(new Map([['index', { hover: was }]]), new Map([['index', { hover: now }], ['gone', { hover: [] }]])).keys()], ['index']);
  // The lifted original probes only where the copy missed something, those first; elsewhere no hover probing.
  const t = liftedTargets([{ slug: 'index', urlPath: '' }, { slug: 'about', urlPath: 'about/' }], new Map([['index', missing]]));
  assert.ok(t[0].hoverBudgetMs >= 10000);
  assert.deepEqual(t[0].hoverFirst, ['a|signin', 'a|pricing']);
  assert.equal(t[1].hoverBudgetMs, 1);
  assert.deepEqual(liftedTargets([{ slug: 'index', urlPath: '' }])[0].hoverFirst, []);
});

test('hover row: a hover the copy misses is left out only when the lifted original misses it too AND a backend request failed in the copy', () => {
  const signIn = { tag: 'a', text: 'Sign in', path: 'body>header:1>span:2>a:1', source: 'css', changes: { color: [1, 2] } };
  const features = { tag: 'a', text: 'Features', path: 'body>header:1>nav:1>a:1', changes: { color: [1, 2] } };
  const old = new Map([['index', { hover: [features, signIn] }]]);
  const copy = (dataFailed) => new Map([['index', { hover: [features], ...(dataFailed && { dataFailed }) }]]);
  const liftedWithout = new Map([['index', { hover: [features] }]]);
  const liftedWith = new Map([['index', { hover: [features, signIn] }]]);
  const backend = new Set(['/auth/me']);
  const rowOf = (newPages, o) => motionItems(old, newPages, o).items.find((i) => i.key === 'motion.hover');

  const ok = rowOf(copy([{ path: '/auth/me', status: 404 }]), { lifted: liftedWithout, backend });
  assert.equal(ok.preset, 'pass', JSON.stringify(ok));
  assert.equal(ok.before.count, 1);
  assert.equal(ok.after.count, 1);
  assert.match(ok.note, /a "Sign in"\) is on an element the page's own script draws only from its server's answer, and that request failed in the copy \(\/auth\/me 404\)/);
  assert.match(ok.note, /do not draw it either: not counted/);
  assert.deepEqual(ok.serverDrawn, [{ page: 'index', element: 'a "Sign in"', path: signIn.path, failed: [{ path: '/auth/me', status: 404 }] }]);

  // Every proof missing on its own keeps the row as before (1 of 2).
  const red = (r) => {
    assert.equal(r.preset, 'open', JSON.stringify(r));
    assert.equal(r.before.count, 2);
    assert.equal(r.serverDrawn, undefined);
  };
  red(rowOf(copy([{ path: '/auth/me', status: 404 }]), { lifted: liftedWith, backend }), 'the lifted original draws it: lost by the copy');
  red(rowOf(copy(null), { lifted: liftedWithout, backend }), 'no failed request in the copy');
  red(rowOf(copy([{ path: '/img/logo.png', status: 404 }]), { lifted: liftedWithout, backend }), 'a failed request that is not the backend');
  red(rowOf(copy([{ path: '/auth/me', status: 404 }]), { lifted: liftedWithout, backend: null }), 'no backend list');
  red(rowOf(copy([{ path: '/auth/me', status: 404 }]), { lifted: null, backend }), 'no lifted measurement');
  red(rowOf(copy([{ path: '/auth/me', status: 404 }])), 'called as before');
  assert.deepEqual(backendFailures([{ path: '/auth/me/', status: 0 }, { path: '/x.css', status: 404 }], backend), [{ path: '/auth/me/', status: 0 }]);
});

test('the copy\'s measurement records its own failed data requests (fetch / XHR to its server), not missing files or other hosts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-datafail-'));
  try {
    await writeFile(path.join(dir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Data</title></head><body>
<a href="/login/">Sign in</a><img src="/missing.png" alt="">
<script>fetch('/auth/me').catch(() => {}); var x = new XMLHttpRequest(); x.open('GET', '/api/billing/me'); x.send(); fetch('https://elsewhere.invalid/api').catch(() => {});</script>
</body></html>`);
    const served = await serveCopy(dir);
    try {
      const got = await measureNewMotion({ origin: new URL(served.url).origin, pages: [{ slug: 'index', urlPath: '', hoverBudgetMs: 1 }] });
      const failed = got.pages.get('index')?.dataFailed ?? [];
      assert.deepEqual(failed.map((f) => [f.path, f.status]).sort(), [['/api/billing/me', 404], ['/auth/me', 404]], JSON.stringify(got));
    } finally {
      await served.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pointer row: an element moving by its own animation is not a mouse follower, on either side', () => {
  const HERO = 'body>main:1>section:1>div:2';
  const BLOB = 'body>main:1>section:6>div:1';
  const ownLoop = { path: HERO, pattern: 'float', keyframes: [{ offset: 0, props: { transform: 'translateY(16px)' } }, { offset: 1, props: { transform: 'none' } }] };
  const old = new Map([['index', {
    loops: { loops: [ownLoop, { path: 'body>p:1', pattern: 'blink', keyframes: [{ offset: 0, props: { opacity: '0' } }] }] },
    pointer: { followers: [{ path: HERO, kx: 0, ky: -0.043, tauMs: 0 }, { path: BLOB, kx: 0, ky: 0.027, tauMs: 0 }] },
  }]]);
  // The copy's probe also read its own loop (a child of the looping box) as a follower: not counted against it either.
  const next = new Map([['index', { loops: { loops: [ownLoop] }, pointer: { followers: [{ path: `${HERO}>span:1`, kx: 0, ky: 0.03, tauMs: 0 }, { path: BLOB, kx: 0, ky: 0.026, tauMs: 0 }] } }]]);
  const row = motionItems(old, next).items.find((i) => i.key === 'motion.pointer');
  assert.equal(row.preset, 'pass', JSON.stringify(row));
  assert.equal(row.before.count, 1);
  assert.equal(row.after.count, 1);
  assert.deepEqual(row.ownAnimation, [{ page: 'index', element: HERO }]);
  assert.match(row.note, /1 element the probe saw move with the mouse moves by its own animation, not with the mouse: not counted/);
  assert.deepEqual([...movesByItself(old.get('index'))], [HERO], 'an opacity blink does not move the box');

  // A real follower that is missing is still named, with the axis it moves on.
  const lost = motionItems(old, new Map([['index', { pointer: { followers: [] } }]])).items.find((i) => i.key === 'motion.pointer');
  assert.equal(lost.preset, 'regressed');
  assert.match(lost.differences[0].diff[0], /the original moves 0\.027 × the mouse's vertical move/);

  // Only an animation-driven "follower": the row still says what was left out, and passes.
  const onlyOwn = motionItems(new Map([['index', { loops: { loops: [ownLoop] }, pointer: { followers: [{ path: HERO, kx: 0, ky: -0.043, tauMs: 0 }] } }]]), new Map([['index', { pointer: { followers: [] } }]])).items.find((i) => i.key === 'motion.pointer');
  assert.equal(onlyOwn.preset, 'pass');
  assert.equal(onlyOwn.before.count, 0);
  assert.match(onlyOwn.note, /own animation/);
});

test('pointer row, older captures: an infinite CSS animation that moves the box is read from the saved snapshot', async () => {
  const HERO = 'body>main:1>section:1>div:2';
  const snap = {
    keyframes: [{ name: 'hi-alert', css: '@keyframes hi-alert { 0% { opacity: 0; transform: translateY(16px); } 100% { transform: none; } }' }, { name: 'glow', css: '@keyframes glow { 0% { opacity: .4 } }' }],
    body: { tag: 'body', path: 'body', children: [{ tag: 'main', path: 'body>main:1', children: [{ tag: 'section', path: 'body>main:1>section:1', children: [
      { tag: 'div', path: HERO, style: { 'animation-name': 'hi-alert', 'animation-iteration-count': 'infinite' } },
      { tag: 'div', path: 'body>main:1>section:1>div:3', style: { 'animation-name': 'hi-alert', 'animation-iteration-count': '1' } },
      { tag: 'div', path: 'body>main:1>section:1>div:4', style: { 'animation-name': 'glow', 'animation-iteration-count': 'infinite' } },
    ] }] }] },
  };
  assert.deepEqual(selfMovingFromSnapshot(snap), [HERO], 'only an infinite animation whose keyframes move the box');
  // From the files, as the re-check reads them: no loop record for it, only the snapshot.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-pointer-own-'));
  try {
    await mkdir(path.join(dir, 'capture', 'index'), { recursive: true });
    await writeFile(path.join(dir, 'capture', 'index', 'motion.json'), JSON.stringify({ pointer: { followers: [{ path: HERO, kx: 0, ky: -0.043, tauMs: 0 }] } }));
    await writeFile(path.join(dir, 'capture', 'index', 'desktop.json'), JSON.stringify(snap));
    const old = await readOldMotion(dir, [{ slug: 'index', path: '/' }]);
    assert.deepEqual(old.get('index').selfMoving, [HERO]);
    const row = motionItems(old, new Map([['index', { pointer: { followers: [] } }]])).items.find((i) => i.key === 'motion.pointer');
    assert.equal(row.preset, 'pass');
    assert.deepEqual(row.ownAnimation, [{ page: 'index', element: HERO }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('interactive parts: paired by kind + text; toggles that only change attributes are not counted', { skip: 'follow-up: compare with main-before-merge' }, () => {
  const w = (kind, text) => ({ kind, text });
  const old = new Map([['index', { clicks: { widgets: [w('disclosure', 'Open menu'), w('tabs', 'Tab 2'), w('carousel', 'Next slide'), w('dialog', 'Book a demo'), w('state', 'Dark mode')] } }]]);
  const all = new Map([['index', { clicks: { widgets: [w('disclosure', 'Open menu'), w('tabs', 'Tab 2'), w('carousel', 'Next slide'), w('dialog', 'Book a demo')] } }]]);
  const half = new Map([['index', { clicks: { widgets: [w('disclosure', 'Open menu'), w('tabs', 'Tab 2')] } }]]);
  const row = (m) => motionItems(old, m).items.find((i) => i.key === 'motion.widgets');
  assert.equal(row(all).preset, 'pass');
  assert.equal(row(all).before.count, 4, 'the attribute-only toggle is left out');
  assert.equal(row(half).preset, 'open');
  assert.equal(row(new Map([['index', { clicks: { widgets: [] } }]])).preset, 'regressed');
  assert.equal(motionItems(new Map([['index', {}]]), all).items.find((i) => i.key === 'motion.widgets'), undefined, 'no parts on the original: no row');
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

test('hover children: several children changing the same properties to different ends are each held against their own', async () => {
  const { hoverDifferences, pairKids } = await import('../src/reaudit/motion.js');
  const kid = (host, rel, end) => ({ path: `${host}>${rel}`, changes: { color: ['rgb(0, 0, 0)', end] } });
  // A card: its title turns blue, its label white (the same property, two ends). The copy's card sits at another path.
  const was = { path: 'body>section:2>a:1', changes: {}, transition: { duration: '0s' }, kids: [kid('body>section:2>a:1', 'div:1', 'rgb(0, 0, 238)'), kid('body>section:2>a:1', 'div:2', 'rgb(255, 255, 255)')] };
  const now = { path: 'body>div:1>section:2>a:1', changes: {}, transition: { duration: '0s' }, kids: [kid('body>div:1>section:2>a:1', 'div:1', 'rgb(0, 0, 238)'), kid('body>div:1>section:2>a:1', 'div:2', 'rgb(255, 255, 255)')] };
  assert.deepEqual(hoverDifferences(was, now), [], 'the same card: no difference (all against the last child said the title ended white)');
  // The same children listed in another order, with paths that do not line up: paired by their end values.
  const shuffled = { ...now, path: 'x', kids: [kid('y', 'b', 'rgb(255, 255, 255)'), kid('y', 'a', 'rgb(0, 0, 238)')] };
  assert.deepEqual(hoverDifferences(was, shuffled), []);
  assert.deepEqual(pairKids(was, shuffled).map(([, n]) => n.changes.color[1]), ['rgb(0, 0, 238)', 'rgb(255, 255, 255)']);
  // A real difference is still named, and a copy child is never used twice.
  const wrong = { ...now, kids: [kid('body>div:1>section:2>a:1', 'div:1', 'rgb(0, 0, 238)'), kid('body>div:1>section:2>a:1', 'div:2', 'rgb(0, 0, 238)')] };
  assert.deepEqual(hoverDifferences(was, wrong), ['child color ends at rgb(0, 0, 238) (original rgb(255, 255, 255))']);
  const fewer = { ...now, kids: [kid('body>div:1>section:2>a:1', 'div:1', 'rgb(0, 0, 238)')] };
  assert.deepEqual(hoverDifferences(was, fewer), ['a child\'s color does not change']);
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

// Clicks compared on what a visitor sees: a second click that closes what it opened (closesOwn) counts even when the page
// is not exactly back where it started; a control the copy's probe never reached is "not checked", never "does nothing".
test('click comparison: the fair close reading wins; unreached controls are not counted against the copy', () => {
  const was = [
    { text: 'Question 1?', tag: 'button', kind: 'disclosure', closes: null, closesOwn: 'toggle' },
    { text: 'Go to slide 3', tag: 'button', kind: 'carousel' },
    { text: 'Go to slide 4', tag: 'button', kind: 'carousel' },
  ];
  const now = [
    { text: 'Question 1?', tag: 'button', kind: 'tabs', closesOwn: 'toggle' },
    { text: 'Go to slide 3', tag: 'button', kind: 'tabs' },
  ];
  const rows = compareClicks(was, now, ['Question 1?', 'Go to slide 3']);
  assert.deepEqual(rows.map((r) => [r.was.text, r.diff.length, Boolean(r.unchecked)]), [['Question 1?', 0, false], ['Go to slide 3', 0, false], ['Go to slide 4', 0, true]]);
  // Reached and missing is still a real difference; an older capture without closesOwn falls back to closes.
  assert.deepEqual(compareClicks(was.slice(2), [], ['Go to slide 4'])[0].diff, ['does nothing in the copy']);
  assert.deepEqual(compareClicks([{ text: 'Menu', closes: 'escape' }], [{ text: 'Menu', closes: null }])[0].diff, ['Escape does not close it again (it does on the original)']);
});

test("the copy's measured motion is saved with the re-check and read back the same; an older re-check has none", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-newmotion-'));
  try {
    assert.equal(await readNewMotion(dir), null);
    const measured = { pages: new Map([['index', { clicks: { widgets: [{ text: 'FAQ', kind: 'disclosure', closesOwn: 'toggle' }], probedNames: ['FAQ'] }, hover: [] }]]), failed: [], skipped: [] };
    await saveNewMotion(dir, measured);
    const back = await readNewMotion(dir);
    assert.deepEqual([...back.keys()], ['index']);
    assert.deepEqual(back.get('index'), measured.pages.get('index'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('click comparison: an in-page link that only scrolled (a scroll-spy moved the "current" mark) counts once per name; missing in the copy is still named', () => {
  // The original's probe recorded the same nav link twice, with different marks moved (it depends on where the page was).
  const spy = (text, kind, from, to) => ({
    text, tag: 'a', kind, reasons: ['anchor'],
    change: { shown: [], hidden: [], added: [], attrs: [{ path: `nav>a:${from}`, from: '|||true||', to: '|||||' }, { path: `nav>a:${to}`, from: '|||||', to: '|||true||', isTrigger: true }], moved: [] },
  });
  const was = [
    spy('How it works', 'carousel', 4, 1), spy('Features', 'carousel', 1, 2),
    spy('How it works', 'state', 5, 1), spy('Features', 'state', 4, 5),
    { text: 'Will it change my code?', tag: 'summary', kind: 'disclosure', closesOwn: 'toggle', change: { shown: [{ path: 'details>p' }], hidden: [], added: [], attrs: [], moved: [] } },
  ];
  const now = [spy('How it works', 'carousel', 3, 1), spy('Features', 'state', 1, 2), { text: 'Will it change my code?', tag: 'summary', kind: 'disclosure', closesOwn: 'toggle' }];
  const rows = compareClicks(was, now, ['How it works', 'Features', 'Will it change my code?']);
  assert.deepEqual(rows.map((r) => [r.was.text, r.diff.length]), [['How it works', 0], ['Features', 0], ['Will it change my code?', 0]], 'each scroll link once, paired whatever mark it moved');
  // A copy without that link at all: still a difference (the link may be broken in the copy).
  assert.deepEqual(compareClicks([spy('Pricing', 'state', 1, 2)], [], ['Pricing'])[0].diff, ['does nothing in the copy']);
  // A link that shows something (a tab panel, a menu) is a control like any other, compared as before.
  const tab = { ...spy('Plans', 'tabs', 1, 2), change: { shown: [{ path: 'section>div' }], hidden: [], added: [], attrs: [], moved: [] }, closesOwn: 'toggle' };
  assert.deepEqual(compareClicks([tab, tab], [{ ...tab, closesOwn: null }], ['Plans'])[0].diff, ['a second click does not close it again (it does on the original)']);
});

test("a page's motion time follows the work: the loop capture's own estimate for that page, the hover and the click budgets", () => {
  // The strip scan scrolls a window (80 % of the view) at a time while there is page below: none on one screen, 12 at most.
  assert.equal(scrollStepsFor(900, 900), 0);
  assert.equal(scrollStepsFor(2000, 900), 2);
  assert.equal(scrollStepsFor(11654, 900), 12, "a 11 654 px page is scanned in 12 windows");
  assert.equal(scrollStepsFor(100000, 900), 12, "never more than the cap");
  const short = loopsTimeFor({ height: 900, view: 900 });
  const long = loopsTimeFor({ height: 11654, view: 900 });
  assert.ok(long > short + 12 * 2000, "a long page gets the time of its 12 windows");
  assert.ok(long >= 40000 && long <= 55000, "about what the loop capture measured on such a page (48 s): " + long);
  assert.ok(loopsTimeFor({ height: 900, view: 900, canvases: 2 }) > short + 2 * 4000, "every animated canvas may be recorded");
  assert.equal(loopsTimeFor({ height: Infinity, view: 900, canvases: 99 }), LOOPS_MAX_MS, "the most is the longest scan with every canvas");
  assert.equal(motionTimeFor({ hoverBudgetMs: 13500, clickBudgetMs: 10500, loopsMs: long }), PAGE_BUDGET_MS + long + 13500 + 10500);
  assert.equal(motionTimeFor({}), PAGE_BUDGET_MS + LOOPS_MAX_MS + 10000, "unknown page: the most the loop capture takes, the base hover budget, no clicks");
  assert.ok(motionTimeFor({ hoverBudgetMs: 13500, clickBudgetMs: 10500, loopsMs: long }) > 104000, "the fixed timer that cut the page off (90 s + 3.5 + 10.5) is exceeded");
});

// The copy's hover budget covers the elements the original saw hovering (probed first on the copy, ~2.5 s each when a script
// drives them), not only "as many probes as the original made": five hovers after five dead links took 12.5 s, not 10.5.
test("the copy's hover budget and the elements it probes first follow the original's mouse-probed hovers", () => {
  const card = (n) => ({ tag: 'a', text: `Card ${n} A longer description that goes past forty characters`, source: 'probe', scriptedMs: 620, changes: { color: ['rgb(0, 0, 0)', 'rgb(0, 0, 238)'] } });
  const old = { stats: { probed: 7, candidates: 40 }, hover: [card(1), card(2), card(3), card(4), card(5), { tag: 'button', text: 'Menu', source: 'css', changes: { color: ['a', 'b'] } }, card(1)] };
  assert.deepEqual(hoverFirstFor(old), [1, 2, 3, 4, 5].map((n) => `a|card${n}alongerdescriptionthatgoespastforty`), 'tag|text keys of the probed hovers, once each, no stylesheet hovers (those need no mouse)');
  assert.equal(hoverBudgetFor(old), 5 * FIRST_MS, 'five first elements at FIRST_MS beat seven probes at 1.5 s');
  assert.equal(hoverBudgetFor({ stats: { probed: 7 }, hover: [] }), Math.max(10000, 7 * 1500), 'no probed hovers: the old rule');
  assert.equal(hoverBudgetFor({ stats: { probed: 100 }, hover: Array.from({ length: 40 }, (_, i) => card(i)) }), 60000, 'never more than a minute');
  assert.deepEqual(hoverFirstFor(null), []);
});

// A jump link ("Skip to content" → #main, a logo → #top): the original's probe recorded what the scroll brought into view
// (reveals shown, a floating card moved), not anything the link controls. Left out on both sides while the copy's page still
// holds the target; a target the copy lost is a real "does nothing".
test('click comparison: jump links are left out while the copy holds their #id target; a lost target does nothing', () => {
  const scrolledInto = { shown: [{ path: 'body>main:1>section:2>div:1' }], hidden: [], added: [], attrs: [], moved: [] };
  const skip = { text: 'Skip to content', tag: 'a', kind: 'tabs', reasons: ['anchor'], trigger: 'body>a:1', change: scrolledInto };
  const home = { text: 'Home', tag: 'a', kind: 'carousel', reasons: ['anchor'], trigger: 'body>header:1>a:1', change: { shown: [], hidden: [], added: [], attrs: [], moved: [{ path: 'body>main:1>div:1' }] } };
  const menu = { text: 'Menu', tag: 'a', kind: 'disclosure', reasons: ['anchor'], trigger: 'body>header:1>a:2', stay: true, change: { shown: [{ path: 'body>nav:1' }], hidden: [], added: [], attrs: [], moved: [] }, closesOwn: 'toggle' };
  const faq = { text: 'What is it?', tag: 'summary', kind: 'disclosure', trigger: 'body>main:1>details:1>summary:1', closesOwn: 'toggle', change: { shown: [{ path: 'body>main:1>details:1>p:1' }], hidden: [], added: [], attrs: [], moved: [] } };
  // An older capture: no href on the widgets, read from the capture's snapshot of the page.
  const body = { tag: 'body', path: 'body', children: [
    { tag: 'a', path: 'body>a:1', attrs: { href: '#main' } },
    { tag: 'header', path: 'body>header:1', children: [{ tag: 'a', path: 'body>header:1>a:1', attrs: { href: '#top' } }, { tag: 'a', path: 'body>header:1>a:2', attrs: { href: '#nav' } }] },
    { tag: 'nav', path: 'body>nav:1', attrs: { id: 'nav' } },
    { tag: 'main', path: 'body>main:1', attrs: { id: 'main' }, children: [{ tag: 'details', path: 'body>main:1>details:1' }] },
  ] };
  const was = markJumps([{ ...skip }, { ...home }, { ...menu }, { ...faq }], body);
  assert.deepEqual(was.map((w) => [w.text, w.href ?? null, !!w.jump]), [['Skip to content', '#main', true], ['Home', '#top', true], ['Menu', '#nav', false], ['What is it?', null, false]],
    'a #id the page holds (or #top) is a jump; a link the page suppressed to open a panel stays a control');
  assert.deepEqual(jumpTargetsOf({ clicks: { widgets: was } }), ['main', 'top']);
  const now = [{ ...menu }, { ...faq }];
  const rows = compareClicks(was, now, ['Menu', 'What is it?'], { main: true, top: true });
  assert.deepEqual(rows.map((r) => [r.was.text, r.leftOut ?? null, r.diff.length]), [['Skip to content', 'jump', 0], ['Home', 'jump', 0], ['Menu', null, 0], ['What is it?', null, 0]]);
  // The copy lost #main (present in the original): the skip link really does nothing there.
  const lost = compareClicks(was, now, ['Menu', 'What is it?'], { main: false, top: true });
  assert.deepEqual(lost[0].diff, ["does nothing in the copy (its target #main is not on the copy's page)"]);
  // Not checked (a measurement made before the target check): not counted either way.
  assert.equal(compareClicks(was, now, null, null)[0].unchecked, true);
  // In the row: the two jumps are left out and said so; the two real controls pass.
  const items = motionItems(new Map([['index', { clicks: { widgets: was } }]]), new Map([['index', { clicks: { widgets: now, probedNames: ['Menu', 'What is it?'] }, jumpTargets: { main: true, top: true } }]])).items;
  const clicks = items.find((i) => i.key === 'motion.clicks');
  assert.equal(clicks.before.count, 2);
  assert.equal(clicks.after.count, 2);
  assert.equal(clicks.preset, 'pass');
  assert.match(clicks.note, /2 links that only jump to a place on the same page left out/);
  const broken = motionItems(new Map([['index', { clicks: { widgets: was } }]]), new Map([['index', { clicks: { widgets: now, probedNames: ['Menu', 'What is it?'] }, jumpTargets: { main: false, top: true } }]])).items.find((i) => i.key === 'motion.clicks');
  assert.equal(broken.before.count, 3);
  assert.match(broken.differences[0].diff[0], /#main is not on the copy's page/);
});

// The mouse probe hovered a list item that changes nothing of its own; its link (which has its own hover rule) was read part of
// the way through its transition, at another moment on each side. The link's own entry is the one compared.
test("hover comparison: a container whose only change is a child's own rule hover is that child's hover", () => {
  const link = { tag: 'a', text: 'Product', source: 'css', path: 'body>nav:1>li:1>a:1', changes: { color: ['rgb(163, 171, 194)', 'rgb(244, 246, 255)'], 'background-color': ['rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0.05)'] } };
  const item = (color, alpha) => ({ tag: 'li', text: 'Product', source: 'probe', path: 'body>nav:1>li:1', changes: {}, kids: [{ path: 'body>nav:1>li:1>a:1', changes: { color: ['rgb(163, 171, 194)', color], 'background-color': ['rgba(0, 0, 0, 0)', `rgba(255, 255, 255, ${alpha})`] } }] });
  assert.deepEqual(withoutChildHovers([link, item('rgb(238, 240, 250)', 0.046)]).map((h) => h.tag), ['a']);
  // Kept: the container changes something itself, a child has no rule of its own, or the child changes more than its rule.
  const own = { ...item('rgb(238, 240, 250)', 0.046), changes: { 'box-shadow': ['none', '0 0 4px red'] } };
  const noRule = { ...item('rgb(238, 240, 250)', 0.046), kids: [{ path: 'body>nav:1>li:1>span:1', changes: { opacity: ['0', '1'] } }] };
  const more = { ...item('rgb(238, 240, 250)', 0.046), kids: [{ path: 'body>nav:1>li:1>a:1', changes: { transform: ['none', 'translateY(-2px)'] } }] };
  for (const h of [own, noRule, more]) assert.equal(withoutChildHovers([link, h]).length, 2);
  // In hover-match: the original read the link at 92 %, the copy at 18 %: no difference left once both items go.
  const items = motionItems(new Map([['index', { hover: [link, item('rgb(238, 240, 250)', 0.046)] }]]), new Map([['index', { hover: [link, item('rgb(177, 184, 205)', 0.009)] }]])).items;
  const match = items.find((i) => i.key === 'motion.hover-match');
  assert.equal(match?.differences?.length ?? 0, 0, JSON.stringify(match));
  assert.equal(items.find((i) => i.key === 'motion.hover').before.count, 1);
});

// The copy's probe ran out of time after 4 of the original's 6 "Learn more" panels: the other 2 are not checked - neither
// "does nothing" nor a silent pass - and the row says so. A control recorded twice by the original's probe counts once.
test('click comparison: controls the copy never reached are not checked (and said so); one control recorded twice counts once', () => {
  const lm = (n) => ({ text: 'Learn more', tag: 'summary', kind: 'disclosure', trigger: `body>main:1>article:${n}>details:1>summary:1`, closesOwn: 'toggle', detailsFrom: false, change: { shown: [{ path: `body>main:1>article:${n}>details:1>div:1` }], hidden: [], added: [], attrs: [], moved: [] } });
  const was = [1, 2, 3, 4, 5, 6].map(lm);
  const now = [1, 2, 3, 4].map(lm);
  const rows = compareClicks(was, now, ['Learn more', 'Learn more', 'Learn more', 'Learn more'], null, now.map((w) => w.trigger));
  assert.deepEqual(rows.map((r) => [r.was.trigger.match(/article:\d/)[0], r.unchecked ? 'unchecked' : r.diff.length]), [['article:1', 0], ['article:2', 0], ['article:3', 0], ['article:4', 0], ['article:5', 'unchecked'], ['article:6', 'unchecked']]);
  // An older measurement (names only): a name probed 4 times judges 4 of the original's controls, not all 6.
  assert.deepEqual(compareClicks(was, now, Array(4).fill('Learn more')).map((r) => !!r.unchecked), [false, false, false, false, true, true]);
  // A control the copy's probe clicked (its path) with nothing happening: a real "does nothing".
  const dead = compareClicks([lm(1)], [], ['Learn more'], null, [lm(1).trigger]);
  assert.deepEqual(dead[0].diff, ['does nothing in the copy']);
  // The row: the 4 checked pass, the 2 unchecked are counted and named, never dropped.
  const row = motionItems(new Map([['features', { clicks: { widgets: was } }]]), new Map([['features', { clicks: { widgets: now, probedNames: Array(4).fill('Learn more'), probedPaths: now.map((w) => w.trigger) } }]])).items.find((i) => i.key === 'motion.clicks');
  assert.equal(row.before.count, 6);
  assert.match(row.after.detail, /4 of the 4 checked do the same/);
  assert.match(row.after.detail, /2 not checked \(the probe ran out of time\)/);
  assert.match(row.note, /2 not checked \(the probe ran out of time\): not counted either way/);
  assert.equal(row.unchecked, 2);
  assert.equal(row.notChecked.length, 2);
  // Nothing checked at all: the row is there, open, never a pass.
  const none = motionItems(new Map([['features', { clicks: { widgets: was } }]]), new Map([['features', { clicks: { widgets: [], probedNames: [], probedPaths: [] } }]])).items.find((i) => i.key === 'motion.clicks');
  assert.equal(none.preset, 'open');
  assert.match(none.after.detail, /None could be checked/);

  // The original recorded one button twice (a disclosure, then tabs after a reload); the copy once: one control, matched.
  const links = (kind) => ({ text: 'Links', tag: 'button', kind, trigger: 'body>main:1>section:3>div:1>button:2', change: { shown: [{ path: 'body>main:1>section:4' }], hidden: [], added: [], attrs: [], moved: [] } });
  const twice = compareClicks([links('disclosure'), links('tabs')], [links('disclosure')], ['Links'], null, ['body>main:1>section:3>div:1>button:2']);
  assert.equal(twice.length, 1);
  assert.deepEqual(twice[0].diff, []);
});

// A FAQ answer's second click read before the probe recorded how the answer started: the reading depends on whether it was open
// when the probe reached it (identical files read "closes" once and "does not close" the next time). No verdict, but named.
test('click comparison: a <details> second click without its start state is not a verdict; with it, it is compared', () => {
  const faq = (closesOwn, detailsFrom) => ({ text: 'Will it send real messages?', tag: 'summary', kind: 'disclosure', trigger: 'body>main:1>details:2>summary:1', closesOwn, ...(detailsFrom != null && { detailsFrom }), change: { shown: [{ path: 'body>main:1>details:2>p:1' }], hidden: [], added: [], attrs: [], moved: [] } });
  const old = compareClicks([faq('toggle')], [faq(null, true)], ['Will it send real messages?'], null, [faq().trigger]);
  assert.equal(old[0].detailsUnread, true);
  assert.deepEqual(old[0].diff, []);
  const items = motionItems(new Map([['home', { clicks: { widgets: [faq('toggle')] } }]]), new Map([['home', { clicks: { widgets: [faq(null, true)], probedNames: ['Will it send real messages?'], probedPaths: [faq().trigger] } }]])).items;
  assert.match(items.find((i) => i.key === 'motion.clicks').after.detail, /1 FAQ answer open in the copy but its second click not checked/);
  // Both readings know the start state: compared as always.
  assert.deepEqual(compareClicks([faq('toggle', false)], [faq(null, false)], ['Will it send real messages?'])[0].diff, ['a second click does not close it again (it does on the original)']);
  assert.deepEqual(compareClicks([faq('toggle', false)], [faq('toggle', true)], ['Will it send real messages?'])[0].diff, []);
});

// An as-is copy: the original's own files (as-is/lifted) measured with the copy's probe, so the reveal row's two sides come
// from one instrument. The capture's count (another probe, on the live site) is replaced; a page not measured keeps it.
test("an as-is copy's reveals and loops are measured on the lifted original with the copy's own probe", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sas-lifted-'));
  try {
    assert.equal(await measureLifted(folder, [{ slug: 'index', urlPath: '' }], new Map()), null, 'no lifted folder: the capture stays the before');
    await mkdir(path.join(folder, 'as-is', 'lifted'), { recursive: true });
    await writeFile(path.join(folder, 'as-is', 'lifted', 'index.html'), ORIGINAL);
    const capture = { reveal: { elements: Array.from({ length: 10 }, () => ({ trigger: { kind: 'scroll' }, timing: { duration: 720 } })) }, loops: { loops: [] }, hover: [{ tag: 'a', text: 'Services', source: 'css', changes: { color: ['a', 'b'] } }] };
    const oldMotion = new Map([['index', structuredClone(capture)], ['other', structuredClone(capture)]]);
    const before = await measureLifted(folder, [{ slug: 'index', urlPath: '' }], oldMotion);
    assert.equal(before?.source, 'lifted');
    assert.deepEqual(before.pages, ['index']);
    const lifted = oldMotion.get('index');
    assert.equal(lifted.measuredFrom, 'lifted');
    assert.equal(summarize(lifted).reveal.count, CARDS.length, 'the lifted page has three reveals (the capture said 10)');
    assert.deepEqual(summarize(lifted).loops.keys, ['spin']);
    assert.deepEqual(lifted.hover, capture.hover, 'hover stays the capture');
    assert.equal(summarize(oldMotion.get('other')).reveal.count, 10, 'a page not measured keeps the capture');
    // Same instrument on the copy: the row is a pass.
    const copy = await measure(1);
    const reveal = motionItems(oldMotion, copy).items.find((i) => i.key === 'motion.reveal');
    assert.equal(reveal.preset, 'pass', JSON.stringify(reveal));
    // The saved files show fewer than the live capture did: both numbers stay in the row.
    assert.match(reveal.note, /live capture 10, original's saved files 3 reveals/);
    assert.deepEqual(reveal.live, { before: 10, saved: 3 });
    // A lifted page with no reveals at all where the live capture had some: the row still shows up, with both numbers.
    const none = new Map([['index', { ...structuredClone(capture), reveal: { elements: [] }, measuredFrom: 'lifted', live: { reveal: capture.reveal, loops: capture.loops } }]]);
    const shown = motionItems(none, new Map([['index', { reveal: { elements: [] }, loops: [], hover: [] }]])).items.find((i) => i.key === 'motion.reveal');
    assert.match(shown?.note ?? '', /live capture 10, original's saved files 0 reveals/);
    // useLiftedBefore alone: nothing measured, nothing changed.
    const untouched = new Map([['index', structuredClone(capture)]]);
    assert.deepEqual(useLiftedBefore(untouched, new Map()), []);
    assert.equal(summarize(untouched.get('index')).reveal.count, 10);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
