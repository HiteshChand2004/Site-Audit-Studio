// The gate of the as-is fixes (preserve/stage.js fixAndProve + check.js fixGate), in both directions. A page's fixes are kept only
// when its picture (1440 px, frozen, scrolled, size reactions held) differs from the same page unfixed by no more than
// max(FIX_GATE_FLOOR_PCT 0.01 %, 2 × the page's own noise), at the same height, with no new console error; the noise is the
// unfixed page pictured twice. Here: a fix the page's own CSS turns into a layout change is undone (reason d); one below the first
// screen inside a section that only appears on scroll is undone too (a picture without the scroll shows no difference at all);
// on a page whose own noise is larger, a small visible fix is kept; and the floor itself, a change just under and well over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';
import { fixGate, FIX_GATE_FLOOR_PCT } from '../src/recreate/behavior/preserve/check.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { pixelDiffPct } from '../src/recreate/behavior/preserve/render.js';

const SITE = 'https://www.example-original.dev/';
const ENGLISH = 'This page is about the work we do for our customers and the people who use what we make every day. '
  + 'We write about it here so that you can find out what it is, how it works and why it matters to the people who need it.';
const head = (css) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gate test page title</title>
<meta name="description" content="A page made to test which fixes are kept and which are undone, written for the gate test.">
<style>body{margin:0;font:18px sans-serif;background:#fff}${css}</style></head>`;

async function copyOf(t, html, extra = async () => {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-gate-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-unfixed`, { recursive: true, force: true }); });
  await writeFile(path.join(dir, 'index.html'), html);
  await extra(dir);
  return dir;
}
const png = (w, h, rgb) => sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer();
const prove = (browser, dir) => fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages: [{ outPath: 'index.html', url: SITE }], siteUrl: SITE, newSiteUrl: null });

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

test('a fix the page\'s own CSS turns into a layout change is undone, reason d', { timeout: 5 * 60000 }, async (t) => {
  // img[alt] is styled bigger by the site: giving the image an alt (fixAlt) resizes it and pushes the text below it.
  const html = `${head('img{display:block;width:40px;height:40px}img[alt]{width:320px;height:160px}')}<body lang="en">
    <h1>Gallery</h1><p>${ENGLISH}</p><img src="/images/team-photo-ab12cd34ef.png"><p>Text under the picture.</p></body></html>`;
  const dir = await copyOf(t, html, async (d) => {
    await mkdir(path.join(d, 'images'), { recursive: true });
    await writeFile(path.join(d, 'images', 'team-photo-ab12cd34ef.png'), await png(40, 40, { r: 200, g: 120, b: 40 }));
  });
  const r = await prove(browser, dir);
  const page = r.pages[0];
  assert.ok(page.fixes.some((f) => f.kind === 'alt'), 'the alt fix was attempted');
  assert.equal(page.reverted?.reason, 'd', JSON.stringify(r.gate));
  assert.ok(r.gate[0].diffPct > r.gate[0].allowedPct, JSON.stringify(r.gate[0]));
  assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), html, 'the page is back as lifted');
  assert.equal(r.counts.alt, undefined, 'an undone fix is not counted');
});

test('a change below the first screen, in a section that only appears on scroll, is caught and undone', { timeout: 5 * 60000 }, async (t) => {
  // The field without a label sits 2600 px down, in a section the page shows only once it is scrolled into view. The site
  // styles a labelled field 140 px lower inside a fixed-height box: the page height does not change, only that part of it.
  const html = `${head(`.hero{height:900px;background:#eef}.gap{height:1400px}
    .r{opacity:0;transition:opacity .4s}.r.in{opacity:1}
    .box{height:400px;overflow:hidden;background:#fafafa;padding:20px}
    input{display:block;width:300px;height:40px;background:#1d4ed8;border:0}input[aria-label]{margin-top:140px}`)}<body lang="en">
    <div class="hero"><h1>Welcome</h1><p>${ENGLISH}</p></div><div class="gap"></div>
    <section class="r"><div class="box"><p>Write to us</p><input name="email"></div></section>
    <script>var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)e.target.classList.add('in');});});
    document.querySelectorAll('.r').forEach(function(el){io.observe(el);});</script></body></html>`;
  const dir = await copyOf(t, html);

  // Without the scroll, the fixed and the unfixed page are the same picture: the section is not shown on either.
  const fixedHtml = html.replace('<input name="email">', '<input name="email" aria-label="Email">');
  const noScroll = async (body) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.setContent(body);
    await p.waitForTimeout(500);
    const shot = await p.screenshot({ fullPage: true });
    await ctx.close();
    const { data } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return data;
  };
  assert.equal(pixelDiffPct(await noScroll(fixedHtml), await noScroll(html)), 0, 'a picture without the scroll sees no difference');

  const r = await prove(browser, dir);
  assert.ok(r.pages[0].fixes.some((f) => f.kind === 'names' && f.value === 'Email'), JSON.stringify(r.pages[0].fixes));
  assert.equal(r.pages[0].reverted?.reason, 'd', JSON.stringify(r.gate));
  assert.equal(r.gate[0].heights[0], r.gate[0].heights[1], 'same height: caught by the pixels, not by the height rule');
  assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), html);
});

test('on a page whose own noise is larger, a small visible fix is kept', { timeout: 5 * 60000 }, async (t) => {
  // A 300 x 300 canvas of random pixels: every load differs (~7 % of a 1440 x 900 page). The fix sets <html lang> (detectLang),
  // and the site colours a 20 x 20 mark when lang is set: a real but small change, well inside twice the noise.
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Gate test page title</title>
    <meta name="description" content="A page made to test which fixes are kept and which are undone, written for the gate test.">
    <style>body{margin:0;font:18px sans-serif;background:#fff;height:900px;overflow:hidden}.mark{width:20px;height:20px;background:#ddd}html[lang] .mark{background:#c00}</style></head>
    <body><p>${ENGLISH}</p><div class="mark"></div><canvas id="c" width="300" height="300"></canvas>
    <script>var c=document.getElementById('c').getContext('2d'),d=c.createImageData(300,300);
    for(var i=0;i<d.data.length;i+=4){d.data[i]=Math.random()*255;d.data[i+1]=Math.random()*255;d.data[i+2]=Math.random()*255;d.data[i+3]=255;}
    c.putImageData(d,0,0);</script></body></html>`;
  const dir = await copyOf(t, html);
  const r = await prove(browser, dir);
  const g = r.gate[0];
  assert.ok(r.pages[0].fixes.some((f) => f.kind === 'lang'), JSON.stringify(r.pages[0].fixes));
  assert.ok(g.noisePct > 1, `the page's own noise was measured (${g.noisePct} %)`);
  assert.ok(g.diffPct > g.noisePct * 0.5 && g.diffPct <= g.allowedPct, JSON.stringify(g));
  assert.equal(r.pages[0].reverted, undefined, 'kept');
  assert.match(await readFile(path.join(dir, 'index.html'), 'utf8'), /<html lang="en"/);
});

