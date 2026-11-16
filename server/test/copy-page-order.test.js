// An as-is copy takes up to 150 pages (SAS_COPY_MAX_PAGES can lower it). When a cap cuts the list, the most important pages are
// kept: the homepage, its header / menu links, its other links, its footer links, then shallower paths; the report names the
// pages left out. Links carry the part of the page they stand in (audit/extract.js), from the HTML's own landmarks only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from '../src/audit/extract.js';
import { byImportance, importanceOf, knownPages } from '../src/recreate/pageOrder.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auditDir } from '../src/config/paths.js';
import { AS_IS_MAX_PAGES, asIsPageChoice, asIsPagesOf } from '../src/recreate/behavior/preserve/asis.js';
import { needsBackend } from '../src/recreate/discover.js';

const HOME = 'https://site.test/';
const HTML = `<!doctype html><html><body>
  <header><a href="/about">About</a><a href="/login">Sign in</a></header>
  <nav aria-label="Main"><a href="/pricing/">Pricing</a></nav>
  <main><a href="/blog/deep/post">A post</a><a href="/features">Features</a><a href="/about">About again</a></main>
  <footer><nav><a href="/privacy">Privacy</a></nav><a href="/terms">Terms</a><a href="/pricing">Pricing again</a></footer>
  <div role="contentinfo"><a href="/imprint">Imprint</a></div>
</body></html>`;

const withCap = (t, value) => {
  const before = process.env.SAS_COPY_MAX_PAGES;
  t.after(() => (before == null ? delete process.env.SAS_COPY_MAX_PAGES : (process.env.SAS_COPY_MAX_PAGES = before)));
  if (value == null) delete process.env.SAS_COPY_MAX_PAGES;
  else process.env.SAS_COPY_MAX_PAGES = String(value);
};

test('each link knows the part of the page it stands in, from the landmarks of the HTML', () => {
  const { links } = extractPage(HTML, HOME);
  const regionOf = Object.fromEntries(links.map((l) => [`${new URL(l.href).pathname}|${l.text}`, l.region]));
  assert.deepEqual(regionOf, {
    '/about|About': 'header',
    '/login|Sign in': 'header',
    '/pricing/|Pricing': 'header',
    '/blog/deep/post|A post': null,
    '/features|Features': null,
    '/about|About again': null,
    '/privacy|Privacy': 'footer', // a menu inside the footer is the footer
    '/terms|Terms': 'footer',
    '/pricing|Pricing again': 'footer',
    '/imprint|Imprint': 'footer',
  });
});

test('pages are ordered by importance: homepage, header and menu links, other homepage links, footer links, then shallower paths', () => {
  const { links } = extractPage(HTML, HOME);
  const rankOf = importanceOf({ homeUrl: HOME, homeLinks: links, depthOf: new Map([['/a/b', 1]]) });
  const pages = ['/zeta', '/terms', '/a/b/c', '/features', '/privacy', '/blog/deep/post', '/pricing', '/about', '/', '/login', '/a/b', '/imprint']
    .map((p) => new URL(p, HOME).href);
  assert.deepEqual(byImportance(pages, rankOf).map((u) => new URL(u).pathname), [
    '/', // the homepage
    '/about', '/login', '/pricing', // header / menu, in page order (a page linked from both header and footer counts as header)
    '/blog/deep/post', '/features', // the homepage's other links, in page order
    '/privacy', '/terms', '/imprint', // footer
    '/zeta', '/a/b', '/a/b/c', // the rest: one segment, then two, then three
  ]);
});

test('a Check made before links had a region keeps the homepage links in page order, ahead of the rest', () => {
  const old = extractPage(HTML, HOME).links.map(({ region, ...l }) => l);
  const rankOf = importanceOf({ homeUrl: HOME, homeLinks: old });
  const pages = ['/zeta', '/privacy', '/about', '/features'].map((p) => new URL(p, HOME).href);
  assert.deepEqual(byImportance(pages, rankOf).map((u) => new URL(u).pathname), ['/about', '/features', '/privacy', '/zeta']);
});

