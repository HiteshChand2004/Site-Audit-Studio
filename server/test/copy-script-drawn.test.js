// A picture the page's own script draws again by its address after load (a runtime re-rendering the page from its data, as
// flexibench's Next.js pages do) keeps its file: a WebP or a smaller copy written into the markup would be downloaded besides
// the original the script asks for again (flexibench /internal-tools: 4.2 MB WebP + 7.6 MB PNG of the same picture).
// perfProbe records the addresses a script writes after the document was parsed; planPerf carries them; fixImageSizes and
// fixPngImages leave those pictures and say why.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import sharp from 'sharp';
import { launchBrowser } from '../src/audit/render.js';
import { perfProbe } from '../src/recreate/behavior/preserve/check.js';
import { fixImageSizes, fixPngImages, planPerf } from '../src/copy/perfAsIs.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Runtime</title></head><body>
<main><h1>Pictures</h1>
<div id="slot"><img id="a" src="/a.png" alt="Drawn again" width="300" height="150"></div>
<img id="b" src="/b.png" alt="Left alone" width="300" height="150">
</main>
<script>
  // What a runtime does after load: it throws the parsed element away and draws its own, by the same address.
  addEventListener('load', function () {
    setTimeout(function () {
      var img = document.createElement('img');
      img.src = '/a.png'; img.alt = 'Drawn again'; img.width = 300; img.height = 150;
      document.getElementById('slot').replaceChildren(img);
    }, 100);
  });
</script></body></html>`;

let server;
let browser;
let png;

before(async () => {
  png = await sharp({ create: { width: 300, height: 150, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
  server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    if (p === '/a.png' || p === '/b.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(png);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

test('perfProbe names the picture a script draws again after load, not the one the markup alone draws', async () => {
  const probe = await perfProbe(browser, `http://127.0.0.1:${server.address().port}`, '/', { widths: [1440] });
  const drawn = probe.widths[0].scriptSrc;
  assert.ok(drawn.includes('/a.png'), `drawn again: ${drawn}`);
  assert.ok(!drawn.includes('/b.png'), `parsed only: ${drawn}`);
  assert.deepEqual([...planPerf(probe, '/').scriptDrawn], ['/a.png']);
});

test('a picture drawn again by a script gets neither a WebP nor smaller copies; the other one still does', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-script-drawn-'));
  try {
    await mkdir(path.join(dir, 'img'), { recursive: true });
    // A gradient: a lossless WebP of it is far smaller than the uncompressed PNG.
    const raw = Buffer.alloc(1800 * 900 * 3);
    for (let y = 0; y < 900; y++) for (let x = 0; x < 1800; x++) { const i = (y * 1800 + x) * 3; raw[i] = (x / 9) | 0; raw[i + 1] = (y / 4) | 0; raw[i + 2] = 120; }
    const big = await sharp(raw, { raw: { width: 1800, height: 900, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    await writeFile(path.join(dir, 'img', 'a.png'), big);
    await writeFile(path.join(dir, 'img', 'b.png'), big);
    const html = '<!doctype html><html><body><img src="/img/a.png" alt="a"><img src="/img/b.png" alt="b"></body></html>';
    const image = (src) => ({ k: 0, src, total: 1, visible: true, top: 0, left: 0, right: 100, nw: 1800, chooses: false, moves: false });
    const drawnAt = { '0|/img/a.png': [[375, 343], [1440, 600]], '0|/img/b.png': [[375, 343], [1440, 600]] };
    const probe = {
      widths: [
        { width: 375, viewportH: 812, images: [image('/img/a.png'), image('/img/b.png')], scriptSrc: ['/img/a.png'] },
        { width: 1440, viewportH: 900, images: [image('/img/a.png'), image('/img/b.png')], drawn: drawnAt, scriptSrc: [] },
      ],
    };
    const plan = planPerf(probe, '/');
    const page = { path: '/', outPath: 'index.html' };

    const $ = load(html);
    const sizes = await fixImageSizes($, page, dir, plan);
    assert.equal($('img[alt=a]').attr('srcset'), undefined, 'no smaller copies for the picture drawn again');
    assert.ok($('img[alt=b]').attr('srcset'), 'the other picture still gets them');
    assert.match(sizes.open.map((o) => o.detail).join('\n'), /\/img\/a\.png keeps its file: the page's own script draws it again/);

    const webp = await fixPngImages($, page, dir, new Map(), plan);
    assert.equal($('img[alt=a]').attr('src'), '/img/a.png', 'no WebP for the picture drawn again');
    assert.match($('img[alt=b]').attr('src'), /^\/img\/b\.sas-[0-9a-f]{10}\.webp$/);
    assert.ok(webp.fixed.every((f) => f.src !== '/img/a.png'));
    assert.match(webp.open.map((o) => o.detail).join('\n'), /\/img\/a\.png keeps its file/);
    assert.ok(!(await readdir(path.join(dir, 'img'))).some((f) => f.startsWith('a.sas-')), 'no file written for it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
