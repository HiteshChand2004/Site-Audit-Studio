// Rebuild from a saved capture (recreate/replay.js): the inspect and assets steps replayed from an earlier recreate's folder.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canReplay, replayStages } from '../src/recreate/replay.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'sas-replay-'));
after(() => rm(tmp, { recursive: true, force: true }));

async function savedRecreate({ withRobots }) {
  const src = path.join(tmp, `src-${withRobots}`);
  const page = { url: 'http://site.test/', path: '/', outPath: 'index.html', slug: 'index', title: 'Home', source: 'home', views: { desktop: { file: 'desktop.json' } } };
  await mkdir(path.join(src, 'capture', 'index'), { recursive: true });
  await mkdir(path.join(src, 'assets', 'images'), { recursive: true });
  await mkdir(path.join(src, 'site'), { recursive: true });
  await writeFile(path.join(src, 'capture', 'index', 'desktop.json'), '{"view":"desktop"}');
  await writeFile(path.join(src, 'capture', 'manifest.json'), JSON.stringify({
    homeUrl: page.url, origin: 'http://site.test', pages: [page],
    discovery: { skipped: [{ url: 'http://site.test/cart', reason: 'backend' }], linksToLive: [{ url: 'http://site.test/x', reason: 'stalled' }],
      ...(withRobots && { robots: { status: 'found', blocksAll: false, blockedAiCrawlers: ['GPTBot'] }, llms: { found: true, text: '# Site', tooLarge: false } }) },
  }));
  await writeFile(path.join(src, 'assets', 'images', 'a.png'), 'png');
  await writeFile(path.join(src, 'assets', 'manifest.json'), JSON.stringify({ files: [{ file: 'images/a.png', kind: 'image' }], map: { 'http://site.test/a.png': 'images/a.png' }, skipped: [], fontFaces: [], keyframes: [] }));
  await writeFile(path.join(src, 'site', 'llms.txt'), '# Old site llms');
  await writeFile(path.join(src, 'report.json'), JSON.stringify({
    createdAt: '2026-10-06T06:52:13.450Z', pages: [{ ...page, views: ['desktop'] }], motion: { status: 'captured' }, assets: { downloaded: 1, svg: null },
    manual: [{ kind: 'page', title: '/cart was not recreated' }, { kind: 'asset', title: 'big video' }, { kind: 'form', title: 'contact form' }],
    fixes: [{ id: 'crawl-files', items: [{ file: 'robots.txt', blocksAll: false, blockedAiCrawlers: ['CCBot'] }] }],
  }));
  return src;
}

const newCtx = async (name) => {
  const dir = path.join(tmp, name);
  await mkdir(dir, { recursive: true });
  return { dir, progress: () => {}, report: { warnings: [], manual: [], pages: [] } };
};

test('a saved recreate is replayed: capture and files linked, pages, discovery and assets restored, the site never opened', async () => {
  const src = await savedRecreate({ withRobots: true });
  assert.equal(await canReplay(src), true);
  assert.equal(await canReplay(path.join(tmp, 'nothing')), false);
  const stages = replayStages(src, { recreateId: 'r1' });
  const ctx = await newCtx('new1');
  await stages.inspect(ctx);
  await stages.assets(ctx);
  assert.equal(ctx.pages.length, 1);
  assert.equal(ctx.discovery.origin, 'http://site.test');
  assert.deepEqual(ctx.discovery.robots.blockedAiCrawlers, ['GPTBot']);
  assert.equal(ctx.discovery.llms.text, '# Site');
  assert.deepEqual(ctx.livePages.map((p) => p.url), ['http://site.test/x']);
  assert.equal(await readFile(path.join(ctx.dir, 'capture', 'index', 'desktop.json'), 'utf8'), '{"view":"desktop"}');
  assert.equal((await stat(path.join(ctx.dir, 'assets', 'images', 'a.png'))).size, 3);
  assert.equal(ctx.assets.map['http://site.test/a.png'], 'images/a.png');
  assert.equal(ctx.report.reusedCapture.recreateId, 'r1');
  assert.match(ctx.report.warnings[0], /Rebuilt from the capture/);
  assert.deepEqual(ctx.report.manual.map((m) => m.kind).sort(), ['asset', 'page'], 'page and asset items carried, the rest is rebuilt');
  // The new recreate can itself be rebuilt from.
  assert.equal(await canReplay(ctx.dir), true);
});

test('an older capture without robots / llms in its manifest takes them from the earlier build', async () => {
  const src = await savedRecreate({ withRobots: false });
  const ctx = await newCtx('new2');
  await replayStages(src, { recreateId: 'r2' }).inspect(ctx);
  assert.deepEqual(ctx.discovery.robots, { status: 'found', blocksAll: false, blockedAiCrawlers: ['CCBot'] });
  assert.equal(ctx.discovery.llms.text, '# Old site llms');
});
