// The motion the re-check measures on a copy (capture/measure.js measureMotion) is read after the same scroll-through the
// capture did on the original: down to SCROLL_CAP, not 8000 px. On interlister the copy is 21 373 px tall and its FAQ starts at
// 19 188 px; its list appears only once scrolled into view. Read after an 8000 px scroll it was still hidden, so the click probe
// found none of its questions ("None could be checked on the recreated site"), while the original's capture had found all three.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { measureMotion } from '../src/recreate/capture/measure.js';
import { SCROLL_CAP } from '../src/recreate/capture/index.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tall page</title>
<style>body{margin:0;font:18px sans-serif}.spacer{height:18000px;background:linear-gradient(#fff,#eef)}
[data-reveal]{opacity:0;visibility:hidden;transition:opacity .3s}[data-reveal].in{opacity:1;visibility:visible}</style></head>
<body><div class="spacer"></div><section id="faq"><h2>Questions</h2><div data-reveal>
<details><summary>What is it?</summary><p>A tool.</p></details>
<details><summary>Who is it for?</summary><p>Builders.</p></details>
<details><summary>How much is it?</summary><p>Free.</p></details></div></section><footer style="height:600px">End</footer>
<script>new IntersectionObserver((es, o) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); o.unobserve(e.target); } }))
.observe(document.querySelector('[data-reveal]'));</script></body></html>`;

let server;
let url;
let browser;
before(async () => {
  server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

const questions = (m) => (m.clicks?.widgets ?? []).filter((w) => w.tag === 'summary').map((w) => w.text).sort();

test('a FAQ that appears only once scrolled to, below 8000 px, is reached: its questions are probed like on the original', { timeout: 180000 }, async () => {
  assert.ok(SCROLL_CAP > 18000, 'the capture scrolls past 8000 px');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(url, { waitUntil: 'load' });
    const m = await measureMotion(page, { focus: false, budgetMs: 2000, clickBudgetMs: 20000 });
    assert.deepEqual(questions(m), ['How much is it?', 'What is it?', 'Who is it for?'], JSON.stringify(m.clicks?.stats));
  } finally {
    await page.close();
  }
});

test('the old 8000 px scroll leaves it hidden (what the re-check read before)', { timeout: 180000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(url, { waitUntil: 'load' });
    const m = await measureMotion(page, { focus: false, budgetMs: 2000, clickBudgetMs: 20000, cap: 8000 });
    assert.deepEqual(questions(m), []);
  } finally {
    await page.close();
  }
});
