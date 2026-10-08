// Recreate 6.4: the Next.js emitter — route planning and URL changes, project files, the Next safety profile,
// inline-script CSP hashes in the preview, and (when the toolchain is installed) a real static export:
// build, verification, equivalence with the plain-HTML build through the URL moves, hydration.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { emitSite } from '../src/recreate/emit/html.js';
import { MOTION_JS } from '../src/recreate/emit/motionScript.js';
import { emitNext } from '../src/recreate/emit/next/index.js';
import { originalPath, planRoutes, routeSegment, urlMapFor } from '../src/recreate/emit/next/routes.js';
import { writeProject } from '../src/recreate/emit/write.js';
import { planZip } from '../src/recreate/export/zip.js';
import { inlineScriptHashes, inlineScripts } from '../src/recreate/inlineScripts.js';
import { previewHeaders, servePreview } from '../src/recreate/preview.js';
import { checkScript, scanProject, scanSite } from '../src/recreate/verify/safety.js';
import { recreateDir } from '../src/recreate/workspace.js';
import recreateRouter from '../src/routes/recreate.js';
import { toolchainDir, toolchainStatus } from '../src/toolchains/index.js';

const exists = (p) => access(p).then(() => true, () => false);
const temps = [];
const projectIds = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-next-'));
  temps.push(dir);
  return dir;
};
async function writeTree(root, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

let sid = 0;
const el = (t, props = {}, ...children) => ({ t, sid: ++sid, attrs: {}, children, ...props });
const text = (t) => ({ text: t });

test('route segments are safe for the file-system router', () => {
  assert.deepEqual(['about', 'first-post', 'v1.2', 'Über', '_private', '.well-known', '[id]', '(x)', 'a b', '%20'].map(routeSegment), ['about', 'first-post', 'v1.2', 'Über', 'private', 'well-known', 'id', 'x', 'a-b', '20']);
  assert.equal(routeSegment('???'), 'page');
});

test('pages become folders: .html files move, folder pages stay, collisions get a suffix', () => {
  const plan = planRoutes(['index.html', 'about.html', 'services/index.html', 'blog/first-post.html', 'about/index.html', '_hidden.html'].map((outPath) => ({ outPath })));
  assert.deepEqual(plan.routes.map((r) => [r.outPath, r.route, r.nextOutPath, r.changed]), [
    ['index.html', '/', 'index.html', false],
    ['about.html', '/about/', 'about/index.html', true],
    ['services/index.html', '/services/', 'services/index.html', false],
    ['blog/first-post.html', '/blog/first-post/', 'blog/first-post/index.html', true],
    ['about/index.html', '/about-2/', 'about-2/index.html', true], // /about/ is taken by about.html
    ['_hidden.html', '/hidden/', 'hidden/index.html', true],
  ]);
  assert.deepEqual(plan.urlChanges, [
    { from: '/about.html', to: '/about/' }, { from: '/blog/first-post.html', to: '/blog/first-post/' },
    { from: '/about/', to: '/about-2/' }, { from: '/_hidden.html', to: '/hidden/' },
  ]);
  assert.equal(plan.byOutPath.get('about.html').route, '/about/');
  assert.deepEqual(['index.html', 'a/index.html', 'a.html'].map(originalPath), ['/', '/a/', '/a.html']);
  const map = urlMapFor(plan.routes, 'https://www.example.com/x');
  assert.equal(map.paths['/about.html'], '/about/');
  assert.equal(map.absolute['https://www.example.com/about.html'], 'https://www.example.com/about/');
  assert.equal('/services/' in map.paths, false);
});

const headerNode = () => el('header', { class: 'site-header', b: 1 },
  el('a', { attrs: { href: { page: 'index.html' } }, class: 'logo' }, text('Home')),
  el('nav', { class: 'main-nav', b: 1 }, ...['a', 'b', 'c'].map((k) => el('a', { attrs: { href: { page: 'about.html' } } }, text(k)))));

const page = (outPath, { bodyClass = 'page', lang = 'en', canonical, meta = [], jsonLd = [] } = {}, ...content) => ({
  outPath,
  head: { lang, title: `Title ${outPath}`, description: 'd', canonical: canonical ?? `https://www.example.com${originalPath(outPath)}`, meta, alternates: [], icons: [], preload: [], jsonLd },
  html: {},
  body: el('body', { class: bodyClass }, ...content),
});

const irOf = (pages, files = []) => ({
  version: 1, baseUrl: 'https://www.example.com', siteName: 'Example', pages, tokens: {}, rules: [], fontFaces: [], keyframes: [],
  breakpoints: { tablet: 1023.98, mobile: 767.98 }, files,
});

test('emitNext writes the project: groups, pages with their head, components, redirects, moved URLs', () => {
  const pages = [
    page('index.html', {}, headerNode(), el('main', { b: 1 }, el('h1', {}, text('Home')))),
    page('about.html', { meta: [{ property: 'og:url', content: 'https://www.example.com/about.html' }, { name: 'robots', content: 'index' }], jsonLd: ['{"@type":"Thing"}'] }, headerNode(), el('main', { b: 1 }, el('p', {}, text('About')))),
    page('blog/first-post.html', { bodyClass: 'post', lang: 'fr' }, el('main', { b: 1 }, el('p', {}, text('Post')))),
  ];
  const sitemap = '<urlset><url><loc>https://www.example.com/about.html</loc></url><url><loc>https://www.example.com/</loc></url></urlset>';
  const out = emitNext(irOf(pages, [{ path: 'sitemap.xml', content: sitemap }, { path: 'robots.txt', content: 'User-agent: *' }]));
  assert.deepEqual([...out.files.keys()].filter((f) => /^(app|components)\//.test(f)).sort(), [
    'app/(site)/about/page.css', 'app/(site)/about/page.jsx', 'app/(site)/layout.jsx', 'app/(site)/page.css', 'app/(site)/page.jsx', 'app/(site-2)/blog/first-post/page.css', 'app/(site-2)/blog/first-post/page.jsx', 'app/(site-2)/layout.jsx', 'app/site.css', 'components/SiteHeader.jsx',
  ]);
  for (const f of ['package.json', 'next.config.mjs', 'jsconfig.json', '.gitignore', 'README.md', 'public/robots.txt', 'public/sitemap.xml', 'public/_redirects', 'vercel.json']) assert.ok(out.files.has(f), f);
  // Root layouts: one per distinct <html lang> + <body class>.
  assert.match(out.files.get('app/(site)/layout.jsx'), /<html lang="en">\n\s+<body className="page">\{children\}<\/body>/);
  assert.match(out.files.get('app/(site-2)/layout.jsx'), /<html lang="fr">\n\s+<body className="post">/);
  // Each page imports only its own stylesheet (inlined by Next); the layout imports none.
  assert.doesNotMatch(out.files.get('app/(site)/layout.jsx'), /import/);
  assert.match(out.files.get('app/(site)/page.jsx'), /^import '\.\/page\.css';/);
  assert.match(out.files.get('next.config.mjs'), /inlineCss: true/);
  // The head is written as elements; Next supplies charset and viewport; canonical and og:url follow the move.
  const about = out.files.get('app/(site)/about/page.jsx');
  assert.match(about, /import SiteHeader from '@\/components\/SiteHeader\.jsx';/);
  assert.match(about, /<title>\{"Title about\.html"\}<\/title>/);
  assert.match(about, /<link rel="canonical" href="https:\/\/www\.example\.com\/about\/" \/>/);
  assert.match(about, /<meta property="og:url" content="https:\/\/www\.example\.com\/about\/" \/>/);
  assert.match(about, /<script type="application\/ld\+json" dangerouslySetInnerHTML=\{\{ __html: "\{\\"@type\\":\\"Thing\\"\}" \}\} \/>/);
  assert.doesNotMatch(about, /charset|viewport/i);
  // Links to a page that moved use its new URL.
  assert.match(out.files.get('components/SiteHeader.jsx'), /href="\/about\/"/);
  // Files that carry URLs.
  assert.equal(out.files.get('public/_redirects'), '/about.html /about/ 301\n/blog/first-post.html /blog/first-post/ 301\n');
  assert.deepEqual(JSON.parse(out.files.get('vercel.json')), {
    trailingSlash: true,
    redirects: [{ source: '/about.html', destination: '/about/', permanent: true }, { source: '/blog/first-post.html', destination: '/blog/first-post/', permanent: true }],
  });
  assert.equal(out.files.get('public/sitemap.xml'), sitemap.replace('/about.html', '/about/'));
  assert.equal(out.files.get('public/robots.txt'), 'User-agent: *');
  assert.match(out.files.get('README.md'), /2 page URLs changed/);
  const pkg = JSON.parse(out.files.get('package.json'));
  assert.deepEqual([pkg.scripts.build, Object.keys(pkg.dependencies)], ['next build', ['next', 'react', 'react-dom']]);
  assert.match(pkg.dependencies.next, /^15\.\d+\.\d+$/);
  assert.match(out.files.get('next.config.mjs'), /output: 'export',\n\s+trailingSlash: true/);
  assert.deepEqual([out.stats.pages, out.stats.groups, out.stats.urlChanges, out.stats.components], [3, 2, 2, 1]);
});

test('a site whose pages all keep their URLs ships no redirects', () => {
  const out = emitNext(irOf([page('index.html', {}, el('main', { b: 1 })), page('about/index.html', {}, el('main', { b: 1 }))]));
  assert.equal(out.files.has('public/_redirects'), false);
  assert.equal(out.files.has('vercel.json'), false);
  assert.match(out.files.get('README.md'), /Every page keeps its original URL\./);
});

test('the Next safety profile allows its own bundles and JSON data pushes, nothing else', async () => {
  const shell = (body) => `<!doctype html><html><head></head><body>${body}</body></html>`;
  const ok = await tempDir();
  await writeTree(ok, {
    'ok.html': shell([
      '<script src="/_next/static/chunks/webpack-abc.js" async="" id="_R_"></script>',
      '<script src="/_next/static/chunks/app/(site)/page-1.js" async=""></script>',
      '<script>(self.__next_f=self.__next_f||[]).push([0])</script>',
      '<script>self.__next_f.push([1,"1:I[1,[],\\"\\"]\\n"])</script>',
      '<script type="application/ld+json">{"a":1}</script>',
    ].join('')),
    '_next/static/chunks/main.js': 'function f(u){return fetch(u)}', // the framework's router
    '_next/static/chunks/polyfills.js': 'var x = typeof XMLHttpRequest',
    '_next/static/chunks/app/(site)/page-1.js': 'export default () => "text about eval(x) and new Function(y)"', // page chunk: content
  });
  const good = await scanSite(ok, { app: 'next' });
  assert.deepEqual(good.issues, []);
  assert.equal(good.checked.js, 3);

  const bad = await tempDir();
  await writeTree(bad, {
    'inline.html': shell('<script>alert(1)</script>'),
    'push-code.html': shell('<script>self.__next_f.push(alert(1))</script>'),
    'push-extra.html': shell('<script>self.__next_f.push([1,"a"]);alert(1)</script>'),
    'remote.html': shell('<script src="https://evil.test/x.js"></script>'),
    'wrong-folder.html': shell('<script src="/other/x.js"></script>'),
    'module.html': shell('<script type="module" src="/_next/static/chunks/a.js"></script>'),
    '_next/static/chunks/evil.js': 'eval("1"); new WebSocket("ws://x")',
  });
  const found = (await scanSite(bad, { app: 'next' })).issues.map((i) => `${i.file}: ${i.detail}`).sort();
  assert.deepEqual(found, [
    '_next/static/chunks/evil.js: WebSocket in script',
    '_next/static/chunks/evil.js: eval() in script',
    'inline.html: <script> element',
    'module.html: <script> element',
    'push-code.html: <script> element',
    'push-extra.html: <script> element',
    'remote.html: <script> element',
    'wrong-folder.html: <script> element',
  ].sort());
  // The same data push is not allowed in the Vite profile, and fetch stays banned there.
  assert.equal((await scanSite(ok, { app: 'vite' })).safe, false);
  assert.deepEqual(checkScript('fetch(u)', { allow: ['fetch()'] }), []);
  assert.deepEqual(checkScript('fetch(u)').map((i) => i.detail), ['fetch() in script']);
});

test('scanProject covers layouts and config but not pages or components', async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    'app/(site)/layout.jsx': 'export default function L() { return null; }',
    'app/(site)/about/page.jsx': 'export default () => <p>fetch(x) and eval(y)</p>;',
    'components/Foot.jsx': 'export default () => <p>eval(x)</p>;',
    'next.config.mjs': 'export default {};',
    'package.json': '{}',
  });
  const clean = await scanProject(dir);
  assert.deepEqual([clean.safe, clean.checked], [true, 2]);
  await writeFile(path.join(dir, 'next.config.mjs'), 'eval("1");');
  assert.deepEqual((await scanProject(dir)).issues.map((i) => `${i.file}: ${i.detail}`), ['next.config.mjs: eval() in script']);
});

