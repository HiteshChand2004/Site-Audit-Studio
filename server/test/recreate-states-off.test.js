// A set of states with an "off" state: an accordion / FAQ whose script renders an answer only while its question is open,
// one at a time, and closes the open one when its question is clicked again. The state probe captures one state per
// question; the "everything closed" state no question leads to by itself is found by clicking the open question once more
// (capture/states.js `off`). The copy must then open and close exactly like the original.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { captureClicks } from '../src/recreate/capture/clicks.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { captureStates } from '../src/recreate/capture/states.js';
import { MOTION_JS } from '../src/recreate/emit/motionScript.js';
import { buildPageTree, isElement } from '../src/recreate/ir/tree.js';
import { applyMotion } from '../src/recreate/ir/motion.js';

const FAQ = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; font: 16px/1.4 Arial, sans-serif } .faq { width: 600px; margin: 40px }
.item { border-bottom: 1px solid #ddd } .q { display: block; width: 100%; padding: 14px 0; border: 0; background: none; text-align: left; font: inherit; cursor: pointer }
.a { padding: 0 0 14px }
</style></head><body><section class="faq"><h2>Frequently asked</h2><div id="list"></div></section>
<script>
  var items = [['What is it?', 'A tool.'], ['How much?', 'Free.'], ['Where?', 'Online.']];
  var open = 0;
  function render() {
    var list = document.getElementById('list');
    list.innerHTML = '';
    items.forEach(function (it, i) {
      var d = document.createElement('div'); d.className = 'item';
      var b = document.createElement('button'); b.className = 'q'; b.type = 'button'; b.textContent = it[0];
      b.setAttribute('aria-expanded', String(open === i));
      b.addEventListener('click', function () { open = open === i ? -1 : i; render(); });
      d.appendChild(b);
      if (open === i) { var a = document.createElement('div'); a.className = 'a'; a.textContent = it[1]; d.appendChild(a); }
      list.appendChild(d);
    });
  }
  render();
</script></body></html>`;

const pages = new Map();
let server;
let base;
let browser;
before(async () => {
  server = http.createServer((req, res) => {
    const body = pages.get(req.url);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(body);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
  pages.set('/faq', FAQ);
  pages.set('/js/motion.js', MOTION_JS);
});
after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
});

test('the closed state of an accordion is captured, and the copy closes the open answer on a second click', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/faq`);
  const snap = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, snap.body, { budgetMs: 20000 });
  await context.close();
  assert.equal(states.sets, 1, JSON.stringify(states.skipped));
  let set = null;
  (function walk(n) {
    if (!n || !n.tag) return;
    if (n.states) set = n.states;
    (n.children ?? []).forEach(walk);
  })(snap.body);
  assert.equal(set.off, 3, `the "all closed" state comes after the three questions: ${JSON.stringify({ ...set, variants: set.variants.map((v) => v.index) })}`);

  const tree = buildPageTree({ desktop: snap.body });
  const site = { pages: [{ info: { path: '/faq', url: `${base}/faq` }, root: tree.root }], assetResolve: () => null };
  applyMotion(site, new Map([['/faq', { clicks }]]));
  const html = (n) => {
    if (!isElement(n)) return n.text.replace(/</g, '&lt;');
    const all = { ...n.attrs, ...n.stateAttrs, ...(n.motionTokens?.length && { 'data-motion': n.motionTokens.join(' ') }) };
    const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  pages.set('/faq-copy', `<!doctype html><html><head><style>[data-w-set][hidden] { display: none !important }</style><script src="/js/motion.js" defer></script></head>${html(tree.root)}</html>`);

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/faq-copy`);
  const answers = () => p.evaluate(() => [...document.querySelectorAll('[data-w-set]')].filter((s) => !s.hidden).flatMap((s) => [...s.querySelectorAll('div')].filter((d) => d.children.length === 0 && d.textContent.trim() && !/\?$/.test(d.textContent.trim())).map((d) => d.textContent.trim())));
  const click = (q) => p.locator('[data-w-set]:not([hidden]) button', { hasText: q }).first().click();
  assert.deepEqual(await answers(), ['A tool.'], 'starts like the original: the first answer open');
  await click('How much?');
  assert.deepEqual(await answers(), ['Free.'], 'one answer at a time');
  await click('How much?');
  assert.deepEqual(await answers(), [], 'the open answer closes on a second click, as in the original');
  await click('Where?');
  assert.deepEqual(await answers(), ['Online.'], 'and the others still open');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Two FAQ lists side by side (each its own accordion: one answer open at a time, a second click closes it; the second list
// starts with every answer closed). One set over both would close the first list's answer when the second is used, and
// the second list's start matches no question: each list is its own set, and a start with everything closed is that
// set's "off" state.
const col = (from) => [0, 1, 2, 3].map((i) => `<div class="item"><h3><button class="q" type="button" data-i="${from + i}" aria-expanded="false">Question ${from + i}?</button></h3><div class="a" role="region" hidden></div></div>`).join('');
const TWO = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; font: 16px/1.4 Arial, sans-serif } .faq { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin: 40px }
.item { border-bottom: 1px solid #ddd } .q { display: block; width: 100%; padding: 14px 0; border: 0; background: none; text-align: left; font: inherit; cursor: pointer }
.a { padding: 0 0 14px }
</style></head><body><h2>Questions</h2><section class="faq"><div class="c"><div class="w">${col(0)}</div></div><div class="c"><div class="w">${col(4)}</div></div></section>
<script>
  var open = [0, -1];
  function render() {
    document.querySelectorAll('.item').forEach(function (it, i) {
      var on = open[i < 4 ? 0 : 1] === i, b = it.querySelector('button'), a = it.querySelector('.a');
      b.setAttribute('aria-expanded', String(on));
      a.hidden = !on; a.textContent = on ? 'Answer ' + i + '.' : '';
    });
  }
  document.querySelectorAll('.q').forEach(function (b) { b.addEventListener('click', function () { var i = +b.dataset.i, k = i < 4 ? 0 : 1; open[k] = open[k] === i ? -1 : i; render(); }); });
  render();
</script></body></html>`;

test('two FAQ lists side by side are two sets; a list that starts closed starts in its "off" state', async () => {
  pages.set('/two', TWO);
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/two`);
  const snap = await page.evaluate(snapshotPage, {});
  const clicks = await captureClicks(page, { budgetMs: 15000 });
  const states = await captureStates(page, clicks, snap.body, { budgetMs: 30000 });
  await context.close();
  const sets = [];
  (function walk(n) {
    if (!n || !n.tag) return;
    if (n.states) sets.push(n.states);
    (n.children ?? []).forEach(walk);
  })(snap.body);
  assert.equal(states.sets, 2, JSON.stringify(states.skipped));
  assert.deepEqual(sets.map((s) => [s.initial, s.count, s.off]), [[0, 4, 4], [4, 4, 4]]);

  const tree = buildPageTree({ desktop: snap.body });
  const site = { pages: [{ info: { path: '/two', url: `${base}/two` }, root: tree.root }], assetResolve: () => null };
  applyMotion(site, new Map([['/two', { clicks }]]));
  const html = (n) => {
    if (!isElement(n)) return n.text.replace(/</g, '&lt;');
    const all = { ...n.attrs, ...n.stateAttrs, ...(n.motionTokens?.length && { 'data-motion': n.motionTokens.join(' ') }) };
    const attrs = Object.entries(all).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  pages.set('/two-copy', `<!doctype html><html><head><style>[data-w-set][hidden] { display: none !important } [hidden] { display: none }</style><script src="/js/motion.js" defer></script></head>${html(tree.root)}</html>`);
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/two-copy`);
  const answers = () => p.evaluate(() => [...document.querySelectorAll('[role=region]')].filter((a) => a.offsetParent && a.textContent.trim()).map((a) => a.textContent.trim()));
  const click = (q) => p.locator('[data-w-set]:not([hidden]) button', { hasText: q }).first().click();
  assert.deepEqual(await answers(), ['Answer 0.'], 'starts like the original');
  await click('Question 5?');
  assert.deepEqual(await answers(), ['Answer 0.', 'Answer 5.'], 'the second list does not close the first one\'s answer');
  await click('Question 5?');
  assert.deepEqual(await answers(), ['Answer 0.'], 'a second click closes it again');
  await click('Question 2?');
  assert.deepEqual(await answers(), ['Answer 2.'], 'one answer at a time within a list');
  assert.deepEqual(errors, []);
  await ctx.close();

  // The re-audit's own check: the click probe on the original and on the copy must agree that a question closes again.
  // On the copy, a click shows another copy of the list (the clicked button is hidden, its twin drawn), and the probe can
  // reach a question while another list's answer is open: neither may turn into "does not close".
  const probe = async (url) => {
    const c = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const pg = await c.newPage();
    await pg.goto(url);
    await pg.waitForTimeout(300);
    const found = await captureClicks(pg, { budgetMs: 30000 });
    await c.close();
    return Object.fromEntries(found.widgets.filter((w) => /^Question/.test(w.text ?? '')).map((w) => [w.text, w.closesOwn ?? w.closes]));
  };
  const original = await probe(`${base}/two`);
  const copied = await probe(`${base}/two-copy`);
  assert.ok(Object.keys(original).length >= 2, JSON.stringify(original));
  for (const [q, how] of Object.entries(original)) {
    assert.equal(how, 'toggle', `${q} closes on the original`);
    assert.equal(copied[q], 'toggle', `${q} closes on the copy too: ${JSON.stringify(copied)}`);
  }
});
