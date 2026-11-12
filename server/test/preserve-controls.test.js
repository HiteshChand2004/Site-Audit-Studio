// Every button of a converted page works as on the original after the original's framework code is taken out
// (behavior/preserve/controls.js): what a click or a scroll did through that code alone is measured on the page with it and
// replayed by the copy's own script, and nothing the page already does by itself (a native <details>) is replayed twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { CONTROLS_DATA_ID, missingChange, planReplay, sameOutcome, withReplay } from '../src/recreate/behavior/preserve/controls.js';
import { runtimeFreeCopy } from '../src/recreate/behavior/preserve/runtimeFree.js';
import { runtimeNotes } from '../src/recreate/convert/runtime.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

const outcome = (o) => ({ text: { added: [], removed: [] }, appeared: 0, vanished: 0, scroll: null, ...o });
const ctl = (o) => ({ path: 'body>button:1', label: 'Go', shown: true, toggle: false, scroll: null, change: { attrs: [], text: [], add: [], remove: [] }, outcome: outcome({}), ...o });

test('a click that ends the same way is left alone; only what the copy does not do itself is replayed', () => {
  assert.equal(sameOutcome(ctl({}), ctl({})), true);
  assert.equal(sameOutcome(ctl({ outcome: outcome({ scroll: 'top' }) }), ctl({ outcome: outcome({ scroll: 'moved' }) })), false);
  assert.equal(sameOutcome(ctl({ outcome: outcome({ scroll: 'moved' }) }), ctl({ outcome: outcome({}) })), true, 'bringing a control into view is not a scroll');
  assert.equal(sameOutcome(ctl({}), { path: 'body>button:1', shown: false }), false, 'hidden on the copy');
  const orig = ctl({ scroll: 'top', outcome: outcome({ scroll: 'top' }), change: { attrs: [{ path: 'body>details:1', name: 'open', from: null, to: '' }, { path: 'html', name: 'data-theme', from: null, to: 'dark' }], text: [], add: [], remove: [] } });
  const free = ctl({ change: { attrs: [{ path: 'body>details:1', name: 'open', from: null, to: '' }], text: [], add: [], remove: [] } });
  const m = missingChange(orig, free);
  assert.deepEqual(m.attrs.map((a) => a.name), ['data-theme'], 'the <details> the browser opens is not opened again');
  assert.equal(m.scroll, 'top');
  const plan = planReplay({ asIs: [{ width: 1440, controls: [orig] }], free: [{ width: 1440, controls: [free] }] }, { asIs: [{ width: 1440, states: [{ path: 'body>button:1', name: 'class', from: 'a', to: 'a show', at: 400 }] }], free: [{ width: 1440, states: [] }] });
  assert.equal(plan.controls.length, 1);
  assert.equal(plan.scroll.length, 1);
  const page = '<html><body><button>Go</button><details><summary>Q</summary>A</details></body></html>';
  const done = withReplay(page, plan);
  assert.equal(done.controls, 1);
  assert.match(done.html, new RegExp(`<script type="application/json" id="${CONTROLS_DATA_ID}">`));
  assert.match(done.html, /<button data-sas-c="1" data-sas-ctl="0">Go<\/button>/);
  assert.equal(withReplay(done.html, plan).already, true, 'never twice');
  assert.equal(withReplay(page, { controls: [], scroll: [] }).html, page, 'nothing to replay: unchanged');
});

