// Click widgets (step 2 of the "as is" fixes): a panel a click opens (accordion answer) is captured as its open state
// (capture/clicks.js readRegion / regionDiff), turned into tokens + CSS (ir/motion.js, emit/motionCss.js) and toggled by the
// fixed js/motion.js. Real browser: the original page is a small accordion driven by its own script.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { captureClicks, commonPath, regionDiff } from '../src/recreate/capture/clicks.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { captureStates, planPanels, planSets } from '../src/recreate/capture/states.js';
import { captureNotices } from '../src/recreate/capture/notices.js';
import { motionCss } from '../src/recreate/emit/motionCss.js';
import { MOTION_JS } from '../src/recreate/emit/motionScript.js';
import { applyMotion, openDecls } from '../src/recreate/ir/motion.js';
import { buildPageTree, isElement } from '../src/recreate/ir/tree.js';
import { buildStyles } from '../src/recreate/ir/styles.js';
import { emitCss } from '../src/recreate/emit/css.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capturePage } from '../src/recreate/capture/index.js';

const ORIGINAL = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif }
.item { border-top: 1px solid #ccc; padding: 12px 0 }
.q { background: none; border: 0; cursor: pointer; font: inherit }
.arrow { display: inline-block; transition: transform .2s }
.a { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .2s } .a > div { overflow: hidden }
.item.open .a { grid-template-rows: 1fr } .item.open .arrow { transform: rotate(90deg) }
</style></head><body><main><section class="faq">
${[1, 2, 3, 4, 5].map((i) => `<div class="item"><button class="q" type="button" aria-expanded="false"><span class="arrow">▶</span> Question ${i}?</button><div class="a"><div><p>Answer ${i}.</p></div></div></div>`).join('\n')}
</section></main>
<script>document.querySelectorAll('.q').forEach(function (b) { b.addEventListener('click', function () {
  var it = b.parentElement; var opening = !it.classList.contains('open');
  document.querySelectorAll('.item.open').forEach(function (o) { o.classList.remove('open'); o.querySelector('.q').setAttribute('aria-expanded', 'false'); });
  if (opening) it.classList.add('open'); b.setAttribute('aria-expanded', opening);
}); });</script>
</body></html>`;

/** The tree as HTML, like the emitter does for these tests: attributes, state attributes and motion tokens. */
const serialize = (n) => {
  if (!isElement(n)) return n.text.replace(/</g, '&lt;');
  const all = { ...n.attrs, ...(n.class && { class: n.class }), ...n.stateAttrs, ...(n.motionTokens?.length && { 'data-motion': n.motionTokens.join(' ') }) };
  const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ' ' + k : ' ' + k + '="' + String(v).replace(/"/g, '&quot;') + '"')).join('');
  return '<' + n.tag + attrs + '>' + n.children.map(serialize).join('') + '</' + n.tag + '>';
};

let server;
let browser;
let base;
const pages = new Map();
before(async () => {
  server = http.createServer((req, res) => {
    const body = req.url === '/' ? ORIGINAL : pages.get(req.url);
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  server?.close();
});

test('commonPath and regionDiff: the area of a control and what opening it changed', () => {
  assert.equal(commonPath(['body>main:1>div:2>button:1', 'body>main:1>div:2>div:1>div:1']), 'body>main:1>div:2');
  const closed = { '': { s: { height: '40px' } }, 'div:1': { s: { 'grid-template-rows': '0px', height: '0px' } } };
  const open = { '': { s: { height: '80px' } }, 'div:1': { s: { 'grid-template-rows': '24px', height: '24px' } }, 'div:1>p:2': { s: {} } };
  assert.deepEqual(regionDiff(closed, open), [
    { rel: '', changes: { height: ['40px', '80px'] } },
    { rel: 'div:1', changes: { 'grid-template-rows': ['0px', '24px'], height: ['0px', '24px'] } },
  ]);
});

test('openDecls: collapsed sizes open to their content, other size changes are left out', () => {
  assert.deepEqual(openDecls({ 'grid-template-rows': ['0px', '56px'], height: ['0px', '56px'] }), { 'grid-template-rows': '1fr', height: 'auto' });
  assert.deepEqual(openDecls({ height: ['40px', '80px'], 'max-height': ['0px', '300px'] }), { 'max-height': 'none' });
  assert.deepEqual(openDecls({ transform: ['none', 'matrix(0, 1, -1, 0, 0, 0)'], opacity: ['0', '1'] }), { transform: 'matrix(0, 1, -1, 0, 0, 0)', opacity: '1' });
});

test('an accordion of the original opens and closes in the copy, every item, with script only', async () => {
  // 1. Capture like Recreate: snapshot first (everything closed), then the click probe.
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  await context.close();
  const disclosures = clicks.widgets.filter((w) => w.kind === 'disclosure');
  assert.ok(disclosures.length >= 1, 'the questions are found as panels that open');
  assert.ok(disclosures.every((w) => w.state?.parts?.length), 'with their open state');
  assert.ok(disclosures.every((w) => w.exclusive === true), 'one answer at a time is recognised');

  // 2. IR: tokens on every item (also the ones the probe did not click), CSS for the open state.
  const tree = buildPageTree({ desktop: snapshot.body });
  const site = { pages: [{ info: { path: '/', url: `${base}/` }, root: tree.root }], assetResolve: () => null };
  const { motion, stats } = applyMotion(site, new Map([['/', { clicks }]]));
  assert.equal(stats.widgets.effects, 1, 'equal items share one effect');
  assert.equal(stats.widgets.elements, 5, 'all five questions get it');
  assert.ok(motion.script);
  const css = motionCss(motion, { tokenOf: new Map(), from: '' });
  assert.match(css, /\.is-open[^{]*\{[^}]*grid-template-rows: 1fr/);
  assert.match(css, /\.is-open[^{]*\{[^}]*transform: matrix\(/, 'the arrow turns too');

  // 3. The copy: the captured markup (classes of the original kept for its closed look) with the tokens, the generated CSS and script.
  const html = (n) => {
    if (!isElement(n)) return n.text.replace(/</g, '&lt;');
    const all = { ...n.attrs, ...n.stateAttrs };
    const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
    const tokens = n.motionTokens?.length ? ` data-motion="${n.motionTokens.join(' ')}"` : '';
    return `<${n.tag}${attrs}${tokens}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  const style = ORIGINAL.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\.item\.open[^}]*\}/g, '');
  const copy = (script) => `<!doctype html><html><head><style>${style}\n${css}</style>${script ? '<script src="/js/motion.js" defer></script>' : ''}</head>${html(tree.root)}</html>`;
  pages.set('/copy', copy(true));
  pages.set('/copy-no-js', copy(false));
  pages.set('/js/motion.js', MOTION_JS);

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/copy`);
  const answerHeight = (i) => p.evaluate((n) => document.querySelectorAll('p')[n].getBoundingClientRect().height ? document.querySelectorAll('p')[n].closest('[data-motion~="wt"]') ? -1 : document.querySelectorAll('p')[n].parentElement.parentElement.getBoundingClientRect().height : 0, i);
  for (let i = 0; i < 5; i++) assert.equal(await answerHeight(i), 0, `answer ${i + 1} starts closed`);
  const buttons = p.locator('button');
  await buttons.nth(4).click(); // an item the probe never clicked
  await p.waitForTimeout(400);
  assert.ok((await answerHeight(4)) > 10, 'the fifth answer opens');
  assert.equal(await buttons.nth(4).getAttribute('aria-expanded'), 'true');
  assert.equal(await answerHeight(0), 0, 'the others stay closed');
  await buttons.nth(4).click();
  await p.waitForTimeout(400);
  assert.equal(await answerHeight(4), 0, 'and closes again');
  // One answer at a time, like the original: opening the second closes the first.
  await buttons.nth(0).click();
  await p.waitForTimeout(400);
  await buttons.nth(1).click();
  await p.waitForTimeout(400);
  assert.ok((await answerHeight(1)) > 10, 'the second answer is open');
  assert.equal(await answerHeight(0), 0, 'the first closed by itself');
  assert.equal(await buttons.nth(0).getAttribute('aria-expanded'), 'false');
  assert.deepEqual(errors, []);

  // Without script the page is as captured: closed, nothing broken.
  await p.goto(`${base}/copy-no-js`);
  assert.equal(await answerHeight(0), 0);
  await ctx.close();
});

// A carousel like a React one: dots and next / previous; the detail panel is re-rendered for the selected item, so only
// the current item exists in the page. A ticking counter elsewhere changes on its own (noise, never a state).
const CAROUSEL = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif }
.dots button { width: 12px; height: 12px; border-radius: 50%; border: 0; background: #ccc; cursor: pointer }
.dots button.on { background: #06f }
.panel h3 { color: #123 }
</style></head><body><header><span id="tick">0</span></header><main><section class="ventures"><div class="box">
<div class="panel"></div>
<div class="controls"><button class="nav" type="button" aria-label="Previous venture">‹</button><div class="dots"></div><button class="nav" type="button" aria-label="Next venture">›</button></div>
</div></section></main>
<script>
var items = ['Accern', 'Botza', 'Choice AI', 'DreamHire'];
var cur = 2;
var dots = document.querySelector('.dots');
items.forEach(function (name, i) { var b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', 'Go to ' + name); b.onclick = function () { show(i); }; dots.appendChild(b); });
function show(i) {
  cur = (i + items.length) % items.length;
  document.querySelector('.panel').innerHTML = '<h3>' + items[cur] + '</h3><p>About ' + items[cur] + '.</p>';
  [].forEach.call(dots.children, function (b, k) { b.className = k === cur ? 'on' : ''; });
}
document.querySelectorAll('.nav')[0].onclick = function () { show(cur - 1); };
document.querySelectorAll('.nav')[1].onclick = function () { show(cur + 1); };
show(2);
setInterval(function () { var t = document.getElementById('tick'); t.textContent = String(Number(t.textContent) + 1); }, 150);
setInterval(function () { show(cur + 1); }, 1500); // moves on by itself
</script></body></html>`;

