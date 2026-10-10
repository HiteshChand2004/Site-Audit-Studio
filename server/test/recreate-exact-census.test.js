// Exact mode, phase B3: the denominator. A page with far more controls than any probe will examine, so the census
// has to disagree with the probes' own "candidates" - which is the whole reason it exists.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { censusInteractive, coverageOf } from '../src/recreate/capture/census.js';

const PORT = 4211;

const many = (n, html) => Array.from({ length: n }, (_, i) => html(i)).join('\n');
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Many</title><style>
  body { margin: 0; font: 16px/1.5 system-ui; }
  .card { cursor: pointer; padding: 4px; }
  .card .inner { cursor: pointer; }
  .away { display: none; }
</style></head><body>
  ${many(60, (i) => `<button type="button">Button ${i}</button>`)}
  ${many(40, (i) => `<a href="/page-${i}">Link ${i}</a>`)}
  ${many(10, (i) => `<a href="#anchor-${i}">Anchor ${i}</a>`)}
  ${many(12, (i) => `<input type="text" name="f${i}" placeholder="Field ${i}">`)}
  ${many(8, (i) => `<details><summary>More ${i}</summary><p>Body ${i}</p></details>`)}
  ${many(6, (i) => `<div role="tab" tabindex="0">Tab ${i}</div>`)}
  ${many(5, (i) => `<div class="card">Card ${i}<span class="inner">inner</span></div>`)}
  ${many(7, (i) => `<button type="button" class="away">Hidden ${i}</button>`)}
  <label for="f0">A label</label>
  <div role="switch" aria-checked="false">Switch</div>
  <div aria-expanded="false" id="disc">Disclosure</div>
</body></html>`;

let server;
let browser;
let census;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  census = await page.evaluate(censusInteractive, {});
  await context.close();
});

after(async () => {
  await browser?.close().catch(() => {});
  server.close();
});

test('everything a visitor can act on is counted, by kind, with nothing filtered out', () => {
  assert.equal(census.byKind.button, 60 + 7, 'the hidden ones are buttons too');
  assert.equal(census.byKind.link, 40);
  assert.equal(census.byKind['anchor-link'], 10);
  assert.equal(census.byKind.field, 12);
  // Eight <details>, their eight <summary> elements and the one aria-expanded div are all disclosures; the role=tab
  // elements carry tabindex but are counted as tabs, under the first kind that describes them.
  assert.equal(census.byKind.disclosure, 17);
  assert.equal(census.byKind.tab, 6);
  assert.equal(census.byKind.switch, 1);
  assert.equal(census.byKind.labelled, 1);
  // The kinds add up to the total: an element is counted once, under the first kind that describes it.
  const sum = Object.values(census.byKind).reduce((a, b) => a + b, 0);
  assert.equal(sum, census.total);
  assert.ok(census.total > 140, `counted ${census.total}`);
});

test('a card dressed as clickable counts, and its insides do not count again', () => {
  // Five cards, each with an inner span that also has cursor: pointer.
  assert.equal(census.byKind.pointer, 5, JSON.stringify(census.byKind));
});

test('what is not shown at this size is counted apart, not left out', () => {
  assert.equal(census.hidden.button, 7);
  assert.equal(census.total - census.visible, 7, 'the seven hidden buttons are the only hidden controls');
});

test('coverage is the probes own numbers over that denominator, with the gap explained', () => {
  // What a probe of this page really reports: it stops at its budget long before 150 controls.
  const motion = {
    hover: 3,
    focus: 1,
    probed: 30,
    clicks: { probed: 20, found: 6, timedOut: true, skipped: { limit: 85, duplicate: 12, hidden: 7, inside: 5 } },
  };
  const c = coverageOf(census, motion);
  assert.equal(c.interactive, census.total);
  assert.equal(c.visible, census.visible);
  assert.equal(c.probed, 50, 'the two probes together');
  assert.equal(c.understood, 10, 'hover + focus + what clicking found');
  assert.ok(c.examined < 50, `${c.examined}% of what a visitor can see - and that is the honest number`);
  // Every reason comes from a counter the capture recorded.
  assert.equal(c.reasons['budget reached'], 85);
  assert.equal(c.reasons['the same kind of control, already probed'], 12);
  assert.equal(c.reasons['not shown at this size'], 7);
  assert.equal(c.reasons['inside another control'], 5);
  assert.equal(c.reasons['the probe ran out of time'], 1);
});

test('the census disagrees with the probes own "candidates", which is why it exists', () => {
  // A probe that examined 40 of its own 40 candidates would read as complete; against the real denominator it is not.
  const motion = { probed: 40, clicks: { probed: 0, found: 40, skipped: { limit: 0 } } };
  const c = coverageOf(census, motion);
  assert.ok(c.examined < 100, `a page with ${census.visible} visible controls is not covered by 40 probes`);
});

test('a page too large to examine says so rather than assuming', () => {
  const c = coverageOf({ total: 10, visible: 10, byKind: {}, hidden: {}, cursorChecked: 4000, cursorSkipped: 1200 }, {});
  assert.equal(c.reasons['not examined (page too large)'], 1200);
  assert.equal(coverageOf(null, {}), null);
});
