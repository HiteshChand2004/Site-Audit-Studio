// The axe step reads a page frozen the same way on both sides (audit/render.js renderHome): a pulsing badge is read at its
// start, not at whatever moment the scan lands on, so a pulse caught dim on one side is not a contrast regression; a real
// contrast problem is still found. The page below holds a badge that is dim for almost its whole (very long) pulse, so an
// unfrozen scan always catches it dim, and a static grey-on-grey line that fails whatever the freeze does.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser, renderHome } from '../src/audit/render.js';

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

let server;
let browser;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
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
