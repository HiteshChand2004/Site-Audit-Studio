// Recreate 6.3: the React + Vite emitter — JSX output, shared components, project files, the app safety
// rules, preview script policy, the project zip, and (when the toolchain is installed) a real export:
// build, verification, equivalence with the plain-HTML build and hydration.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import { emitSite } from '../src/recreate/emit/html.js';
import { findShared } from '../src/recreate/emit/react/components.js';
import { emitReact, pageName, pagePath } from '../src/recreate/emit/react/index.js';
import { jsxNode, jsxText, propName, styleObject, svgPropName, visibleChildren } from '../src/recreate/emit/react/jsx.js';
import { writeProject } from '../src/recreate/emit/write.js';
import { planZip } from '../src/recreate/export/zip.js';
import { previewHeaders } from '../src/recreate/preview.js';
import { checkScript, scanProject, scanSite } from '../src/recreate/verify/safety.js';
import { recreateDir } from '../src/recreate/workspace.js';
import recreateRouter from '../src/routes/recreate.js';
import { toolchainStatus } from '../src/toolchains/index.js';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-react-'));
  temps.push(dir);
  return dir;
};
async function writeTree(root, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

// IR helpers.
let sid = 0;
const el = (t, props = {}, ...children) => ({ t, sid: ++sid, attrs: {}, children, ...props });
const text = (t) => ({ text: t });
const refs = {
  useAsset: () => true,
  assetHref: (f) => `/assets/${f}`,
  pageHref: pagePath,
  stylesheetHref: () => null,
};

test('page names and paths follow the original URLs', () => {
  assert.deepEqual(['index.html', 'about/index.html', 'about.html', 'services/web/index.html', 'blog/first-post.html'].map(pageName), ['Home', 'About', 'About', 'ServicesWeb', 'BlogFirstPost']);
  assert.deepEqual(['index.html', 'about/index.html', 'about.html'].map(pagePath), ['/', '/about/', '/about.html']);
});

test('React prop names, style objects and JSX text', () => {
  assert.deepEqual(['for', 'tabindex', 'srcset', 'colspan', 'crossorigin', 'aria-label', 'data-x', 'loading'].map(propName), ['htmlFor', 'tabIndex', 'srcSet', 'colSpan', 'crossOrigin', 'aria-label', 'data-x', 'loading']);
  assert.deepEqual(['stroke-width', 'xlink:href', 'class', 'viewBox', 'data-a'].map(svgPropName), ['strokeWidth', 'xlinkHref', 'className', 'viewBox', 'data-a']);
  assert.deepEqual(styleObject('color: red; --x: 1; background-color:#fff;;'), { color: 'red', '--x': '1', backgroundColor: '#fff' });
  assert.equal(jsxText('Hello world'), 'Hello world');
  assert.equal(jsxText(' lead'), '{" lead"}');
  assert.equal(jsxText('a\nb'), '{"a\\nb"}');
  assert.equal(jsxText('a  b'), '{"a  b"}');
  assert.equal(jsxText('1 < 2 & {x}'), '{"1 < 2 & {x}"}');
  assert.equal(jsxText(' '), '{" "}');
});

test('jsxNode writes elements the way HTML reads them', () => {
  const j = (n, components) => jsxNode(n, refs, 0, components);
  assert.equal(j(el('br')), '<br />');
  assert.equal(j(el('img', { attrs: { src: { asset: 'images/a.png' }, alt: '', loading: 'lazy' }, class: 'hero' })), '<img className="hero" src="/assets/images/a.png" alt="" loading="lazy" />');
  assert.equal(j(el('a', { attrs: { href: { page: 'about/index.html', hash: '#team' }, title: 'a "b" & c' } }, text('About'))), '<a href="/about/#team" title={"a \\"b\\" & c"}>\n  About\n</a>');
  // Boolean and form attributes become the props React renders them from, without controlled inputs.
  assert.equal(j(el('input', { attrs: { type: 'checkbox', checked: '', disabled: '', value: 'x' } })), '<input type="checkbox" defaultChecked disabled defaultValue="x" />');
  assert.equal(j(el('textarea', {}, text('hi\nthere'))), '<textarea defaultValue={"hi\\nthere"} />');
  const select = el('select', {}, el('option', { attrs: { value: 'a' } }, text('A')), el('option', { attrs: { value: 'b', selected: '' } }, text('B')));
  const out = j(select);
  assert.match(out, /<select defaultValue="b">/);
  assert.doesNotMatch(out, /selected/);
  // Inline SVG keeps its own element: attributes as props, the inner markup as HTML.
  const svg = j({ t: 'svg', sid: 1, class: 'logo', attrs: {}, children: [], raw: '<svg width="24" viewBox="0 0 24 24" stroke-width="2"><use href="asset:icons/a.svg#i"/></svg>' });
  assert.equal(svg, '<svg className="logo" width="24" viewBox="0 0 24 24" strokeWidth="2" dangerouslySetInnerHTML={{ __html: "<use href=\\"/assets/icons/a.svg#i\\"/>" }} />');
});

test('children follow the HTML emitter: block-only whitespace dropped, inline whitespace and adjacent text kept', () => {
  const block = (t) => el(t, { b: 1 });
  assert.deepEqual(visibleChildren([block('div'), text('\n  '), block('p')], 'section').map((c) => c.t), ['div', 'p']);
  assert.equal(visibleChildren([text('a '), el('b'), text(' '), el('i')], 'p').length, 4);
  assert.deepEqual(visibleChildren([text('health'), text('.')], 'p'), [{ text: 'health.' }]); // JSX would join separate lines with a space
  assert.equal(visibleChildren([text('\n  ')], 'pre').length, 1);
});

const headerNode = (extra = {}) => el('header', { class: 'site-header', b: 1, ...extra },
  el('a', { attrs: { href: { page: 'index.html' } }, class: 'logo' }, text('Home')),
  el('nav', { class: 'main-nav', b: 1 },
    ...['a', 'b', 'c'].map((k) => el('a', { attrs: { href: { page: 'index.html' } } }, text(k)))));

const page = (outPath, ...content) => ({
  outPath,
  head: { lang: 'en', title: outPath, description: 'd', canonical: `https://x.test/${outPath}`, meta: [], alternates: [], icons: [], jsonLd: [] },
  html: {},
  body: el('body', { class: 'page' }, ...content),
});

test('blocks identical on two pages become one component; different ones stay inline', () => {
  const pages = [
    page('index.html', headerNode(), el('main', { b: 1 }, el('h1', {}, text('Home')))),
    page('about.html', headerNode(), el('main', { b: 1 }, el('h1', {}, text('About')))),
    page('contact.html', headerNode({ class: 'site-header active' }), el('main', { b: 1 }, el('h1', {}, text('Contact')))),
  ];
  const { names, components } = findShared(pages, new Set(['Home']));
  assert.equal(components.length, 1);
  assert.equal(components[0].name, 'SiteHeader');
  assert.equal(components[0].pages, 2);
  assert.equal(names.size, 2); // pages 1 and 2 only; the third header differs by a class
  assert.equal(names.get(pages[0].body.children[0]), 'SiteHeader');
  assert.equal(names.has(pages[2].body.children[0]), false);
  // A name already taken (a page component) gets a suffix.
  assert.equal(findShared(pages, new Set(['SiteHeader'])).components[0].name, 'SiteHeader2');
});

test('emitReact writes the project: pages, components, styles, head data, public files and assets', () => {
  const pages = [
    page('index.html', headerNode(), el('main', { b: 1 }, el('img', { attrs: { src: { asset: 'images/a.png' }, alt: 'A' } }))),
    page('about/index.html', headerNode(), el('main', { b: 1 }, el('p', {}, text('About')))),
  ];
  const ir = {
    version: 1, baseUrl: 'https://www.example.com', siteName: 'Example', pages, tokens: {}, rules: [], fontFaces: [], keyframes: [],
    breakpoints: { tablet: 1023.98, mobile: 767.98 },
    files: [{ path: 'sitemap.xml', content: '<urlset/>' }, { path: 'robots.txt', content: 'User-agent: *' }],
  };
  const out = emitReact(ir);
  assert.deepEqual([...out.files.keys()].filter((f) => f.startsWith('src/')).sort(), [
    'src/components/SiteHeader.jsx', 'src/entry-server.jsx', 'src/main.jsx', 'src/page-meta.json', 'src/pages.js', 'src/pages/About.jsx', 'src/pages/Home.jsx', 'src/styles/site.css',
  ]);
  for (const f of ['package.json', 'vite.config.js', 'index.html', 'scripts/prerender.mjs', 'README.md', '.gitignore', 'public/sitemap.xml', 'public/robots.txt']) assert.ok(out.files.has(f), f);
  assert.deepEqual([...out.assets], ['images/a.png']);
  const home = out.files.get('src/pages/Home.jsx');
  assert.match(home, /^import SiteHeader from '\.\.\/components\/SiteHeader\.jsx';/);
  assert.match(home, /<SiteHeader \/>/);
  assert.match(home, /src="\/assets\/images\/a\.png"/);
  const meta = JSON.parse(out.files.get('src/page-meta.json'));
  assert.deepEqual(meta.map((m) => [m.path, m.outPath, m.name, m.lang, m.bodyClass]), [['/', 'index.html', 'Home', 'en', 'page'], ['/about/', 'about/index.html', 'About', 'en', 'page']]);
  assert.match(meta[0].head, /<title>index\.html<\/title>/);
  assert.doesNotMatch(meta[0].head, /stylesheet/); // Vite adds the built stylesheet
  assert.match(out.files.get('src/styles/site.css'), /#root \{\n  display: contents;\n\}/);
  const pkg = JSON.parse(out.files.get('package.json'));
  assert.equal(pkg.name, 'example-com-site');
  assert.equal(pkg.type, 'module');
  assert.match(pkg.dependencies.react, /^\d+\.\d+\.\d+$/); // pinned, from the toolchain
  assert.match(out.files.get('src/pages.js'), /path: "\/about\/", outPath: "about\/index\.html", load: \(\) => import\('\.\/pages\/About\.jsx'\)/);
  assert.equal(out.stats.components, 1);
});

test('the app safety rules allow only our own bundle; scripts and sinks are findings', async () => {
  const dir = await tempDir();
  const shell = (head) => `<!doctype html><html><head>${head}</head><body><div id="root"></div></body></html>`;
  await writeTree(dir, {
    'ok.html': shell('<script type="module" crossorigin src="/_app/index-abc.js"></script><link rel="modulepreload" href="/_app/Home-x.js"><link rel="stylesheet" href="/_app/style.css">'),
    '_app/index-abc.js': 'console.log("hi")',
    '_app/Home-x.js': 'export default () => "text that says fetch(url) and eval(x)"', // page content: not scanned
    '_app/style.css': 'a{color:red}',
  });
  const contentChunk = (rel) => rel.startsWith('_app/Home-');
  const ok = await scanSite(dir, { app: true, contentChunk });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.checked.js, 2);

  const bad = await tempDir();
  await writeTree(bad, {
    'inline.html': shell('<script type="module">alert(1)</script>'),
    'remote.html': shell('<script type="module" src="https://evil.test/x.js"></script>'),
    'classic.html': shell('<script src="/_app/a.js"></script>'),
    'preload.html': shell('<link rel="modulepreload" href="https://evil.test/x.js">'),
    '_app/a.js': 'fetch("/x")',
    '_app/b.js': 'new Function("return 1")()',
  });
  const found = (await scanSite(bad, { app: true })).issues.map((i) => `${i.file}: ${i.detail}`).sort();
  assert.deepEqual(found, [
    '_app/a.js: fetch() in script',
    '_app/b.js: new Function() in script',
    'classic.html: <script> element',
    'inline.html: <script> element',
    'preload.html: modulepreload https://evil.test/x.js',
    'remote.html: <script> element',
  ]);
  // Without the app option a module script is never allowed (the plain-HTML build has none).
  assert.equal((await scanSite(dir)).safe, false);

  assert.deepEqual(checkScript('document.write(1); new WebSocket(u); import("https://a.test/x.js")').map((i) => i.detail), ['document.write() in script', 'WebSocket in script', 'import() of another origin in script']);
  assert.deepEqual(checkScript('import("./Home-x.js"); const u = "https://a.test/x"'), []); // a URL string is inert
});

test('scanProject checks the code around the pages, not the pages themselves', async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    'src/main.jsx': 'export const x = 1;',
    'src/pages/Home.jsx': 'export default () => <p>use fetch(url) like this</p>;', // site content
    'src/components/Foot.jsx': 'export default () => <p>eval(x)</p>;',
    'scripts/prerender.mjs': 'console.log(1);',
    'vite.config.js': 'export default {};',
  });
  const clean = await scanProject(dir);
  assert.deepEqual([clean.safe, clean.checked], [true, 3]);
  await writeFile(path.join(dir, 'src', 'main.jsx'), 'fetch("/x");');
  const dirty = await scanProject(dir);
  assert.deepEqual(dirty.issues.map((i) => `${i.file}: ${i.detail}`), ['src/main.jsx: fetch() in script']);
});

