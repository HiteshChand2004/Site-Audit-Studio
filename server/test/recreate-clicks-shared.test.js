// Shared parts clicked once per job (capture/clicks.js captureClicks `shared`): a part an earlier page had exactly (same
// markup, same drawn styles) is not clicked again, its controls' results are taken over at this page's paths, and they are
// the very results clicking it again gives. Anything different, or a result reaching outside the part, is clicked as before.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { captureClicks, rebaseEntry, shareable, shareClicksEnabled } from '../src/recreate/capture/clicks.js';
import { startSiteServer } from '../src/recreate/verify/server.js';

const STYLE = `<style>
  body { margin: 0; font: 16px sans-serif; }
  header { position: sticky; top: 0; display: flex; gap: 16px; padding: 12px; background: #fff; }
  .menu { display: none; position: absolute; top: 44px; background: #eee; padding: 8px; }
  .menu.open { display: block; }
  .answer { display: none; }
  .open + .answer { display: block; }
  .active { font-weight: 700; }
  dialog-box { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); }
  dialog-box.open { display: block; }
  section { padding: 40px 12px; }
</style>`;
const header = (active = '') => `<header>
  <button type="button" id="products" aria-expanded="false">Products</button>
  <div class="menu" id="menu"><a href="/a.html">Product A</a></div>
  <a href="/b.html" class="${active}">About</a>
  <button type="button" id="contact">Contact us</button>
</header>`;
const SCRIPT = `<script>
  const p = document.getElementById('products');
  p.addEventListener('click', () => { const m = document.getElementById('menu'); m.classList.toggle('open'); p.setAttribute('aria-expanded', m.classList.contains('open')); });
  document.getElementById('contact').addEventListener('click', () => document.querySelector('dialog-box').classList.toggle('open'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelector('dialog-box').classList.remove('open'); });
  for (const q of document.querySelectorAll('.q')) q.addEventListener('click', () => { q.classList.toggle('open'); q.setAttribute('aria-expanded', q.classList.contains('open')); });
</script>`;
const faq = (items) => `<section>${items.map((t) => `<button type="button" class="q" aria-expanded="false">${t}</button><div class="answer">Answer to ${t}</div>`).join('')}</section>`;
const page = ({ before = '', active = '', items }) => `<!doctype html><html><head>${STYLE}</head><body>${before}${header(active)}<main>${faq(items)}</main><dialog-box></dialog-box>${SCRIPT}</body></html>`;

let dir;
let site;
let browser;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-clicks-shared-'));
  await writeFile(path.join(dir, 'a.html'), page({ items: ['Is it fast?', 'Is it safe?'] }));
  await writeFile(path.join(dir, 'b.html'), page({ items: ['Who are you?', 'Where are you?'] }));
  // The same header one place further down the body (a banner before it).
  await writeFile(path.join(dir, 'c.html'), page({ before: '<div class="banner">Sale</div>', items: ['When?'] }));
  // A header that differs by one class (the current page's link marked).
  await writeFile(path.join(dir, 'd.html'), page({ active: 'active', items: ['Why?'] }));
  site = await startSiteServer(dir);
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function clicks(file, shared) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto(`${site.origin}/${file}`, { waitUntil: 'load' });
    return await captureClicks(page, { budgetMs: 60000, shared });
  } finally {
    await context.close();
  }
}
const inHeader = (out) => out.widgets.filter((w) => w.trigger.includes('>header:'));
const sameish = (w) => JSON.parse(JSON.stringify(w));
// Without where the boxes were on the screen: a taken-over result keeps the earlier page's reading of it (the same sizes; only
// sizes and distances within one result are used by the copy, never a place on the screen).
const sizesOnly = (w) => JSON.parse(JSON.stringify(w, (k, v) => (k === 'rect' && Array.isArray(v) ? v.slice(2) : v)));