// The "framework": it draws the page's text from its data (so the copy must lose it), opens the menu, cycles the theme
// dark → light → dark, shows "Back to top" once the page is scrolled and scrolls up when it is clicked.
const RUNTIME = `(function(){
var d={};(self.__next_f||[]).forEach(function(x){if(typeof x[1]==='string'&&x[1].charAt(0)==='{')Object.assign(d,JSON.parse(x[1]));});
document.querySelectorAll('[data-k]').forEach(function(el){if(d[el.getAttribute('data-k')])el.textContent=d[el.getAttribute('data-k')];});
var m=document.getElementById('menu-btn'),n=document.getElementById('nav');
m.addEventListener('click',function(){var o=n.classList.toggle('open');m.setAttribute('aria-expanded',o?'true':'false');});
var t=document.getElementById('theme');
t.addEventListener('click',function(){var dark=document.documentElement.getAttribute('data-theme')!=='dark';document.documentElement.setAttribute('data-theme',dark?'dark':'light');t.setAttribute('aria-label',dark?'Switch to light theme':'Switch to dark theme');});
var up=document.querySelector('.to-top');
function s(){up.classList.toggle('show',scrollY>400);}window.addEventListener('scroll',s,{passive:true});s();
up.addEventListener('click',function(){window.scrollTo({top:0,behavior:'smooth'});});
})();`;
const DATA = JSON.stringify({ h: 'Acme', a: 'Tools for builders', b: 'More about the tools' });
const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Controls</title>
<style>body{margin:0;font:18px/1.5 sans-serif}header{display:flex;gap:12px;padding:12px}.nav{display:none}.nav.open{display:block}
section{min-height:900px;padding:24px}.to-top{position:fixed;right:12px;bottom:12px;opacity:0;visibility:hidden}.to-top.show{opacity:1;visibility:visible}
[data-theme=dark] body{background:#111;color:#eee}</style>
<script src="/_next/static/chunks/main.js" defer></script></head><body>
<header><strong data-k="h">Acme</strong><button id="menu-btn" type="button" aria-expanded="false">Menu</button><nav id="nav" class="nav"><a href="/a">Tools</a> <a href="/b">About</a></nav>
<button id="theme" type="button" aria-label="Switch to dark theme">◐</button></header>
<main><section><h1 data-k="a">Tools for builders</h1><details><summary>What is it?</summary><p>A set of tools.</p></details></section>
<section><h2 data-k="b">More about the tools</h2><p>Text further down the page.</p></section></main>
<button class="to-top" type="button" aria-label="Back to top">↑</button>
<script>(self.__next_f=self.__next_f||[]).push([0])</script><script>self.__next_f.push([1,${JSON.stringify(DATA)}])</script></body></html>`;

test('in a browser: the menu, the theme switch and "Back to top" work without the framework code, the FAQ is not clicked twice', { timeout: 600000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-controls-'));
  const browser = await chromium.launch();
  try {
    const copy = path.join(root, 'copy');
    await mkdir(path.join(copy, '_next', 'static', 'chunks'), { recursive: true });
    await writeFile(path.join(copy, '_next', 'static', 'chunks', 'main.js'), RUNTIME, 'utf8');
    await writeFile(path.join(copy, 'index.html'), PAGE, 'utf8');
    const { dir, record } = await runtimeFreeCopy({ browser, copyDir: copy, outDir: path.join(root, 'out'), pages: [{ outPath: 'index.html' }] });
    const r = record.pages[0];
    assert.equal(r.status, 'removed', JSON.stringify(r));
    assert.deepEqual([...r.replay.buttons].sort(), ['Back to top', 'Menu', 'Switch to dark theme'], JSON.stringify(r.replay));
    assert.ok(r.replay.scroll >= 1, '"Back to top" appears once scrolled');
    assert.equal(r.gaps, undefined, `nothing differs: ${JSON.stringify(r.gaps)}`);
    assert.equal(record.buttons.script, '/js/sas-controls.js');
    assert.match(runtimeNotes(record).readme, /replayed by the copy's own script, `\/js\/sas-controls\.js`: 3 buttons/);
    assert.doesNotMatch(await readFile(path.join(dir, 'index.html'), 'utf8'), /main\.js/);

    const s = await serveCopy(dir);
    try {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(s.url, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      const shown = (sel) => page.evaluate((x) => getComputedStyle(document.querySelector(x)).display !== 'none' && getComputedStyle(document.querySelector(x)).visibility !== 'hidden', sel);
      // The menu opens and closes.
      assert.equal(await shown('#nav'), false);
      await page.click('#menu-btn');
      assert.equal(await shown('#nav'), true);
      assert.equal(await page.getAttribute('#menu-btn', 'aria-expanded'), 'true');
      await page.click('#menu-btn');
      assert.equal(await shown('#nav'), false);
      // The theme goes dark, light, dark.
      const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await page.click('#theme');
      assert.equal(await theme(), 'dark');
      await page.click('#theme');
      assert.equal(await theme(), 'light');
      assert.equal(await page.getAttribute('#theme', 'aria-label'), 'Switch to dark theme');
      await page.click('#theme');
      assert.equal(await theme(), 'dark');
      // The FAQ opens on the first click and closes on the second, as the browser does it (no replay on top).
      await page.click('summary');
      assert.equal(await page.evaluate(() => document.querySelector('details').open), true);
      await page.click('summary');
      assert.equal(await page.evaluate(() => document.querySelector('details').open), false);
      // "Back to top": hidden at the top, shown once scrolled, and it scrolls up.
      assert.equal(await shown('.to-top'), false);
      await page.evaluate(() => window.scrollTo({ top: 1200, behavior: 'instant' }));
      await page.waitForTimeout(300);
      assert.equal(await shown('.to-top'), true);
      await page.click('.to-top');
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => scrollY), 0);
      await page.waitForTimeout(300);
      assert.equal(await shown('.to-top'), false, 'and hides again at the top');
      assert.deepEqual(errors, []);
    } finally {
      await s.close();
    }
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
