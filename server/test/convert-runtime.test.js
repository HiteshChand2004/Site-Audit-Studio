// A converted copy (React + Vite, Next.js, MERN) of a site whose framework hydrates: the original's runtime drew its own content
// over the components on load, so an owner's change to a component never showed (React error #418 on a Next.js site). The runtime
// is now taken out of every page proven to do without it (convert/runtime.js finds it, behavior/preserve/runtimeFree.js proves it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { markEdits, pruneServiceWorker, runtimeNotes, runtimesOf, withoutRuntime } from '../src/recreate/convert/runtime.js';
import { behaviourGaps, runtimeFreeCopy, withHead } from '../src/recreate/behavior/preserve/runtimeFree.js';

const NEXT_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Home</title>
<link rel="stylesheet" href="/_next/static/chunks/site.css">
<link rel="preload" as="script" href="/_next/static/chunks/main.js">
<link rel="preload" as="font" href="/_next/static/media/a.woff2" crossorigin>
<script>try{document.documentElement.dataset.theme='dark'}catch(e){}</script>
<script src="/_next/static/chunks/main.js" async></script>
<script type="application/ld+json">{"@type":"Organization"}</script>
</head><body><header><nav><a href="/">Home</a></nav></header><main><section><h1>Hello</h1><p>World of words</p></section>
<section><h2>More</h2><p>Second part</p></section></main><footer><p>Footer text</p></footer>
<script>(self.__next_f=self.__next_f||[]).push([0])</script><script>self.__next_f.push([1,"0:{}"])</script>
<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js');}</script></body></html>`;

test('the Next.js runtime is found and only its parts leave the page', () => {
  assert.deepEqual(runtimesOf(NEXT_PAGE), [{ id: 'next', name: 'Next.js' }]);
  const out = withoutRuntime(NEXT_PAGE);
  assert.equal(out.removed.length, 4, 'the bundle, its preload and both data pushes');
  assert.deepEqual(out.files, ['/_next/static/chunks/main.js']);
  assert.doesNotMatch(out.html, /__next_f|main\.js/);
  // Everything that is not the runtime stays: the stylesheet, the font preload, the theme script, the structured data, the
  // copy's own service worker registration, the content.
  for (const kept of ['site.css', 'a.woff2', "dataset.theme='dark'", 'application/ld+json', "register('/sw.js')", 'World of words']) assert.ok(out.html.includes(kept), kept);
});

test('other frameworks are recognised; a page without one is left alone', () => {
  assert.deepEqual(runtimesOf('<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{}</script></body></html>').map((r) => r.id), ['next']);
  assert.deepEqual(runtimesOf('<html><body><div id="__nuxt"></div><script>window.__NUXT__={}</script><script type="module" src="/_nuxt/entry.js"></script></body></html>').map((r) => r.id), ['nuxt']);
  assert.deepEqual(runtimesOf('<html><body><script>__sveltekit_abc = {base:""};</script></body></html>').map((r) => r.id), ['sveltekit']);
  assert.deepEqual(runtimesOf('<html><body><astro-island uid="1"><p>x</p></astro-island></body></html>').map((r) => r.id), ['astro']);
  assert.deepEqual(runtimesOf('<html><body><div data-framer-hydrate-v2="{}"></div><script type="module" src="/sites/abc/script_main.mjs"></script></body></html>').map((r) => r.id), ['framer']);
  const plain = '<html><head><script src="/js/slider.js"></script></head><body><p>Text</p></body></html>';
  assert.deepEqual(runtimesOf(plain), []);
  assert.equal(withoutRuntime(plain).html, plain, 'unchanged, byte for byte');
});

