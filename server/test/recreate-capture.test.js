// Recreate 4a.2: page discovery and the Playwright capture, against the local recreate fixture site only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { capturePage } from '../src/recreate/capture/index.js';
import { discoverPages, outPathFor, selectPages, skipReason, slugFor } from '../src/recreate/discover.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { userPolicy, withNetPolicy } from '../src/security/netGuard.js';
import { pageKey } from '../src/audit/util.js';
import { startFixtureServer } from './serve-fixture.js';

// The fixture runs on localhost, which the SSRF guard blocks unless this dev flag is set.
process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4198;
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

test('output paths keep the original URLs', () => {
  assert.equal(outPathFor('/'), 'index.html');
  assert.equal(outPathFor('/about.html'), 'about.html');
  assert.equal(outPathFor('/About'), 'about/index.html');
  assert.equal(outPathFor('/services/'), 'services/index.html');
  assert.equal(outPathFor('/blog/Hello%20World.htm'), 'blog/hello-world.html');
  assert.equal(outPathFor('/../x'), 'page/x/index.html');
  assert.equal(slugFor('index.html'), 'index');
  assert.equal(slugFor('services/index.html'), 'services');
  assert.equal(slugFor('blog/first-post.html'), 'blog__first-post');
  // A long address is cut and keeps a hash (Windows: capture files under a long folder could not be written).
  const long = slugFor('media/news/panscience-innovations-partners-with-bits-law-school-to-launch-palette-centre/index.html');
  assert.ok(long.length <= 48, long);
  assert.match(long, /^media__news__panscience-innovations-par.*-[0-9a-f]{8}$/);
  assert.notEqual(long, slugFor('media/news/panscience-innovations-partners-with-bits-law-school-to-launch-palette-centre-2/index.html'));
});

test('backend pages, query URLs and files are not recreated', () => {
  assert.equal(skipReason(`${origin}/login.html`, origin), 'backend');
  assert.equal(skipReason(`${origin}/shop/cart/`, origin), 'backend');
  assert.equal(skipReason(`${origin}/wp-admin/`, origin), 'backend');
  assert.equal(skipReason(`${origin}/?ref=x`, origin), 'query');
  assert.equal(skipReason(`${origin}/a.pdf`, origin), 'not-html');
  assert.equal(skipReason('https://example.org/', origin), 'external');
  assert.equal(skipReason(`${origin}/cartography`, origin), null);
});

test('selection: homepage links first, then sitemap, limit respected, duplicates merged', () => {
  const page = (p, links = []) => ({
    url: `${origin}${p}`,
    status: 200,
    depth: 1,
    facts: { title: p, links: links.map((l) => ({ href: `${origin}${l}`, internal: true })) },
  });
  const pages = [page('/', ['/b', '/a', '/b#top']), page('/a'), page('/b'), page('/c'), { url: `${origin}/gone`, status: 404, facts: null }];
  const result = selectPages({
    pages,
    homeUrl: `${origin}/`,
    sitemapUrls: [`${origin}/c`, `${origin}/gone`, `${origin}/d`],
    robots: { isAllowed: () => true },
    limit: 2,
  });
  assert.deepEqual(result.pages.map((p) => [p.path, p.source]), [['/', 'home'], ['/b', 'home-link'], ['/a', 'home-link']]);
  assert.deepEqual(result.beyondLimit.map((p) => new URL(p.url).pathname), ['/c', '/d']);
  assert.deepEqual(result.skipped.map((s) => [new URL(s.url).pathname, s.reason]), [['/gone', 'error']]);
});

test('selection: www. and bare host, http and https, trailing slash are one page (found on a site that links both forms)', () => {
  assert.equal(pageKey('https://www.example.com/about/'), pageKey('http://example.com/about'));
  assert.equal(pageKey('https://WWW.Example.com/#top'), pageKey('https://example.com/'));
  assert.notEqual(pageKey('https://example.com/about'), pageKey('https://example.com/about?x=1'));
  assert.notEqual(pageKey('https://example.com/about'), pageKey('https://blog.example.com/about'));
  const page = (url, links = []) => ({ url, status: 200, depth: 1, facts: { title: url, links: links.map((href) => ({ href, internal: true })) } });
  const pages = [
    page('https://example.com/', ['https://www.example.com/', 'https://www.example.com/about', 'https://example.com/about/', 'https://example.com/contact']),
    page('https://example.com/about'),
    page('https://www.example.com/about'),
    page('https://www.example.com/contact'),
  ];
  const result = selectPages({ pages, homeUrl: 'https://example.com/', sitemapUrls: ['https://www.example.com/contact', 'http://example.com/team'], robots: { isAllowed: () => true }, limit: 300 });
  assert.deepEqual(result.pages.map((p) => p.outPath), ['index.html', 'about/index.html', 'contact/index.html']);
  assert.deepEqual(result.beyondLimit.map((p) => p.url), ['http://example.com/team']);
});

