// The gate of the as-is fixes (preserve/stage.js fixAndProve + check.js fixGate), in both directions. A page's fixes are kept only
// when its picture (375 and 1440 px, frozen, scrolled, size reactions held) has not one pixel different from the same page unfixed outside
// the places the page moves by itself (the noise map: wherever any two of three unfixed pictures differ), at the same size, with no
// new console error. One ruler: verify/exact/pixels.js exactDiff. Here: a fix the page's own CSS turns into a layout change is
// undone (reason d); one below the first screen inside a section that only appears on scroll is undone too; on a page with a noisy
// part, a visible fix elsewhere is undone and a fix that changes nothing is kept; and the smallest changes — 2 x 2 px, a pale
// square, a change far down a tall page — are seen, while an unchanged page passes. Both widths (375, 1440) are checked, and a
// page's fixes are dropped by group, not all at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';
import { fixGate, gateVerdict } from '../src/recreate/behavior/preserve/check.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { exactDiff } from '../src/recreate/verify/exact/pixels.js';

const SITE = 'https://www.example-original.dev/';
const ENGLISH = 'This page is about the work we do for our customers and the people who use what we make every day. '
  + 'We write about it here so that you can find out what it is, how it works and why it matters to the people who need it.';
// The page states its theme colour and icon, so each test meets only the fixes it was written for (Step 3 adds them when missing).
const head = (css) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gate test page title</title><meta name="theme-color" content="#c2410c"><link rel="icon" href="data:,">
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
const prove = (browser, dir) => fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages: [{ outPath: 'index.html', url: SITE }], siteUrl: SITE, newSiteUrl: null, speed: false });
// A page that already states what the head fixes would add (og tags, and the Organization / WebSite data a homepage gets), so
// a test decides which groups of fixes it has: the image's alt, and the language only when `lang` is left out.
const stated = (css, { lang = true } = {}) => head(css)
  .replace('<html>', lang ? '<html lang="en">' : '<html>')
  .replace('</head>', '<meta property="og:title" content="Gate test page title">'
    + '<meta property="og:description" content="A page made to test which fixes are kept and which are undone, written for the gate test.">'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":["Organization","WebSite"],"name":"Gate"}</script></head>');
const IMG = '<img src="/images/team-photo-ab12cd34ef.png">';
const withImage = async (d) => {
  await mkdir(path.join(d, 'images'), { recursive: true });
  await writeFile(path.join(d, 'images', 'team-photo-ab12cd34ef.png'), await png(40, 40, { r: 200, g: 120, b: 40 }));
};

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

test('a fix the page\'s own CSS turns into a layout change is caught; only that group of fixes is dropped, reason d', { timeout: 5 * 60000 }, async (t) => {
  // img[alt] is styled bigger by the site: giving the image an alt (fixAlt) resizes it and pushes the text below it.
  const html = `${head('img{display:block;width:40px;height:40px}img[alt]{width:320px;height:160px}')}<body lang="en">
    <h1>Gallery</h1><p>${ENGLISH}</p><img src="/images/team-photo-ab12cd34ef.png"><p>Text under the picture.</p></body></html>`;
  const dir = await copyOf(t, html, async (d) => {
    await mkdir(path.join(d, 'images'), { recursive: true });
    await writeFile(path.join(d, 'images', 'team-photo-ab12cd34ef.png'), await png(40, 40, { r: 200, g: 120, b: 40 }));
  });
  const r = await prove(browser, dir);
  const page = r.pages[0];
  assert.equal(page.reverted, undefined, 'the page keeps its other fixes');
  assert.deepEqual(page.dropped.map((d) => d.group), ['alt'], JSON.stringify(r.gate));
  assert.ok(r.gate[0].changedPx > 0 || r.gate[0].sizeChanged, JSON.stringify(r.gate[0]));
  const now = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.doesNotMatch(now, /<img[^>]*\balt=/, 'the image is as lifted');
  assert.match(now, /<html lang="en"/, 'the language, which changes nothing, is kept');
  assert.equal(r.counts.alt, undefined, 'a dropped fix is not counted');
  assert.equal(r.counts.lang, 1);
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
    return shot;
  };
  assert.equal((await exactDiff(await noScroll(html), await noScroll(fixedHtml))).diff, 0, 'a picture without the scroll sees no difference');

  const r = await prove(browser, dir);
  assert.equal(r.pages[0].reverted, undefined, JSON.stringify(r.gate));
  assert.deepEqual(r.pages[0].dropped.map((d) => d.group), ['names'], JSON.stringify(r.gate));
  assert.equal(r.gate[0].heights[0], r.gate[0].heights[1], 'same height: caught by the pixels, not by the height rule');
  assert.ok(r.gate[0].changedPx > 0, JSON.stringify(r.gate[0]));
  const now = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.doesNotMatch(now, /aria-label="Email"/, 'the field is as lifted');
  assert.match(now, /<html lang="en"/);
});

