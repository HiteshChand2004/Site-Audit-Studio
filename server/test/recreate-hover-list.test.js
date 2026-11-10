// Step 9b: a list item whose hover look the page's script draws (a menu of <li>s, a hover layer added on mouseenter) keeps
// its list whole in the copy. The hovered copy used to go into a <div style="display: contents"> together with the item, a
// <div> inside a <ul>: axe `list` / `listitem` failed (flexibench). Now no box may stand in a list (ir/states.js
// hoverPairOnly): the copy is the item's next sibling and js/motion.js marks the item while the mouse or focus is on either.
// Through the real pipeline (capture, assets, generate, build; the measuring steps stubbed) in normal and in exact mode:
// the list holds only list items, axe list / listitem pass, the hover still shows the original's look, and the copy at rest
// is drawn the same as the original.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { db, projectDir } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { servePreview } from '../src/recreate/preview.js';
import { expandHoverCards, hoverPairOnly } from '../src/recreate/ir/states.js';
import { placeExtras } from '../src/recreate/ir/asis.js';
import { seedProject } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
const PORT = 4262;
const origin = `http://localhost:${PORT}`;

const HOME = `<!doctype html><html lang="en"><head><title>Hover list</title><style>
body { margin: 0; font: 16px/1.4 sans-serif; color: #111 }
.menu { display: flex; gap: 24px; list-style: none; margin: 0; padding: 32px 40px; background: #f3f4f6 }
.menu li { position: relative; width: 160px; height: 56px; border: 1px solid #d1d5db; background: #fff }
.menu a { display: block; padding: 16px; color: #111; text-decoration: none }
.layer { position: absolute; inset: 0; padding: 16px; background: #1f2937; color: #fff }
main { padding: 40px }
</style></head><body><header><nav aria-label="Main"><ul class="menu">
<li><a href="#">Clinic</a></li><li><a href="#">Hospital</a></li><li><a href="#">Lab</a></li>
</ul></nav></header><main><h1>Hover list</h1><p>A menu whose items show a dark layer while the mouse is on them.</p></main>
<script>document.querySelectorAll('.menu li').forEach(function (li) {
  li.addEventListener('mouseenter', function () { var d = document.createElement('div'); d.className = 'layer'; d.textContent = 'All about ' + li.textContent.trim(); li.appendChild(d); });
  li.addEventListener('mouseleave', function () { var d = li.querySelector('.layer'); if (d) d.remove(); });
});</script></body></html>`;

let site;
let browser;
const builds = {};
const projectIds = [];

async function build(exact) {
  const id = randomUUID();
  projectIds.push(id);
  seedProject(db, { id, name: 'hover-list', url: `${origin}/`, stack: 'html', authorized: 1, recreatePages: -1, analysis: true });
  const recreateId = randomUUID();
  const stub = async () => {};
  const report = await runRecreate({
    project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id), recreateId, exact, progress: () => {},
    stages: { ...STAGES, sweep: stub, exactCapture: stub, exact: stub, preview: stub, responsive: stub, stack: stub },
  });
  return { dir: recreateDir(id, recreateId), report };
}

