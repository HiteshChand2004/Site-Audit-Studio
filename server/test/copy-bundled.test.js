// A "bundled" page (one self-contained HTML file) ships a shell and its real document as a JSON string in
// <script type="__bundler/template">; its loader puts that document in place of the shell when the page loads. procuredesk.panscience.ai
// was such a site: the copy made 16 fixes in the shell and the browser threw all of them away, so the re-check read the
// original's title, description and missing lang on the copy. Its head tags also stood in a <helmet> block in the body (its
// script moves them into the head), where a fix written into <head> lost to them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { bundledTemplate, drawnHtml, syncShellHead, withTemplate } from '../src/copy/bundled.js';
import { fixAsIsCopy } from '../src/copy/fixAsIs.js';
import { applyToHtml } from '../src/copy/fixMode.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

const LONG = 'Garden Tools — The Best Garden Tools Shop For Every Season, Every Garden And Every Gardener';
const WORDS = 'We sell spades, rakes and shears that last for years. Every tool is tested in our own garden before it is sold, and we will repair it for free if it breaks. Order before noon and it ships the same day from our shop in the valley.';

// The document the loader draws: its head tags in a <helmet> block (moved into the head by its own script), a stylesheet in
// the body (text that is not words), no lang.
const DRAWN = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<script>document.addEventListener('DOMContentLoaded',function(){var h=document.querySelector('helmet');if(!h)return;while(h.firstChild)document.head.appendChild(h.firstChild);h.remove();});</script>
</head>
<body>
<helmet>
<title>${LONG}</title>
<meta name="description" content="Tools.">
<style>.x{font-family:sans-serif;color:#222;margin:0;padding:0;border:0}${'.y{color:#333}'.repeat(400)}</style>
</helmet>
<main><h1>Garden tools that last</h1><p>${WORDS}</p><p>${WORDS}</p></main>
</body></html>`;

// The shell: its own title (the original's), a loading note, the loader, and the template.
const shell = (drawn) => `<!DOCTYPE html><html><head>
  <meta charset="utf-8">
  <title>${LONG}</title>
  <style>body{background:#faf9f5}</style>
</head>
<body><div id="__bundler_loading">Loading…</div>
<script>document.addEventListener('DOMContentLoaded',function(){var t=JSON.parse(document.querySelector('script[type="__bundler/template"]').textContent);document.open();document.write(t);document.close();});</script>
<script type="__bundler/template">${JSON.stringify(drawn).replace(/<\//g, '<\\/')}</script>
</body></html>`;

test('a bundled page: its template is found, read and written back as the loader reads it', () => {
  const page = shell(DRAWN);
  const t = bundledTemplate(page);
  assert.ok(t, 'found');
  assert.equal(t.inner, DRAWN);
  assert.equal(drawnHtml(page), DRAWN);
  assert.equal(drawnHtml('<html><body>plain</body></html>'), '<html><body>plain</body></html>', 'an ordinary page is itself');
  assert.equal(bundledTemplate('<script type="__bundler/template">"not a page"</script>'), null, 'a string that is no document');
  const next = withTemplate(page, t, DRAWN.replace('Tools.', 'Better tools.'));
  assert.ok(!next.slice(t.start).includes('</script></script>'), 'every </ inside the JSON is escaped');
  assert.equal(drawnHtml(next), DRAWN.replace('Tools.', 'Better tools.'));
  assert.equal(next.slice(0, t.start), page.slice(0, t.start), 'the shell before the template is untouched');
});

test('the shell\'s head follows the drawn document (a reader that runs no script sees the same tags)', () => {
  const drawn = '<html lang="en"><head><title>Short</title><meta name="description" content="New words here."><meta property="og:title" content="Short"><script type="application/ld+json">{"@type":"WebSite"}</script></head><body></body></html>';
  const out = syncShellHead('<html><head><title>Long old title</title><meta name="description" content="Old."><style>a{}</style></head><body>x</body></html>', drawn);
  assert.match(out.html, /<html lang="en">/);
  assert.match(out.html, /<title>Short<\/title>/);
  assert.match(out.html, /<meta name="description" content="New words here.">/);
  assert.match(out.html, /og:title/);
  assert.match(out.html, /"@type":"WebSite"/);
  assert.match(out.html, /<style>a\{\}<\/style>/, 'the shell\'s own tags stay');
  assert.equal(syncShellHead(out.html, drawn).changed, 0, 'a second pass changes nothing');
});

test('the copy\'s fixes are made in the document the browser draws, and the browser shows them', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-bundled-'));
  await writeFile(path.join(dir, 'index.html'), shell(DRAWN));
  const r = await fixAsIsCopy({ dir, pages: [{ path: '/', outPath: 'index.html', url: 'https://garden.example/' }], siteUrl: 'https://garden.example/' });
  const page = r.pages[0];
  assert.equal(page.bundled, true);
  const kinds = page.fixes.map((f) => `${f.kind}:${f.field}`);
  for (const k of ['head:title', 'head:description', 'lang:lang']) assert.ok(kinds.includes(k), `${k} made (${kinds.join(', ')})`);
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  const title = page.fixes.find((f) => f.field === 'title').value;
  assert.ok(title.length >= 10 && title.length <= 60, title);
  assert.ok(drawnHtml(html).includes(`<title>${title}</title>`), 'in the template\'s helmet');
  assert.ok(!/<head>[^]*<title>[^]*<\/head>[^]*<helmet>/.test(drawnHtml(html)), 'no second title written into the drawn head');
  assert.ok(html.slice(0, html.indexOf('</head>')).includes(`<title>${title}</title>`), 'the shell\'s title follows');

  const served = await serveCopy(dir);
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    await p.goto(served.url, { waitUntil: 'load' });
    await p.waitForFunction(() => !document.getElementById('__bundler_loading') && document.querySelector('h1'));
    const seen = await p.evaluate(() => ({ title: document.title, lang: document.documentElement.lang, description: document.querySelector('meta[name="description"]')?.content }));
    assert.equal(seen.title, title, 'the browser shows the fixed title');
    assert.equal(seen.lang, 'en', 'and the language');
    assert.ok(seen.description.length >= 50, `and the fixed description (${seen.description})`);
  } finally {
    await browser.close();
    await served.close();
  }
});

test('Fix mode writes an approved colour into the drawn document of a bundled page', () => {
  const page = shell(DRAWN.replace('<h1>', '<h1 class="faint">'));
  const out = applyToHtml(page, [{ id: 'x', kind: 'contrast', selector: 'h1.faint', change: { to: '#333333' } }]);
  assert.deepEqual(out.applied, ['x']);
  assert.match(drawnHtml(out.html), /<h1 class="faint" style="color: #333333 !important">/);
});
