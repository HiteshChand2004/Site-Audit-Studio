// The copy never holds a page's first paint back with more than the original (behavior/preserve/blockingGate.js): every page is
// held against the same page as lifted. A blocking file the copy added is taken out and listed; what the copy adds the way it
// should (inline, deferred, async, a module, a stylesheet for print) is left alone; a file of the original's that grew, or an
// order that changed, is listed and never dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { blockingGate, blockingRefs, blockingWarning } from '../src/recreate/behavior/preserve/blockingGate.js';

const HEAD = '<link rel="stylesheet" href="/static/css/a~11111111.css"><link rel="stylesheet" href="/static/css/b~22222222.css"><script src="/static/js/nav.js"></script>';
const page = (head, body = '<p>Hello</p>') => `<!DOCTYPE html><html><head><title>x</title>${head}</head><body>${body}</body></html>`;

async function folders(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-blocking-gate-'));
  for (const [side, list] of Object.entries(files)) {
    for (const [rel, body] of Object.entries(list)) {
      const f = path.join(root, side, rel);
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, body, 'utf8');
    }
  }
  return root;
}

test('what blocks the first paint: stylesheets that apply, classic scripts in the head with neither async nor defer', () => {
  const $ = cheerio.load(page(`${HEAD}<link rel="stylesheet" href="print.css" media="print"><link rel="alternate stylesheet" href="alt.css">
<link rel="stylesheet" href="/x.css" disabled><script src="/d.js" defer></script><script src="/m.js" type="module"></script><script src="/a.js" async></script>
<script>var inline = 1</script><script type="application/ld+json">{}</script><noscript><link rel="stylesheet" href="/ns.css"></noscript><link rel="preload" as="style" href="/p.css">`,
  '<link rel="stylesheet" href="late.css"><script src="/body.js"></script>'));
  assert.deepEqual(blockingRefs($, 'blog/index.html').map((r) => [r.kind, r.key]), [
    ['stylesheet', '/static/css/a~11111111.css'], ['stylesheet', '/static/css/b~22222222.css'], ['script', '/static/js/nav.js'],
    ['stylesheet', '/blog/late.css'],
  ]);
});

test('a blocking file the copy added is taken out; the original\'s files, and what the copy adds without blocking, stay', async () => {
  const files = { '/static/css/a~11111111.css': 'a{color:red}', '/static/css/b~22222222.css': 'b{color:blue}', '/static/js/nav.js': 'void 0' };
  const lifted = { 'index.html': page(HEAD), 'about/index.html': page(HEAD), ...files };
  const root = await folders({
    lifted,
    copy: {
      ...files,
      // Added by the copy: a blocking script and stylesheet (taken out), and the ways the copy should add things (kept).
      'index.html': page(`${HEAD}<script src="/js/added.js"></script><link rel="stylesheet" href="/css/added.css">
<script src="/js/motion.js" defer></script><script>window.__shim=1</script><link rel="icon" href="/icons/favicon-generated.svg">`,
      '<p>Hello</p><script>/* form guard */</script>'),
      'about/index.html': page(HEAD),
      // A notice page the copy wrote: nothing lifted to hold it against.
      'pricing/index.html': page(''),
    },
  });
  try {
    const pages = [{ outPath: 'index.html' }, { outPath: 'about/index.html' }, { outPath: 'pricing/index.html' }];
    const g = await blockingGate({ copyDir: path.join(root, 'copy'), liftedDir: path.join(root, 'lifted'), pages });
    assert.equal(g.checked, 2);
    assert.deepEqual(g.missing, ['pricing/index.html']);
    assert.deepEqual(g.dropped.map((d) => [d.page, d.kind, d.ref]), [['index.html', 'script', '/js/added.js'], ['index.html', 'stylesheet', '/css/added.css']]);
    assert.deepEqual([g.larger, g.reordered], [[], []]);
    const html = await readFile(path.join(root, 'copy', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /added\.(js|css)/);
    for (const kept of ['/static/css/a~11111111.css', '/static/js/nav.js', '/js/motion.js" defer', 'window.__shim=1', 'favicon-generated.svg', 'form guard']) assert.ok(html.includes(kept), kept);
    assert.match(blockingWarning(g), /^Render-blocking files: 2 files the copy added would have held a page's first paint back and were taken out \(\/js\/added\.js on index\.html/);
    assert.equal(await readFile(path.join(root, 'copy', 'about', 'index.html'), 'utf8'), page(HEAD), 'a page with nothing added is not rewritten');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a file of the original\'s that grew, or another order, is listed and kept; one at another address is the same file', async () => {
  const big = `b{${'color:#0a0b0c;margin:1px 2px 3px 4px;'.repeat(400)}${Array.from({ length: 2000 }, (_, i) => `.x${i}{top:${i}px}`).join('')}}`;
  const root = await folders({
    lifted: { 'index.html': page(HEAD), '/static/css/a~11111111.css': 'a{}', '/static/css/b~22222222.css': 'b{}', '/static/js/nav.js': '' },
    copy: {
      'index.html': page('<link rel="stylesheet" href="/static/css/b~22222222.css"><link rel="stylesheet" href="/assets/a~11111111.css"><script src="/static/js/nav.js"></script>'),
      '/assets/a~11111111.css': 'a{}', '/static/css/b~22222222.css': big, '/static/js/nav.js': '',
    },
  });
  try {
    const g = await blockingGate({ copyDir: path.join(root, 'copy'), liftedDir: path.join(root, 'lifted'), pages: [{ outPath: 'index.html' }] });
    assert.deepEqual(g.dropped, [], 'the original\'s own file at another address is never taken out');
    assert.deepEqual(g.reordered.map((r) => r.ref), ['/assets/a~11111111.css']);
    assert.deepEqual(g.larger.map((r) => r.ref), ['/static/css/b~22222222.css']);
    assert.ok(g.larger[0].bytes > g.larger[0].original + 1024);
    assert.match(blockingWarning(g), /1 file the first paint waits for is larger than the original's .*; the files the first paint waits for are asked for in another order than the original on 1 page \(index\.html\)/);
    assert.match(await readFile(path.join(root, 'copy', 'index.html'), 'utf8'), /b~22222222\.css/, 'kept');
    assert.equal(blockingWarning({ dropped: [], larger: [], reordered: [] }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