test('the preview sends script-src only for an app', () => {
  assert.doesNotMatch(previewHeaders(['http://a.test'])['Content-Security-Policy'], /script-src/);
  assert.match(previewHeaders(['http://a.test'], { scripts: true })['Content-Security-Policy'], /default-src 'none'; script-src 'self';/);
});

test('the project zip holds the source and the report, never build output or dependencies', async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    'stacks/react-vite/package.json': '{}',
    'stacks/react-vite/src/main.jsx': 'x',
    'stacks/react-vite/public/assets/images/a.png': 'png',
    'stacks/react-vite/dist/index.html': 'built',
    'stacks/react-vite/.ssr/entry.js': 'ssr',
    'stacks/react-vite/node_modules/react/index.js': 'dep',
    'stacks/react-vite/.gitignore': 'dist',
  });
  const report = {
    stack: 'react-vite', baseUrl: 'https://www.Example.com/', pages: [], warnings: [],
    outputs: {
      html: { status: 'ready', dir: 'dist' },
      'react-vite': { status: 'ready', dir: 'stacks/react-vite', dist: 'dist', build: { toolchain: 'react-vite', js: { bytes: 204800, gzipBytes: 71680 }, css: { bytes: 2048 } }, equivalence: { dom: { equal: 2, total: 2 }, visual: { min: 1 } }, fidelity: { score: 91 }, warnings: ['one warning'] },
    },
  };
  const plan = await planZip({ dir, report, stack: 'react-vite' });
  assert.equal(plan.name, 'example.com-react-vite.zip');
  assert.deepEqual(plan.entries.map((e) => e.name).sort(), [
    'example.com-react-vite/.gitignore',
    'example.com-react-vite/RECREATE-REPORT.md',
    'example.com-react-vite/package.json',
    'example.com-react-vite/public/assets/images/a.png',
    'example.com-react-vite/src/main.jsx',
  ]);
  const md = plan.entries.find((e) => e.name.endsWith('RECREATE-REPORT.md')).content;
  assert.match(md, /## react-vite build/);
  assert.match(md, /same DOM and pixels on 2\/2 pages/);
  assert.match(md, /JavaScript: 200 KB \(70 KB gzipped\)/);
  assert.match(md, /- one warning/);
  await assert.rejects(planZip({ dir, report, stack: 'nextjs' }), (e) => e.status === 400);
});

