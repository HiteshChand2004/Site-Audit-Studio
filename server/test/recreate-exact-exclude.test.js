// Exact mode, phase B4: the parts of a page that are not the site. Decided from evidence, never from a list of
// brands - so the tests are about the evidence, including the cases where nothing may be removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyExcludes, findExcludable, CORNER_MAX, EMBED_HOSTS } from '../src/recreate/ir/exclude.js';
import { excludedFor } from '../src/recreate/verify/exact/compare.js';

const WIDTHS = { desktop: 1440 };
const el = (tag, { path, style = {}, rect = [0, 0, 100, 40], attrs = {}, children = [], text } = {}) => ({
  tag,
  path,
  cpath: path,
  attrs,
  views: { desktop: { rect, style } },
  children: text ? [{ text }] : children,
});
const tree = (children) => ({
  info: { path: '/' },
  root: el('body', { path: 'body', rect: [0, 0, 1440, 2000], children }),
});

test('a badge pinned to a corner that points at the builder is not part of the site', () => {
  const badge = el('a', {
    path: 'body>a:1',
    style: { position: 'fixed' },
    rect: [1280, 1900, 140, 40],
    attrs: { href: 'https://www.framer.com/?via=badge' },
    text: 'Made in Framer',
  });
  const found = findExcludable(tree([badge]), { viewWidths: WIDTHS });
  assert.equal(found.length, 1);
  assert.equal(found[0].reason, 'builder-badge');
  assert.match(found[0].evidence, /framer\.com/);
  assert.equal(found[0].text, 'Made in Framer');
});

test('a corner link to the site itself is the site, and stays', () => {
  const ownLink = el('a', {
    path: 'body>a:1',
    style: { position: 'fixed' },
    rect: [1280, 1900, 140, 40],
    attrs: { href: '/contact' },
    text: 'Contact us',
  });
  assert.deepEqual(findExcludable(tree([ownLink]), { viewWidths: WIDTHS }), []);
});

test('a bar across the window that a click made go away for good is a consent banner', () => {
  const banner = el('div', {
    path: 'body>div:1',
    style: { position: 'fixed' },
    rect: [0, 1800, 1440, 120],
    children: [el('button', { path: 'body>div:1>button:1', text: 'Accept' })],
  });
  // The click probe records a control whose click did not restore the page: that is dismissing.
  const dismissed = new Set(['body>div:1>button:1']);
  const found = findExcludable(tree([banner]), { viewWidths: WIDTHS, dismissed });
  assert.equal(found.length, 1);
  assert.equal(found[0].reason, 'consent-banner');
  assert.match(found[0].evidence, /go away for good/);
});

test('a sticky header is not a consent banner, however wide it is', () => {
  const header = el('header', {
    path: 'body>header:1',
    style: { position: 'sticky' },
    rect: [0, 0, 1440, 80],
    children: [el('button', { path: 'body>header:1>button:1', text: 'Menu' })],
  });
  // Its button opens a menu and the page goes back to how it was, so nothing was dismissed.
  assert.deepEqual(findExcludable(tree([header]), { viewWidths: WIDTHS, dismissed: new Set() }), []);
});

test('a chat bubble from another company goes; an embed a page means to show stays', () => {
  const chat = el('div', {
    path: 'body>div:1',
    style: { position: 'fixed' },
    rect: [1320, 1880, 90, 90],
    children: [el('iframe', { path: 'body>div:1>iframe:1', attrs: { src: 'https://widget.some-chat-service.example/box' } })],
  });
  const found = findExcludable(tree([chat]), { viewWidths: WIDTHS });
  assert.equal(found[0].reason, 'chat-widget');
  assert.match(found[0].evidence, /widget\.some-chat-service\.example/);

  // A video or a map in the same corner is content the page means to show.
  for (const src of ['https://www.youtube.com/embed/abc', 'https://player.vimeo.com/video/1', 'https://calendly.com/x']) {
    const embed = el('div', {
      path: 'body>div:1',
      style: { position: 'fixed' },
      rect: [1320, 1880, 200, 120],
      children: [el('iframe', { path: 'body>div:1>iframe:1', attrs: { src } })],
    });
    assert.deepEqual(findExcludable(tree([embed]), { viewWidths: WIDTHS }), [], src);
  }
  assert.ok(EMBED_HOSTS.includes('youtube.com'));
});

