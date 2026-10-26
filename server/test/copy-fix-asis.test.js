// The safe fixes of an as-is copy (copy/fixAsIs.js) and their proof (preserve/stage.js fixAndProve): only what is missing, empty,
// duplicated or invalid is changed; a page that states everything correctly is left byte for byte; the site files name the new
// site; and a page whose fixes change what it shows (its own script reads the title) gets its lifted HTML back, reason d.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fixAsIsCopy, AS_IS_HEADERS } from '../src/copy/fixAsIs.js';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';

const SITE = 'https://www.example-original.test/';
const NEW = 'https://new.example.test';
const ENGLISH = 'This page is about the work we do for our customers and the people who use what we make every day. '
  + 'We write about it here so that you can find out what it is, how it works and why it matters to the people who need it.';

const home = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Acme</title>
<link rel="canonical" href="https://example-original.test/">
<style>body{margin:0;font:16px sans-serif}img{display:block;width:40px;height:40px}</style></head>
<body><h1>Acme tools</h1><p>${ENGLISH}</p>
<img src="/images/team-photo-ab12cd34ef.png">
<a href="https://www.linkedin.com/company/acme"><svg width="16" height="16"><rect width="16" height="16"/></svg></a>
<iframe src="https://player.vimeo.com/video/1" width="10" height="10"></iframe>
<div id="dup">a</div><div id="dup">b</div>
<h2>What is Acme?</h2><p>Acme is a set of tools for people who build things, made to last and easy to use.</p>
<h2>Who is it for?</h2><p>Anyone who builds things and wants tools that do not get in the way of the work.</p>
</body></html>`;

// Its title is the homepage's; its own script writes the title into the page, so a new title shows.
const about = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Acme</title><meta name="description" content="About Acme: who we are, what we make and why we make it the way we do.">
<style>body{margin:0;font:16px sans-serif}</style></head>
<body><h1>About us</h1><p>We are a small team.</p><div id="t"></div>
<script>document.getElementById('t').textContent = document.title;</script></body></html>`;

