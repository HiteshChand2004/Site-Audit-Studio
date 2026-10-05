// Full-site C.1-C.2: the interactive parts of a page are rebuilt in the copy. A real Recreate of a local page with a menu,
// a hover dropdown, accordions, tabs, a slider and a dialog (fixtures/widgets-page.js), then the copy is used in a browser
// the way a visitor would: every part works with the generated script, nothing changes without it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { db } from '../src/db/index.js';
import { runRecreate } from '../src/recreate/index.js';
import { stateDecls } from '../src/recreate/ir/widgets.js';
import { startSiteServer } from '../src/recreate/verify/server.js';
import { servePreview } from '../src/recreate/preview.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { WIDGETS_PAGE } from './fixtures/widgets-page.js';
import { exportStack } from '../src/recreate/export/fromIr.js';
import { toolchainStatus } from '../src/toolchains/index.js';

process.env.SAS_ALLOW_LOCALHOST = '1'; // the "original" is a local page

let dir;
let original;
let browser;
let report;
let dist;
let served;
let projectId;
let recreateIdOf;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-widgets-'));
  await writeFile(path.join(dir, 'index.html'), WIDGETS_PAGE);
  for (const p of ['a.html', 'b.html', 'x.html', 'y.html', 'about.html', 'elsewhere.html']) await writeFile(path.join(dir, p), `<!doctype html><title>${p}</title><p>${p}</p>`);
  original = await startSiteServer(dir);
  browser = await launchBrowser();

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, target_domain, created_at, updated_at) VALUES (?, 'widgets', ?, 'html', 1, 0, 'https://new.example.org', ?, ?)`)
    .run(id, `${original.origin}/`, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${original.origin}/`, analyzedAt: now, techStack: [], brokenLinks: { checked: 0, broken: [], unverified: [] } }));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const recreateId = randomUUID();
  projectId = id;
  recreateIdOf = recreateId;
  report = await runRecreate({ project, recreateId, progress: () => {} });
  // The job runner stores the finished recreate; an export from the saved IR reads it from there.
  db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`).run(recreateId, id, now, now, JSON.stringify(report));
  dist = path.join(recreateDir(id, recreateId), 'dist');
  served = await servePreview(dist, { scripts: true });
});
after(async () => {
  await browser?.close();
  await served?.close?.();
  await original?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('stateDecls keeps the look of a state, not its size', () => {
  assert.deepEqual(stateDecls({ display: 'block', visibility: 'visible', opacity: '1', transform: 'none', translate: 'none', height: '18px', 'max-height': 'none', overflow: 'visible' }),
    { display: 'block', visibility: 'visible', opacity: '1', transform: 'none' });
});

test('the copy carries the rebuilt parts: tokens, ARIA, open / closed rules and the one generated script', async () => {
  assert.deepEqual(report.errors, []);
  assert.equal(report.safety?.safe, true, 'the safety gate passed');
  const w = report.generate.widgets;
  assert.ok(w.rebuilt >= 5, `rebuilt ${JSON.stringify(w)}`);
  for (const kind of ['disclosure', 'tabs', 'carousel', 'dialog']) assert.ok(w.byKind[kind] >= 1, kind);
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  assert.match(html, /data-w="dt\d+"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*data-w="dt\d+"/);
  assert.match(html, /data-w="dh\d+"/, 'the dropdown opens on hover');
  assert.match(html, /role="tab"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /data-w="ck\d+"/);
  assert.match(html, /<script src="js\/motion\.js" defer><\/script>/);
  const css = await readFile(path.join(dist, 'css', 'site.css'), 'utf8');
  assert.match(css, /\[data-w~="?dp\d+"?\]\.w-open/);
  assert.match(css, /\[data-w~="?bp\d+:\d+"?\]\.w-shut/);
  assert.doesNotMatch(html, new RegExp(original.origin.replace(/[.:/]/g, '\\$&')), 'nothing points at the original');
});

async function openCopy({ javaScript = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, javaScriptEnabled: javaScript });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${served.url ?? served.origin}/`, { waitUntil: 'load' });
  return { page, errors, context };
}
const visible = (page, selector) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
}, selector);

