// A crashed local browser (Chromium out of memory on a long job) is replaced and the page rendered again; a page that
// still cannot be rendered is listed and the other pages go on, so one page never throws away the work of a whole Recreate.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureSite } from '../src/recreate/generate.js';
import { isBrowserCrash, openRenderer, renderPage } from '../src/recreate/verify/layout.js';

const page = (name) => ({
  outPath: `${name}.html`,
  head: { lang: 'en', title: name, meta: [], alternates: [], icons: [], preload: [], jsonLd: [] },
  html: {},
  body: { t: 'body', children: [{ t: 'main', b: true, class: 'page', children: [{ t: 'h1', children: [{ text: `Page ${name}` }] }] }] },
});
const IR = { version: 1, pages: ['a', 'b', 'c'].map(page), rules: [], tokens: {}, fontFaces: [], keyframes: [], breakpoints: { source: 'single-view' }, files: [] };
const SITE = { pages: ['a', 'b', 'c'].map((name) => ({ views: ['desktop'], info: { path: `/${name}.html` } })) };

let root;
let renderer;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-crash-'));
  renderer = await openRenderer(root);
});
after(async () => {
  await renderer?.close();
  await rm(root, { recursive: true, force: true });
});

// The browser behind the renderer goes away the way a crash or a killed process does.
const crashBrowser = () => renderer.contexts.desktop.browser().close();

test('crash errors are told apart from a slow or broken page', () => {
  for (const m of ['browserContext.newPage: Target crashed ', 'page.goto: Page crashed', 'Target page, context or browser has been closed', 'browser has disconnected']) {
    assert.equal(isBrowserCrash(new Error(m)), true, m);
  }
  for (const m of ['page.goto: Timeout 15000ms exceeded.', 'net::ERR_FAILED', 'Cannot read properties of undefined']) {
    assert.equal(isBrowserCrash(new Error(m)), false, m);
  }
});

test('after the browser crashed, the page is rendered in a new browser; renders that saw the same crash share one relaunch', async () => {
  renderer.server.overrides.set('a.html', '<!doctype html><title>a</title><h1 data-sas-id="1">A</h1>');
  const first = await renderPage(renderer, 'a.html', 'desktop');
  assert.ok(first.rects['1']);
  const before = renderer.recoveries;

  await crashBrowser();
  const [x, y] = await Promise.all([renderPage(renderer, 'a.html', 'desktop'), renderPage(renderer, 'a.html', 'desktop')]);
  assert.ok(x.rects['1'] && y.rects['1']);
  assert.equal(renderer.recoveries, before + 1);
  renderer.server.overrides.clear();
});

test('a page that cannot be rendered is listed and the other pages are still measured', async () => {
  // b.html never loads (a page error that is not a crash: no new browser helps).
  await renderer.contexts.desktop.route('**/b.html', (route) => route.abort('failed'));
  const seen = [];
  const result = await measureSite(renderer, IR, SITE, { onView: (tree) => seen.push(tree.info.path) });
  await renderer.contexts.desktop.unroute('**/b.html');
  assert.deepEqual(seen, ['/a.html', '/c.html']);
  assert.equal(result.started, 3);
  assert.deepEqual(result.failed.map((f) => f.path), ['/b.html']);
  assert.match(result.failed[0].error, /ERR_FAILED/);
});

test('a crash in the middle of the site costs nothing: the pages after it are rendered in a new browser', async () => {
  const seen = [];
  const before = renderer.recoveries;
  const result = await measureSite(renderer, IR, SITE, {
    onView: async (tree) => {
      seen.push(tree.info.path);
      if (tree.info.path === '/a.html') await crashBrowser();
    },
  });
  assert.deepEqual(seen, ['/a.html', '/b.html', '/c.html']);
  assert.deepEqual(result.failed, []);
  assert.equal(renderer.recoveries, before + 1);
});

test('when no page renders at all, the error is raised (the build itself is broken)', async () => {
  await renderer.contexts.desktop.route('**/*.html', (route) => route.abort('failed'));
  await assert.rejects(measureSite(renderer, IR, SITE, { onView: () => {} }), /ERR_FAILED/);
  await renderer.contexts.desktop.unroute('**/*.html');
});