// ---- a real export (needs the react-vite toolchain: npm run setup:toolchains -w server -- react-vite) ----

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const tricky = () => {
  const form = el('form', { b: 1, attrs: { method: 'post' } },
    el('label', { attrs: { for: 'n' } }, text('Name')),
    el('input', { attrs: { id: 'n', type: 'text', value: 'Ada', required: '' } }),
    el('input', { attrs: { type: 'checkbox', checked: '' } }),
    el('select', {}, el('option', { attrs: { value: 'a' } }, text('A')), el('option', { attrs: { value: 'b', selected: '' } }, text('B'))),
    el('textarea', {}, text('line 1\nline 2')),
    el('button', { attrs: { type: 'submit' } }, text('Send')));
  return [
    el('p', { b: 1 }, text('Fish & chips <b>not bold</b> {braces} "quotes"'), el('em', {}, text('em')), text(' tail '), text('merged')),
    el('p', { b: 1 }, text('  leading and  double  spaces  ')),
    el('img', { attrs: { src: { asset: 'images/a.png' }, alt: 'A "pic"', srcset: [{ asset: 'images/a.png', d: '1x' }, { asset: 'images/a.png', d: '2x' }] } }),
    { t: 'svg', sid: ++sid, class: 'icon', attrs: {}, children: [], raw: '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="3" stroke-width="1" fill="#0f766e"/></svg>' },
    form,
    el('a', { attrs: { href: { page: 'about.html', hash: '#top' } } }, text('About')),
    el('a', { attrs: { href: { external: 'https://example.org/x?a=1&b=2' }, target: '_blank', rel: 'noopener' } }, text('External')),
  ];
};