test('inline scripts are found and hashed (data blocks and external scripts are not)', () => {
  const html = '<script src="/a.js"></script><script>one()</script><script type="application/ld+json">{"a":1}</script><script type="module">two()</script><script>one()</script><script> </script>';
  assert.deepEqual(inlineScripts(html), ['one()', 'two()', 'one()']);
  const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
  assert.deepEqual(inlineScriptHashes(html), [sha('one()'), sha('two()')]);
});

test("the preview allows each page's inline scripts by hash, never 'unsafe-inline'", async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    'a/index.html': '<!doctype html><script>self.__next_f.push([0])</script>',
    'b/index.html': '<!doctype html><script>self.__next_f.push([1,"b"])</script>',
    'plain/index.html': '<!doctype html><p>no script</p>',
    'x.js': 'console.log(1)',
  });
  const hash = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
  const csp = async (origin, p) => (await fetch(`${origin}${p}`)).headers.get('content-security-policy');
  const inline = await servePreview(dir, { scripts: 'inline' });
  const plain = await servePreview(dir, { scripts: true });
  try {
    assert.match(await csp(inline.origin, '/a/'), new RegExp(`script-src 'self' ${hash('self.__next_f.push([0])').replace(/[+/]/g, '\\$&')};`));
    assert.match(await csp(inline.origin, '/b/'), new RegExp(hash('self.__next_f.push([1,"b"])').replace(/[+/]/g, '\\$&')));
    assert.doesNotMatch(await csp(inline.origin, '/a/'), new RegExp(hash('self.__next_f.push([1,"b"])').replace(/[+/]/g, '\\$&')));
    assert.match(await csp(inline.origin, '/plain/'), /script-src 'self';/);
    assert.match(await csp(inline.origin, '/x.js'), /script-src 'self';/);
    assert.doesNotMatch(await csp(inline.origin, '/a/'), /unsafe-inline.*script|script-src[^;]*unsafe-inline/);
    // scripts: true (React + Vite) never adds hashes.
    assert.match(await csp(plain.origin, '/a/'), /script-src 'self';/);
  } finally {
    await inline.close();
    await plain.close();
  }
  assert.match(previewHeaders(['http://a.test'], { scripts: 'inline', scriptHashes: ["'sha256-x'"] })['Content-Security-Policy'], /script-src 'self' 'sha256-x';/);
});

