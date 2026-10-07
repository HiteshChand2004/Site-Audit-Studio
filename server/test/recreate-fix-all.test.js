// The copy fixes the original's audit problems (fix-all): titles / descriptions, language, structured data, llms.txt,
// per-page inline CSS, hidden states in templates, responsive images, text contrast, names of icon buttons, and the
// pages the analysis found joining the recreate. Pure functions and small trees, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import sharp from 'sharp';
import { applyImageVariants, makeImageVariants, sizesFor } from '../src/recreate/assets/variants.js';
import { selectPages } from '../src/recreate/discover.js';
import { emitCss, usedCustomProps } from '../src/recreate/emit/css.js';
import { emitSite } from '../src/recreate/emit/html.js';
import { MOTION_JS } from '../src/recreate/emit/motionScript.js';
import { jsxNode } from '../src/recreate/emit/react/jsx.js';
import { fixContrast, passingColor, ratio } from '../src/recreate/fixers/contrast.js';
import { crawlFiles } from '../src/recreate/ir/crawlFiles.js';
import { detectLang, fitTitle, refineHeadTexts } from '../src/recreate/ir/seoText.js';
import { addStructuredData, findQuestions } from '../src/recreate/ir/structuredData.js';
import { analyzeAeo, NO_QUESTIONS } from '../src/audit/analyzers/aeo.js';

const view = (style = {}, rect = [0, 0, 300, 40]) => ({ style, rect, hidden: false });
const el = (tag, children = [], { style = {}, attrs = {}, ...rest } = {}) => ({ tag, attrs, views: { desktop: view(style) }, children, ...rest });
const txt = (text) => ({ text });

test('titles and descriptions: duplicates, too long and too short ones are rewritten from the page', () => {
  const page = (p, title, description, h1, para) => ({
    info: { path: p },
    root: el('body', [el('main', [el('h1', [txt(h1)]), el('p', [txt(para)]), el('footer', [el('p', [txt('Shared footer text that every page of the site repeats below.')])])])]),
    head: { title, description, meta: [] },
    headAuto: [],
  });
  const trees = [
    page('/', 'Acme', 'Acme', 'Acme builds tools', 'Acme builds tools for teams that ship software every single day of the week.'),
    page('/about', 'Acme', 'Acme', 'About our company', 'We started in 2010 with five people and a single idea about making work simpler.'),
    page('/pricing', 'A very long title that goes on and on beyond sixty characters | Acme Inc', 'x'.repeat(200), 'Pricing', 'Plans start small and grow with your team, with every feature on every plan.'),
  ];
  refineHeadTexts(trees, 'Acme');
  const titles = trees.map((t) => t.head.title);
  const descriptions = trees.map((t) => t.head.description);
  assert.equal(new Set(titles).size, 3, `unique titles: ${titles}`);
  assert.equal(new Set(descriptions).size, 3);
  for (const t of titles) assert.ok(t.length >= 10 && t.length <= 60, t);
  for (const d of descriptions) assert.ok(d.length >= 50 && d.length <= 160, d);
  assert.ok(!descriptions.some((d) => d.includes('Shared footer')), 'a text every page repeats never describes a page');
  assert.ok(trees[1].headAuto.some((a) => a.field === 'title' && /another page/.test(a.source)));
  assert.equal(fitTitle('Our services and pricing | A company name that makes the title far too long', 'Acme'), 'Our services and pricing');
  assert.equal(fitTitle('Home', 'Acme Tools'), 'Home | Acme Tools');
});

test('language guessed from the text only when one language clearly wins', () => {
  assert.equal(detectLang('The quick brown fox jumps over the lazy dog and runs to the forest with you, for this is what we do in our town every day.'), 'en');
  assert.equal(detectLang('यह एक हिंदी वाक्य है जो भाषा पहचानने के लिए काफी लंबा है और इसमें कई शब्द हैं ताकि जांच ठीक से हो सके।'), 'hi');
  assert.equal(detectLang('Short'), null);
});

test('structured data: WebSite + Organization on the homepage, FAQPage from questions and answers', () => {
  const faq = el('section', [
    el('h2', [txt('Frequently asked')]),
    el('div', [el('button', [txt('How long does setup take?')]), el('div', [txt('About ten minutes with the guided installer.')])]),
    el('div', [el('button', [txt('Can I cancel anytime?')]), el('div', [txt('Yes, plans are monthly and you can cancel at any time.')])]),
  ]);
  const home = { info: { path: '/' }, root: el('body', [el('a', [txt('LinkedIn')], { href: 'https://www.linkedin.com/company/acme' }), faq]), head: { jsonLd: [], icons: [], meta: [], description: 'Acme builds tools.' } };
  const pairs = findQuestions(home.root);
  assert.equal(pairs.length, 2);
  assert.match(pairs[0].answer, /ten minutes/);
  const out = addStructuredData({ pages: [home], baseUrl: 'https://acme.test', siteName: { value: 'Acme' } });
  const types = home.head.jsonLd.flatMap((j) => { const x = JSON.parse(j); return x['@graph'] ? x['@graph'].map((g) => g['@type']) : [x['@type']]; });
  assert.deepEqual(types.sort(), ['FAQPage', 'Organization', 'WebSite']);
  assert.ok(out.added.length >= 1);
  assert.match(home.head.jsonLd[0], /linkedin\.com\/company\/acme/);
  // Already declared types are never added twice.
  const again = addStructuredData({ pages: [home], baseUrl: 'https://acme.test', siteName: { value: 'Acme' } });
  assert.equal(again.added.length, 0);
});

