// Click widgets (step 2 of the "as is" fixes): a panel a click opens (accordion answer) is captured as its open state
// (capture/clicks.js readRegion / regionDiff), turned into tokens + CSS (ir/motion.js, emit/motionCss.js) and toggled by the
// fixed js/motion.js. Real browser: the original page is a small accordion driven by its own script.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { captureClicks, commonPath, regionDiff } from '../src/recreate/capture/clicks.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { captureStates, planSets } from '../src/recreate/capture/states.js';
import { captureNotices } from '../src/recreate/capture/notices.js';
import { motionCss } from '../src/recreate/emit/motionCss.js';
import { MOTION_JS } from '../src/recreate/emit/motionScript.js';
import { applyMotion, openDecls } from '../src/recreate/ir/motion.js';
import { buildPageTree, isElement } from '../src/recreate/ir/tree.js';

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
