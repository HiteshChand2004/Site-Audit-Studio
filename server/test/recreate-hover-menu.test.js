// Hover menus a script adds next to their link, and boxes caught in the first pose of an entrance (fix-all, parchaa): the
// copy's tree side. Small trees, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandHoverCards } from '../src/recreate/ir/states.js';
import { applyMotion } from '../src/recreate/ir/motion.js';

const view = (rect, style = {}) => ({ rect, style, hidden: false });
const el = (tag, children = [], views = { desktop: view([0, 0, 100, 30]) }, extra = {}) => ({ tag, attrs: {}, views, children, ...extra });

test('a hover menu next to other links: link and hovered copy share a box that draws nothing', () => {
  const copy = el('div', [el('a', [{ text: 'Platforms' }]), el('div', [el('a', [{ text: 'HMIS' }])])]);
  const item = el('div', [el('a', [{ text: 'Platforms' }])], { desktop: view([300, 20, 90, 30]) }, { hoverState: { node: copy } });
  const other = el('div', [el('a', [{ text: 'Company' }])]);
  const bar = el('nav', [item, other]);
  const root = el('body', [bar]);
  assert.equal(expandHoverCards(root), 1);
  const box = bar.children[0];
  assert.equal(box.views.desktop.style.display, 'contents');
  assert.ok('data-w-hv' in box.stateAttrs);
  assert.deepEqual(box.children.map((c) => Object.keys(c.stateAttrs ?? {})), [['data-w-hrest'], ['data-w-hcopy']]);
  assert.equal(bar.children[1], other, 'the other links stay where they were');
  // A card alone in its cell keeps using the cell (no extra box).
  const card = el('div', [el('p', [{ text: 'Card' }])], undefined, { hoverState: { node: el('div', [el('p', [{ text: 'Card hovered' }])]) } });
  const cell = el('div', [card]);
  expandHoverCards(el('body', [el('main', [cell])]));
  assert.ok('data-w-hv' in cell.stateAttrs);
  assert.equal(cell.children.length, 2);
});

test('a box caught invisible in the first pose of an entrance is shown and gets the entrance back as a scroll reveal', () => {
  const frozen = (style) => el('div', [el('p', [{ text: 'The Role of AI in Global Health' }])], {
    desktop: view([100, 2000, 300, 200], { opacity: '0', transform: 'matrix(0.9, 0, 0, 0.9, 0, 0)', position: 'relative', ...style }),
    laptop: view([100, 2000, 300, 200], {}),
  });
  const card = frozen();
  const overlay = frozen({ position: 'absolute' }); // a hover layer: hidden on purpose
  const empty = el('div', [], { desktop: view([100, 2400, 300, 200], { opacity: '0', transform: 'matrix(0.9, 0, 0, 0.9, 0, 0)' }) });
  const slide = el('div', [el('p', [{ text: 'Slide 2' }])], { desktop: view([1500, 2000, 300, 200], { opacity: '0', transform: 'translateX(40px)' }) });
  const row = el('div', [card, overlay, empty, slide], { desktop: view([0, 1900, 1440, 500]), laptop: view([0, 1900, 1024, 500]) });
  const site = { pages: [{ info: { path: '/' }, root: el('body', [row], { desktop: view([0, 0, 1440, 3000]) }) }] };
  const { motion, stats } = applyMotion(site, new Map());
  assert.equal(stats.reveal.frozen, 1);
  assert.equal(card.views.desktop.style.opacity, undefined, 'shown as it ends');
  assert.equal(card.views.desktop.style.transform, undefined);
  assert.ok(card.motionTokens.includes('rv'));
  const effect = motion.reveal.find((r) => card.motionTokens.includes(r.token));
  assert.equal(effect.opacity, 0);
  assert.deepEqual(effect.scale, [0.9, 0.9]);
  assert.equal(motion.script, true, 'the reveal script is shipped');
  for (const n of [overlay, empty, slide]) assert.equal(n.views.desktop.style.opacity, '0', 'left as captured');
});

test('a menu drawn as a layer of its own is moved into its link box at the same offset', async () => {
  const { attachLayer } = await import('../src/recreate/capture/states.js');
  const box = { tag: 'div', style: {}, rect: [560, 50, 90, 33], children: [{ tag: 'a', style: {}, rect: [560, 50, 90, 33], children: [] }] };
  const layer = { tag: 'div', path: 'body>div:2', style: { position: 'fixed', top: '83px', left: '0px', transform: 'matrix(1, 0, 0, 1, 555, 0)', 'z-index': '10' }, rect: [555, 83, 125, 248], children: [{ tag: 'a', style: {}, rect: [570, 95, 60, 20], children: [] }] };
  attachLayer(box, layer);
  assert.equal(box.style.position, 'relative', 'the link box holds the layer');
  const moved = box.children[1];
  assert.deepEqual([moved.style.position, moved.style.left, moved.style.top, moved.style.transform, moved.style['z-index']], ['absolute', '-5px', '33px', undefined, '10']);
  assert.equal(moved.path, undefined);
});
