// Recreate 4a.4: IR (view alignment, variant merge, styles, head, links) and the plain HTML emitter,
// plus the full pipeline against the local recreate fixture site only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { declarations, tidyColors } from '../src/recreate/emit/css.js';
import { emitPage } from '../src/recreate/emit/html.js';
import { buildHead, clip, generatedFavicon } from '../src/recreate/ir/head.js';
import { pickBreakpoints } from '../src/recreate/ir/index.js';
import { createLinkResolver, relFile, relPage } from '../src/recreate/ir/links.js';
import { ClassNamer, meaningful, originalName } from '../src/recreate/ir/names.js';
import { cascade, resolveHints } from '../src/recreate/ir/styles.js';
import { buildPageTree, deepText, isElement } from '../src/recreate/ir/tree.js';
import { runRecreate } from '../src/recreate/index.js';
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

test('breakpoints come from the original media queries', () => {
  assert.deepEqual(pickBreakpoints(['(max-width: 1024px)', '(max-width: 600px)']), { tablet: 1024, mobile: 600, source: 'site' });
  assert.deepEqual(pickBreakpoints(['(min-width: 992px)', '(min-width: 40em)', 'print']), { tablet: 991.98, mobile: 639.98, source: 'site' });
  assert.deepEqual(pickBreakpoints([]), { tablet: 1023.98, mobile: 767.98, source: 'default' });
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

test('links: recreated pages become relative paths, the rest stays live; relative asset paths', () => {
  const resolve = createLinkResolver({
    pages: [{ url: 'https://s.test/', outPath: 'index.html' }, { url: 'https://s.test/about/', outPath: 'about/index.html' }],
    livePages: [{ url: 'https://s.test/blog/' }],
    skipped: [{ url: 'https://s.test/login', reason: 'backend' }],
    origin: 'https://s.test',
  });
  assert.deepEqual(resolve('https://s.test/about', 'https://s.test/'), { page: 'about/index.html', hash: '' });
  assert.deepEqual(resolve('https://www.s.test/#team', 'https://s.test/about/'), { page: 'index.html', hash: '#team' });
  assert.deepEqual(resolve('https://s.test/about/#x', 'https://s.test/about/'), { anchor: '#x' });
  assert.deepEqual(resolve('https://s.test/blog/', 'https://s.test/'), { live: 'https://s.test/blog/', reason: 'beyond-limit' });
  assert.deepEqual(resolve('https://s.test/login', 'https://s.test/'), { live: 'https://s.test/login', reason: 'backend' });
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
  assert.match(html, /<script type="application\/ld\+json">\{"a":"<\\\/script>"\}<\/script>/);
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
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const recreateId = randomUUID();
  const report = await runRecreate({ project, recreateId, progress: () => {} });
  const dir = recreateDir(id, recreateId);
  const site = path.join(dir, 'site');
  const read = (file) => readFile(path.join(site, file), 'utf8');

  assert.deepEqual(report.pages.map((p) => p.outPath), ['index.html', 'about.html', 'services/index.html', 'contact.html', 'work.html']);
  assert.deepEqual(report.errors, []);
  const files = (await readdir(site, { recursive: true })).map((f) => f.replaceAll('\\', '/')).filter((f) => /\.\w+$/.test(f)).sort();
  for (const f of ['index.html', 'about.html', 'services/index.html', 'contact.html', 'work.html', 'css/site.css']) assert.ok(files.includes(f), f);

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

  // Links: recreated pages relative, the others live and reported.
  const home = await read('index.html');
  assert.match(home, /<a class="[\w-]+" href="about\.html">About<\/a>/);
  assert.match(home, /href="services\/">Services</);
  assert.match(home, new RegExp(`href="${origin}/login\\.html">Log in<`));
  assert.match(home, /<link rel="canonical" href="http:\/\/localhost:4196\/">/);
  const services = await read('services/index.html');
  assert.match(services, /href="\.\.\/">Home</);
  assert.match(services, /<link rel="icon" href="\.\.\/assets\/images\/hero-bg-[0-9a-f]{10}\.svg">/);
  assert.match(await read('about.html'), new RegExp(`href="${origin}/team\\.html">Our team<`));
  const live = Object.fromEntries(report.generate.liveLinks.map((l) => [new URL(l.url).pathname, l.reason]));
  assert.equal(live['/team.html'], 'beyond-limit');
  assert.equal(live['/login.html'], 'backend');
  assert.equal(live['/brochure.pdf'], 'not-html');

  // The builder-style page: one copy of the content, restyled per breakpoint.
  const work = await read('work.html');
  assert.equal(work.match(/<h1/g).length, 1);
  assert.equal(work.match(/<h3[^>]*>Project one/g).length, 1);
  assert.doesNotMatch(work, /action=/);
  assert.match(work, /<label class="[\w-]+" for="email">/);
  assert.match(work, /<input id="email"/);
  assert.match(work, /<title>Selected work \| Recreate Co<\/title>/);
  assert.match(work, /<meta name="description" content="We design and build fast marketing sites for small teams, from the first sketch to launch day\.">/);
  const css = await read('css/site.css');
  const gridClass = work.match(/<div class="([\w-]+)">\s*<div class="card">/)[1];
  const rules = (selector) => [...css.matchAll(new RegExp(`\\.${selector} \\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
  const [base, tablet, mobile] = rules(gridClass);
  assert.match(base, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(tablet, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(mobile, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 1024\.98px\)/);
  assert.match(css, /@media \(max-width: 600\.98px\)/);
  assert.match(css, /--brand: #0f766e;/);
  assert.match(css, /@font-face \{\n {2}font-family: "Brand Mono";\n {2}src: url\("\.\.\/assets\/fonts\/mono-[0-9a-f]{10}\.woff2"\) format\("woff2"\);/);
  assert.match(css, /@keyframes brand-fade/);
  assert.doesNotMatch(css, /@keyframes brand-pulse/); // not used by any page

  // Report: auto-generated head fields, the form, the IR and the generation stats.
  const auto = report.autoGenerated.filter((a) => a.page === '/work.html').map((a) => [a.field, a.source]);
  assert.deepEqual(auto.slice(0, 3), [['title', 'first heading'], ['description', 'first paragraph'], ['canonical', 'page URL']]);
  assert.ok(report.autoGenerated.some((a) => a.page === '/' && a.field === 'og:description'));
  assert.equal(report.autoGenerated.some((a) => a.page === '/' && a.field === 'title'), false);
  assert.deepEqual(report.pages.find((p) => p.path === '/work.html').head.autoGenerated.slice(0, 2), ['title', 'description']);
  assert.ok(report.manual.some((m) => m.kind === 'form' && m.title === 'Form on /work.html needs a backend'));
  assert.equal(report.generate.variantsMerged, 2);
  assert.ok(report.generate.wrappersRemoved >= 2);
  assert.deepEqual(report.generate.breakpoints, { tablet: 1024.98, mobile: 600.98, source: 'site' });
  const ir = JSON.parse(await readFile(path.join(dir, 'ir', 'site.json'), 'utf8'));
  assert.equal(ir.version, 1);
  assert.equal(ir.pages.length, 5);

  // Fidelity: rough, but the fixture is plain CSS and should come out close to the original.
  assert.ok(report.fidelity.score >= 90, `fidelity ${report.fidelity.score}`);
  for (const p of report.fidelity.pages) {
    assert.ok(p.score >= 85, `${p.path}: ${p.score}`);
    for (const [view, v] of Object.entries(p.views)) {
      assert.ok(v.sizes >= 0.9, `${p.path} ${view} sizes ${v.sizes}`);
      assert.ok(await exists(path.join(dir, v.screenshot)), v.screenshot);
    }
  }
});