test('every section gets one marker; the service worker map loses only the files that left', () => {
  const marked = markEdits(NEXT_PAGE);
  assert.ok(marked.marks.length >= 3, `marks: ${JSON.stringify(marked.marks)}`);
  for (const m of marked.marks) assert.ok(marked.html.includes(m.mark));
  const sw = 'const MAP = {"https://a.test/_next/static/chunks/main.js":"/_next/static/chunks/main.js","https://a.test/x.css":"/x.css"};\nconst HOSTS = [];';
  const pruned = pruneServiceWorker(sw, ['/_next/static/chunks/main.js']);
  assert.match(pruned, /"\/x\.css"/);
  assert.doesNotMatch(pruned, /main\.js/);
  assert.ok(pruned.endsWith('const HOSTS = [];'));
  assert.equal(pruneServiceWorker('self.addEventListener("fetch", () => {})', ['/a.js']), null);
});

test('the title a runtime set after load is written into the page; behaviour gaps are named', () => {
  const head = withHead(NEXT_PAGE, { title: 'Home · Site', description: null });
  assert.match(head.html, /<title>Home · Site<\/title>/);
  assert.deepEqual(head.changed, { title: { from: 'Home', to: 'Home · Site' } });
  assert.equal(withHead(NEXT_PAGE, { title: 'Home' }), null);
  const asIs = { width: 375, moves: true, clicks: [{ i: 0, shown: true, delta: { added: ['Menu'], removed: [] }, at: '/' }] };
  const free = { width: 375, moves: false, clicks: [{ i: 0, shown: true, delta: { added: [], removed: [] }, at: '/' }] };
  assert.equal(behaviourGaps(free, asIs).length, 2);
  assert.deepEqual(behaviourGaps(asIs, asIs), []);
});

