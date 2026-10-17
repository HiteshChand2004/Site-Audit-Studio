// Step (b) prerequisites of the preserve-original work, without a browser: the layout shell, the driver column, the
// build-time download with its fallbacks, the video poster fallback, and origin exclusion of widget-injected parts.
// The site's own portal / modal outside the section is kept; a button a widget script injected is excluded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import { preserveCapture, driverOf } from '../src/recreate/behavior/preserve/index.js';
import { shellOf, localize, filterCss, parseSheets } from '../src/recreate/behavior/preserve/extract.js';
import { fetchMissing, closestVariant } from '../src/recreate/behavior/preserve/fetch.js';
import { collectSignals, groupComponents } from '../src/recreate/behavior/preserve/detect.js';
import { indexSnapshot, resolvePath } from '../src/recreate/behavior/preserve/dom.js';

const sha = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');
const SITE = 'https://site.test/';

test('shell: the ancestors of a component are kept as empty elements, so its layout context is the original\'s', () => {
  const $ = load('<html><body><div class="row" style="display:flex"><section class="s"><p>hi</p></section><aside>x</aside></div></body></html>');
  const el = resolvePath($, 'body>div:1>section:1');
  const shell = shellOf(el);
  assert.match(shell, /<div class="row" style="display:flex">/, 'the flex parent keeps its class and inline style');
  assert.match(shell, /<!--sas-component-->/, 'the marker stands where the component goes');
  assert.doesNotMatch(shell, /<aside|hi</, 'siblings and the content are not part of the shell');
});

test('CSS: a rule for an ancestor (its flex row) reaches the component, a rule for an unrelated element does not', () => {
  const $ = load('<html><body><div class="row"><section class="s"><p>hi</p></section></div><nav class="other"></nav></body></html>');
  const sheets = parseSheets([{ readable: true, raw: '.row{display:flex} .other{color:red} .s p{margin:0}' }]);
  const el = resolvePath($, 'body>div:1>section:1');
  const css = filterCss(sheets, $, el).css;
  assert.match(css, /\.row/, 'the ancestor\'s rule is kept');
  assert.match(css, /\.s p/, 'the subtree\'s own rule is kept');
  assert.doesNotMatch(css, /\.other/, 'an unrelated rule is not kept');
});

test('driver column: CSS-only parts are CSS; a Next.js runtime, Framer and a lift candidate are named', () => {
  const css = { id: 'c1', drivers: ['css'] };
  assert.equal(driverOf(css, []).available, 'css');
  const framer = { id: 'c2', drivers: ['framer'] };
  assert.deepEqual([driverOf(framer, []).available, driverOf(framer, []).runtime], ['runtime', 'Framer']);
  const next = { id: 'c3', drivers: ['script'] };
  const nextScripts = [{ url: 'https://site.test/_next/static/chunks/a.js', status: 'not-lifted', role: 'framework' }];
  assert.deepEqual([driverOf(next, nextScripts).available, driverOf(next, nextScripts).runtime], ['runtime', 'Next.js']);
  const lib = [{ url: 'https://cdn.test/gsap.js', status: 'lift-candidate', role: 'library' }];
  assert.equal(driverOf(next, lib).available, 'lift-candidate');
});

