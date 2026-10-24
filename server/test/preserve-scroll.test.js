// The as-is warm-up scroll (preserve/scroll.js scrollThrough) and the size-reaction hold the visual check pictures under
// (verify/exact/freeze.js holdSizeReactions), the two general causes of an unstable picture on a tall page:
// - the scroll goes to the page's own bottom (before 2026-10-24: a fixed 14 000 px, under a phone layout's height), follows a
//   page that grows while it is scrolled, and ends at its time cap on one that never stops growing, saying so;
// - the full-page picture (Chromium grows the window to the page's height for it) fires the page's resize / media-query /
//   ResizeObserver reactions — when, relative to the capture, is up to the browser, which is why it showed as a race on a real
//   site; held, none of them reaches the page and the picture is the page as a visitor sees it, at the phone width as at the
//   desktop's (the race was only ever observed at 1440; this is the proof for 390 the handoff asked for).
// Related tests only: run alone with SAS_TEST_BROWSER_CONCURRENCY=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { scrollThrough, SCROLL_MAX_MS } from '../src/recreate/behavior/preserve/scroll.js';
import { openAndScroll, holdSizeReactions } from '../src/recreate/behavior/preserve/check.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { exactDiff } from '../src/recreate/verify/exact/pixels.js';

const TALL = 20000;
const META = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
/** A TALL px page whose block at 17 000 px is drawn only once an IntersectionObserver has seen it (a scroll-revealed part). */
const LAZY_PAGE = `<!doctype html><html><head>${META}<title>Tall page</title>
<style>body{margin:0;height:${TALL}px;background:#fff}#late{position:absolute;top:17000px;left:100px;width:300px;height:120px;background:#06c;opacity:0}#late.in{opacity:1}</style></head>
<body><div id="late"></div><script>new IntersectionObserver((es)=>es.forEach((e)=>{if(e.isIntersecting){e.target.classList.add('in');e.target.textContent='seen'}})).observe(document.getElementById('late'))</script></body></html>`;
/** A page that grows by 3 000 px every time its bottom comes into view: an endless feed. */
const ENDLESS_PAGE = `<!doctype html><html><head>${META}<title>Endless page</title><style>body{margin:0}section{height:3000px;background:#eee}</style></head>
<body><section></section><script>addEventListener('scroll',()=>{if(scrollY+innerHeight>=document.documentElement.scrollHeight-800){const s=document.createElement('section');document.body.appendChild(s)}})</script></body></html>`;
/**
 * A page that re-lays itself out on any size reaction once armed (a resize listener, a media-query listener, a ResizeObserver):
 * three columns become one and paint wide red bands — what a full-page picture provokes without the hold.
 */
const REACTIVE_PAGE = `<!doctype html><html><head>${META}<title>Reactive page</title>
<style>body{margin:0;height:4000px;background:#fff}.cols{display:flex;gap:10px;padding:20px}.cols div{flex:1;height:200px;background:#09c}
body.tall .cols{display:block}body.tall .cols div{height:60px;background:#c00;margin:0 0 10px}</style></head>
<body><div class="cols"><div></div><div></div><div></div></div>
<script>window.__fired={resize:0,mql:0,ro:0};
const react=(k)=>{if(!window.__armed)return;__fired[k]++;document.body.classList.add('tall')};
addEventListener('resize',()=>react('resize'));
matchMedia('(orientation: portrait)').addEventListener('change',()=>react('mql'));
new ResizeObserver(()=>react('ro')).observe(document.documentElement);</script></body></html>`;

let browser;
const servers = [];
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => {
  for (const s of servers) await s.close().catch(() => {});
  await browser.close();
});

async function serve(t, html) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-scroll-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), html);
  const s = await serveCopy(dir);
  servers.push(s);
  return `${s.url.replace(/\/$/, '')}/`;
}

