// The inline fix of an as-is copy (copy/perfAsIs.js inlineStylesheets): a small local stylesheet the first paint waits for is
// written into the page where its <link> stood, with its url()s pointing from the page; every case it must not touch stays a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { gzipSync } from 'node:zlib';
import { inlineStylesheets, rebaseCssUrls, INLINE_MAX_BYTES, INLINE_MAX_GZIP } from '../src/copy/perfAsIs.js';

/** A stylesheet of rules with varied names and colours, just past `gzipKB` KB once gzipped. */
function sheetOfGzip(gzipKB, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s.toString(16).padStart(8, '0'); };
  let css = '';
  while (true) {
    for (let i = 0; i < 200; i++) css += `.c${rnd()}{color:#${rnd().slice(0, 6)};margin:${s % 37}px}`;
    if (gzipSync(css).length >= gzipKB * 1024) return css;
  }
}

async function site(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sas-inline-'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

test('rebaseCssUrls: relative addresses point from the page, the rest stay', () => {
  const css = 'a{background:url(../media/a.png)}b{background:url("img/b.png")}c{background:url(/x.png)}d{background:url(data:image/png;base64,AA)}e{fill:url(#g)}f{background:url(https://h.example/y.png)}';
  const out = rebaseCssUrls(css, '_next/static/css', 'blog');
  assert.match(out, /url\(\.\.\/_next\/static\/media\/a\.png\)/);
  assert.match(out, /url\("\.\.\/_next\/static\/css\/img\/b\.png"\)/);
  assert.match(out, /url\(\/x\.png\)/);
  assert.match(out, /url\(data:image\/png;base64,AA\)/);
  assert.match(out, /url\(#g\)/);
  assert.match(out, /url\(https:\/\/h\.example\/y\.png\)/);
  assert.match(rebaseCssUrls('a{background:url(../media/a.png)}', 'css', ''), /url\(media\/a\.png\)/);
});

test('a small blocking sheet is written into the page in its place, url()s from the page', async () => {
  const dir = await site({
    'css/site.css': 'h1{color:red;background:url(../img/a.png)}p>a{color:blue}',
    'css/late.css': 'p{color:green}',
  });
  try {
    const $ = cheerio.load('<html><head><link rel="preload" as="font" href="/f.woff2"><link rel="stylesheet" href="/css/site.css"><style id="after">h1{color:black}</style><link rel="stylesheet" href="/css/late.css" media="print"></head><body><h1>Hi</h1></body></html>');
    const r = await inlineStylesheets($, { path: '/blog/', outPath: 'blog/index.html' }, dir);
    assert.equal(r.fixed.length, 1);
    assert.equal(r.fixed[0].file, 'css/site.css');
    assert.equal($('link[href="/css/site.css"]').length, 0);
    const style = $('style[data-sas-inline="/css/site.css"]');
    assert.equal(style.length, 1);
    assert.equal(style.next().attr('id'), 'after', 'same place in the cascade');
    assert.match($.html(), /url\(\.\.\/img\/a\.png\)/);
    assert.match($.html(), /p>a\{color:blue\}/, 'the text is written as it is, nothing escaped');
    assert.equal($('link[href="/css/late.css"]').length, 1, 'a sheet that does not block stays');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a framework\'s pair of first-paint sheets (14 KB + 18 KB gzip) both go into the page; one past the limit stays a file', async () => {
  // own360's Next.js build: 0fspgkgshvx6t.css (14 KB) and 093xbxg.cd3f4.css (18 KB); the larger stayed a file at a 16 KB limit.
  const big = sheetOfGzip(INLINE_MAX_GZIP / 1024 + 1, 3);
  const dir = await site({ 'a.css': sheetOfGzip(14, 1), 'b.css': sheetOfGzip(18, 2), 'huge.css': big });
  try {
    assert.ok(Buffer.byteLength(big) <= INLINE_MAX_BYTES, 'past the gzip limit only, so that is the rule tested');
    const $ = cheerio.load('<html><head><link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"><link rel="stylesheet" href="/huge.css"></head><body></body></html>');
    const r = await inlineStylesheets($, { path: '/', outPath: 'index.html' }, dir);
    assert.deepEqual(r.fixed.map((f) => f.file).sort(), ['a.css', 'b.css']);
    assert.equal($('style[data-sas-inline]').length, 2);
    assert.equal($('link[href="/huge.css"]').length, 1);
    assert.match(r.open.map((o) => o.detail).join('\n'), /huge\.css .*too large/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('integrity, @import, a script that names it, too large, another host: each stays a file, with why', async () => {
  const dir = await site({
    'a.css': 'a{color:red}',
    'b.css': '@import url(c.css);b{color:red}',
    'named.css': 'i{color:red}',
    'big.css': `x{content:"${'z'.repeat(INLINE_MAX_BYTES)}"}`,
    'app.js': 'load("/named.css")',
  });
  try {
    const $ = cheerio.load('<html><head><link rel="stylesheet" href="/a.css" integrity="sha256-x"><link rel="stylesheet" href="/b.css"><link rel="stylesheet" href="/named.css"><link rel="stylesheet" href="/big.css"><link rel="stylesheet" href="https://cdn.example/x.css"><script src="/app.js"></script></head><body></body></html>');
    const r = await inlineStylesheets($, { path: '/', outPath: 'index.html' }, dir);
    assert.equal(r.fixed.length, 0);
    assert.equal($('link[rel=stylesheet]').length, 5);
    const why = r.open.map((o) => o.detail).join('\n');
    assert.match(why, /a\.css .*integrity/);
    assert.match(why, /b\.css .*imports/);
    assert.match(why, /named\.css .*script/);
    assert.match(why, /big\.css .*too large/);
    assert.ok(!/cdn\.example/.test(why), 'another host is not ours to inline, and is not listed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