test('an element that is simply in the page flow is never excluded, whatever it holds', () => {
  const inFlow = el('div', {
    path: 'body>div:1',
    rect: [0, 400, 1440, 200],
    attrs: { href: 'https://www.framer.com/' },
    children: [el('iframe', { path: 'body>div:1>iframe:1', attrs: { src: 'https://unknown.example/thing' } })],
  });
  assert.deepEqual(findExcludable(tree([inFlow]), { viewWidths: WIDTHS }), [], 'fixed or sticky is the first condition');
});

test('a big fixed panel in a corner is not a badge: a badge is small', () => {
  const panel = el('a', {
    path: 'body>a:1',
    style: { position: 'fixed' },
    rect: [900, 900, CORNER_MAX + 200, CORNER_MAX + 200],
    attrs: { href: 'https://www.framer.com/' },
  });
  assert.deepEqual(findExcludable(tree([panel]), { viewWidths: WIDTHS }), []);
});

test('what is excluded is removed from the tree, and a parent takes its children with it', () => {
  const badge = el('div', {
    path: 'body>div:1',
    style: { position: 'fixed' },
    rect: [1300, 1900, 120, 40],
    children: [el('a', { path: 'body>div:1>a:1', attrs: { href: 'https://www.framer.com/' }, text: 'Made in Framer' })],
  });
  const kept = el('p', { path: 'body>p:1', text: 'Real content' });
  const t = tree([badge, kept]);
  const list = findExcludable(t, { viewWidths: WIDTHS });
  assert.equal(list.length, 1, 'the parent is listed, not both');
  const removed = applyExcludes(t, list);
  assert.deepEqual(removed, ['body>div:1']);
  assert.deepEqual(t.root.children.map((c) => c.path), ['body>p:1'], 'and the real content is untouched');
});

test('an exclusion is taken out of the comparison by the text it painted', () => {
  const texts = excludedFor([
    { page: '/', text: 'Made in Framer' },
    { page: '/about', text: 'We use cookies' },
    { page: '/', text: '' },
  ], '/');
  assert.deepEqual([...texts], ['made in framer'], 'this page only, normalised the way the box index keys it');
  assert.equal(excludedFor([], '/').size, 0);
});

test("the builder's own frame and the control that opens it are tooling, not the site", () => {
  // An editor bar: a frame from the platform's host stretched over the window (clipped until opened), and a small
  // pinned button half-way down the edge - not in a corner - whose click changes that frame.
  const frame = el('iframe', {
    path: 'body>iframe:1',
    style: { position: 'fixed', 'clip-path': 'circle(1px at 100% 100%)' },
    rect: [0, 0, 1440, 900],
    attrs: { src: 'https://framer.com/edit?siteId=abc' },
  });
  const bar = el('div', {
    path: 'body>div:4',
    style: { position: 'fixed' },
    rect: [1400, 435, 30, 30],
    children: [el('span', { path: 'body>div:4>span:1', text: 'Edit Content' }), el('button', { path: 'body>div:4>button:1' })],
  });
  const touches = new Map([['body>div:4>button:1', new Set(['body>iframe:1', 'body>div:4>span:1'])]]);
  const found = findExcludable(tree([bar, frame]), { viewWidths: WIDTHS, touches });
  assert.deepEqual(found.map((f) => f.reason).sort(), ['builder-control', 'builder-frame']);
  assert.equal(found.find((f) => f.reason === 'builder-control').path, 'body>div:4');
  assert.match(found.find((f) => f.reason === 'builder-frame').evidence, /framer\.com/);
});

test("a pinned control that does not touch the builder's frame stays, even when such a frame exists", () => {
  const frame = el('iframe', { path: 'body>iframe:1', style: { position: 'fixed' }, rect: [0, 0, 1440, 900], attrs: { src: 'https://framer.com/edit' } });
  const toTop = el('button', { path: 'body>button:1', style: { position: 'fixed' }, rect: [1380, 820, 40, 40], text: 'Top' });
  const touches = new Map([['body>button:1', new Set(['body'])]]);
  const found = findExcludable(tree([toTop, frame]), { viewWidths: WIDTHS, touches });
  assert.deepEqual(found.map((f) => f.path), ['body>iframe:1']);
});

test('a frame in the page flow from a service the page shows is never tooling', () => {
  const video = el('iframe', { path: 'body>iframe:1', rect: [0, 400, 800, 450], attrs: { src: 'https://www.youtube.com/embed/x' } });
  assert.deepEqual(findExcludable(tree([video]), { viewWidths: WIDTHS }), []);
});

test('excluded text is matched with its white space folded, as the box index keys it', () => {
  const keys = excludedFor([{ page: '/', text: 'Edit   Content' }], '/');
  assert.ok(keys.has('edit content'));
});
