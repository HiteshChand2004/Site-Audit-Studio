// The accessibility attributes a removed runtime gave the page's controls after load are written into the page without it
// (behavior/preserve/loadedA11y.js, used by runtimeFree.js). A builder's script finishes its dropdown toggles in the browser
// (role="button", tabindex="0", aria-haspopup, aria-expanded, an id and the aria-controls naming its list): written without that
// script, the toggles lost them, so Lighthouse found no command to check where the original passed ("does not apply") and the
// copy's accessibility score was lower (a real copy, 2026-11-16: 94 → 90). Only what the HTML lacks is added; a state that keeps
// changing, a value that differs between widths, and a reference to an id the page will not have are left out.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { loadedA11yChanges, readLoadedA11y, withLoadedA11y } from '../src/recreate/behavior/preserve/loadedA11y.js';

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loaded roles</title>
<style>body { margin: 0; font: 16px sans-serif; } .toggle { padding: 8px; cursor: pointer; } .list { display: none; }</style></head><body>
<main>
<div class="dropdown"><div class="toggle">What does it cost?</div><nav class="list"><a href="/a">A</a></nav></div>
<div class="dropdown"><div class="toggle">Who is it for?</div><nav class="list"><a href="/b">B</a></nav></div>
<div class="spinner" aria-live="polite">Ready</div>
<div class="wide">Wide</div>
<img class="logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Own logo">
<button class="go" aria-describedby="nowhere">Go</button>
</main>
<script>
addEventListener('load', () => {
  document.querySelectorAll('.dropdown').forEach((d, i) => {
    const t = d.querySelector('.toggle');
    const l = d.querySelector('.list');
    t.id = 'dd-toggle-' + i; l.id = 'dd-list-' + i;
    t.setAttribute('role', 'button'); t.setAttribute('tabindex', '0');
    t.setAttribute('aria-haspopup', 'menu'); t.setAttribute('aria-expanded', 'false'); t.setAttribute('aria-controls', l.id);
    l.setAttribute('aria-labelledby', t.id);
  });
  // The HTML's own value is never changed; a reference to an id no element has is not taken.
  document.querySelector('.logo').setAttribute('alt', 'Changed by the script');
  document.querySelector('.go').setAttribute('aria-controls', 'not-on-the-page');
  // A label that depends on the width, and one that keeps changing.
  document.querySelector('.wide').setAttribute('aria-label', innerWidth > 800 ? 'Wide view' : 'Narrow view');
  let n = 0;
  setInterval(() => document.querySelector('.spinner').setAttribute('aria-valuenow', String(++n)), 120);
});
</script></body></html>`;

let dir;
let served;
let browser;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-loaded-a11y-'));
  await writeFile(path.join(dir, 'index.html'), HTML);
  served = await serveCopy(dir);
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await served?.close?.();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const openAt = async (width) => {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  await page.goto(served.url, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return page;
};

test('the roles, ids and references the script settled are taken; the HTML\'s own values, moving or width-dependent ones are not', { timeout: 120000 }, async () => {
  const { list, varies, refsDropped } = loadedA11yChanges(HTML, await readLoadedA11y(openAt, [375, 1440]));
  const by = (cls) => list.filter((c) => c.cls === cls).map((c) => c.attrs);
  assert.deepEqual(by('toggle'), [
    { id: 'dd-toggle-0', role: 'button', tabindex: '0', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'dd-list-0' },
    { id: 'dd-toggle-1', role: 'button', tabindex: '0', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'dd-list-1' },
  ], JSON.stringify(list));
  assert.deepEqual(by('list').map((a) => a['aria-labelledby']), ['dd-toggle-0', 'dd-toggle-1']);
  assert.deepEqual(by('logo'), [], 'the alt the HTML has is never changed');
  assert.deepEqual(by('go'), [], 'a reference to an id the page will not have is dropped');
  assert.equal(refsDropped, 1);
  assert.deepEqual(by('wide'), [], 'a different label at each width is not the page\'s own');
  assert.deepEqual(by('spinner'), [], 'a state that keeps changing is not taken');
  assert.ok(varies >= 1);
});

test('the written page carries them with no script running, and Lighthouse\'s rules find commands where the original had them', { timeout: 120000 }, async () => {
  const { list } = loadedA11yChanges(HTML, await readLoadedA11y(openAt, [375, 1440]));
  const bare = HTML.replace(/<script>[\s\S]*<\/script>/, '');
  const written = withLoadedA11y(bare, list);
  assert.equal(written.written, list.length);
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'sas-loaded-a11y-out-'));
  await writeFile(path.join(outDir, 'index.html'), written.html);
  const own = await serveCopy(outDir);
  const context = await browser.newContext({ viewport: { width: 1440, height: 800 }, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(own.url, { waitUntil: 'load' });
    const r = await page.evaluate(() => [...document.querySelectorAll('[role="button"][tabindex="0"]')].map((e) => ({ id: e.id, controls: document.getElementById(e.getAttribute('aria-controls'))?.className })));
    assert.deepEqual(r, [{ id: 'dd-toggle-0', controls: 'list' }, { id: 'dd-toggle-1', controls: 'list' }]);
  } finally {
    await context.close();
    await own.close?.();
    await rm(outDir, { recursive: true, force: true });
  }
  // Written twice: nothing more is added (only missing attributes are).
  assert.equal(withLoadedA11y(written.html, list).written, 0);
});

test('an element that is not the one read, or an id another element already has, is left as it is', () => {
  const html = '<html><body><main><div class="toggle">A</div><p id="dd-toggle-0">taken</p></main></body></html>';
  const readings = [{ width: 1440, attrs: { 'body>main:1>div:1': { tag: 'div', cls: 'toggle', attrs: { id: 'dd-toggle-0', role: 'button' } } } }];
  const { list } = loadedA11yChanges(html, readings);
  assert.deepEqual(list, [{ path: 'body>main:1>div:1', tag: 'div', cls: 'toggle', attrs: { role: 'button' } }], 'the id is another element\'s');
  assert.equal(withLoadedA11y(html, [{ ...list[0], cls: 'other' }]).written, 0);
});
