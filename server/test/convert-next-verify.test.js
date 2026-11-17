// A built Next.js conversion held against the as-is copy page by page (convert/next.js verifyConvertedNext), as React + Vite
// and MERN are (convert/react.js verifyConverted): every exported page must hold the DOM of its as-is page, links to a moved
// page read at its new address. A page that does not is shipped as the as-is page itself (site-files/, so every later build
// and `npm run dev` keep it), its page file says so, and it is listed; when no page holds its DOM the check throws (the copy is
// then packed as static files). No browser: files only, one Next build at the start and one more in the middle.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildConverted, convertToNext, EXPORT_DIR, finishPageModule, verifyConvertedNext } from '../src/recreate/convert/next.js';
import { domDifference } from '../src/recreate/convert/react.js';
import { freePort } from '../src/recreate/behavior/preserve/serveStack.js';
import { toolchainDir, toolchainStatus } from '../src/toolchains/index.js';

const para = (n) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i + 1} of the section, long enough to be read as content.</p>`).join('');
const head = (title) => `<head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/css/site.css"></head>`;
const header = '<header class="site-header"><nav><a href="/">Home</a> <a href="/about.html">About</a> <a href="/blog/post/">Post</a></nav></header>';
const footer = '<footer class="site-footer"><p>Footer text of the site.</p><a href="/about.html#team">Team</a></footer>';
const PAGES = {
  // A builder's banner before <html>, with its line breaks: read as written, though the links of the page are moved.
  'index.html': `<!DOCTYPE html>\n<!-- Made in "Builder" -->\n<html lang="en">${head('Home')}<body>${header}<main><section class="intro"><h2>Welcome</h2>${para(6)}</section></main>${footer}</body></html>`,
  // about.html moves to /about/: every link to it is written at the new address on both sides.
  'about.html': `<!DOCTYPE html><html lang="en">${head('About')}<body>${header}<main><section class="team"><h2>Our team</h2>${para(6)}</section></main>${footer}</body></html>`,
  'blog/post/index.html': `<!DOCTYPE html><html lang="en">${head('Post')}<body>${header}<main><article class="post"><h2>A post</h2>${para(6)}<p class="mark">The sentence that will differ.</p></article></main>${footer}</body></html>`,
};
const OUT = { 'index.html': 'index.html', 'about.html': 'about/index.html', 'blog/post/index.html': 'blog/post/index.html' };

let root;
let copyDir;
let outDir;
let pages;

const exported = (rel) => readFile(path.join(outDir, EXPORT_DIR, rel), 'utf8');
const moved = (html) => html.split('href="/about.html').join('href="/about/');

before(async () => {
  const tc = await toolchainStatus('next');
  if (!tc.installed) throw new Error('the next toolchain is not installed: npm run setup:toolchains -w server -- next');
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-next-verify-'));
  copyDir = path.join(root, 'copy');
  for (const [rel, body] of Object.entries({ ...PAGES, 'css/site.css': 'body{margin:0}h2{font-size:32px}' })) {
    await mkdir(path.dirname(path.join(copyDir, rel)), { recursive: true });
    await writeFile(path.join(copyDir, rel), body);
  }
  outDir = path.join(root, 'nextjs');
  pages = Object.keys(PAGES).map((outPath) => ({ outPath, url: `https://site.example/${outPath.replace(/index\.html$/, '')}` }));
  await convertToNext({ copyDir, outDir, pages, pageUrl: 'https://site.example/' });
  await buildConverted(outDir, { timeoutMs: 6 * 60000 });
});

let dev;
let devLog = '';

