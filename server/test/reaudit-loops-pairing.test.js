// The re-audit's "Looping animations kept" row pairs the original's loops with the copy's by the element that moves.
// Pairing by the kind of motion alone counted 2 of 16 on a copy that ran all 16 (found on a real site): the original's
// script motion is recorded as a drift or a dash ramp, the copy's rebuilt keyframes read back as another kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLoops } from '../src/reaudit/motion.js';

const loop = (o) => ({ source: 'script', pattern: 'drift', params: { channel: 'y' }, tag: 'div', rect: [100, 100, 400, 230], path: 'body>div:1', ...o });

test('script motion on the original and rebuilt keyframes of another kind in the copy pair by element', () => {
  const original = [
    loop({ path: 'body>div:1>div:7>div:3>div:5', rect: [519, 5524, 402, 232] }),
    loop({ path: 'body>div:1>div:7>div:3>div:6', rect: [520, 5518, 399, 231] }),
    loop({ tag: 'path', pattern: 'ramp', params: { channel: 'dash' }, path: 'body>div:2>svg:1>path:2', rect: [471, 4244, 250, 200] }),
  ];
  // The copy: an exact copy keeps two paths; the third element sits elsewhere in the copy's markup, at the same place.
  const copy = [
    loop({ source: 'css-animation', pattern: 'other', path: 'body>div:1>div:7>div:3>div:5', rect: [519, 5300, 402, 232] }),
    loop({ source: 'css-animation', pattern: 'other', path: 'body>div:1>div:7>div:3>div:6', rect: [520, 5600, 399, 231] }),
    loop({ tag: 'path', source: 'css-animation', pattern: 'dash', path: 'body>main:1>svg:1>path:2', rect: [480, 4250, 250, 200] }),
  ];
  assert.equal(matchLoops(original, copy), 3);
});

test('a loop that is gone from the copy is not paired with a different element', () => {
  const original = [loop({ path: 'body>a:1', rect: [0, 0, 100, 100] }), loop({ tag: 'ul', pattern: 'marquee', path: 'body>ul:1', rect: [0, 2000, 1300, 60] })];
  const copy = [loop({ tag: 'ul', pattern: 'marquee', path: 'body>ul:1', rect: [0, 2000, 1300, 60] })];
  assert.equal(matchLoops(original, copy), 1);
  assert.equal(matchLoops(original, []), 0);
});

test('one copy loop never answers for two loops of the original', () => {
  const original = [loop({ path: 'body>div:1' }), loop({ path: 'body>div:2' })];
  const copy = [loop({ path: 'body>div:1' })];
  assert.equal(matchLoops(original, copy), 1);
});