test('an as-is copy takes up to 150 pages; a cap keeps the most important ones and records what it left out', (t) => {
  withCap(t, null);
  assert.equal(AS_IS_MAX_PAGES, 150);
  const project = { url: HOME };
  const many = Array.from({ length: 200 }, (_, i) => `/p${String(i).padStart(3, '0')}`);
  const all = asIsPageChoice(project, many);
  assert.equal(all.pages.length, 150, 'the homepage and 149 more');
  assert.deepEqual({ ...all.choice, notCopied: all.choice.notCopied.length }, { found: 201, copied: 150, max: 150, notCopied: 51, notCopiedCount: 51 });

  const { links } = extractPage(HTML, HOME);
  const rankOf = importanceOf({ homeUrl: HOME, homeLinks: links });
  // Sent in alphabetical order (as the page list used to be): the cap must still keep the header and menu pages.
  const asked = ['/a-1', '/a-2', '/a-3', '/about', '/features', '/login', '/pricing', '/privacy'];
  withCap(t, 4);
  const cut = asIsPageChoice(project, asked, rankOf);
  assert.deepEqual(cut.pages.map((u) => new URL(u).pathname), ['/', '/about', '/login', '/pricing']);
  assert.deepEqual(cut.choice.notCopied.map((u) => new URL(u).pathname), ['/features', '/privacy', '/a-1', '/a-2', '/a-3']);
  assert.deepEqual([cut.choice.found, cut.choice.copied, cut.choice.notCopiedCount], [9, 4, 5]);
  // Nothing cut: the list keeps its own order and nothing is left out.
  withCap(t, null);
  const whole = asIsPageChoice(project, asked, rankOf);
  assert.deepEqual(whole.pages.map((u) => new URL(u).pathname), ['/', ...asked]);
  assert.equal(whole.choice.notCopiedCount, 0);
  assert.deepEqual(asIsPagesOf(project, asked), whole.pages, 'asIsPagesOf is the same list');
  assert.equal(asIsPageChoice(project, ['https://other.test/x'], rankOf), null);
});

test('backend pages are pages of the copy like any other, only flagged', (t) => {
  withCap(t, null);
  const asked = ['/login', '/sign-up', '/account/settings', '/cart', '/checkout', '/admin', '/dashboard', '/about'];
  const { pages } = asIsPageChoice({ url: HOME }, asked);
  assert.equal(pages.length, 9, 'none is left out');
  assert.deepEqual(pages.filter((u) => needsBackend(u)).map((u) => new URL(u).pathname), asked.slice(0, 7));
});

test('the copy\'s pages include those the Check found but did not read (its page limit), not only the ones it read', async () => {
  const project = { id: '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c', url: 'https://www.parchaa.example.com/' };
  const dir = auditDir(project.id, 'a1');
  await mkdir(dir, { recursive: true });
  // A Check limited to 3 pages that found 5 more, one of them on another site and one only a query variant.
  await writeFile(path.join(dir, 'crawl.json'), JSON.stringify({
    pages: [
      { url: 'https://www.parchaa.example.com/', status: 200, depth: 0, facts: { links: [] } },
      { url: 'https://www.parchaa.example.com/doctors', status: 200, depth: 1 },
      { url: 'https://www.parchaa.example.com/gone', status: 404, depth: 1 },
    ],
    notRead: ['https://www.parchaa.example.com/clinics', 'https://www.parchaa.example.com/blog/post-1', 'https://parchaa.example.com/doctors/', 'https://elsewhere.example.org/x', 'https://www.parchaa.example.com/search?q=a'],
    cutBy: 'pages',
  }));
  const { pages } = await knownPages(project, { analysisIds: ['a1'], recreateReports: [] });
  assert.deepEqual(pages.map((p) => p.path).sort(), ['/', '/blog/post-1', '/clinics', '/doctors'].sort(), 'unread pages of the site are in; another site, a query variant, a duplicate and a page that answered 404 are not');
});
