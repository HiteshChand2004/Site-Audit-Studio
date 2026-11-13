// Image addresses a page's script builds itself (behavior/preserve/complete.js imageAddressesOf / imageAddressShim): own360.ai's
// Next.js image component drew its screenshots again in the browser and asked /_next/image?url=…&w=750 of the copy's server,
// which holds that size under another name (404 on four pages; the worker only maps it from the second visit). On a first
// visit the page's second script now gives the copy's file before the browser asks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { imageAddressesOf, imageAddressShim, registerServiceWorker } from '../src/recreate/behavior/preserve/complete.js';
import { serveFolder } from '../src/recreate/behavior/preserve/render.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4950000000049454e44ae426082', 'hex');
const SAME = {
  '/_next/image?url=%2Fscreens%2Fagents.png&w=640&q=75': '/_next/image~11111111.png',
  '/_next/image?url=%2Fscreens%2Fagents.png&w=750&q=75': '/_next/image~22222222.png',
  '/_next/image?url=%2Fscreens%2Fother.png&w=750&q=75': '/_next/image~33333333.png',
  '/security?_rsc=1r34m': '/security~44444444.txt',
};

test('the map holds the picture sizes this page names, nothing else', () => {
  const html = '<img srcset="/_next/image~11111111.png 640w, /_next/image~22222222.png 750w">';
  assert.deepEqual(imageAddressesOf(html, SAME), {
    '/_next/image?url=%2Fscreens%2Fagents.png&w=640&q=75': '/_next/image~11111111.png',
    '/_next/image?url=%2Fscreens%2Fagents.png&w=750&q=75': '/_next/image~22222222.png',
  }, 'another page\'s picture and a data answer are left out');
});

test('a picture the page\'s script draws with the original\'s image addresses loads the copy\'s files on a first visit', { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-imgmap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, '_next'), { recursive: true });
  for (const local of new Set(Object.values(SAME))) await writeFile(path.join(dir, local), PNG);
  // The page as the lift leaves it (its srcset already local), and a script that draws the picture again as the runtime does.
  await writeFile(path.join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>
<img id="a" sizes="100vw" srcset="/_next/image~11111111.png 640w, /_next/image~22222222.png 750w">
<script>
  var img = document.getElementById('a');
  img.setAttribute('srcset', '/_next/image?url=%2Fscreens%2Fagents.png&w=640&q=75 640w, /_next/image?url=%2Fscreens%2Fagents.png&w=750&q=75 750w');
  var b = new Image(); b.srcset = '/_next/image?url=%2Fscreens%2Fagents.png&w=750&q=75 750w'; b.sizes = '100vw'; document.body.appendChild(b);
  var c = document.createElement('img'); c.src = location.origin + '/_next/image?url=%2Fscreens%2Fagents.png&w=640&q=75'; document.body.appendChild(c);
  var link = document.createElement('a'); link.setAttribute('href', '/pricing?plan=pro'); document.body.appendChild(link);
</script></body></html>`);
  await registerServiceWorker(dir, 'index.html', { same: SAME });
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts[0].includes('window.URL=S') && scripts[1].includes('sasImageMap'), 'the map is the second script, before any of the page\'s');
  assert.ok(!scripts[1].includes('other.png'), 'only this page\'s pictures');

  const server = await serveFolder(dir);
  const context = await browser.newContext({ viewport: { width: 412, height: 800 }, deviceScaleFactor: 1.75, serviceWorkers: 'block' });
  const asked = [];
  try {
    const page = await context.newPage();
    page.on('request', (r) => asked.push(new URL(r.url()).pathname + new URL(r.url()).search));
    await page.goto(`${server.url}index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    assert.deepEqual(asked.filter((a) => a.includes('?url=')), [], `no image address of the original is asked of the copy (${asked.join(', ')})`);
    assert.ok(asked.some((a) => a === '/_next/image~22222222.png'), 'the 750 w size comes from the copy\'s file');
    const state = await page.evaluate(async () => ({
      // Which file each picture drew from (a 1 px picture under a 750w descriptor has a naturalWidth of 0, so that says nothing).
      loaded: await Promise.all([...document.images].map((i) => i.decode().then(() => new URL(i.currentSrc).pathname, () => `failed: ${i.currentSrc}`))),
      link: document.querySelector('a').getAttribute('href'),
      src: document.images[2].getAttribute('src'),
    }));
    assert.deepEqual(state.loaded, ['/_next/image~22222222.png', '/_next/image~22222222.png', '/_next/image~11111111.png'], 'every picture drew, from the copy\'s files');
    assert.equal(state.link, '/pricing?plan=pro', 'an address that is not a mapped picture passes unchanged');
    assert.equal(state.src, '/_next/image~11111111.png');
  } finally {
    await context.close();
    await server.close();
  }
});

test('the script is a no-op for values it does not map', () => {
  const src = imageAddressShim({ '/a?x=1': '/a~1.png' });
  assert.match(src, /^\(function\(\)\{var M=\{"\/a\?x=1":"\/a~1\.png"\};window\.sasImageMap=M;/);
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|setTimeout/, 'no network, no timer');
});