// Everything stated: nothing to fix.
const fine = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Contact the Acme team</title>
<meta name="description" content="Write to the Acme team about tools, orders and anything else you would like to know.">
<link rel="canonical" href="${NEW}/contact"><meta property="og:title" content="Contact the Acme team">
<meta property="og:description" content="Write to the Acme team about tools, orders and anything else you would like to know.">
<meta property="og:url" content="${NEW}/contact"></head><body><h1>Contact</h1><p>Write to us.</p></body></html>`;

const robots = 'User-agent: *\nAllow: /\nDisallow: /private/\n\nHost: https://example-original.test\nSitemap: https://example-original.test/sitemap.xml\n';

async function siteDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-fixasis-'));
  await mkdir(path.join(dir, 'about'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), home);
  await writeFile(path.join(dir, 'about', 'index.html'), about);
  await writeFile(path.join(dir, 'contact.html'), fine);
  await writeFile(path.join(dir, 'robots.txt'), robots);
  await mkdir(path.join(dir, 'images'), { recursive: true });
  await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toFile(path.join(dir, 'images', 'team-photo-ab12cd34ef.png'));
  return dir;
}
const PAGES = [
  { path: '/', outPath: 'index.html', url: SITE },
  { path: '/about/', outPath: 'about/index.html', url: `${SITE}about/` },
  { path: '/contact.html', outPath: 'contact.html', url: `${SITE}contact.html` },
];

test('only what is missing, duplicated or invalid is fixed; the site files name the new site', async () => {
  const dir = await siteDir();
  try {
    const r = await fixAsIsCopy({ dir, pages: PAGES, siteUrl: SITE, newSiteUrl: NEW });
    const out = await readFile(path.join(dir, 'index.html'), 'utf8');
    const fixes = r.pages[0].fixes;
    const has = (kind, field, value) => fixes.some((f) => f.kind === kind && (!field || f.field === field) && (value == null || String(f.value).includes(value)));
    assert.ok(has('alt', 'alt', 'Team photo'), 'image alt from its file name');
    assert.match(out, /alt="Team photo"/);
    assert.ok(has('names', 'aria-label', 'LinkedIn'), 'icon link named after the service');
    assert.ok(fixes.some((f) => f.kind === 'aria' && f.rule === 'frame-title'), 'frame title');
    assert.equal((out.match(/id="dup"/g) ?? []).length, 2, 'a duplicate id is never renamed in an as-is copy');
    assert.ok(r.open.some((o) => o.rule === 'duplicate-id' && o.reason === 'd'));
    assert.ok(has('address', 'canonical', `${NEW}/`), 'the canonical naming the original moves to the new site');
    assert.ok(has('lang', 'lang', 'en'));
    assert.match(out, /<html lang="en"/);
    assert.ok(has('data', 'json-ld', 'Organization') && has('data', 'json-ld', 'WebSite') && has('data', 'json-ld', 'FAQPage (2'));
    assert.ok(has('head', 'description'), 'a missing description from the page\'s own paragraphs');
    assert.match(out, /<title>Acme<\/title>/, 'the first page keeps its own title');

    const aboutFixes = r.pages[1].fixes;
    assert.ok(aboutFixes.some((f) => f.field === 'title' && f.source === 'duplicate of another page' && /About us/.test(f.value)));

    assert.equal(r.pages[2].fixes.length, 0);
    assert.equal(await readFile(path.join(dir, 'contact.html'), 'utf8'), fine, 'a page with nothing to fix is left byte for byte');

    const robotsOut = await readFile(path.join(dir, 'robots.txt'), 'utf8');
    assert.match(robotsOut, /Disallow: \/private\//, 'the original\'s rules are kept');
    assert.match(robotsOut, /Host: https:\/\/new\.example\.test/);
    assert.match(robotsOut, /Sitemap: https:\/\/new\.example\.test\/sitemap\.xml/);
    assert.doesNotMatch(robotsOut, /example-original/);
    const sitemap = await readFile(path.join(dir, 'sitemap.xml'), 'utf8');
    for (const p of ['/', '/about/', '/contact.html']) assert.ok(sitemap.includes(`<loc>${NEW}${p}</loc>`), p);
    assert.match(await readFile(path.join(dir, 'llms.txt'), 'utf8'), /^# /);
    const headers = await readFile(path.join(dir, '_headers'), 'utf8');
    assert.equal(headers, AS_IS_HEADERS);
    assert.match(headers, /X-Content-Type-Options: nosniff/);
    assert.doesNotMatch(headers, /Content-Security-Policy/, 'no CSP: the original\'s own scripts run in the copy');

    // Run again: nothing left to fix (a repack starts from the lifted copy, but a second pass must not stack changes).
    const again = await fixAsIsCopy({ dir, pages: PAGES, siteUrl: SITE, newSiteUrl: NEW });
    assert.equal(again.pages[0].fixes.filter((f) => f.kind !== 'names').length, 0, JSON.stringify(again.pages[0].fixes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('without the new site\'s address nothing names an address', async () => {
  const dir = await siteDir();
  try {
    const r = await fixAsIsCopy({ dir, pages: PAGES, siteUrl: SITE, newSiteUrl: null });
    assert.ok(!r.pages.flatMap((p) => p.fixes).some((f) => f.kind === 'address' || f.field === 'canonical' || f.field === 'og:url'));
    assert.equal(await readFile(path.join(dir, 'robots.txt'), 'utf8'), robots);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fixes are kept only where they change nothing a visitor sees; the others are reverted (reason d)', { timeout: 5 * 60000 }, async () => {
  const dir = await siteDir();
  const browser = await chromium.launch();
  try {
    const r = await fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages: PAGES, siteUrl: SITE, newSiteUrl: NEW });
    const byPath = Object.fromEntries(r.pages.map((p) => [p.path, p]));
    assert.equal(byPath['/'].reverted, undefined, JSON.stringify(r.gate));
    assert.match(await readFile(path.join(dir, 'index.html'), 'utf8'), /alt="Team photo"/, 'the homepage keeps its fixes');
    assert.equal(byPath['/about/'].reverted?.reason, 'd', JSON.stringify(r.gate));
    assert.equal(await readFile(path.join(dir, 'about', 'index.html'), 'utf8'), about, 'the about page is back as lifted');
    assert.equal(r.reverted, 1);
    assert.ok(r.counts.alt >= 1);
    assert.ok(r.gate.find((g) => g.path === '/').diffPct <= 0.5);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}-unfixed`, { recursive: true, force: true });
  }
});
