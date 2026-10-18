// A feed area (a carousel or a list that changes by itself) holds the elements the page shows now and the states it shows in
// turn. The rebuild used to leave EVERY scroll reveal inside such an area to the feed, so the visible slide lost its reveal
// (nyaayai: 132 reveals on the original, 6 on the copy). Only what the page does not show now is left to the feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMotion } from '../src/recreate/ir/motion.js';

const node = (cpath, tag, children = [], style = {}) => ({ tag, cpath, attrs: {}, views: { desktop: { style, rect: [0, 0, 100, 40], hidden: false } }, children });
const reveal = (path) => ({
  path, tag: 'p', text: '', rect: [0, 900, 100, 40],
  from: { opacity: 0, transform: 'matrix(1, 0, 0, 1, 0, 16)', filter: 'none', motion: { translate: [0, 16], scale: [1, 1], rotate: 0 } },
  to: { opacity: 1, transform: 'none', filter: 'none', motion: { translate: [0, 0], scale: [1, 1], rotate: 0 } },
  timing: { source: 'transition', duration: 700, delay: 0, easing: { css: 'cubic-bezier(0.16, 1, 0.3, 1)' } },
  trigger: { kind: 'scroll', step: 1, topBefore: 1.4, topAfter: 0.5 }, replay: false, group: 'r1',
});

test('a feed area: the slide the page shows keeps its scroll reveal; a state the page does not show is left to the feed', () => {
  // body > feed area (a carousel) > the visible slide's element (in the tree); a second slide is a state, not in the tree.
  const visible = node('body>div:1>div:1', 'div');
  const feed = node('body>div:1', 'div', [visible]);
  feed.stateAttrs = { 'data-w-feed': '' };
  const root = node('body', 'body', [feed]);
  const site = { pages: [{ info: { path: '/', url: 'http://x.test/' }, root }] };
  const motion = {
    hover: [], focus: [],
    reveal: { elements: [reveal('body>div:1>div:1'), reveal('body>div:1>div:9')] },
    loops: { loops: [] },
  };
  const { stats } = applyMotion(site, new Map([['/', motion]]));
  assert.ok(visible.motionTokens?.includes('rv'), 'the visible slide keeps its scroll reveal');
  assert.equal(stats.reveal.skipped.feed, 1, 'only the state the page does not show is left to the feed');
});
