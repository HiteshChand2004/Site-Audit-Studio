// The "Original as-is" rules that need no browser: which pages a copy takes, where each one lives in the copy, how links
// between the chosen pages are recognised, and that discovery takes exactly the chosen pages (discover.js include).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asIsPagesOf, localOfOutPath } from '../src/recreate/behavior/preserve/asis.js';
import { pageKeyOf } from '../src/recreate/behavior/preserve/pageLift.js';
import { readLifted } from '../src/recreate/behavior/preserve/stage.js';
import { planZip } from '../src/recreate/export/zip.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectPages } from '../src/recreate/discover.js';
import { pageKey } from '../src/audit/util.js';

const project = { url: 'https://www.site.test/' };

test('the homepage is always one of the copy\'s pages; other addresses of the site are added once', () => {
  assert.deepEqual(asIsPagesOf(project, []), ['https://www.site.test/']);
  const pages = asIsPagesOf(project, ['https://site.test/about/', 'https://www.site.test/about#team', '/pricing?x=1', 'https://www.site.test/']);
  assert.deepEqual(pages, ['https://www.site.test/', 'https://site.test/about/', 'https://www.site.test/pricing']);
});

test('an address of another site is refused, and so is a list that is not a list of addresses', () => {
  assert.equal(asIsPagesOf(project, ['https://other.test/x']), null);
  assert.equal(asIsPagesOf({ url: 'not a url' }, []), null);
});

test('each page has its own place in the copy', () => {
  assert.equal(localOfOutPath('index.html'), '/');
  assert.equal(localOfOutPath('about/index.html'), '/about/');
  assert.equal(localOfOutPath('about.html'), '/about.html');
});

test('a link to a chosen page is recognised whatever its spelling (www, trailing slash, index.html, query, fragment)', () => {
  const key = pageKeyOf('https://www.site.test/about/');
  for (const u of ['https://site.test/about', 'https://www.site.test/about/index.html?x=1#top', 'https://site.test/about/']) {
    assert.equal(pageKeyOf(u), key, u);
  }
  assert.notEqual(pageKeyOf('https://site.test/about-us/'), key);
});

test('discovery takes exactly the chosen pages when an include set is given; without it nothing changes', () => {
  const home = 'https://site.test/';
  const robots = { isAllowed: () => true };
  const pages = [
    { url: home, depth: 0, status: 200, facts: { links: [
      { href: 'https://site.test/a', internal: true },
      { href: 'https://site.test/b', internal: true },
    ] } },
    { url: 'https://site.test/a', depth: 1, status: 200, facts: {} },
    { url: 'https://site.test/b', depth: 1, status: 200, facts: {} },
  ];
  const chosen = new Set([pageKey(home), pageKey('https://site.test/a')]);
  const only = selectPages({ pages, homeUrl: home, robots, limit: 5, include: chosen });
  assert.deepEqual(only.pages.map((p) => p.url), [home, 'https://site.test/a']);

  const all = selectPages({ pages, homeUrl: home, robots, limit: 5 });
  assert.deepEqual(all.pages.map((p) => p.url), [home, 'https://site.test/a', 'https://site.test/b']);
});

test('a lifted copy keeps its page set; an older copy (report only) gives the same pages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-readlifted-'));
  try {
    const saved = path.join(root, 'saved');
    await mkdir(saved, { recursive: true });
    await mkdir(path.join(saved, 'as-is'), { recursive: true });
    await writeFile(path.join(saved, 'as-is', 'pages.json'), JSON.stringify({ pages: [{ url: 'https://s.test/', outPath: 'index.html' }, { url: 'https://s.test/about/', outPath: 'about/index.html' }], excludedHosts: ['chat.test'], lift: { files: 3 } }), 'utf8');
    const kept = await readLifted(saved);
    assert.deepEqual(kept.pages.map((p) => p.outPath), ['index.html', 'about/index.html']);
    assert.deepEqual(kept.excludedHosts, ['chat.test']);

    const older = path.join(root, 'older');
    await mkdir(older, { recursive: true });
    await writeFile(path.join(older, 'report.json'), JSON.stringify({ asIs: { pages: [{ url: 'https://s.test/', path: '/' }, { url: 'https://s.test/about/', path: '/about/' }, { url: 'https://s.test/pricing.html', path: '/pricing.html' }], excludedByRule: ['chat.test'] } }), 'utf8');
    const old = await readLifted(older);
    assert.deepEqual(old.pages.map((p) => p.outPath), ['index.html', 'about/index.html', 'pricing.html']);
    assert.deepEqual(old.excludedHosts, ['chat.test']);

    assert.equal(await readLifted(path.join(root, 'nothing')), null, 'no copy, no pages');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the download of an as-is MERN copy keeps its client/dist (the copy itself); a clean build’s dist is still left out', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-zip-asis-'));
  try {
    const stacks = path.join(root, 'stacks', 'mern');
    await mkdir(path.join(stacks, 'client', 'dist'), { recursive: true });
    await mkdir(path.join(stacks, 'server'), { recursive: true });
    await writeFile(path.join(stacks, 'client', 'dist', 'index.html'), '<!doctype html>', 'utf8');
    await writeFile(path.join(stacks, 'server', 'index.js'), '// server', 'utf8');
    await writeFile(path.join(stacks, 'README.md'), '# copy', 'utf8');
    const asIsReport = { stack: 'mern', url: 'https://site.test/', outputs: { mern: { status: 'ready', dir: 'stacks/mern', mode: 'as-is' } }, pages: [] };
    const plan = await planZip({ dir: root, report: asIsReport, stack: 'mern' });
    const names = plan.entries.map((e) => e.name);
    assert.ok(names.some((n) => n.endsWith('/client/dist/index.html')), 'the copy is in the download');
    assert.ok(names.some((n) => n.endsWith('/README.md')));

    await mkdir(path.join(stacks, 'client', 'dist', 'assets'), { recursive: true });
    await writeFile(path.join(stacks, 'client', 'dist', 'assets', 'built.js'), 'x', 'utf8');
    const cleanReport = { ...asIsReport, outputs: { mern: { status: 'ready', dir: 'stacks/mern' } } };
    const clean = await planZip({ dir: root, report: cleanReport, stack: 'mern' });
    assert.ok(!clean.entries.some((e) => e.name.includes('/client/dist/')), 'a built dist is not the copy: left out');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
