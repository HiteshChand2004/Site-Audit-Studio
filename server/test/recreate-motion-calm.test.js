// A part that switches state by itself (a feed, an auto-advancing set): on each step js/motion.js holds still what the
// previous state already showed, so only new elements play their entrance. It must never hold still a LOOP: on a real
// site the cards of an auto-switching section carried continuous animations, and after the first step they stood still.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../src/audit/render.js';
import { MOTION_JS } from '../src/recreate/emit/motionScript.js';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const PAGE = `<!doctype html><html><head><style>
  [data-w-set][hidden] { display: none !important; }
  @keyframes rise { from { opacity: 0; } }
  .row { animation: rise 0.4s both; }
  @keyframes m-l1 { to { transform: rotate(360deg); } }
  [data-motion~="l1"] { animation: m-l1 1s linear infinite; }
  @keyframes spin2 { to { transform: rotate(-360deg); } }
  .own { animation: spin2 2s linear infinite; }
</style></head><body>
  <div data-w-set="s1" data-w-i="0" data-w-auto="600:1" data-w-feed>
    <p class="row">Row A</p><div class="card" data-motion="l1">Card</div><div class="own">Badge</div>
  </div>
  <div data-w-set="s1" data-w-i="1" hidden>
    <p class="row">Row A</p><p class="row">Row B</p><div class="card" data-motion="l1">Card</div><div class="own">Badge</div>
  </div>
  <script>${MOTION_JS}</script>
</body></html>`;

test('after an automatic step, loops keep running while repeated entrances are held still', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(PAGE, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('[data-w-set="s1"][data-w-i="1"]:not([hidden])'), null, { timeout: 5000 });
    await page.waitForTimeout(100);
    const r = await page.evaluate(() => {
      const shown = document.querySelector('[data-w-set="s1"]:not([hidden])');
      const at = (sel) => shown.querySelector(sel);
      const named = (el) => getComputedStyle(el).animationName;
      return {
        state: shown.getAttribute('data-w-i'),
        card: named(at('.card')),
        badge: named(at('.own')),
        rowA: named([...shown.querySelectorAll('.row')].find((p) => p.textContent === 'Row A')),
        rowB: named([...shown.querySelectorAll('.row')].find((p) => p.textContent === 'Row B')),
      };
    });
    assert.equal(r.state, '1', 'the set stepped by itself');
    assert.equal(r.card, 'm-l1', 'a loop token keeps its loop after the step');
    assert.equal(r.badge, 'spin2', 'an animation of the page that repeats forever keeps running');
    assert.equal(r.rowA, 'none', 'a row the previous state already showed does not replay its entrance');
    assert.equal(r.rowB, 'rise', 'a new row plays its entrance');
  } finally {
    await page.close();
  }
});
