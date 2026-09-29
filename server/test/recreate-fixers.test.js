// Recreate 4a.5: SVG sanitizer, HTML attribute guard, safety scanner, fixers (a11y, links, loading,
// fonts), WordPress REST content and minification. The REST lookup runs against the local fixture only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeSvgFiles } from '../src/recreate/assets/index.js';
import { buildDist, minifyCss } from '../src/recreate/build/minify.js';
import { accessibleName, fileLabel, fixAlt, fixHeadings, fixNames } from '../src/recreate/fixers/a11y.js';
import { guardAttributes } from '../src/recreate/fixers/html.js';
import { brokenTargets, fixBrokenLinks, fixFonts, fixLoading } from '../src/recreate/fixers/perf.js';
import { sanitizeSvg } from '../src/recreate/fixers/svg.js';
import { cleanContentHtml, fetchWordPress, headHints, itemFor, restBlocks, similarity, syncText } from '../src/recreate/fixers/wordpress.js';
import { createLinkResolver } from '../src/recreate/ir/links.js';
import { deepText } from '../src/recreate/ir/tree.js';
import { userPolicy, withNetPolicy } from '../src/security/netGuard.js';
import { checkContent, scanSite } from '../src/recreate/verify/safety.js';
import { startFixtureServer } from './serve-fixture.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4195;
const origin = `http://localhost:${PORT}`;
let server;
const temps = [];
before(async () => {
  server = await startFixtureServer(PORT, { site: 'recreate' });
});
after(async () => {
  server.close();
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-fix-'));
  temps.push(dir);
  return dir;
};

// A merged tree node: views { desktop: { style, rect, hidden } }.
const view = (rect, style = {}) => ({ style, rect, hidden: false });
const node = (tag, attrs = {}, children = [], { rect = [0, 0, 100, 20], views, ...extra } = {}) => ({
  tag, attrs, children, views: views ?? { desktop: view(rect) }, ...extra,
});
const text = (t) => ({ text: t });
const page = (root, p = '/') => ({ info: { url: `https://s.test${p}`, path: p, outPath: 'index.html' }, root });

const EVIL_SVG = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)" viewBox="0 0 10 10">
<script>alert(1)</script><SCRIPT xlink:href="x.js"/>
<a href="javascript:alert(1)"><circle r="1"/></a><a xlink:href=" java&#x09;script:alert(1)"><rect/></a>
<image href="https://evil.test/x.png"/><use xlink:href="https://evil.test/s.svg#i"/><use href="#ok"/>
<foreignObject><iframe src="x"></iframe></foreignObject><set attributeName="href" to="javascript:alert(1)"/>
<animate attributeName="fill" values="red;blue"/>
<rect fill="url(https://evil.test/p#g)" style="fill:url(#g);stroke:url(http://e/x);scroll-behavior:smooth" onclick="x" inkscape:label="a"/>
<style>@import url(https://evil.test/a.css); .a{background:url(https://evil.test/b.png)} a>b{fill:red}</style>
<text>1 &lt; 2 &amp; 3</text><image href="data:image/png;base64,AAAA"/><image href="data:image/svg+xml,&lt;svg onload=alert(1)&gt;"/>
<a href="https://ok.test/">x</a><!-- comment --></svg>`;

test('SVG sanitizer: scripts, handlers, script URLs and external references are removed; the drawing stays', () => {
  const { svg, removed, changed } = sanitizeSvg(EVIL_SVG);
  assert.equal(changed, true);
  assert.doesNotMatch(svg, /script|onload|onclick|javascript|evil\.test|foreignObject|iframe|inkscape|@import|<!--|ENTITY|<\?xml/i);
  assert.doesNotMatch(svg, /<set\b/); // an animation that rewrites href is dropped
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" xmlns:xlink="[^"]+" viewBox="0 0 10 10">/);
  assert.match(svg, /<use href="#ok"\/>/);
  assert.match(svg, /<animate attributeName="fill" values="red;blue"\/>/);
  assert.match(svg, /<rect style="fill:url\(#g\);stroke:none;scroll-behavior:smooth"\/>/);
  assert.match(svg, /<style> \.a\{background:none\} a&gt;b\{fill:red\}<\/style>/);
  assert.match(svg, /<text>1 &lt; 2 &amp; 3<\/text>/);
  assert.match(svg, /<image href="data:image\/png;base64,AAAA"\/>/);
  assert.match(svg, /<a href="https:\/\/ok\.test\/">x<\/a>/);
  assert.deepEqual(removed, { scripts: 2, handlers: 2, scriptUrls: 2, external: 7, elements: 2 });
  // The result is stable: sanitizing it again changes nothing.
  assert.equal(sanitizeSvg(svg).changed, false);
  assert.equal(sanitizeSvg(svg).svg, svg);

  // Inline SVG may reference local assets; &nbsp; from outerHTML is kept as a character.
  const inline = sanitizeSvg('<svg width="24"><use href="asset:images/icons-1a2b3c4d5e.svg#i"></use><image href="https://x.test/a.png"></image><text>a&nbsp;b</text></svg>', { inline: true });
  assert.equal(inline.svg, '<svg width="24"><use href="asset:images/icons-1a2b3c4d5e.svg#i"/><image/><text>a b</text></svg>');
  assert.equal(sanitizeSvg('<svg><use href="asset:images/a.svg"/></svg>').svg.includes('asset:'), false); // files may not
  assert.equal(sanitizeSvg('<html><body>not svg</body></html>').svg, null);
});

test('SVG files in assets/ are rewritten in place; a file without an <svg> root is removed', async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, 'evil.svg'), EVIL_SVG);
  await writeFile(path.join(dir, 'fake.svg'), '<!doctype html><p>soft 404</p>');
  const result = {
    files: [{ file: 'evil.svg', kind: 'image', mime: 'image/svg+xml' }, { file: 'fake.svg', kind: 'icon', mime: 'image/svg+xml' }],
    map: { 'https://s.test/evil.svg': 'evil.svg', 'https://s.test/fake.svg': 'fake.svg', 'https://s.test/fake.svg?v=2': 'fake.svg' },
    skipped: [],
  };
  const summary = await sanitizeSvgFiles(dir, result);
  assert.deepEqual({ files: summary.files, changed: summary.changed, removedFiles: summary.removedFiles }, { files: 2, changed: 1, removedFiles: 1 });
  assert.doesNotMatch(await readFile(path.join(dir, 'evil.svg'), 'utf8'), /script|onload|evil\.test/);
  assert.deepEqual(result.files.map((f) => f.file), ['evil.svg']);
  assert.deepEqual(Object.values(result.map), ['evil.svg']);
  assert.deepEqual(result.skipped.map((s) => s.reason), ['not-an-asset', 'not-an-asset']);
});

test('HTML attribute guard removes event handlers and script URLs', () => {
  const attrs = { onclick: 'x()', OnMouseOver: 'y', title: 'ok', srcdoc: '<b>', formaction: '/x', 'aria-label': 'Open', xlink: 'javascript:alert(1)', cite: ' jav\tascript:1', rel: 'noopener' };
  const stats = guardAttributes(attrs);
  assert.deepEqual(attrs, { title: 'ok', 'aria-label': 'Open', rel: 'noopener' });
  assert.deepEqual(stats, { handlers: 2, scriptUrls: 2, other: 2 });
});

test('safety scanner finds what could run script or load from another origin', async () => {
  const types = (kind, s) => checkContent(kind, s).map((i) => i.type);
  assert.deepEqual(types('html', '<p onclick="x">a</p><script>1</script><script type="application/ld+json">{}</script><a href="javascript:x">b</a><iframe srcdoc="x"></iframe>'),
    ['script', 'script', 'script', 'script']);
  assert.deepEqual(types('html', '<script type="application/ld+json">{"a":"</scr"+"ipt>"}</script>'), []);
  assert.deepEqual(types('html', '<svg><image href="https://x.test/a.png"/><use href="../assets/i.svg#a"/><a href="https://ok.test/"><circle/></a></svg>'), ['external']);
  assert.deepEqual(types('html', '<a href="https://ok.test/">x</a><img src="assets/a.png" alt=""><iframe src="https://www.youtube.com/embed/x"></iframe>'), []);
  assert.deepEqual(types('svg', EVIL_SVG).includes('script'), true);
  assert.deepEqual(types('svg', sanitizeSvg(EVIL_SVG).svg), []);
  assert.deepEqual(types('css', 'a{background:url(https://x.test/a.png)} @import "x.css"; b{scroll-behavior:smooth;background:url("../assets/b.png")}'), ['external', 'external']);
  assert.deepEqual(types('css', 'a{width:expression(alert(1))}'), ['script']);

  const dir = await tempDir();
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><p>ok</p>');
  await writeFile(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
  assert.deepEqual(await scanSite(dir), { safe: true, checked: { html: 1, svg: 1, css: 0 }, issues: [] });
  await writeFile(path.join(dir, 'bad.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="x"/>');
  const bad = await scanSite(dir);
  assert.equal(bad.safe, false);
  assert.deepEqual(bad.issues.map((i) => i.file), ['bad.svg']);
});

test('alt text: title, figure caption, readable file name, else decorative (reported)', () => {
  assert.equal(fileLabel('https://x.test/img/team-photo@2x-1a2b3c4d.png'), 'Team photo');
  assert.equal(fileLabel('https://x.test/uploads/2024/05/IMG_2031.jpg'), null);
  assert.equal(fileLabel('https://x.test/a/9f86d081884c7d65.webp'), null);
  assert.equal(fileLabel('https://x.test/hero-banner-1920x1080.jpg'), 'Hero banner');

  const root = node('body', {}, [
    node('figure', {}, [node('img', { src: '/a.png' }, [], { src: 'https://s.test/IMG_1.png' }), node('figcaption', {}, [text('Our office')])]),
    node('img', { title: 'Logo' }),
    node('img', {}, [], { src: 'https://s.test/img/city-skyline.jpg' }),
    node('img', {}, [], { src: 'https://s.test/img/DSC0042.jpg' }),
    node('img', { alt: 'Kept' }),
    node('a', { href: '/' }, [node('img', {}, [], { src: 'https://s.test/x.png' }), text('Home')]),
  ]);
  const { fixed, decorative } = fixAlt(page(root));
  assert.deepEqual(fixed.map((f) => [f.value, f.source]), [
    ['Our office', 'figure caption'], ['Logo', 'title attribute'], ['City skyline', 'file name'], ['', 'decorative (the link or button has text)'],
  ]);
  assert.deepEqual(decorative.map((f) => [f.value, f.source]), [['', 'decorative (no description found)']]);
  assert.equal(root.children[4].attrs.alt, 'Kept');
});

test('accessible names for icon links, icon buttons and unlabeled fields', () => {
  const resolveLink = createLinkResolver({ pages: [{ url: 'https://s.test/', outPath: 'index.html' }, { url: 'https://s.test/pricing/', outPath: 'pricing/index.html' }], origin: 'https://s.test' });
  const svg = (inner = '') => node('svg', {}, [], { svg: `<svg viewBox="0 0 1 1">${inner}<path d="M0 0"/></svg>` });
  const root = node('body', {}, [
    node('a', { href: 'https://www.linkedin.com/company/x' }, [svg()], { href: 'https://www.linkedin.com/company/x' }),
    node('a', { href: '/pricing/' }, [svg()], { href: 'https://s.test/pricing/' }),
    node('a', { href: '/' }, [svg()], { href: 'https://s.test/' }),
    node('a', { href: 'mailto:hi@s.test' }, [svg()], { href: 'mailto:hi@s.test' }),
    node('button', { class: 'framer-x navbar-toggler' }, [svg()]),
    node('button', {}, [node('img', {}, [], { src: 'https://s.test/icons/close-icon.svg' })]),
    node('button', {}, [svg('<title>Play video</title>')]),
    node('button', { class: 'b1' }, [svg()]),
    node('label', { for: 'email' }, [text('Email')]),
    node('input', { id: 'email', type: 'email' }),
    node('input', { type: 'search', placeholder: 'Search the site' }),
    node('input', { type: 'hidden', name: 'token' }),
  ]);
  const { fixed, open } = fixNames(page(root), { pageUrl: 'https://s.test/', resolveLink, pageTitles: new Map([['pricing/index.html', 'Pricing plans | Acme']]), siteName: 'Acme' });
  assert.deepEqual(fixed.map((f) => [f.element, f.field, f.value]), [
    ['a', 'aria-label', 'LinkedIn'],
    ['a', 'aria-label', 'Pricing plans'],
    ['a', 'aria-label', 'Acme home'],
    ['a', 'aria-label', 'Email hi@s.test'],
    ['button', 'aria-label', 'Open menu'],
    ['button', 'alt', 'Close'],
    ['input', 'aria-label', 'Search the site'],
  ]);
  assert.deepEqual(open.map((o) => o.element), ['button']); // b1: nothing to go on
  assert.equal(accessibleName(root.children[6]), 'Play video');
  assert.equal(root.children[5].children[0].attrs.alt, 'Close');
});

test('headings: one h1, no skipped levels, siblings stay siblings, margins kept', () => {
  const h = (tag, t, style = {}) => node(tag, {}, [text(t)], { views: { desktop: view([0, 0, 100, 20], { ...style }) } });
  const root = node('body', {}, [
    node('header', {}, [h('h4', 'Newsletter')]),
    node('main', {}, [h('h1', 'Title'), h('h3', 'A'), h('h5', 'A.1'), h('h3', 'B'), h('h1', 'Second title', { 'margin-top': '0px' }), h('h4', 'C')]),
  ]);
  const changes = fixHeadings(page(root));
  assert.deepEqual(changes.map((c) => [c.text, c.from, c.to]), [
    ['A', 'h3', 'h2'], ['A.1', 'h5', 'h3'], ['B', 'h3', 'h2'], ['Second title', 'h1', 'h2'], ['C', 'h4', 'h3'],
  ]);
  const second = root.children[1].children[4];
  assert.deepEqual(second.views.desktop.style, { 'margin-top': '0px', 'margin-bottom': '21.44px' }); // h1 UA margin kept
  assert.equal(root.children[0].children[0].tag, 'h4'); // before the h1: left alone

  const noH1 = node('body', {}, [node('main', {}, [h('h2', 'Welcome'), h('h3', 'More')])]);
  assert.deepEqual(fixHeadings(page(noH1)).map((c) => [c.text, c.from, c.to]), [['Welcome', 'h2', 'h1'], ['More', 'h3', 'h2']]);
});

test('broken links lose their href; loading priorities follow the first screen', () => {
  const broken = brokenTargets(
    { brokenLinks: { broken: [{ url: 'https://s.test/old/', status: 404 }] } },
    [{ url: 'https://s.test/gone', reason: 'error', status: 410 }, { url: 'https://s.test/slow', reason: 'error', status: 200 }, { url: 'https://s.test/login', reason: 'backend' }],
  );
  assert.deepEqual([...broken.values()].map((b) => [b.url, b.source]), [['https://s.test/old/', 'audit'], ['https://s.test/gone', 'discovery']]);
  const root = node('body', {}, [
    node('a', { href: '/old', target: '_blank' }, [text('Old page')], { href: 'https://s.test/old' }),
    node('a', { href: '/fine' }, [text('Fine')], { href: 'https://s.test/fine' }),
  ]);
  const fixed = fixBrokenLinks(page(root), broken, 'https://s.test');
  assert.deepEqual(fixed.map((f) => [f.text, f.status, f.internal]), [['Old page', 404, true]]);
  assert.deepEqual(root.children[0].attrs, {});
  assert.equal(root.children[1].attrs.href, '/fine');

  const img = (y, w, h, extra = {}) => node('img', { ...extra }, [], { views: { desktop: view([0, y, w, h]), mobile: view([0, y, Math.min(w, 375), h]) } });
  const pics = [img(100, 300, 200), img(80, 1200, 500, { loading: 'lazy' }), img(20, 32, 32), img(2000, 800, 400), img(1000, 800, 400)];
  const frame = node('iframe', { src: 'https://www.youtube.com/embed/x' }, [], { views: { desktop: view([0, 3000, 560, 315]) } });
  const res = fixLoading(page(node('body', {}, [...pics, frame])));
  assert.deepEqual(pics[1].attrs, { fetchpriority: 'high', loading: 'eager' }); // the lazy hero is fixed
  assert.equal(pics[0].attrs.fetchpriority, undefined);
  assert.deepEqual(pics[3].attrs, { loading: 'lazy', decoding: 'async' });
  assert.equal(pics[4].attrs.loading, 'lazy'); // below 900 on desktop and 812 on mobile
  assert.deepEqual(pics[2].attrs, {}); // an icon in the first screen: untouched
  assert.equal(frame.attrs.loading, 'lazy');
  assert.deepEqual({ lazy: res.lazy, lazyFrames: res.lazyFrames, priority: res.priority.length }, { lazy: 2, lazyFrames: 1, priority: 1 });
});

test('fonts: swap for blocking font-display, preload for the families that carry the text', () => {
  const ir = {
    fontFaces: [
      { family: 'Inter', weight: '400', style: 'normal', display: 'block', src: [{ asset: 'fonts/inter-a.woff2', format: 'woff2' }] },
      { family: 'Inter', weight: '700', style: 'normal', display: 'swap', src: [{ asset: 'fonts/inter-b.woff2', format: 'woff2' }] },
      { family: 'Serif Display', weight: '400', style: 'normal', src: [{ asset: 'fonts/serif.woff', format: 'woff' }] },
      { family: 'Unused', weight: '400', style: 'normal', src: [{ asset: 'fonts/unused.woff2' }] },
    ],
    rules: [
      { selector: '.page', parts: { base: { 'font-family': 'Inter, sans-serif' } } },
      { selector: '.title', parts: { base: { 'font-family': '"Serif Display", serif' } } },
    ],
    pages: [{ path: '/', html: { class: null }, head: { title: 'x' }, body: { t: 'body', class: 'page', children: [
      { t: 'h1', class: 'title', children: [text('Hello')] },
      { t: 'p', children: [text('A much longer paragraph of body text.')] },
    ] } }],
  };
  const first = fixFonts(ir);
  assert.deepEqual(first.display.map((d) => [d.family, d.from]), [['Inter', 'block'], ['Serif Display', 'auto'], ['Unused', 'auto']]);
  assert.deepEqual(ir.pages[0].head.preload, [
    { asset: 'fonts/inter-a.woff2', as: 'font', type: 'font/woff2' },
    { asset: 'fonts/serif.woff', as: 'font', type: 'font/woff' },
  ]);
  // Idempotent across IR builds: the same report, no duplicate preloads.
  assert.deepEqual(fixFonts(ir), first);
  assert.equal(ir.pages[0].head.preload.length, 2);
});

test('WordPress: clean content, text sync with the rendered page, head hints', async () => {
  const html = cleanContentHtml('<p class="wp-block" style="color:red" onclick="x">Hi <a href="javascript:alert(1)">bad</a> <a href="https://ok.test/" target="_blank">ok</a></p>'
    + '<script>alert(1)</script><form action="/x"><input></form><div class="wp-block-group"><section><h2>Title</h2></section></div>'
    + '<iframe src="https://www.youtube.com/embed/x"></iframe><iframe src="http://insecure.test/"></iframe><svg onload="x"><circle r="1"/></svg><custom-el>kept text</custom-el>');
  assert.equal(html, '<p>Hi <a>bad</a> <a href="https://ok.test/">ok</a></p><div><section><h2>Title</h2></section></div>'
    + '<iframe src="https://www.youtube.com/embed/x" loading="lazy"></iframe><svg><circle r="1"/></svg>kept text');

  assert.deepEqual(restBlocks('<ul><li>One</li><li><p>Two</p></li></ul><h2>Head</h2>'), [{ tag: 'li', text: 'One' }, { tag: 'p', text: 'Two' }, { tag: 'h2', text: 'Head' }]);
  assert.ok(similarity('Email hello [at] example [dot] org today', 'Email hello@example.org today') > 0.7);
  assert.equal(similarity('', 'x'), 0);

  const p = (t) => node('p', {}, [text(t)]);
  const root = node('body', {}, [node('main', {}, [
    node('h1', {}, [text('About')]),
    p('We are a smal team.'),
    node('p', {}, [text('Read '), node('a', { href: '/x' }, [text('our story')]), text(' here.')]),
    p('Contact: info [at] s [dot] test'),
  ])]);
  const t = page(root, '/about/');
  const r = syncText(t, { content: { rendered: '<p>We are a small team.</p><p>Read our full story here.</p><p>Contact: info@s.test</p><p>Only in the CMS.</p>' } });
  assert.deepEqual({ blocks: r.blocks, matched: r.matched, updated: r.updated.length, kept: r.kept, missing: r.missing }, { blocks: 4, matched: 3, updated: 2, kept: 1, missing: 1 });
  assert.equal(deepText(root.children[0].children[1]), 'We are a small team.');
  assert.equal(deepText(root.children[0].children[3]), 'Contact: info@s.test');
  assert.equal(deepText(root.children[0].children[2]), 'Read our story here.'); // inline markup kept as rendered

  assert.deepEqual(headHints({ title: { rendered: 'Caf&eacute; &#8211; menu' }, excerpt: { rendered: '<p>Fresh food daily [&hellip;]</p>' } }), { title: 'Café – menu', excerpt: 'Fresh food daily…' });
});

test('WordPress REST lookup against the fixture API (SSRF-guarded)', async () => {
  const wp = await withNetPolicy(userPolicy(), () => fetchWordPress({
    origin,
    pages: [{ url: `${origin}/` }, { url: `${origin}/contact.html` }, { url: `${origin}/services/` }],
  }));
  assert.equal(wp.reachable, true);
  assert.equal(wp.api, `${origin}/wp-json/wp/v2/`);
  assert.deepEqual(wp.totals, { pages: 2, posts: 2 });
  assert.deepEqual([...wp.items.values()].map((i) => i.id).sort(), [11, 12]);
  assert.equal(itemFor(wp, `http://www.localhost:${PORT}/contact.html`)?.slug, 'contact'); // www and bare host are one site
  assert.equal(itemFor(wp, `${origin}/`), null);

  // A site without the API: reported as unreachable, nothing is guessed.
  const none = await withNetPolicy(userPolicy(), () => fetchWordPress({ origin: `${origin}/cdn`, pages: [{ url: `${origin}/` }] }));
  assert.equal(none.reachable, false);
  assert.equal(none.items.size, 0);
});