// A page with a part that moves by itself: a 300 x 300 canvas of random pixels, different on every load.
const noisyPage = (markCss) => `<!doctype html><html><head><meta charset="utf-8"><title>Gate test page title</title><meta name="theme-color" content="#c2410c"><link rel="icon" href="data:,">
    <meta name="description" content="A page made to test which fixes are kept and which are undone, written for the gate test.">
    <style>body{margin:0;font:18px sans-serif;background:#fff;height:900px;overflow:hidden}.mark{width:20px;height:20px;background:#ddd}${markCss}</style></head>
    <body><p>${ENGLISH}</p><div class="mark"></div><canvas id="c" width="300" height="300"></canvas>
    <script>var c=document.getElementById('c').getContext('2d'),d=c.createImageData(300,300);
    for(var i=0;i<d.data.length;i+=4){d.data[i]=Math.random()*255;d.data[i+1]=Math.random()*255;d.data[i+2]=Math.random()*255;d.data[i+3]=255;}
    c.putImageData(d,0,0);</script></body></html>`;

test('on a page with a noisy part, a small visible fix elsewhere is undone (the noise no longer hides it)', { timeout: 5 * 60000 }, async (t) => {
  // The fix sets <html lang> (detectLang); the site colours a 20 x 20 mark red when lang is set. Before 2026-10-23 this was KEPT:
  // 400 px is a small share of the page next to the canvas's noise. It is a visible change, away from the part that moves.
  const dir = await copyOf(t, noisyPage('html[lang] .mark{background:#c00}'));
  const r = await prove(browser, dir);
  const g = r.gate[0];
  assert.ok(g.noiseShare > 1, `the page's own noise was mapped (${JSON.stringify(g)})`);
  // The mark sits right above the canvas: the part of it within the noise map's 8 px margin is counted as in the noise, the
  // rest as a visible change. Either way the fix is undone.
  assert.ok(g.changedPx > 0 && g.changedPx + g.inNoisePx >= 400, `the mark's change is seen (${JSON.stringify(g)})`);
  assert.equal(r.pages[0].reverted, undefined, 'the fixes that change nothing are kept');
  const lang = r.pages[0].dropped?.find((d) => d.group === 'lang');
  assert.ok(lang, JSON.stringify(r.pages[0]));
  assert.match(lang.why, /px where the page does not move by itself/);
  assert.doesNotMatch(await readFile(path.join(dir, 'index.html'), 'utf8'), /<html lang=/);
});

test('on the same noisy page, a fix that changes nothing visible is kept', { timeout: 5 * 60000 }, async (t) => {
  const dir = await copyOf(t, noisyPage(''));
  const r = await prove(browser, dir);
  const g = r.gate[0];
  assert.ok(r.pages[0].fixes.some((f) => f.kind === 'lang'), JSON.stringify(r.pages[0].fixes));
  assert.ok(g.inNoisePx > 1000, `the canvas differs between loads, inside the noise map (${JSON.stringify(g)})`);
  assert.equal(g.changedPx, 0, JSON.stringify(g));
  assert.equal(r.pages[0].reverted, undefined, 'kept');
  assert.match(await readFile(path.join(dir, 'index.html'), 'utf8'), /<html lang="en"/);
  assert.deepEqual(g.views.map((v) => v.width), [375, 1440], 'proved at both widths');
  assert.equal(g.width, null, 'no width failed');
});

