// The lighter fix proof of an exact copy (preserve/stage.js fixAndProve `exact`, used by build/index.js fixExactCopy): fixes that
// only write head tags nothing draws are proved by the page itself (withoutUnpainted: the rest of the page byte for byte the same),
// not by pictures; a look at the other fixes serves every combination that differs only by those; both widths are pictured at the
// same time. What still holds: a fix that draws something is looked at at 375 and 1440 px, and one that changes a pixel is undone.
// "Copy my site" (exact: false) still looks at every fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fixAndProve, withoutUnpainted } from '../src/recreate/behavior/preserve/stage.js';
import { fixGate } from '../src/recreate/behavior/preserve/check.js';

const doc = (head, body = '<p>Hello</p>') => `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

test('withoutUnpainted: only tags nothing draws are set aside', () => {
  const base = doc('<meta name="viewport" content="width=device-width"><title>A</title><link rel="stylesheet" href="/a.css">');
  const same = (a, b) => assert.equal(withoutUnpainted(a), withoutUnpainted(b));
  const differs = (a, b) => assert.notEqual(withoutUnpainted(a), withoutUnpainted(b));
  same(base, doc('<meta name="viewport" content="width=device-width"><title>Another title</title>\n  <meta name="description" content="New words">'
    + '<meta property="og:title" content="A"><link rel="canonical" href="https://x.dev/"><meta name="theme-color" content="#c2410c">'
    + '<link rel="icon" href="/i.png"><link rel="stylesheet" href="/a.css"><script type="application/ld+json">{"@type":"WebSite"}</script>'));
  differs(base, doc('<meta name="viewport" content="width=1024"><title>A</title><link rel="stylesheet" href="/a.css">'), 'the viewport draws');
  differs(base, doc('<meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><title>A</title><link rel="stylesheet" href="/a.css">'));
  differs(base, doc('<meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="0"><title>A</title><link rel="stylesheet" href="/a.css">'));
  differs(base, doc('<meta name="viewport" content="width=device-width"><title>A</title><link rel="stylesheet" href="/b.css">'), 'a stylesheet draws');
  differs(base, doc('<meta name="viewport" content="width=device-width"><title>A</title><link rel="stylesheet" href="/a.css"><style>p{color:red}</style>'));
  differs(base, doc('<meta name="viewport" content="width=device-width"><title>A</title><link rel="stylesheet" href="/a.css">', '<p>Hello </p>'), 'the body is compared byte for byte');
  differs(base, doc('<meta name="viewport" content="width=device-width"><title>A</title><link rel="stylesheet" href="/a.css">', '<p alt="x">Hello</p>'));
});

const SITE = 'https://www.example-original.dev/';
const ENGLISH = 'This page is about the work we do for our customers and the people who use what we make every day. '
  + 'We write about it here so that you can find out what it is, how it works and why it matters to the people who need it.';
// No description and no og tags: each page gets head fixes (quiet). The second page also has an image without alt, which the
// site's own CSS draws bigger once it has one: a fix that changes the look, which must still be caught and undone.
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><meta name="theme-color" content="#c2410c"><link rel="icon" href="data:,">
<style>body{margin:0;font:18px sans-serif;background:#fff}img{display:block;width:40px;height:40px}img[alt]{width:320px;height:160px}</style></head>
<body><h1>${title}</h1><p>${ENGLISH}</p>${body}</body></html>`;

