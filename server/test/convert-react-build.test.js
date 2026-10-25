// The as-is copy converted into a React + Vite project (recreate/convert/react.js) and built with the pinned toolchain, with no
// browser: the fixture site stands in for a finished as-is copy, plus one page of the cases React writes differently (an
// inline handler on <body>, a meta and an async script in the body, images React would preload, form controls with defaults,
// style objects, entities, a custom element, noscript, a template, an odd doctype). Checked: every built page holds the DOM
// of its as-is page (verifyConverted), not one script or stylesheet is added, the copy's files are byte for byte the same,
// what was kept as original HTML is listed with where and why, forms are described, and the development server renders the
// pages from the components. The browser proof against the original is convert-react.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConvertedReact, convertToReact, doctypeOf, domDifference, pageComponentName, REACT_EXPORT_DIR, routeOf, verifyConverted } from '../src/recreate/convert/react.js';
import { toolchainDir, toolchainStatus } from '../src/toolchains/index.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recreate-site');
const ORIGIN = 'https://www.example-original.dev';

const EDGE = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<!-- Published by a builder: "banner" & date -->
<html lang="en" class="no-js" data-theme="dark">
<head>
  <meta charset="utf-8">
  <!-- head comment -->
  <title>Edge &amp; cases</title>
  <link rel="stylesheet" href="styles.css">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script>document.documentElement.className = 'js';</script>
  <noscript><style>.reveal { opacity: 1 }</style></noscript>
</head>
<body class="edge" onload="window.loaded = 1">
  <!-- a comment with "quotes", 'single' & <angle> -->
  <!--$--><p class="marker">server-rendered</p><!--/$-->
  <header class="site-header"><a href="/">Home</a> <a href="about.html#team">About</a></header>
  <main id="content">
    <h1 style="color: rgb(10, 20, 30); --gap: 4px; -webkit-text-stroke: 0">Fish &amp; chips &lt;3 "quoted" 'single'</h1>
    <img src="img/team.png" srcset="img/team.png 1x, img/team.png 2x" alt="Team" fetchpriority="high">
    <picture><source srcset="img/photo.svg" type="image/svg+xml"><img src="img/photo.svg" alt=""></picture>
    <meta itemprop="name" content="in the body">
    <button type="button" onclick="window.clicked = (window.clicked || 0) + 1">Click</button>
    <form id="signup" action="/subscribe" method="post">
      <label for="e">Email</label><input id="e" name="email" type="email" value="a@b.c" required>
      <input type="checkbox" name="news" checked>
      <select name="plan"><option value="a">A</option><option value="b" selected>B</option></select>
      <textarea name="msg">line 1
line 2</textarea>
      <input type="hidden" name="t" value="x"><button>Send</button>
    </form>
    <x-widget for="a" tabindex="0" data-mode="on">custom</x-widget>
    <svg viewBox="0 0 10 10" width="10" height="10"><path d="M0 0h10v10z" stroke-width="2"/></svg>
    <template id="tpl"><p>later</p></template>
    <details open><summary>More</summary><p>Inside</p></details>
    <div hidden>hidden box</div>
  </main>
  <script src="hover.js" async></script>
  <footer class="site-footer"><p>&copy; 2026</p></footer>
  <script src="reveal.js" defer></script>