test('the Next project zip leaves out build output and dependencies', async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    'stacks/nextjs/package.json': '{}',
    'stacks/nextjs/app/(site)/page.jsx': 'x',
    'stacks/nextjs/public/_redirects': '/a /b 301',
    'stacks/nextjs/out/index.html': 'built',
    'stacks/nextjs/.next/cache/x': 'cache',
    'stacks/nextjs/node_modules/next/index.js': 'dep',
  });
  const report = { stack: 'nextjs', baseUrl: 'https://example.com', pages: [], warnings: [], outputs: { html: { status: 'ready', dir: 'dist' }, nextjs: { status: 'ready', dir: 'stacks/nextjs', dist: 'out' } } };
  const plan = await planZip({ dir, report, stack: 'nextjs' });
  assert.deepEqual(plan.entries.map((e) => e.name).sort(), [
    'example.com-nextjs/RECREATE-REPORT.md', 'example.com-nextjs/app/(site)/page.jsx', 'example.com-nextjs/package.json', 'example.com-nextjs/public/_redirects',
  ]);
});

test('a `revert` reset of the flex shorthand is written as longhands (Next.js postcss-flexbugs-fixes turns `flex: revert` into `flex: revert 1`)', async (t) => {
  const { emitCss } = await import('../src/recreate/emit/css.js');
  const ir = {
    siteName: 'x', tokens: {}, fontFaces: [], keyframes: [], boxSizingReset: false, breakpoints: { tablet: 1023.98, mobile: 767.98 },
    rules: [{ selector: '.stack', parts: { base: { display: 'flex', flex: '0 1 450px' }, tablet: { flex: 'revert', width: '672px' }, mobile: { flex: 'revert-layer', 'flex-grow': '1' } } }],
  };
  const css = emitCss(ir);
  assert.doesNotMatch(css, /flex:\s*revert/);
  const tablet = css.slice(css.indexOf('@media (max-width: 1023.98px)'), css.indexOf('@media (max-width: 767.98px)'));
  assert.deepEqual(tablet.match(/flex-[a-z]+: revert;/g), ['flex-grow: revert;', 'flex-shrink: revert;', 'flex-basis: revert;']);
  assert.match(tablet, /width: 672px;/);
  assert.match(css, /flex-basis: revert-layer;/);
  assert.match(css, /flex: 0 1 450px;/); // a real flex value stays a shorthand
  if (!(await toolchainStatus('next')).installed) return t.diagnostic('next toolchain not installed: the postcss check was skipped');
  // The same CSS through the plugin that broke it: nothing is rewritten, the control still shows the bug.
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(toolchainDir('next'), 'node_modules', 'next', 'package.json'));
  const postcss = require('postcss');
  const flexbugs = require('next/dist/compiled/postcss-flexbugs-fixes');
  const run = async (input) => (await postcss([flexbugs()]).process(input, { from: undefined })).css;
  assert.match(await run('.a{flex:revert}'), /flex:revert 1/); // the control: this is what the shorthand turned into
  assert.equal(await run(css), css);
});

