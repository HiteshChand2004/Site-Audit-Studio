// The "Original as-is" rules that need no browser: which pages a copy takes, where each one lives in the copy, how links
// between the chosen pages are recognised, and that discovery takes exactly the chosen pages (discover.js include).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asIsPagesOf, localOfOutPath } from '../src/recreate/behavior/preserve/asis.js';
import { pageKeyOf } from '../src/recreate/behavior/preserve/pageLift.js';
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
