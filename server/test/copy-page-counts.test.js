// "N pages copied" / "N pages side by side" for every kind of copy. A copy packaged again from a kept copy (another stack, e.g.
// Next.js or React + Vite after a plain HTML copy) runs no capture, which is what filled report.pages, so the app said
// "0 pages copied" (gardner, Next.js). The server now gives such a job its page list (stage.js repackPages), and the app reads
// the copy's own output for a report saved before that (client/src/copiedPages.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copiedPages } from '../../client/src/copiedPages.js';
import { plural } from '../../client/src/format.js';
import { repackPages } from '../src/recreate/behavior/preserve/stage.js';

const dirs = [];
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {}); });

const tabs = (result) => ({ copy: `${plural(copiedPages(result).length, 'page')} copied`, compare: `${plural(copiedPages(result).length, 'page')} side by side` });

test('a converted copy saved before the fix (Next.js, packaged again): the counts come from its output', () => {
  // The shape of gardner's report: no capture ran, pages empty, the Next.js output lists the page.
  const report = { stack: 'nextjs', pages: [], outputs: { nextjs: { status: 'ready', mode: 'as-is', pages: [{ outPath: 'index.html', path: '/' }] } }, asIs: { stack: 'nextjs', pages: [{ url: 'https://gardener.example/', path: '/' }] } };
  assert.deepEqual(tabs(report), { copy: '1 page copied', compare: '1 page side by side' });
  const react = { stack: 'react-vite', pages: [], outputs: { 'react-vite': { status: 'ready', mode: 'as-is', pages: [{ outPath: 'index.html' }, { outPath: 'about/index.html' }, { outPath: 'blog/index.html' }] } } };
  assert.equal(tabs(react).copy, '3 pages copied');
});

test('every other kind of copy keeps its count: captured as-is, rebuilt, an older copy with no output pages', () => {
  assert.equal(tabs({ stack: 'html', pages: [{ outPath: 'index.html' }, { outPath: 'about/index.html' }], outputs: { html: { pages: [{}] } } }).copy, '2 pages copied', 'the capture\'s list wins');
  assert.equal(tabs({ stack: 'mern', pages: Array.from({ length: 14 }, () => ({})), outputs: { mern: {} } }).copy, '14 pages copied');
  assert.equal(tabs({ stack: 'html', pages: [] }).copy, '0 pages copied', 'nothing to count is still 0');
  assert.deepEqual(copiedPages(null), []);
});

test('a job packaged again gets its page list: the earlier job\'s (without its capture folder), else one per saved page', async () => {
  const earlier = await mkdtemp(path.join(os.tmpdir(), 'sas-page-counts-'));
  dirs.push(earlier);
  const saved = [{ url: 'https://site.example/', outPath: 'index.html' }, { url: 'https://site.example/about/', outPath: 'about/index.html' }];
  // The earlier job's report is gone (retention): built from the saved page set.
  assert.deepEqual(await repackPages(earlier, saved), [
    { url: 'https://site.example/', path: '/', outPath: 'index.html', source: 'reused' },
    { url: 'https://site.example/about/', path: '/about/', outPath: 'about/index.html', source: 'reused' },
  ]);
  // Its report is there: its entries (titles and all), without the slug of a capture this job does not have.
  await writeFile(path.join(earlier, 'report.json'), JSON.stringify({ pages: [
    { url: 'https://site.example/', path: '/', outPath: 'index.html', slug: 'index', title: 'Home', views: ['desktop'] },
    { url: 'https://site.example/about/', path: '/about/', outPath: 'about/index.html', slug: 'about', title: 'About' },
  ] }));
  const pages = await repackPages(earlier, saved);
  assert.deepEqual(pages.map((p) => [p.outPath, p.title, 'slug' in p]), [['index.html', 'Home', false], ['about/index.html', 'About', false]]);
  assert.equal(tabs({ stack: 'nextjs', pages }).copy, '2 pages copied');
});
