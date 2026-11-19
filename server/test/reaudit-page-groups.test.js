import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupMin, pageShape, planGroups } from '../src/reaudit/pageGroups.js';

const WORDS = 'Some words that a visitor reads on this page, long enough to be real content. ';
const page = (paras, css = '/css/site.css') => `<!doctype html><html><head><link rel="stylesheet" href="${css}?v=1"><script src="/js/app.js"></script></head>
<body><header><nav><a href="/">Home</a><a href="/blog/">Blog</a></nav></header>
<main><article><h1>Title</h1>${`<p>${WORDS.repeat(2)}</p>`.repeat(paras)}<svg><path d="M0 0"/><circle r="2"/></svg></article></main>
<footer><p>Footer</p></footer><script>window.x = 1</script></body></html>`;

test('pageShape: the same layout with more or fewer paragraphs is one shape; another stylesheet or layout is another', () => {
  assert.equal(pageShape(page(5)), pageShape(page(7)), 'a run of equal sibling tags counts once');
  assert.equal(pageShape(page(5)), pageShape(page(5).replace('?v=1', '?v=2')), 'a query on a file name does not count');
  assert.notEqual(pageShape(page(5)), pageShape(page(5, '/css/other.css')), 'another stylesheet: another shape');
  assert.notEqual(pageShape(page(5)), pageShape(page(5).replace('<h1>Title</h1>', '<section><h2>x</h2></section>')), 'another layout: another shape');
  const p = `<p>${WORDS.repeat(2)}</p>`;
  const post = (inner) => page(0).replace('<h1>Title</h1>', `<h1>Title</h1>${inner}`);
  assert.equal(pageShape(post(`<h2>A</h2>${p}${p}<h2>B</h2>${p}`)), pageShape(post(`${p}<h2>A</h2>${p}${p}${p}<h2>B</h2>`)), 'headings and paragraphs in another order and number: one shape');
});

test('pageShape: a shell its script fills (next to no text in its HTML) has no shape, so it is measured on its own', () => {
  assert.equal(pageShape('<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div><script>start()</script></body></html>'), null);
});

test('planGroups: the homepage and the first two pages of each shape are measured, the rest through their group', () => {
  const pages = ['/', '/blog/a/', '/blog/b/', '/blog/c/', '/blog/d/', '/about/', '/odd/'].map((path) => ({ path }));
  const shape = { '/': 'home', '/blog/a/': 'post', '/blog/b/': 'post', '/blog/c/': 'post', '/blog/d/': 'post', '/about/': 'about', '/odd/': null };
  const plan = planGroups(pages, (p) => shape[p.path]);
  assert.deepEqual(plan.measure.map((p) => p.path), ['/', '/blog/a/', '/blog/b/', '/about/', '/odd/'], 'a page whose shape is unknown is measured');
  assert.deepEqual(plan.through, [{ path: '/blog/c/', rep: '/blog/a/', shape: 'post' }, { path: '/blog/d/', rep: '/blog/a/', shape: 'post' }]);
  assert.equal(plan.groups, 2);
});

test('groupMin: off unless set to a whole number of at least 2', () => {
  assert.equal(groupMin({}), null);
  assert.equal(groupMin({ SAS_PAGE_GROUPS_MIN: '' }), null);
  assert.equal(groupMin({ SAS_PAGE_GROUPS_MIN: '1' }), null);
  assert.equal(groupMin({ SAS_PAGE_GROUPS_MIN: 'many' }), null);
  assert.equal(groupMin({ SAS_PAGE_GROUPS_MIN: '200' }), 200);
});
