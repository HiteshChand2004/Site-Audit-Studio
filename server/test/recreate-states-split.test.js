// Sets of states the probe used to get wrong, found on a real site (two FAQ lists side by side, a carousel whose dots
// only slide the track, a feed read at another moment by each view): how far a track is slid tells its slides apart,
// controls in blocks that each act inside their own block are separate sets, and a part that changes by itself takes the
// widest view's markup in every view.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { captureClicks } from '../src/recreate/capture/clicks.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { captureStates, shiftOf, splitIndependent, stateSignature } from '../src/recreate/capture/states.js';
import { selfChangingPaths, settleSelfChanging } from '../src/recreate/ir/asis.js';

test('a slid track is told apart by its translation, in steps of 8 px', () => {
  assert.equal(shiftOf({ transform: 'matrix(1, 0, 0, 1, -640, 0)' }), ' @-80,0');
  assert.equal(shiftOf({ transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1280, 0, 0, 1)' }), ' @-160,0');
  assert.equal(shiftOf({ translate: '-320px' }), ' @-40,0');
  assert.equal(shiftOf({ transform: 'matrix(1, 0, 0, 1, 0.4, 2)' }), '', 'sub-pixel and small shifts are no difference');
  assert.equal(shiftOf(undefined), '');
  const slide = (x) => ({ tag: 'div', children: [{ tag: 'div', style: { transform: `matrix(1, 0, 0, 1, ${x}, 0)` }, children: [{ text: 'A' }, { text: 'B' }] }] });
  assert.notEqual(stateSignature(slide(0)), stateSignature(slide(-600)));
});

test('controls in blocks that each act inside their own block are separate sets; a tab row whose panel is elsewhere stays one', () => {
  const A = 'body>section:1>div:1';
  const btn = (col, i) => `${A}>div:${col}>div:${i}>h3:1>button:1`;
  const faq = {
    controls: [1, 2, 3, 4].map((i) => btn(1, i)).concat([1, 2, 3, 4].map((i) => btn(2, i))),
    changed: new Set([`${A}>div:1>div:3>div:1`]), nav: [], triggers: new Set([btn(1, 3)]),
    byTrigger: new Map([[btn(1, 3), [`${A}>div:1>div:3>div:1`]]]),
  };
  const split = splitIndependent(faq);
  assert.equal(split.length, 2);
  assert.deepEqual(split.map((s) => s.controls.length), [4, 4]);
  // The block nobody probed takes the probed block's change, moved over.
  assert.deepEqual([...split[1].changed], [`${A}>div:2>div:3>div:1`]);
  // Tabs in one block switching a panel in another: the change leaves the control's block.
  const tabs = { ...faq, byTrigger: new Map([[btn(1, 3), [`${A}>div:2>div:1`]]]) };
  assert.equal(splitIndependent(tabs).length, 1);
  // One control per block (a plain accordion, items as the blocks): nothing to split.
  const one = { controls: [`${A}>div:1>button:1`, `${A}>div:2>button:1`], changed: new Set([`${A}>div:1>p:1`]), nav: [], triggers: new Set([`${A}>div:1>button:1`]), byTrigger: new Map([[`${A}>div:1>button:1`, [`${A}>div:1>p:1`]]]) };
  assert.equal(splitIndependent(one).length, 1);
});

test('a part that changes by itself takes the widest view\'s markup in every view; the rest is left alone', () => {
  const row = (t) => ({ t: 'div', cpath: 'body>div:1>div:1', attrs: {}, children: [{ text: t }] });
  const body = (t, h) => ({ t: 'body', cpath: 'body', attrs: {}, children: [{ t: 'div', cpath: 'body>div:1', attrs: {}, children: [row(t)] }, { t: 'h1', cpath: 'body>h1:1', attrs: {}, children: [{ text: h }] }] });
  const bodies = [['desktop', body('Row 7', 'Wide')], ['mobile', body('Row 9', 'Narrow')]];
  const tree = { children: [{ cpath: 'body>div:1', stateAttrs: { 'data-w-set': 's1', 'data-w-feed': '' }, children: [] }, { cpath: 'body>h1:1', stateAttrs: { 'data-w-set': 's2' }, children: [] }] };
  const paths = selfChangingPaths(tree);
  assert.deepEqual(paths, ['body>div:1'], 'a feed is self-changing; a set switched by clicks is not');
  assert.equal(settleSelfChanging(bodies, paths), 1);
  assert.equal(bodies[1][1].children[0].children[0].children[0].text, 'Row 7');
  assert.equal(bodies[1][1].children[1].children[0].text, 'Narrow', 'a heading the site renders per width keeps its own version');
});

const CAROUSEL = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; font: 16px Arial, sans-serif } .box { width: 600px; margin: 40px; overflow: hidden }
.track { display: flex; transition: transform 200ms } .slide { flex: 0 0 600px; height: 120px; padding: 20px; box-sizing: border-box; background: #eee }
.dots { display: flex; gap: 8px; margin-top: 10px } .dot { width: 14px; height: 14px; border: 0; border-radius: 50%; background: #bbb; cursor: pointer }
.dot.on { background: #333 }
</style></head><body><h2>What people say</h2><div class="box"><div class="track">
<div class="slide">Quote one</div><div class="slide">Quote two</div><div class="slide">Quote three</div></div>
<div class="dots"><button class="dot on" aria-label="Go to slide 1"></button><button class="dot" aria-label="Go to slide 2"></button><button class="dot" aria-label="Go to slide 3"></button></div></div>
<script>
  var track = document.querySelector('.track'), dots = document.querySelectorAll('.dot');
  dots.forEach(function (d, i) { d.addEventListener('click', function () {
    track.style.transform = 'translateX(' + (-600 * i) + 'px)';
    dots.forEach(function (x, j) { x.classList.toggle('on', i === j); });
  }); });
</script></body></html>`;

let server;
let base;
let browser;
before(async () => {
  server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(CAROUSEL));
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
});

test('a carousel whose dots only slide the track (every slide stays rendered) is captured as states', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/`);
  const snap = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, snap.body, { budgetMs: 30000 });
  await context.close();
  let set = null;
  (function walk(n) {
    if (!n || !n.tag) return;
    if (n.states) set = n.states;
    (n.children ?? []).forEach(walk);
  })(snap.body);
  assert.equal(states.sets, 1, JSON.stringify({ states, kinds: clicks.widgets.map((w) => w.kind) }));
  assert.equal(set.count, 3);
  assert.equal(set.initial, 0);
});