test('discovery on the fixture: nav pages first, skips with reasons, the rest link to the live site', async () => {
  const result = await withNetPolicy(userPolicy(), () => discoverPages({ url: `${origin}/`, limit: 3 }));
  assert.deepEqual(result.pages.map((p) => p.path), ['/', '/about.html', '/services/', '/contact.html']);
  assert.deepEqual(result.pages.map((p) => p.outPath), ['index.html', 'about.html', 'services/index.html', 'contact.html']);
  const skipped = Object.fromEntries(result.skipped.map((s) => [new URL(s.url).pathname + new URL(s.url).search, s.reason]));
  assert.deepEqual(skipped, {
    '/login.html': 'backend',
    '/cart': 'backend',
    '/?ref=footer': 'query',
    '/brochure.pdf': 'not-html',
    '/private/secret.html': 'robots',
    '/old-work.html': 'error', // the broken link on /work.html (a 4a.5 fixer seed)
  });
  assert.deepEqual(result.beyondLimit.map((p) => new URL(p.url).pathname).sort(), ['/blog/first-post.html', '/blog/second-post.html', '/team.html', '/work.html']);
  assert.equal(result.sitemap.status, 'found');
});

test('discovery refuses a blocked homepage without the dev flag', async () => {
  delete process.env.SAS_ALLOW_LOCALHOST;
  try {
    await assert.rejects(withNetPolicy(userPolicy(), () => discoverPages({ url: `${origin}/`, limit: 1 })), /loopback/);
  } finally {
    process.env.SAS_ALLOW_LOCALHOST = '1';
  }
});

test('near its time limit the inspect step keeps the pages captured so far instead of failing', async () => {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'fixture', ?, 'html', 1, 1, ?, ?)`)
    .run(id, `${origin}/`, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const stubs = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));
  // The step has (almost) no time left: the homepage is still captured, the other page is not.
  const inspect = (ctx) => {
    ctx.stepDeadline = Date.now() + 1000;
    return STAGES.inspect(ctx);
  };
  const report = await runRecreate({ project, recreateId: randomUUID(), progress: () => {}, stages: { ...stubs, inspect } });
  assert.deepEqual(report.pages.map((p) => p.path), ['/']);
  assert.ok(report.discovery.linksToLive.some((l) => l.url === `${origin}/about.html` && l.reason === 'time-limit'));
  assert.match(report.warnings.join('\n'), /1 page was not captured within the time limit of the inspect step \(\/about\.html\); links to it open a notice page in the new site/);
});

test('a page that stalls is abandoned before the step limit: the pages captured so far are kept, the job does not fail', async () => {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'fixture', ?, 'html', 1, 1, ?, ?)`)
    .run(id, `${origin}/`, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const stubs = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));
  // The second page never finishes. Without the page limit the step would run into its own limit and fail the whole job.
  const inspect = (ctx) => {
    ctx.stepDeadline = Date.now() + 24000;
    ctx.capturePage = (browser, info, ...rest) => (info.path === '/about.html' ? new Promise(() => {}) : capturePage(browser, info, ...rest));
    return STAGES.inspect(ctx);
  };
  const started = Date.now();
  const report = await runRecreate({ project, recreateId: randomUUID(), progress: () => {}, stages: { ...stubs, inspect } });
  assert.ok(Date.now() - started < 30000, 'abandoned before the step limit');
  assert.deepEqual(report.pages.map((p) => p.path), ['/']);
  assert.ok(report.discovery.linksToLive.some((l) => l.url === `${origin}/about.html` && l.reason === 'time-limit'));
  assert.match(report.warnings.join('\n'), /1 page was not captured within the time limit of the inspect step \(\/about\.html\)/);
});

