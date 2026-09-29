// Recreate 4a.3: asset collection and download, against the local recreate fixture site only.
// Its /cdn/ paths, requested as http://127.0.0.1:<port>, stand in for a platform CDN.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { ASSET_BUDGET, ASSET_LIMITS, assetsStage, downloadAssets } from '../src/recreate/assets/index.js';
import { findPlatformCdnRefs, PLATFORM_CDN_HOSTS, platformCdnHost } from '../src/recreate/assets/cdn.js';
import { assetKey, collectAssets, pickCandidates } from '../src/recreate/assets/collect.js';
import { parseSrcset, parseStylesheet } from '../src/recreate/assets/css.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { userPolicy, withNetPolicy } from '../src/security/netGuard.js';
import { startFixtureServer } from './serve-fixture.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4197;
const origin = `http://localhost:${PORT}`;
const cdn = `http://127.0.0.1:${PORT}/cdn`;
let server;
const projectIds = [];
const tmpDirs = [];

before(async () => {
  server = await startFixtureServer(PORT, { site: 'recreate' });
});
after(async () => {
  server.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

const tempRoot = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-assets-'));
  tmpDirs.push(dir);
  return dir;
};

test('srcset parsing keeps commas inside URLs', () => {
  const base = 'https://example.com/page/';
  assert.deepEqual(parseSrcset('a.jpg 1x, /b.jpg 2x', base), [
    { url: 'https://example.com/page/a.jpg', descriptor: '1x' },
    { url: 'https://example.com/b.jpg', descriptor: '2x' },
  ]);
  assert.deepEqual(
    parseSrcset('https://img.cdn.test/w_400,h_300/p.jpg 400w,https://img.cdn.test/w_800,h_600/p.jpg 800w', base).map((c) => c.url),
    ['https://img.cdn.test/w_400,h_300/p.jpg', 'https://img.cdn.test/w_800,h_600/p.jpg'],
  );
  assert.deepEqual(parseSrcset('data:image/png;base64,AAAA 1x, c.png', base).map((c) => c.url), ['https://example.com/page/c.png']);
  assert.deepEqual(parseSrcset('', base), []);
});

test('stylesheet parsing: @font-face, @keyframes, @import and other url() references', () => {
  const css = `
    /* url(commented.png) */
    @import url("more.css");
    @import 'print.css' print;
    @font-face { font-family: 'Inter Var'; font-weight: 100 900; src: url(data:font/woff2;base64,AA==) format("woff2"),
      url(../fonts/inter.woff2) format("woff2-variations"), local("Inter"); unicode-range: U+0000-00FF; }
    @media (min-width: 600px) { @keyframes spin { to { transform: rotate(360deg); } } }
    .hero { background: url('/img/hero.jpg'); mask: url(#m); }
  `;
  const parsed = parseStylesheet(css, 'https://cdn.test/css/site.css');
  assert.deepEqual(parsed.fontFaces, [
    {
      family: 'Inter Var',
      weight: '100 900',
      style: 'normal',
      display: null,
      unicodeRange: 'U+0000-00FF',
      src: [{ url: 'https://cdn.test/fonts/inter.woff2', format: 'woff2-variations' }],
    },
  ]);
  assert.deepEqual(parsed.keyframes.map((k) => k.name), ['spin']);
  assert.match(parsed.keyframes[0].css, /^@keyframes spin \{.*rotate\(360deg\).*\}$/s);
  assert.deepEqual(parsed.imports, ['https://cdn.test/css/more.css', 'https://cdn.test/css/print.css']);
  assert.deepEqual(parsed.urls, ['https://cdn.test/img/hero.jpg']);
});

test('platform CDN hosts come from the detection rules', () => {
  for (const host of ['framerusercontent.com', 'wixstatic.com', 'cdn.shopify.com', 'squarespace-cdn.com']) assert.ok(PLATFORM_CDN_HOSTS.includes(host), host);
  assert.equal(platformCdnHost('https://framerusercontent.com/images/a.png'), 'framerusercontent.com');
  assert.equal(platformCdnHost('https://static.wixstatic.com/media/x.jpg'), 'wixstatic.com');
  assert.equal(platformCdnHost('https://notwixstatic.com/x.jpg'), null);
  assert.equal(platformCdnHost('https://example.com/a.png'), null);
  const html = `<img src="https://framerusercontent.com/images/a.png?scale-down-to=512"><div style="background:url(//static.wixstatic.com/media/b.jpg)">
    <a href="https://example.com/">ok</a> url("/assets/images/a.png")`;
  assert.deepEqual(findPlatformCdnRefs(html), ['https://framerusercontent.com/images/a.png?scale-down-to=512', 'https://static.wixstatic.com/media/b.jpg']);
  assert.deepEqual(findPlatformCdnRefs('<img src="assets/images/a-1234.png">'), []);
});

test('collection: one entry per URL, kinds, download order and used fonts only', () => {
  const page = 'https://site.test/';
  const capture = (view, extra = {}) => ({
    slug: 'index',
    view,
    data: {
      url: page,
      head: {
        links: [{ rel: 'icon', href: 'https://site.test/favicon.svg' }, { rel: 'stylesheet', href: 'https://site.test/a.css' }],
        meta: [{ property: 'og:image', content: '/og.png' }],
      },
      body: {
        tag: 'body',
        children: [
          { tag: 'img', src: 'https://cdn.test/a.jpg?w=800', attrs: { src: 'https://cdn.test/a.jpg?w=400', srcset: 'https://cdn.test/a.jpg?w=400 400w, https://cdn.test/a.jpg?w=800 800w' } },
          { tag: 'img', attrs: { alt: '' }, lazy: { 'data-src': '/lazy.png', 'data-srcset': '/lazy@2x.png 2x' } },
          { tag: 'picture', children: [{ tag: 'source', attrs: { srcset: '/p.avif' } }] },
          { tag: 'video', src: 'https://cdn.test/v.mp4', poster: 'https://cdn.test/poster.jpg', children: [{ tag: 'source', src: 'https://cdn.test/v.webm' }] },
          { tag: 'svg', svg: '<svg><use href="/sprite.svg#icon"></use><use href="#local"></use><image xlink:href="data:image/png;base64,AA"/></svg>' },
          { tag: 'span', after: { content: 'url("/arrow.svg")' } },
          { tag: 'input', attrs: { type: 'text', src: '/nope.png' } },
          { tag: 'iframe', src: 'https://www.youtube.com/embed/x' },
        ],
      },
      cssUrls: ['https://site.test/favicon.svg', 'https://cdn.test/bg.jpg#frag'],
      resources: [
        { url: 'https://cdn.test/bg.jpg', type: 'image', status: 200 },
        { url: 'https://fonts.test/used-latin.woff2', type: 'font', status: 200 },
        { url: 'https://site.test/app.js', type: 'script', status: 200 },
      ],
      loadedFonts: [{ family: 'Used Sans' }],
      fontFaces: [
        { family: 'Used Sans', weight: '400', style: 'normal', unicodeRange: 'latin', src: [{ url: 'https://fonts.test/used-latin.woff2', format: 'woff2' }] },
        { family: 'Used Sans', weight: '400', style: 'normal', unicodeRange: 'cyrillic', src: [{ url: 'https://fonts.test/used-cyr.ttf', format: 'truetype' }, { url: 'https://fonts.test/used-cyr.woff2', format: 'woff2' }] },
        { family: 'Unused Serif', weight: '400', style: 'normal', unicodeRange: null, src: [{ url: 'https://fonts.test/unused.woff2', format: 'woff2' }] },
      ],
      ...extra,
    },
  });
  const { assets, fontFaces, unusedFontFaces } = collectAssets([capture('desktop'), capture('mobile')]);
  const kinds = Object.fromEntries(assets.map((a) => [a.url, a.kind]));
  assert.deepEqual(kinds, {
    'https://fonts.test/used-latin.woff2': 'font',
    'https://fonts.test/used-cyr.woff2': 'font', // the unused subset falls back to its best format only
    'https://site.test/og.png': 'image',
    'https://site.test/favicon.svg': 'image', // icon and CSS background: the larger limit wins
    'https://cdn.test/a.jpg?w=800': 'image',
    'https://site.test/lazy.png': 'image',
    'https://site.test/lazy@2x.png': 'image',
    'https://site.test/p.avif': 'image',
    'https://cdn.test/poster.jpg': 'image',
    'https://site.test/sprite.svg': 'image',
    'https://site.test/arrow.svg': 'image',
    'https://cdn.test/bg.jpg': 'image',
    'https://cdn.test/v.mp4': 'media',
    'https://cdn.test/v.webm': 'media',
  });
  assert.deepEqual([...new Set(assets.map((a) => a.kind))], ['font', 'image', 'media']);
  assert.deepEqual(fontFaces.map((f) => f.unicodeRange), ['latin', 'cyrillic']);
  assert.equal(unusedFontFaces, 1);
  assert.equal(assetKey('https://a.test/x.png#y'), 'https://a.test/x.png');
  assert.equal(assetKey('javascript:alert(1)'), null);
});

test('collection: same-origin font sources captured as bare URL strings (before 4a.7) still map to files', () => {
  const data = {
    url: 'https://site.test/',
    head: { links: [], meta: [] },
    body: { tag: 'body', children: [] },
    resources: [{ url: 'https://site.test/f.woff2', type: 'font', status: 200 }],
    loadedFonts: [{ family: 'Inline Sans' }],
    fontFaces: [{ family: 'Inline Sans', weight: '400', style: 'normal', unicodeRange: null, src: ['https://site.test/f.woff2', 'https://site.test/f.ttf'] }],
  };
  const { assets, fontFaces } = collectAssets([{ slug: 'index', view: 'desktop', data }]);
  assert.deepEqual(fontFaces[0].src, [{ url: 'https://site.test/f.woff2', format: null }, { url: 'https://site.test/f.ttf', format: null }]);
  assert.deepEqual(assets.filter((a) => a.kind === 'font').map((a) => a.url), ['https://site.test/f.woff2']);
});

test('srcset: only the candidate each view needs is downloaded', () => {
  const c = (w) => ({ url: `https://cdn.test/i.jpg?w=${w}`, descriptor: `${w}w` });
  const set = [16, 32, 64, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840].map(c);
  // The browser showed one of them (currentSrc): nothing more is needed for this view.
  assert.deepEqual(pickCandidates(set, { src: 'https://cdn.test/i.jpg?w=828', rect: [0, 0, 391, 230] }, 2), []);
  // Not loaded (lazy): the smallest that covers the rendered width at the pixel density.
  assert.deepEqual(pickCandidates(set, { rect: [0, 0, 391, 230] }, 2), [c(828)]);
  assert.deepEqual(pickCandidates(set, { rect: [0, 0, 391, 230] }, 1), [c(640)]);
  assert.deepEqual(pickCandidates(set, { rect: [0, 0, 5000, 10] }, 1), [c(3840)]); // none is wide enough
  // Density descriptors; and a candidate list without descriptors takes the first.
  const x = [{ url: 'https://s.test/a.png', descriptor: '1x' }, { url: 'https://s.test/a@2x.png', descriptor: '2x' }];
  assert.deepEqual(pickCandidates(x, { rect: [0, 0, 100, 100] }, 2), [x[1]]);
  assert.deepEqual(pickCandidates([{ url: 'https://s.test/b.png', descriptor: '' }], { rect: [0, 0, 10, 10] }, 1), [{ url: 'https://s.test/b.png', descriptor: '' }]);
});

test('downloads: dedupe, redirects, size and time limits, SSRF on every hop', async () => {
  const root = await tempRoot();
  const list = [
    ['img/team.png?w=400', 'image'],
    ['img/team.png?w=800', 'image'],
    ['r/img/photo.svg', 'image'],
    ['fonts/mono.woff2', 'font'],
    ['img/missing.png', 'image'],
    ['big.mp4', 'media'],
    ['stream.mp4', 'media'],
    ['slow.png', 'image'],
    ['redirect-private', 'image'],
    ['redirect-api', 'image'],
    ['loop', 'image'],
    ['html.png', 'image'],
    ['html-as-png.png', 'image'],
  ].map(([p, kind]) => ({ url: `${cdn}/${p}`, kind }));

  const limits = { ...ASSET_LIMITS, image: { maxBytes: 1024 * 1024, timeout: 1000 }, media: { maxBytes: 1024 * 1024, timeout: 5000 } };
  const result = await withNetPolicy(userPolicy(), () => downloadAssets(list, root, { limits }));

  const reasons = Object.fromEntries(result.skipped.map((s) => [s.url.replace(`${cdn}/`, ''), s.reason]));
  assert.deepEqual(reasons, {
    'img/missing.png': 'http-404',
    'big.mp4': 'too-large',
    'stream.mp4': 'too-large',
    'slow.png': 'timeout',
    'redirect-private': 'blocked',
    'redirect-api': 'blocked',
    loop: 'too-many-redirects',
    'html.png': 'not-an-asset',
    'html-as-png.png': 'not-an-asset',
  });
  assert.match(result.skipped.find((s) => s.url.endsWith('redirect-private')).detail, /private address/);
  assert.match(result.skipped.find((s) => s.url.endsWith('big.mp4')).detail, /media: 1 MB/);

  // One file per content: both team.png URLs share it.
  assert.equal(result.files.length, 3);
  assert.equal(result.reused, 1);
  const team = result.map[`${cdn}/img/team.png?w=400`];
  assert.match(team, /^images\/team-[0-9a-f]{10}\.png$/);
  assert.equal(result.map[`${cdn}/img/team.png?w=800`], team);
  // The redirect target is mapped too.
  assert.match(result.map[`${cdn}/r/img/photo.svg`], /^images\/photo-[0-9a-f]{10}\.svg$/);
  assert.equal(result.map[`${cdn}/img/photo.svg`], result.map[`${cdn}/r/img/photo.svg`]);
  assert.match(result.map[`${cdn}/fonts/mono.woff2`], /^fonts\/mono-[0-9a-f]{10}\.woff2$/);
  assert.equal((await stat(path.join(root, result.map[`${cdn}/fonts/mono.woff2`]))).size, 21168);

  // No partial downloads are left behind.
  const all = (await readdir(root, { recursive: true })).map((f) => f.replaceAll('\\', '/'));
  assert.deepEqual(all.filter((f) => f.includes('.part-')), []);
  assert.deepEqual(all.filter((f) => /\.\w+$/.test(f)).sort(), Object.values(result.map).filter((v, i, a) => a.indexOf(v) === i).sort());
});

test('downloads: the count budget and the step deadline', async () => {
  const root = await tempRoot();
  const list = ['img/team.png', 'img/photo.svg', 'img/hero-bg.svg'].map((p) => ({ url: `${cdn}/${p}`, kind: 'image' }));
  const budgeted = await withNetPolicy(userPolicy(), () => downloadAssets(list, root, { budget: { ...ASSET_BUDGET, maxAssets: 1, concurrency: 1 } }));
  assert.equal(budgeted.files.length, 1);
  assert.deepEqual(budgeted.skipped.map((s) => s.reason), ['budget', 'budget']);

  const late = await withNetPolicy(userPolicy(), () => downloadAssets(list, root, { deadline: Date.now() + 5000 }));
  assert.equal(late.files.length, 0);
  assert.deepEqual(late.skipped.map((s) => s.reason), ['time-limit', 'time-limit', 'time-limit']);
});

test('downloads are blocked for loopback without the dev flag', async () => {
  delete process.env.SAS_ALLOW_LOCALHOST;
  try {
    const root = await tempRoot();
    const result = await withNetPolicy(userPolicy(), () => downloadAssets([{ url: `${cdn}/img/team.png`, kind: 'image' }], root));
    assert.deepEqual(result.skipped.map((s) => s.reason), ['blocked']);
    assert.equal(result.files.length, 0);
  } finally {
    process.env.SAS_ALLOW_LOCALHOST = '1';
  }
});

test('the assets step localizes every asset of the captured pages', async () => {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'fixture', ?, 'html', 1, 1, ?, ?)`)
    .run(id, `${origin}/`, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const recreateId = randomUUID();
  const stubs = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));
  const limits = { media: { maxBytes: 1024 * 1024, timeout: 10000 } };

  const report = await runRecreate({
    project,
    recreateId,
    progress: () => {},
    stages: { ...stubs, inspect: STAGES.inspect, assets: (ctx) => assetsStage(ctx, { limits }) },
  });
  assert.deepEqual(report.pages.map((p) => p.path), ['/', '/about.html']);

  const dir = path.join(recreateDir(id, recreateId), 'assets');
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const local = (url) => manifest.map[url];

  // Home: the favicon doubles as the hero background (one file); the lazy image. About: CDN files.
  assert.ok(local(`${origin}/img/hero-bg.svg`));
  assert.ok(local(`${origin}/img/photo.svg`));
  const team = local(`${cdn}/img/team.png?w=800`);
  assert.ok(team);
  assert.equal(local(`${cdn}/img/team.png?poster`), team); // same bytes, one file
  // A srcset candidate no captured view used is not downloaded (every view showed w=800).
  assert.equal(local(`${cdn}/img/team.png?w=400`), undefined);
  assert.ok(local(`${cdn}/r/img/photo.svg`));
  assert.ok(local(`${cdn}/fonts/mono.woff2`));
  assert.equal(Object.keys(manifest.map).some((u) => u.includes('unused')), false);

  // The cross-origin stylesheet (and its @import) was read for the font and the animations.
  assert.deepEqual(manifest.sheets.map((s) => [s.url, s.status]), [[`${cdn}/brand.css`, 'read'], [`${cdn}/brand-extra.css`, 'read']]);
  assert.deepEqual(manifest.fontFaces.map((f) => [f.family, f.local, f.src.map((s) => s.file)]), [
    ['Brand Mono', true, [local(`${cdn}/fonts/mono.woff2`), null]],
  ]);
  assert.deepEqual(manifest.keyframes.map((k) => k.name).sort(), ['brand-fade', 'brand-pulse']);

  // Nothing referenced is left pointing at the original hosts: every asset URL is either local or skipped.
  assert.deepEqual(report.assets.skipped.map((s) => [s.url, s.reason]), [
    [`${cdn}/img/missing.png`, 'http-404'],
    [`${cdn}/big.mp4`, 'too-large'],
  ]);
  assert.equal(report.assets.found, Object.keys(manifest.map).length + report.assets.skippedCount);
  // Unique files only: the font, team.png (4 URLs), photo.svg (3 URLs, one via a redirect) and hero-bg.svg.
  assert.equal(report.assets.downloaded, 4);
  assert.deepEqual(Object.keys(report.assets.byKind).sort(), ['font', 'image']);
  assert.deepEqual(report.manual.filter((m) => m.kind === 'asset').map((m) => [m.title, m.url]), [
    ['Video or audio file too large to bundle', `${cdn}/big.mp4`],
  ]);
  for (const file of new Set(Object.values(manifest.map))) assert.ok((await stat(path.join(dir, file))).size > 0, file);
});
