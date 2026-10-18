// The sizes attribute of a copied image: a breakpoint never names a width larger than its view (a box recorded wider than the
// phone, 676 px on a 375 px view, made the browser download a 1536 px file for a 390 px screen), and the site's own sizes is
// kept where it gave one. The browser check picks the candidate a phone really needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { applyImageVariants, sizesFor } from '../src/recreate/assets/variants.js';

const BREAKPOINTS = { mobile: 699.98, tablet: 809.98, laptop: 1319.98 };

test('sizes: no breakpoint names a width wider than its view', () => {
  // parchaa: the phone view recorded the picture 676 px wide; the phone is 375 px wide.
  const sizes = sizesFor({ mobile: 676, tablet: 1086, laptop: 1086, desktop: 1395 }, BREAKPOINTS);
  assert.equal(sizes, '(max-width: 699.98px) 375px, (max-width: 809.98px) 768px, (max-width: 1319.98px) 1024px, 1395px');
  for (const [view, px] of [['mobile', 375], ['tablet', 768], ['laptop', 1024]]) {
    const m = sizes.match(new RegExp(`${BREAKPOINTS[view]}px\\) (\\d+)px`));
    if (m) assert.ok(Number(m[1]) <= px, `${view}: ${m[1]}px is wider than the ${px}px view`);
  }
});

test('sizes: a view that is the widest still caps at the desktop width', () => {
  assert.equal(sizesFor({ desktop: 2000 }, {}), '1440px');
});

test('sizes: the site\'s own sizes attribute is kept; ours is computed only where it is missing', () => {
  const variants = new Map([['images/a.png', [{ asset: 'images/a-390w.webp', w: 390 }, { asset: 'images/a-780w.webp', w: 780 }]]]);
  const img = (sizes) => ({ t: 'img', rw: { mobile: 390, desktop: 1395 }, attrs: { src: { asset: 'images/a.png' }, ...(sizes && { sizes }) } });
  const ir = { breakpoints: BREAKPOINTS, pages: [{ body: { t: 'body', children: [img('100vw'), img()] } }] };
  assert.equal(applyImageVariants(ir, variants), 2);
  const [own, computed] = ir.pages[0].body.children;
  assert.equal(own.attrs.sizes, '100vw', 'the site\'s sizes is kept');
  assert.equal(computed.attrs.sizes, sizesFor({ mobile: 390, desktop: 1395 }, BREAKPOINTS), 'ours is computed where the site gave none');
});

test('browser: a phone at 2x picks the candidate near its width, not the largest file', { timeout: 120000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-sizes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Candidates for a 390 px phone: 390, 780 and the original 1536. The recorded 676 px view is what the old sizes said.
  const sizes = sizesFor({ mobile: 676, desktop: 1395 }, BREAKPOINTS);
  await writeFile(path.join(dir, 'index.html'), `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="margin:0"><img id="p" alt="" style="width:100%;display:block" sizes="${sizes}"
    srcset="a-390.png 390w, a-780.png 780w, a-1536.png 1536w" src="a-1536.png"></body></html>`, 'utf8');
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
    await page.route('**/*.png', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));
    await page.goto(`file://${path.join(dir, 'index.html').replace(/\\/g, '/')}`);
    const chosen = await page.evaluate(() => document.getElementById('p').currentSrc);
    assert.ok(chosen.endsWith('a-780.png'), `a 375 px view at 2x picks the 780 px candidate, not ${chosen}`);
  } finally {
    await browser.close();
  }
});