test('a carousel whose content the original re-renders: every state is in the copy, dots and next / previous switch it', async () => {
  pages.set('/carousel', CAROUSEL);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/carousel`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, snapshot.body, { budgetMs: 20000 });
  await context.close();
  assert.equal(planSets(clicks.widgets, clicks.noise).length, 1, 'the selected dot and its neighbours are one set');
  assert.equal(states.sets, 1, JSON.stringify(states.skipped));
  assert.equal(states.states, 4);
  const area = (function find(n) {
    if (!n || 'text' in n) return null;
    if (n.states) return n;
    for (const c of n.children ?? []) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  })(snapshot.body);
  assert.equal(area.states.initial, 2, 'starts where a first visit starts');
  assert.equal(area.states.autoplay?.step, 1, 'moves on by itself, forwards');
  assert.ok(Math.abs(area.states.autoplay.ms - 1500) <= 300, `every ~1.5 s (${area.states.autoplay.ms})`);

  const tree = buildPageTree({ desktop: snapshot.body });
  assert.equal(tree.stats.stateSets, 1);
  assert.equal(tree.stats.states, 3, 'the three states the page did not start in are added');
  const site = { pages: [{ info: { path: '/carousel', url: `${base}/carousel` }, root: tree.root }], assetResolve: () => null };
  const { motion } = applyMotion(site, new Map([['/carousel', { clicks }]]));
  assert.equal(motion.states, 1);
  assert.ok(motion.script);
  const css = motionCss(motion, { tokenOf: new Map(), from: '' });

  const html = (n) => {
    if (!isElement(n)) return n.text.replace(/</g, '&lt;');
    const all = { ...n.attrs, ...n.stateAttrs, ...(n.motionTokens?.length && { 'data-motion': n.motionTokens.join(' ') }) };
    const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  const style = CAROUSEL.match(/<style>([\s\S]*?)<\/style>/)[1];
  pages.set('/carousel-copy', `<!doctype html><html><head><style>${style}\n${css}</style><script src="/js/motion.js" defer></script></head>${html(tree.root)}</html>`);
  pages.set('/carousel-copy-no-js', `<!doctype html><html><head><style>${style}\n${css}</style></head>${html(tree.root)}</html>`);

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const visibleTitles = () => p.evaluate(() => [...document.querySelectorAll('h3')].filter((h) => h.getClientRects().length).map((h) => h.textContent));
  await p.goto(`${base}/carousel-copy`);
  assert.deepEqual(await visibleTitles(), ['Choice AI'], 'starts where the original started');
  await p.locator('button[aria-label="Go to Accern"]:visible').click();
  assert.deepEqual(await visibleTitles(), ['Accern'], 'a dot shows its item');
  await p.locator('button[aria-label="Next venture"]:visible').click();
  assert.deepEqual(await visibleTitles(), ['Botza'], 'next goes one on');
  await p.locator('button[aria-label="Previous venture"]:visible').click();
  await p.locator('button[aria-label="Previous venture"]:visible').click();
  assert.deepEqual(await visibleTitles(), ['DreamHire'], 'previous wraps around');
  // Left alone, the copy moves on by itself like the original (the wait restarts after a click).
  await p.waitForTimeout(3400);
  assert.notDeepEqual(await visibleTitles(), ['DreamHire'], 'it moved on by itself');
  assert.deepEqual(errors, []);
  await p.goto(`${base}/carousel-copy-no-js`);
  assert.deepEqual(await visibleTitles(), ['Choice AI'], 'without script: the first state only');
  await ctx.close();
});

// Step 4 (phone and tablet back): the states are snapshotted at the desktop window only. Built with the generated stylesheet
// from a desktop and a phone capture, the copies must take the phone layout of the area they copy (a node missing in a
// view is hidden there), so on a phone the dots and next / previous still switch the item.
test('a carousel copied from a desktop and a phone capture still switches on a phone (state copies are not hidden there)', async () => {
  pages.set('/carousel', CAROUSEL);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/carousel`);
  const desktop = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, desktop.body, { budgetMs: 20000 });
  await context.close();
  assert.equal(states.sets, 1, JSON.stringify(states.skipped));
  const phoneContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const phonePage = await phoneContext.newPage();
  await phonePage.goto(`${base}/carousel`);
  const mobile = await phonePage.evaluate(snapshotPage, {});
  await phoneContext.close();

  const tree = buildPageTree({ desktop: desktop.body, mobile: mobile.body });
  assert.equal(tree.stats.states, 3);
  const copies = [];
  (function walk(n) {
    if (!isElement(n)) return;
    if (n.stateAttrs && 'hidden' in n.stateAttrs) copies.push(n);
    n.children.forEach(walk);
  })(tree.root);
  assert.equal(copies.length, 3);
  const everyNode = (n, fn) => !isElement(n) || (fn(n) && n.children.every((c) => everyNode(c, fn)));
  assert.ok(copies.every((c) => everyNode(c, (n) => n.views.mobile)), 'every node of a copy has phone data');

  const site = { pages: [{ info: { path: '/carousel', url: `${base}/carousel` }, root: tree.root }], assetResolve: () => null };
  const { motion } = applyMotion(site, new Map([['/carousel', { clicks }]]));
  const { rules, boxSizingReset } = buildStyles([tree], { assetFile: () => null });
  const ir = { rules, breakpoints: { source: 'default' }, tokens: {}, fontFaces: [], keyframes: [], boxSizingReset, pages: [] };
  const siteCss = emitCss(ir);
  assert.match(typeof siteCss === 'string' ? siteCss : siteCss.css, /@media \(max-width: 767\.98px\)/, 'the copy has phone rules');
  const css = `${typeof siteCss === 'string' ? siteCss : siteCss.css}\n${motionCss(motion, { tokenOf: new Map(), from: '' })}`;
  const html = (n) => {
    if (!isElement(n)) return n.text.replace(/</g, '&lt;');
    const all = { ...n.attrs, ...(n.class && { class: n.class }), ...n.stateAttrs, ...(n.motionTokens?.length && { 'data-motion': n.motionTokens.join(' ') }) };
    const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  const doc = (extra = '') => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}\n${extra}</style><script src="/js/motion.js" defer></script></head>${html(tree.root)}</html>`;
  pages.set('/carousel-phone', doc());
  // The safety net of js/motion.js: a state the stylesheet does not show at this width is not switched to.
  pages.set('/carousel-phone-hidden', doc('@media (max-width: 767.98px) { [data-w-set][data-w-i="0"] { display: none } }'));

  for (const width of [375, 1200]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    const visibleTitles = () => p.evaluate(() => [...document.querySelectorAll('h3')].filter((h) => h.getClientRects().length).map((h) => h.textContent));
    await p.goto(`${base}/carousel-phone`);
    assert.deepEqual(await visibleTitles(), ['Choice AI'], `${width}: starts where the original started`);
    await p.locator('button[aria-label="Go to Accern"]:visible').click();
    assert.deepEqual(await visibleTitles(), ['Accern'], `${width}: a dot shows its item`);
    await p.locator('button[aria-label="Next venture"]:visible').click();
    assert.deepEqual(await visibleTitles(), ['Botza'], `${width}: next goes one on`);
    if (width === 375) {
      await p.goto(`${base}/carousel-phone-hidden`);
      await p.locator('button[aria-label="Go to Accern"]:visible').click();
      assert.deepEqual(await visibleTitles(), ['Choice AI'], 'a state not shown at this width is not switched to (nothing goes blank)');
      await p.locator('button[aria-label="Go to DreamHire"]:visible').click();
      assert.deepEqual(await visibleTitles(), ['DreamHire'], 'the others still switch');
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

// A menu button only the phone layout shows: the desktop probe never sees it (hidden there), so the phone view is probed
// too (mobile-clicks.json) and the copy opens the drawer on a phone like the original.
const PHONE_MENU = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
body { margin: 0; font: 16px sans-serif } header { display: flex; justify-content: space-between; padding: 12px }
.links a { margin: 0 8px } .burger { display: none; width: 44px; height: 32px }
.drawer { display: none; padding: 12px; background: #eee } .drawer.open { display: block }
@media (max-width: 600px) { .links { display: none } .burger { display: block } }
</style></head><body><header><b>Logo</b><nav class="links"><a href="/a.html">Alpha</a><a href="/b.html">Beta</a></nav>
<button class="burger" type="button" aria-label="Open menu" aria-expanded="false">=</button></header>
<nav class="drawer" id="drawer"><a href="/a.html">Alpha page</a> <a href="/b.html">Beta page</a></nav>
<main><p>Content</p></main>
<script>var b = document.querySelector('.burger'), d = document.getElementById('drawer');
b.addEventListener('click', function () { var o = d.classList.toggle('open'); b.setAttribute('aria-expanded', String(o)); });</script></body></html>`;

