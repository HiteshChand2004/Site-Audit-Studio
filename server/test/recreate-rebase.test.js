// Full-site E.1: full addresses copied from the original (structured data, llms.txt, hreflang) name the new site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinkResolver } from '../src/recreate/ir/links.js';
import { createRebaser, servedPath } from '../src/recreate/ir/rebase.js';

const origin = 'https://example.com';
const pages = [
  { url: 'https://example.com/', outPath: 'index.html' },
  { url: 'https://example.com/about/', outPath: 'about/index.html' },
  { url: 'https://example.com/team.html', outPath: 'team.html' },
];
const assets = { 'https://cdn.example.net/logo.png': 'images/logo-abc.png', 'https://example.com/brochure.pdf': 'files/brochure-1.pdf' };
const make = () => createRebaser({
  resolveLink: createLinkResolver({ pages, skipped: [{ url: 'https://example.com/login', reason: 'login' }], origin, assetFile: (u) => assets[u] ?? null }),
  baseUrl: 'https://new.example.org',
});

test('servedPath: index files are folders, other files keep their name', () => {
  assert.equal(servedPath('index.html'), '/');
  assert.equal(servedPath('about/index.html'), '/about/');
  assert.equal(servedPath('team.html'), '/team.html');
});

test('addresses of the original move to the new site; other hosts stay', () => {
  const r = make();
  const home = 'https://example.com/';
  assert.equal(r.url('https://www.example.com/about/', home), 'https://new.example.org/about/', 'www. is the same site');
  assert.equal(r.url('https://example.com/team.html#people', home), 'https://new.example.org/team.html#people');
  assert.equal(r.url('https://example.com/brochure.pdf', home), 'https://new.example.org/assets/files/brochure-1.pdf');
  assert.equal(r.url('https://example.com/login', home), 'https://new.example.org/login/', 'a page not copied → its notice page on the new site');
  assert.equal(r.url('https://twitter.com/example', home), 'https://twitter.com/example');
  assert.equal(r.url('mailto:hi@example.com', home), 'mailto:hi@example.com');
  assert.equal(r.url('not a url', home), 'not a url');
});

test('structured data: every address value moves, keys and text stay, invalid JSON is left alone', () => {
  const r = make();
  const raw = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Example', url: 'https://www.example.com', logo: 'https://example.com/brochure.pdf', sameAs: ['https://twitter.com/example'], hasPart: [{ '@type': 'WebPage', url: 'https://example.com/about/' }] });
  const out = JSON.parse(r.json(raw, 'https://example.com/'));
  assert.equal(out['@context'], 'https://schema.org');
  assert.equal(out.url, 'https://new.example.org/');
  assert.equal(out.logo, 'https://new.example.org/assets/files/brochure-1.pdf');
  assert.deepEqual(out.sameAs, ['https://twitter.com/example']);
  assert.equal(out.hasPart[0].url, 'https://new.example.org/about/');
  assert.equal(r.json('{ broken', 'https://example.com/'), '{ broken');
  assert.ok(r.count() >= 3);
});

test('llms.txt: links in the text move, sentence punctuation stays outside', () => {
  const r = make();
  const text = '# Example\n- [About](https://example.com/about/): who we are.\nSee https://www.example.com/team.html.\nPartner: https://partner.org/x';
  const out = r.text(text, 'https://example.com/');
  assert.match(out, /\(https:\/\/new\.example\.org\/about\/\)/);
  assert.match(out, /See https:\/\/new\.example\.org\/team\.html\.$/m);
  assert.match(out, /https:\/\/partner\.org\/x/);
  assert.doesNotMatch(out, /https?:\/\/(www\.)?example\.com/);
});
