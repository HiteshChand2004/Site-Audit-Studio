// Full-site D.1: titles and descriptions that break the SEO checks are fixed from the page itself and marked for review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixHeadTexts, shortenTitle } from '../src/recreate/ir/head.js';

const shown = { desktop: { rect: [0, 0, 100, 20], hidden: false } };
const el = (tag, ...children) => ({ tag, attrs: {}, views: shown, children });
const text = (t) => ({ text: t });
const page = (path, title, description, { h1 = null, p = null } = {}) => ({
  info: { path },
  head: { title, description },
  headAuto: [],
  root: el('body', el('main', ...(h1 ? [el('h1', text(h1))] : []), ...(p ? [el('p', text(p))] : []))),
});
const LONG_P = 'We design and build fast, accessible marketing sites for small teams that want to grow without a large agency.';

test('shortenTitle drops trailing parts first, then cuts at a word', () => {
  assert.equal(shortenTitle('Our services for growing companies | Example Studio | Design and engineering since 2009'), 'Our services for growing companies | Example Studio');
  const cut = shortenTitle('A very long title without any separator that goes on and on far beyond sixty characters');
  assert.ok(cut.length <= 60, cut);
  assert.match(cut, /…$/);
  assert.equal(shortenTitle('Short and fine'), 'Short and fine');
});

test('length: long cut, short completed; duplicates get the page heading; every change is listed with the original', () => {
  const trees = [
    page('/', 'Example Studio — fast marketing sites for small teams and the people who run them', LONG_P),
    page('/about/', 'About', 'Who we are.', { h1: 'About the studio', p: LONG_P.replace('We design', 'Since 2009 we design') }),
    page('/work/', 'Example Studio', LONG_P, { h1: 'Selected work', p: 'Case studies from twelve years of client work across retail, health and education sectors.' }),
    page('/contact/', 'Example Studio', 'x'.repeat(200), { h1: 'Contact us' }),
  ];
  const done = fixHeadTexts(trees, { value: 'Example Studio' });
  const [home, about, work, contact] = trees;

  assert.ok(home.head.title.length <= 60);
  assert.equal(home.headAuto[0].original, 'Example Studio — fast marketing sites for small teams and the people who run them');
  assert.equal(home.headAuto[0].review, true);

  assert.equal(about.head.title, 'About | Example Studio', 'a short title gets the site name');
  assert.match(about.head.description, /^Since 2009/, "a short description becomes the page's first paragraph");

  // /work/ had the homepage's description and the same title as /contact/.
  assert.equal(work.head.title, 'Selected work | Example Studio');
  assert.match(work.head.description, /^Case studies/);
  assert.equal(contact.head.title, 'Contact us | Example Studio');
  assert.ok(contact.head.description.length <= 160);

  const titles = trees.map((t) => t.head.title.toLowerCase());
  assert.equal(new Set(titles).size, titles.length, 'titles are unique');
  const descs = trees.map((t) => t.head.description.toLowerCase());
  assert.equal(new Set(descs).size, descs.length, 'descriptions are unique');
  assert.ok(done.titles >= 4 && done.descriptions >= 3, JSON.stringify(done));
});

test('fine titles and descriptions are left exactly as they are', () => {
  const trees = [page('/', 'Example Studio | Fast marketing sites', LONG_P), page('/about/', 'About | Example Studio', LONG_P.replace('We', 'Since 2009 we'))];
  const done = fixHeadTexts(trees, { value: 'Example Studio' });
  assert.deepEqual(done, { titles: 0, descriptions: 0 });
  assert.deepEqual(trees.map((t) => t.headAuto.length), [0, 0]);
});
