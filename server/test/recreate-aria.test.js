// Full-site D.4: accessibility rules fixed mechanically, without changing the look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixAria } from '../src/recreate/fixers/aria.js';

const el = (tag, attrs = {}, ...children) => ({ tag, attrs, views: { desktop: { style: {}, rect: [0, 0, 10, 10], hidden: false } }, children });

test('duplicate ids, frame titles, positive tabindex, invalid ARIA values, focusable inside aria-hidden', () => {
  const panel = el('div', { 'aria-hidden': 'true' }, el('a', { href: '/x' }));
  panel.widgetTokens = ['dp3'];
  const tree = { info: { path: '/' }, root: el('body', {},
    el('div', { id: 'intro' }), el('section', { id: 'intro' }),
    el('iframe', { src: 'https://www.youtube.com/embed/abc' }),
    el('iframe', { src: 'https://maps.example.com/x', title: 'Our office' }),
    el('button', { tabindex: '3' }),
    el('button', { 'aria-expanded': '', 'aria-pressed': 'mixed', 'aria-label': 'Menu' }),
    el('div', { 'aria-hidden': 'true' }, el('a', { href: '/hidden' }), el('span', {})),
    panel,
  ) };
  const { fixed } = fixAria(tree);
  const [d1, d2, f1, f2, tab, aria, hidden, widgetPanel] = tree.root.children;
  assert.equal(d1.attrs.id, 'intro');
  assert.equal(d2.attrs.id, 'intro-2');
  assert.equal(f1.attrs.title, 'Embedded content from youtube.com');
  assert.equal(f2.attrs.title, 'Our office', 'an existing title is kept');
  assert.equal(tab.attrs.tabindex, '0');
  assert.equal(aria.attrs['aria-expanded'], undefined, 'an empty true/false value goes');
  assert.equal(aria.attrs['aria-pressed'], 'mixed', 'a valid value stays');
  assert.equal(aria.attrs['aria-label'], 'Menu');
  assert.equal(hidden.children[0].attrs.tabindex, '-1', 'a link inside aria-hidden leaves the Tab order');
  assert.equal(hidden.children[1].attrs.tabindex, undefined);
  assert.equal(widgetPanel.attrs['aria-hidden'], undefined, 'a panel the script opens is not aria-hidden');
  assert.equal(widgetPanel.children[0].attrs.tabindex, undefined, 'its links stay reachable');
  assert.deepEqual([...new Set(fixed.map((f) => f.rule))].sort(), ['aria-hidden-focus', 'aria-hidden-panel', 'aria-valid-attr-value', 'duplicate-id', 'frame-title', 'tabindex']);
});