test('the inspect step captures every selected page at desktop, laptop, tablet and mobile', async () => {
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

  const report = await runRecreate({ project, recreateId, progress: () => {}, stages: { ...stubs, inspect: STAGES.inspect } });
  assert.deepEqual(report.pages.map((p) => [p.path, p.views]), [
    ['/', ['desktop', 'laptop', 'tablet', 'mobile']],
    ['/about.html', ['desktop', 'laptop', 'tablet', 'mobile']],
  ]);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.manual.map((m) => m.title), ['/login.html was not recreated', '/cart was not recreated']);
  assert.ok(report.discovery.linksToLive.some((l) => l.url === `${origin}/services/`));

  const dir = path.join(recreateDir(id, recreateId), 'capture');
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.pages.length, 2);
  for (const file of ['desktop.json', 'laptop.json', 'tablet.json', 'mobile.json', 'desktop-fold.webp', 'mobile-full.webp']) {
    assert.ok(await exists(path.join(dir, 'index', file)), file);
  }
  assert.ok(await exists(path.join(dir, 'about', 'desktop.json')));

  // Hover / focus capture (4b.1): motion.json for the desktop view, the nav link hover found, counts in the report.
  const motion = JSON.parse(await readFile(path.join(dir, 'index', 'motion.json'), 'utf8'));
  const navLink = motion.hover.find((h) => /About/i.test(h.text));
  assert.ok(navLink, JSON.stringify(motion.hover.map((h) => h.text)));
  assert.equal(navLink.changes.color[1], 'rgb(180, 83, 9)');
  assert.ok(motion.rules.some((r) => /nav a:hover/.test(r.selector)));
  // The seeded script-only hover (fixtures/recreate-site/hover.js) has no :hover rule: only the probe finds it.
  const logo = motion.hover.find((h) => h.tag === 'a' && /Recreate Co/.test(h.text));
  assert.equal(logo.changes['letter-spacing'][1], '2px');
  assert.ok(!motion.rules.some((r) => /logo/.test(r.selector)));
  assert.equal(report.motion.status, 'captured');
  assert.equal(report.motion.pages, 2);
  assert.ok(report.motion.hover >= 2 && report.motion.rules >= 2);
  assert.equal(report.pages[0].motion.hover, motion.hover.length);
  assert.ok(!(await exists(path.join(dir, 'index', 'laptop-motion.json'))), 'only the desktop view is probed');

  const load = async (view) => JSON.parse(await readFile(path.join(dir, 'index', `${view}.json`), 'utf8'));
  const [desktop, mobile] = [await load('desktop'), await load('mobile')];
  const find = (node, fn) => {
    if (fn(node)) return node;
    for (const c of node.children ?? []) {
      const hit = c.tag && find(c, fn);
      if (hit) return hit;
    }
    return null;
  };
  const byClass = (snap, c) => find(snap.body, (n) => (n.attrs?.class ?? '').split(' ').includes(c));

  // Head, design tokens, breakpoints and structured data.
  assert.equal(desktop.head.title, 'Recreate Co — fixture for page discovery and capture');
  assert.equal(desktop.head.lang, 'en');
  assert.deepEqual(desktop.customProps, { '--brand': '#0f766e', '--ink': '#1e293b', '--radius': '12px' });
  assert.deepEqual(desktop.mediaQueries, ['(max-width: 1024px)', '(max-width: 600px)']);
  assert.equal(desktop.head.jsonLd.length, 1);

  // Computed styles differ per breakpoint; the mobile menu swap is visible.
  assert.equal(byClass(desktop, 'features').style['grid-template-columns'].split(' ').length, 3);
  assert.equal(byClass(mobile, 'features').style['grid-template-columns'].split(' ').length, 1);
  assert.equal(find(desktop.body, (n) => n.tag === 'nav').hidden, undefined);
  assert.equal(find(mobile.body, (n) => n.tag === 'nav').hidden, true);
  assert.equal(byClass(mobile, 'menu-button').style.display, 'block');
  // Style diffs stay small: currentColor defaults are not repeated.
  assert.equal(byClass(desktop, 'site-header').style['border-top-color'], undefined);
  assert.equal(byClass(desktop, 'site-header').style['border-bottom-color'], 'rgb(226, 232, 240)');

  // Pseudo-elements, inline SVG, the lazy image (loaded by scrolling) and CSS background URLs.
  assert.equal(byClass(desktop, 'cta').after.content, '"→"');
  assert.equal(byClass(desktop, 'feature').before.style.height, '4px');
  assert.match(find(desktop.body, (n) => n.tag === 'svg').svg, /^<svg[^>]*viewBox="0 0 24 24"/);
  const img = find(desktop.body, (n) => n.tag === 'img');
  assert.equal(img.src, `${origin}/img/photo.svg`);
  assert.deepEqual(img.lazy, { 'data-src': '/img/photo.svg' });
  assert.deepEqual(desktop.cssUrls, [`${origin}/img/hero-bg.svg`]);
  const resources = desktop.resources.map((r) => `${r.type} ${new URL(r.url).pathname}`).sort();
  assert.deepEqual(resources, ['document /', 'image /img/hero-bg.svg', 'image /img/photo.svg', 'script /hover.js', 'script /lazy.js', 'stylesheet /styles.css']);
  assert.deepEqual(desktop.screenshots.fold.width, 1440);
  assert.deepEqual(mobile.screenshots.fold.width, 750); // DPR 2
});
