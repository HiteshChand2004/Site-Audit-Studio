// An original built with Next.js, converted into a Next.js project (recreate/convert/next.js): its own stylesheets, scripts,
// fonts and images live under /_next/, an address the converted project's stack reserves for itself. `next dev` answers every
// /_next/ address itself, so the development server showed such a copy unstyled while the build (whose after-build step copies
// site-files/ into out/) was right. Here both are run: `npm run dev` (scripts/dev.mjs) must serve every one of the original's
// /_next/ files and every page exactly as `npm run build` ships it, and both must look and behave like the original.
// The home page is built the way the App Router builds (stylesheets under chunks/ with data-precedence, async scripts,
// self.__next_f), /about/ the way the Pages Router does (data-next-head metas, <noscript data-n-css>, <div id="__next">,
// __NEXT_DATA__): tags that look like the ones Next adds to the converted pages and must stay the original's.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { buildConverted, convertToNext, EXPORT_DIR } from '../src/recreate/convert/next.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { domSignature, firstDifference } from '../src/recreate/verify/equivalence.js';
import { toolchainDir, toolchainStatus } from '../src/toolchains/index.js';

const DEV_PORT = 4255;
const DEV = `http://127.0.0.1:${DEV_PORT}`;
const FONTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recreate-site', 'fonts');

const HOME = `<!DOCTYPE html><html lang="en" class="brand_variable"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/_next/static/chunks/0a1b2c3d.css" data-precedence="next"><link rel="preload" href="/_next/static/media/brand-s.p.4f2a.woff2" as="font" crossorigin="" type="font/woff2"><script src="/_next/static/chunks/main-app-9f8e7d.js" async=""></script><title>Built with Next.js</title><meta name="description" content="A page built the way the App Router builds."></head><body><header class="site-header"><a href="/" class="logo"><img src="/_next/static/media/logo.77aa.svg" alt="Home" width="32" height="32"></a><nav><a href="/about/">About</a></nav></header><main><h1 class="hero">Tested pull requests</h1><p class="lead">Styled by the original's own stylesheet.</p><p id="ran">not yet</p><img src="/images/photo.svg" alt="A photo" width="120" height="80"></main><footer class="site-footer"><p>Footer</p></footer><script>self.__next_f=self.__next_f||[];self.__next_f.push([0])</script><script>self.__next_f.push([1,"0:{\\"P\\":null}\\n"])</script></body></html>`;
const ABOUT = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8" data-next-head=""/><meta name="viewport" content="width=device-width" data-next-head=""/><title data-next-head="">About · Built with Next.js</title><link rel="preload" href="/_next/static/css/5d6e7f80.css" as="style"/><link rel="stylesheet" href="/_next/static/css/5d6e7f80.css" data-n-g=""/><noscript data-n-css=""></noscript><script defer="" src="/_next/static/chunks/framework-1122aa.js"></script></head><body><div id="__next"><header class="site-header"><a href="/" class="logo"><img src="/_next/static/media/logo.77aa.svg" alt="Home" width="32" height="32"/></a><nav><a href="/about/">About</a></nav></header><main><h1 class="hero">About us</h1><p id="ran">not yet</p></main></div><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}},"page":"/about","query":{},"buildId":"b1"}</script></body></html>`;
const FILES = {
  '_next/static/chunks/0a1b2c3d.css': `@font-face{font-family:Brand;src:url(/_next/static/media/brand-s.p.4f2a.woff2) format("woff2")}
body{margin:0;background:rgb(12,20,33);color:rgb(240,236,220);font-family:Brand,monospace}
.site-header{display:flex;gap:24px;align-items:center;padding:16px 32px;background:rgb(30,90,60)}.site-header a{color:rgb(255,210,0)}
.hero{font-size:48px;margin:32px}.lead{margin:0 32px;color:rgb(150,200,255)}#ran{margin:16px 32px}.site-footer{padding:24px 32px;border-top:4px solid rgb(255,210,0)}`,
  '_next/static/css/5d6e7f80.css': `body{margin:0;background:rgb(250,245,235);color:rgb(40,30,20);font-family:Georgia,serif}
.site-header{display:flex;gap:24px;padding:20px 40px;background:rgb(120,40,30)}.site-header a{color:rgb(255,255,255)}.hero{font-size:40px;margin:40px}#ran{margin:0 40px}`,
  '_next/static/chunks/main-app-9f8e7d.js': `document.documentElement.dataset.ran='app';document.getElementById('ran').textContent='the original\\'s app script ran';`,
  '_next/static/chunks/framework-1122aa.js': `document.documentElement.dataset.ran='pages';document.getElementById('ran').textContent='the original\\'s pages script ran';`,
  '_next/static/media/logo.77aa.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="rgb(255,210,0)"/></svg>',
  'images/photo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="120" height="80" fill="rgb(200,80,40)"/></svg>',
};
const ROUTES = ['/', '/about/'];

