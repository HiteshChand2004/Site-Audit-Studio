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

// A hover rule whose selector holds an attribute selector: `~=` and a quoted space are not combinators. Read as one,
// the element holding the state came out as `="card"]` and the rule was left to the slow mouse probe as "invalid".
test('hover rules with attribute selectors are read from the stylesheet, not dropped as invalid', async () => {
  const html = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif }
[data-kind~="card"]:hover { background-color: rgb(1, 2, 3) }
a[aria-label="Open menu"]:hover { color: rgb(4, 5, 6) }
[data-state=open] > button:hover { color: rgb(7, 8, 9) }
</style></head><body>
<div data-kind="card big">Card</div><a href="#" aria-label="Open menu">Menu</a>
<div data-state="open"><button type="button">Close</button></div>
</body></html>`;
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(html);
  const found = await captureInteractions(page, { budgetMs: 4000 });
  await page.close();
  const by = (tag) => found.hover.find((h) => h.tag === tag && h.source === 'css');
  assert.equal(found.stats.fromRules.unsupportedBy.invalid, 0, JSON.stringify(found.stats.fromRules));
  assert.deepEqual(by('div')?.changes?.['background-color']?.[1], 'rgb(1, 2, 3)');
  assert.deepEqual(by('a')?.changes?.color?.[1], 'rgb(4, 5, 6)');
  assert.deepEqual(by('button')?.changes?.color?.[1], 'rgb(7, 8, 9)');
});

// A site's own `transition: … !important` with more specificity than a bare `*` kept running while a rule was forced, so
// the probe read the value from the start of the change (flexibench: a button's "hover" colour was its rest colour).
test('a forced hover rule is read at its end value even when the site keeps its transition with !important', async () => {
  const html = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif }
.cta.big { background-color: rgb(10, 10, 10); transition: background-color 0.8s ease !important }
.cta.big:hover { background-color: rgb(26, 26, 255) }
</style></head><body><a class="cta big" href="#">Schedule</a></body></html>`;
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(html);
  const found = await captureInteractions(page, { budgetMs: 4000 });
  await page.close();
  const css = found.hover.find((h) => h.tag === 'a' && h.source === 'css');
  assert.deepEqual(css?.changes?.['background-color'], ['rgb(10, 10, 10)', 'rgb(26, 26, 255)'], JSON.stringify(found.hover));
});
