// Full-site D.2: text that does not stand out from its background gets the closest shade of its colour that passes WCAG AA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, fixColor, fixContrast, parseColor } from '../src/recreate/fixers/contrast.js';

const view = (style = {}, rect = [0, 0, 200, 20], hidden = false) => ({ desktop: { style, rect, hidden } });
// Each element gets its own row on the page (y = 30 × its order), so nothing overlaps by accident.
let row = 0;
const el = (tag, style, ...children) => ({ tag, attrs: {}, views: view(style, [0, 30 * row++, 200, 20]), children });
const text = (t) => ({ text: t });
const tree = (root, htmlStyle = {}) => ({ info: { path: '/' }, root, htmlNode: { tag: 'html', views: view(htmlStyle), children: [root] } });

test('colours and the WCAG ratio', () => {
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30, 1]);
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30, 0.5]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.equal(parseColor('currentcolor'), null);
  assert.equal(Math.round(contrast([0, 0, 0], [255, 255, 255])), 21);
  assert.equal(Math.round(contrast([119, 119, 119], [255, 255, 255]) * 100) / 100, 4.48);
});

test('fixColor moves lightness away from the background, only as far as needed, hue kept', () => {
  const light = [150, 170, 230]; // a pale blue on white
  const out = fixColor(light, [255, 255, 255], 4.6);
  assert.ok(contrast(out, [255, 255, 255]) >= 4.6);
  assert.ok(contrast(out, [255, 255, 255]) < 5.2, 'not darker than needed');
  assert.ok(out[2] > out[0], 'still blue');
  const onDark = fixColor([70, 70, 90], [20, 20, 30], 4.6);
  assert.ok(onDark[0] > 70, 'lighter on a dark background');
});

test('fixContrast: light grey on white fixed, dark-on-dark fixed lighter, large text needs 3:1, images left open, fine text untouched', () => {
  const t = tree(el('body', {},
    el('p', { color: 'rgb(170, 170, 170)' }, text('Pale grey text that is hard to read')),
    el('p', {}, text('Normal black text')),
    el('h2', { color: 'rgb(140, 140, 140)', 'font-size': '32px' }, text('Large grey heading')),
    el('section', { 'background-color': 'rgb(20, 20, 30)', color: 'rgb(70, 70, 90)' }, el('p', {}, text('Dim text on a dark band'))),
    el('div', { 'background-image': 'url("asset:hero.jpg")', color: 'rgb(200, 200, 200)' }, el('p', {}, text('Text on a photo'))),
  ));
  const { fixed, open } = fixContrast(t);
  const byText = (s) => fixed.find((f) => f.text.startsWith(s));
  assert.ok(byText('Pale grey')?.after >= 4.5);
  assert.equal(byText('Normal black'), undefined);
  assert.equal(byText('Large grey'), undefined, '140 grey at 32 px passes 3:1');
  assert.ok(byText('Dim text')?.after >= 4.5);
  assert.equal(open.length, 1);
  assert.match(open[0].reason, /image or gradient/);
  // The colour is written on the node itself: the stylesheet built afterwards carries it.
  assert.match(t.root.children[0].views.desktop.style.color, /^#[0-9a-f]{6}$/);
});

test('white text over a photo that sits behind it as a sibling is left alone (open), never darkened', () => {
  const hero = { tag: 'section', attrs: {}, views: view({}, [0, 0, 1000, 500]), children: [
    { tag: 'img', attrs: {}, views: view({}, [0, 0, 1000, 500]), children: [] },
    { tag: 'h1', attrs: {}, views: view({ color: 'rgb(255, 255, 255)', 'font-size': '48px' }, [100, 200, 600, 60]), children: [text('Hero headline')] },
  ] };
  const t = tree(el('body', {}, hero));
  const { fixed, open } = fixContrast(t);
  assert.deepEqual(fixed, []);
  assert.equal(open.length, 1);
  assert.equal(hero.children[1].views.desktop.style.color, 'rgb(255, 255, 255)');
});

test('a dark page whose colours are set on <html> is judged against them', () => {
  const t = tree(el('body', {}, el('p', {}, text('Light text on a dark page'))), { 'background-color': 'rgb(15, 15, 20)', color: 'rgb(235, 235, 235)' });
  assert.deepEqual(fixContrast(t).fixed, []);
});