let root;
let copyDir;
let outDir;
let original;
let built;
let dev;
let devLog = '';
let browser;

const nextFiles = () => Object.keys(FILES).filter((f) => f.startsWith('_next/')).concat('_next/static/media/brand-s.p.4f2a.woff2');
const exportFile = (route) => path.join(outDir, EXPORT_DIR, route === '/' ? 'index.html' : `${route.replace(/^\/|\/$/g, '')}/index.html`);

async function waitForDev(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (dev.exitCode !== null) throw new Error(`npm run dev stopped: ${devLog.slice(-2000)}`);
    if (await fetch(`${DEV}/_next/static/chunks/0a1b2c3d.css`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`npm run dev did not answer: ${devLog.slice(-2000)}`);
}

before(async () => {
  const tc = await toolchainStatus('next');
  if (!tc.installed) throw new Error('the next toolchain is not installed: npm run setup:toolchains -w server -- next');
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-convert-next-dev-'));
  copyDir = path.join(root, 'copy');
  const write = async (rel, body) => {
    await mkdir(path.dirname(path.join(copyDir, rel)), { recursive: true });
    await writeFile(path.join(copyDir, rel), body);
  };
  await write('index.html', HOME);
  await write('about/index.html', ABOUT);
  for (const [rel, body] of Object.entries(FILES)) await write(rel, body);
  await mkdir(path.join(copyDir, '_next/static/media'), { recursive: true });
  await cp(path.join(FONTS, 'mono.woff2'), path.join(copyDir, '_next/static/media/brand-s.p.4f2a.woff2'));

  outDir = path.join(root, 'nextjs');
  const pages = [{ outPath: 'index.html', url: 'https://next-built.example/' }, { outPath: 'about/index.html', url: 'https://next-built.example/about/' }];
  await convertToNext({ copyDir, outDir, pages, pageUrl: 'https://next-built.example/' });
  await buildConverted(outDir, { timeoutMs: 6 * 60000 });
  original = await serveCopy(copyDir);
  built = await serveCopy(path.join(outDir, EXPORT_DIR));

  // `npm run dev` as a person runs it, with the toolchain's node_modules linked in (removed again after).
  await symlink(path.join(toolchainDir('next'), 'node_modules'), path.join(outDir, 'node_modules'), 'junction');
  dev = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: outDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(DEV_PORT), HOST: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' },
  });
  dev.stdout.on('data', (d) => { devLog = (devLog + d).slice(-20000); });
  dev.stderr.on('data', (d) => { devLog = (devLog + d).slice(-20000); });
  await waitForDev(3 * 60000);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  if (dev && dev.exitCode === null) {
    const gone = new Promise((r) => dev.once('exit', r));
    // The dev server starts workers of its own: end the whole tree.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { windowsHide: true });
    else dev.kill();
    await gone;
  }
  await original?.close?.();
  await built?.close?.();
  if (outDir) await rmdir(path.join(outDir, 'node_modules')).catch(() => unlink(path.join(outDir, 'node_modules'))).catch(() => {});
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

test('the original\'s /_next/ files answer in development and in the build, byte for byte, with their types', { timeout: 5 * 60000 }, async () => {
  for (const rel of [...nextFiles(), 'images/photo.svg']) {
    const want = await readFile(path.join(copyDir, rel));
    for (const [side, base] of [['dev', DEV], ['build', built.url.replace(/\/$/, '')]]) {
      const r = await fetch(`${base}/${rel}`);
      assert.equal(r.status, 200, `${side} /${rel}`);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(want), `${side} /${rel}: the original's bytes`);
      const type = r.headers.get('content-type') ?? '';
      if (rel.endsWith('.css')) assert.match(type, /text\/css/, `${side} /${rel}`);
      if (rel.endsWith('.js')) assert.match(type, /javascript/, `${side} /${rel}`);
    }
  }
});

