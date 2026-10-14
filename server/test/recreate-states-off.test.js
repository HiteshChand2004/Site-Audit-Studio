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
