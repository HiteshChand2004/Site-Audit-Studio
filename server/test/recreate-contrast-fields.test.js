// Form fields (input, textarea, select) carry their own text colour (what is typed, and the placeholder). The contrast fixer
// used to look only at elements with text children, so a grey field on a white footer (nyaayai: #999 on #fff, 2.84:1) was
// never checked, and the audit's finding for it had nothing to match. A field is now checked like any text it shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axeContrastFindings, fixContrast, parseColor, ratio } from '../src/recreate/fixers/contrast.js';

const view = (style = {}, rect = [0, 0, 300, 40]) => ({ style, rect, hidden: false });
const el = (tag, children = [], { style = {}, attrs = {}, ...rest } = {}) => ({ tag, attrs, views: { desktop: view(style) }, children, ...rest });
const WHITE = [255, 255, 255, 1];

test('a grey form field on a white footer is checked and its colour made to pass (the audit\'s finding)', () => {
  const axe = { violations: [{ id: 'color-contrast', nodes: [{
    html: '<input class="footer-form-field" placeholder="Your Email" type="email" value="" name="Email">',
    any: [{ id: 'color-contrast', data: { fgColor: '#999999', bgColor: '#ffffff', contrastRatio: 2.84, expectedContrastRatio: '4.5:1' } }],
  }] }] };
  const field = el('input', [], { attrs: { class: 'footer-form-field', type: 'email', placeholder: 'Your Email' }, style: { color: 'rgb(153, 153, 153)' } });
  const t = { info: { path: '/' }, root: el('body', [el('footer', [el('form', [field])], { style: { 'background-color': 'rgb(255, 255, 255)' } })]) };
  const out = fixContrast(t, { axe: axeContrastFindings(axe) });
  assert.ok(out.fixed.some((f) => f.element === 'input' && f.field === 'color'), 'the field\'s colour is fixed');
  assert.ok(ratio(parseColor(field.views.desktop.style.color), WHITE) >= 4.5, 'and it now reaches 4.5:1 on white');
});

test('a grey field is checked from its own style too, when the audit did not scan it', () => {
  const field = el('textarea', [], { attrs: { placeholder: 'Message' }, style: { color: 'rgb(153, 153, 153)' } });
  const t = { info: { path: '/' }, root: el('body', [el('form', [field], { style: { 'background-color': 'rgb(255, 255, 255)' } })]) };
  assert.equal(fixContrast(t).fixed.length, 1);
  assert.ok(ratio(parseColor(field.views.desktop.style.color), WHITE) >= 4.5);
});
