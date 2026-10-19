// Full-site D.3: structured data, FAQ schema, theme-color and llms.txt the original lacks are added from the site itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHeadData, faqPairs } from '../src/recreate/ir/aeo.js';
import { crawlFiles } from '../src/recreate/ir/crawlFiles.js';

const shown = { desktop: { rect: [0, 0, 100, 20], hidden: false } };
const el = (tag, ...children) => ({ tag, attrs: {}, views: shown, children });
const text = (t) => ({ text: t });
const page = (outPath, path, head, root = el('body')) => ({ info: { outPath, path, url: `https://old.test${path}` }, head: { meta: [], jsonLd: [], ...head }, headAuto: [], root });

test('faqPairs: question headings with their answer, <details> pairs; statements are not questions', () => {
  const root = el('body', el('main',
    el('h2', text('How long does a project take?')), el('p', text('Most sites take four to six weeks from start to launch.')),
    el('h2', text('Our process')), el('p', text('We plan, design, build and test every page.')),
    el('details', el('summary', text('Do you host the site?')), el('p', text('Yes, on a fast static host with a free certificate.'))),
    el('h3', text('Why?')), el('h3', text('Next heading')),
  ));
  const pairs = faqPairs(root);
  assert.deepEqual(pairs.map((p) => p.q), ['How long does a project take?', 'Do you host the site?']);
  assert.match(pairs.find((p) => p.q.startsWith('How')).a, /four to six weeks/);
});

test('addHeadData: Organization + WebSite on the homepage, FAQPage where there are questions, theme-color everywhere; existing data is kept', () => {
  const faq = el('body', el('main', el('h2', text('Is it fast?')), el('p', text('Yes, every page loads in under a second.')), el('h2', text('Is it safe?')), el('p', text('Yes, nothing runs that we did not generate.'))));
  const trees = [page('index.html', '/', { title: 'Home' }), page('faq/index.html', '/faq/', { title: 'FAQ' }, faq)];
  const added = addHeadData(trees, { siteName: { value: 'Example' }, baseUrl: 'https://new.example.org', logo: 'https://new.example.org/assets/icons/logo.png', themeColor: '#2563eb' });
  const types = (t) => t.head.jsonLd.map((j) => JSON.parse(j)['@type']);
  assert.deepEqual(types(trees[0]), ['Organization', 'WebSite']);
  assert.equal(JSON.parse(trees[0].head.jsonLd[0]).url, 'https://new.example.org/');
  assert.deepEqual(types(trees[1]), ['FAQPage']);
  assert.equal(JSON.parse(trees[1].head.jsonLd[0]).mainEntity.length, 2);
  assert.ok(trees.every((t) => t.head.meta.some((m) => m.name === 'theme-color' && m.content === '#2563eb')));
  assert.equal(added.themeColor, 2);
  assert.ok(trees[0].headAuto.every((a) => a.review));

  // A site that already has an Organization and a theme-color keeps them as they are.
  const own = [page('index.html', '/', { jsonLd: [JSON.stringify({ '@type': 'Organization', name: 'Own' })], meta: [{ name: 'theme-color', content: '#000000' }] })];
  addHeadData(own, { siteName: { value: 'Example' }, baseUrl: 'https://new.example.org', themeColor: '#2563eb' });
  assert.deepEqual(own[0].head.jsonLd.map((j) => JSON.parse(j)['@type']), ['Organization', 'WebSite']);
  assert.deepEqual(own[0].head.meta, [{ name: 'theme-color', content: '#000000' }]);
});

test('llms.txt is written from the pages when the original has none, never when it has one', () => {
  const pages = [
    page('index.html', '/', { title: 'Example | Fast sites', description: 'Fast marketing sites for small teams.', canonical: 'https://new.example.org/' }),
    page('about/index.html', '/about/', { title: 'About [us]', description: 'Who we are.', canonical: 'https://new.example.org/about/' }),
  ];
  const made = crawlFiles({ pages, baseUrl: 'https://new.example.org' });
  const file = made.files.find((f) => f.path === 'llms.txt');
  assert.ok(file);
  assert.match(file.content, /^# Example \| Fast sites\n\n> Fast marketing sites for small teams\.\n\n## Pages\n/);
  assert.match(file.content, /- \[About us\]\(https:\/\/new\.example\.org\/about\/\): Who we are\./);
  assert.equal(made.llms.generated, true);
  const copied = crawlFiles({ pages, baseUrl: 'https://new.example.org', llms: { text: '# Own file\n' } });
  assert.equal(copied.files.find((f) => f.path === 'llms.txt').content, '# Own file\n');
  assert.equal(copied.llms.generated, false);
});

test('the copy ships security and caching headers for static hosts (_headers)', () => {
  const made = crawlFiles({ pages: [page('index.html', '/', { title: 'Home', canonical: 'https://new.example.org/' })], baseUrl: 'https://new.example.org' });
  const headers = made.files.find((f) => f.path === '_headers')?.content ?? '';
  assert.match(headers, /^\/\*\n/);
  for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options: nosniff', "script-src 'self'", "style-src 'self' 'unsafe-inline'", 'Referrer-Policy']) assert.ok(headers.includes(h), h);
  assert.match(headers, /\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
});
