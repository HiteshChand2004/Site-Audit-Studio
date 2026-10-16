// A site that renders other markup at other widths keeps one version per width in an exact copy (data-sas-v). Hover and
// focus effects are probed on the desktop layout, so only the desktop version of a button carried them - on a real Framer
// site the same button stood still at 390 px. shareHoverAcrossVersions gives the same element of the narrower versions
// the same tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareHoverAcrossVersions } from '../src/recreate/ir/asis.js';

const button = (v, motion, kidMotion) => ({
  t: 'button', attrs: { class: 'cta', 'data-sas-v': v, ...(motion && { 'data-motion': motion }) },
  children: [{ t: 'p', attrs: { ...(kidMotion && { 'data-motion': kidMotion }) }, children: [{ text: 'Submit' }] }],
});

test('the phone and tablet versions of a button get its desktop hover, inner parts included', () => {
  const body = {
    t: 'body', attrs: {}, children: [
      button('v1', 'h13', 'h13k1'),
      button('v2'),
      button('v3'),
      { t: 'a', attrs: { class: 'cta', 'data-sas-v': 'v3' }, children: [{ text: 'Other' }] },
    ],
  };
  const variants = new Map([['v1', ['desktop', 'laptop']], ['v2', ['tablet']], ['v3', ['mobile']]]);
  assert.equal(shareHoverAcrossVersions(body, variants), 4);
  for (const b of body.children.slice(1, 3)) {
    assert.equal(b.attrs['data-motion'], 'h13');
    assert.equal(b.children[0].attrs['data-motion'], 'h13k1');
  }
  assert.equal(body.children[3].attrs['data-motion'], undefined, 'another element of the phone version gets nothing');
});

test('only hover and focus tokens are shared; a version that has its own keeps it; no versions, nothing to do', () => {
  const body = {
    t: 'body', attrs: {}, children: [
      button('v1', 'h2 l4 rv', null),
      button('v2', 'h9', null),
      button('v3', 'f3', null),
    ],
  };
  const variants = new Map([['v1', ['desktop']], ['v2', ['tablet']], ['v3', ['mobile']]]);
  shareHoverAcrossVersions(body, variants);
  assert.equal(body.children[1].attrs['data-motion'], 'h9', 'its own hover stays');
  assert.equal(body.children[2].attrs['data-motion'], 'f3', 'its own focus stays');
  const shared = { t: 'body', attrs: {}, children: [{ t: 'button', attrs: { 'data-motion': 'h1' }, children: [] }] };
  assert.equal(shareHoverAcrossVersions(shared, new Map()), 0);
});

test('a loop or a reveal of the desktop version is never copied', () => {
  const body = { t: 'body', attrs: {}, children: [button('v1', 'h2 l4 rv r1', null), button('v2')] };
  shareHoverAcrossVersions(body, new Map([['v1', ['desktop']], ['v2', ['mobile']]]));
  assert.equal(body.children[1].attrs['data-motion'], 'h2');
});

// The rebuilt (normal) copy: one merged tree, where the phone version of a section is a node the desktop never draws.
test('rebuilt tree: an element drawn only at narrower widths gets the hover of its desktop twin', async () => {
  const { shareHoverWithNarrowTwins } = await import('../src/recreate/ir/motion.js');
  const view = (shown) => ({ style: {}, rect: shown ? [0, 0, 100, 40] : [0, 0, 0, 0], hidden: !shown });
  const btn = (desktop, mobile, tokens, kidTokens) => ({
    tag: 'button', attrs: {}, views: { desktop: view(desktop), mobile: view(mobile) }, ...(tokens && { motionTokens: tokens }),
    children: [{ tag: 'span', attrs: {}, views: { desktop: view(desktop), mobile: view(mobile) }, ...(kidTokens && { motionTokens: kidTokens }), children: [{ text: 'Get the app' }] }],
  });
  const desk = btn(true, false, ['h4'], ['h4k1']);
  const phone = btn(false, true);
  const other = { tag: 'button', attrs: {}, views: { mobile: view(true) }, children: [{ text: 'Something else' }] };
  const root = { tag: 'body', attrs: {}, views: { desktop: view(true), mobile: view(true) }, children: [desk, { tag: 'div', attrs: {}, views: { mobile: view(true) }, children: [phone, other] }] };
  assert.equal(shareHoverWithNarrowTwins(root), 2);
  assert.deepEqual(phone.motionTokens, ['h4']);
  assert.deepEqual(phone.children[0].motionTokens, ['h4k1']);
  assert.equal(other.motionTokens, undefined);
});