after(async () => {
  if (dev && dev.exitCode === null) {
    const gone = new Promise((r) => dev.once('exit', r));
    // The dev server starts workers of its own: end the whole tree.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { windowsHide: true });
    else dev.kill();
    await gone;
  }
  if (outDir) await rmdir(path.join(outDir, 'node_modules')).catch(() => unlink(path.join(outDir, 'node_modules'))).catch(() => {});
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

test('every exported page holds the DOM of its as-is page (a moved page and its links included)', async () => {
  const v = await verifyConvertedNext({ copyDir, outDir, pages });
  assert.deepEqual(v, { pages: 3, matched: 3, plain: [] }, JSON.stringify(v.plain));
  assert.match(await exported('index.html'), /href="\/about\/"/, 'the link to the moved page is at its new address');
});

test('a page that does not hold it ships as the as-is page, its page file says so, and it is listed', async () => {
  const post = OUT['blog/post/index.html'];
  await writeFile(path.join(outDir, EXPORT_DIR, post), (await exported(post)).replace('The sentence that will differ.', 'Another sentence.'));
  const v = await verifyConvertedNext({ copyDir, outDir, pages });
  assert.equal(v.matched, 2);
  assert.deepEqual(v.plain.map((x) => [x.page, x.outPath]), [['/blog/post/', 'blog/post/index.html']]);
  assert.match(v.plain[0].difference, /The sentence that will differ/);
  const plain = moved(PAGES['blog/post/index.html']);
  for (const file of [path.join(outDir, EXPORT_DIR, post), path.join(outDir, 'site-files', post)]) {
    const html = await readFile(file, 'utf8');
    assert.equal(domDifference(PAGES['blog/post/index.html'].split('href="/about.html').join('href="/about/'), html), null, file);
    assert.equal(domDifference(plain, html), null);
  }
  const groups = (await readdir(path.join(outDir, 'app'))).filter((n) => /^\(p-.+\)$/.test(n));
  const pageFile = (await Promise.all(groups.map((g) => path.join(outDir, 'app', g, 'blog', 'post', 'page.jsx')).map((f) => stat(f).then(() => f, () => null)))).find(Boolean);
  assert.ok(pageFile, 'the post has its page file');
  assert.match(await readFile(pageFile, 'utf8'), /^\/\/ This page ships as the copy's plain HTML \(site-files\/blog\/post\/index\.html\)/);
  // The other pages stay the converted ones.
  assert.equal(await readFile(path.join(outDir, 'site-files', 'index.html'), 'utf8').catch(() => null), null);
});

test('a later npm run build keeps the plain page, and the check then passes', { timeout: 8 * 60000 }, async () => {
  await buildConverted(outDir, { timeoutMs: 6 * 60000 });
  assert.equal(domDifference(moved(PAGES['blog/post/index.html']), await exported(OUT['blog/post/index.html'])), null);
  const v = await verifyConvertedNext({ copyDir, outDir, pages });
  assert.deepEqual(v.plain, []);
});

test('npm run dev shows the plain-kept page, and the converted pages as before', { timeout: 5 * 60000 }, async () => {
  await symlink(path.join(toolchainDir('next'), 'node_modules'), path.join(outDir, 'node_modules'), 'junction');
  const port = await freePort();
  const devUrl = `http://127.0.0.1:${port}`;
  dev = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: outDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' },
  });
  dev.stdout.on('data', (d) => { devLog = (devLog + d).slice(-20000); });
  dev.stderr.on('data', (d) => { devLog = (devLog + d).slice(-20000); });
  const end = Date.now() + 3 * 60000;
  while (!(await fetch(`${devUrl}/css/site.css`).then((r) => r.ok, () => false))) {
    if (dev.exitCode !== null) throw new Error(`npm run dev stopped: ${devLog.slice(-2000)}`);
    if (Date.now() > end) throw new Error(`npm run dev did not answer: ${devLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const post = await fetch(`${devUrl}/blog/post/`);
  assert.equal(post.status, 200);
  assert.match(post.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(await post.text(), await readFile(path.join(outDir, 'site-files', 'blog', 'post', 'index.html'), 'utf8'), 'the plain page, byte for byte');
  // A converted page is still Next's, finished as the build finishes it: the same DOM as out/ once Next's own tags (its
  // development scripts in dev, its build's in out/) are set aside.
  const { withoutNext } = await finishPageModule();
  const anyNext = { has: (u) => u.startsWith('/_next/') };
  for (const [route, rel] of [['/', 'index.html'], ['/about/', 'about/index.html']]) {
    const r = await fetch(`${devUrl}${route}`);
    assert.equal(r.status, 200, route);
    assert.equal(domDifference(withoutNext(await exported(rel), anyNext), withoutNext(await r.text(), anyNext)), null, `${route} in dev is the page out/ ships`);
  }
});

test('no page holding its DOM throws: the copy is then packed as static files', async () => {
  for (const rel of Object.values(OUT)) await writeFile(path.join(outDir, EXPORT_DIR, rel), (await exported(rel)).replace('Footer text of the site.', 'Changed.'));
  await assert.rejects(verifyConvertedNext({ copyDir, outDir, pages }), /no page of the build holds the DOM of its as-is page/);
});
