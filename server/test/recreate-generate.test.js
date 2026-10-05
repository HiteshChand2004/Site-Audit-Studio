// Recreate 4a.4: IR (view alignment, variant merge, styles, head, links) and the plain HTML emitter,
// plus the full pipeline against the local recreate fixture site only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { declarations, emitCss, tidyColors } from '../src/recreate/emit/css.js';
import { emitPage } from '../src/recreate/emit/html.js';
import { MOTION_JS } from '../src/recreate/emit/motionScript.js';
import { buildHead, clip, generatedFavicon } from '../src/recreate/ir/head.js';
import { pickBreakpoints } from '../src/recreate/ir/index.js';
import { createLinkResolver, relFile, relPage } from '../src/recreate/ir/links.js';
import { ClassNamer, meaningful, originalName } from '../src/recreate/ir/names.js';
import { cascade, resolveHints, wrapsText } from '../src/recreate/ir/styles.js';
import { buildPageTree, deepText, isElement } from '../src/recreate/ir/tree.js';
import { runRecreate } from '../src/recreate/index.js';
import { startPreview, stopPreview } from '../src/recreate/preview.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { startFixtureServer } from './serve-fixture.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4196;
const origin = `http://localhost:${PORT}`;
const exists = (p) => access(p).then(() => true, () => false);
let server;
const projectIds = [];

