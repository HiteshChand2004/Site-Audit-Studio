// Repeated blocks are probed one by one. A row of cards that a script lifts when the mouse arrives - no link, no
// pointer cursor, no transition, no inline style until the hover - sits in a parent that carries the only sign of
// motion (will-change). Probing just the parent put the mouse on the middle card and recorded "hover the row: the
// middle card lifts", so the copy lifted that one card whatever card was hovered. Each card must have its own effect,
// the parent none of theirs, and the check must say so when a copy moves the wrong card.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { captureInteractions } from '../src/recreate/capture/interactions.js';
import { hoverDifferences } from '../src/reaudit/motion.js';

const PORT = 4222;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 16px/1.4 Arial, sans-serif; background: #111; color: #eee; }
  .row { display: flex; gap: 12px; padding: 40px; will-change: transform; }
  .card { flex: 1; padding: 20px; background: #222; border-radius: 12px; }
</style></head><body>
<div class="row">
  <div class="card c1"><b>Design</b><p>Clear visual systems.</p></div>
  <div class="card c2"><b>Build</b><p>Polished and precise.</p></div>
  <div class="card c3"><b>Launch</b><p>Ready for the world.</p></div>
</div>
<p class="note">A paragraph that is not a card.</p>
<script>
  for (const card of document.querySelectorAll('.card')) {
    card.addEventListener('mouseenter', () => { card.style.transform = 'scale(1.1) translateY(-6px)'; card.style.boxShadow = 'rgb(124, 92, 255) 0px 0px 0px 1px'; });
    card.addEventListener('mouseleave', () => { card.style.transform = ''; card.style.boxShadow = 'rgba(124, 92, 255, 0) 0px 0px 0px 0px'; });
  }
</script></body></html>`;

let server;
let browser;
let found;
before(async () => {
  server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  found = await captureInteractions(page, { budgetMs: 8000 });
  await context.close();
});
after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
});

test('each card is probed on its own and lifts itself, with its outline', () => {
  const cards = found.hover.filter((h) => /^(Design|Build|Launch)/.test(h.text ?? ''));
  assert.deepEqual(cards.map((h) => h.text.split(' ')[0]), ['Design', 'Build', 'Launch'], JSON.stringify(found.hover.map((h) => [h.path, h.text])));
  for (const h of cards) {
    assert.equal(h.changes.transform?.[1], 'matrix(1.1, 0, 0, 1.1, 0, -6.6)', h.text);
    assert.equal(h.changes['box-shadow']?.[1], 'rgb(124, 92, 255) 0px 0px 0px 1px', h.text);
    assert.ok(h.reasons.includes('item'), 'found as a repeated block, nothing else announces it');
  }
});

test('the row is not credited with what the card under the mouse does', () => {
  const row = found.hover.find((h) => h.path === 'body>div:1');
  assert.ok(!row?.kids?.some((k) => k.changes.transform), JSON.stringify(row));
  assert.ok(found.stats.handedToItems >= 1 || !row, 'the middle card\'s lift was handed to the card');
  assert.ok(!found.hover.some((h) => /not a card/.test(h.text ?? '')), 'an element that is not a repeated block is not probed for it');
});

test('the check flags a copy whose hover moves the wrong card', () => {
  const was = { tag: 'div', text: 'Design', changes: { transform: ['none', 'matrix(1.1, 0, 0, 1.1, 0, -6)'] }, transition: { duration: '0s' } };
  const wrong = { tag: 'div', text: 'Design', changes: {}, sibs: [{ rel: 'next', changes: { transform: ['none', 'matrix(1.1, 0, 0, 1.1, 0, -6)'] } }], transition: { duration: '0s' } };
  assert.deepEqual(hoverDifferences(was, wrong), ['transform does not change', 'also changes its next sibling\'s transform (the original does not)']);
  assert.deepEqual(hoverDifferences(was, { ...was }), []);
});