test('the same header on the next page is taken over, with the very results clicking it again gives; the page\'s own FAQ is still clicked', async () => {
  const shared = new Map();
  const first = await clicks('a.html', shared);
  assert.equal(first.stats.reused, 0);
  const products = inHeader(first).find((w) => w.text === 'Products');
  assert.equal(products?.kind, 'disclosure', 'the dropdown is found on the first page');

  const second = await clicks('b.html', shared);
  const alone = await clicks('b.html', null);
  // Products (a dropdown inside the header) and About (a link) are taken over; "Contact us" opens a layer at the end of the
  // body, outside the header, so it is clicked again on every page.
  assert.equal(second.stats.reused, 2);
  assert.ok(second.stats.probed < alone.stats.probed, 'fewer clicks');
  assert.ok(second.probedNames.includes('Contact us'));
  assert.ok(!second.probedNames.includes('Products'));
  // The same widgets as when every control is clicked, header and FAQ alike.
  const byTrigger = (out) => Object.fromEntries(out.widgets.map((w) => [w.trigger, sameish(w)]));
  assert.deepEqual(byTrigger(second), byTrigger(alone));
  assert.ok(second.widgets.some((w) => w.text === 'Who are you?' && w.kind === 'disclosure'), 'the page\'s own FAQ is clicked');
});

test('the same header elsewhere in the body is taken over at this page\'s paths; a header that differs at all is clicked again', async () => {
  const shared = new Map();
  await clicks('a.html', shared);
  const moved = await clicks('c.html', shared);
  const alone = await clicks('c.html', null);
  assert.equal(moved.stats.reused, 2);
  const products = inHeader(moved).find((w) => w.text === 'Products');
  assert.match(products.trigger, /^body>header:1>/, 'the trigger at the header\'s place on this page');
  assert.ok(products.targets.every((p) => p.startsWith('body>header:1>')));
  assert.deepEqual(sizesOnly(products), sizesOnly(inHeader(alone).find((w) => w.text === 'Products')));

  const marked = await clicks('d.html', shared);
  assert.equal(marked.stats.reused, 0, 'one class differs: its own part');
  assert.ok(marked.probedNames.includes('Products'));
});

test('no record: every control is clicked, as before', async () => {
  const out = await clicks('b.html', null);
  assert.equal(out.stats.reused, 0);
  assert.ok(out.probedNames.includes('Products'));
});

test('rebaseEntry and shareable: paths move with the part; a result outside the part is never kept', () => {
  const entry = { kind: 'disclosure', trigger: 'body>header:0>button:0', targets: ['body>header:0>div:0'], text: 'body text', group: { paths: ['x'] },
    change: { shown: [{ path: 'body>header:0>div:0', rect: [0, 0, 1, 1] }], hidden: [], added: [], attrs: [{ path: 'body>header:0>button:0', from: 'false', to: 'true' }], moved: [] },
    state: { root: 'body>header:0', parts: [{ rel: '', changes: {} }] } };
  const moved = rebaseEntry(entry, 'body>header:0', 'body>header:1');
  assert.equal(moved.trigger, 'body>header:1>button:0');
  assert.deepEqual(moved.targets, ['body>header:1>div:0']);
  assert.equal(moved.change.attrs[0].path, 'body>header:1>button:0');
  assert.equal(moved.state.root, 'body>header:1');
  assert.equal(moved.text, 'body text');
  assert.equal(moved.group, undefined, 'the group is this page\'s own');
  assert.equal(entry.trigger, 'body>header:0>button:0', 'the kept entry is not changed');
  // `body>header:10` is not inside `body>header:1`.
  assert.equal(rebaseEntry({ t: 'body>header:10>a:0' }, 'body>header:1', 'body>header:2').t, 'body>header:10>a:0');

  assert.equal(shareable({ entries: [entry] }, 'body>header:0'), true);
  assert.equal(shareable({ entries: [] }, 'body>header:0'), true, 'nothing happened: kept');
  assert.equal(shareable({ entries: [{ ...entry, targets: ['body>dialog-box:0'] }] }, 'body>header:0'), false);
  assert.equal(shareable({ entries: [entry] }, null), false);
  assert.equal(shareClicksEnabled({}), true);
  assert.equal(shareClicksEnabled({ SAS_SHARE_CLICKS: '0' }), false);
});
