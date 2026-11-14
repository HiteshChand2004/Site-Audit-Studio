// The start states a removed runtime leaves behind (behavior/preserve/startStates.js). An animation library renders an element's
// entrance into the server HTML as its first frame (`style="opacity:0;transform:translateY(24px)"`) and its script animates it
// in. Written without that script, the page kept the first frame for good: the copy's rebuilt reveal faded the section in and
// it fell back to opacity 0 (testpilot.panscience.ai: the homepage demo and every section below it never showed). Here a
// "framework" page like that is captured for real and converted; every part the original shows must show in the copy, with
// and without script, and a part the original keeps hidden stays hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { capturePage } from '../src/recreate/capture/index.js';
import { declarationsOf, settledStyles, withoutStartStates } from '../src/recreate/behavior/preserve/startStates.js';
import { runtimeFreeCopy } from '../src/recreate/behavior/preserve/runtimeFree.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const START = 'opacity:0;transform:translateY(24px)';
// The framework: it redraws the text from its own data, brings the first-screen picture in as the page opens and every
// [data-fade] section in as it comes into view. The "ghost" box it never touches: hidden on purpose.
const RUNTIME = `(function(){
var d={};(self.__next_f||[]).forEach(function(x){if(typeof x[1]==='string'&&x[1].charAt(0)==='{')Object.assign(d,JSON.parse(x[1]));});
document.querySelectorAll('[data-k]').forEach(function(el){if(d[el.getAttribute('data-k')])el.textContent=d[el.getAttribute('data-k')];});
function show(el){el.style.transition='opacity .4s ease, transform .4s ease';el.style.opacity='1';el.style.transform='none';}
document.querySelectorAll('[data-enter]').forEach(function(el){setTimeout(function(){show(el);},150);});
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){show(e.target);io.unobserve(e.target);}});},{threshold:0.1});
document.querySelectorAll('[data-fade]').forEach(function(el){io.observe(el);});
})();`;
const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Start states</title>
<style>body{margin:0;font:18px/1.5 sans-serif}section{min-height:700px;padding:40px}.demo{width:320px;height:180px;background:#335}.ghost{position:absolute;top:0;right:0;width:40px;height:40px;background:#c00}</style>
<script src="/_next/static/chunks/main.js" defer></script></head><body>
<header><h1 data-k="t">Top of the page</h1><div data-enter style="${START}"><div class="demo"></div></div></header>
<main><section><h2 data-k="a">First part</h2><p data-k="p">Text that is there at once.</p></section>
<section data-fade style="scroll-margin-top:80px;${START}"><h2 data-k="b">Second part</h2><p>A section that rises into view.</p></section>
<section data-fade style="${START}"><h2 data-k="c">Third part</h2><p>Another one further down.</p></section></main>
<div class="ghost" style="opacity:0"></div>
<script>(self.__next_f=self.__next_f||[]).push([0])</script><script>self.__next_f.push([1,${JSON.stringify(JSON.stringify({ t: 'Top of the page', a: 'First part', p: 'Text that is there at once.', b: 'Second part', c: 'Third part' }))}])</script></body></html>`;

test('declarations split on the semicolons between them only', () => {
  assert.deepEqual(declarationsOf('opacity:0; background:url("a;b.png") ; transform: translate(0, 4px) !important').map((d) => [d.prop, d.value]),
    [['opacity', '0'], ['background', 'url("a;b.png")'], ['transform', 'translate(0, 4px)']]);
});

test('only a start state the capture saw taken away is dropped', () => {
  const settled = new Map([
    ['body>div:1', { tag: 'div', cls: 'a b', style: {} }], // shown, in place
    ['body>div:2', { tag: 'div', cls: '', style: { opacity: '0' } }], // hidden on the original too
    ['body>div:3', { tag: 'div', cls: 'other', style: {} }], // another element at that place
    ['body>p:1', { tag: 'p', cls: '', style: { transform: 'matrix(1, 0, 0, 1, 0, 30)' } }], // moved on the original too
  ]);
  const html = `<html><body><div class="b a" style="color:red;opacity:0;transform:translateY(18px)">1</div><div style="opacity:0">2</div>
<div class="mine" style="opacity:0">3</div><p style="opacity:0;transform:translateY(30px)">4</p></body></html>`;
  const r = withoutStartStates(html, settled);
  assert.equal(r.cleared, 2);
  assert.equal(r.declarations, 3);
  assert.match(r.html, /<div class="b a" style="color:red">1<\/div>/);
  assert.match(r.html, /<div style="opacity:0">2<\/div>/);
  assert.match(r.html, /<div class="mine" style="opacity:0">3<\/div>/);
  assert.match(r.html, /<p style="transform:translateY\(30px\)">4<\/p>/, 'the opacity goes, the move the original kept stays');
  assert.equal(withoutStartStates(html, null).html, html);
});

test('in a browser: what the framework brought in shows without it, with and without script', { timeout: 300000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-start-states-'));
  const server = createServer((req, res) => {
    if (req.url.startsWith('/_next/static/chunks/main.js')) res.writeHead(200, { 'content-type': 'text/javascript' }).end(RUNTIME);
    else if (req.url === '/' || req.url === '/index.html') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const job = path.join(root, 'job');
    const info = { url: `${origin}/`, path: '/', outPath: 'index.html', slug: 'index', source: 'home' };
    const captured = await capturePage(browser, info, job, { motionBudgetMs: 20000, clickBudgetMs: 0 });
    assert.deepEqual(captured.errors, []);
    await writeFile(path.join(job, 'capture', 'manifest.json'), JSON.stringify({ origin, homeUrl: `${origin}/`, pages: [{ ...info, views: captured.views }] }), 'utf8');
    const pages = [{ outPath: 'index.html' }];
    const settled = await settledStyles({ dir: job, pages });
    assert.ok(settled.get('index.html')?.size > 5, 'the capture read the page');

    const lifted = path.join(root, 'lifted');
    await mkdir(path.join(lifted, '_next', 'static', 'chunks'), { recursive: true });
    await writeFile(path.join(lifted, 'index.html'), PAGE, 'utf8');
    await writeFile(path.join(lifted, '_next', 'static', 'chunks', 'main.js'), RUNTIME, 'utf8');
    const free = await runtimeFreeCopy({ browser, copyDir: lifted, outDir: path.join(root, 'source'), pages, jobDir: job });
    const rec = free.record.pages[0];
    assert.equal(rec.status, 'removed', JSON.stringify(rec));
    assert.deepEqual(rec.shown, { elements: 3, declarations: 6 }, JSON.stringify(rec));
    const out = await readFile(path.join(free.dir, 'index.html'), 'utf8');
    assert.doesNotMatch(out, /main\.js|__next_f/);
    assert.match(out, /style="scroll-margin-top:80px"/, 'the rest of an inline style stays');
    assert.match(out, /class="ghost" style="opacity:0"/, 'hidden on the original, hidden in the copy');

    const s = await serveCopy(free.dir);
    try {
      for (const javaScriptEnabled of [true, false]) {
        const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, javaScriptEnabled })).newPage();
        await page.goto(s.url, { waitUntil: 'load' });
        await page.waitForTimeout(1200);
        const opacity = (sel, i = 0) => page.evaluate(([q, n]) => parseFloat(getComputedStyle(document.querySelectorAll(q)[n]).opacity), [sel, i]);
        const top = (sel, i = 0) => page.evaluate(([q, n]) => document.querySelectorAll(q)[n].getBoundingClientRect().top + scrollY, [sel, i]);
        const side = javaScriptEnabled ? 'with script' : 'without script';
        assert.equal(await opacity('[data-enter]'), 1, `the first-screen picture shows (${side})`);
        for (const i of [0, 1]) {
          await page.evaluate((n) => document.querySelectorAll('[data-fade]')[n].scrollIntoView({ block: 'center' }), i);
          await page.waitForTimeout(1500);
          assert.equal(await opacity('[data-fade]', i), 1, `section ${i + 2} shows once scrolled to, and stays (${side})`);
        }
        assert.equal(await opacity('.ghost'), 0, `the ghost stays hidden (${side})`);
        // In place: the start state's 24 px drop is gone with it.
        const sectionTop = await top('[data-fade]', 1);
        const prevBottom = await page.evaluate(() => { const r = document.querySelectorAll('[data-fade]')[0].getBoundingClientRect(); return r.bottom + scrollY; });
        assert.ok(Math.abs(sectionTop - prevBottom) < 1, `no offset left: ${sectionTop} vs ${prevBottom} (${side})`);
        await page.context().close();
      }
    } finally {
      await s.close();
    }
  } finally {
    await browser.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