test('npm run dev serves every page exactly as npm run build ships it: the original\'s Next.js markers kept, Next\'s own gone', { timeout: 5 * 60000 }, async () => {
  for (const route of ROUTES) {
    const shipped = await readFile(exportFile(route), 'utf8');
    const r = await fetch(`${DEV}${route}`);
    assert.equal(r.status, 200, route);
    const served = await r.text();
    assert.equal(served, shipped, `${route}: the page in development differs from the build`);
    assert.ok(!/data-next-hide-fouc|react-refresh|_buildManifest|"buildId":"development"|\/_next\/static\/chunks\/webpack\.js/.test(served), `${route}: no development runtime`);
  }
  const about = await readFile(exportFile('/about/'), 'utf8');
  // The original's own tags that look like Next's stay, once each, where the original has them.
  for (const tag of ['<meta charSet="utf-8" data-next-head=""/>', '<meta name="viewport" content="width=device-width" data-next-head=""/>', '<noscript data-n-css=""></noscript>', '<div id="__next">', '<script id="__NEXT_DATA__" type="application/json">']) {
    assert.equal(about.split(tag).length - 1, 1, `/about/: ${tag} once, as in the original`);
  }
  const home = await readFile(exportFile('/'), 'utf8');
  assert.equal(home.split('self.__next_f').length, HOME.split('self.__next_f').length, '/: the original\'s inline scripts kept');
  // A page the project does not have: 404 in development as in the build; an address without its slash is sent to it.
  assert.equal((await fetch(`${DEV}/no-such-page/`)).status, 404);
  const moved = await fetch(`${DEV}/about`, { redirect: 'manual' });
  assert.ok([301, 308].includes(moved.status) && /\/about\/$/.test(moved.headers.get('location') ?? ''), `/about: ${moved.status}`);
});

test('in a browser: development, build and original have the same DOM, styles and running scripts, and the same pixels', { timeout: 10 * 60000 }, async () => {
  const sides = { original: original.url.replace(/\/$/, ''), build: built.url.replace(/\/$/, ''), dev: DEV };
  for (const route of ROUTES) {
    // Scripts off: the DOM as sent.
    const off = await browser.newContext({ javaScriptEnabled: false });
    const signatures = {};
    try {
      const page = await off.newPage();
      for (const [side, base] of Object.entries(sides)) {
        await page.goto(`${base}${route}`, { waitUntil: 'load' });
        // The signature writes every address in full: the three servers' origins are read as one.
        signatures[side] = (await page.evaluate(domSignature, null)).map((l) => l.split(base).join('{origin}'));
      }
    } finally {
      await off.close();
    }
    assert.equal(firstDifference(signatures.original, signatures.build), null, `${route}: build vs original ${JSON.stringify(firstDifference(signatures.original, signatures.build))}`);
    assert.equal(firstDifference(signatures.build, signatures.dev), null, `${route}: dev vs build ${JSON.stringify(firstDifference(signatures.build, signatures.dev))}`);

    // Scripts on: styled by the original's stylesheet, its font loaded, its script run; then the pixels.
    const on = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const seen = {};
    try {
      const page = await on.newPage();
      for (const [side, base] of Object.entries(sides)) {
        const failed = [];
        page.removeAllListeners('requestfailed');
        page.on('requestfailed', (req) => failed.push(req.url()));
        const answers = [];
        page.removeAllListeners('response');
        page.on('response', (res) => { if (res.status() >= 400) answers.push(`${res.status()} ${res.url()}`); });
        await page.goto(`${base}${route}`, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        seen[side] = await page.evaluate(() => ({
          bg: getComputedStyle(document.body).backgroundColor,
          header: getComputedStyle(document.querySelector('.site-header')).backgroundColor,
          h1: getComputedStyle(document.querySelector('h1')).fontSize,
          ran: document.documentElement.dataset.ran ?? null,
          text: document.getElementById('ran').textContent,
          font: document.fonts.check('16px Brand'),
          logo: document.querySelector('.logo img').naturalWidth > 0,
        }));
        seen[side].shot = await page.screenshot({ fullPage: true });
        assert.deepEqual([failed, answers], [[], []], `${route} (${side}): every request answered`);
      }
    } finally {
      await on.close();
    }
    const facts = (s) => { const { shot, ...rest } = s; return rest; };
    assert.notEqual(seen.original.bg, 'rgba(0, 0, 0, 0)', `${route}: the original is styled`);
    assert.ok(seen.original.ran && seen.original.logo, `${route}: the original's script ran and its image drew`);
    if (route === '/') assert.equal(seen.original.font, true, '/: the original\'s font loaded');
    assert.deepEqual(facts(seen.build), facts(seen.original), `${route}: build vs original`);
    assert.deepEqual(facts(seen.dev), facts(seen.original), `${route}: dev vs original`);
    const raw = async (png) => sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const [o, b, d] = await Promise.all([seen.original.shot, seen.build.shot, seen.dev.shot].map(raw));
    assert.deepEqual([b.info.width, b.info.height], [o.info.width, o.info.height], `${route}: build has the original's size`);
    assert.ok(b.data.equals(o.data), `${route}: build pixels equal the original's`);
    assert.ok(d.data.equals(b.data), `${route}: dev pixels equal the build's`);
  }
});