test('a menu button only the phone layout shows opens its drawer in the copy on a phone', async () => {
  pages.set('/phone-menu', PHONE_MENU);
  pages.set('/js/motion.js', MOTION_JS);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/phone-menu`);
  const desktop = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 10000 });
  await context.close();
  assert.ok(!clicks.widgets.some((w) => /menu/i.test(w.text ?? '')), 'the desktop probe does not see the phone menu');
  const phoneContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const phonePage = await phoneContext.newPage();
  await phonePage.goto(`${base}/phone-menu`);
  const mobile = await phonePage.evaluate(snapshotPage, {});
  const phoneClicks = await captureClicks(phonePage, { budgetMs: 8000, limit: 8 });
  await phoneContext.close();
  assert.ok(phoneClicks.widgets.some((w) => w.kind === 'disclosure' && w.state), JSON.stringify(phoneClicks.widgets.map((w) => [w.kind, w.text, Boolean(w.state)])));

  const tree = buildPageTree({ desktop: desktop.body, mobile: mobile.body });
  const site = { pages: [{ info: { path: '/phone-menu', url: `${base}/phone-menu` }, root: tree.root }], assetResolve: () => null };
  const { motion, stats } = applyMotion(site, new Map([['/phone-menu', { clicks, clicksMobile: phoneClicks }]]));
  assert.ok(stats.widgets.phone >= 1 && motion.script, JSON.stringify(stats.widgets));
  const { rules, boxSizingReset } = buildStyles([tree], { assetFile: () => null });
  const siteCss = emitCss({ rules, breakpoints: { source: 'default' }, tokens: {}, fontFaces: [], keyframes: [], boxSizingReset, pages: [] });
  const css = `${typeof siteCss === 'string' ? siteCss : siteCss.css}\n${motionCss(motion, { tokenOf: new Map(), from: '' })}`;
  const html = (n) => {
    if (!isElement(n)) return n.text.replace(/</g, '&lt;');
    const all = { ...n.attrs, ...(n.class && { class: n.class }), ...n.stateAttrs, ...(n.motionTokens?.length && { 'data-motion': n.motionTokens.join(' ') }) };
    const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  pages.set('/phone-menu-copy', `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style><script src="/js/motion.js" defer></script></head>${html(tree.root)}</html>`);
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/phone-menu-copy`);
  const drawerShown = () => p.evaluate(() => [...document.querySelectorAll('a')].some((a) => a.textContent === 'Alpha page' && a.getClientRects().length > 0));
  assert.equal(await drawerShown(), false, 'closed at first');
  await p.locator('button:visible').first().click();
  assert.equal(await drawerShown(), true, 'the menu button opens the drawer');
  await p.locator('button:visible').first().click();
  assert.equal(await drawerShown(), false, 'and closes it');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// A media page styled inline (no classes): category chips render only the chosen category's section (the others are
// removed from the page), and the videos section has a look-alike "View more" button that adds a card and becomes
// "View less" (a second click takes it away).
const FILTER = `<!doctype html><html><head><style>body { margin: 0; font: 16px sans-serif }</style></head><body><main>
<section><div id="chips"></div></section><div id="list"></div>
<section><p>Footer text</p></section></main>
<script>
var cats = { News: ['Funding news'], Videos: ['Video one', 'Video two'], Blogs: ['Essay'] };
var cur = 'All', more = false;
var chips = document.getElementById('chips');
['All', 'News', 'Videos', 'Blogs'].forEach(function (c) { var b = document.createElement('button'); b.textContent = c; b.style.cssText = 'margin:4px;padding:6px'; b.onclick = function () { cur = c; more = false; render(); }; chips.appendChild(b); });
function render() {
  [].forEach.call(chips.children, function (b) { b.style.background = b.textContent === cur ? '#06f' : '#eee'; });
  var html = '';
  Object.keys(cats).forEach(function (c) {
    if (cur !== 'All' && cur !== c) return;
    html += '<section><h2>' + c + '</h2><div>' + cats[c].map(function (t) { return '<div style="padding:8px;border:1px solid #ccc">' + t + '</div>'; }).join('') + '</div>' +
      (c === 'Videos' ? '<div><button style="margin:4px;padding:6px" id="more">View more</button></div>' : '') + '</section>';
  });
  document.getElementById('list').innerHTML = html;
  // Like a framework updating in place: only the extra card is added or removed, and the button's label changes.
  var m = document.getElementById('more'); if (m) m.onclick = function () {
    more = !more; m.textContent = more ? 'View less' : 'View more';
    var list = m.parentElement.previousElementSibling;
    if (more) { var d = document.createElement('div'); d.style.cssText = 'padding:8px;border:1px solid #ccc'; d.textContent = 'Video three'; list.appendChild(d); } else list.lastElementChild.remove();
  };
}
render();
</script></body></html>`;

test('a filter that renders only the chosen section, and a "View more" that adds a card: both work in the copy', async () => {
  pages.set('/filter', FILTER);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/filter`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 20000 });
  const states = await captureStates(page, clicks, snapshot.body, { budgetMs: 30000 });
  await context.close();
  assert.ok(clicks.widgets.some((w) => w.text === 'View more'), 'the look-alike button is probed on its own');
  assert.equal(states.sets, 2, JSON.stringify(states.skipped));

  const tree = buildPageTree({ desktop: snapshot.body });
  const site = { pages: [{ info: { path: '/filter', url: `${base}/filter` }, root: tree.root }], assetResolve: () => null };
  const { motion } = applyMotion(site, new Map([['/filter', { clicks }]]));
  assert.ok(motion.script);
  const css = motionCss(motion, { tokenOf: new Map(), from: '' });
  const html = (n) => {
    if (!isElement(n)) return n.text.replace(/</g, '&lt;');
    const all = { ...n.attrs, ...n.stateAttrs, ...(n.motionTokens?.length && { 'data-motion': n.motionTokens.join(' ') }) };
    const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  pages.set('/filter-copy', `<!doctype html><html><head><style>${css}</style><script src="/js/motion.js" defer></script></head>${html(tree.root)}</html>`);

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/filter-copy`);
  const headings = () => p.evaluate(() => [...document.querySelectorAll('h2')].filter((h) => h.getClientRects().length).map((h) => h.textContent));
  const items = () => p.evaluate(() => [...document.querySelectorAll('div')].filter((d) => /^(Video|Funding|Essay)/.test(d.textContent) && !d.children.length && d.getClientRects().length).map((d) => d.textContent));
  assert.deepEqual(await headings(), ['News', 'Videos', 'Blogs']);
  await p.locator('button:visible', { hasText: 'Videos' }).click();
  assert.deepEqual(await headings(), ['Videos'], 'a chip shows only its section');
  await p.locator('button:visible', { hasText: 'View more' }).click();
  assert.deepEqual(await items(), ['Video one', 'Video two', 'Video three'], 'View more adds the card in the filtered state too');
  await p.locator('button:visible', { hasText: 'View less' }).click();
  assert.deepEqual(await items(), ['Video one', 'Video two'], 'View less takes it away');
  await p.locator('button:visible', { hasText: 'All' }).click();
  assert.deepEqual(await headings(), ['News', 'Videos', 'Blogs']);
  await p.locator('button:visible', { hasText: 'View more' }).click();
  assert.ok((await items()).includes('Video three'), 'and in the first state');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Product cards whose hover look the page's script draws (like a site builder's hover variant): on mouseenter a dark
// layer with a description is added inside the card, on mouseleave it is removed. Each card sits in its own grid cell.
const HOVER_CARDS = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif } .cards { display: grid; grid-template-columns: repeat(3, 240px); gap: 20px; padding: 40px }
.card { display: block; position: relative; height: 160px; padding: 16px; border: 1px solid #ccc; background: #fff; color: #111; text-decoration: none }
.layer { position: absolute; inset: 0; background: #333; color: #fff; padding: 16px }
</style></head><body><main><section class="cards">
<div class="cell"><a class="card" href="#"><h3>Clinic</h3></a></div>
<div class="cell"><a class="card" href="#"><h3>Hospital</h3></a></div>
<div class="cell"><a class="card" href="#"><h3>Lab</h3></a></div>
</section></main>
<script>document.querySelectorAll('.card').forEach(function (c) {
  c.addEventListener('mouseenter', function () { var d = document.createElement('div'); d.className = 'layer'; d.textContent = 'All about ' + c.querySelector('h3').textContent; c.appendChild(d); });
  c.addEventListener('mouseleave', function () { var d = c.querySelector('.layer'); if (d) d.remove(); });
});</script></body></html>`;

test('cards whose hover look the script draws show that look in the copy, with CSS only', async () => {
  pages.set('/hover-cards', HOVER_CARDS);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/hover-cards`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, snapshot.body, { budgetMs: 15000 });
  await context.close();
  assert.ok(clicks.widgets.some((w) => w.opensOn === 'hover'), JSON.stringify(clicks.widgets.map((w) => [w.kind, w.opensOn])));
  assert.ok(states.hoverCards >= 1, JSON.stringify(states));

  const tree = buildPageTree({ desktop: snapshot.body });
  assert.equal(tree.stats.hoverCards, states.hoverCards);
  const site = { pages: [{ info: { path: '/hover-cards', url: `${base}/hover-cards` }, root: tree.root }], assetResolve: () => null };
  const { motion } = applyMotion(site, new Map([['/hover-cards', { clicks }]]));
  // The hovered look waits in a <template> in the published page and the script puts it in place on the first pointerover
  // (fewer elements); the swap itself is CSS, as this page (built without templates) shows.
  assert.equal(motion.script, true, 'the script brings the hovered look in');
  const css = motionCss(motion, { tokenOf: new Map(), from: '' });
  const html = (n) => {
    if (!isElement(n)) return n.text.replace(/</g, '&lt;');
    const all = { ...n.attrs, ...n.stateAttrs, ...(n.motionTokens?.length && { 'data-motion': n.motionTokens.join(' ') }) };
    const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  const style = HOVER_CARDS.match(/<style>([\s\S]*?)<\/style>/)[1];
  pages.set('/hover-cards-copy', `<!doctype html><html><head><style>${style}\n${css}</style></head>${html(tree.root)}</html>`);
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(`${base}/hover-cards-copy`);
  const layers = () => p.evaluate(() => [...document.querySelectorAll('.layer')].filter((e) => e.getClientRects().length).map((e) => e.textContent));
  assert.deepEqual(await layers(), [], 'no layer at first');
  // A real mouse move (the card hides itself once hovered, its hovered copy takes its place).
  const box = await p.locator('h3:visible', { hasText: 'Hospital' }).boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  assert.deepEqual(await layers(), ['All about Hospital'], 'the hovered look shows on hover');
  await p.mouse.move(5, 5);
  assert.deepEqual(await layers(), [], 'and the card is back when the mouse leaves');
  await ctx.close();
});