test('build-time fetch: a missing file is downloaded and hashed; a failed one falls back to the closest recorded variant', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-fetch-'));
  try {
    const recordDir = path.join(dir, 'record');
    await mkdir(path.join(recordDir, 'files'), { recursive: true });
    const recorded = Buffer.from('SMALL');
    await writeFile(path.join(recordDir, 'files', sha('SMALL')), recorded);
    const byUrl = new Map([
      ['https://site.test/img.png?width=400', { url: 'https://site.test/img.png?width=400', sha: sha('SMALL'), type: 'image/png', kind: 'image' }],
    ]);
    const fetched = Buffer.from('DOWNLOADED');
    const fakeFetch = async (url, { dir: tmp }) => {
      if (url.includes('fresh.png')) {
        const tmpFile = path.join(tmp, 'fresh.tmp');
        await writeFile(tmpFile, fetched);
        return { ok: true, tmp: tmpFile, sha256: sha('DOWNLOADED'), bytes: fetched.length, mime: 'image/png', finalUrl: url, redirects: [] };
      }
      return { ok: false, reason: 'http-404', finalUrl: url };
    };
    const outDir = path.join(dir, 'out');
    await mkdir(outDir, { recursive: true });
    const assets = [
      { url: 'https://site.test/fresh.png', kind: 'image', status: 'missing' },
      { url: 'https://site.test/img.png?width=800', kind: 'image', status: 'missing' },
    ];
    await fetchMissing({ assets, outDir, byUrl, recordDir, base: SITE, fetchImpl: fakeFetch });
    assert.equal(assets[0].status, 'fetched');
    assert.equal(assets[0].sha256, sha('DOWNLOADED'), 'the downloaded file carries its hash');
    assert.ok((await stat(path.join(outDir, assets[0].file))).isFile());
    assert.equal(assets[1].status, 'fallback', 'a failed download uses the closest recorded variant');
    assert.equal(assets[1].fallbackFrom, 'https://site.test/img.png?width=400');
    assert.match(assets[1].reason, /download failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('closest variant: the recorded width nearest to the one asked for, same file only', () => {
  const byUrl = new Map([
    ['https://site.test/a.png?width=400', { sha: 'x' }],
    ['https://site.test/a.png?width=1200', { sha: 'y' }],
    ['https://site.test/b.png?width=800', { sha: 'z' }],
  ]);
  assert.equal(closestVariant('https://site.test/a.png?width=900', byUrl).url, 'https://site.test/a.png?width=1200');
  assert.equal(closestVariant('https://site.test/a.png?width=450', byUrl).url, 'https://site.test/a.png?width=400');
  assert.equal(closestVariant('https://site.test/c.png?width=450', byUrl), null);
});

test('a video that cannot be had is replaced by its poster; without a poster its source is removed', () => {
  const $ = load('<section><video class="hero" src="https://site.test/v.mp4" poster="https://site.test/p.webp"></video></section>');
  const root = resolvePath($, 'body>section:1') ?? $('section')[0];
  const assets = [
    { url: 'https://site.test/v.mp4', kind: 'media', status: 'failed', reason: 'too big' },
    { url: 'https://site.test/p.webp', kind: 'image', status: 'local', file: 'assets/p.webp' },
  ];
  const out = localize({ markup$: $, rootEl: root, css: '', assets, base: SITE });
  assert.match(out.markup, /<img src="assets\/p\.webp"/, 'the poster stands in for the video');
  assert.doesNotMatch(out.markup, /<video|v\.mp4/, 'no video and no original URL is left');
});

test('origin: a button a widget script injected is excluded, a site portal outside the section is kept', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-origin-'));
  try {
    const net = path.join(root, '.network');
    const page = path.join(root, 'index');
    await mkdir(path.join(net, 'files'), { recursive: true });
    await mkdir(page, { recursive: true });
    const HTML = '<!doctype html><html><head><style>.portal:hover{color:red}.chat-btn:hover{color:blue}</style></head><body>'
      + '<section class="s1"><p>content</p></section>'
      + '<div class="portal"><button class="site-modal">Site modal</button></div>'
      + '<button class="chat-btn">Ask the widget</button>'
      + '</body></html>';
    await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries: [
      { url: 'https://chat.vendor.test/widget/chatbot-widget.js', status: 200, kind: 'script', type: 'text/javascript', sha: sha('// widget') },
    ] }));
    await writeFile(path.join(net, 'files', sha('// widget')), '// widget');
    await writeFile(path.join(page, 'desktop-asis.json'), JSON.stringify({ html: HTML, baseURI: SITE, sheets: [{ readable: true, raw: '.portal:hover{color:red}.chat-btn:hover{color:blue}' }] }));
    await writeFile(path.join(page, 'desktop.json'), JSON.stringify({ viewport: [1440, 900], body: {
      tag: 'body', path: 'body', rect: [0, 0, 1440, 900], children: [
        { tag: 'section', path: 'body>section:1', rect: [0, 0, 1440, 200], children: [] },
        { tag: 'div', path: 'body>div:1', rect: [0, 200, 1440, 200], children: [] },
        { tag: 'button', path: 'body>button:1', rect: [1200, 800, 200, 40], children: [] },
      ],
    } }));
    await writeFile(path.join(page, 'motion.json'), JSON.stringify({
      hover: [{ path: 'body>div:1', tag: 'div', source: 'css', text: 'Site modal' }, { path: 'body>button:1', tag: 'button', source: 'css', text: 'Ask the widget' }],
    }));
    // The attribution measurement: the button exists only while the widget script runs.
    await writeFile(path.join(page, 'attribution.json'), JSON.stringify({ injected: ['body>button:1'] }));

    const out = path.join(root, 'out');
    const index = await preserveCapture({ captureRoot: root, slug: 'index', outDir: out, pageUrl: SITE, fetch: false });
    const byRoot = Object.fromEntries(index.components.map((c) => [c.root, c]));
    assert.equal(byRoot['body>button:1'].status, 'excluded-by-origin', 'the widget-injected button is excluded');
    assert.notEqual(byRoot['body>div:1'].status, 'excluded-by-origin', 'the site\'s portal, outside the section, is kept');
    assert.equal(index.attribution.measured, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('attribution: an icon-only button a widget inserted takes its wrapper with it; a site element that is missing is kept', async () => {
  const { injectedParts } = await import('../src/recreate/behavior/preserve/attribution.js');
  const WIDGET = 'https://chat.vendor.test/widget.js';
  const SITE_SCRIPT = 'https://site.test/site.js';
  // Normal loads: the widget's wrapper and its icon-only button, and a site note the site script inserted after the widget.
  // Blocked load: none of the widget's parts, and the site note is missing too (its script waited for the widget).
  const normal = {
    elements: [
      { key: 'svg|#1', path: 'body>div:3>button:1>svg:1', text: '', by: WIDGET },
      { key: 'p|Site note#1', path: 'body>p:9', text: 'Site note', by: SITE_SCRIPT },
    ],
    paths: ['body', 'body>div:3', 'body>div:3>button:1', 'body>div:3>button:1>svg:1', 'body>p:9', 'body>div:1', 'body>div:1>p:1'],
    inserted: [{ path: 'body>div:3', by: WIDGET }, { path: 'body>div:3>button:1', by: WIDGET }, { path: 'body>div:3>button:1>svg:1', by: WIDGET }, { path: 'body>p:9', by: SITE_SCRIPT }],
  };
  const again = { elements: normal.elements, paths: normal.paths };
  const blocked = { elements: [], paths: ['body', 'body>div:1', 'body>div:1>p:1'] };
  const out = injectedParts(normal, again, blocked, ['chat.vendor.test']);
  assert.deepEqual(out.injected, ['body>div:3'], 'the widget\'s wrapper is the injected root');
  assert.ok(!out.injected.some((p) => p.includes('p:9')), 'the site\'s own note is kept, though it is missing when the widget is blocked');
});

test('keyframes used only by an inline style="animation" are kept: the element animates in the copy', () => {
  // The animation is written in the element\'s own style attribute, not in any stylesheet rule (the way a page\'s script
  // or a builder writes it). Its @keyframes is in the sheet and must come with the component.
  const $ = load('<html><body><div class="wrap"><span class="grad" style="background-size:200% 200%;animation:gradient-shift 4s ease infinite">Text</span></div></body></html>');
  const sheets = parseSheets([{ readable: true, raw: '@keyframes gradient-shift{0%{background-position:0%}to{background-position:100%}} @keyframes unused{from{opacity:0}to{opacity:1}}' }]);
  const el = resolvePath($, 'body>div:1');
  const css = filterCss(sheets, $, el).css;
  assert.match(css, /@keyframes gradient-shift/, 'the keyframes the inline animation names are kept');
  assert.doesNotMatch(css, /@keyframes unused/, 'keyframes nothing names are not kept');
});

test('resource kinds: an image, a video, a font and a stylesheet are each their own kind (a video is never fetched as an image)', async () => {
  const { resourceUrls } = await import('../src/recreate/behavior/preserve/extract.js');
  const $ = load('<html><body><div class="x"><img src="/a.png"><video src="/v.mp4" poster="/p.webp"></video><link rel="stylesheet" href="/s.css"></div></body></html>');
  const root = resolvePath($, 'body>div:1');
  const found = Object.fromEntries(resourceUrls($, root, 'h1{font-family:X} @font-face{src:url(/f.woff2)}', SITE).map((r) => [r.url.replace(SITE, '/'), r.kind]));
  assert.equal(found['/a.png'], 'image');
  assert.equal(found['/v.mp4'], 'media', 'the video is media');
  assert.equal(found['/p.webp'], 'image', 'the poster is an image');
  assert.equal(found['/f.woff2'], 'font');
  assert.equal(found['/s.css'], 'style');
});

test('responsive variants are separate files, named by their content; a versioned module is served as JavaScript', async () => {
  const { localPathOf } = await import('../src/recreate/behavior/preserve/pageLift.js');
  const { typeExtOf } = await import('../src/recreate/verify/server.js');
  const base = 'https://site.test/images/pic.png';
  const small = localPathOf(`${base}?scale-down-to=1024&width=6400`);
  const big = localPathOf(`${base}?width=512`);
  assert.notEqual(small, big, 'two variants of one file do not share a name');
  assert.equal(localPathOf(base), '/images/pic.png', 'the bare address keeps its name');
  assert.match(localPathOf(`${base}?width=512`, 'image/webp'), /^\/images\/pic~[0-9a-f]{8}\.webp$/, 'the extension follows the content');
  assert.equal(typeExtOf('/m/feather-icons/menu.js@0.0.29'), '.js', 'a version suffix is not the extension');
});