test('a fix that shows only on a phone is caught at 375 px and undone; the computer width is not rendered', { timeout: 5 * 60000 }, async (t) => {
  const html = `${stated('img{display:block;width:40px;height:40px}@media (max-width:600px){img[alt]{width:320px;height:160px}}')}<body>
    <h1>Gallery</h1><p>${ENGLISH}</p>${IMG}<p>Text under the picture.</p></body></html>`;
  const dir = await copyOf(t, html, withImage);
  const r = await prove(browser, dir);
  const page = r.pages[0];
  assert.deepEqual([...new Set(page.fixes.map((f) => f.kind))], ['alt'], 'the image is the only thing to fix');
  assert.equal(r.gate.length, 1, 'one group: no retry');
  assert.equal(r.gate[0].width, 375, JSON.stringify(r.gate[0]));
  assert.deepEqual(r.gate[0].views.map((v) => v.width), [375], 'a change at 375 px decides');
  assert.equal(page.reverted?.reason, 'd');
  assert.match(page.reverted.why, /at 375 px/);
  assert.deepEqual(page.dropped.map((d) => d.group), ['alt']);
  assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), html, 'the page is back as lifted');
});

test('a fix that shows only on a computer passes at 375 px and is caught at 1440 px', { timeout: 5 * 60000 }, async (t) => {
  const html = `${stated('img{display:block;width:40px;height:40px}@media (min-width:1000px){img[alt]{width:320px;height:160px}}')}<body>
    <h1>Gallery</h1><p>${ENGLISH}</p>${IMG}<p>Text under the picture.</p></body></html>`;
  const dir = await copyOf(t, html, withImage);
  const r = await prove(browser, dir);
  const g = r.gate[0];
  assert.deepEqual(g.views.map((v) => [v.width, v.invisible]), [[375, true], [1440, false]], JSON.stringify(g.views));
  assert.equal(g.width, 1440);
  assert.match(r.pages[0].reverted.why, /at 1440 px/);
  assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), html);
});

test('two groups invisible alone but visible together are both dropped; each retry is served afresh', { timeout: 8 * 60000 }, async (t) => {
  // The site enlarges an image with an alt only when the page has a language: alt alone and lang alone change nothing.
  // A server that kept the first pass's page would have shown alt AND lang in the "alt alone" look, and dropped alt there
  // ("they changed the page"), never reaching the look at both together: the "not together" reason proves each look was fresh.
  const html = `${stated('img{display:block;width:40px;height:40px}html[lang] img[alt]{width:320px;height:160px}', { lang: false })}<body>
    <h1>Gallery</h1><p>${ENGLISH}</p>${IMG}<p>Text under the picture.</p></body></html>`;
  const dir = await copyOf(t, html, withImage);
  const r = await prove(browser, dir);
  assert.deepEqual(r.gate.map((g) => [g.groups ?? null, g.invisible]), [[null, false], [['alt'], true], [['lang'], true], [['alt', 'lang'], false]], JSON.stringify(r.gate));
  const page = r.pages[0];
  assert.deepEqual(page.dropped.map((d) => d.group), ['alt', 'lang']);
  for (const d of page.dropped) assert.match(d.why, /not together with the other kept fixes/);
  assert.equal(page.reverted?.reason, 'd');
  assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), html, 'the page is back as lifted');
  assert.equal(r.total, 0);
});