before(async () => {
  site = createServer((req, res) => {
    if (req.url.split('?')[0] === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(HOME);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise((resolve) => { site.listen(PORT, resolve); });
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close().catch(() => {});
  site?.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

async function open(url, width) {
  const context = await browser.newContext({ viewport: { width, height: 700 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.mouse.move(width - 2, 690);
  await page.waitForTimeout(300);
  return { page, close: () => context.close() };
}
async function openCopy(dir, width) {
  const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
  const { page, close } = await open(`${served.origin ?? `http://127.0.0.1:${served.port}`}/index.html`, width);
  return { page, close: async () => { await close(); await served.close?.(); } };
}

/** Pixels that differ between two screenshots of the same size (any channel off by more than 2). */
async function differing(a, b, { sameSize = true } = {}) {
  const [x, y] = await Promise.all([a, b].map((buf) => sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (!sameSize && (x.info.width !== y.info.width || x.info.height !== y.info.height)) return `size ${x.info.width}x${x.info.height} vs ${y.info.width}x${y.info.height}`;
  assert.deepEqual([x.info.width, x.info.height], [y.info.width, y.info.height], 'the same page size');
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    if (Math.abs(x.data[i] - y.data[i]) > 2 || Math.abs(x.data[i + 1] - y.data[i + 1]) > 2 || Math.abs(x.data[i + 2] - y.data[i + 2]) > 2) n++;
  }
  return n;
}

const layers = (page) => page.evaluate(() => [...document.querySelectorAll('.menu *')].filter((e) => e.getClientRects().length && getComputedStyle(e).backgroundColor === 'rgb(31, 41, 55)').map((e) => e.textContent.trim()));

test('no box may stand in a list: list items, table rows and options are paired, other cards keep their box', () => {
  assert.equal(hoverPairOnly('ul', 'li'), true);
  assert.equal(hoverPairOnly('OL', 'LI'), true);
  assert.equal(hoverPairOnly('tbody', 'tr'), true);
  assert.equal(hoverPairOnly('select', 'option'), true);
  assert.equal(hoverPairOnly('ul', 'div'), true, 'a stray item of a list still gets no box inside the list');
  assert.equal(hoverPairOnly('nav', 'div'), false);
  assert.equal(hoverPairOnly('div', 'a'), false);
  // The tree: the hovered copy of an <li> is its next sibling, no <div> between the list and its items.
  const view = { desktop: { rect: [0, 0, 100, 30], style: {}, hidden: false } };
  const li = (text, extra = {}) => ({ tag: 'li', attrs: {}, views: view, children: [{ text }], ...extra });
  const hovered = li('Hospital', { hoverState: { node: li('All about Hospital') } });
  const list = { tag: 'ul', attrs: {}, views: view, children: [li('Clinic'), hovered, li('Lab')] };
  assert.equal(expandHoverCards({ tag: 'body', attrs: {}, views: view, children: [list] }), 1);
  assert.deepEqual(list.children.map((c) => c.tag), ['li', 'li', 'li', 'li']);
  assert.equal(list.children[1].stateAttrs['data-w-hrest'], 'pair');
  assert.ok('data-w-hcopy' in list.children[2].stateAttrs);
  // The original markup of an exact copy: the same rule where the copy is placed.
  const asLi = (text, cpath) => ({ t: 'li', cpath, attrs: {}, children: [{ text }] });
  const ul = { t: 'ul', attrs: {}, children: [asLi('Clinic', 'a'), asLi('Hospital', 'b'), asLi('Lab', 'c')] };
  const body = { t: 'body', attrs: {}, children: [ul] };
  assert.equal(placeExtras(body, [{ kind: 'wrap', anchor: 'b', node: { t: 'li', attrs: { 'data-w-hcopy': '' }, children: [{ text: 'All about Hospital' }] } }]), 1);
  assert.deepEqual(ul.children.map((c) => c.t), ['li', 'li', 'li', 'li']);
  assert.equal(ul.children[1].attrs['data-w-hrest'], 'pair');
  // Not in a list: the box that draws nothing is still used.
  const row = { t: 'div', attrs: {}, children: [{ t: 'a', cpath: 'x', attrs: {}, children: [{ text: 'Company' }] }, { t: 'a', cpath: 'y', attrs: {}, children: [] }] };
  placeExtras({ t: 'body', attrs: {}, children: [row] }, [{ kind: 'wrap', anchor: 'x', node: { t: 'a', attrs: { 'data-w-hcopy': '' }, children: [] } }]);
  assert.equal(row.children[0].attrs['data-w-hv'], '');
});

for (const mode of ['normal', 'exact']) {
  test(`${mode}: the menu list holds only list items, axe list / listitem pass, the hover shows, nothing is drawn differently`, async () => {
    builds[mode] ??= await build(mode === 'exact');
    const { dir } = builds[mode];
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const copy = await openCopy(dir, 1440);
    try {
      // A hover look was found and built (else this test proves nothing).
      assert.ok(await copy.page.locator('[data-w-hrest]').count() >= 1, 'a hover card was rebuilt');
      const kids = await copy.page.$$eval('ul', (uls) => uls.flatMap((ul) => [...ul.children].map((c) => c.tagName)));
      assert.deepEqual([...new Set(kids)].filter((t) => !['LI', 'TEMPLATE', 'SCRIPT'].includes(t)), [], `children of the list: ${kids}`);
      const axe = await new AxeBuilder({ page: copy.page }).withRules(['list', 'listitem']).analyze();
      assert.deepEqual(axe.violations.map((v) => v.id), [], 'axe list / listitem');
      // The hover: the original's layer while the mouse is on the item, gone when it leaves.
      assert.deepEqual(await layers(copy.page), []);
      // A real mouse move (the hovered copy covers the item once it shows, so a locator hover would wait for it forever).
      const box = await copy.page.getByText('Hospital', { exact: true }).boundingBox();
      await copy.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await copy.page.waitForTimeout(500);
      assert.deepEqual(await layers(copy.page), ['All about Hospital'], 'the hovered look shows');
      await copy.page.mouse.move(1430, 690);
      await copy.page.waitForTimeout(300);
      assert.deepEqual(await layers(copy.page), [], 'and goes when the mouse leaves');
      // After the hover the list still holds list items only.
      const after = await copy.page.$$eval('ul', (uls) => uls.flatMap((ul) => [...ul.children].map((c) => c.tagName)));
      assert.deepEqual([...new Set(after)].filter((t) => !['LI', 'TEMPLATE', 'SCRIPT'].includes(t)), []);
      // Keyboard focus stays on the item's link (the original shows the layer on mouseenter only; showing it on focus would
      // hide the focused item and drop the focus).
      await copy.page.getByRole('link', { name: 'Hospital', exact: true }).focus();
      assert.equal(await copy.page.evaluate(() => document.activeElement?.textContent.trim()), 'Hospital', 'focus stays on the link');
    } finally {
      await copy.close();
    }
    // At rest, at a computer and a phone width: the change draws nothing new — the copy is pixel for pixel the same page put
    // back into the old shape (item + copy in a box that draws nothing). An exact copy is also the original, pixel for pixel;
    // a rebuilt one is the rebuild it was before (its own small differences to the original are not this change's).
    for (const width of [1440, 375]) {
      const o = await open(`${origin}/`, width);
      const c = await openCopy(dir, width);
      try {
        const now = await c.page.screenshot({ fullPage: true });
        const original = await o.page.screenshot({ fullPage: true });
        const vsOriginal = await differing(original, now, { sameSize: mode === 'exact' });
        oldVsOriginal[mode] ??= {};
        await c.page.evaluate(() => {
          for (const card of document.querySelectorAll('[data-w-hrest="pair"]')) {
            const copyOf = card.nextElementSibling;
            const box = document.createElement('div');
            box.setAttribute('data-w-hv', '');
            box.style.display = 'contents';
            card.replaceWith(box);
            card.setAttribute('data-w-hrest', '');
            box.append(card, copyOf);
          }
        });
        assert.ok(await c.page.locator('ul > div[data-w-hv]').count() >= 1, 'the old shape was put back');
        const old = await c.page.screenshot({ fullPage: true });
        assert.equal(await differing(old, now), 0, `the list-safe pair draws the same as the old box at ${width} px`);
        oldVsOriginal[mode][width] = [vsOriginal, await differing(original, old, { sameSize: mode === 'exact' })];
        if (mode === 'exact') assert.equal(vsOriginal, 0, `${vsOriginal} pixels differ from the original at ${width} px`);
        else assert.equal(vsOriginal, oldVsOriginal[mode][width][1], 'the same difference to the original as the old shape');
      } finally {
        await o.close();
        await c.close();
      }
    }
    console.log(`# ${mode}: pixels differing from the original [now, old shape] by width: ${JSON.stringify(oldVsOriginal[mode])}`);
  });
}
const oldVsOriginal = {};
