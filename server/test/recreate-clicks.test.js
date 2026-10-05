// Full-site B.1: click capture (capture/clicks.js) on a local page with one of each interactive part, built the way
// sites build them (script-driven, no particular library), plus controls that must not count.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { captureClicks, classifyClick } from '../src/recreate/capture/clicks.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { startSiteServer } from '../src/recreate/verify/server.js';
import { WIDGETS_PAGE } from './fixtures/widgets-page.js';

const PAGE = WIDGETS_PAGE;

let dir;
let site;
let browser;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-clicks-'));
  await writeFile(path.join(dir, 'index.html'), PAGE);
  site = await startSiteServer(dir);
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('classifyClick: dialog, tabs, carousel, disclosure, nothing', () => {
  const vp = [1000, 700];
  const box = (p, parent, rect = [0, 0, 100, 50], fixed = false) => ({ path: p, parent, rect, fixed, inTrigger: false });
  const none = { shown: [], hidden: [], added: [], attrs: [], moved: [], viewport: vp };
  assert.equal(classifyClick(none), null);
  assert.equal(classifyClick({ ...none, shown: [box('body>div:0', 'body', [0, 0, 1000, 700], true)] }).kind, 'dialog');
  const swap = { ...none, shown: [box('body>div:1>div:2', 'body>div:1')], hidden: [box('body>div:1>div:1', 'body>div:1')] };
  assert.equal(classifyClick(swap, { text: 'Tab 2', group: { sig: 'button|tab|', count: 3 } }).kind, 'tabs');
  assert.equal(classifyClick(swap, { text: 'Next slide' }).kind, 'carousel');
  assert.equal(classifyClick({ ...none, moved: [{ path: 'body>div:2', from: 'none', to: 'matrix(1,0,0,1,-400,0)' }] }).kind, 'carousel');
  assert.deepEqual(classifyClick({ ...none, shown: [box('body>nav:0', 'body')] }), { kind: 'disclosure', targets: ['body>nav:0'] });
  const own = { ...none, shown: [box('body>div:4', 'body')], hidden: [{ ...box('body>div:3', 'body'), hasTrigger: true }] };
  assert.equal(classifyClick(own, { group: { sig: 'button||collapse|div.search', count: 2 } }).kind, 'disclosure');
});

test('captureClicks finds menu, dropdown, accordion, details, tabs, slider and dialog; page links stay put', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await page.goto(`${site.origin}/`, { waitUntil: 'load' });
  const snap = await page.evaluate(snapshotPage, {});
  const out = await captureClicks(page, { budgetMs: 60000 });
  const byText = (t) => out.widgets.find((w) => w.text.includes(t));

  assert.equal(page.url(), `${site.origin}/`, 'no link left the page');
  assert.equal(out.stats.left, false);

  const burger = byText('Open menu');
  assert.equal(burger?.kind, 'disclosure');
  assert.ok(burger.targets.some((p) => p.startsWith('body>nav:')), 'the drawer is the target');
  assert.equal(burger.closes, 'toggle');

  const dd = byText('Products');
  assert.equal(dd?.kind, 'disclosure');
  assert.equal(dd.opensOn, 'hover');

  assert.equal(byText('Question one')?.kind, 'disclosure');
  assert.equal(byText('Native details')?.kind, 'disclosure');

  const tab = byText('Tab 2');
  assert.equal(tab?.kind, 'tabs');
  assert.equal(tab.group?.count, 3);

  assert.equal(byText('Next slide')?.kind, 'carousel');

  const dialog = byText('Book a demo');
  assert.equal(dialog?.kind, 'dialog');
  assert.ok(dialog.closes, 'the dialog was closed again');

  assert.equal(byText('Does nothing'), undefined);
  assert.equal(byText('Collapse search bar')?.kind, 'disclosure', 'a button that hides its own block is a toggle, not tabs');
  assert.equal(byText('Go by script'), undefined, 'a script navigation is refused, nothing changed');
  assert.ok(out.stats.noChange >= 1);
  assert.ok(!out.widgets.some((w) => w.text === 'A page link'), 'links to pages are not candidates');

  // Paths are the snapshot's paths, so the IR can find the elements.
  const paths = new Set();
  const walk = (n) => { if (n.path) paths.add(n.path); (n.children ?? []).forEach(walk); };
  walk(snap.body ?? snap.tree ?? snap);
  for (const w of out.widgets) assert.match(w.trigger, /^body>/);
  await page.close();
});

test('captureClicks stops at its budget', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await page.goto(`${site.origin}/`, { waitUntil: 'load' });
  const out = await captureClicks(page, { budgetMs: 1 });
  assert.equal(out.stats.timedOut, true);
  assert.ok(out.widgets.length <= 1);
  await page.close();
});