test('llms.txt is generated when the original has none, copied when it has one', () => {
  const pages = [
    { info: { path: '/' }, head: { title: 'Acme', description: 'Tools for teams.', canonical: 'https://acme.test/', meta: [] } },
    { info: { path: '/about' }, head: { title: 'About | Acme', description: 'Who we are.', canonical: 'https://acme.test/about', meta: [] } },
  ];
  const gen = crawlFiles({ pages, baseUrl: 'https://acme.test', siteName: 'Acme' });
  const file = gen.files.find((f) => f.path === 'llms.txt');
  assert.ok(gen.llms.generated && file);
  assert.match(file.content, /^# Acme\n\n> Tools for teams\.\n\n## Pages\n\n- \[Acme\]\(https:\/\/acme\.test\/\): Tools for teams\./);
  const copied = crawlFiles({ pages, baseUrl: 'https://acme.test', llms: { text: '# Own file\n' } });
  assert.equal(copied.files.find((f) => f.path === 'llms.txt').content, '# Own file\n');
  assert.ok(copied.llms.copied && !copied.llms.generated);
});

test('structured answers: N/A detail is shared with the checklist', () => {
  const rows = analyzeAeo({ pages: [{ url: 'https://a.test/', facts: { jsonLd: [], questionHeadings: [], headings: [], faqSignals: 0 } }], home: { facts: {} }, robots: { blockedAiCrawlers: [] }, llms: { found: false }, renderedTextLength: null });
  assert.equal(rows.find((r) => r.title === 'Structured answers').detail, NO_QUESTIONS);
});

const irOf = (pages, rules) => ({
  siteName: 'Acme', tokens: {}, fontFaces: [{ family: 'Brand', src: [{ asset: 'fonts/brand.woff2', format: 'woff2' }] }],
  keyframes: [{ name: 'spin', css: '@keyframes spin { to { transform: rotate(1turn) } }' }, { name: 'fade', css: '@keyframes fade { from { opacity: 0 } }' }],
  boxSizingReset: true, breakpoints: { tablet: 1023.98, mobile: 767.98 }, rules, files: [], motion: null, pages,
});

test('per-page CSS: only the page\'s classes, the @keyframes / @font-face they name, no unread custom properties', () => {
  const pageA = { outPath: 'index.html', html: {}, head: { meta: [], icons: [], alternates: [], jsonLd: [] }, body: { t: 'body', attrs: {}, children: [{ t: 'div', class: 'hero', attrs: {}, children: [] }] } };
  const pageB = { outPath: 'about/index.html', html: {}, head: { meta: [], icons: [], alternates: [], jsonLd: [] }, body: { t: 'body', attrs: {}, children: [{ t: 'div', class: 'team', attrs: {}, children: [] }] } };
  const ir = irOf([pageA, pageB], [
    { selector: '.hero', parts: { base: { 'font-family': 'Brand', animation: 'spin 2s linear infinite', '--framer-x': '1', '--used': '4px', padding: 'var(--used)', 'background-image': 'url("asset:images/a.webp")' } } },
    { selector: '.team', parts: { base: { color: 'red', animation: 'fade 1s' }, mobile: { color: 'blue' } } },
  ]);
  const used = usedCustomProps(ir);
  assert.ok(used.has('--used') && !used.has('--framer-x'));
  const a = emitCss(ir, { page: pageA, usedVars: used });
  assert.match(a, /\.hero/);
  assert.doesNotMatch(a, /\.team/);
  assert.match(a, /@keyframes spin/);
  assert.doesNotMatch(a, /@keyframes fade/);
  assert.match(a, /font-family: "Brand"/);
  assert.doesNotMatch(a, /--framer-x/);
  assert.match(a, /url\("assets\/images\/a\.webp"\)/, 'url relative to the page');
  const b = emitCss(ir, { page: pageB, usedVars: used });
  assert.match(b, /@media \(max-width: 767\.98px\)/);
  assert.doesNotMatch(b, /@font-face/, 'a font the page does not use is left out');
  const site = emitSite(ir, { inlineCss: true });
  const html = site.files.get('index.html');
  assert.match(html, /<style>[\s\S]*\.hero[\s\S]*<\/style>/);
  assert.doesNotMatch(html, /rel="stylesheet"/);
  assert.ok(site.files.has('css/site.css'));
  assert.ok(site.assets.has('images/a.webp'));
});

test('hidden states and hover looks are written inside <template>, in HTML and JSX; the script puts them in place', () => {
  const state = { t: 'div', tpl: 's1', attrs: { 'data-w-set': 's1', 'data-w-i': '1', hidden: '' }, children: [{ text: 'Second slide' }] };
  const page = { outPath: 'index.html', html: {}, head: { meta: [], icons: [], alternates: [], jsonLd: [] }, body: { t: 'body', attrs: {}, children: [{ t: 'div', attrs: { 'data-w-set': 's1', 'data-w-i': '0' }, children: [{ text: 'First slide' }] }, state] } };
  const html = emitSite(irOf([page], []), {}).files.get('index.html');
  const $ = load(html);
  assert.equal($('template[data-w-tpl="s1"]').length, 1);
  assert.equal($('body > div').length, 1, 'the hidden state is not part of the page');
  assert.match($('template').html(), /Second slide/);
  const jsx = jsxNode(state, { useAsset: () => true, assetHref: (f) => `/assets/${f}`, pageHref: () => '/' });
  assert.match(jsx, /<template data-w-tpl="s1" dangerouslySetInnerHTML=\{\{ __html: ".*Second slide.*" \}\} \/>/);
  assert.match(MOTION_JS, /template\[data-w-tpl="/);
  assert.match(MOTION_JS, /pointerover/);
});

test('responsive images: WebP files at the shown widths (never wider than the original), srcset + sizes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-variants-'));
  try {
    await mkdir(path.join(dir, 'images'), { recursive: true });
    await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#3366cc' } }).png({ compressionLevel: 0 }).toFile(path.join(dir, 'images', 'hero.png'));
    const img = { t: 'img', attrs: { src: { asset: 'images/hero.png' } }, rw: { desktop: 600, tablet: 700, mobile: 343 }, children: [] };
    const ir = { breakpoints: { laptop: 1279.98, tablet: 1023.98, mobile: 767.98 }, pages: [{ body: { t: 'body', attrs: {}, children: [img] } }] };
    const { variants, files, stats } = await makeImageVariants({ ir, assetsDir: dir });
    assert.ok(stats.images === 1 && files.length >= 3);
    for (const f of files) assert.ok(f.width <= 2400 && f.file.endsWith('.webp'));
    applyImageVariants(ir, variants);
    assert.ok(img.attrs.srcset.every((s) => /^\d+w$/.test(s.d)));
    assert.match(img.attrs.src.asset, /-\d+w\.webp$/);
    assert.equal(img.attrs.sizes, '(max-width: 767.98px) 343px, (max-width: 1023.98px) 700px, 600px');
    assert.equal(sizesFor({ desktop: 500 }, {}), '500px');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('contrast: the smallest change toward black or white that passes, text over pictures left alone', () => {
  const grey = [153, 153, 153, 1];
  const white = [255, 255, 255, 1];
  const fixed = passingColor(grey, white, 4.58);
  assert.ok(ratio(fixed, white) >= 4.58 && ratio(fixed, white) < 4.9, 'just enough');
  assert.equal(passingColor([0, 0, 0, 1], white, 4.58), null);
  const p = el('p', [txt('Pale text')], { style: { color: 'rgb(153, 153, 153)', 'font-size': '14px' } });
  const onPicture = el('p', [txt('Over a photo')], { style: { color: 'rgb(200, 200, 200)' } });
  const t = { info: { path: '/' }, root: el('body', [el('section', [p], { style: { 'background-color': 'rgb(255, 255, 255)' } }), el('div', [onPicture], { style: { 'background-image': 'url(x.jpg)' } })]) };
  const out = fixContrast(t);
  assert.equal(out.fixed.length, 1);
  assert.notEqual(p.views.desktop.style.color, 'rgb(153, 153, 153)');
  assert.equal(onPicture.views.desktop.style.color, 'rgb(200, 200, 200)');
  assert.equal(out.open.length, 1);
  // Large text needs 3:1 only.
  const big = el('h1', [txt('Big')], { style: { color: 'rgb(130, 130, 130)', 'font-size': '32px' } });
  assert.equal(fixContrast({ info: { path: '/' }, root: el('body', [big], { style: { 'background-color': 'rgb(255, 255, 255)' } }) }).fixed.length, 0);
});

test('pages the analysis found join the recreate even when the server HTML links none of them', () => {
  const home = { url: 'https://spa.test/', status: 200, depth: 0, facts: { links: [] } };
  const faq = { url: 'https://spa.test/faq/1', status: 200, depth: 1, facts: { links: [] } };
  const robots = { isAllowed: () => true };
  const without = selectPages({ pages: [home], homeUrl: home.url, robots, limit: 50 });
  assert.equal(without.pages.length, 1);
  const withKnown = selectPages({ pages: [home, faq], homeUrl: home.url, knownUrls: [faq.url], robots, limit: 50 });
  assert.deepEqual(withKnown.pages.map((p) => p.path), ['/', '/faq/1']);
  assert.equal(withKnown.pages[1].source, 'analysis');
});