test('a visitor can use every part of the copy', async () => {
  const { page, errors, context } = await openCopy();
  // Menu: the burger opens the drawer, Escape closes it.
  const burger = page.locator('[aria-label="Open menu"]');
  const drawer = `#${await burger.getAttribute('aria-controls')}`;
  assert.equal(await visible(page, drawer), false);
  await burger.click();
  assert.equal(await visible(page, drawer), true, 'the drawer opens');
  assert.equal(await burger.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await visible(page, drawer), false, 'Escape closes it');

  // Accordion: a question shows its answer.
  const q = page.getByText('Question one');
  await q.click();
  assert.equal(await page.getByText('Answer one').isVisible(), true);

  // Tabs: Tab 2 shows panel 2 and hides panel 1.
  assert.equal(await page.getByText('Panel 1').isVisible(), true);
  await page.getByRole('tab', { name: 'Tab 2' }).click();
  assert.equal(await page.getByText('Panel 2').isVisible(), true);
  assert.equal(await page.getByText('Panel 1').isVisible(), false);

  // Slider: next moves the track by one slide.
  const track = page.locator('[data-w^="ck"], [data-w*=" ck"]').first();
  const x0 = await track.evaluate((el) => el.getBoundingClientRect().left);
  await page.getByLabel('Next slide').click();
  await page.waitForTimeout(500);
  const x1 = await track.evaluate((el) => el.getBoundingClientRect().left);
  assert.ok(x1 < x0 - 100, `the track moved (${x0} → ${x1})`);

  // Dialog: opens, Escape closes it.
  await page.getByText('Book a demo').click();
  assert.equal(await page.getByText('Dialog text').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByText('Dialog text').isVisible(), false);

  // A menu the original's script built on the click: in the copy it is part of the page, hidden until opened.
  assert.equal(await page.getByText('Design', { exact: true }).isVisible(), false);
  await page.getByText('Services', { exact: true }).click();
  assert.equal(await page.getByText('Design', { exact: true }).isVisible(), true);
  await page.getByText('Services', { exact: true }).click();
  assert.equal(await page.getByText('Design', { exact: true }).isVisible(), false);

  // Dropdown on hover.
  await page.getByText('Products').hover();
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('Item A').isVisible(), true);

  assert.deepEqual(errors, []);
  await context.close();
});

test('without script the copy looks as captured: panels closed, the first tab shown', async () => {
  const { page, context } = await openCopy({ javaScript: false });
  assert.equal(await page.getByText('Answer one').isVisible(), false);
  assert.equal(await page.getByText('Panel 1').isVisible(), true);
  assert.equal(await page.getByText('Dialog text').isVisible(), false);
  await context.close();
});

// C.3: the app stacks carry the same script and markup, stay equal to the HTML build, and the parts work there too.
for (const [stack, toolchain, scripts] of [['react-vite', 'react-vite', true], ['nextjs', 'next', 'inline']]) {
  test(`${stack}: equivalent to the HTML build, hydration clean, the menu and the tabs work`, { timeout: 400000 }, async (t) => {
    if (!(await toolchainStatus(toolchain)).installed) return t.skip(`${toolchain} toolchain not installed`);
    const out = await exportStack({ projectId, recreateId: recreateIdOf, stack });
    const output = out.output ?? out;
    assert.equal(output.status, 'ready', JSON.stringify(output.error ?? ''));
    assert.ok(!(output.hydration?.problems?.length), `hydration: ${JSON.stringify(output.hydration)}`);
    const root = path.join(recreateDir(projectId, recreateIdOf), 'stacks', stack, output.dist);
    const app = await servePreview(root, { scripts });
    try {
      const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${app.origin}/`, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      const burger = page.locator('[aria-label="Open menu"]');
      await burger.click();
      assert.equal(await burger.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.getByText('X', { exact: true }).isVisible(), true, 'the drawer opens');
      await page.getByRole('tab', { name: 'Tab 3' }).click();
      assert.equal(await page.getByText('Panel 3').isVisible(), true);
      assert.equal(await page.getByText('Panel 1').isVisible(), false);
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await app.close();
    }
  });
}
