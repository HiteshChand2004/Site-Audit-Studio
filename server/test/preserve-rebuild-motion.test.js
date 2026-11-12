// The original's animations rebuilt on an as-is copy's own page, without the original's code (behavior/preserve/
// rebuildMotion.js): the page of a "framework" whose script fades sections in on scroll and colours a button on hover is
// captured for real, its framework code is taken out, and the copy's own script and rules must do the same in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { capturePage } from '../src/recreate/capture/index.js';
import { elementAt, MOTION_STYLE_ATTR, rebuildMotion } from '../src/recreate/behavior/preserve/rebuildMotion.js';
import { runtimeNotes, withoutRuntime } from '../src/recreate/convert/runtime.js';
import { runtimeFreeCopy } from '../src/recreate/behavior/preserve/runtimeFree.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

// What the framework does in the browser: every [data-fade] section starts lowered and transparent and rises once it comes
// into view; the button turns red under the mouse. All of it from script, none of it in the stylesheet.
const RUNTIME = `(function(){
var d={};(self.__next_f||[]).forEach(function(x){if(typeof x[1]==='string'&&x[1].charAt(0)==='{')Object.assign(d,JSON.parse(x[1]));});
document.querySelectorAll('[data-k]').forEach(function(el){if(d[el.getAttribute('data-k')])el.textContent=d[el.getAttribute('data-k')];});
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.style.opacity='1';e.target.style.transform='none';io.unobserve(e.target);}});},{threshold:0.1});
document.querySelectorAll('[data-fade]').forEach(function(el){el.style.transition='opacity .4s ease, transform .4s ease';el.style.opacity='0';el.style.transform='translateY(24px)';io.observe(el);});
var bar=document.getElementById('bar');function prog(){var m=document.documentElement.scrollHeight-innerHeight;bar.style.transform='scaleX('+(m>0?scrollY/m:0)+')';}window.addEventListener('scroll',prog,{passive:true});prog();
var b=document.getElementById('cta');b.addEventListener('mouseenter',function(){b.style.backgroundColor='rgb(200, 0, 0)';});b.addEventListener('mouseleave',function(){b.style.backgroundColor='';});
})();`;
const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Fade</title>
<style>body{margin:0;font:18px/1.5 sans-serif}section{min-height:700px;padding:40px}#cta{background:rgb(20,20,120);color:#fff;border:0;padding:12px 20px}
.bar{position:fixed;top:0;left:0;right:0;height:4px;background:#0a0;transform-origin:0 0;transform:scaleX(0)}</style>
<script src="/_next/static/chunks/main.js" defer></script></head><body>
<header><h1 data-k="t">Top of the page</h1><button id="cta" type="button">Start now</button></header>
<main><section><h2 data-k="a">First part</h2><p data-k="p">Text that is there at once.</p></section>
<section data-fade><h2 data-k="b">Second part</h2><p>A section that rises into view.</p></section>
<section data-fade><h2 data-k="c">Third part</h2><p>Another one further down.</p></section></main>
<div class="bar" id="bar"></div>
<script>(self.__next_f=self.__next_f||[]).push([0])</script><script>self.__next_f.push([1,${JSON.stringify(JSON.stringify({ t: 'Top of the page', a: 'First part', p: 'Text that is there at once.', b: 'Second part', c: 'Third part' }))}])</script></body></html>`;

test('elementAt finds an element by its capture path', () => {
  const $ = cheerio.load('<html><body><header><nav><a>1</a><a>2</a></nav></header><main><section></section><section><h2>x</h2></section></main></body></html>');
  assert.equal($(elementAt($, 'body>main:1>section:2>h2:1')).text(), 'x');
  assert.equal($(elementAt($, 'body>header:1>nav:1>a:2')).text(), '2');
  assert.equal(elementAt($, 'body>main:1>section:3'), null);
  assert.equal(elementAt($, 'html>body:1'), null);
});

test('in a browser: the scroll fade-in and the hover come back without the framework code', { timeout: 300000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-rebuild-motion-'));
  const server = createServer((req, res) => {
    if (req.url.startsWith('/_next/static/chunks/main.js')) res.writeHead(200, { 'content-type': 'text/javascript' }).end(RUNTIME);
    else if (req.url === '/' || req.url === '/index.html') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    // The capture of the original, as an as-is copy makes it, and its page set.
    const job = path.join(root, 'job');
    const info = { url: `${origin}/`, path: '/', outPath: 'index.html', slug: 'index', source: 'home' };
    const captured = await capturePage(browser, info, job, { motionBudgetMs: 20000, clickBudgetMs: 0 });
    assert.deepEqual(captured.errors, []);
    await writeFile(path.join(job, 'capture', 'manifest.json'), JSON.stringify({ origin, homeUrl: `${origin}/`, pages: [{ ...info, views: captured.views }] }), 'utf8');
    const motion = JSON.parse(await readFile(path.join(job, 'capture', 'index', 'motion.json'), 'utf8'));
    assert.ok((motion.reveal?.elements ?? []).length >= 2, `the capture saw the sections rise: ${JSON.stringify(motion.reveal?.stats ?? motion.reveal).slice(0, 300)}`);

    // The copy: the page as the server sent it, without the framework code.
    const copy = path.join(root, 'copy');
    await mkdir(copy, { recursive: true });
    await writeFile(path.join(copy, 'index.html'), withoutRuntime(PAGE).html, 'utf8');
    const pages = [{ outPath: 'index.html' }];
    const r = await rebuildMotion({ dir: job, copyDir: copy, pages });
    assert.ok(r.placed >= 2, JSON.stringify(r.pages));
    assert.equal(r.script, '/js/motion.js');
    const html = await readFile(path.join(copy, 'index.html'), 'utf8');
    assert.match(html, new RegExp(`<style ${MOTION_STYLE_ATTR}(="")?>`));
    assert.doesNotMatch(html, /main\.js|__next_f/);
    // Once is enough: a second run leaves the page alone.
    const again = await rebuildMotion({ dir: job, copyDir: copy, pages });
    assert.equal(again.pages[0].already, true);

    const s = await serveCopy(copy);
    try {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(s.url, { waitUntil: 'load' });
      await page.waitForTimeout(600);
      const opacityOf = (n) => page.evaluate((i) => parseFloat(getComputedStyle(document.querySelectorAll('[data-fade]')[i]).opacity), n);
      assert.ok(await opacityOf(1) < 0.5, 'the third part waits below the fold, hidden');
      await page.evaluate(() => document.querySelectorAll('[data-fade]')[1].scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(1200);
      assert.ok(await opacityOf(1) > 0.95, 'and rises once scrolled to');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      await page.hover('#cta');
      await page.waitForTimeout(600);
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('cta')).backgroundColor), 'rgb(200, 0, 0)', 'the hover colour');
      // The progress bar the framework grew with the scroll (its stylesheet starts it at scaleX(0)) grows in the copy too.
      const barWidth = () => page.evaluate(() => document.getElementById('bar').getBoundingClientRect().width / innerWidth);
      assert.ok(await barWidth() < 0.05, 'empty at the top');
      await page.evaluate(() => window.scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) / 2, behavior: 'instant' }));
      await page.waitForTimeout(400);
      const half = await barWidth();
      assert.ok(half > 0.35 && half < 0.65, `half way at half the page: ${half}`);
      assert.ok(await page.evaluate(() => document.getElementById('bar').getBoundingClientRect().height) > 3, 'its height kept');
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.waitForTimeout(300);
      assert.deepEqual(errors, []);
      // And what the owner changes stays (no framework draws over it).
      await writeFile(path.join(copy, 'index.html'), html.replace('Top of the page', 'Changed by the owner'), 'utf8');
      const s2 = await serveCopy(copy);
      try {
        await page.goto(s2.url, { waitUntil: 'load' });
        await page.waitForTimeout(600);
        assert.match(await page.textContent('h1'), /Changed by the owner/);
      } finally {
        await s2.close();
      }
    } finally {
      await s.close();
    }

    // The whole proof (runtimeFree.js) on the copy as lifted, framework code and all: without that code and with the rebuilt
    // animations, the page looks and works like the page with it, so the code goes and the animations come with the page.
    const lifted = path.join(root, 'lifted');
    await mkdir(path.join(lifted, '_next', 'static', 'chunks'), { recursive: true });
    await writeFile(path.join(lifted, 'index.html'), PAGE, 'utf8');
    await writeFile(path.join(lifted, '_next', 'static', 'chunks', 'main.js'), RUNTIME, 'utf8');
    const free = await runtimeFreeCopy({ browser, copyDir: lifted, outDir: path.join(root, 'source'), pages, jobDir: job });
    const rec = free.record.pages[0];
    assert.equal(rec.status, 'removed', JSON.stringify(rec));
    assert.ok(rec.rebuilt.placed >= 2, JSON.stringify(rec.rebuilt));
    assert.equal(rec.gaps, undefined, 'nothing differs');
    assert.equal(free.record.animations.script, '/js/motion.js');
    const out = await readFile(path.join(free.dir, 'index.html'), 'utf8');
    assert.doesNotMatch(out, /main\.js|__next_f/);
    assert.match(out, /data-motion="rv r1"/);
    assert.equal(await readFile(path.join(free.dir, 'js', 'motion.js'), 'utf8').then((t) => t.length > 1000), true, 'the script is beside the page');
    assert.equal(await readFile(path.join(free.dir, '_next', 'static', 'chunks', 'main.js'), 'utf8').catch(() => null), null, 'the framework file is gone');
    const notes = runtimeNotes(free.record);
    assert.match(notes.readme, /rebuilt with the copy's own small script, `\/js\/motion\.js`/);
    assert.match(notes.readme, /looks the same at phone and computer width/);
    assert.deepEqual(notes.items, []);
  } finally {
    await browser.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