// Tabs whose second tab shows cards with a stylesheet hover (a lift): the cards exist only in that state, so their hover
// is read while the state is shown and reaches the copy's hidden state.
const TAB_HOVER = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif } .tabs button { padding: 8px } .card { display: inline-block; width: 200px; height: 80px; margin: 10px; border: 1px solid #ccc; transition: transform .2s }
.card:hover { transform: translateY(-3px); box-shadow: 0 10px 20px rgba(0, 0, 0, .1) }
</style></head><body><main><section><div class="tabs"><button>Partner</button><button>Join</button></div></section>
<section id="panel"><p>Partner form here.</p></section></main>
<script>var bs = document.querySelectorAll('.tabs button'); var panel = document.getElementById('panel');
bs[0].onclick = function () { panel.innerHTML = '<p>Partner form here.</p>'; };
bs[1].onclick = function () { panel.innerHTML = '<div class="card">One</div><div class="card">Two</div>'; };</script></body></html>`;

test('hover effects of content only another tab shows reach the copy of that tab', async () => {
  pages.set('/tab-hover', TAB_HOVER);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/tab-hover`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, snapshot.body, { budgetMs: 20000 });
  await context.close();
  assert.equal(states.sets, 1, JSON.stringify(states));
  const tree = buildPageTree({ desktop: snapshot.body });
  const site = { pages: [{ info: { path: '/tab-hover', url: `${base}/tab-hover` }, root: tree.root }], assetResolve: () => null };
  const { motion, stats } = applyMotion(site, new Map([['/tab-hover', { clicks, hover: [], focus: [] }]]));
  assert.ok(stats.hover.elements >= 2, `the two cards of the hidden tab get the hover: ${JSON.stringify(stats.hover)}`);
  const css = motionCss(motion, { tokenOf: new Map(), from: '' });
  assert.match(css, /:hover[^{]*\{[^}]*translate|:hover[^{]*\{[^}]*transform/);
});

