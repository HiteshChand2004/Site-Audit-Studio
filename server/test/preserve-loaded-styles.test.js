// The style attributes a removed runtime set once the page had loaded are written into the page without it
// (behavior/preserve/loadedStyles.js, used by runtimeFree.js), so what that script placed or showed stays so: motionrepo's
// header pill (`left:0;width:0;opacity:0` in the HTML, placed under the current link by the script) was invisible on 34 pages.
// Only the page's settled state is taken: not what keeps changing, not what differs between widths where the element is
// drawn, and a width where it is not drawn (the desktop nav on a phone) does not count.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { loadedStyleChanges, readLoadedStyles, styledPaths, withLoadedStyles } from '../src/recreate/behavior/preserve/loadedStyles.js';

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loaded styles</title>
<style>
body { margin: 0; font: 16px sans-serif; }
nav { position: relative; height: 56px; }
@media (max-width: 800px) { nav { display: none; } }
nav a { display: inline-block; margin-left: 40px; }
.pill { position: absolute; top: 8px; height: 40px; background: #fc0; transition: left .3s, width .3s, opacity .3s; }
.panel { overflow: hidden; background: #eee; }
.ticker { width: 50px; height: 20px; background: #333; }
.sized { height: 20px; background: #09c; }
.fade { height: 20px; background: #c30; }
</style></head><body>
<header><nav><a href="/">Home</a><a href="/pricing/" id="here">Pricing</a><span class="pill" style="left:0;width:0;opacity:0"></span></nav></header>
<main>
<div class="panel" style="height:0">Panel text the script measures.</div>
<div class="ticker" style="transform:translateX(0px)"></div>
<div class="sized" style="width:10px"></div>
<div class="fade" style="opacity:0"></div>
<p class="plain" style="color: rgb(10, 20, 30)">Untouched.</p>
</main>
<script>
const place = () => {
  const here = document.getElementById('here');
  const pill = document.querySelector('.pill');
  // As a scroll-spy script does: under the current link, measured (0 where the nav is not drawn).
  pill.style.left = here.offsetLeft + 'px';
  pill.style.width = here.offsetWidth + 'px';
  pill.style.opacity = '1';
  document.querySelector('.panel').style.height = '120px';
  document.querySelector('.sized').style.width = Math.round(innerWidth / 4) + 'px';
  document.querySelector('.fade').removeAttribute('style');
};
addEventListener('load', place);
let x = 0;
setInterval(() => { x = (x + 7) % 300; document.querySelector('.ticker').style.transform = 'translateX(' + x + 'px)'; }, 40);
</script></body></html>`;

let dir;
let served;
let browser;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-loaded-styles-'));
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
  await page.waitForTimeout(600);
  return page;
};

test('the settled styles are taken; what keeps changing, differs where drawn or is unchanged is not', { timeout: 120000 }, async () => {
  const readings = await readLoadedStyles(openAt, [375, 1440], styledPaths(HTML));
  const { list, varies } = loadedStyleChanges(HTML, readings);
  const by = Object.fromEntries(list.map((c) => [c.cls || c.tag, c.style]));
  // The pill: drawn only at 1440 (the nav is hidden on a phone), so that width's value is the one.
  assert.match(by.pill ?? '', /left: \d+px; width: \d+px; opacity: 1;/, JSON.stringify(list));
  assert.notEqual(by.pill, 'left: 0px; width: 0px; opacity: 1;');
  assert.equal(by.panel, 'height: 120px;', 'the same at both widths where it is drawn');
  assert.ok('fade' in by && by.fade === null, 'a style the script took away goes');
  assert.equal('ticker' in by, false, 'changing all the time: not the page\'s settled state');
  assert.equal('sized' in by, false, 'a different value at each width where it is drawn');
  assert.equal('plain' in by, false, 'unchanged');
  assert.equal(varies, 2, 'the ticker and the width-dependent box are counted');
});

test('the written page shows them with no script running', { timeout: 120000 }, async () => {
  const readings = await readLoadedStyles(openAt, [375, 1440], styledPaths(HTML));
  const { list } = loadedStyleChanges(HTML, readings);
  const written = withLoadedStyles(HTML.replace(/<script>[\s\S]*<\/script>/, ''), list);
  assert.equal(written.written, list.length);
  // The written page on a server of its own (the other one keeps what it served).
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'sas-loaded-styles-out-'));
  await writeFile(path.join(outDir, 'index.html'), written.html);
  const own = await serveCopy(outDir);
  const context = await browser.newContext({ viewport: { width: 1440, height: 800 }, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(own.url, { waitUntil: 'load' });
    const r = await page.evaluate(() => {
      const pill = document.querySelector('.pill').getBoundingClientRect();
      const here = document.getElementById('here').getBoundingClientRect();
      return { pill: [Math.round(pill.left), Math.round(pill.width)], here: [Math.round(here.left), Math.round(here.width)], opacity: getComputedStyle(document.querySelector('.pill')).opacity, panel: document.querySelector('.panel').offsetHeight, fade: document.querySelector('.fade').getAttribute('style') };
    });
    assert.deepEqual(r.pill, r.here, 'the pill under the current link, as the script put it');
    assert.equal(r.opacity, '1');
    assert.equal(r.panel, 120);
    assert.equal(r.fade, null);
  } finally {
    await context.close();
    await own.close?.();
    await rm(outDir, { recursive: true, force: true });
  }
});

test('an element that is not the one read (other tag or classes) is left as it is', () => {
  const list = [{ path: 'body>main:1>div:1', tag: 'div', cls: 'panel', style: 'height: 120px;' }];
  assert.equal(withLoadedStyles(HTML, list).written, 1);
  assert.equal(withLoadedStyles(HTML.replace('class="panel"', 'class="panel open"'), list).written, 0);
  assert.equal(withLoadedStyles(HTML, [{ ...list[0], tag: 'section' }]).written, 0);
  assert.deepEqual(withLoadedStyles(HTML, []), { html: HTML, written: 0 });
});
