// Step 9c: an exact copy keeps every version of markup the site's script renders per width (data-sas-v), each hidden
// by a width rule outside its views — so every visitor's page held every version (flexibench: 1321 → 2225 elements).
// Those versions are now parked like a rebuilt page's layout parts (ir/asis.js markVersionLayouts → data-w-lay): the
// copy's script takes the ones hidden at the visitor's width out of the page and puts them back on a resize. The file
// keeps every version (no script = all there, hidden by the width rule).
// Through the real pipeline (capture, assets, generate, build; the measuring steps stubbed) in normal and in exact mode:
// fewer elements after load in the exact copy, nothing drawn differently (parked against unparked, and an exact copy
// against the original), a resize brings the other version back, and axe list / listitem pass.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { db, projectDir } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { servePreview } from '../src/recreate/preview.js';
import { markVersionLayouts } from '../src/recreate/ir/asis.js';
import { seedProject } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
const PORT = 4263;
const origin = `http://localhost:${PORT}`;

const ITEMS = ['Plan', 'Build', 'Launch', 'Measure'];
// The site renders a wide grid of cards above 600 px and a compact list below, swapping on resize (what a builder site's
// script does once it hydrates).
const HOME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Versions</title><style>
body { margin: 0; font: 16px/1.4 Arial, sans-serif; color: #111 } main { padding: 24px } h1 { margin: 0 0 16px; font-size: 32px }
.wide { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; list-style: none; margin: 0; padding: 0 }
.wide li { border: 1px solid #ccc; padding: 16px; background: #fafafa } .wide h2 { margin: 0 0 8px; font-size: 20px } .wide p { margin: 0 }
.phone { margin: 0; padding-left: 20px } .phone li { padding: 4px 0 }
</style></head><body><main><h1>How it works</h1><div class="slot"></div><p>The same text at every width.</p></main>
<script>
  var slot = document.querySelector('.slot');
  var items = ${JSON.stringify(ITEMS)};
  var render = function () {
    slot.innerHTML = innerWidth < 600
      ? '<ol class="phone">' + items.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ol>'
      : '<ul class="wide">' + items.map(function (t) { return '<li><h2>' + t + '</h2><p>Step ' + t.toLowerCase() + ' in detail.</p></li>'; }).join('') + '</ul>';
  };
  render();
  addEventListener('resize', render);
</script></body></html>`;

let site;
let browser;
const builds = {};
const projectIds = [];

async function build(exact) {
  const id = randomUUID();
  projectIds.push(id);
  seedProject(db, { id, name: 'versions', url: `${origin}/`, stack: 'html', authorized: 1, recreatePages: -1, analysis: true });
  const recreateId = randomUUID();
  const stub = async () => {};
  await runRecreate({
    project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id), recreateId, exact, progress: () => {},
    stages: { ...STAGES, sweep: stub, exactCapture: stub, exact: stub, preview: stub, responsive: stub, stack: stub },
  });
  return recreateDir(id, recreateId);
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

/** A page at a width; `keep` = the copy's script leaves every layout part in place (window.__sasKeepLayouts). */
async function open(url, width, { keep = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  if (keep) await context.addInitScript(() => { window.__sasKeepLayouts = true; });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return { page, close: () => context.close() };
}
async function serve(dir) {
  const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
  return { url: `${served.origin ?? `http://127.0.0.1:${served.port}`}/index.html`, close: () => served.close?.() };
}
const count = (page) => page.evaluate(() => document.querySelectorAll('*').length);
const shot = (page) => page.screenshot({ fullPage: true });

/** Pixels that differ between two screenshots (any channel off by more than 2); a size mismatch is reported as such. */
async function differing(a, b) {
  const [x, y] = await Promise.all([a, b].map((buf) => sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (x.info.width !== y.info.width || x.info.height !== y.info.height) return `size ${x.info.width}x${x.info.height} vs ${y.info.width}x${y.info.height}`;
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    if (Math.abs(x.data[i] - y.data[i]) > 2 || Math.abs(x.data[i + 1] - y.data[i + 1]) > 2 || Math.abs(x.data[i + 2] - y.data[i + 2]) > 2) n++;
  }
  return n;
}

test('versions of an exact page are marked to be parked; small or script-switched ones are not', () => {
  const li = (t) => ({ t: 'li', attrs: {}, children: [{ text: t }] });
  const wide = { t: 'ul', attrs: { 'data-sas-v': 'v1' }, children: [li('a'), li('b')] };
  const phone = { t: 'ol', attrs: { 'data-sas-v': 'v2' }, children: [li('a')] }; // 2 elements: too small
  const state = { t: 'div', attrs: { 'data-sas-v': 'v1' }, children: [{ t: 'div', attrs: { 'data-w-set': 's1', 'data-w-i': '0' }, children: [li('x'), li('y')] }] };
  const svg = { t: 'svg', raw: '<svg data-sas-v="v1"><g/><g/><g/></svg>', attrs: { 'data-sas-v': 'v1' }, children: [] };
  const body = { t: 'body', attrs: {}, children: [{ t: 'main', attrs: {}, children: [wide, phone, state, svg] }] };
  assert.equal(markVersionLayouts(body), 1);
  assert.equal(wide.attrs['data-w-lay'], '');
  for (const n of [phone, state, svg]) assert.equal(n.attrs['data-w-lay'], undefined);
});

for (const mode of ['normal', 'exact']) {
  test(`${mode}: fewer elements after load, nothing drawn differently, a resize brings the other version, axe list / listitem pass`, async () => {
    builds[mode] ??= await build(mode === 'exact');
    const dir = builds[mode];
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const copy = await serve(dir);
    const results = {};
    try {
      if (mode === 'exact') {
        const html = await readFile(path.join(dir, 'dist', 'index.html'), 'utf8');
        assert.ok((html.match(/data-sas-v=/g) ?? []).length >= 2, 'the exact copy holds every version in its file');
        assert.match(html, /data-w-lay/, 'and marks them to be parked');
      }
      for (const width of [1440, 375]) {
        const parked = await open(copy.url, width);
        const kept = await open(copy.url, width, { keep: true });
        const original = await open(`${origin}/`, width);
        try {
          const [p, k] = [await count(parked.page), await count(kept.page)];
          const pShot = await shot(parked.page);
          results[width] = { elements: { parked: p, kept: k, original: await count(original.page) }, vsKept: await differing(pShot, await shot(kept.page)), vsOriginal: await differing(await shot(original.page), pShot) };
          assert.equal(results[width].vsKept, 0, `parking draws nothing differently at ${width} px`);
          if (mode === 'exact') {
            assert.ok(p < k, `fewer elements at ${width} px: ${p} parked vs ${k} kept`);
            assert.equal(results[width].vsOriginal, 0, `the exact copy is the original at ${width} px`);
          }
          const axe = await new AxeBuilder({ page: parked.page }).withRules(['list', 'listitem']).analyze();
          assert.deepEqual(axe.violations.map((v) => v.id), [], `axe list / listitem at ${width} px`);
        } finally {
          await parked.close();
          await kept.close();
          await original.close();
        }
      }
      // A resize from a computer to a phone width shows the phone version, as the original's script does.
      const resized = await open(copy.url, 1440);
      try {
        await resized.page.setViewportSize({ width: 375, height: 800 });
        await resized.page.waitForTimeout(400);
        const shown = await resized.page.evaluate(() => [...document.querySelectorAll('li')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()));
        assert.deepEqual(shown, ['Plan', 'Build', 'Launch', 'Measure'].map((t) => (mode === 'exact' ? t : shown.find((s) => s.startsWith(t)))));
        if (mode === 'exact') {
          const phone = await open(copy.url, 375);
          try {
            assert.equal(await differing(await shot(phone.page), await shot(resized.page)), 0, 'after the resize the page is the phone page');
          } finally {
            await phone.close();
          }
        }
      } finally {
        await resized.close();
      }
    } finally {
      await copy.close();
    }
    console.log(`# ${mode}: ${JSON.stringify(results)}`);
  });
}