async function copyWithTwoPages(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-light-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-unfixed`, { recursive: true, force: true }); });
  await mkdir(path.join(dir, 'images'), { recursive: true });
  await writeFile(path.join(dir, 'images', 'team-photo-ab12cd34ef.png'), await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer());
  const home = page('Light proof home page', '<p>Nothing to draw differently here.</p>');
  const other = page('Light proof gallery page', '<img src="/images/team-photo-ab12cd34ef.png"><p>Text under the picture.</p>');
  await writeFile(path.join(dir, 'index.html'), home);
  await writeFile(path.join(dir, 'gallery.html'), other);
  return { dir, home, other };
}

const pages = [{ outPath: 'index.html', url: SITE }, { outPath: 'gallery.html', url: `${SITE}gallery.html` }];
const groupsOf = (p) => [...new Set(p.fixes.map((f) => (f.kind === 'head' ? `head:${f.field}` : f.kind)))];

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

test('exact copy: head-only fixes need no picture, a look serves both combinations, a visible fix is still undone', { timeout: 6 * 60000 }, async (t) => {
  const { dir, home, other } = await copyWithTwoPages(t);
  const looked = [];
  const lookGate = async (...args) => {
    looked.push({ path: args[3], parallel: args[4]?.parallel === true });
    return fixGate(...args);
  };
  const r = await fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages, siteUrl: SITE, newSiteUrl: null, speed: false, lookGate, exact: true });
  const byPath = new Map(r.pages.map((p) => [p.path, p]));
  const detail = JSON.stringify({ looked, pages: r.pages.map((p) => ({ path: p.path, groups: groupsOf(p), dropped: p.dropped, reverted: p.reverted })), lighter: r.lighter });

  // The homepage: only head fixes, kept without a single picture.
  assert.ok(!byPath.get('/').reverted, detail);
  assert.ok(byPath.get('/').fixes.length > 0 && byPath.get('/').fixes.every((f) => ['head', 'data'].includes(f.kind)), detail);
  assert.notEqual(await readFile(path.join(dir, 'index.html'), 'utf8'), home, 'the homepage is fixed');
  assert.ok(!looked.some((l) => l.path === '/'), `the homepage is not pictured: ${detail}`);

  // The gallery: its alt fix draws the image bigger, so it is still caught and dropped; its head fixes stay.
  const gallery = byPath.get('/gallery.html');
  assert.ok(!gallery.reverted, detail);
  assert.deepEqual((gallery.dropped ?? []).map((d) => d.group), ['alt'], detail);
  assert.ok(gallery.fixes.length > 0 && gallery.fixes.every((f) => f.kind !== 'alt'), detail);
  assert.doesNotMatch(await readFile(path.join(dir, 'gallery.html'), 'utf8'), /<img[^>]*\balt=/, 'the image is as it was');
  // One look in all: the first (alt + head); "alt alone" is the same picture (head draws nothing), "head alone" needs none.
  assert.equal(looked.length, 1, detail);
  assert.equal(looked[0].parallel, true, 'both widths at the same time');
  assert.ok(r.lighter.structural >= 2 && r.lighter.reused >= 1, detail);
  assert.equal(r.css, undefined, 'speed: false here, so no stylesheet step at all');
});

test('"Copy my site" (not exact) pictures every page with a fix, both widths at once, and keeps its group retries', { timeout: 6 * 60000 }, async (t) => {
  const { dir, other } = await copyWithTwoPages(t);
  const looked = [];
  const lookGate = async (...args) => {
    looked.push({ path: args[3], parallel: args[4]?.parallel === true });
    return fixGate(...args);
  };
  const r = await fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages, siteUrl: SITE, newSiteUrl: null, speed: false, lookGate });
  assert.ok(looked.some((l) => l.path === '/'), 'the homepage is pictured');
  assert.ok(looked.length > 2, 'the gallery groups are looked at one by one, as before');
  assert.ok(looked.every((l) => l.parallel), 'both widths at the same time, as an exact copy (the same verdict: the test below)');
  assert.equal(r.lighter, undefined);
  const gallery = r.pages.find((p) => p.path === '/gallery.html');
  assert.ok((gallery.dropped ?? []).some((d) => d.group === 'alt'));
  assert.doesNotMatch(await readFile(path.join(dir, 'gallery.html'), 'utf8'), /<img[^>]*\balt=/);
  assert.notEqual(other, null);
});

test('both widths at once give the same verdict as one after the other', { timeout: 6 * 60000 }, async (t) => {
  const { dir } = await copyWithTwoPages(t);
  // The gallery with an alt the CSS draws bigger: changed at both widths.
  const fixedDir = `${dir}-fixed`;
  t.after(() => rm(fixedDir, { recursive: true, force: true }));
  await mkdir(path.join(fixedDir, 'images'), { recursive: true });
  await writeFile(path.join(fixedDir, 'images', 'team-photo-ab12cd34ef.png'), await readFile(path.join(dir, 'images', 'team-photo-ab12cd34ef.png')));
  const html = await readFile(path.join(dir, 'gallery.html'), 'utf8');
  await writeFile(path.join(fixedDir, 'gallery.html'), html.replace('<img src=', '<img alt="Team photo" src='));
  await writeFile(path.join(fixedDir, 'same.html'), html);
  await writeFile(path.join(dir, 'same.html'), html);
  const { serveCopy } = await import('../src/recreate/behavior/preserve/serve.js');
  const a = await serveCopy(fixedDir);
  const b = await serveCopy(dir);
  t.after(async () => { await a.close(); await b.close(); });
  const fixedBase = a.url.replace(/\/$/, '');
  const unfixedBase = b.url.replace(/\/$/, '');
  const serial = await fixGate(browser, fixedBase, unfixedBase, '/gallery.html');
  const both = await fixGate(browser, fixedBase, unfixedBase, '/gallery.html', { parallel: true });
  assert.equal(serial.invisible, false);
  assert.equal(both.invisible, false);
  assert.equal(both.width, serial.width, 'the first failing width decides in both');
  assert.equal(both.views[0].changedPx, serial.views[0].changedPx);
  const sameSerial = await fixGate(browser, fixedBase, unfixedBase, '/same.html');
  const sameBoth = await fixGate(browser, fixedBase, unfixedBase, '/same.html', { parallel: true });
  assert.equal(sameSerial.invisible, true);
  assert.equal(sameBoth.invisible, true);
  assert.deepEqual(sameBoth.views.map((v) => v.width), [375, 1440]);
});
