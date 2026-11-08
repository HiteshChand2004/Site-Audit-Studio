// A stray reply of the browser connection during the fix proof (preserve/stage.js fixAndProve): Playwright's own assertion in
// CRSession._onMessage, thrown in its message loop, reached the process as an uncaught exception and ended it (first exact
// rebuild of Step 9e, /contact.html). While the proof runs it is counted instead: the page whose look saw it gets its HTML back,
// the other pages keep their fixes, the proof finishes, and the listener is gone afterwards. Any other uncaught error is still
// thrown again. The process is passed in (an EventEmitter here), so the test runner's own listener is never involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fixAndProve, isStrayReply, strayReplyGuard } from '../src/recreate/behavior/preserve/stage.js';
import { fixGate } from '../src/recreate/behavior/preserve/check.js';

// The error exactly as the crashed run printed it (Playwright 1.63, coreBundle.js).
const strayReply = () => {
  const err = new Error('Assertion error');
  err.stack = [
    'Error: Assertion error',
    '    at assert (C:\\x\\node_modules\\playwright-core\\lib\\coreBundle.js:838:11)',
    '    at _CRSession._onMessage (C:\\x\\node_modules\\playwright-core\\lib\\coreBundle.js:35014:11)',
    '    at CRConnection._onMessage (C:\\x\\node_modules\\playwright-core\\lib\\coreBundle.js:34951:20)',
    '    at Immediate.<anonymous> (C:\\x\\node_modules\\playwright-core\\lib\\coreBundle.js:39453:30)',
    '    at process.processImmediate (node:internal/timers:574:21)',
  ].join('\n');
  return err;
};

test('only Playwright\'s stray-reply assertion is recognised', () => {
  assert.equal(isStrayReply(strayReply()), true);
  assert.equal(isStrayReply(new Error('Assertion error')), false, 'the same message from elsewhere');
  const other = strayReply();
  other.message = 'Target page, context or browser has been closed';
  assert.equal(isStrayReply(other), false, 'another message from the same frame');
  assert.equal(isStrayReply('Assertion error'), false);
});

test('the guard counts stray replies, throws any other error again, and is removed on close', () => {
  const proc = new EventEmitter();
  const rethrown = [];
  const guard = strayReplyGuard({ proc, rethrow: (e) => rethrown.push(e) });
  assert.equal(proc.listenerCount('uncaughtException'), 1);
  proc.emit('uncaughtException', strayReply());
  proc.emit('uncaughtException', strayReply());
  assert.equal(guard.count, 2);
  assert.equal(rethrown.length, 0);
  assert.equal(proc.listenerCount('uncaughtException'), 1, 'still listening after a stray reply');
  const boom = new TypeError('something else went wrong');
  proc.emit('uncaughtException', boom);
  assert.deepEqual(rethrown, [boom], 'an unrelated error is thrown again');
  assert.equal(proc.listenerCount('uncaughtException'), 0, 'and the listener is gone, so Node ends the process as before');
  guard.close();
  const g2 = strayReplyGuard({ proc, rethrow: () => {} });
  g2.close();
  assert.equal(proc.listenerCount('uncaughtException'), 0);
});

const SITE = 'https://www.example-original.dev/';
const ENGLISH = 'This page is about the work we do for our customers and the people who use what we make every day. '
  + 'We write about it here so that you can find out what it is, how it works and why it matters to the people who need it.';
// Each page states everything the head fixes would add, so its only fix is the image's alt (one markup group).
const page = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><meta name="theme-color" content="#c2410c"><link rel="icon" href="data:,">
<meta name="description" content="${title}: a page made to test what happens when the browser connection misbehaves.">
<meta property="og:title" content="${title}"><meta property="og:description" content="${title}: a page made to test what happens when the browser connection misbehaves.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":["Organization","WebSite"],"name":"Stray"}</script>
<style>body{margin:0;font:18px sans-serif;background:#fff}img{display:block;width:40px;height:40px}</style></head>
<body><h1>${title}</h1><p>${ENGLISH}</p><img src="/images/team-photo-ab12cd34ef.png"><p>Text under the picture.</p></body></html>`;

test('a stray reply during one page\'s look undoes that page only; the proof finishes; the listener is removed', { timeout: 5 * 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-stray-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-unfixed`, { recursive: true, force: true }); });
  await mkdir(path.join(dir, 'images'), { recursive: true });
  await writeFile(path.join(dir, 'images', 'team-photo-ab12cd34ef.png'), await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer());
  const home = page('Stray reply home page');
  const other = page('Stray reply other page');
  await writeFile(path.join(dir, 'index.html'), home);
  await writeFile(path.join(dir, 'other.html'), other);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const proc = new EventEmitter();
  let fired = 0;
  // The real gate; on /other.html the stray reply arrives while the look is under way.
  const gate = async (...args) => {
    const g = await fixGate(...args);
    if (args[3] === '/other.html') {
      fired++;
      proc.emit('uncaughtException', strayReply());
    }
    return g;
  };
  const r = await fixAndProve({
    browser, copyDir: dir, gateDir: `${dir}-unfixed`, siteUrl: SITE, newSiteUrl: null, speed: false, lookGate: gate, proc,
    pages: [{ outPath: 'index.html', url: SITE }, { outPath: 'other.html', url: `${SITE}other.html` }],
  });
  assert.equal(fired, 1, `the disturbed page is looked at once, not tried again group by group: ${JSON.stringify(r.pages.map((p) => ({ path: p.path, fixes: p.fixes.map((f) => f.kind), reverted: p.reverted })))}`);
  assert.equal(proc.listenerCount('uncaughtException'), 0, 'the listener is removed when the proof ends');
  const byPath = new Map(r.pages.map((p) => [p.path, p]));
  assert.ok(!byPath.get('/').reverted, 'the other page keeps its fixes');
  assert.ok(byPath.get('/').fixes.some((f) => f.kind === 'alt'));
  assert.match(await readFile(path.join(dir, 'index.html'), 'utf8'), /<img[^>]*\salt=/);
  assert.match(byPath.get('/other.html').reverted?.why ?? '', /browser connection/);
  assert.equal(await readFile(path.join(dir, 'other.html'), 'utf8'), other, 'the disturbed page has its HTML back, byte for byte');
  assert.equal(r.reverted, 1);
});