test('the floor in both directions: a change under 0.01 % is kept, one well over it is not', { timeout: 5 * 60000 }, async (t) => {
  // No noise at all (a still page), so the floor decides. 2 x 2 px of 1440 x 900 = 0.0003 %; 60 x 60 px = 0.28 %.
  const page = (dot) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;height:900px;overflow:hidden;background:#fff}
    i{position:absolute;left:600px;top:400px;width:${dot}px;height:${dot}px;background:#c00}</style></head><body>${dot ? '<i></i>' : ''}</body></html>`;
  const serve = async (body) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-floor-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(path.join(dir, 'index.html'), body);
    const s = await serveCopy(dir);
    t.after(() => s.close());
    return s.url.replace(/\/$/, '');
  };
  const unfixed = await serve(page(0));
  const tiny = await fixGate(browser, await serve(page(2)), unfixed, '/');
  const big = await fixGate(browser, await serve(page(60)), unfixed, '/');
  assert.equal(tiny.noisePct, 0);
  assert.equal(tiny.allowedPct, FIX_GATE_FLOOR_PCT);
  assert.ok(tiny.diffPct > 0 && tiny.diffPct <= FIX_GATE_FLOOR_PCT && tiny.invisible, JSON.stringify(tiny));
  assert.ok(big.diffPct > FIX_GATE_FLOOR_PCT && !big.invisible, JSON.stringify(big));
});