test('the scroll-through reaches the bottom of a page taller than 14 000 px: a part revealed at 17 000 px is drawn', { timeout: 120000 }, async (t) => {
  const url = await serve(t, LAZY_PAGE);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  const view = await page.evaluate(() => innerHeight);
  const r = await scrollThrough(page);
  assert.equal(r.height, TALL);
  assert.equal(r.capped, false);
  const expected = Math.ceil((TALL - view) / 400) + 1; // one step per 400 px until the bottom is on screen
  assert.ok(Math.abs(r.steps - expected) <= 2, `one step per 400 px to the bottom: ${r.steps} (about ${expected} for a ${view} px window)`);
  assert.equal(await page.evaluate(() => document.getElementById('late').textContent), 'seen', 'the part below 14 000 px was brought into view');
  // The check's own warm-up uses it and returns to the top.
  const r2 = await openAndScroll(page, url);
  assert.equal(r2.height, TALL);
  assert.equal(await page.evaluate(() => scrollY), 0);
});

test('a page that keeps growing as its bottom comes into view ends at the time cap, and says so', { timeout: 120000 }, async (t) => {
  const url = await serve(t, ENDLESS_PAGE);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  const r = await scrollThrough(page, { maxMs: 2500 });
  assert.equal(r.capped, true);
  assert.ok(r.height > 6000, `it followed the page as it grew: ${r.height} px`);
  assert.ok(r.ms >= 2500 && r.ms < 2500 + 1500, `ended at the cap, not long after it: ${r.ms} ms`);
  assert.ok(SCROLL_MAX_MS <= 30000, 'the production cap stays within a page-level time limit');
});

for (const [width, height, mobile] of [[390, 844, true], [1440, 900, false]]) {
  test(`at ${width}: without the hold the full-page picture fires the page's size reactions, which re-lay it out; held, none reaches the page and the picture is the visitor's`, { timeout: 120000 }, async (t) => {
    const url = await serve(t, REACTIVE_PAGE);
    const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
    t.after(() => ctx.close());
    await ctx.addInitScript(holdSizeReactions);
    const page = await ctx.newPage();
    const state = () => page.evaluate(() => ({ ...window.__fired, tall: document.body.classList.contains('tall'), view: innerHeight }));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    assert.equal((await state()).view, height, 'the window is the viewport (the page has a viewport meta)');
    const firstScreen = await page.screenshot({ type: 'png' }); // the first screen as the visitor has it
    // Without the hold: the picture's window is 4 000 px tall; the page's reactions run — during the capture or just after it
    // (the browser's timing: the race), either way the page is re-laid out by the time the next picture is taken.
    await page.evaluate(() => { window.__sasHoldSize = false; window.__armed = true; });
    await page.screenshot({ fullPage: true, type: 'png' });
    await page.waitForTimeout(300);
    const fired = await state();
    assert.ok(fired.resize + fired.mql + fired.ro > 0, `the page's reactions ran because of the picture: ${JSON.stringify(fired)}`);
    assert.equal(fired.tall, true, 'and re-laid the page out');
    const reacted = await page.screenshot({ fullPage: true, type: 'png' });
    // The page again, held: nothing of the page's runs, and two pictures are the same picture.
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__sasHoldSize = true; window.__armed = true; });
    const held = await page.screenshot({ fullPage: true, type: 'png' });
    const held2 = await page.screenshot({ fullPage: true, type: 'png' });
    await page.waitForTimeout(300);
    const quiet = await state();
    assert.deepEqual(quiet, { resize: 0, mql: 0, ro: 0, tall: false, view: height }, `held: no reaction reached the page: ${JSON.stringify(quiet)}`);
    assert.equal((await exactDiff(held, held2, { threshold: 0.05 })).commonPct, 0, 'two held pictures are identical');
    const d = await exactDiff(held, reacted, { threshold: 0.05 });
    assert.ok(d.commonPct > 0.5, `the re-laid-out page is another picture: ${d.commonPct} % differs`);
    // The held picture's top is the visitor's first screen (rows only the taller picture has are left out of commonPct).
    const top = await exactDiff(firstScreen, held, { threshold: 0.05 });
    assert.equal(top.commonPct, 0, `the held picture's top ${height} px = the first screen: ${JSON.stringify({ common: top.commonPct, heights: top.heights })}`);
  });
}