// Cards whose click shows a short fixed message with their own name, gone again after a moment (no site to open yet).
const NOTICE = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif } .cards { display: flex; gap: 20px; padding: 40px }
.card { display: block; width: 200px; padding: 20px; border: 1px solid #ccc; color: #111; text-decoration: none }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #111; color: #fff; padding: 12px 18px; border-radius: 8px }
</style></head><body><main><section class="cards">
<a class="card" href="#"><h3>Accern</h3></a><a class="card" href="#"><h3>Eigen</h3></a><a class="card" href="#"><h3>Botza</h3></a>
</section></main>
<script>
var timer;
document.querySelectorAll('.card').forEach(function (c) { c.addEventListener('click', function (e) {
  e.preventDefault();
  var t = document.querySelector('.toast'); if (t) t.remove();
  t = document.createElement('div'); t.className = 'toast'; t.textContent = c.textContent.trim() + "'s website hasn't been added yet.";
  document.querySelector('.cards').appendChild(t);
  clearTimeout(timer); timer = setTimeout(function () { t.remove(); }, 1200);
}); });
</script></body></html>`;

test('a short message a click shows: each control shows its own, gone again after the same time', async () => {
  pages.set('/notice', NOTICE);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/notice`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, snapshot.body, { budgetMs: 15000 });
  const notices = await captureNotices(page, clicks, snapshot.body);
  await context.close();
  assert.equal(states.sets, 0, 'the cards are not tabs');
  assert.equal(notices.notices, 1);
  assert.equal(notices.items, 3);
  const ms = snapshot.body.notices[0].ms;
  assert.ok(ms >= 900 && ms <= 1800, `stays ~1.2 s (${ms})`);

  const tree = buildPageTree({ desktop: snapshot.body });
  assert.equal(tree.stats.notices, 3);
  const site = { pages: [{ info: { path: '/notice', url: `${base}/notice` }, root: tree.root }], assetResolve: () => null };
  const { motion } = applyMotion(site, new Map([['/notice', { clicks }]]));
  assert.ok(motion.script);
  const css = motionCss(motion, { tokenOf: new Map(), from: '' });
  const html = (n) => {
    if (!isElement(n)) return n.text.replace(/</g, '&lt;');
    const all = { ...n.attrs, ...n.stateAttrs, ...(n.motionTokens?.length && { 'data-motion': n.motionTokens.join(' ') }) };
    const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  const style = NOTICE.match(/<style>([\s\S]*?)<\/style>/)[1];
  pages.set('/notice-copy', `<!doctype html><html><head><style>${style}\n${css}</style><script src="/js/motion.js" defer></script></head>${html(tree.root)}</html>`);

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(`${base}/notice-copy`);
  const shown = () => p.evaluate(() => [...document.querySelectorAll('[data-w-note-of]')].filter((e) => !e.hidden).map((e) => e.textContent.trim()));
  assert.deepEqual(await shown(), [], 'no message at first');
  await p.locator('a.card', { hasText: 'Eigen' }).click();
  assert.deepEqual(await shown(), ["Eigen's website hasn't been added yet."]);
  assert.equal(new URL(p.url()).hash, '', 'the # link does not jump');
  await p.waitForTimeout(ms + 400);
  assert.deepEqual(await shown(), [], 'gone again after the same time');
  await ctx.close();
});

