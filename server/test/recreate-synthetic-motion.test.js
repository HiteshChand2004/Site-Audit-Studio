// The synthetic motion fallback: effects a site runs with JavaScript alone, which the copy never carries.
//   1. the probe reaches the elements (capture/interactions.js install: a script's fingerprint is a candidate too),
//   2. it measures how long such an effect takes (no transition declares it anywhere),
//   3. the copy times itself over that measurement (ir/motion.js synthTransition, emit/motionCss.js).
// Nothing here knows a framework: the marks are will-change, an inline motion property, a transform that does
// nothing, and attribute names that speak of animation.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { captureInteractions } from '../src/recreate/capture/interactions.js';
import { applyMotion, synthTransition } from '../src/recreate/ir/motion.js';
import { motionCss } from '../src/recreate/emit/motionCss.js';

// Three cards a script lifts on hover over 300 ms - plain <div>s, no link, no button, no role, no pointer cursor and
// no transition: before this layer the probe never looked at them and the lift was lost with the original's script.
// Beside them: a card the script moves in one step (nothing to time), and a card with no mark at all (must stay
// invisible to the probe, or every page would cost a probe of its every box).
const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px sans-serif }
  .cards { display: flex; gap: 20px; padding: 40px }
  .card { width: 240px; height: 160px; background: #eee; will-change: transform }
  .step { width: 240px; height: 160px; background: #ddd; will-change: transform }
  .plain { width: 240px; height: 160px; background: #ccc }
</style></head><body>
<div class="cards">
  <div class="card">Design</div>
  <div class="card">Build</div>
  <div class="card">Launch</div>
  <div class="step">Step</div>
  <div class="plain">Plain</div>
</div>
<script>
  document.querySelectorAll('.card').forEach(function (el) {
    var run = null;
    el.addEventListener('mouseenter', function () {
      run = el.animate([{ transform: 'translateY(0px)' }, { transform: 'translateY(-16px)' }], { duration: 300, fill: 'forwards' });
    });
    el.addEventListener('mouseleave', function () { if (run) run.cancel(); run = null; });
  });
  var step = document.querySelector('.step');
  step.addEventListener('mouseenter', function () { step.style.transform = 'translateY(-16px)'; });
  step.addEventListener('mouseleave', function () { step.style.transform = ''; });
  var plain = document.querySelector('.plain');
  plain.addEventListener('mouseenter', function () { plain.style.backgroundColor = 'rgb(200, 30, 30)'; });
  plain.addEventListener('mouseleave', function () { plain.style.backgroundColor = ''; });
</script></body></html>`;

let server;
let browser;
let url;
before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  server?.close();
});

test('a script-animated box with no interactive sign of any kind is probed, and its effect is timed', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(url);
  const found = await captureInteractions(page, { budgetMs: 12000, focusStops: 0 });
  await page.close();

  const byText = (t) => found.hover.filter((h) => h.source === 'probe' && h.text === t);
  const cards = ['Design', 'Build', 'Launch'].map((t) => byText(t)[0]);
  for (const [i, card] of cards.entries()) {
    assert.ok(card, `the ${['first', 'second', 'third'][i]} card was not probed (${JSON.stringify(found.stats)})`);
    assert.equal(card.dyn, 'will-change', 'the mark that made the probe look at it is reported');
    assert.deepEqual(card.reasons, ['dynamic', 'item'], 'the mark of a script, and one of a row of blocks');
    assert.ok(card.changes.transform, `no transform delta measured: ${JSON.stringify(card.changes)}`);
    assert.equal(card.scripted, true, 'the page animated it itself, so the copy has to time it');
    assert.ok(card.scriptedMs >= 150 && card.scriptedMs <= 700, `measured ${card.scriptedMs} ms for a 300 ms animation`);
  }
  assert.ok(found.stats.dynamic >= 4, `${found.stats.dynamic} script-animated boxes taken in`);
  assert.equal(found.stats.dynamicFound, 4, 'the three cards and the one-step card');

  // A change the page makes in one step stays a step: the copy must not invent a movement the original never had.
  const step = byText('Step')[0];
  assert.ok(step, 'the one-step card was probed');
  assert.ok(step.changes.transform, 'its transform change was measured');
  assert.equal(step.scripted, undefined, 'nothing to time: it was already there at the first read');

  // A box with no mark at all is found too when it is one of a row of blocks (capture/interactions.js `items`): its
  // script-only hover used to be lost. An unmarked element that is not one of a row still costs no probe
  // (recreate-hover-items.test.js).
  const plain = byText('Plain')[0];
  assert.ok(plain?.reasons.includes('item'), 'found as one of the row');
  assert.deepEqual(plain.changes['background-color'], ['rgb(204, 204, 204)', 'rgb(200, 30, 30)']);
});

// A merged tree as ir/tree.js builds it (the shape recreate-motion-ir.test.js uses).
const node = (cpath, tag, children = [], style = {}) => ({ tag, cpath, attrs: {}, views: { desktop: { style, rect: [0, 0, 240, 160], hidden: false } }, children });
const site = () => {
  const card = node('body>div:1', 'div');
  const own = node('body>div:2', 'div');
  const root = node('body', 'body', [card, own]);
  return { site: { pages: [{ info: { path: '/', url: 'http://x.test/' }, root }], assetResolve: () => null }, card, own };
};
const noTransition = { property: 'none', duration: '0s', delay: '0s', timing: 'ease' };
const scriptedEntry = {
  path: 'body>div:1', tag: 'div', text: 'Design', dyn: 'will-change', source: 'probe', scripted: true, scriptedMs: 320,
  changes: { transform: ['none', 'matrix(1, 0, 0, 1, 0, -16)'], 'box-shadow': ['none', 'rgba(0, 0, 0, 0.2) 0px 10px 20px'], cursor: ['auto', 'pointer'] },
  transition: noTransition, domDelta: 0,
};
// The same effect on an element that carries its own transition: the original animates it, so the copy keeps that.
const ownEntry = {
  path: 'body>div:2', tag: 'div', text: 'Own', source: 'probe',
  changes: { transform: ['none', 'matrix(1, 0, 0, 1, 0, -16)'] },
  transition: { property: 'transform', duration: '0.4s', delay: '0s', timing: 'ease-in-out' }, domDelta: 0,
};

test('synthTransition: only a timed, script-driven effect of an element without a transition of its own', () => {
  assert.equal(
    synthTransition({ transform: 'matrix(1, 0, 0, 1, 0, -16)', 'box-shadow': 'rgba(0, 0, 0, 0.2) 0px 10px 20px' }, scriptedEntry),
    'transform 320ms ease-out, box-shadow 320ms ease-out',
  );
  // Properties that change in one step by nature are not animated.
  assert.equal(synthTransition({ display: 'block', cursor: 'pointer', 'background-image': 'none' }, scriptedEntry), null);
  // The element animates it itself: nothing of the original may be overruled.
  assert.equal(synthTransition({ transform: 'none' }, { ...scriptedEntry, transition: { property: 'transform', duration: '0.4s', delay: '0s', timing: 'ease' } }), null);
  // A transition that runs nowhere (0s, or none at all) is no transition.
  assert.equal(synthTransition({ transform: 'none' }, { ...scriptedEntry, transition: { property: 'transform', duration: '0s', delay: '0s', timing: 'ease' } }), 'transform 320ms ease-out');
  // The rest state decides, not the state the mouse was on when it was read.
  assert.equal(synthTransition({ transform: 'none' }, { ...scriptedEntry, transitionOut: { property: 'transform', duration: '0.3s', delay: '0s', timing: 'ease' } }), null);
  // An effect the stylesheet declares needs nothing: the original's own transition comes with its styles.
  assert.equal(synthTransition({ transform: 'none' }, { ...scriptedEntry, scripted: false }), null);
  assert.equal(synthTransition({ transform: 'none' }, undefined), null);
  // A measurement is used as measured, within bounds; without one the default stands.
  assert.match(synthTransition({ opacity: '1' }, { ...scriptedEntry, scriptedMs: 40 }), /opacity 120ms/);
  assert.match(synthTransition({ opacity: '1' }, { ...scriptedEntry, scriptedMs: 9000 }), /opacity 700ms/);
  assert.match(synthTransition({ opacity: '1' }, { ...scriptedEntry, scriptedMs: undefined }), /opacity 250ms/);
});

test('the IR carries the synthetic transition, the stylesheet writes it at rest and under reduced motion only', () => {
  const { site: s, card } = site();
  const { motion, stats } = applyMotion(s, new Map([['/', { hover: [scriptedEntry, ownEntry], focus: [] }]]));
  assert.equal(stats.hover.elements, 2);
  assert.equal(stats.hover.scripted, 1);
  assert.equal(stats.hover.dynamic, 1);
  assert.equal(stats.hover.synthesized, 1, 'one of the two effects needs the copy to time it');
  const [lift, ownStyle] = motion.hover;
  assert.equal(lift.transition, 'transform 320ms ease-out, box-shadow 320ms ease-out');
  assert.equal(ownStyle.transition, undefined, 'the element with its own transition keeps it');
  assert.ok((card.motionTokens ?? []).includes(lift.token), 'the card carries the effect\'s token');

  const css = motionCss(motion, { tokenOf: new Map(), from: 'css/site.css' });
  // The end state stays a hover rule for pointer devices …
  assert.match(css, /@media \(hover: hover\)/);
  assert.match(css, new RegExp(`\\[data-motion~="${lift.token}"\\]:hover \\{[^}]*transform: matrix\\(1, 0, 0, 1, 0, -16\\)`));
  // … and the time it takes is written on the element at rest, so leaving eases back too.
  const timed = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
  assert.match(timed, new RegExp(`\\[data-motion~="${lift.token}"\\] \\{\\s*transition: transform 320ms ease-out, box-shadow 320ms ease-out;`));
  assert.doesNotMatch(css, /transition: transform 400ms/, 'nothing is written for the element that transitions itself');
});

test('a descendant and a neighbour of a script-animated element get their own timing', () => {
  const card = node('body>div:1', 'div', [node('body>div:1>span:1', 'span')]);
  const sib = node('body>div:2', 'div');
  const root = node('body', 'body', [card, sib]);
  const s = { pages: [{ info: { path: '/', url: 'http://x.test/' }, root }], assetResolve: () => null };
  const entry = {
    ...scriptedEntry,
    kids: [{ path: 'body>div:1>span:1', changes: { opacity: ['0', '1'] }, transition: noTransition }],
    sibs: [{ path: 'body>div:2', rel: 'next', changes: { opacity: ['1', '0.4'] }, transition: noTransition }],
  };
  const { motion } = applyMotion(s, new Map([['/', { hover: [entry], focus: [] }]]));
  const [effect] = motion.hover;
  assert.equal(effect.kids[0].transition, 'opacity 320ms ease-out');
  assert.equal(effect.sibs[0].transition, 'opacity 320ms ease-out');
  const css = motionCss(motion, { tokenOf: new Map(), from: 'css/site.css' });
  const timed = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
  assert.match(timed, new RegExp(`\\[data-motion~="${effect.kids[0].token}"\\] \\{\\s*transition: opacity 320ms ease-out;`));
  assert.match(timed, new RegExp(`\\[data-motion~="${effect.sibs[0].token}"\\] \\{\\s*transition: opacity 320ms ease-out;`));
});
