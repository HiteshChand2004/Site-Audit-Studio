// Notice pages in a "Copy my site" copy (copy/noticePages.js, Step 7): a link of a copied page to a page of the same site that
// was not copied opens a local notice page; everything else keeps its link, and nothing of the page but those hrefs changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addNoticePages, pathKey } from '../src/copy/noticePages.js';

const SITE = 'https://www.acme-original.dev/';

const HOME = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Acme</title>
<link rel="stylesheet" href="/styles.css"><link rel="alternate" href="/team.html"></head><body>
<nav><a href="/">Home</a> <a href="/about.html">About</a> <a class="x" href="/team.html">Team</a> <a href='/team.html#people'>People</a>
<a href="https://acme-original.dev/work/">Work</a> <a href="https://www.acme-original.dev/login">Sign in</a> <a href="/cart">Cart</a>
<a href="/private/secret.html">Private</a> <a href="/brochure.pdf">Brochure</a> <a href="https://other.dev/page">Other</a>
<a href="#top">Top</a> <a href="mailto:hi@acme-original.dev">Mail</a> <a href="javascript:void(0)">JS</a> <a href="/about/">About again</a>
<a href="/existing/">Existing</a> <a href="/old-page.html">Old</a> <a href="/team.html?x=1&amp;y=2">Team with query</a></nav>
<p>Text with /team.html in it stays.</p></body></html>`;
const NESTED = '<!doctype html><html><head><title>Docs</title></head><body><a href="../team.html">Team</a> <a href="guide/">Guide</a></body></html>';

async function copy() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-notice-'));
  await writeFile(path.join(dir, 'index.html'), HOME);
  await writeFile(path.join(dir, 'about.html'), '<!doctype html><html><body><a href="/">Home</a></body></html>');
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(path.join(dir, 'docs', 'index.html'), NESTED);
  await mkdir(path.join(dir, 'existing'), { recursive: true });
  await writeFile(path.join(dir, 'existing', 'index.html'), 'a file of the copy');
  await writeFile(path.join(dir, 'robots.txt'), 'User-agent: *\nDisallow: /private/\n');
  const pages = [
    { url: SITE, outPath: 'index.html' },
    { url: `${SITE}about.html`, outPath: 'about.html' },
    { url: `${SITE}docs/`, outPath: 'docs/index.html' },
  ];
  return { dir, pages };
}

test('which links get a notice page, with which reason, and which keep their link', async (t) => {
  const { dir, pages } = await copy();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await addNoticePages({ dir, pages, siteUrl: SITE, brokenOnOriginal: ['https://acme-original.dev/old-page.html'], siteName: 'Acme' });

  const byPath = Object.fromEntries(r.pages.map((p) => [p.outPath, p]));
  assert.deepEqual(Object.keys(byPath).sort(), ['cart/index.html', 'docs/guide/index.html', 'login/index.html', 'private/secret.html', 'team.html', 'work/index.html']);
  assert.equal(byPath['team.html'].reason, 'beyond-limit');
  assert.equal(byPath['work/index.html'].reason, 'beyond-limit', 'a full address of the original, with or without www');
  assert.equal(byPath['login/index.html'].reason, 'backend');
  assert.equal(byPath['cart/index.html'].reason, 'backend');
  assert.equal(byPath['private/secret.html'].reason, 'robots');
  assert.deepEqual(byPath['team.html'].from, ['/', '/docs/'], 'linked from the homepage and, relatively, from a nested page');
  assert.deepEqual([...r.left].sort((a, b) => a.url.localeCompare(b.url)), [
    { url: 'https://www.acme-original.dev/about/', why: 'may be the copied page /about.html under another address: left as it is' },
    { url: 'https://www.acme-original.dev/existing/', why: 'the copy already holds existing/index.html' },
    { url: 'https://www.acme-original.dev/old-page.html', why: 'broken on the original: the owner fixes or removes the link' },
  ]);

  const home = await readFile(path.join(dir, 'index.html'), 'utf8');
  for (const [from, to] of [['"/team.html"', '"/team.html"'], ["'/team.html#people'", "'/team.html#people'"], ['"https://acme-original.dev/work/"', '"/work/"'],
    ['"https://www.acme-original.dev/login"', '"/login/"'], ['"/cart"', '"/cart/"'], ['"/team.html?x=1&amp;y=2"', '"/team.html"']]) {
    assert.ok(home.includes(`href=${to}`), `${from} → ${to}`);
  }
  // Left as they are.
  for (const kept of ['href="/"', 'href="/about.html"', 'href="/about/"', 'href="/brochure.pdf"', 'href="https://other.dev/page"', 'href="#top"',
    'href="mailto:hi@acme-original.dev"', 'href="javascript:void(0)"', 'href="/existing/"', 'href="/old-page.html"', 'href="/styles.css"']) {
    assert.ok(home.includes(kept), kept);
  }
  assert.ok(home.includes('<link rel="alternate" href="/team.html">'), 'only <a> links change');
  assert.ok(home.includes('Text with /team.html in it stays.'));
  assert.equal(home.replace(/href=(["'])[^"']*\1/g, ''), HOME.replace(/href=(["'])[^"']*\1/g, ''), 'nothing but hrefs changed');
  assert.equal(await readFile(path.join(dir, 'existing', 'index.html'), 'utf8'), 'a file of the copy', 'never overwritten');
  assert.match(await readFile(path.join(dir, 'docs', 'index.html'), 'utf8'), /href="\/team\.html">Team<\/a> <a href="\/docs\/guide\/">Guide/);
  assert.ok(r.links >= 9 && r.files === 2, JSON.stringify({ links: r.links, files: r.files }));
});

test('the notice page: says why, noindex, no script, its own language, a way home', async (t) => {
  const { dir, pages } = await copy();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await addNoticePages({ dir, pages, siteUrl: SITE, siteName: 'Acme' });
  const login = await readFile(path.join(dir, 'login', 'index.html'), 'utf8');
  assert.match(login, /<title>\/login is not part of this copy \| Acme<\/title>/);
  assert.match(login, /<html lang="de">/);
  assert.match(login, /<meta name="robots" content="noindex">/);
  assert.match(login, /This page needs a server/);
  assert.match(login, /<a href="\.\.\/">Back to the homepage<\/a>/);
  assert.doesNotMatch(login, /<script|https?:\/\//i, 'no script and no outside address');
  assert.match(await readFile(path.join(dir, 'private', 'secret.html'), 'utf8'), /robots\.txt asks crawlers to stay away/);
  assert.match(await readFile(path.join(dir, 'team.html'), 'utf8'), /not part of the pages chosen for the copy[\s\S]*href="\.\/"/);
});

test('a copy whose links all lead to copied pages is left untouched', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-notice-none-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const page = '<!doctype html><html><body><a href="/">Home</a><a href="/about.html">About</a><a href="https://other.dev/">x</a></body></html>';
  await writeFile(path.join(dir, 'index.html'), page);
  await writeFile(path.join(dir, 'about.html'), page);
  const r = await addNoticePages({ dir, pages: [{ url: SITE, outPath: 'index.html' }, { url: `${SITE}about.html`, outPath: 'about.html' }], siteUrl: SITE });
  assert.deepEqual(r, { pages: [], links: 0, files: 0, left: [] });
  assert.deepEqual((await readdir(dir)).sort(), ['about.html', 'index.html']);
  assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), page);
});

test('one key for the same page however its path is written', () => {
  assert.equal(pathKey('/about/'), '/about');
  assert.equal(pathKey('/About/index.html'), '/about');
  assert.equal(pathKey('/'), '/');
  assert.equal(pathKey('/index.html'), '/');
  assert.notEqual(pathKey('/about.html'), pathKey('/about'));
});