test('minification: esbuild CSS and JS in dist/, assets linked', async () => {
  const css = await minifyCss('.a {\n  color: #ff0000;\n  margin: 0px 0px 0px 0px;\n}\n\n@media (max-width: 767.98px) {\n  .a {\n    color: red;\n  }\n}\n');
  assert.equal(css.includes('\n  '), false);
  assert.match(css, /@media ?\(max-width: ?767\.98px\)/);
  const dir = await tempDir();
  const assetsDir = path.join(dir, 'assets');
  await writeFile(path.join(dir, 'x.txt'), '');
  await rm(assetsDir, { recursive: true, force: true });
  await import('node:fs/promises').then((fs) => fs.mkdir(path.join(assetsDir, 'images'), { recursive: true }));
  await writeFile(path.join(assetsDir, 'images', 'a.png'), 'png');
  const files = new Map([['index.html', '<!doctype html><p>x</p>\n'], ['css/site.css', '.a {\n  color: red;\n}\n'], ['js/site.js', 'function hello (name) {\n  return "hi " + name;\n}\nwindow.hello = hello;\n']]);
  const sizes = await buildDist({ files, assets: ['images/a.png'], assetsDir, distDir: path.join(dir, 'dist') });
  assert.equal(await readFile(path.join(dir, 'dist', 'css', 'site.css'), 'utf8'), '.a{color:red}\n');
  const js = await readFile(path.join(dir, 'dist', 'js', 'site.js'), 'utf8');
  assert.ok(js.length < files.get('js/site.js').length && /window\.hello=/.test(js), js);
  assert.equal(await readFile(path.join(dir, 'dist', 'assets', 'images', 'a.png'), 'utf8'), 'png');
  assert.deepEqual([sizes.css.files, sizes.js.files, sizes.files], [1, 1, 4]);
});
