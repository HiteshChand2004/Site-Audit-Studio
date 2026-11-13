// Three ways an as-is copy of a Webflow site (onfinance.ai) broke in the browser while every file was there:
// 1. the integrity hash a page names for its stylesheet and script still named the original's bytes, and the copy had changed
//    them (the lift points their url() addresses at the copy's files): the browser refused both and the page showed unstyled;
// 2. a picture whose file name holds a literal "%20" (Webflow's smaller sizes) was written with that %20 as it is, which the
//    browser decodes to a space: 7 pictures 404, and a name with spaces broke the srcset it stood in;
// 3. a font loader built "/css?family=Kalam:300,400,…" (its Google Fonts address, made the copy's own); the bare file has no
//    extension, so the host sent it as application/octet-stream and the browser refused the stylesheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { addressOf } from '../src/recreate/behavior/preserve/pageLift.js';
import { integrityOf, refreshIntegrity } from '../src/recreate/behavior/preserve/integrity.js';
import { imageAddressesOf, imageAddressShim } from '../src/recreate/behavior/preserve/complete.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

const sha = (alg, s) => `${alg}-${createHash(alg).update(s).digest('base64')}`;

test('a local path is written as an address that finds the file again', () => {
  assert.equal(addressOf('/site/app.css'), '/site/app.css', 'a plain path is unchanged');
  assert.equal(addressOf('/a/Shot%202024-12-28 at 7.59 PM-p-500.png'), '/a/Shot%25202024-12-28%20at%207.59%20PM-p-500.png');
  assert.equal(decodeURIComponent(addressOf('/a/Shot%202024 x.png')), '/a/Shot%202024 x.png', 'decodes back to the file name');
  assert.equal(addressOf('/a/b#c?d"e.png'), '/a/b%23c%3Fd%22e.png');
  assert.equal(addressOf('/fonts/Café.woff2'), '/fonts/Café.woff2', 'other characters stay as they were');
});

test('an integrity hash names the copy\'s file as it is; another site\'s file keeps its hash', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-sri-'));
  const css = 'body{background:rgb(1,2,3)}';
  const js = 'document.documentElement.dataset.ran="yes";';
  await mkdir(path.join(dir, 'css'), { recursive: true });
  await mkdir(path.join(dir, 'blog'), { recursive: true });
  await writeFile(path.join(dir, 'css', 'site.css'), css);
  await writeFile(path.join(dir, 'app.js'), js);
  const page = (pre) => `<!doctype html><html><head>
<link href="${pre}css/site.css" rel="stylesheet" type="text/css" integrity="sha384-NOTTHEFILE" crossorigin="anonymous"/>
<script src="${pre}app.js" integrity='sha512-old' crossorigin="anonymous"></script>
<link rel="stylesheet" href="https://cdn.example.test/x.css" integrity="sha384-THEIRS">
</head><body>x</body></html>`;
  await writeFile(path.join(dir, 'index.html'), page('/'));
  await writeFile(path.join(dir, 'blog', 'index.html'), page('../'));
  const r = await refreshIntegrity(dir);
  assert.deepEqual(r, { pages: 2, changed: 4 });
  for (const f of ['index.html', 'blog/index.html']) {
    const html = await readFile(path.join(dir, f), 'utf8');
    assert.ok(html.includes(`integrity="${sha('sha384', css)}"`), `${f}: the stylesheet's hash is the file's`);
    assert.ok(html.includes(`integrity="${sha('sha512', js)}"`), `${f}: the algorithm the page named is kept`);
    assert.ok(html.includes('integrity="sha384-THEIRS"'), `${f}: another site's file keeps its hash`);
  }
  assert.deepEqual(await refreshIntegrity(dir), { pages: 0, changed: 0 }, 'a second pass changes nothing');
  assert.equal(integrityOf(Buffer.from(css), 'sha256-x sha384-y'), sha('sha384', css), 'the strongest algorithm named');

  // In a browser: the stylesheet applies and the script runs.
  const served = await serveCopy(dir);
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    await p.route('https://cdn.example.test/**', (route) => route.fulfill({ status: 404, body: '' }));
    await p.goto(served.url);
    assert.equal(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(1, 2, 3)');
    assert.equal(await p.evaluate(() => document.documentElement.dataset.ran), 'yes');
  } finally {
    await browser.close();
    await served.close();
  }
});

test('a stylesheet a script asks for at a query address is the copy\'s .css file on the first visit', async () => {
  const same = {
    '/css?family=Kalam:300,400,500': '/css~25f14d75.css',
    '/style.css?v=2': '/style~aa.css', // its bare path is a .css: a host serves it right without help
    '/_next/image?url=%2Fa.png&w=750': '/_next/image~11.webp',
  };
  const map = imageAddressesOf('<img src="/_next/image~11.webp">', same);
  assert.deepEqual(map, { '/css?family=Kalam:300,400,500': '/css~25f14d75.css', '/_next/image?url=%2Fa.png&w=750': '/_next/image~11.webp' });

  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-fontcss-'));
  await writeFile(path.join(dir, 'css~25f14d75.css'), 'body{color:rgb(9,8,7)}');
  await writeFile(path.join(dir, 'css'), 'body{color:rgb(9,8,7)}'); // the bare file: no extension
  // As webfont.js does it: an address built from the page's protocol, set with setAttribute on a new link.
  await writeFile(path.join(dir, 'index.html'), `<!doctype html><html><head><script>${imageAddressShim(map)}</script>
<script>var l=document.createElement('link');l.setAttribute('rel','stylesheet');l.setAttribute('href',location.protocol+'/css?family=Kalam:300,400,500');document.head.appendChild(l);</script>
</head><body>x</body></html>`);
  const served = await serveCopy(dir);
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    await p.goto(served.url, { waitUntil: 'load' });
    assert.equal(await p.evaluate(() => getComputedStyle(document.body).color), 'rgb(9, 8, 7)');
    assert.match(await p.evaluate(() => document.querySelector('link[rel=stylesheet]').getAttribute('href')), /^\/css~25f14d75\.css$/);
  } finally {
    await browser.close();
    await served.close();
  }
});
