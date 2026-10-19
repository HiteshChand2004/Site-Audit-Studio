// The visual check compares the original with the copy. A page that rotates its own words changes between two screenshots taken
// seconds apart, so the difference measured the moment, not the page. The frozen picture (verify/shot.js) is the same at any time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { frozenFullShot, fullShotOf } from '../src/recreate/verify/shot.js';

test('a page that rotates its words: a frozen picture is the same at any time, while the page itself keeps changing', { timeout: 180000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-frozen-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rotator.html');
  await writeFile(file, `<!doctype html><html><head><meta charset="utf-8"><title>Rotator</title></head>
    <body style="margin:0;font:48px sans-serif"><h1 id="h">alpha</h1><p>Static text below the rotating word, so the page is tall enough to scroll.</p>
    <div style="height:1400px;background:linear-gradient(#fff,#333)"></div>
    <script>var words=['alpha','bravo','charlie'],i=0;setInterval(function(){i=(i+1)%words.length;document.getElementById('h').textContent=words[i];},300);</script>
    </body></html>`, 'utf8');
  const url = `file://${file.split(path.sep).join('/')}`;
  const view = { width: 600, height: 500, dpr: 1, mobile: false };
  const browser = await chromium.launch();
  try {
    // The page really does change: two plain screenshots a second apart differ.
    const plain = await (await browser.newContext({ viewport: { width: 600, height: 500 } })).newPage();
    await plain.goto(url, { waitUntil: 'load' });
    const first = await plain.screenshot({ type: 'png', fullPage: true });
    await plain.waitForTimeout(500);
    const second = await plain.screenshot({ type: 'png', fullPage: true });
    assert.notEqual(Buffer.compare(first, second), 0, 'the rotating page changes between two screenshots');

    // Frozen pictures taken a second apart are the same, and the frozen timers are counted.
    const a = await frozenFullShot(browser, url, view);
    await new Promise((r) => setTimeout(r, 1000));
    const b = await frozenFullShot(browser, url, view);
    assert.equal(Buffer.compare(a.png, b.png), 0, 'the frozen picture does not depend on when it was taken');
    assert.ok(a.frozen && a.frozen.intervals >= 1, 'the rotator\'s timer was frozen and counted');
  } finally {
    await browser.close();
  }
});

test('a page whose load event never comes: the frozen picture still finishes inside its own limit', { timeout: 120000 }, async (t) => {
  const { createServer } = await import('node:http');
  // The image never answers, so the page's load event never fires; the page itself is ready at domcontentloaded.
  const server = createServer((req, res) => {
    if (req.url === '/hang.png') return; // never answered
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>Hang</title></head><body style="margin:0;font:40px sans-serif"><h1>Ready</h1><img src="/hang.png" width="40" height="40" alt=""><p>Text below the heading.</p></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    const started = Date.now();
    const shot = await frozenFullShot(browser, url, { width: 600, height: 500, dpr: 1, mobile: false }, { limitMs: 20000 });
    assert.ok(shot.png.length > 1000, 'a picture was taken');
    assert.ok(Date.now() - started < 30000, 'inside its own limit, not the load event\'s');
  } finally {
    await browser.close();
  }
});

test('when the frozen picture cannot finish, the capture keeps the normal screenshot and says why', { timeout: 120000 }, async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 600, height: 500 } });
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><body style="margin:0;font:40px sans-serif"><h1>Normal</h1></body></html>');
    const shot = await fullShotOf(browser, page, 'http://127.0.0.1:1/', { width: 600, height: 500, dpr: 1, mobile: false }, { fallbackHeight: 500, limitMs: 5000 });
    assert.equal(shot.frozen, false);
    assert.ok(shot.reason && shot.reason.length > 0, 'the reason is kept');
    assert.ok(shot.png.length > 1000, 'the normal screenshot is kept');
    await context.close();
  } finally {
    await browser.close();
  }
});