// A framework in miniature: its bundle draws every [data-k] element from the inline data pushes once the page has loaded (what
// hydration does), wires the menu button of a page that has one, and keeps a counter going on a page that has one (what the
// copy cannot replay: it changes by itself, not on a click).
const RUNTIME = `(function(){function run(){var d={};(self.__next_f||[]).forEach(function(x){if(typeof x[1]==='string'&&x[1].charAt(0)==='{')Object.assign(d,JSON.parse(x[1]));});
document.querySelectorAll('[data-k]').forEach(function(el){if(d[el.getAttribute('data-k')])el.textContent=d[el.getAttribute('data-k')];});
var b=document.getElementById('menu-btn');if(b)b.addEventListener('click',function(){document.getElementById('menu').hidden=false;});
var k=document.getElementById('tick');if(k)setInterval(function(){k.textContent=String(Number(k.textContent)+1);},400);}
if(document.readyState==='complete')setTimeout(run,50);else window.addEventListener('load',function(){setTimeout(run,50);});})();`;
const page = ({ title, menu = false, ticker = false }) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/site.css"><script src="/_next/static/chunks/main.js" async></script></head><body>
<header><p data-k="h">The header line</p>${menu ? '<button id="menu-btn" type="button">Menu</button><ul id="menu" hidden><li>One menu item</li></ul>' : ''}</header>
<main>${ticker ? '<p>Documents read today: <span id="tick">1</span></p>' : ''}<section><h1 data-k="t">A heading for ${title}</h1><p data-k="a">The first paragraph of the page.</p></section>
<section><h2 data-k="u">Another part</h2><p data-k="b">The second paragraph of the page.</p></section></main>
<footer><p data-k="f">Footer words</p></footer>
<script>(self.__next_f=self.__next_f||[]).push([0])</script>
<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify({ h: 'The header line', t: `A heading for ${title}`, a: 'The first paragraph of the page.', u: 'Another part', b: 'The second paragraph of the page.', f: 'Footer words' }))}])</script>
</body></html>`;

test('in a browser (prefer exact): a page that does without its runtime loses it, one that needs it keeps it, a plain one is left alone', { timeout: 600000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-runtime-free-'));
  const browser = await chromium.launch();
  try {
    const copy = path.join(root, 'copy');
    await mkdir(path.join(copy, '_next', 'static', 'chunks'), { recursive: true });
    await mkdir(path.join(copy, 'menu'), { recursive: true });
    await mkdir(path.join(copy, 'ticker'), { recursive: true });
    await mkdir(path.join(copy, 'plain'), { recursive: true });
    await writeFile(path.join(copy, '_next', 'static', 'chunks', 'main.js'), RUNTIME, 'utf8');
    await writeFile(path.join(copy, 'site.css'), 'body{font:16px/1.5 sans-serif;margin:0;padding:24px}section{margin:24px 0}', 'utf8');
    await writeFile(path.join(copy, 'sw.js'), 'const MAP = {"https://a.test/_next/static/chunks/main.js":"/_next/static/chunks/main.js"};\n', 'utf8');
    await writeFile(path.join(copy, 'index.html'), page({ title: 'Home' }), 'utf8');
    await writeFile(path.join(copy, 'menu', 'index.html'), page({ title: 'Menu page', menu: true }), 'utf8');
    await writeFile(path.join(copy, 'ticker', 'index.html'), page({ title: 'Ticker page', ticker: true }), 'utf8');
    await writeFile(path.join(copy, 'plain', 'index.html'), '<!DOCTYPE html><html lang="en"><head><title>Plain</title></head><body><main><h1>Plain page</h1><p>Nothing draws over this.</p></main></body></html>', 'utf8');
    const pages = ['index.html', 'menu/index.html', 'ticker/index.html', 'plain/index.html'].map((outPath) => ({ outPath }));

    const { dir, record } = await runtimeFreeCopy({ browser, copyDir: copy, outDir: path.join(root, 'convert-source'), pages, prefer: 'exact' });
    const by = Object.fromEntries(record.pages.map((r) => [r.path, r]));
    assert.equal(by['/'].status, 'removed', JSON.stringify(by['/']));
    assert.deepEqual(by['/'].runtimes, ['Next.js']);
    assert.ok(by['/'].overwritten.length >= 3, 'the runtime drew over the sections');
    // The menu needed the runtime; its click is now replayed by the copy's own script (controls.js).
    assert.equal(by['/menu/'].status, 'removed', JSON.stringify(by['/menu/']));
    assert.deepEqual(by['/menu/'].replay.buttons, ['Menu']);
    // A counter the runtime keeps going is not a click: the strict choice keeps the runtime for it.
    assert.equal(by['/ticker/'].status, 'kept', JSON.stringify(by['/ticker/']));
    assert.equal(by['/ticker/'].why, 'behaviour');
    assert.equal(by['/plain/'].status, 'fine');

    const home = await readFile(path.join(dir, 'index.html'), 'utf8');
    assert.doesNotMatch(home, /__next_f|main\.js/);
    assert.match(await readFile(path.join(dir, 'ticker', 'index.html'), 'utf8'), /main\.js/, 'the page that needs it keeps it');
    assert.doesNotMatch(await readFile(path.join(dir, 'menu', 'index.html'), 'utf8'), /main\.js/);
    // The ticker page still loads the bundle, so the file stays; nothing in the original copy changed.
    assert.ok(await stat(path.join(dir, '_next', 'static', 'chunks', 'main.js')).then(() => true, () => false));
    assert.match(await readFile(path.join(copy, 'index.html'), 'utf8'), /__next_f/);

    // In the copy without the runtime an owner's edit stays on the page.
    const edited = home.replace('The first paragraph of the page.', 'Changed by the owner.');
    await writeFile(path.join(dir, 'index.html'), edited, 'utf8');
    const { serveCopy } = await import('../src/recreate/behavior/preserve/serve.js');
    const s = await serveCopy(dir);
    try {
      const p = await (await browser.newContext()).newPage();
      await p.goto(s.url, { waitUntil: 'load' });
      await p.waitForTimeout(800);
      assert.match(await p.textContent('body'), /Changed by the owner\./);
    } finally {
      await s.close();
    }

    const notes = runtimeNotes(record);
    assert.match(notes.readme, /taken out of 2 of 4 pages/);
    assert.match(notes.readme, /\/ticker\/: without the framework.s code at \d+ px the page stops changing by itself/);
    assert.equal(notes.items.length, 1);
    assert.equal(notes.items[0].page, '/ticker/');

    // Packaged again without a browser (the address stage): the same decisions, no proof.
    const again = await runtimeFreeCopy({ browser: null, copyDir: copy, outDir: path.join(root, 'again'), pages, decided: record, prefer: 'exact' });
    assert.equal(again.record.removedPages, 2);
    assert.equal(await readFile(path.join(again.dir, 'index.html'), 'utf8'), home);
    assert.equal(await readFile(path.join(again.dir, 'menu', 'index.html'), 'utf8'), await readFile(path.join(dir, 'menu', 'index.html'), 'utf8'), 'the replay too');
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('when the owner prefers editable components, a page that needs its runtime loses it anyway and says what it loses', { timeout: 300000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-runtime-editable-'));
  const browser = await chromium.launch();
  try {
    const copy = path.join(root, 'copy');
    await mkdir(path.join(copy, '_next', 'static', 'chunks'), { recursive: true });
    await writeFile(path.join(copy, '_next', 'static', 'chunks', 'main.js'), RUNTIME, 'utf8');
    await writeFile(path.join(copy, 'site.css'), 'body{margin:0;padding:24px}', 'utf8');
    await writeFile(path.join(copy, 'index.html'), page({ title: 'Ticker page', ticker: true }), 'utf8');
    const { dir, record } = await runtimeFreeCopy({ browser, copyDir: copy, outDir: path.join(root, 'out'), pages: [{ outPath: 'index.html' }], prefer: 'editable' });
    const r = record.pages[0];
    assert.equal(r.status, 'removed', JSON.stringify(r));
    assert.ok(r.gaps.some((g) => g.kind === 'motion'), JSON.stringify(r.gaps));
    assert.equal(record.prefer, 'editable');
    assert.doesNotMatch(await readFile(path.join(dir, 'index.html'), 'utf8'), /main\.js/);
    const notes = runtimeNotes(record);
    assert.match(notes.readme, /you chose the components over an exact copy/);
    assert.equal(notes.items.length, 1);
    assert.equal(notes.items[0].reason, 'editable');
    assert.match(notes.items[0].values, /the page stops changing by itself/);
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a page whose runtime no other page needs takes its files and service-worker entries with it', { timeout: 300000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-runtime-files-'));
  const browser = await chromium.launch();
  try {
    const copy = path.join(root, 'copy');
    await mkdir(path.join(copy, '_next', 'static', 'chunks'), { recursive: true });
    await writeFile(path.join(copy, '_next', 'static', 'chunks', 'main.js'), RUNTIME, 'utf8');
    await writeFile(path.join(copy, 'site.css'), 'body{margin:0;padding:24px}', 'utf8');
    await writeFile(path.join(copy, 'sw.js'), 'const MAP = {"https://a.test/_next/static/chunks/main.js":"/_next/static/chunks/main.js","https://a.test/site.css":"/site.css"};\n', 'utf8');
    await writeFile(path.join(copy, 'index.html'), page({ title: 'Home' }), 'utf8');
    const { dir, record } = await runtimeFreeCopy({ browser, copyDir: copy, outDir: path.join(root, 'out'), pages: [{ outPath: 'index.html' }] });
    assert.equal(record.removedPages, 1, JSON.stringify(record.pages));
    assert.equal(record.filesRemoved, 1);
    assert.equal(await stat(path.join(dir, '_next', 'static', 'chunks', 'main.js')).then(() => true, () => false), false);
    const sw = await readFile(path.join(dir, 'sw.js'), 'utf8');
    assert.doesNotMatch(sw, /main\.js/);
    assert.match(sw, /site\.css/);
    assert.match(runtimeNotes(record).readme, /taken out of every page/);
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
