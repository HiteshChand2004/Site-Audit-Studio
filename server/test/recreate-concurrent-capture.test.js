// Faster "Visit every page" (Recreate inspect step): several pages captured at once within a limit, discovery fetching more
// pages at once with a broader "render when in doubt" rule, URL deduplication. Fixture sites only (localhost).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { crawl } from '../src/audit/crawler.js';
import { extractPage, looksClientRendered, looksLikeShell } from '../src/audit/extract.js';
import { fetchPage } from '../src/audit/http.js';
import { crawlConcurrency, CRAWL_CONCURRENCY } from '../src/recreate/discover.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { CAPTURE_PAGES_MAX, capturePagesAtOnce, limiter, roomForAnotherPage } from '../src/recreate/inspect.js';
import { userPolicy, withNetPolicy } from '../src/security/netGuard.js';
import { startFixtureServer } from './serve-fixture.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
// No shared static-file cache in this file (it is covered by shared-cache.test.js): every inspect step here would create and
// remove a cache folder in the OS temp folder, which that file checks for while both run side by side.
process.env.SAS_SHARED_CACHE = '0';

const PORT = 4191;
const origin = `http://localhost:${PORT}`;
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

function makeProject(recreatePages = 5) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'fixture', ?, 'html', 1, ?, ?, ?)`).run(id, `${origin}/`, recreatePages, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
const stubs = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A stand-in for capturePage: no browser work, a desktop view, an optional delay per page.
const fakeView = { file: 'desktop.json', reveal: { pinned: 0 }, resources: [] };

// Runs only the inspect step with a stand-in capture; returns the report, the manifest and what the capture saw.
async function inspectWith({ pages = 5, capturePages, room, capture }) {
  const project = makeProject(pages);
  const seen = { order: [], running: 0, peak: 0 };
  let dir;
  const report = await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    stages: {
      ...stubs,
      inspect: (ctx) => {
        dir = ctx.dir;
        if (capturePages !== undefined) ctx.capturePages = capturePages;
        if (room) ctx.roomForAnotherPage = room;
        ctx.capturePage = async (_browser, info, workspace) => {
          seen.order.push(info.path);
          await mkdir(path.join(workspace, 'capture', info.slug), { recursive: true });
          seen.running++;
          seen.peak = Math.max(seen.peak, seen.running);
          try {
            return await capture(info);
          } finally {
            seen.running--;
          }
        };
        return STAGES.inspect(ctx);
      },
      // keeps the workspace (and its manifest) readable after the job
      generate: async () => {
        seen.manifest = JSON.parse(await readFile(path.join(dir, 'capture', 'manifest.json'), 'utf8'));
      },
    },
  });
  return { report, seen };
}

test('capture concurrency: SAS_CAPTURE_PAGES fixes it, SAS_MAX_PARALLEL caps it, else CPU and free memory decide', () => {
  assert.equal(capturePagesAtOnce({ env: { SAS_CAPTURE_PAGES: '1' }, cpus: 32, free: 1e6 }), 1, '1 = the old one-page-at-a-time loop');
  assert.equal(capturePagesAtOnce({ env: { SAS_CAPTURE_PAGES: '5' }, cpus: 2, free: 100 }), 5);
  assert.equal(capturePagesAtOnce({ env: { SAS_CAPTURE_PAGES: 'x', SAS_MAX_PARALLEL: '1' }, cpus: 32, free: 1e6 }), 1, 'invalid value ignored; SAS_MAX_PARALLEL=1 = one page');
  assert.equal(capturePagesAtOnce({ env: { SAS_MAX_PARALLEL: '8' }, cpus: 32, free: 1e6 }), 2, 'cap 8 contexts / 4 views');
  assert.equal(capturePagesAtOnce({ env: {}, cpus: 32, free: 1e6 }), CAPTURE_PAGES_MAX);
  assert.equal(capturePagesAtOnce({ env: {}, cpus: 4, free: 1e6 }), 1, 'a 4-thread machine stays at one page');
  assert.equal(capturePagesAtOnce({ env: {}, cpus: 8, free: 1e6 }), 2);
  assert.equal(capturePagesAtOnce({ env: {}, cpus: 32, free: 1000 }), 1, 'short of memory: one page');
  assert.equal(capturePagesAtOnce({ env: {}, cpus: 32, free: 1600 }), 2);
  assert.equal(roomForAnotherPage({ free: 500 }), false);
  assert.equal(roomForAnotherPage({ free: 4000 }), true);
});

test('discovery fetch concurrency: SAS_CRAWL_CONCURRENCY (1–16), else the default', () => {
  assert.equal(crawlConcurrency({}), CRAWL_CONCURRENCY);
  assert.ok(CRAWL_CONCURRENCY >= 6 && CRAWL_CONCURRENCY <= 10);
  assert.equal(crawlConcurrency({ SAS_CRAWL_CONCURRENCY: '3' }), 3);
  assert.equal(crawlConcurrency({ SAS_CRAWL_CONCURRENCY: '99' }), CRAWL_CONCURRENCY);
});

test('limiter runs at most the given number of tasks at once and every task finishes', async () => {
  const run = limiter(() => 2);
  let running = 0;
  let peak = 0;
  const out = await Promise.all([1, 2, 3, 4, 5].map((n) => run(async () => {
    running++;
    peak = Math.max(peak, running);
    await sleep(20);
    running--;
    return n * 10;
  })));
  assert.equal(peak, 2);
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  await assert.rejects(run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await run(async () => 'next'), 'next', 'a failed task frees its slot');
});

test('several pages are captured at once within the limit; pages and manifest keep the discovery order', async () => {
  // Later pages finish first (shorter delays), so completion order differs from discovery order.
  const delays = { '/': 250 };
  const capture = async (info) => {
    await sleep(delays[info.path] ?? 150 - Math.min(140, info.path.length * 5));
    return { views: { desktop: fakeView }, errors: [] };
  };
  const one = await inspectWith({ capturePages: 1, capture });
  const three = await inspectWith({ capturePages: 3, capture });
  assert.equal(one.seen.peak, 1, 'SAS_CAPTURE_PAGES=1: strictly one page at a time');
  assert.equal(three.seen.peak, 3, 'never more than the limit');
  assert.equal(three.report.capture.pagesAtOnce, 3);
  assert.ok(one.report.pages.length >= 4, `${one.report.pages.length} pages`);
  assert.deepEqual(three.report.pages.map((p) => p.path), one.report.pages.map((p) => p.path), 'same pages, same order');
  assert.deepEqual(three.seen.manifest.pages.map((p) => p.path), one.seen.manifest.pages.map((p) => p.path));
  assert.deepEqual(three.seen.order, one.seen.order, 'pages start in discovery order');
  assert.equal(three.report.pages[0].path, '/');
});

test('one failing page (an error thrown, or no desktop view) never stops the other pages', async () => {
  let failing;
  const capture = async (info) => {
    await sleep(30);
    if (info.path === failing[0]) throw new Error('page crashed');
    if (info.path === failing[1]) return { views: {}, errors: [{ view: 'desktop', message: 'net::ERR_ABORTED' }] };
    return { views: { desktop: fakeView }, errors: [] };
  };
  for (const capturePages of [1, 3]) {
    const probe = await inspectWith({ capturePages: 1, capture: async () => ({ views: { desktop: fakeView }, errors: [] }) });
    const all = probe.report.pages.map((p) => p.path);
    failing = [all[1], all[2]];
    const { report } = await inspectWith({ capturePages, capture });
    assert.deepEqual(report.pages.map((p) => p.path), all.filter((p) => !failing.includes(p)), `capturePages=${capturePages}`);
    assert.ok(report.errors.some((e) => e.message.includes('page crashed')));
    const live = report.discovery.linksToLive.map((l) => new URL(l.url).pathname);
    for (const p of failing) assert.ok(live.includes(p), `${p} links to a notice page`);
  }
});

test('short of memory: no second page starts while one runs', async () => {
  const capture = async () => {
    await sleep(40);
    return { views: { desktop: fakeView }, errors: [] };
  };
  const { report, seen } = await inspectWith({ capturePages: 3, room: () => false, capture });
  assert.equal(seen.peak, 1);
  assert.ok(report.capture.heldBack > 0);
  assert.ok(report.pages.length >= 4);
});

test('the homepage failing still fails the step when pages run side by side', async () => {
  const capture = async (info) => {
    await sleep(20);
    return info.path === '/' ? { views: {}, errors: [{ view: 'desktop', message: 'boom' }] } : { views: { desktop: fakeView }, errors: [] };
  };
  await assert.rejects(inspectWith({ capturePages: 3, capture }), /homepage could not be captured/);
});

test('real captures side by side give the same pages and the same capture data as one at a time', async () => {
  const real = async (capturePages) => {
    const project = makeProject(3);
    let manifest;
    let dir;
    const report = await runRecreate({
      project,
      recreateId: randomUUID(),
      progress: () => {},
      stages: {
        ...stubs,
        inspect: (ctx) => {
          dir = ctx.dir;
          ctx.capturePages = capturePages;
          return STAGES.inspect(ctx);
        },
        generate: async () => {
          manifest = JSON.parse(await readFile(path.join(dir, 'capture', 'manifest.json'), 'utf8'));
          for (const p of manifest.pages) p.desktop = JSON.parse(await readFile(path.join(dir, 'capture', p.slug, 'desktop.json'), 'utf8'));
        },
      },
    });
    return { report, manifest };
  };
  const one = await real(1);
  const two = await real(2);
  assert.deepEqual(two.report.pages.map((p) => p.path), one.report.pages.map((p) => p.path));
  assert.deepEqual(two.report.pages.map((p) => p.views), one.report.pages.map((p) => p.views));
  for (const [i, p] of one.manifest.pages.entries()) {
    const q = two.manifest.pages[i];
    assert.equal(q.desktop.nodeCount, p.desktop.nodeCount, p.path);
    assert.equal(q.desktop.scrollHeight, p.desktop.scrollHeight, p.path);
  }
});

test('discovery: plain HTML is parsed without a browser; pages that may need JavaScript are rendered', () => {
  const page = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
  const text = 'Words that make a paragraph of real content. '.repeat(20);
  const links = '<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>';
  const check = (html) => looksClientRendered(extractPage(html, 'https://example.com/'), html);
  assert.equal(check(page(`<header>${links}</header><main><p>${text}</p></main>`)), false, 'a normal server-rendered page');
  assert.equal(check(page(`<div id="__next"><header>${links}</header><main><p>${text.repeat(5)}</p></main></div>`)), false, 'SSR app with its content');
  assert.equal(check(page('<div id="root"></div>')), true, 'empty shell');
  const menuOnly = page(`<header>${links}</header><div id="app"></div>`);
  assert.equal(looksLikeShell(extractPage(menuOnly, 'https://example.com/')), false, 'the old rule missed it');
  assert.equal(check(menuOnly), true, 'menu around an empty body');
  assert.equal(check(page(`<header>${links}</header><p>${text}</p><div id="root"></div>`)), true, 'empty mount point next to some text');
  assert.equal(check(page(`<header>${links}</header><p>${text}</p><noscript>Please enable JavaScript to use this site.</noscript>`)), true);
});

test('discovery crawl: fetches several pages at once (the limit honoured) and requests each URL once whatever its form', async () => {
  let running = 0;
  let peak = 0;
  const hits = new Map();
  const site = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits.set(p, (hits.get(p) ?? 0) + 1);
    running++;
    peak = Math.max(peak, running);
    await sleep(60);
    running--;
    res.setHeader('content-type', 'text/html');
    if (p === '/') {
      // the same pages linked in several forms: trailing slash, fragment, absolute, duplicate
      const forms = Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">x</a><a href="/p${i}/">x</a><a href="/p${i}#top">x</a><a href="http://localhost:${site.address().port}/p${i}">x</a>`).join('');
      return res.end(`<html><body><p>${'home '.repeat(80)}</p>${forms}</body></html>`);
    }
    res.end(`<html><body><p>${'page '.repeat(80)}</p><a href="/">home</a></body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  try {
    const base = `http://localhost:${site.address().port}/`;
    const result = await withNetPolicy(userPolicy(), async () => {
      const home = await fetchPage(base);
      return crawl({ home, maxPages: 50, robots: { isAllowed: () => true }, concurrency: 6 });
    });
    assert.equal(result.pages.length, 13);
    assert.equal(peak, 6, 'six fetches at once, never more');
    for (let i = 0; i < 12; i++) assert.equal(hits.get(`/p${i}`), 1, `/p${i} requested once`);
  } finally {
    site.close();
  }
});