// ---- a real export (needs the next toolchain: npm run setup:toolchains -w server -- next) ----

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('real export: static export, moved URLs, equivalence through the moves, hydration', { timeout: 480000 }, async (t) => {
  if (!(await toolchainStatus('next')).installed) return t.skip('next toolchain not installed');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', recreateRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;
  try {
    const form = el('form', { b: 1 }, el('label', { attrs: { for: 'n' } }, text('Name')), el('input', { attrs: { id: 'n', type: 'text', value: 'Ada' } }), el('button', { attrs: { type: 'submit' } }, text('Send')));
    const pages = [
      page('index.html', { jsonLd: ['{"@type":"Organization","name":"A & B <x>"}'] }, headerNode(), el('main', { b: 1 }, el('h1', { attrs: { 'data-motion': 'rv r1' } }, text('Home')),
        el('p', {}, text('Fish & chips <b>not bold</b> {braces}')), el('img', { attrs: { src: { asset: 'images/a.png' }, alt: 'A' } }),
        el('a', { attrs: { href: { anchor: '#top' } } }, text('Top')), form)),
      page('about.html', { meta: [{ property: 'og:url', content: 'https://www.example.com/about.html' }] }, headerNode(), el('main', { b: 1 }, el('h1', {}, text('About')))),
      // The original was a client-rendered app: everything in its own <div id="root"> (the mount id is never written).
      page('services/index.html', { bodyClass: 'services', lang: 'fr' }, el('div', { id: 'root', class: 'box', b: 1 }, el('main', { b: 1 }, el('h1', {}, text('Services')), el('a', { attrs: { href: { page: 'about.html', hash: '#team' } } }, text('Team'))))),
    ];
    const ir = irOf(pages, [
      { path: 'robots.txt', content: 'User-agent: *\n' },
      { path: 'sitemap.xml', content: '<urlset><url><loc>https://www.example.com/about.html</loc></url></urlset>\n' },
    ]);
    // 4b.5: the reveal script ships with the app (scroll reveal on the Home heading).
    ir.motion = { version: 1, hover: [], focus: [], reveal: [{ token: 'r1', opacity: 0, translate: [0, 16], duration: 300, easing: 'ease' }], delays: [], loops: [], script: true };

    const id = randomUUID();
    projectIds.push(id);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'p', 'https://www.example.com/', 'nextjs', 1, ?, ?)`).run(id, now, now);
    const recreateId = randomUUID();
    const dir = recreateDir(id, recreateId);
    await writeTree(dir, { 'assets/images/a.png': TINY_PNG, 'assets/manifest.json': JSON.stringify({ files: [{ file: 'images/a.png' }] }), 'ir/site.json': JSON.stringify(ir) });
    await writeProject(path.join(dir, 'dist'), emitSite(ir), { assetsDir: path.join(dir, 'assets'), known: new Set(['images/a.png']) });
    const report = {
      recreateId, stack: 'nextjs', outputs: { html: { status: 'ready', dir: 'dist' } }, pages: pages.map((p) => ({ outPath: p.outPath })),
      safety: { safe: true }, fidelity: { score: 90, threshold: 80 }, baseUrl: 'https://www.example.com', warnings: [],
    };
    db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`).run(recreateId, id, now, now, JSON.stringify(report));

    const res = await fetch(`${base}/${id}/recreate/${recreateId}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack: 'nextjs' }) });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    const out = body.output;
    assert.deepEqual([out.status, out.dir, out.dist], ['ready', 'stacks/nextjs', 'out']);
    assert.deepEqual(out.urlChanges, [{ from: '/about.html', to: '/about/' }]);
    assert.deepEqual(out.equivalence.dom, { equal: 3, total: 3 });
    assert.ok(out.equivalence.visual.min >= 0.97);
    assert.deepEqual([out.hydration.checked, out.hydration.failed], [3, 0], JSON.stringify(out.hydration));
    assert.equal(out.safety.safe, true);
    assert.deepEqual(out.fidelity, { score: 90, basis: 'equivalent-to-html', threshold: 80 });
    assert.ok(out.build.js.bytes > 0 && out.warnings.some((w) => /URL changes in the static export/.test(w)));

    const project = path.join(dir, 'stacks', 'nextjs');
    assert.equal(await exists(path.join(project, 'node_modules')), false);
    assert.equal(await exists(path.join(project, '.next')), false);
    assert.equal((await toolchainStatus('next')).installed, true);
    // The static site: pages as folders, the moved page at its new URL, files copied, redirects and sitemap updated.
    const site = path.join(project, 'out');
    for (const f of ['index.html', 'about/index.html', 'services/index.html', 'robots.txt', 'sitemap.xml', '_redirects', 'assets/images/a.png']) assert.equal(await exists(path.join(site, f)), true, f);
    assert.equal(await exists(path.join(site, 'about.html')), false);
    const about = await readFile(path.join(site, 'about', 'index.html'), 'utf8');
    assert.match(about, /<link rel="canonical" href="https:\/\/www\.example\.com\/about\/"\/>/);
    assert.match(about, /<meta property="og:url" content="https:\/\/www\.example\.com\/about\/"\/>/);
    assert.match(await readFile(path.join(site, 'sitemap.xml'), 'utf8'), /<loc>https:\/\/www\.example\.com\/about\/<\/loc>/);
    assert.equal(await readFile(path.join(site, '_redirects'), 'utf8'), '/about.html /about/ 301\n');
    assert.match(await readFile(path.join(site, 'services', 'index.html'), 'utf8'), /<html lang="fr"><head>/);
    assert.doesNotMatch(await readFile(path.join(site, 'services', 'index.html'), 'utf8'), /id="root"/, 'the original app\'s mount id is not written');

    // Preview: the stack's own output with its inline data scripts allowed by hash.
    const preview = await (await fetch(`${base}/${id}/preview`, { method: 'POST' })).json();
    assert.equal(preview.preview.scripts, true);
    const served = await fetch(`${preview.preview.url}about/`);
    assert.equal(served.status, 200);
    const csp = served.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' 'sha256-/);
    assert.doesNotMatch(csp, /unsafe-inline.*script-src|script-src[^;]*unsafe-inline/);
    // 4b.5: the reveal script is a file in public/, loaded by the page, and runs under that policy.
    assert.equal(await readFile(path.join(site, 'js', 'motion.js'), 'utf8'), MOTION_JS);
    assert.match(await readFile(path.join(site, 'index.html'), 'utf8'), /<script src="\/js\/motion\.js" defer=""><\/script>/);
    const browser = await launchBrowser();
    try {
      const motionPage = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
      await motionPage.goto(preview.preview.url, { waitUntil: 'load' });
      await motionPage.waitForFunction(() => document.querySelector('h1').classList.contains('is-in'), null, { timeout: 5000 });
      assert.equal(await motionPage.evaluate(() => document.documentElement.classList.contains('js-motion')), true);
    } finally {
      await browser.close();
    }
    await fetch(`${base}/${id}/preview`, { method: 'DELETE' });
    const head = await fetch(`${base}/${id}/recreate/${recreateId}/download?stack=nextjs`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-disposition'), 'attachment; filename="example.com-nextjs.zip"');
  } finally {
    server.close();
    await import('../src/recreate/preview.js').then((m) => m.stopPreview());
  }
});