// Dots switching a panel (a state set) and cards showing a short message (notices) on one page.
const DOTS_AND_NOTICE = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif } .dots button { width: 12px; height: 12px; border-radius: 50%; border: 0; background: #ccc; cursor: pointer }
.dots button.on { background: #06f } .cards { display: flex; gap: 20px; padding: 40px }
.card { display: block; width: 200px; padding: 20px; border: 1px solid #ccc; color: #111; text-decoration: none }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #111; color: #fff; padding: 12px 18px; border-radius: 8px }
</style></head><body><main><section class="ventures"><div class="panel"></div><div class="dots"></div></section>
<section class="cards"><a class="card" href="#"><h3>Accern</h3></a><a class="card" href="#"><h3>Eigen</h3></a><a class="card" href="#"><h3>Botza</h3></a></section></main>
<script>
var items = ['Accern', 'Botza', 'Choice AI'];
var dots = document.querySelector('.dots');
items.forEach(function (name, i) { var b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', 'Go to ' + name); b.onclick = function () { show(i); }; dots.appendChild(b); });
function show(i) {
  document.querySelector('.panel').innerHTML = '<h3>' + items[i] + '</h3><p>About ' + items[i] + '.</p>';
  [].forEach.call(dots.children, function (b, k) { b.className = k === i ? 'on' : ''; });
}
show(0);
var timer;
document.querySelectorAll('.card').forEach(function (c) { c.addEventListener('click', function (e) {
  e.preventDefault();
  var t = document.querySelector('.toast'); if (t) t.remove();
  t = document.createElement('div'); t.className = 'toast'; t.textContent = c.textContent.trim() + "'s website hasn't been added yet.";
  document.querySelector('.cards').appendChild(t);
  clearTimeout(timer); timer = setTimeout(function () { t.remove(); }, 1200);
}); });
</script></body></html>`;

test('the page capture reads the state sets and the notices side by side, with the same result as one after the other', async () => {
  pages.set('/dots-notice', DOTS_AND_NOTICE);
  // One after the other (what the capture did before).
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/dots-notice`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const serial = { states: await captureStates(page, clicks, snapshot.body, { budgetMs: 20000 }), notices: await captureNotices(page, clicks, snapshot.body) };
  await context.close();
  assert.ok(serial.states.sets >= 1, JSON.stringify(serial.states.skipped));
  assert.equal(serial.notices.items, 3);

  // The page capture (capture/index.js): both at once.
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sas-widgets-'));
  try {
    const result = await capturePage(browser, { url: `${base}/dots-notice`, path: '/dots-notice', slug: 'dots-notice' }, workspace, { motionBudgetMs: 3000, clickBudgetMs: 15000 });
    assert.deepEqual(result.errors, []);
    const dir = path.join(workspace, 'capture', 'dots-notice');
    const motion = JSON.parse(await readFile(path.join(dir, 'motion.json'), 'utf8'));
    assert.equal(motion.states.sets, serial.states.sets);
    assert.equal(motion.states.states, serial.states.states);
    assert.equal(motion.notices.notices, serial.notices.notices);
    assert.equal(motion.notices.items, serial.notices.items);
    const desktop = JSON.parse(await readFile(path.join(dir, 'desktop.json'), 'utf8'));
    assert.equal(desktop.body.notices[0].items.length, 3);
    // Side by side: both together take about as long as the longer one, not the sum.
    const both = motion.statesNoticesMs;
    console.log(`# states ${motion.states.ms} ms, notices ${motion.notices.ms} ms, both together ${both} ms`);
    assert.ok(both < motion.states.ms + motion.notices.ms - 500, `${both} ms vs ${motion.states.ms} + ${motion.notices.ms} ms`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// A panel a click renders on demand and the page closes with Escape, not by clicking the control again: its opened
// DOM is the only way to rebuild it, and it used to be dropped because the second click did not undo the first.
const ESCAPE_PANEL = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif; padding: 24px }
.row { position: relative; display: flex; gap: 12px; align-items: center }
.open { font: inherit; padding: 8px 14px; border: 1px solid #888; background: #fff; cursor: pointer }
.panel { margin-top: 12px; border: 1px solid #ddd; padding: 12px; display: grid; gap: 6px; width: 240px }
</style></head><body>
<h1>Catalogue</h1>
<div class="row"><button class="open" type="button">Filters</button></div>
<main><p>A list of products with enough text on the page that the button is not all there is to read.</p></main>
<script>
var row = document.querySelector('.row');
row.querySelector('.open').addEventListener('click', function () {
  if (row.querySelector('.panel')) return;
  var p = document.createElement('div');
  p.className = 'panel';
  p.innerHTML = '<label>In stock</label><label>On sale</label>';
  row.appendChild(p);
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { var p = row.querySelector('.panel'); if (p) p.remove(); }
});
</script>
</body></html>`;

test('a panel a click renders and Escape closes is captured, and the copy opens it with the same control', async () => {
  pages.set('/escape-panel', ESCAPE_PANEL);
  pages.set('/js/motion.js', MOTION_JS);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/escape-panel`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, snapshot.body, { budgetMs: 20000 });
  await context.close();

  const widget = clicks.widgets.find((w) => w.text === 'Filters');
  assert.ok(widget && widget.kind === 'disclosure' && widget.closes === 'escape',
    JSON.stringify(clicks.widgets.map((w) => [w.kind, w.text, w.closes])));
  assert.equal(states.openPanels, 1, JSON.stringify(states.skipped));

  const tree = buildPageTree({ desktop: snapshot.body });
  const site = { pages: [{ info: { path: '/escape-panel', url: `${base}/escape-panel` }, root: tree.root }], assetResolve: () => null };
  const { motion } = applyMotion(site, new Map([['/escape-panel', { clicks }]]));
  assert.ok(motion.script);
  const { rules, boxSizingReset } = buildStyles([tree], { assetFile: () => null });
  const siteCss = emitCss({ rules, breakpoints: { source: 'default' }, tokens: {}, fontFaces: [], keyframes: [], boxSizingReset, pages: [] });
  const css = `${typeof siteCss === 'string' ? siteCss : siteCss.css}\n${motionCss(motion, { tokenOf: new Map(), from: '' })}`;
  const html = (n) => {
    if (!isElement(n)) return n.text.replace(/</g, '&lt;');
    const all = { ...n.attrs, ...(n.class && { class: n.class }), ...n.stateAttrs, ...(n.motionTokens?.length && { 'data-motion': n.motionTokens.join(' ') }) };
    const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  const copy = html(tree.root);
  assert.match(copy, /In stock/); // the panel's markup is in the page, as a hidden state
  assert.match(copy, /data-w-go/);
  pages.set('/escape-panel-copy', `<!doctype html><html><head><style>${css}</style><script src="/js/motion.js" defer></script></head>${copy}</html>`);

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/escape-panel-copy`);
  const shown = () => p.evaluate(() => [...document.querySelectorAll('label')].some((l) => l.textContent === 'In stock' && l.getClientRects().length > 0));
  assert.equal(await shown(), false, 'closed at first');
  await p.getByRole('button', { name: 'Filters' }).first().click();
  assert.equal(await shown(), true, 'the control opens the panel');
  await p.getByRole('button', { name: 'Filters' }).first().click();
  assert.equal(await shown(), false, 'and closes it again');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// --- Step 2 of the gap plan: interactions ------------------------------------------------------------------------

// A top bar whose links are controls: "Platforms" opens a menu on click and the page stays where it is (its script
// suppresses the link); "About us" shows a flyout but follows its link as well. Only the first may become a control in
// the copy - the second has to stay a link.
const NAV_LINKS = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif }
header { display: flex; gap: 24px; padding: 12px; position: relative }
.has, .card { position: relative }
.menu { display: none; position: absolute; top: 28px; left: 0; width: 260px; height: 150px; background: #eee; padding: 12px }
.has.open .menu { display: block }
.flyout { display: none; position: absolute; top: 28px; left: 0; width: 240px; height: 120px; background: #ddd; padding: 12px }
.card.open .flyout { display: block }
</style></head><body><header><b>Logo</b>
<div class="has"><a href="/platforms.html" id="pl">Platforms</a><div class="menu"><a href="/one.html">One</a> <a href="/two.html">Two</a></div></div>
<div class="card"><a href="/about.html" id="ab">About us</a><div class="flyout"><p>Quick look</p></div></div>
</header><main><p>Content</p></main>
<script>
var pl = document.getElementById('pl');
pl.addEventListener('click', function (e) { e.preventDefault(); pl.parentElement.classList.toggle('open'); });
var ab = document.getElementById('ab');
ab.addEventListener('click', function () { ab.parentElement.classList.toggle('open'); });
</script></body></html>`;

test('a nav link whose click opens a menu becomes a control; one that follows its link stays a link', async () => {
  pages.set('/nav-links', NAV_LINKS);
  pages.set('/js/motion.js', MOTION_JS);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/nav-links`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  await context.close();

  const menu = clicks.widgets.find((w) => /Platforms/.test(w.text ?? ''));
  const flyout = clicks.widgets.find((w) => /About/.test(w.text ?? ''));
  assert.ok(menu, `the link is clicked, not only hovered: ${JSON.stringify(clicks.widgets.map((w) => [w.text, w.kind]))}`);
  assert.equal(menu.kind, 'disclosure');
  assert.equal(menu.stay, true, 'the page suppressed the link itself');
  assert.ok(menu.state?.parts?.length, 'with its open state');
  assert.ok(flyout, 'the second link is probed too');
  assert.equal(flyout.stay, false, 'that one follows its link as well');

  const tree = buildPageTree({ desktop: snapshot.body });
  const site = { pages: [{ info: { path: '/nav-links', url: `${base}/nav-links` }, root: tree.root }], assetResolve: () => null };
  const { motion, stats } = applyMotion(site, new Map([['/nav-links', { clicks }]]));
  assert.equal(stats.widgets.skipped.navigates, 1, 'the link that navigates is not rebuilt');
  const find = (n, test) => {
    if (!isElement(n)) return null;
    if (test(n)) return n;
    for (const c of n.children) {
      const hit = find(c, test);
      if (hit) return hit;
    }
    return null;
  };
  const link = find(tree.root, (n) => n.tag === 'a' && /platforms/.test(String(n.attrs?.href ?? '')));
  assert.ok(link?.motionTokens?.includes('wt'), 'the link is the control of its panel');
  assert.ok(link.stateAttrs && 'data-w-stay' in link.stateAttrs, 'and does not follow its href');
  const other = find(tree.root, (n) => n.tag === 'a' && /about/.test(String(n.attrs?.href ?? '')));
  assert.ok(other, 'the other link is still in the page');
  assert.ok(!other.stateAttrs?.['data-w-stay'] && !other.motionTokens?.includes('wt'), 'untouched');

  const { rules, boxSizingReset } = buildStyles([tree], { assetFile: () => null });
  const siteCss = emitCss({ rules, breakpoints: { source: 'default' }, tokens: {}, fontFaces: [], keyframes: [], boxSizingReset, pages: [] });
  const css = `${typeof siteCss === 'string' ? siteCss : siteCss.css}\n${motionCss(motion, { tokenOf: new Map(), from: '' })}`;
  pages.set('/nav-links-copy', `<!doctype html><html><head><style>${css}</style><script src="/js/motion.js" defer></script></head>${serialize(tree.root)}</html>`);
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/nav-links-copy`);
  const menuShown = () => p.evaluate(() => [...document.querySelectorAll('a')].some((a) => a.textContent === 'One' && a.getClientRects().length > 0));
  assert.equal(await menuShown(), false, 'the menu starts closed');
  await p.locator('a[href="/platforms.html"]').click();
  assert.equal(await menuShown(), true, 'the link opens the menu');
  assert.equal(p.url(), `${base}/nav-links-copy`, 'and stays on the page');
  await p.locator('a[href="/platforms.html"]').click();
  assert.equal(await menuShown(), false, 'clicking it again closes the menu');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// A dialog the page draws only while it is open, appended to the body (a "portal"): the body is the only element holding
// both it and its button, so there is no area to rebuild in place. The copy ships the dialog as a hidden element of the
// page and opens it on the same button; Escape and its own × close it again.
const BODY_MODAL = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif }
.sheet { position: fixed; inset: 0; background: rgba(0, 0, 0, .5) }
.box { position: absolute; top: 80px; left: 50%; margin-left: -180px; width: 360px; height: 220px; background: #fff; padding: 24px }
.x { position: absolute; top: 8px; right: 8px; width: 32px; height: 32px }
</style></head><body><header><button id="open" type="button" aria-expanded="false">Sign in</button></header>
<main><p>Welcome</p></main>
<script>
var btn = document.getElementById('open');
var sheet = null;
function close() { if (sheet) { sheet.remove(); sheet = null; btn.setAttribute('aria-expanded', 'false'); } }
btn.addEventListener('click', function () {
  if (sheet) return close();
  sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = '<div class="box"><h2>Sign in</h2><p>Use your company account.</p><button class="x" type="button" aria-label="Close">\\u00d7</button></div>';
  document.body.appendChild(sheet);
  sheet.querySelector('.x').addEventListener('click', close);
  btn.setAttribute('aria-expanded', 'true');
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
</script></body></html>`;

test('a dialog the original appends to the body opens in the copy and closes with its × and with Escape', async () => {
  pages.set('/body-modal', BODY_MODAL);
  pages.set('/js/motion.js', MOTION_JS);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/body-modal`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, snapshot.body, { budgetMs: 20000 });
  await context.close();

  const dialog = clicks.widgets.find((w) => w.kind === 'dialog');
  assert.ok(dialog, `the click opens a layer over the page: ${JSON.stringify(clicks.widgets.map((w) => [w.text, w.kind]))}`);
  assert.ok(dialog.closes, 'and the page closes it again');
  assert.equal(planPanels(clicks.widgets, snapshot.body).length, 1, 'it is a panel the body alone holds');
  assert.equal(states.panels, 1, JSON.stringify(states.panelsSkipped));
  const panel = snapshot.body.panels[0];
  assert.equal(panel.control, dialog.trigger);
  assert.ok(panel.closeRel, 'the control inside it that closes it was found');
  assert.ok(JSON.stringify(panel.body).includes('company account'), 'the dialog is snapshotted open');

  const tree = buildPageTree({ desktop: snapshot.body });
  const site = { pages: [{ info: { path: '/body-modal', url: `${base}/body-modal` }, root: tree.root }], assetResolve: () => null };
  const { motion, stats } = applyMotion(site, new Map([['/body-modal', { clicks }]]));
  assert.equal(stats.states.panels, 1);
  assert.ok(motion.script, 'the panel needs the script');
  const { rules, boxSizingReset } = buildStyles([tree], { assetFile: () => null });
  const siteCss = emitCss({ rules, breakpoints: { source: 'default' }, tokens: {}, fontFaces: [], keyframes: [], boxSizingReset, pages: [] });
  const css = `${typeof siteCss === 'string' ? siteCss : siteCss.css}\n${motionCss(motion, { tokenOf: new Map(), from: '' })}`;
  assert.match(css, /\[data-w-panel-of\]\[hidden\]/, 'a panel not shown stays hidden without script');
  const copy = serialize(tree.root);
  assert.match(copy, /data-w-panel="p1"/);
  assert.match(copy, /data-w-panel-of="p1"/);
  assert.match(copy, /data-w-x/);
  pages.set('/body-modal-copy', `<!doctype html><html><head><style>${css}</style><script src="/js/motion.js" defer></script></head>${copy}</html>`);
  pages.set('/body-modal-nojs', `<!doctype html><html><head><style>${css}</style></head>${copy}</html>`);

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/body-modal-copy`);
  const dialogShown = () => p.evaluate(() => [...document.querySelectorAll('p')].some((x) => /company account/.test(x.textContent) && x.getClientRects().length > 0));
  assert.equal(await dialogShown(), false, 'the dialog starts closed');
  await p.getByRole('button', { name: 'Sign in' }).click();
  assert.equal(await dialogShown(), true, 'the button opens it');
  assert.equal(await p.getByRole('button', { name: 'Sign in' }).getAttribute('aria-expanded'), 'true');
  await p.getByRole('button', { name: 'Close' }).click();
  assert.equal(await dialogShown(), false, 'its × closes it');
  await p.getByRole('button', { name: 'Sign in' }).click();
  assert.equal(await dialogShown(), true);
  await p.keyboard.press('Escape');
  assert.equal(await dialogShown(), false, 'Escape closes it');
  assert.deepEqual(errors, []);
  // Without script the page is as captured: the dialog is not shown, nothing covers the page.
  await p.goto(`${base}/body-modal-nojs`);
  assert.equal(await dialogShown(), false);
  await ctx.close();
});

// A control only the tablet layout has: a "Filters" button between 601 and 1024 px (the computer shows the filters
// themselves, the phone a different drawer). The desktop and phone probes never see it, so the tablet view is probed too.
const TABLET_ONLY = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
body { margin: 0; font: 16px sans-serif } .bar { display: flex; gap: 12px; padding: 12px }
.filters { display: flex; gap: 12px } .ft { display: none; width: 120px; height: 36px }
.panel { display: none; padding: 12px; background: #eee; height: 120px } .open .panel { display: block }
@media (max-width: 1024px) and (min-width: 601px) { .filters { display: none } .ft { display: block } }
</style></head><body><div class="wrap"><div class="bar"><b>Shop</b>
<div class="filters"><label><input type="checkbox"> In stock</label><label><input type="checkbox"> On sale</label></div>
<button class="ft" type="button" aria-expanded="false">Filters</button></div>
<div class="panel"><label><input type="checkbox"> In stock</label> <label><input type="checkbox"> On sale</label></div></div>
<main><p>Products</p></main>
<script>var b = document.querySelector('.ft'), w = document.querySelector('.wrap');
b.addEventListener('click', function () { var o = w.classList.toggle('open'); b.setAttribute('aria-expanded', String(o)); });</script></body></html>`;

test('a control only the tablet layout shows opens its panel in the copy on a tablet', async () => {
  pages.set('/tablet-only', TABLET_ONLY);
  pages.set('/js/motion.js', MOTION_JS);
  const shot = async (width, height) => {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await page.goto(`${base}/tablet-only`);
    const snapshot = await page.evaluate(snapshotPage, {});
    const clicks = await captureClicks(page, { budgetMs: 10000, limit: 8 });
    await context.close();
    return { body: snapshot.body, clicks };
  };
  const desktop = await shot(1440, 900);
  const tablet = await shot(768, 1024);
  assert.ok(!desktop.clicks.widgets.some((w) => /Filters/.test(w.text ?? '')), 'the desktop probe does not see the tablet button');
  assert.ok(tablet.clicks.widgets.some((w) => w.kind === 'disclosure' && w.state), JSON.stringify(tablet.clicks.widgets.map((w) => [w.kind, w.text, Boolean(w.state)])));

  const tree = buildPageTree({ desktop: desktop.body, tablet: tablet.body });
  const site = { pages: [{ info: { path: '/tablet-only', url: `${base}/tablet-only` }, root: tree.root }], assetResolve: () => null };
  const { motion, stats } = applyMotion(site, new Map([['/tablet-only', { clicks: desktop.clicks, clicksTablet: tablet.clicks }]]));
  assert.ok(stats.widgets.tablet >= 1, JSON.stringify(stats.widgets));
  assert.ok(motion.script);
  const { rules, boxSizingReset } = buildStyles([tree], { assetFile: () => null });
  const siteCss = emitCss({ rules, breakpoints: { source: 'default' }, tokens: {}, fontFaces: [], keyframes: [], boxSizingReset, pages: [] });
  const css = `${typeof siteCss === 'string' ? siteCss : siteCss.css}\n${motionCss(motion, { tokenOf: new Map(), from: '' })}`;
  pages.set('/tablet-only-copy', `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style><script src="/js/motion.js" defer></script></head>${serialize(tree.root)}</html>`);

  const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/tablet-only-copy`);
  const panelShown = () => p.evaluate(() => {
    const panels = [...document.querySelectorAll('div')].filter((d) => d.querySelector('input') && d.getClientRects().length > 0);
    return panels.some((d) => d.getBoundingClientRect().height > 60);
  });
  assert.equal(await panelShown(), false, 'the panel starts closed');
  await p.getByRole('button', { name: 'Filters' }).first().click();
  assert.equal(await panelShown(), true, 'the tablet button opens it');
  await p.getByRole('button', { name: 'Filters' }).first().click();
  assert.equal(await panelShown(), false, 'and closes it again');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// A dialog the page already holds at the end of the body, hidden until a class on <body> shows it (a very common
// pattern): the body is the only element holding it and its button, so the open state is the stylesheet's and the copy
// toggles it there. Its × and Escape close it, as in the original.
const PAGE_MODAL = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif }
.sheet { position: fixed; inset: 0; background: rgba(0, 0, 0, .5); visibility: hidden; opacity: 0 }
body.show .sheet { visibility: visible; opacity: 1 }
.box { position: absolute; top: 80px; left: 50%; margin-left: -180px; width: 360px; height: 200px; background: #fff; padding: 24px }
.x { position: absolute; top: 8px; right: 8px; width: 32px; height: 32px }
</style></head><body><header><button id="open" type="button" aria-expanded="false">Sign in</button></header>
<main><p>Welcome</p></main>
<div class="sheet"><div class="box"><h2>Sign in</h2><p>Use your company account.</p><button class="x" type="button" aria-label="Close">×</button></div></div>
<script>
var btn = document.getElementById('open');
function set(on) { document.body.classList.toggle('show', on); btn.setAttribute('aria-expanded', String(on)); }
btn.addEventListener('click', function () { set(!document.body.classList.contains('show')); });
document.querySelector('.x').addEventListener('click', function () { set(false); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
</script></body></html>`;

test('a dialog the page already holds is opened by its button in the copy, and its × and Escape close it', async () => {
  pages.set('/page-modal', PAGE_MODAL);
  pages.set('/js/motion.js', MOTION_JS);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/page-modal`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, snapshot.body, { budgetMs: 20000 });
  await context.close();

  const dialog = clicks.widgets.find((w) => w.kind === 'dialog');
  assert.ok(dialog, `the click shows a layer over the page: ${JSON.stringify(clicks.widgets.map((w) => [w.text, w.kind]))}`);
  assert.equal(dialog.state?.root, 'body', 'the body is the only element holding the layer and its button');
  assert.ok(dialog.state.parts.length, 'its open state is read as styles');
  assert.equal(states.panels, 0, 'nothing to copy: the page holds the dialog itself');
  assert.equal(states.panelCloses, 1, 'its close control was found');
  assert.ok(dialog.closePath, JSON.stringify(dialog.closePath));

  const tree = buildPageTree({ desktop: snapshot.body });
  const site = { pages: [{ info: { path: '/page-modal', url: `${base}/page-modal` }, root: tree.root }], assetResolve: () => null };
  const { motion, stats } = applyMotion(site, new Map([['/page-modal', { clicks }]]));
  assert.ok(stats.widgets.effects >= 1, JSON.stringify(stats.widgets));
  assert.ok(tree.root.stateAttrs?.['data-w-dismiss']?.includes('esc'), 'Escape closes it, like the original');
  const find = (n, pick) => {
    if (!isElement(n)) return null;
    if (pick(n)) return n;
    for (const c of n.children) {
      const hit = find(c, pick);
      if (hit) return hit;
    }
    return null;
  };
  assert.ok(find(tree.root, (n) => n.stateAttrs && 'data-w-layer' in n.stateAttrs), 'the layer itself is marked');
  assert.ok(find(tree.root, (n) => n.stateAttrs && 'data-w-x' in n.stateAttrs), 'and its close control');

  const { rules, boxSizingReset } = buildStyles([tree], { assetFile: () => null });
  const siteCss = emitCss({ rules, breakpoints: { source: 'default' }, tokens: {}, fontFaces: [], keyframes: [], boxSizingReset, pages: [] });
  const css = `${typeof siteCss === 'string' ? siteCss : siteCss.css}\n${motionCss(motion, { tokenOf: new Map(), from: '' })}`;
  pages.set('/page-modal-copy', `<!doctype html><html><head><style>${css}</style><script src="/js/motion.js" defer></script></head>${serialize(tree.root)}</html>`);

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/page-modal-copy`);
  const shown = () => p.evaluate(() => {
    const el = [...document.querySelectorAll('p')].find((x) => /company account/.test(x.textContent));
    if (!el) return false;
    const cs = getComputedStyle(el);
    return el.getClientRects().length > 0 && cs.visibility === 'visible' && parseFloat(cs.opacity) > 0.5;
  });
  assert.equal(await shown(), false, 'the dialog starts closed');
  await p.getByRole('button', { name: 'Sign in' }).click();
  assert.equal(await shown(), true, 'the button opens it');
  await p.getByRole('button', { name: 'Close' }).click();
  assert.equal(await shown(), false, 'its × closes it');
  await p.getByRole('button', { name: 'Sign in' }).click();
  assert.equal(await shown(), true);
  await p.keyboard.press('Escape');
  assert.equal(await shown(), false, 'Escape closes it');
  assert.deepEqual(errors, []);
  await ctx.close();
});