</body>
</html>
`;

// The original's own files at addresses Vite's development server answers for itself: npm run dev must serve these.
const RESERVED = {
  '@vite/client': 'window.originalViteClient = 1;',
  '@react-refresh': 'window.originalRefresh = 1;',
  '@fs/assets/a.css': '.fs { color: red }',
  '@id/x.js': 'window.originalId = 1;',
  'node_modules/lib/index.js': 'window.originalLib = 1;',
  'src/app.js': 'window.originalSrc = 1;',
  'vite.config.js': 'window.originalConfig = 1;',
  'package.json': '{"name":"the-original"}',
  '_app/chunk.js': 'window.originalApp = 1;',
};

let root;
let copyDir;
let outDir;
let pages;
let result;
let built;

async function listFiles(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out;
}

before(async () => {
  const tc = await toolchainStatus('react-vite');
  if (!tc.installed) throw new Error('the react-vite toolchain is not installed: npm run setup:toolchains -w server -- react-vite');
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-convert-react-'));
  copyDir = path.join(root, 'copy');
  await cp(FIXTURE, copyDir, { recursive: true });
  await rm(path.join(copyDir, 'private'), { recursive: true, force: true });
  await writeFile(path.join(copyDir, 'edge.html'), EDGE, 'utf8');
  for (const [rel, body] of Object.entries(RESERVED)) {
    await mkdir(path.dirname(path.join(copyDir, rel)), { recursive: true });
    await writeFile(path.join(copyDir, rel), body, 'utf8');
  }
  const files = await listFiles(copyDir);
  pages = files.filter((f) => f.endsWith('.html')).map((outPath) => ({ outPath, url: `${ORIGIN}/${outPath.replace(/(^|\/)index\.html$/, '$1')}` }));
  outDir = path.join(root, 'react-vite');
  result = await convertToReact({ copyDir, outDir, pages, pageUrl: `${ORIGIN}/` });
  built = await buildConvertedReact(outDir);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
});

test('addresses and names: pages keep their addresses, components are named from them, the doctype is the page\'s own', () => {
  assert.equal(routeOf('index.html'), '/');
  assert.equal(routeOf('services/index.html'), '/services/');
  assert.equal(routeOf('about.html'), '/about.html');
  assert.equal(pageComponentName('blog/first-post.html'), 'BlogFirstPost');
  assert.equal(pageComponentName('index.html'), 'Home');
  assert.equal(doctypeOf('\n<!doctype html><html></html>'), '<!doctype html>');
  assert.equal(doctypeOf('<html></html>'), '<!DOCTYPE html>');
  assert.deepEqual(result.urlChanges, [], 'no page moves');
});

test('every built page holds the DOM of its as-is page; nothing but the pages is new in dist/', { timeout: 10 * 60000 }, async () => {
  assert.deepEqual(built.steps.map((s) => s.label), ['vite build --ssr', 'prerender']);
  const v = await verifyConverted({ copyDir, outDir, pages });
  assert.equal(v.pages, pages.length);
  assert.deepEqual(v.added, [], 'no file the copy does not have, except the pages and _headers');
  const dist = path.join(outDir, REACT_EXPORT_DIR);
  const distFiles = await listFiles(dist);
  // No JavaScript at all but the copy's own scripts: not one byte of React reaches a visitor.
  const copyJs = (await listFiles(copyDir)).filter((f) => /\.m?js$/.test(f)).sort();
  assert.deepEqual(distFiles.filter((f) => /\.m?js$/.test(f)).sort(), copyJs);
  for (const p of pages) {
    const html = await readFile(path.join(dist, p.outPath), 'utf8');
    assert.doesNotMatch(html, /data-sas-raw|data-sas-comment|sas-render-start|rel="preload" as="image"/, `${p.outPath}: no conversion marker or React preload hint left`);
    assert.doesNotMatch(html, /type="module"|modulepreload/, `${p.outPath}: no module script`);
  }
  const edge = await readFile(path.join(dist, 'edge.html'), 'utf8');
  assert.ok(edge.startsWith('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n<!-- Published by a builder: "banner" & date -->\n<html'),
    'the page\'s own doctype, then the comment before <html> exactly as written');
  assert.match(edge, /<!-- head comment -->/, 'a comment of the head is kept');
  assert.ok(edge.includes(`<!-- a comment with "quotes", 'single' & <angle> -->`), 'a comment with quotes and markup characters is kept byte for byte');
  assert.ok(edge.includes('<!--$--><p class="marker">server-rendered</p><!--/$-->'), 'the hydration markers of a React-rendered original stay in place');
  assert.match(edge, /<body class="edge" onload="window.loaded = 1">/, 'a <body> attribute React cannot write is written as it was');
  assert.match(edge, /<button type="button" onclick="window.clicked = \(window.clicked \|\| 0\) \+ 1">Click<\/button>/, 'the inline handler is the original HTML');
  assert.match(edge, /<head><meta charSet="utf-8"\/><!-- head comment --><title>/, 'the head keeps the original order, its comment included');
  assert.match(edge, /<\/main>\s*<script src="hover.js" async=""><\/script>\s*<footer/, 'the async script stands where the original has it');
});

test('a difference in the built DOM is caught, named, and fails the check', async () => {
  assert.equal(domDifference('<p class="a">x</p>', '<p class="a">x</p>'), null);
  assert.equal(domDifference('<p style="color: red;  --x: 1">x</p>', '<p style="color:red;--x:1">x</p>'), null, 'a style is compared by its declarations');
  assert.equal(domDifference('<input checked="checked">', '<input checked="">'), null, 'a boolean attribute by its presence');
  assert.equal(domDifference('<head>\n <title>a</title>\n</head><body><p>x</p></body>', '<head><title>a</title></head><body><p>x</p></body>'), null, 'whitespace in the head draws nothing');
  assert.match(domDifference('<body><!--$--><p>x</p></body>', '<body><p>x</p></body>'), /#comment/, 'a comment of the body counts: a React-rendered original reads it back');
  assert.match(domDifference('<!DOCTYPE html>\n<!-- banner -->\n<html><body></body></html>', '<!DOCTYPE html><html><body></body></html>'), /prolog/, 'so do the comments before <html>');
  assert.match(domDifference('<p>a</p>', '<p>b</p>'), /"a"/);
  assert.match(domDifference('<p>a</p>', '<p>a</p><p>b</p>'), /nothing more/);
  assert.notEqual(domDifference('<body><p> a</p></body>', '<body><p>a</p></body>'), null, 'whitespace in the body is text');
  // A tampered build is refused.
  const tampered = path.join(root, 'tampered');
  await cp(outDir, tampered, { recursive: true });
  const file = path.join(tampered, REACT_EXPORT_DIR, 'about.html');
  await writeFile(file, (await readFile(file, 'utf8')).replace('</body>', '<p>extra</p></body>'), 'utf8');
  await assert.rejects(verifyConverted({ copyDir, outDir: tampered, pages }), /about\.html is not the as-is page/);
  await writeFile(path.join(tampered, REACT_EXPORT_DIR, 'about.html'), await readFile(path.join(outDir, REACT_EXPORT_DIR, 'about.html')));
  await writeFile(path.join(tampered, REACT_EXPORT_DIR, 'react-runtime.js'), 'x', 'utf8');
  await assert.rejects(verifyConverted({ copyDir, outDir: tampered, pages }), /added code the copy does not have: react-runtime\.js/);
});

test('the project: components per section, shared ones once, the fallbacks named, forms described', async () => {
  assert.equal(result.stats.pages, pages.length);
  assert.ok(result.shared.length >= 1, `shared: ${result.shared}`);
  assert.ok(result.stats.components > pages.length, 'the pages are split into sections');
  const edge = result.fallbacks.filter((f) => f.page === '/edge.html').map((f) => [f.tag, f.attribute ?? null]);
  assert.deepEqual(edge, [['meta', null], ['button', 'onclick'], ['script', null]]);
  assert.ok(result.fallbacks.every((f) => f.where && f.reason), 'each fallback says where and why');
  const signup = result.forms.find((f) => f.label === 'signup');
  assert.equal(signup.method, 'POST');
  assert.equal(signup.target, 'the original site (example-original.dev/subscribe)');
  assert.deepEqual(signup.fields, ['email', 'news', 'plan', 'msg']);
  const files = await listFiles(outDir);
  for (const f of ['package.json', 'vite.config.js', 'src/routes.js', 'src/entry-server.jsx', 'scripts/prerender.mjs', 'scripts/dev.mjs', 'README.md', 'src/pages/Home.jsx', 'src/pages/Edge.jsx', 'src/components/RawHtml.jsx', 'public/_headers', 'public/styles.css']) {
    assert.ok(files.includes(f), `${f} is written`);
  }
  assert.ok(!files.some((f) => f.startsWith('public/') && f.endsWith('.html') && pages.some((p) => `public/${p.outPath}` === f)), 'a page is a component, not a file of public/');
  const pkg = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.scripts), ['dev', 'build', 'preview']);
  assert.deepEqual(Object.keys(pkg.dependencies), ['react', 'react-dom']);
  assert.equal(pkg.devDependencies.vite, '6.3.5');
  const readme = await readFile(path.join(outDir, 'README.md'), 'utf8');
  assert.match(readme, /"signup" on \/edge\.html \(POST, 4 field\(s\)\): on the original it sent its data to the original site/);
  assert.match(readme, /3 element\(s\) could not be written exactly as JSX|element\(s\) could not be written exactly as JSX/);
});

test('npm run dev shows every page exactly as the build ships it and serves the original\'s files first, even where Vite answers', { timeout: 3 * 60000 }, async () => {
  const modules = path.join(outDir, 'node_modules');
  await symlink(path.join(toolchainDir('react-vite'), 'node_modules'), modules, 'junction');
  const port = 4291;
  const dev = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: outDir, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    let res;
    for (let i = 0; i < 60 && !res; i++) {
      res = await fetch(`${dev}/about.html`).catch(() => null);
      if (!res) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(res, `the dev server answered: ${out.slice(-500)}`);
    assert.equal(res.status, 200);
    // Every page, at its address and at its file: byte for byte what the build wrote (the same rendering and finishing code,
    // no Vite client, no React code, the prolog and the comments put back).
    const dist = path.join(outDir, REACT_EXPORT_DIR);
    for (const p of pages) {
      const builtPage = await readFile(path.join(dist, p.outPath), 'utf8');
      for (const address of new Set([new URL(p.url).pathname, `/${p.outPath}`])) {
        const page = await fetch(`${dev}${address}`);
        assert.equal(page.status, 200, `${address}: ${out.slice(-800)}`);
        assert.match(page.headers.get('content-type'), /text\/html/);
        assert.equal(await page.text(), builtPage, `${address} in development is the built ${p.outPath}`);
      }
    }
    // The original's own files, including the ones at addresses Vite's development server keeps for itself.
    for (const rel of ['styles.css', ...Object.keys(RESERVED)]) {
      const file = await fetch(`${dev}/${rel}`);
      assert.equal(file.status, 200, `/${rel}`);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), await readFile(path.join(copyDir, rel)), `/${rel} is the original's file`);
    }
    // A folder page without its slash goes to it, as on a static host; an unknown address is a 404; nothing but reading.
    const folder = await fetch(`${dev}/services`, { redirect: 'manual' });
    assert.equal(folder.status, 301);
    assert.equal(folder.headers.get('location'), '/services/');
    assert.equal((await fetch(`${dev}/no-such-page.html`)).status, 404);
    assert.equal((await fetch(`${dev}/@vite/env`)).status, 404, 'no Vite address the original does not have is answered');
    assert.equal((await fetch(`${dev}/about.html`, { method: 'POST', body: 'x' })).status, 405);
    // An edit to a component shows when the page is loaded again.
    const components = path.join(outDir, 'src', 'components');
    let edited = null;
    for (const name of await readdir(components)) {
      const text = await readFile(path.join(components, name), 'utf8');
      if (text.includes('server-rendered')) { edited = { file: path.join(components, name), text }; break; }
    }
    assert.ok(edited, 'a component holds the marker paragraph');
    await writeFile(edited.file, edited.text.replace('server-rendered', 'edited in development'), 'utf8');
    try {
      const again = await (await fetch(`${dev}/edge.html`)).text();
      assert.ok(again.includes('<p class="marker">edited in development</p>'), 'the edit is shown on the next load');
    } finally {
      await writeFile(edited.file, edited.text, 'utf8');
    }
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await rmdir(modules).catch(() => unlink(modules)).catch(() => {});
  }
});

test('the download: DEPLOY.md names only scripts and folders the converted package has', async () => {
  const { describePackage, runAndHost } = await import('../src/copy/deploy.js');
  const files = (await listFiles(outDir)).filter((f) => !/^(dist|\.ssr|\.vite|node_modules)\//.test(f));
  const d = describePackage({ files, read: (rel) => (files.includes(rel) ? readFileSync(path.join(outDir, rel), 'utf8') : null) });
  assert.equal(d.tool, 'vite');
  assert.deepEqual(d.outputs, ['dist']);
  const { run, hosts } = runAndHost(d);
  const text = [...run, ...hosts].join('\n');
  for (const m of text.matchAll(/npm run ([\w:.-]+)/g)) assert.ok(d.scripts[m[1]], `npm run ${m[1]} exists`);
  assert.match(text, /npm run build`? writes the finished site to `dist\/`/);
});