before(async () => {
  server = await startFixtureServer(PORT, { site: 'recreate' });
});
after(async () => {
  await stopPreview();
  server.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

// A captured element: rect [x, y, w, h], style diff, children.
const el = (tag, rect, style = {}, children = [], extra = {}) => ({ tag, rect, style, children, ...extra });
const text = (t) => ({ text: t });
const find = (node, test) => {
  if (!isElement(node)) return null;
  if (test(node)) return node;
  for (const c of node.children) {
    const hit = find(c, test);
    if (hit) return hit;
  }
  return null;
};
const findAll = (node, test, out = []) => {
  if (!isElement(node)) return out;
  if (test(node)) out.push(node);
  node.children.forEach((c) => findAll(c, test, out));
  return out;
};

test('original class names are hints only: builder, hashed and utility names are never reused', () => {
  for (const bad of ['framer-1x2y3z', 'framer-Xk2p9', 'w-dyn-list', 'wp-block-group', 'css-1a2b3c', 'sc-bdVaJa', 'jsx-1234', '_a1b2c',
    'px-4', 'md:flex', 'hidden-tablet', 'show-desktop', 'elementor-widget', 'sqs-block', 'comp-kx9', '1col']) {
    assert.equal(meaningful(bad), false, bad);
  }
  for (const good of ['hero', 'site-header', 'card', 'work-intro', 'menu-button', 'pricing_table']) assert.equal(meaningful(good), true, good);
  assert.equal(originalName({ class: 'framer-1x2y3z wrapper hero__title' }), 'hero-title');
  assert.equal(originalName({ class: 'framer-1x2y3z w-dyn-list' }), null);

  const namer = new ClassNamer();
  assert.equal(namer.name('title', 'a'), 'title');
  assert.equal(namer.name('title', 'b'), 'title-2');
  assert.equal(namer.name('other', 'a'), 'title'); // same style → same class
});

test('views are aligned into one tree; elements only one view has are kept for that view', () => {
  const desktop = el('body', [0, 0, 1440, 900], {}, [
    el('header', [0, 0, 1440, 80], {}, [el('nav', [0, 0, 600, 80], {}, [text('Links')])]),
    el('main', [0, 80, 1440, 800], {}, [el('h1', [0, 80, 1440, 60], {}, [text('Hello')])]),
  ]);
  const mobile = el('body', [0, 0, 375, 900], {}, [
    el('header', [0, 0, 375, 60], {}, [el('nav', [0, 0, 0, 0], { display: 'none' }, [text('Links')], { hidden: true }), el('button', [300, 10, 40, 40], {}, [text('Menu')])]),
    el('main', [0, 60, 375, 800], {}, [el('h1', [0, 60, 375, 40], { 'font-size': '28px' }, [text('Hello')])]),
  ]);
  const { root, views, stats } = buildPageTree({ desktop, mobile });
  assert.deepEqual(views, ['desktop', 'mobile']);
  const header = find(root, (n) => n.tag === 'header');
  assert.deepEqual(header.children.map((c) => c.tag), ['nav', 'button']);
  assert.deepEqual(Object.keys(header.children[1].views), ['mobile']);
  assert.equal(stats.viewOnly, 1);
  const h1 = find(root, (n) => n.tag === 'h1');
  assert.deepEqual(Object.keys(h1.views).sort(), ['desktop', 'mobile']);
  assert.equal(h1.views.mobile.style['font-size'], '28px');
});

test('duplicate Desktop / Tablet / Phone copies merge into one element restyled per view', () => {
  const copy = (view, visible, cls, size) => el('div', visible ? [0, 0, 1000, 300] : [0, 0, 0, 0], visible ? {} : { display: 'none' }, [
    el('h2', visible ? [0, 0, 1000, 40] : [0, 0, 0, 0], { 'font-size': size }, [text('Our services')]),
    el('p', visible ? [0, 40, 1000, 20] : [0, 0, 0, 0], {}, [text('We design and build websites.')]),
  ], { attrs: { class: cls }, hidden: !visible });
  const body = (view) => el('body', [0, 0, 1000, 900], {}, [
    copy(view, view === 'desktop', 'framer-a1 hidden-tablet', '40px'),
    copy(view, view === 'tablet', 'framer-b2 hidden-desktop', '32px'),
    copy(view, view === 'mobile', 'framer-c3 hidden-desktop', '24px'),
    // Plain wrappers around one element go away.
    el('div', [0, 300, 1000, 20], { 'box-sizing': 'border-box' }, [el('div', [0, 300, 1000, 20], {}, [el('p', [0, 300, 1000, 20], {}, [text('Note')])])]),
    el('div', [0, 320, 1000, 20], {}, [text('Footer')], { attrs: { role: 'contentinfo' } }),
  ]);
  const { root, stats } = buildPageTree({ desktop: body('desktop'), tablet: body('tablet'), mobile: body('mobile') });
  assert.equal(stats.variantsMerged, 2);
  const headings = findAll(root, (n) => n.tag === 'h2');
  assert.equal(headings.length, 1);
  assert.deepEqual(['desktop', 'tablet', 'mobile'].map((v) => headings[0].views[v].style['font-size']), ['40px', '32px', '24px']);
  const merged = root.children[0];
  assert.deepEqual(['desktop', 'tablet', 'mobile'].map((v) => merged.views[v].hidden), [false, false, false]);
  assert.equal(stats.wrappersRemoved, 2);
  assert.equal(root.children[1].tag, 'p');
  assert.equal(root.children[2].tag, 'footer');
  assert.equal(deepText(root), 'Our services We design and build websites. Note Footer');
});

test('styles cascade from desktop with inherit / revert for values a view does not set', () => {
  const parts = cascade({
    desktop: { color: 'red', 'margin-top': '32px', display: 'grid' },
    tablet: { color: 'red', display: 'grid' },
    mobile: null,
  }, ['desktop', 'tablet', 'mobile'], 'div');
  assert.deepEqual(parts, {
    base: { color: 'red', 'margin-top': '32px', display: 'grid' },
    tablet: { 'margin-top': 'revert' },
    mobile: { display: 'none' },
  });
  // A mobile-only element is hidden in the base rule.
  const only = cascade({ desktop: null, tablet: null, mobile: { color: 'blue' } }, ['desktop', 'tablet', 'mobile'], 'span');
  assert.deepEqual(only, { base: { color: 'blue', display: 'none' }, mobile: { display: 'revert' } });
  // Links reset to "same as parent", so a missing colour is inherit and a missing underline is none.
  assert.deepEqual(cascade({ desktop: { color: 'red', 'text-decoration-line': 'underline' }, mobile: {} }, ['desktop', 'mobile'], 'a').mobile,
    { color: 'inherit', 'text-decoration-line': 'none' });

  const decls = { desktop: { '@w': { px: 600, ratio: 0.5 } }, tablet: { '@w': { px: 300, ratio: 0.5 } }, mobile: {} };
  resolveHints(decls, ['desktop', 'tablet', 'mobile'], 'div');
  assert.deepEqual(decls, { desktop: { 'max-width': '600px' }, tablet: { 'max-width': '300px' }, mobile: {} }); // not in every view
  const all = { desktop: { '@w': { px: 600, ratio: 0.5 } }, mobile: { '@w': { px: 180, ratio: 0.5 } } };
  resolveHints(all, ['desktop', 'mobile'], 'div');
  assert.deepEqual(all, { desktop: { width: '50%' }, mobile: { width: '50%' } });
  const img = { desktop: { '@rw': { px: 1000, ratio: 1 } }, mobile: { '@rw': { px: 120, ratio: 0.4 } } };
  resolveHints(img, ['desktop', 'mobile'], 'img');
  assert.deepEqual(img, { desktop: { width: '100%' }, mobile: { width: '120px', 'max-width': '100%' } });
});

test('wrapped text is measured on the content box: padding is not a second line', () => {
  const node = (style, rect) => ({ tag: 'a', attrs: {}, views: { desktop: { style, rect, hidden: false } }, children: [{ text: 'Contact Us' }] });
  // A pill button: 40 px tall, 12 px padding top and bottom, 14 px text (one line).
  assert.equal(wrapsText(node({ 'font-size': '14px', 'padding-top': '12px', 'padding-bottom': '12px' }, [0, 0, 114, 40]), 'desktop'), false);
  // The same height without padding holds two lines.
  assert.equal(wrapsText(node({ 'font-size': '14px' }, [0, 0, 114, 40]), 'desktop'), true);
  // A line height set on an ancestor is inherited.
  const parent = { tag: 'div', views: { desktop: { style: { 'line-height': '24px' }, rect: [0, 0, 200, 48] } } };
  assert.equal(wrapsText(node({}, [0, 0, 114, 48]), 'desktop', [parent]), true);
  assert.equal(wrapsText(node({}, [0, 0, 114, 24]), 'desktop', [parent]), false);
});

test('breakpoints come from the original media queries', () => {
  // Four captured views (4b.6.3): the laptop boundary is the widest one between 1024 and 1440, tablet between 768 and 1024, mobile between 375 and 768.
  assert.deepEqual(pickBreakpoints(['(max-width: 1024px)', '(max-width: 600px)']), { laptop: 1024, tablet: 1023.98, mobile: 600, source: 'site' });
  assert.deepEqual(pickBreakpoints(['(min-width: 992px)', '(min-width: 40em)', 'print']), { laptop: 1279.98, tablet: 991.98, mobile: 639.98, source: 'site' });
  assert.deepEqual(pickBreakpoints([]), { laptop: 1279.98, tablet: 1023.98, mobile: 767.98, source: 'default' });
  // A builder with tablet 810–1199 and phone below 810: the 1024 capture is its tablet layout, the 768 capture its phone layout.
  assert.deepEqual(pickBreakpoints(['(min-width: 810px) and (max-width: 1199.98px)', '(max-width: 809.98px)', '(min-width: 1200px)']), { laptop: 1199.98, tablet: 809.98, mobile: 767.98, source: 'site' });
  // Without a laptop capture the tablet boundary is the widest between 768 and 1440, as before.
  assert.deepEqual(pickBreakpoints(['(max-width: 1024px)', '(max-width: 600px)'], { laptop: false }), { tablet: 1024, mobile: 600, source: 'site' });
  assert.deepEqual(pickBreakpoints([], { laptop: false }), { tablet: 1023.98, mobile: 767.98, source: 'default' });
});

test('head: kept when present, filled from the page when missing, and marked auto-generated', () => {
  const root = { tag: 'body', attrs: {}, views: { desktop: { style: {}, rect: [0, 0, 1440, 900] } }, children: [
    { tag: 'main', attrs: {}, views: { desktop: { style: {}, rect: [0, 0, 1440, 900] } }, children: [
      { tag: 'h1', attrs: {}, views: { desktop: { style: {}, rect: [0, 0, 100, 40] } }, children: [text('Pricing plans')] },
      { tag: 'p', attrs: {}, views: { desktop: { style: {}, rect: [0, 40, 100, 20] } }, children: [text('Short.')] },
      { tag: 'p', attrs: {}, views: { desktop: { style: {}, rect: [0, 60, 100, 20] } }, children: [text('Simple pricing for teams of every size. Start free, upgrade when you need more seats and storage.')] },
      { tag: 'img', attrs: { src: '/hero.png' }, natural: [1200, 600], views: { desktop: { style: {}, rect: [0, 80, 100, 50] } }, children: [] },
    ] },
  ] };
  const assetFile = (url, base) => (new URL(url, base).pathname === '/hero.png' ? 'images/hero-abc.png' : null);
  const { head, auto, missing } = buildHead({
    head: { title: '', lang: null, meta: [{ name: 'robots', content: 'noindex' }, { name: 'generator', content: 'Framer' }], links: [], jsonLd: [] },
    page: { url: 'https://old.example.com/pricing/', path: '/pricing/', outPath: 'pricing/index.html' },
    root,
    assetFile,
    baseUrl: 'https://new.example.com',
    siteName: { value: 'Acme', source: 'logo text' },
  });
  assert.equal(head.title, 'Pricing plans | Acme');
  assert.equal(head.description, 'Simple pricing for teams of every size. Start free, upgrade when you need more seats and storage.');
  assert.equal(head.canonical, 'https://new.example.com/pricing/');
  const meta = Object.fromEntries(head.meta.map((m) => [m.property ?? m.name, m.content]));
  assert.equal(meta.robots, 'noindex'); // kept
  assert.equal(meta.generator, undefined); // platform meta dropped
  assert.equal(meta['og:image'], 'https://new.example.com/assets/images/hero-abc.png');
  assert.equal(meta['og:url'], head.canonical);
  assert.equal(meta['twitter:card'], 'summary_large_image');
  assert.deepEqual(auto.map((a) => [a.field, a.source]), [
    ['title', 'first heading'], ['description', 'first paragraph'], ['canonical', 'page URL'], ['og:title', 'title'],
    ['og:description', 'description'], ['og:type', 'default'], ['og:site_name', 'logo text'], ['og:image', 'first large image'], ['twitter:card', 'default'],
  ]);
  assert.deepEqual(missing, ['lang']); // never guessed
  assert.equal(clip('One two three. Four five six seven eight nine ten.', 26), 'One two three.');
  assert.equal(clip('word '.repeat(50), 20), 'word word word word…');
  assert.match(generatedFavicon('acme <co>', '#0f766e'), /fill="#0f766e".*>A<\/text>/);
});

test('links: recreated pages become relative paths, linked files local, the rest a local notice page (never live); relative asset paths', () => {
  const resolve = createLinkResolver({
    pages: [{ url: 'https://s.test/', outPath: 'index.html' }, { url: 'https://s.test/about/', outPath: 'about/index.html' }],
    livePages: [{ url: 'https://s.test/blog/' }],
    skipped: [{ url: 'https://s.test/login', reason: 'backend' }],
    origin: 'https://s.test',
    assetFile: (url) => ({ 'https://s.test/files/brochure.pdf': 'files/brochure-1234567890.pdf', 'https://cdn.test/deck.pdf': 'files/deck-0987654321.pdf' })[url] ?? null,
  });
  assert.deepEqual(resolve('https://s.test/about', 'https://s.test/'), { page: 'about/index.html', hash: '' });
  assert.deepEqual(resolve('https://www.s.test/#team', 'https://s.test/about/'), { page: 'index.html', hash: '#team' });
  assert.deepEqual(resolve('https://s.test/about/#x', 'https://s.test/about/'), { anchor: '#x' });
  // A query-string variant of a recreated page opens that page.
  assert.deepEqual(resolve('https://s.test/about/?ref=nav', 'https://s.test/'), { page: 'about/index.html', hash: '' });
  // Linked files that were downloaded are local, on the site or on another host.
  assert.deepEqual(resolve('https://s.test/files/brochure.pdf', 'https://s.test/'), { asset: 'files/brochure-1234567890.pdf' });
  assert.deepEqual(resolve('https://cdn.test/deck.pdf', 'https://s.test/'), { asset: 'files/deck-0987654321.pdf' });
  // Everything else of the site opens a local notice page at the same path, never the live site.
  assert.deepEqual(resolve('https://s.test/blog/', 'https://s.test/'), { file: 'blog/index.html', hash: '', url: 'https://s.test/blog/', reason: 'beyond-limit' });
  assert.deepEqual(resolve('https://s.test/login', 'https://s.test/'), { file: 'login/index.html', hash: '', url: 'https://s.test/login', reason: 'backend' });
  assert.deepEqual(resolve('https://s.test/files/missing.pdf', 'https://s.test/'), { file: 'files/missing.pdf/index.html', hash: '', url: 'https://s.test/files/missing.pdf', reason: 'not-recreated' });
  assert.deepEqual([...resolve.notices.keys()], ['blog/index.html', 'login/index.html', 'files/missing.pdf/index.html']);
  assert.deepEqual(resolve('https://other.test/', 'https://s.test/'), { external: 'https://other.test/' });
  assert.deepEqual(resolve('mailto:hi@s.test', 'https://s.test/'), { external: 'mailto:hi@s.test' });
  assert.equal(resolve('javascript:void(0)', 'https://s.test/'), null);
  assert.equal(resolve('data:text/html,<b>x</b>', 'https://s.test/'), null);

  assert.equal(relPage('index.html', 'about/index.html'), 'about/');
  assert.equal(relPage('about/index.html', 'index.html'), '../');
  assert.equal(relPage('index.html', 'index.html'), './');
  assert.equal(relPage('blog/post.html', 'contact.html'), '../contact.html');
  assert.equal(relFile('blog/post.html', 'assets/images/a.png'), '../assets/images/a.png');
  assert.equal(relFile('css/site.css', 'assets/fonts/f.woff2'), '../assets/fonts/f.woff2');
});

test('emitter: colours, tokens, shorthands, escaping and no measurement ids in the final HTML', () => {
  assert.equal(tidyColors('rgb(15, 118, 110)'), '#0f766e');
  assert.equal(tidyColors('rgba(0, 0, 0, 0)'), 'transparent');
  assert.equal(tidyColors('0px 1px 2px rgba(0, 0, 0, 0.5)'), '0px 1px 2px rgb(0 0 0 / 0.5)');
  const css = declarations({
    color: 'rgb(15, 118, 110)',
    'margin-top': '0px', 'margin-right': 'auto', 'margin-bottom': '0px', 'margin-left': 'auto',
    'padding-top': '1px', 'padding-right': 'revert', 'padding-bottom': '1px', 'padding-left': '1px',
    'background-image': 'url("asset:images/a.png")',
  }, { tokenOf: new Map([['#0f766e', '--brand']]), from: 'css/site.css' });
  assert.equal(css, [
    '  color: var(--brand);',
    '  padding-top: 1px;',
    '  padding-right: revert;',
    '  padding-bottom: 1px;',
    '  padding-left: 1px;',
    '  background-image: url("../assets/images/a.png");',
    '  margin: 0px auto;',
  ].join('\n'));

  const page = {
    outPath: 'blog/post.html',
    head: { lang: 'en', title: 'A <b> & "c"', description: 'd', canonical: 'https://s.test/blog/post.html', meta: [], icons: [{ rel: 'icon', asset: 'icons/f.svg' }], alternates: [], jsonLd: ['{"a":"</script>"}'] },
    html: { class: null },
    body: { t: 'body', sid: 1, class: 'page', attrs: {}, b: 1, children: [
      { t: 'p', sid: 2, attrs: {}, b: 1, children: [text('1 < 2 & 3'), { t: 'a', sid: 3, attrs: { href: { page: 'index.html', hash: '' } }, children: [text('Home')] }] },
      { t: 'img', sid: 4, attrs: { src: { asset: 'images/a.png' }, srcset: [{ asset: 'images/a.png', d: '1x' }], alt: '' }, children: [] },
    ] },
  };
  const html = emitPage(page);
  assert.match(html, /<title>A &lt;b&gt; &amp; "c"<\/title>/);
  assert.match(html, /<link rel="icon" href="\.\.\/assets\/icons\/f\.svg">/);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/css\/site\.css">/);
  assert.match(html, /<script type="application\/ld\+json">\{"a":"\\u003c\/script\\u003e"\}<\/script>/);
  assert.match(html, /<p>1 &lt; 2 &amp; 3<a href="\.\.\/">Home<\/a><\/p>/);
  assert.match(html, /<img src="\.\.\/assets\/images\/a\.png" srcset="\.\.\/assets\/images\/a\.png 1x" alt="">/);
  assert.doesNotMatch(html, /data-sas-id/);
  assert.match(emitPage(page, { ids: true }), /<p data-sas-id="2">/);
});

test('the full pipeline generates a clean, linked, responsive site from the fixture', async () => {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'fixture', ?, 'html', 1, 4, ?, ?)`)
    .run(id, `${origin}/`, now, now);
  // The analysis detected WordPress (the fixture serves a small /wp-json/wp/v2/) and one broken link.
  const audit = {
    url: `${origin}/`,
    analyzedAt: now,
    techStack: [{ id: 'wordpress', name: 'WordPress', confidence: 90 }],
    brokenLinks: { checked: 10, broken: [{ url: `${origin}/old-work.html`, status: 404, foundOn: '/work.html' }], unverified: [] },
  };
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify(audit));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const recreateId = randomUUID();
  const report = await runRecreate({ project, recreateId, progress: () => {} });
  const dir = recreateDir(id, recreateId);
  const site = path.join(dir, 'site');
  const readRaw = (file) => readFile(path.join(site, file), 'utf8');
  // Structure assertions below look at the markup without the motion tokens (4b.4: data-motion="…" on animated elements).
  const read = async (file) => (await readRaw(file)).replace(/ data-motion="[^"]*"/g, '');

  assert.deepEqual(report.pages.map((p) => p.outPath), ['index.html', 'about.html', 'services/index.html', 'contact.html', 'work.html']);
  assert.deepEqual(report.errors, []);
  const files = (await readdir(site, { recursive: true })).map((f) => f.replaceAll('\\', '/')).filter((f) => /\.\w+$/.test(f)).sort();
  for (const f of ['index.html', 'about.html', 'services/index.html', 'contact.html', 'work.html']) assert.ok(files.includes(f), f);
  // D.6: no shared stylesheet; every page carries the rules it uses (this small site: all inline in the head).
  assert.ok(!files.includes('css/site.css'));
  const siteCss = emitCss(JSON.parse(await readFile(path.join(dir, 'ir', 'site.json'), 'utf8')));
  const inlineCss = (html) => html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  // Crawl files (Phase 5): sitemap.xml and robots.txt generated, the original llms.txt copied as it is.
  for (const f of ['sitemap.xml', 'robots.txt', 'llms.txt']) assert.ok(files.includes(f), f);
  // Copied with its page links moved onto the copy's own address (full-site E.1): nothing names the original site.
  const llmsOriginal = await readFile(new URL('./fixtures/recreate-site/llms.txt', import.meta.url), 'utf8');
  const llmsCopy = await read('llms.txt');
  assert.equal(llmsCopy.replace(/http:\/\/localhost:\d+/g, 'ORIGIN'), llmsOriginal.replace(/http:\/\/localhost:\d+/g, 'ORIGIN'));
  assert.match(await read('robots.txt'), /^Sitemap: https?:\/\/[^\s]+\/sitemap\.xml$/m);
  assert.equal((await read('sitemap.xml')).match(/<loc>/g).length, 5);
  const crawlFix = report.fixes.find((f) => f.id === 'crawl-files');
  assert.equal(crawlFix.title, 'sitemap.xml and robots.txt generated, llms.txt copied');
  assert.deepEqual(crawlFix.items.map((i) => i.file), ['sitemap.xml', 'robots.txt', 'llms.txt']);

  // No builder class names, no measurement ids and no reference to the stand-in CDN origin anywhere.
  const texts = await Promise.all(files.filter((f) => /\.(html|css)$/.test(f)).map(async (f) => [f, await read(f)]));
  for (const [f, body] of texts) {
    assert.doesNotMatch(body, /framer-|w-dyn|wp-block|hidden-(desktop|tablet|phone)|data-sas-id|127\.0\.0\.1/, f);
  }
  // Every asset a page or the stylesheet references exists in the site folder.
  for (const [f, body] of texts) {
    for (const m of body.matchAll(/(?:src|href)="([^"]+)"|url\("([^"]+)"\)|srcset="([^"]+)"/g)) {
      const refs = m[3] ? m[3].split(', ').map((c) => c.split(' ')[0]) : [m[1] ?? m[2]];
      for (const ref of refs.filter((r) => r.includes('assets/'))) {
        assert.ok(await exists(path.join(site, path.dirname(f), ref)), `${f} → ${ref}`);
      }
    }
  }

  // Links: recreated pages relative; nothing points at the original site: the login page opens a local notice page, the
  // brochure is downloaded.
  const home = await read('index.html');
  assert.match(home, /<a class="[\w-]+"(?: data-motion="[^"]*")? href="about\.html">About<\/a>/);
  assert.match(home, /href="services\/">Services</);
  assert.match(home, /href="login\.html">Log in</);
  assert.match(home, /href="assets\/files\/brochure-[0-9a-f]{10}\.pdf">Brochure</);
  const toOld = [...home.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]).filter((h) => h.startsWith(origin));
  assert.deepEqual(toOld, [], 'no link to the original site');
  const notice = await read('login.html');
  assert.match(notice, /<meta name="robots" content="noindex">/);
  assert.match(notice, /needs a server \(sign-in, sign-up, cart, checkout or account\)/);
  assert.match(notice, /<a href="\.\/">Back to the homepage<\/a>/);
  assert.doesNotMatch(notice, /<script/i);
  assert.match(home, /<link rel="canonical" href="http:\/\/localhost:4196\/">/);
  const services = await read('services/index.html');

  // 4a.7 — builder-style seeds on /services/ (below the first screen).
  // Scroll-reveal content is captured in its revealed state: visible text, no leftover opacity 0 / offset.
  assert.match(services, /<h2 class="[\w-]+"(?: data-motion="[^"]*")?>Revealed on scroll<\/h2>/);
  assert.match(services, /fades in when it scrolls into view/);
  const servicesInfo = report.pages.find((p) => p.path === '/services/');
  assert.ok(servicesInfo.revealPinned.desktop >= 3, JSON.stringify(servicesInfo.revealPinned));
  assert.ok(report.warnings.some((w) => /^Scroll-reveal content on \d+ pages? was captured in its revealed state \(.*\/services\//.test(w)));
  // 4b.2 — how those elements appear (reveal.js fixture: inline opacity/transform transition 0.4s, replayed on leave).
  const servicesMotion = JSON.parse(await readFile(path.join(dir, 'capture', servicesInfo.slug, 'motion.json'), 'utf8'));
  const heading = servicesMotion.reveal.elements.find((e) => e.tag === 'h2' && /Revealed on scroll/.test(e.text));
  assert.ok(heading, JSON.stringify(servicesMotion.reveal.elements.map((e) => `${e.tag}:${e.text}`)));
  assert.equal(heading.timing.source, 'transition');
  assert.equal(heading.timing.duration, 400);
  assert.equal(heading.timing.easing.css, 'ease');
  assert.equal(heading.from.opacity, 0);
  assert.deepEqual(heading.from.motion.translate, [0, 40]);
  assert.equal(heading.to.opacity, 1);
  assert.equal(heading.replay, true);
  assert.ok(servicesMotion.reveal.stats.revealed >= 3 && servicesMotion.reveal.stats.declared >= 3);
  assert.ok(report.motion.reveal.revealed >= 3 && report.motion.reveal.replay >= 1, JSON.stringify(report.motion.reveal));
  // 4b.3 — the seeded infinite CSS spinner is a loop (read before the screenshots would cancel it).
  const spinner = servicesMotion.loops.loops.find((l) => l.name === 'spin');
  assert.ok(spinner, JSON.stringify(servicesMotion.loops.loops.map((l) => [l.name, l.pattern])));
  assert.equal(spinner.source, 'css-animation');
  assert.equal(spinner.pattern, 'spin');
  assert.equal(spinner.timing.duration, 3000);
  assert.equal(spinner.timing.iterations, 'infinite');
  assert.equal(spinner.inStylesheet, true);
  assert.ok(report.motion.loops.css >= 1 && report.motion.loops.patterns.spin >= 1, JSON.stringify(report.motion.loops));

  // 4b.4 — the IR carries the motion: tokens on the elements, rules in the stylesheet, the fixed reveal script.
  const rawServices = await readRaw('services/index.html');
  assert.match(rawServices, /<h2 class="[\w-]+" data-motion="rv r\d+( d\d+)? rp">Revealed on scroll<\/h2>/);
  assert.match(rawServices, /<script src="\.\.\/js\/motion\.js" defer><\/script>\s*<\/head>/);
  assert.equal(await readRaw('js/motion.js'), MOTION_JS);
  const motionCssText = siteCss;
  assert.match(motionCssText, /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*\.js-motion \[data-motion~="r1"\]:not\(\.is-in\) \{\n {4}opacity: 0;\n {4}translate: 0px 40px;/);
  assert.match(motionCssText, /\.js-motion \[data-motion~="r1"\]\.is-in \{\n {4}animation: m-r1 400ms ease var\(--md, 0ms\) backwards;/);
  assert.match(motionCssText, / {2}@keyframes m-r1 \{\n {4}from \{\n {6}opacity: 0;/);
  assert.match(motionCssText, /@media \(hover: hover\) \{[\s\S]*\[data-motion~="h1"\]:hover \{/);
  assert.match(await readRaw('index.html'), /<script src="js\/motion\.js" defer><\/script>/);
  assert.equal(report.generate.motion.script, true);
  assert.ok(report.generate.motion.reveal.elements >= 3 && report.generate.motion.hover.elements >= 1, JSON.stringify(report.generate.motion));
  assert.ok(report.generate.motion.loops.carried >= 1, 'the fixture spinner is carried by the page CSS');
  assert.equal(report.outputs.html.scripts, true);
  assert.equal(report.safety.safe, true);
  assert.match(await readFile(path.join(dir, 'dist', 'js', 'motion.js'), 'utf8'), /IntersectionObserver/);
  assert.match(services, /href="\.\.\/">Home</);
  assert.match(services, /<link rel="icon" href="\.\.\/assets\/images\/hero-bg-[0-9a-f]{10}\.svg">/);
  assert.match(await read('about.html'), /href="team\.html">Our team</);
  assert.deepEqual(report.generate.liveLinks, [], 'no same-site link stays live');
  const notices = Object.fromEntries(report.generate.noticePages.map((l) => [new URL(l.url).pathname, l.reason]));
  assert.equal(notices['/team.html'], 'beyond-limit');
  assert.equal(notices['/login.html'], 'backend');
  assert.equal(notices['/brochure.pdf'], undefined, 'downloaded, not a notice page');

  // The builder-style page: one copy of the content, restyled per breakpoint.
  const work = await read('work.html');
  assert.equal(work.match(/<h1/g).length, 1);
  assert.equal(work.match(/<h2[^>]*>Project one/g).length, 1); // h1 → h3 fixed to h1 → h2
  assert.doesNotMatch(work, /action=/);
  assert.match(work, /<label class="[\w-]+" for="email">/);
  assert.match(work, /<input id="email"/);
  assert.match(work, /<title>Selected work \| Recreate Co<\/title>/);
  assert.match(work, /<meta name="description" content="We design and build fast marketing sites for small teams, from the first sketch to launch day\.">/);
  const css = siteCss;
  // The page's own copy of those rules: inline, compact, only what the page uses, no stylesheet request.
  const workInline = inlineCss(await readRaw('work.html'));
  assert.ok(workInline.length > 0 && workInline.length < css.length, `${workInline.length} vs ${css.length}`);
  assert.doesNotMatch(workInline, /\n/);
  assert.doesNotMatch(await readRaw('work.html'), /rel="stylesheet"/);
  const gridClass = work.match(/<div class="([\w-]+)">\s*<div class="card">/)[1];
  const rules = (selector) => [...css.matchAll(new RegExp(`\\.${selector} \\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
  // Desktop only for now (views.js): one rule per class and no media queries.
  const [base, ...others] = rules(gridClass);
  assert.match(base, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.deepEqual(others, []);
  assert.doesNotMatch(css, /@media \(max-width:/);
  assert.match(css, /--brand: #0f766e;/);
  assert.match(css, /@font-face \{\n {2}font-family: "Brand Mono";\n {2}src: url\("\.\.\/assets\/fonts\/mono-[0-9a-f]{10}\.woff2"\) format\("woff2"\);/);
  assert.match(css, /@keyframes brand-fade/);
  // 4a.7 — a same-origin @font-face (inline <style>, read by the capture) gets its local file.
  assert.match(css, /@font-face \{\n {2}font-family: "Fixture Mono";\n {2}src: url\("\.\.\/assets\/fonts\/mono-[0-9a-f]{10}\.woff2"\) format\("woff2"\);/);
  const classOf = (re) => services.match(re)[1];
  const baseRule = (cls) => rules(cls)[0] ?? '';
  // The fold card crosses the fold and is hidden again at the top (too little of it in view): pinned too.
  const foldCard = classOf(/<div class="([\w-]+)">\s*<p[^>]*>Crossing the fold/);
  for (const cls of [foldCard, classOf(/<h2 class="([\w-]+)">Revealed on scroll/), classOf(/<p class="([\w-]+)">This paragraph fades/)]) {
    // Nothing hidden, half-faded or still offset (a state captured mid-animation).
    assert.doesNotMatch(baseRule(cls), /opacity: 0[;\s.]|translateY|matrix\(1, 0, 0, 1, 0, [1-9]/, cls);
  }
  // 4a.7 — an image frame whose image is absolutely positioned keeps its size; the copy column in a
  // flex row (inside a display: contents wrapper) keeps its width, so its text keeps wrapping.
  const frameRule = baseRule(classOf(/<div class="([\w-]+)"><img class="[\w-]+"[^>]* src="\.\.\/assets\/images\/team-/));
  assert.match(frameRule, /height: 300px/);
  assert.match(frameRule, /width: 400px/);
  const copyRule = baseRule(classOf(/<div class="([\w-]+)">\s*<h2 class="[\w-]+">Revealed on scroll/));
  assert.match(copyRule, /(^|\s)width: (50%|481px);/); // a width (text: 1 px of slack), never only max-width
  // A row around a zero-basis growing text (flex: 1 0 0) in a centred column keeps its width even
  // though its text fits on one line; without it the row shrinks to one word per line.
  const highlightRule = baseRule(classOf(/<div class="([\w-]+)"><span[^>]*>(?:(?!<\/span>)[^])*<\/span><div[^>]*>\s*<p[^>]*>Fast onboarding/));
  assert.match(highlightRule, /(^|\s)width: (100%|\d+px);/);
  // Its centred wrapper, content-sized too, keeps filling its parent: the row's 100% needs that.
  const innerRule = baseRule(classOf(/<div class="([\w-]+)">\s*<div class="[\w-]+"><span[^>]*>(?:(?!<\/span>)[^])*<\/span><div[^>]*>\s*<p[^>]*>Fast onboarding/));
  assert.match(innerRule, /(^|\s)width: 100%;/);
  // The bullet box holds only an SVG at width: 100%: it keeps its own width (else the SVG falls
  // back to 300 px and squeezes the text).
  const dotRule = baseRule(classOf(/<span class="([\w-]+)"[^>]*><svg[^>]*>(?:(?!<\/span>)[^])*<\/span><div[^>]*>\s*<p[^>]*>Fast onboarding/));
  assert.match(dotRule, /(^|\s)width: 6px;/);
  // A grid tile sized by its width (justify-self: start) around an absolutely positioned image keeps
  // its width; without it the tile and its image collapse to 0.
  const badgeRule = baseRule(classOf(/<div class="([\w-]+)">\s*<img[^>]* alt="Badge one"/));
  assert.match(badgeRule, /(^|\s)width: (100%|\d+px);/);
  assert.doesNotMatch(badgeRule, /(^|\s)width: 0/);
  // A spinning element is captured with its layout size, not the bounding box of the frame it was
  // caught in, in every view; the generated rule keeps 40 px.
  for (const view of ['desktop']) {
    const snap = JSON.parse(await readFile(path.join(dir, 'capture', 'services', `${view}.json`), 'utf8'));
    const findNode = (n) => (n.attrs?.class ?? '').split(' ').includes('spinner') ? n : (n.children ?? []).reduce((hit, c) => hit ?? (c.tag ? findNode(c) : null), null);
    assert.deepEqual(findNode(snap.body).rect.slice(2), [40, 40], view);
  }
  const spinnerRule = baseRule(classOf(/<span class="([\w-]+)" aria-hidden="true"><\/span>/));
  assert.match(spinnerRule, /(^|\s)(max-)?width: 40px;/, spinnerRule);
  // A space-between card stretched by an explicit grid row keeps its height (its last child sits at
  // the bottom edge, so "where the content ends" would call it full).
  const deckRule = baseRule(classOf(/<a class="([\w-]+)"(?: data-motion="[^"]*")? href="\.\.\/about\.html">\s*<span[^>]*><\/span>\s*<span[^>]*>Deck card one/));
  assert.match(deckRule, /(^|\s)(min-)?height: 220px;/, deckRule);
  // A box holding only absolute content, part of it inside a display: contents wrapper, keeps its
  // height, so the bottom-anchored card stays where it was.
  const stageRule = baseRule(classOf(/<div class="([\w-]+)">\s*<div class="[\w-]+">\s*<span class="[\w-]+">New<\/span>/));
  assert.match(stageRule, /(^|\s)height: 200px;/, stageRule);
  // Fixed-size chips larger than their text keep their size through minimums (never cutting text).
  const chipRule = baseRule(classOf(/<span class="([\w-]+)">JPM<\/span>/));
  assert.match(chipRule, /(^|\s)(min-)?width: (59|60)px;/, chipRule);
  assert.match(chipRule, /(^|\s)(min-)?height: 24px;/, chipRule);
  assert.match(spinnerRule, /(^|\s)height: 40px;/);
  assert.doesNotMatch(css, /@keyframes brand-pulse/); // not used by any page

  // Report: auto-generated head fields, the form, the IR and the generation stats.
  const auto = report.autoGenerated.filter((a) => a.page === '/work.html').map((a) => [a.field, a.source]);
  assert.deepEqual(auto.slice(0, 3), [['title', 'first heading'], ['description', 'first paragraph'], ['canonical', 'page URL']]);
  assert.ok(report.autoGenerated.some((a) => a.page === '/' && a.field === 'og:description'));
  assert.equal(report.autoGenerated.some((a) => a.page === '/' && a.field === 'title'), false);
  assert.deepEqual(report.pages.find((p) => p.path === '/work.html').head.autoGenerated.slice(0, 2), ['title', 'description']);
  assert.ok(report.manual.some((m) => m.kind === 'form' && m.title === 'Form on /work.html needs a backend'));
  // The builder page's hidden tablet / phone copies are dropped (one visible copy kept).
  assert.equal(report.generate.variantsMerged, 2);
  assert.ok(report.generate.wrappersRemoved >= 2);
  // One captured view: no breakpoints.
  assert.deepEqual(report.generate.breakpoints, { source: 'single-view' });
  const ir = JSON.parse(await readFile(path.join(dir, 'ir', 'site.json'), 'utf8'));
  assert.equal(ir.version, 1);
  assert.equal(ir.pages.length, 5);

  // 4a.5 — safety: no script, handler, script URL or external reference in any page or SVG file.
  assert.equal(report.safety.safe, true, JSON.stringify(report.safety.issues));
  assert.deepEqual(report.safety.issues, []);
  for (const [f, body] of texts) assert.doesNotMatch(body, /<script(?![^>]*application\/ld\+json)(?![^>]*src="(\.\.\/)*js\/motion\.js" defer>)|\son\w+=|javascript:|example\.org\/(tracker|sprite|p\.svg)/i, f);
  const svgFiles = files.filter((f) => f.endsWith('.svg'));
  const searchIcon = svgFiles.find((f) => f.includes('search-'));
  assert.ok(searchIcon);
  const icon = await read(searchIcon);
  assert.doesNotMatch(icon, /script|onload|javascript:|@import|https?:\/\/example/i);
  assert.match(icon, /<line x1="11"/); // the drawing itself is kept
  assert.ok(report.safety.sanitized.svgFiles.changed >= 1);
  assert.ok(report.safety.sanitized.inlineSvg.removed.scripts >= 1);
  const inline = work.match(/<svg class="[\w-]+" width="16"[^]*?<\/svg>/)[0];
  assert.doesNotMatch(inline, /script|onload|foreignObject|javascript:|https?:/i);
  assert.match(inline, /<circle cx="8" cy="8" r="7" fill="#0f766e"\/>/);

  // 4a.5 — fixers.
  const fix = Object.fromEntries(report.fixes.map((f) => [f.id, f]));
  assert.match(work, /<span class="[\w-]+">Archive<\/span>/); // broken link unlinked: plain text, no <a> left without href
  assert.ok(!/<a(?![^>]*\shref=)[^>]*>Archive/.test(work));
  assert.deepEqual(fix['broken-links'].items.map((i) => [i.page, new URL(i.url).pathname, i.status]), [['/work.html', '/old-work.html', 404]]);
  assert.match(work, /<img[^>]* alt="Our studio in Lisbon"/);
  assert.match(work, /<a class="[\w-]+" aria-label="GitHub"(?: data-motion="[^"]*")? href="https:\/\/github\.com\/recreate-co">/);
  assert.match(work, /<button class="[\w-]+" type="button"><img[^>]* alt="Search"/);
  assert.equal(fix['accessible-names'].count, 2);
  assert.deepEqual(fix.headings.items.map((h) => [h.from, h.to, h.text]), [['h3', 'h2', 'Project one'], ['h3', 'h2', 'Project two'], ['h3', 'h2', 'Project three']]);
  assert.match(work, /<img[^>]* fetchpriority="high" loading="eager"/);
  assert.match(home, /<img[^>]* alt="A lazy-loaded photo"[^>]* loading="lazy" decoding="async"/);
  assert.match(await read('about.html'), /<link rel="preload" href="assets\/fonts\/mono-[0-9a-f]{10}\.woff2" as="font" type="font\/woff2" crossorigin>/);
  assert.match(css, /font-display: swap;/);
  for (const a of ['alt', 'aria-label']) assert.ok(report.autoGenerated.some((x) => x.page === '/work.html' && x.field === a), a);

  // 4a.5 — WordPress REST: text and description from the API, clean content in the IR.
  const contact = await read('contact.html');
  assert.match(contact, /<p>Email hello@example\.org and we reply within one working day\.<\/p>/);
  assert.doesNotMatch(contact, /\[at\]/);
  assert.match(contact, /<meta name="description" content="Email hello@example\.org and we reply within one working day\. Our studio is open Monday to Friday…">/);
  assert.ok(report.autoGenerated.some((a) => a.page === '/contact.html' && a.field === 'description' && a.source === 'WordPress REST API (excerpt)'));
  assert.deepEqual(report.wordpress.totals, { pages: 2, posts: 2 });
  assert.deepEqual(report.wordpress.recreated, { page: 2, post: 0 });
  assert.ok(report.manual.some((m) => m.kind === 'cms' && /2 WordPress posts and pages were not recreated/.test(m.title)));
  const contactIr = ir.pages.find((p) => p.path === '/contact.html').content;
  assert.equal(contactIr.source, 'wordpress-rest');
  assert.equal(contactIr.id, 11);
  assert.doesNotMatch(contactIr.html, /script|onclick|javascript:|style=|class=/i);
  assert.match(contactIr.html, /<a href="\/about\.html">read about us<\/a>/);
  assert.equal(ir.pages.find((p) => p.path === '/').content, null);

  // 4a.5 — production build: dist/ has the same pages and a minified stylesheet.
  const distCss = inlineCss(await readFile(path.join(dir, 'dist', 'index.html'), 'utf8'));
  assert.ok(distCss.length > 0 && distCss.length < css.length * 0.9, `${distCss.length} vs ${css.length}`);
  assert.doesNotMatch(distCss, /\n {2}/);
  assert.doesNotMatch(distCss, /@media ?\(max-width/); // desktop only for now: no media queries
  for (const f of ['index.html', 'work.html', 'services/index.html']) assert.ok(await exists(path.join(dir, 'dist', f)), f);
  assert.ok(await exists(path.join(dir, 'dist', searchIcon)));

  // Fidelity: rough, but the fixture is plain CSS and should come out close to the original.
  assert.ok(report.fidelity.score >= 90, `fidelity ${report.fidelity.score}`);
  for (const p of report.fidelity.pages) {
    assert.ok(p.score >= 85, `${p.path}: ${p.score}`);
    assert.equal(p.low, false, p.path);
    for (const [view, v] of Object.entries(p.views)) {
      assert.ok(v.sizes >= 0.9, `${p.path} ${view} sizes ${v.sizes}`);
      assert.ok(await exists(path.join(dir, v.screenshot)), v.screenshot);
    }
  }
  // 4a.6 — the fidelity threshold: nothing flagged on the fixture.
  assert.deepEqual([report.fidelity.threshold, report.fidelity.status, report.fidelity.lowPages], [80, 'ok', []]);
  assert.equal(report.warnings.some((w) => /fidelity/i.test(w)), false);

  // 4a.6 — build verification of dist/: every file there, links and assets resolve, valid HTML.
  assert.equal(report.verify.ok, true, JSON.stringify(report.verify));
  assert.equal(report.verify.dir, 'dist');
  assert.deepEqual([report.verify.missingFiles, report.verify.brokenLinks, report.verify.missingAssets, report.verify.externalAssets, report.verify.anchors], [[], [], [], [], []]);
  assert.deepEqual(report.verify.html, { valid: true, errors: 0, warnings: 0, pages: [] });
  // The 5 recreated pages and the notice pages their links need (login, team, …): all checked, all valid.
  assert.equal(report.verify.checked.pages, 5 + report.generate.noticePageCount);
  assert.ok(report.generate.noticePageCount >= 2);
  assert.ok(report.verify.checked.links >= 15, `links ${report.verify.checked.links}`);
  assert.ok(report.verify.checked.assets >= 10, `assets ${report.verify.checked.assets}`);
  assert.equal(await exists(path.join(dir, 'dist.tmp')), false);
  // The same checks hold for the readable site/.
  const { verifySite } = await import('../src/recreate/verify/site.js');
  assert.equal((await verifySite(site)).ok, true);

  // 4a.6 — preview: the pipeline served every page and the stylesheet; the real preview serves dist/.
  assert.equal(report.preview.checked, 6); // five pages and js/motion.js (D.6: the CSS is inside the pages)
  assert.deepEqual(report.preview.pages, ['index.html', 'about.html', 'services/index.html', 'contact.html', 'work.html']);
  const preview = await startPreview({ projectId: id, recreateId, root: path.join(dir, 'dist') });
  assert.ok(preview.port >= 5100 && preview.port <= 5199);
  const res = await fetch(`${preview.url}services/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors/);
  assert.equal(await res.text(), await readFile(path.join(dir, 'dist', 'services', 'index.html'), 'utf8'));
  assert.equal((await fetch(`${preview.url}ir/site.json`)).status, 404); // only dist/ is served
  assert.equal((await fetch(`${preview.url}../report.json`)).status, 404);
  await stopPreview();
});
