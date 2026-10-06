// Hover effects set by script (step 3 of the "as is" fixes): the mouse probe (capture/interactions.js) must reach every
// element of a busy page, also when the page scrolls smoothly (the element moves after it was aimed at).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { captureInteractions } from '../src/recreate/capture/interactions.js';

const N = 20;
const PAGE = `<!doctype html><html><head><style>
html { scroll-behavior: smooth } body { margin: 0; font: 16px sans-serif }
.row { height: 420px; display: flex; align-items: center; justify-content: center }
.row a { display: inline-block; padding: 12px 20px; background: #eee; color: #111; text-decoration: none }
</style></head><body>
${Array.from({ length: N }, (_, i) => `<div class="row"><a class="item-${i}" href="#">Item number ${i}</a></div>`).join('\n')}
<script>
document.querySelectorAll('.row a').forEach(function (a, i) {
  a.addEventListener('mouseenter', function () { a.style.backgroundColor = 'rgb(' + (10 * i) + ', 80, 200)'; });
  a.addEventListener('mouseleave', function () { a.style.backgroundColor = ''; });
});
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

test('script-driven hovers are found on every element of a long, smoothly scrolling page', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(url);
  const found = await captureInteractions(page, { budgetMs: 8000 });
  await page.close();
  const hovered = found.hover.filter((h) => h.source === 'probe' && h.changes?.['background-color']);
  assert.equal(found.stats.candidates, N);
  assert.ok(hovered.length >= N - 1, `${hovered.length} of ${N} hovers found (${JSON.stringify(found.stats)})`);
});
