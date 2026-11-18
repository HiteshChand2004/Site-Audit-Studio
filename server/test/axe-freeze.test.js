// The axe step reads a page frozen the same way on both sides (audit/render.js renderHome): a pulsing badge is read at its
// start, not at whatever moment the scan lands on, so a pulse caught dim on one side is not a contrast regression; a real
// contrast problem is still found. The page below holds a badge that is dim for almost its whole (very long) pulse, so an
// unfrozen scan always catches it dim, and a static grey-on-grey line that fails whatever the freeze does.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser, renderHome, settleNewAnimations, waitTextStill, TEXT_STILL_MAX_MS } from '../src/audit/render.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pulse</title>
<style>
  body { background: #0c2b1f; color: #f0fdf4; font: 16px/1.5 sans-serif; margin: 0; padding: 40px; }
  .mk-pulse { display: inline-block; padding: 2px 8px; color: #a7f3d0; animation: mk-pulse 1000s linear infinite; }
  @keyframes mk-pulse { 0% { opacity: 1 } 0.01% { opacity: .05 } 99.99% { opacity: .05 } 100% { opacity: 1 } }
  .faint { color: #1a3d2f; }
</style></head><body>
<main><h1>Gardening made simple</h1>
<p><span class="mk-pulse">Live now</span></p>
<p class="faint">This line is hard to read on every visit.</p></main>
</body></html>`;

// A grey line that passes at full strength (#595959 on white, 7:1) and that a script fades in frame by frame - no Web
// Animation, as Framer's runtime does it - every time the page scrolls, over 2.5 s. The scan scrolls the page first, so it
// used to read the line half-faded (low contrast). /ticker: a line whose opacity a script changes forever.
const fader = (forever) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fade</title>
<style>
  body { background: #fff; color: #111; font: 16px/1.5 sans-serif; margin: 0; padding: 40px; }
  .grey { color: #595959; }
  .tall { height: 3000px; }
</style></head><body>
<main><h1>Plain words</h1>
<p class="grey" id="line">This grey line is easy to read once it is shown.</p>
<div class="tall"></div></main>
<script>
  var line = document.getElementById('line');
  var start = 0;
  function frame(now) {
    var t = ${forever ? '((now / 400) % 1)' : 'Math.min(1, Math.max(0, (now - start) / 2500))'};
    line.style.opacity = String(0.2 + 0.8 * t);
    if (${forever ? 'true' : 't < 1'}) requestAnimationFrame(frame);
  }
  addEventListener('scroll', function () { start = performance.now(); requestAnimationFrame(frame); });
</script></body></html>`;

let server;
let browser;

before(async () => {
  server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const body = p === '/' ? PAGE : p === '/fade' ? fader(false) : p === '/ticker' ? fader(true) : null;
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

const url = () => `http://localhost:${server.address().port}/`;
const contrastTargets = (render) => (render.axe?.violations ?? [])
  .filter((v) => v.id === 'color-contrast')
  .flatMap((v) => v.nodes.map((n) => `${n.target.join(' ')} ${n.html}`));

test('axe step: a pulsing badge is read at rest (no false contrast finding), a real contrast problem is still caught', async () => {
  // Unfrozen, the scan lands on the dim part of the pulse: the false finding this freeze exists to remove.
  const loose = await renderHome(browser, url(), { freezeForAxe: false });
  assert.ok(contrastTargets(loose).some((t) => t.includes('mk-pulse')), `unfrozen scan should catch the dim badge: ${contrastTargets(loose)}`);

  // Frozen (the default, both sides): the badge passes, the faint line still fails.
  const frozen = await renderHome(browser, url());
  const targets = contrastTargets(frozen);
  assert.ok(!targets.some((t) => t.includes('mk-pulse')), `badge read at rest: ${targets}`);
  assert.ok(targets.some((t) => t.includes('faint')), `real contrast problem caught: ${targets}`);

  // Twice the same page, frozen: the same verdict both times (the two sides of a re-check agree).
  const again = await renderHome(browser, url());
  assert.deepEqual(contrastTargets(again).sort(), targets.sort());
});

test('axe step: text a script is still fading in is read once it holds still, not half-faded', async () => {
  // Without the wait (freezeForAxe off: the scan as it was), the line is caught on its way in.
  const loose = await renderHome(browser, `${url()}fade`, { freezeForAxe: false });
  assert.ok(contrastTargets(loose).some((t) => t.includes('line')), `the scan without the wait should catch the half-faded line: ${contrastTargets(loose)}`);
  const settled = await renderHome(browser, `${url()}fade`);
  assert.ok(!contrastTargets(settled).some((t) => t.includes('line')), `the line is read at full strength: ${contrastTargets(settled)}`);
});

test('axe step: a row a feed puts in while the scan runs is read shown, not half-faded; a spinner keeps turning', async () => {
  // flexibench: the hero feed adds a row every 2.4 s whose fade-in axe caught half-way (#c9c9c9 on white). After
  // settleNewAnimations, a row put in (also one still waiting out its delay) shows at once; an endless animation runs on.
  const page = await browser.newPage();
  await page.setContent(`<style>
    @keyframes row-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes spin { to { transform: rotate(360deg) } }
    .row { color: #595959; animation: row-in 2s ease-out both; }
    .late { animation-delay: 1s; }
    .spin { width: 10px; height: 10px; animation: spin 1s linear infinite; }
  </style><main id="feed"></main>`);
  await page.evaluate(settleNewAnimations);
  await page.evaluate(() => {
    const feed = document.getElementById('feed');
    feed.insertAdjacentHTML('beforeend', '<p class="row" id="r1">New row</p><p class="row late" id="r2">Later row</p><div class="spin" id="s"></div>');
  });
  await page.waitForTimeout(200);
  const read = await page.evaluate(() => ({
    r1: getComputedStyle(document.getElementById('r1')).opacity,
    r2: getComputedStyle(document.getElementById('r2')).opacity,
    spin: document.getElementById('s').getAnimations().map((a) => a.playState),
  }));
  await page.close();
  assert.equal(read.r1, '1', 'the new row is shown at once');
  assert.equal(read.r2, '1', 'a row waiting out its delay too');
  assert.deepEqual(read.spin, ['running'], 'the spinner keeps turning');
});

test('axe step: text that never holds still is scanned after at most the cap', async () => {
  const t0 = Date.now();
  const loose = await renderHome(browser, `${url()}ticker`, { freezeForAxe: false });
  const before = Date.now() - t0;
  const t1 = Date.now();
  const capped = await renderHome(browser, `${url()}ticker`);
  const withWait = Date.now() - t1;
  assert.ok(capped.axe, `the page is scanned (${capped.axeError})`);
  assert.ok(withWait - before < TEXT_STILL_MAX_MS + 2500, `the wait stays within its cap: ${before} ms without it, ${withWait} ms with it`);
  // The wait on its own, measured directly: it gives up at the cap and says so.
  const page = await browser.newPage();
  await page.goto(`${url()}ticker`);
  await page.mouse.wheel(0, 200);
  const r = await waitTextStill(page);
  await page.close();
  assert.equal(r.still, false);
  assert.ok(r.waitedMs >= TEXT_STILL_MAX_MS && r.waitedMs < TEXT_STILL_MAX_MS + 1000, `waited ${r.waitedMs} ms`);
});
