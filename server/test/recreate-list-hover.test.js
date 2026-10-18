// A hover card in a list (ul / ol / menu): the rebuilt list holds only list items. A box around the card used to be a div
// inside the list (nyaayai/flexibench copies: the accessibility audit failed the list and its items on every page).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandHoverCards } from '../src/recreate/ir/states.js';

const el = (tag, children = [], attrs = {}) => ({ tag, attrs, views: { desktop: { style: {}, rect: [0, 0, 100, 40], hidden: false } }, children, cpath: `body>${tag}` });
const card = () => { const c = el('li', [el('button', [])]); c.hoverState = { node: el('li', [el('button', [])]) }; return c; };

test('a hover card in a list keeps the list valid: no div among the list items', () => {
  const list = el('ul', [el('li', []), card(), el('li', [])]);
  const root = el('body', [list]);
  expandHoverCards(root);
  const bad = list.children.filter((c) => c.tag !== 'li');
  assert.deepEqual(bad.map((c) => c.tag), [], 'every child of the list is a list item');
});

test('a hover card outside a list still gets its box (the copy shows on hover)', () => {
  const nav = el('nav', [card(), el('a', [])]);
  const root = el('body', [nav]);
  assert.equal(expandHoverCards(root), 1);
  assert.equal(nav.children[0].tag, 'div');
  assert.equal(nav.children[0].stateAttrs['data-w-hv'], '');
});