test('a look that cannot decide drops what it covers: with no working browser nothing is kept and the page is as lifted', { timeout: 60000 }, async (t) => {
  const html = `${stated('img{display:block;width:40px;height:40px}', { lang: false })}<body><h1>Gallery</h1><p>${ENGLISH}</p>${IMG}</body></html>`;
  const dir = await copyOf(t, html, withImage);
  const broken = { newContext: async () => { throw new Error('the browser is gone'); } };
  const r = await prove(broken, dir);
  assert.equal(r.gate.length, 3, 'the first look, then each group alone; nothing passed, so no look at them together');
  for (const g of r.gate) assert.equal(g.invisible, false);
  const page = r.pages[0];
  assert.deepEqual(page.dropped.map((d) => d.group), ['alt', 'lang']);
  for (const d of page.dropped) assert.match(d.why, /could not prove them invisible: the browser is gone/);
  assert.equal(page.reverted?.reason, 'd');
  assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), html);
});

test('the smallest changes are seen and an unchanged page passes: 2 x 2 px, a pale square, a change far down a tall page', { timeout: 8 * 60000 }, async (t) => {
  // No noise at all (a still page). Before 2026-10-23 all four changes below read 0 % and passed as invisible.
  const page = (size, color, tall) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;height:${tall ? 10000 : 900}px;overflow:hidden;background:#fff}
    i{position:absolute;left:600px;top:${tall ? 9000 : 400}px;width:${size}px;height:${size}px;background:${color}}</style></head><body>${size ? '<i></i>' : ''}</body></html>`;
  const serve = async (body) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-floor-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(path.join(dir, 'index.html'), body);
    const s = await serveCopy(dir);
    t.after(() => s.close());
    return s.url.replace(/\/$/, '');
  };
  const blank = await serve(page(0));
  const same = await fixGate(browser, blank, blank, '/');
  assert.equal(same.changedPx, 0, `an unchanged page passes (${JSON.stringify(same)})`);
  assert.ok(same.invisible);
  // The ruler sets antialiased-looking edge pixels aside (pixelmatch's rule), so a tiny square counts fewer pixels than it has;
  // what matters is that it is seen.
  for (const [size, color, tall] of [[2, '#c00', false], [60, '#f0f0f0', false], [10, '#c00', true], [30, '#e8e8e8', true]]) {
    // (#f5f5f5 on white, 10 levels, is below GATE_THRESHOLD: the stated limit, not tested as seen.)
    const g = await fixGate(browser, await serve(page(size, color, tall)), await serve(page(0, '', tall)), '/');
    assert.ok(g.changedPx > 0 && g.changedPx <= size * size, `${size} x ${size} ${color}${tall ? ' at 9000 px on a 10000 px page' : ''}: ${JSON.stringify(g)}`);
    assert.equal(g.invisible, false);
  }
});

test('gateVerdict: a page whose own height changes between loads is all noise, and nothing in it is called invisible by default', async () => {
  const shot = (h, dot) => sharp({ create: { width: 100, height: h, channels: 3, background: '#fff' } })
    .composite(dot ? [{ input: { create: { width: 4, height: 4, channels: 3, background: '#000' } }, left: 10, top: 10 }] : []).png().toBuffer();
  const v = await gateVerdict([await shot(200, true)], [await shot(200), await shot(220), await shot(200)]);
  assert.equal(v.noiseShare, 100);
  assert.equal(v.changedPx, 0);
  assert.equal(v.inNoisePx, 16, 'the change is counted where it cannot be judged, not dropped');
  const still = await gateVerdict([await shot(200, true), await shot(200, true), await shot(200, true)], [await shot(200), await shot(200), await shot(200)]);
  assert.equal(still.changedPx, 16);
  // A difference that shows in only one pairing is noise the pictures happened to catch, not a change the fixes made.
  const once = await gateVerdict([await shot(200, true), await shot(200), await shot(200)], [await shot(200), await shot(200), await shot(200)]);
  assert.equal(once.changedPx, 0);
  assert.ok(once.inNoisePx >= 16, 'but it is counted, not dropped');
});