test('real export: build, verify, equivalence with the HTML build, hydration', { timeout: 300000 }, async (t) => {
  if (!(await toolchainStatus('react-vite')).installed) return t.skip('react-vite toolchain not installed');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', recreateRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;
  try {
    const pages = [
      page('index.html', headerNode(), el('main', { b: 1 }, el('h1', {}, text('Home')), ...tricky())),
      page('about.html', headerNode(), el('main', { b: 1 }, el('h1', {}, text('About')), el('p', {}, text('Hello')))),
    ];
    const ir = {
      version: 1, baseUrl: 'https://www.example.com', siteName: 'Example', pages, tokens: {}, rules: [], fontFaces: [], keyframes: [],
      breakpoints: { tablet: 1023.98, mobile: 767.98 }, files: [{ path: 'robots.txt', content: 'User-agent: *\n' }],
    };

    const id = randomUUID();
    projectIds.push(id);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'p', 'https://www.example.com/', 'react-vite', 1, ?, ?)`).run(id, now, now);
    const recreateId = randomUUID();
    const dir = recreateDir(id, recreateId);
    const known = new Set(['images/a.png']);
    await writeTree(dir, { 'assets/images/a.png': TINY_PNG, 'assets/manifest.json': JSON.stringify({ files: [{ file: 'images/a.png' }] }), 'ir/site.json': JSON.stringify(ir) });
    await writeProject(path.join(dir, 'dist'), emitSite(ir), { assetsDir: path.join(dir, 'assets'), known });
    const report = {
      recreateId, stack: 'react-vite', outputs: { html: { status: 'ready', dir: 'dist' } }, pages: pages.map((p) => ({ outPath: p.outPath })),
      safety: { safe: true }, fidelity: { score: 90, threshold: 80 }, baseUrl: 'https://www.example.com', warnings: [],
    };
    db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`).run(recreateId, id, now, now, JSON.stringify(report));

    const res = await fetch(`${base}/${id}/recreate/${recreateId}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack: 'react-vite' }) });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    const out = body.output;
    assert.deepEqual([out.status, out.dir, out.dist, out.from], ['ready', 'stacks/react-vite', 'dist', 'ir']);
    assert.deepEqual(out.equivalence.dom, { equal: 2, total: 2 });
    assert.ok(out.equivalence.visual.min >= 0.97);
    assert.deepEqual([out.hydration.checked, out.hydration.failed], [2, 0], JSON.stringify(out.hydration));
    assert.equal(out.safety.safe, true);
    assert.deepEqual(out.fidelity, { score: 90, basis: 'equivalent-to-html', threshold: 80 });
    assert.ok(out.build.js.bytes > 0 && out.build.css.bytes > 0);
    assert.deepEqual(out.warnings, []);

    // The build left only the project's own files (no node_modules link) and the toolchain is intact.
    const project = path.join(dir, 'stacks', 'react-vite');
    assert.equal(await exists(path.join(project, 'node_modules')), false);
    assert.equal(await exists(path.join(project, '.ssr')), false);
    assert.equal((await toolchainStatus('react-vite')).installed, true);
    const home = await readFile(path.join(project, 'dist', 'index.html'), 'utf8');
    assert.match(home, /<div id="root">.*<h1>Home<\/h1>/s);
    assert.match(home, /<script type="module" crossorigin src="\/_app\/index-[\w-]+\.js"><\/script>/);
    assert.match(home, /<link rel="stylesheet" crossorigin href="\/_app\/style-[\w-]+\.css">/);
    assert.equal(await exists(path.join(project, 'dist', 'about.html')), true);
    assert.equal(await exists(path.join(project, 'dist', 'robots.txt')), true);
    assert.equal(await exists(path.join(project, 'dist', 'assets', 'images', 'a.png')), true);
    assert.ok((await readdir(path.join(project, 'dist', '_app'))).some((f) => /^SiteHeader-/.test(f)));

    // Preview: the project's stack output, with its scripts allowed; download: source without build output.
    const preview = await (await fetch(`${base}/${id}/preview`, { method: 'POST' })).json();
    assert.equal(preview.preview.scripts, true);
    const served = await fetch(`${preview.preview.url}about.html`);
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-security-policy'), /script-src 'self'/);
    await fetch(`${base}/${id}/preview`, { method: 'DELETE' });
    const head = await fetch(`${base}/${id}/recreate/${recreateId}/download?stack=react-vite`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-disposition'), 'attachment; filename="example.com-react-vite.zip"');

    // A second export returns the existing output.
    const again = await fetch(`${base}/${id}/recreate/${recreateId}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack: 'react-vite' }) });
    assert.equal(again.status, 200);
  } finally {
    server.close();
    await import('../src/recreate/preview.js').then((m) => m.stopPreview());
  }
});

