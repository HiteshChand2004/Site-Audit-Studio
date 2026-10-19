// Full-site D.6: each page carries only the rules it uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageCss, usedBy } from '../src/recreate/emit/pageCss.js';

const CSS = `/* Site: generated */
:root {
  --brand: #0f766e;
}
@font-face {
  font-family: "Brand";
  src: url("../assets/fonts/b.woff2") format("woff2");
}
*, ::before, ::after {
  box-sizing: border-box;
}
a {
  color: inherit;
}
.hero {
  display: grid;
  grid-template-areas: "a b"
    "c d";
}
.hero::before {
  content: "{ not a block }";
}
.other-page {
  color: red;
}
.card, .unused {
  padding: 4px;
}
.card .unused {
  margin: 0;
}
.spin {
  animation: spin 2s linear infinite;
}
@keyframes spin {
  to {
    rotate: 360deg;
  }
}
@keyframes never {
  to {
    opacity: 0;
  }
}
@media (hover: hover) {
  [data-motion~="h1"]:hover {
    color: var(--brand);
  }
  [data-motion~="h9"]:hover {
    color: blue;
  }
}
.js-motion [data-motion~="r1"]:not(.is-in) {
  opacity: 0;
}
[data-w~="dp2"].w-open {
  display: block;
}`;

test('usedBy collects classes and tokens; the filter keeps what the page uses', () => {
  const body = { t: 'body', class: 'page', children: [
    { t: 'div', class: 'hero', attrs: { 'data-motion': 'h1 r1' }, children: [] },
    { t: 'div', class: 'card spin', attrs: { 'data-w': 'dp2' }, children: [] },
  ] };
  const used = usedBy(body);
  assert.deepEqual([...used.classes].sort(), ['card', 'hero', 'page', 'spin']);
  assert.deepEqual([...used.tokens].sort(), ['dp2', 'h1', 'r1']);
  const css = pageCss(CSS, used);
  for (const kept of [':root{', '@font-face{', '*, ::before, ::after{', 'a{', '.hero{', '.hero::before{content: "{ not a block }";}', '.card, .unused{', '.spin{', '@keyframes spin{',
    '[data-motion~="h1"]:hover{', '.js-motion [data-motion~="r1"]:not(.is-in){', '[data-w~="dp2"].w-open{']) assert.ok(css.includes(kept), `kept ${kept}`);
  for (const dropped of ['.other-page', '.card .unused{', '@keyframes never', 'h9']) assert.ok(!css.includes(dropped), `dropped ${dropped}`);
  assert.match(css, /grid-template-areas: "a b" "c d";/, 'multi-line values keep a space');
  assert.doesNotMatch(css, /\n/);
  assert.doesNotMatch(css, /generated/, 'comments go');
  assert.match(css, /@media \(hover: hover\)\{\[data-motion~="h1"\]:hover\{color: var\(--brand\);\}\}/);
});

test('a page that uses none of the classes still gets the element rules and the tokens it has', () => {
  const css = pageCss(CSS, usedBy({ t: 'body', children: [] }));
  assert.ok(css.includes('a{color: inherit;}'));
  assert.ok(!css.includes('.hero'));
  assert.ok(!css.includes('@media'), 'an at-rule left empty goes too');
});
