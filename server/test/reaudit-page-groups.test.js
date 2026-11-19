import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupMin, pageShape, planGroups } from '../src/reaudit/pageGroups.js';

const page = (paras, css = '/css/site.css') => `<!doctype html><html><head><link rel="stylesheet" href="${css}?v=1"><script src="/js/app.js"></script></head>
<body><header><nav><a href="/">Home</a><a href="/blog/">Blog</a></nav></header>
<main><article><h1>Title</h1>${'<p>Some words.</p>'.repeat(paras)}<svg><path d="M0 0"/><circle r="2"/></svg></article></main>
<footer><p>Footer</p></footer><script>window.x = 1</script></body></html>`;

test('pageShape: the same layout with more or fewer paragraphs is one shape; another stylesheet or layout is another', () => {
  assert.equal(pageShape(page(5)), pageShape(page(7)), 'a run of equal sibling tags counts once');
  assert.equal(pageShape(page(5)), pageShape(page(5).replace('?v=1', '?v=2')), 'a query on a file name does not count');
  assert.notEqual(pageShape(page(5)), pageShape(page(5, '/css/other.css')), 'another stylesheet: another shape');
  assert.notEqual(pageShape(page(5)), pageShape(page(5).replace('<h1>Title</h1>', '<section><h2>x</h2></section>')), 'another layout: another shape');
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