test('an emitter mistake is caught: a DOM that differs from the HTML build fails the export and is recorded', { timeout: 300000 }, async (t) => {
  if (!(await toolchainStatus('react-vite')).installed) return t.skip('react-vite toolchain not installed');
  const { getEmitter, registerEmitter } = await import('../src/recreate/emit/index.js');
  const { exportStack } = await import('../src/recreate/export/fromIr.js');
  const real = getEmitter('react-vite');
  // The same emitter with a deliberate bug: every <em> loses its text.
  registerEmitter({ ...real, emit: (ir) => emitReact({ ...ir, pages: ir.pages.map((p) => ({ ...p, body: JSON.parse(JSON.stringify(p.body).replaceAll('"text":"em"', '"text":"gone"')) })) }) });
  try {
    const pages = [page('index.html', el('main', { b: 1 }, el('p', {}, el('em', {}, text('em')))))];
    const ir = { version: 1, baseUrl: 'https://x.test', pages, tokens: {}, rules: [], fontFaces: [], keyframes: [], breakpoints: { tablet: 1023.98, mobile: 767.98 }, files: [] };
    const id = randomUUID();
    projectIds.push(id);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'p', 'https://x.test/', 'react-vite', 1, ?, ?)`).run(id, now, now);
    const recreateId = randomUUID();
    const dir = recreateDir(id, recreateId);
    await writeTree(dir, { 'assets/manifest.json': JSON.stringify({ files: [] }), 'ir/site.json': JSON.stringify(ir) });
    await writeProject(path.join(dir, 'dist'), emitSite(ir), { assetsDir: path.join(dir, 'assets'), known: new Set() });
    const report = { recreateId, stack: 'react-vite', outputs: { html: { status: 'ready', dir: 'dist' } }, pages: [{ outPath: 'index.html' }], safety: { safe: true }, fidelity: { score: 90 } };
    db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`).run(recreateId, id, now, now, JSON.stringify(report));

    await assert.rejects(exportStack({ projectId: id, recreateId, stack: 'react-vite' }), /not the same page as the plain-HTML build on \/ .*#em" vs ".*#gone"/s);
    assert.equal(await exists(path.join(dir, 'stacks', 'react-vite')), false);
    assert.equal(await exists(path.join(dir, 'stacks', 'react-vite.tmp')), false);
    const stored = JSON.parse(db.prepare('SELECT result_json FROM recreates WHERE id = ?').get(recreateId).result_json);
    assert.equal(stored.outputs['react-vite'].status, 'failed');
    assert.match(stored.outputs['react-vite'].error, /not the same page/);
  } finally {
    registerEmitter(real);
  }
});

