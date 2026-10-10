// Exact mode, phase A2: the one loading recipe both sides use, and the freeze that makes two loads of a moving page
// end in the same state. Driven against a real browser and a page that moves in every way that matters: a CSS loop,
// a Web Animations loop, a carousel on setInterval, a timer that changes the page later, and a one-shot entrance.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { settleExact, RECIPE_VERSION, SCROLL_STEP_PX } from '../src/recreate/verify/exact/recipe.js';
import { freezePage, freezeTimers, frozenSummary } from '../src/recreate/verify/exact/freeze.js';
import { slotFor } from '../src/recreate/verify/exact/slots.js';

const PORT = 4203;
const origin = `http://127.0.0.1:${PORT}`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Moving page</title><style>
  body { margin: 0; font: 16px system-ui; }
  a.logo { display: block; width: 120px; }
  a.logo:hover { color: rgb(1, 2, 3); }
  @keyframes march { from { transform: translateX(0px); } to { transform: translateX(-200px); } }
  .marquee { animation: march 2s linear infinite; width: 400px; }
  @keyframes rise { from { opacity: 0; } to { opacity: 1; } }
  .entrance { animation: rise 600ms ease forwards; }
  .tall { height: 3000px; background: linear-gradient(#fff, #eee); }
  .below { height: 200px; }
</style></head><body>
  <a class="logo" href="#">Logo</a>
  <div class="marquee">marquee</div>
  <div class="entrance">entrance</div>
  <div id="slide">Slide 1</div>
  <div class="tall"></div>
  <div class="below" id="below">below the fold</div>
<script>
  var i = 1;
  setInterval(function carousel() { i++; document.getElementById('slide').textContent = 'Slide ' + i; }, 300);
  setTimeout(function late() { document.body.setAttribute('data-late', 'yes'); }, 1500);
  document.querySelector('.marquee').animate(
    [{ filter: 'blur(0px)' }, { filter: 'blur(4px)' }],
    { duration: 1000, iterations: Infinity },
  );
</script></body></html>`;

let server;
let browser;
const slot = slotFor(1280);

before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  server.close();
});

/** One visit, exactly as either side of the comparison makes it. */
async function visit({ freeze = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: slot.width, height: slot.height },
    deviceScaleFactor: slot.dpr,
    isMobile: slot.mobile,
    hasTouch: slot.hasTouch,
    serviceWorkers: 'block',
  });
  try {
    if (freeze) await context.addInitScript(freezeTimers);
    const page = await context.newPage();
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    const settled = await settleExact(page, slot);
    const frozen = freeze ? await freezePage(page) : null;
    const state = await page.evaluate(() => ({
      slide: document.getElementById('slide').textContent,
      marquee: getComputedStyle(document.querySelector('.marquee')).transform,
      blur: getComputedStyle(document.querySelector('.marquee')).filter,
      entrance: getComputedStyle(document.querySelector('.entrance')).opacity,
      late: document.body.getAttribute('data-late'),
      scrollY: Math.round(window.scrollY),
      // The lazy content below a 3000 px filler proves the scroll-through really went down the page.
      belowSeen: document.getElementById('below').getBoundingClientRect().top < 1e6,
    }));
    return { settled, frozen, state };
  } finally {
    await context.close().catch(() => {});
  }
}

test('the recipe scrolls the whole page, comes back to the top and reports what it did', async () => {
  const { settled } = await visit();
  assert.equal(settled.version, RECIPE_VERSION);
  assert.equal(settled.fonts, true, 'it waited for the fonts');
  assert.ok(settled.steps > 5, `it stepped down the page (${settled.steps} steps of ${SCROLL_STEP_PX}px)`);
  assert.equal(settled.reachedBottom, true);
  assert.equal(settled.stoppedBy, null, 'nothing cut it short');
  assert.ok(settled.height > 3000, `the page height is reported (${settled.height})`);
  assert.ok(settled.scrollWidth >= slot.width);
  assert.ok(settled.ms > 0);
});

test('the mouse ends at the corner, and the page says what is there', async () => {
  const { settled, state } = await visit();
  assert.equal(state.scrollY, 0, 'back at the top');
  assert.equal(settled.origin.tag, 'a');
  assert.equal(settled.origin.text, 'Logo');
  // The corner is a link with a hover of its own: worth knowing, because the mouse rests there in every shot.
  assert.equal(settled.origin.hover, true);
});

test('the freeze puts a moving page at its start, the same way every time', async () => {
  const first = await visit();
  const second = await visit();

  // The one phase both sides can agree on is zero: the carousel never advanced past its first slide.
  assert.equal(first.state.slide, 'Slide 1');
  assert.equal(second.state.slide, 'Slide 1');
  // A timer that would have changed the page a second and a half in never fired.
  assert.equal(first.state.late, null);
  // The repeating animations sit at their 0% values: no translate, no blur.
  assert.equal(first.state.marquee, 'matrix(1, 0, 0, 1, 0, 0)');
  assert.equal(first.state.blur, 'blur(0px)');
  // The entrance runs once, so its end state *is* the resting look.
  assert.equal(first.state.entrance, '1');

  // Determinism is the point: two loads of the same moving page agree on everything measured.
  assert.deepEqual(first.state, second.state, 'two visits end in the same state');
});

test('what was stopped is counted, not implied', async () => {
  const { frozen } = await visit();
  assert.equal(frozen.timers.intervals >= 1, true, 'the carousel interval was suppressed');
  assert.equal(frozen.timers.timeouts >= 1, true, 'the slow timer was suppressed');
  assert.ok(frozen.timers.notes.some((n) => n.includes('interval') && n.includes('carousel')), JSON.stringify(frozen.timers.notes));
  // Two repeating animations (the CSS marquee and the Web Animations blur) were put at the start; the entrance was
  // finished instead.
  assert.ok(frozen.animations.zeroed >= 2, `zeroed ${frozen.animations.zeroed}`);
  assert.ok(frozen.animations.finished >= 1, `finished ${frozen.animations.finished}`);
  assert.equal(frozen.animations.failed, 0);
  const marquee = frozen.animations.items.find((i) => i.name === 'march');
  assert.equal(marquee.action, 'zeroed');
  assert.equal(marquee.iterations, 'infinite');
  assert.equal(frozen.animations.items.find((i) => i.name === 'rise').action, 'finished');
});

test('without the freeze the same page is a different page each time, which is why the freeze exists', async () => {
  const { state } = await visit({ freeze: false });
  // 300 ms per slide over the recipe's 4 s wait and its scroll-through: it is long past slide 1.
  assert.notEqual(state.slide, 'Slide 1');
  assert.equal(state.late, 'yes', 'and the slow timer did change the page');
});

test('frozenSummary names what moved on one side only', () => {
  const original = { timers: { intervals: 2, timeouts: 1, notes: [] }, animations: { zeroed: 3, finished: 1, scrollLinked: 1, items: [{ name: 'march' }] } };
  const copy = { timers: { intervals: 0, timeouts: 0, notes: [] }, animations: { zeroed: 1, finished: 1, scrollLinked: 0, items: [] } };
  const s = frozenSummary(original, copy);
  assert.equal(s.loopsOnlyOriginal, 2, 'two loops the copy does not have');
  assert.equal(s.loopsOnlyCopy, 0);
  assert.equal(s.timersOnlyOriginal, 3);
  assert.equal(s.original.scrollLinked, 1);
  assert.deepEqual(s.items.original, [{ name: 'march' }]);
  // A side that was never frozen says so rather than looking still.
  assert.equal(frozenSummary(null, null).original.timers, 0);
});
