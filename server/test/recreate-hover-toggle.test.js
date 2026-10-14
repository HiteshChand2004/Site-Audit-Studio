// Hover and toggles, original against copy, through the real pipeline (capture, assets, generate, build; the measuring
// steps stubbed) in normal and in exact mode, checked in a real browser on the built copy:
//   - hovering one nav link changes that link only (a header with a transition of its own holds the links: probing
//     the header with the mouse lands on one of them, and that link's own hover must not become the header's);
//   - a neighbour rule (`.tile:hover + .tile`) changes the hovered tile's neighbour only, not every later tile;
//   - a menu item holding a submenu (`li:hover > a`) colours its own link, not the submenu's links;
//   - a button's hover background is the original's, after the transition - also one a script animates over the
//     rule's (the rule probe cannot see it, the real mouse can);
//   - FAQs of seven kinds (independent or one at a time; answers shown by class, by the hidden attribute, by a measured
//     height, by max-height, or drawn only while open; the first open at load; ten questions of which the probe clicks
//     three; focusable boxes with a button role) open on a click, close on a second one, keep their answers to their
//     questions, keep several open or one open as the original does, keep aria-expanded in step, and answer Enter / Space.
// The pure pieces (pointer crediting, the rule + mouse merge, neighbour and nested tokens, panels that start open,
// controls one to a block) are tested first, without a browser.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { servePreview } from '../src/recreate/preview.js';
import { creditUnderPointer, mergeMouseIntoRule } from '../src/recreate/capture/interactions.js';
import { planSets, samePlace } from '../src/recreate/capture/states.js';
import { applyMotion, closedOnClick, shutDecls } from '../src/recreate/ir/motion.js';
import { motionCss } from '../src/recreate/emit/motionCss.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
const PORT = 4251;
const origin = `http://localhost:${PORT}`;

const HEAD = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
body { margin: 0; font: 16px/1.4 Arial, sans-serif; color: #222; }
.site-header { display: flex; align-items: center; justify-content: center; gap: 40px; padding: 16px 40px; background: #fff; transition: background-color .3s ease, box-shadow .3s ease; }
.logo { font-weight: 700; color: #111; text-decoration: none; }
.main-nav { display: flex; transition: opacity .3s ease; }
.main-nav a { color: rgb(51, 51, 51); text-decoration: none; padding: 0 14px; transition: color .35s ease; }
.main-nav a:hover { color: rgb(194, 65, 12); }
main { padding: 24px 40px; }
`;

const HOME = `${HEAD('Hover')}
.actions { display: flex; gap: 16px; margin: 32px 0; }
.btn { display: inline-block; padding: 12px 22px; border: 0; border-radius: 6px; font: inherit; color: #fff; background-color: rgb(31, 41, 55); cursor: pointer; transition: background-color .5s ease, transform .5s ease; }
.btn:hover { background-color: rgb(194, 65, 12); transform: translateY(-2px); }
.btn.ghost { background-color: transparent; color: rgb(31, 41, 55); box-shadow: inset 0 0 0 2px rgb(31, 41, 55); }
.btn.ghost:hover { background-color: rgb(31, 41, 55); color: #fff; }
.cards { display: flex; gap: 20px; }
.card { width: 220px; padding: 16px; border: 1px solid #ddd; }
.card a { color: rgb(29, 78, 216); text-decoration: none; transition: color .3s ease; }
.card a:hover { color: rgb(30, 58, 138); text-decoration: underline; }
.tiles { display: flex; gap: 12px; margin: 32px 0; }
.tile { width: 120px; padding: 20px 0; text-align: center; background-color: rgb(243, 244, 246); transition: background-color .3s ease; }
.tile:hover + .tile { background-color: rgb(254, 215, 170); }
.menu, .menu ul { list-style: none; margin: 0; padding: 0; }
.menu { display: flex; gap: 40px; margin: 32px 0; }
.menu ul { padding-left: 16px; }
.menu a { color: rgb(75, 85, 99); text-decoration: none; transition: color .3s ease; }
.menu li:hover > a { color: rgb(194, 65, 12); }
footer { padding: 24px 40px; }
footer a { color: rgb(80, 80, 80); margin-right: 18px; }
</style></head><body>
<header class="site-header"><a class="logo" href="/">Brand</a><nav class="main-nav"><a href="/faq">Questions</a><a href="/accordion">Accordion</a><a href="/#about">About</a><a href="/#work">Work</a><a href="/#contact">Contact</a></nav></header>
<main>
<h1 id="about">Hover</h1>
<div class="actions"><button type="button" class="btn">Get started</button><a class="btn ghost" href="/#work">See the work</a><button type="button" class="btn js" id="js-btn">Book a call</button></div>
<div class="cards" id="work"><div class="card"><h3>One</h3><p>Text one.</p><a href="/faq">Read one</a></div><div class="card"><h3>Two</h3><p>Text two.</p><a href="/faq">Read two</a></div><div class="card"><h3>Three</h3><p>Text three.</p><a href="/faq">Read three</a></div></div>
<div class="tiles"><div class="tile">Tile A</div><div class="tile">Tile B</div><div class="tile">Tile C</div><div class="tile">Tile D</div></div>
<ul class="menu"><li><a href="/faq">Products</a><ul><li><a href="/faq">Annotate</a></li><li><a href="/accordion">Benchmark</a></li></ul></li><li><a href="/faq">Company</a><ul><li><a href="/faq">Team</a></li><li><a href="/accordion">Careers</a></li></ul></li></ul>
</main>
<footer id="contact"><a href="/faq">Help</a><a href="/accordion">Terms</a><a href="/#about">Privacy</a></footer>
<script>
  // A hover the page draws with script (no :hover rule): the background eases to a colour over ~300 ms.
  var b = document.getElementById('js-btn');
  b.style.backgroundColor = 'rgb(55, 65, 81)';
  var anim = null;
  function to(c) { if (anim) anim.cancel(); anim = b.animate([{ backgroundColor: getComputedStyle(b).backgroundColor }, { backgroundColor: c }], { duration: 300, fill: 'forwards' }); }
  b.addEventListener('mouseenter', function () { to('rgb(22, 163, 74)'); });
  b.addEventListener('mouseleave', function () { to('rgb(55, 65, 81)'); });
</script></body></html>`;

const FAQ_STYLE = `.faq { width: 640px; margin: 24px 0; }
.item { border-bottom: 1px solid #ddd; }
.q { display: block; width: 100%; padding: 14px 0; border: 0; background: none; text-align: left; font: inherit; color: #111; cursor: pointer; }
.a { display: none; padding: 0 0 14px; color: #444; }
.item.open .a { display: block; }
.item.open .q { font-weight: 700; }
`;
const FAQ_ITEMS = [['What is it?', 'A tool for teams.'], ['How much does it cost?', 'It is free for everyone.'], ['Where does it run?', 'In any browser.'], ['Can I export?', 'Yes, as a zip.']];
const faqMarkup = (cls) => `<div class="faq ${cls}">${FAQ_ITEMS.map(([q, a], i) => `<div class="item"><button type="button" class="q" aria-expanded="false" aria-controls="${cls}-a${i}">${q}</button><div class="a" id="${cls}-a${i}">${a}</div></div>`).join('')}</div>`;

const NAV = '<header class="site-header"><a class="logo" href="/">Brand</a><nav class="main-nav"><a href="/faq">Questions</a><a href="/accordion">Accordion</a><a href="/faq-render">Rendered</a><a href="/faq-height">Sliding</a><a href="/faq-div">Panels</a><a href="/faq-long">Long</a><a href="/faq-many">Many</a><a href="/faq-swap">Swap</a></nav></header>';

// Independent questions: each opens and closes by itself, several can be open.
const FAQ = `${HEAD('Questions')}${FAQ_STYLE}</style></head><body>
${NAV}
<main><h1>Questions</h1>${faqMarkup('free')}</main>
<script>
  document.querySelectorAll('.free .q').forEach(function (q) {
    q.addEventListener('click', function () {
      var item = q.parentElement; var open = item.classList.toggle('open');
      q.setAttribute('aria-expanded', String(open));
    });
  });
</script></body></html>`;

// An accordion: one answer at a time, a second click on the open question closes it.
const ACCORDION = `${HEAD('Accordion')}${FAQ_STYLE}</style></head><body>
${NAV}
<main><h1>Accordion</h1>${faqMarkup('one')}</main>
<script>
  var qs = document.querySelectorAll('.one .q');
  qs.forEach(function (q) {
    q.addEventListener('click', function () {
      var item = q.parentElement; var open = !item.classList.contains('open');
      qs.forEach(function (o) { o.parentElement.classList.remove('open'); o.setAttribute('aria-expanded', 'false'); });
      if (open) { item.classList.add('open'); q.setAttribute('aria-expanded', 'true'); }
    });
  });
</script></body></html>`;


// Independent questions whose answer the page's script renders only while it is open (and removes again).
const FAQ_RENDER = `${HEAD('Rendered')}${FAQ_STYLE}.a { display: block; }</style></head><body>
${NAV}<main><h1>Rendered</h1><div class="faq" id="list"></div></main>
<script>
  var items = ${JSON.stringify(FAQ_ITEMS)};
  var list = document.getElementById('list');
  items.forEach(function (it) {
    var d = document.createElement('div'); d.className = 'item';
    var b = document.createElement('button'); b.type = 'button'; b.className = 'q'; b.textContent = it[0]; b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', function () {
      var a = d.querySelector('.a');
      if (a) { a.remove(); b.setAttribute('aria-expanded', 'false'); }
      else { a = document.createElement('div'); a.className = 'a'; a.textContent = it[1]; d.appendChild(a); b.setAttribute('aria-expanded', 'true'); }
    });
    d.appendChild(b); list.appendChild(d);
  });
</script></body></html>`;

// Independent questions whose answer slides open: the script sets the height it measures, the icon turns.
const FAQ_HEIGHT = `${HEAD('Sliding')}${FAQ_STYLE}.a { display: block; height: 0; overflow: hidden; padding: 0; transition: height .3s ease; }
.icon { display: inline-block; margin-left: 8px; transition: transform .3s ease; }
.item.open .icon { transform: rotate(45deg); }</style></head><body>
${NAV}<main><h1>Sliding</h1><div class="faq slide">${FAQ_ITEMS.map(([q, a]) => `<div class="item"><button type="button" class="q" aria-expanded="false">${q}<span class="icon" aria-hidden="true">+</span></button><div class="a"><p style="margin:0;padding:0 0 14px">${a}</p></div></div>`).join('')}</div></main>
<script>
  document.querySelectorAll('.slide .q').forEach(function (q) {
    q.addEventListener('click', function () {
      var item = q.parentElement; var a = item.querySelector('.a'); var open = item.classList.toggle('open');
      a.style.height = open ? a.scrollHeight + 'px' : '0px';
      q.setAttribute('aria-expanded', String(open));
    });
  });
</script></body></html>`;

// One answer at a time; the questions are focusable boxes with a button role that answer Enter and Space themselves,
// and the answers are hidden with the hidden attribute.
const FAQ_DIV = `${HEAD('Panels')}${FAQ_STYLE}.a { display: block; } .a[hidden] { display: none; } .q:focus-visible { outline: 2px solid #c2410c; }</style></head><body>
${NAV}<main><h1>Panels</h1><div class="faq panels">${FAQ_ITEMS.map(([q, a]) => `<div class="item"><div class="q" role="button" tabindex="0" aria-expanded="false">${q}</div><div class="a" hidden>${a}</div></div>`).join('')}</div></main>
<script>
  var qs = document.querySelectorAll('.panels .q');
  function toggle(q) {
    var open = q.getAttribute('aria-expanded') !== 'true';
    qs.forEach(function (o) { o.setAttribute('aria-expanded', 'false'); o.nextElementSibling.hidden = true; });
    if (open) { q.setAttribute('aria-expanded', 'true'); q.nextElementSibling.hidden = false; }
  }
  qs.forEach(function (q) {
    q.addEventListener('click', function () { toggle(q); });
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(q); } });
  });
</script></body></html>`;

const LONG_ITEMS = Array.from({ length: 10 }, (_, i) => [`Question number ${i + 1}?`, `Answer number ${i + 1}.`]);

// Ten questions, one answer at a time, the first open when the page loads: the question is a button inside a heading,
// the answer opens its max-height, the mark beside the question turns.
const FAQ_LONG = `${HEAD('Long')}${FAQ_STYLE}.a { display: block; max-height: 0; overflow: hidden; padding: 0; transition: max-height .35s ease; }
.a p { margin: 0; padding: 0 0 14px; } h3 { margin: 0; font-size: 16px; }
.mark { display: inline-block; margin-left: 8px; transition: transform .3s ease; }
.item.expanded .a { max-height: 400px; } .item.expanded .mark { transform: rotate(180deg); }</style></head><body>
${NAV}<main><h1>Long</h1><div class="faq long">${LONG_ITEMS.map(([q, a], i) => `<div class="item${i === 0 ? ' expanded' : ''}"><h3><button type="button" class="q" aria-expanded="${i === 0}">${q}<span class="mark" aria-hidden="true">v</span></button></h3><div class="a"><p>${a}</p></div></div>`).join('')}</div></main>
<script>
  var items = document.querySelectorAll('.long .item');
  items.forEach(function (item) {
    var q = item.querySelector('.q');
    q.addEventListener('click', function () {
      var open = !item.classList.contains('expanded');
      items.forEach(function (o) { o.classList.remove('expanded'); o.querySelector('.q').setAttribute('aria-expanded', 'false'); });
      if (open) { item.classList.add('expanded'); q.setAttribute('aria-expanded', 'true'); }
    });
  });
</script></body></html>`;

// Ten questions, one answer at a time, the first open: the page's script re-renders the list on every click and draws
// only the open answer.
const FAQ_MANY = `${HEAD('Many')}${FAQ_STYLE}.a { display: block; }</style></head><body>
${NAV}<main><h1>Many</h1><div class="faq" id="many"></div></main>
<script>
  var items = ${JSON.stringify(LONG_ITEMS)};
  var open = 0;
  function render() {
    var list = document.getElementById('many'); list.innerHTML = '';
    items.forEach(function (it, i) {
      var d = document.createElement('div'); d.className = 'item';
      var b = document.createElement('button'); b.type = 'button'; b.className = 'q'; b.textContent = it[0]; b.setAttribute('aria-expanded', String(open === i));
      b.addEventListener('click', function () { open = open === i ? -1 : i; render(); document.querySelectorAll('#many .q')[i].focus(); });
      d.appendChild(b);
      if (open === i) { var a = document.createElement('div'); a.className = 'a'; a.textContent = it[1]; d.appendChild(a); }
      list.appendChild(d);
    });
  }
  render();
</script></body></html>`;

// One answer at a time, drawn only while open, the way a component library updates the page: the click removes the open
// answer and adds the new one in its own item, nothing else changes.
const FAQ_SWAP = `${HEAD('Swap')}${FAQ_STYLE}.a { display: block; }</style></head><body>
${NAV}<main><h1>Swap</h1><div class="faq swap">${LONG_ITEMS.slice(0, 6).map(([q]) => `<div class="item"><button type="button" class="q" aria-expanded="false">${q}</button></div>`).join('')}</div></main>
<script>
  var answers = ${JSON.stringify(LONG_ITEMS.slice(0, 6).map(([, a]) => a))};
  var items = document.querySelectorAll('.swap .item');
  items.forEach(function (item, i) {
    var q = item.querySelector('.q');
    q.addEventListener('click', function () {
      var was = item.querySelector('.a');
      items.forEach(function (o) { var a = o.querySelector('.a'); if (a) a.remove(); o.querySelector('.q').setAttribute('aria-expanded', 'false'); });
      if (!was) { var a = document.createElement('div'); a.className = 'a'; a.textContent = answers[i]; item.appendChild(a); q.setAttribute('aria-expanded', 'true'); }
    });
  });
</script></body></html>`;

// --- The pure pieces -------------------------------------------------------------------------------------------------

test('a change inside the element under the mouse is that element\'s own hover, not the probed container\'s', () => {
  const link = 'body>header:1>nav:1>a:2';
  const red = { color: ['rgb(51, 51, 51)', 'rgb(194, 65, 12)'] };
  const entry = () => ({ path: 'body>header:1', changes: {}, chain: [link, 'body>header:1>nav:1'], kids: [{ path: link, changes: { ...red } }] });
  // The link hovers by itself and its own hover is that colour: handed back.
  const a = entry();
  assert.equal(creditUnderPointer([a], { effectOf: new Map([[link, { path: link, changes: red }]]), measured: new Set([link]), subjects: new Set([link]) }), 1);
  assert.equal(a.kids, undefined);
  // Never measured on its own: it cannot say, so the change is not spread over the header either.
  const b = entry();
  creditUnderPointer([b], { effectOf: new Map(), measured: new Set(), subjects: new Set([link]) });
  assert.equal(b.kids, undefined);
  // Measured on its own with no such change: the header really does it (`header:hover a`), so it stays.
  const c = entry();
  creditUnderPointer([c], { effectOf: new Map(), measured: new Set([link]), subjects: new Set([link]) });
  assert.deepEqual(c.kids, [{ path: link, changes: red }]);
  // Not a hover subject of its own (a plain span): the header's.
  const d = entry();
  creditUnderPointer([d], { effectOf: new Map(), measured: new Set(), subjects: new Set() });
  assert.equal(d.kids.length, 1);
});

test('the real mouse adds to a rule\'s hover what a script does on top, and never overrules a value the rule read', () => {
  const rule = { path: 'body>button:1', source: 'css', changes: { transform: ['none', 'matrix(1, 0, 0, 1, 0, -2)'], opacity: ['1', '0.9'] } };
  const mouse = { path: 'body>button:1', changes: { transform: ['none', 'matrix(1, 0, 0, 1, 0, -2)'], opacity: ['1', '0.95'], 'background-color': ['rgb(55, 65, 81)', 'rgb(22, 163, 74)'] } };
  assert.deepEqual(mergeMouseIntoRule(rule, mouse), ['background-color']);
  assert.equal(rule.source, 'css+probe');
  assert.deepEqual(rule.changes['background-color'], ['rgb(55, 65, 81)', 'rgb(22, 163, 74)']);
  assert.deepEqual(rule.changes.opacity, ['1', '0.9'], 'the rule probe read it with transitions off');
  const same = { path: 'x', source: 'css', changes: { color: ['a', 'b'] } };
  assert.deepEqual(mergeMouseIntoRule(same, { changes: { color: ['a', 'b'] } }), []);
  assert.equal(same.source, 'css', 'nothing added: still the site\'s own rule');
});

// A tiny IR page: an element per path, children by path.
function irPage(paths, extra = {}) {
  const byPath = new Map();
  const node = (cpath) => ({ tag: cpath.split('>').at(-1).split(':')[0], attrs: { ...(extra[cpath] ?? {}) }, views: { desktop: { style: {}, rect: [0, 0, 100, 20] } }, children: [], cpath });
  const root = node('body');
  byPath.set('body', root);
  for (const p of paths) {
    const n = node(p);
    byPath.set(p, n);
    byPath.get(p.slice(0, p.lastIndexOf('>'))).children.push(n);
  }
  return { site: { pages: [{ info: { path: '/', url: 'http://x/' }, root }], assetResolve: () => null }, byPath };
}

test('a neighbour effect is paired with its own neighbour only (`.tile:hover + .tile` restyled every later tile)', () => {
  const tiles = [1, 2, 3, 4].map((i) => `body>div:1>div:${i}`);
  const { site, byPath } = irPage(['body>div:1', ...tiles]);
  const bg = { 'background-color': ['rgb(243, 244, 246)', 'rgb(254, 215, 170)'] };
  const hover = tiles.slice(0, 3).map((p, i) => ({ path: p, source: 'css', changes: {}, sibs: [{ path: tiles[i + 1], rel: 'next', changes: bg }] }));
  const { motion } = applyMotion(site, new Map([['/', { hover }]]));
  const hosts = tiles.slice(0, 3).map((p) => byPath.get(p).motionTokens.find((t) => /^h\d+$/.test(t)));
  assert.equal(new Set(hosts).size, 3, `each tile its own token: ${hosts}`);
  for (const e of motion.hover) {
    for (const s of e.sibs) assert.equal(tiles.filter((p) => byPath.get(p).motionTokens?.includes(s.token)).length, 1, `${s.token} on one tile only`);
  }
});

test('a part of a hovered menu item is kept to the nearest item around it (`li:hover > a` with a submenu inside)', () => {
  const outer = 'body>ul:1>li:1';
  const inner = `${outer}>ul:1>li:1`;
  const { site } = irPage(['body>ul:1', outer, `${outer}>a:1`, `${outer}>ul:1`, inner, `${inner}>a:1`]);
  const red = { color: ['rgb(75, 85, 99)', 'rgb(194, 65, 12)'] };
  const hover = [outer, inner].map((p) => ({ path: p, source: 'css', changes: {}, kids: [{ path: `${p}>a:1`, changes: red }] }));
  const { motion } = applyMotion(site, new Map([['/', { hover }]]));
  assert.equal(motion.hover.length, 1, 'one shared effect');
  assert.equal(motion.hover[0].nested, true);
  const css = motionCss(motion, { tokenOf: new Map(), from: 'css/site.css' });
  assert.match(css, /\[data-motion~="h1"\]:hover \[data-motion~="h1k1"\]:not\(\[data-motion~="h1"\]:not\(:hover\) \[data-motion~="h1k1"\]\)/);
});

test('a panel open when the page loads: the click is read the right way round and its closed state is written', () => {
  const opened = { change: { shown: [{ path: 'a' }], hidden: [], attrs: [] } };
  const closed = { change: { shown: [], hidden: [{ path: 'a' }], attrs: [] } };
  assert.equal(closedOnClick(opened), false);
  assert.equal(closedOnClick(closed), true);
  assert.equal(closedOnClick({ change: { shown: [], hidden: [], attrs: [{ isTrigger: true, from: 'true|||||', to: 'false|||||' }] } }), true);
  assert.deepEqual(shutDecls({ 'max-height': ['0px', '400px'], height: ['0px', '36px'], transform: ['none', 'matrix(-1, 0, 0, -1, 0, 0)'], 'grid-template-rows': ['0px', '120px'] }),
    { 'max-height': '0px', height: '0px', transform: 'none', 'grid-template-rows': '0fr' });

  // Ten questions, the first open: the probed click on it closed its answer; the probe of another opened one.
  const list = 'body>main:1>div:1';
  const items = Array.from({ length: 3 }, (_, i) => `${list}>div:${i + 1}`);
  const paths = ['body>main:1', list, ...items.flatMap((p) => [p, `${p}>button:1`, `${p}>div:1`])];
  const { site, byPath } = irPage(paths, Object.fromEntries(items.map((p, i) => [`${p}>button:1`, { 'aria-expanded': String(i === 0) }])));
  const group = { sig: 'q', paths: items.map((p) => `${p}>button:1`) };
  const widget = (p, from, to, attrsFrom, attrsTo) => ({
    kind: 'disclosure', opensOn: 'click', closes: 'toggle', trigger: `${p}>button:1`, group,
    change: { shown: [], hidden: [], added: [], attrs: [{ path: `${p}>button:1`, from: `${attrsFrom}|||||`, to: `${attrsTo}|||||`, isTrigger: true }] },
    state: { root: p, parts: [{ rel: 'div:1', changes: { 'max-height': [from, to] } }] },
  });
  const clicks = { widgets: [widget(items[0], '400px', '0px', 'true', 'false'), widget(items[1], '0px', '400px', 'false', 'true')] };
  const { motion } = applyMotion(site, new Map([['/', { clicks }]]));
  assert.equal(motion.widgets.length, 1, 'one effect: the first answer\'s reading was turned round');
  const [w] = motion.widgets;
  assert.equal(w.startsOpen, true);
  assert.deepEqual(w.parts[0].decls, { 'max-height': 'none' });
  assert.deepEqual(w.parts[0].shut, { 'max-height': '0px' });
  assert.equal(byPath.get(items[0]).stateAttrs?.['data-w-open'], '', 'the first item starts open');
  assert.equal(byPath.get(items[1]).stateAttrs?.['data-w-open'], undefined);
  const css = motionCss(motion, { tokenOf: new Map(), from: 'css/site.css' });
  assert.match(css, /\[data-motion~="w1"\]\.is-shut \[data-motion~="w1p1"\] \{\s*max-height: 0px;/);
});

test('controls one to a block: the questions the probe did not click are planned too, and an accordion is marked', () => {
  const q = (i) => `body>main:1>div:1>div:${i}>h3:1>button:1`;
  assert.equal(samePlace([q(1), q(2)])(q(7)), true);
  assert.equal(samePlace([q(1), q(2)])('body>main:1>div:1>div:7>button:1'), false);
  assert.equal(samePlace(['body>div:1>button:1', 'body>div:1>button:2']), null, 'a row of tabs is not one control per block');
  // A list re-rendered on every click: everything changes, yet all ten questions are controls of the set.
  const list = 'body>main:1>div:1';
  const all = Array.from({ length: 10 }, (_, i) => `${list}>div:${i + 1}>button:1`);
  const group = { sig: 'q', count: 10, paths: all };
  const items = Array.from({ length: 10 }, (_, i) => ({ path: `${list}>div:${i + 1}` }));
  const tab = (i) => ({ kind: 'tabs', opensOn: 'click', trigger: all[i], group, change: { shown: [], hidden: items, added: items.slice(0, 6), text: [], moved: [] } });
  const [set] = planSets([tab(0), tab(1), tab(2)]);
  assert.equal(set.controls.length, 10);
  // Answers drawn only while open, one at a time: every question gets its own toggle, all in one group.
  const toggle = (i) => ({ kind: 'disclosure', opensOn: 'click', closes: 'toggle', exclusive: true, trigger: all[i], group, change: { added: [{ path: `${list}>div:${i + 1}>div:1` }] }, state: { added: true } });
  const plans = planSets([toggle(0), toggle(1), toggle(2)]);
  assert.equal(plans.length, 10);
  assert.ok(plans.every((p) => p.one === list && p.toggle));
});

const PAGES = { '/faq-swap': FAQ_SWAP, '/faq-long': FAQ_LONG, '/faq-many': FAQ_MANY, '/': HOME, '/faq': FAQ, '/accordion': ACCORDION, '/faq-render': FAQ_RENDER, '/faq-height': FAQ_HEIGHT, '/faq-div': FAQ_DIV };

let site;
let browser;
const builds = {};
const projectIds = [];

async function build(exact) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'hover-toggle', ?, 'html', 1, -1, ?, ?)`).run(id, `${origin}/`, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  const recreateId = randomUUID();
  const stub = async () => {};
  await runRecreate({
    project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id), recreateId, exact, progress: () => {},
    stages: { ...STAGES, sweep: stub, exactCapture: stub, exact: stub, preview: stub, responsive: stub, stack: stub },
  });
  const dir = recreateDir(id, recreateId);
  if (process.env.SAS_KEEP_DIST) await cp(dir, path.join(process.env.SAS_KEEP_DIST, exact ? 'exact' : 'normal'), { recursive: true });
  return dir;
}

before(async () => {
  site = createServer((req, res) => {
    const body = PAGES[req.url.split('?')[0]];
    if (body) return res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise((resolve) => { site.listen(PORT, resolve); });
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close().catch(() => {});
  site?.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

async function openCopy(dir, file) {
  const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${served.origin ?? `http://127.0.0.1:${served.port}`}/${file}`, { waitUntil: 'load' });
  return { page, close: async () => { await context.close(); await served.close?.(); } };
}
async function openOriginal(file) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${origin}/${file}`, { waitUntil: 'load' });
  return { page, close: () => context.close() };
}

// The colour of every nav link, by its text.
const navColours = (page) => page.$$eval('header a', (as) => Object.fromEntries(as.map((a) => [a.textContent.trim(), getComputedStyle(a).color])));
const byText = (page, sel, text) => page.locator(sel, { hasText: text }).first();

async function hoverChecks(open) {
  const { page, close } = await open();
  try {
    await page.mouse.move(1, 899);
    await page.waitForTimeout(600);
    const rest = await navColours(page);
    const out = { rest, hovered: {} };
    for (const name of ['Questions', 'About', 'Work']) {
      const link = byText(page, 'header nav a', name);
      await link.hover();
      await page.waitForTimeout(700);
      out.hovered[name] = await navColours(page);
      await page.mouse.move(1, 899);
      await page.waitForTimeout(700);
    }
    // A neighbour rule (`.tile:hover + .tile`): only the tile right after the hovered one changes.
    const tiles = () => page.$$eval('main *', (els) => Object.fromEntries(els.filter((e) => /^Tile [A-D]$/.test(e.textContent.trim()) && !e.children.length).map((e) => [e.textContent.trim(), getComputedStyle(e).backgroundColor])));
    out.tiles = { rest: await tiles() };
    for (const name of ['Tile A', 'Tile B']) {
      await page.getByText(name, { exact: true }).hover();
      await page.waitForTimeout(600);
      out.tiles[name] = await tiles();
      await page.mouse.move(1, 899);
      await page.waitForTimeout(600);
    }
    // A menu item holding a submenu (`li:hover > a`): hovering it colours its own link, not the links of the items inside.
    const menu = () => page.$$eval('main li a', (as) => Object.fromEntries(as.map((a) => [a.textContent.trim(), getComputedStyle(a).color])));
    out.menu = { rest: await menu() };
    for (const name of ['Products', 'Annotate']) {
      await page.locator('main li a', { hasText: name }).first().hover();
      await page.waitForTimeout(600);
      out.menu[name] = await menu();
      await page.mouse.move(1, 899);
      await page.waitForTimeout(600);
    }
    out.buttons = {};
    for (const name of ['Get started', 'See the work', 'Book a call']) {
      const b = byText(page, '.actions > *, main a, main button', name);
      const restBg = await b.evaluate((e) => getComputedStyle(e).backgroundColor);
      await b.hover();
      await page.waitForTimeout(900);
      out.buttons[name] = { rest: restBg, hover: await b.evaluate((e) => getComputedStyle(e).backgroundColor) };
      await page.mouse.move(1, 899);
      await page.waitForTimeout(900);
    }
    return out;
  } finally {
    await close();
  }
}

// What the visitor sees of a FAQ: the answers on show and each visible question's aria-expanded.
const faqState = (page, list = FAQ_ITEMS) => page.evaluate((items) => {
  // Drawn and not clipped away by a collapsed ancestor (an answer that slides shut keeps its box at height 0).
  const shown = (el) => {
    if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return false;
    let r = el.getBoundingClientRect();
    let top = r.top;
    let bottom = r.bottom;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowY === 'visible') continue;
      r = p.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
    }
    return bottom - top >= 1;
  };
  const all = [...document.querySelectorAll('main *')];
  const answers = items.filter(([, a]) => all.some((el) => el.children.length === 0 && el.textContent.trim() === a && shown(el))).map(([q]) => q);
  const expanded = {};
  for (const [q] of items) {
    const btn = all.find((el) => el.textContent.trim().startsWith(q) && shown(el) && el.hasAttribute('aria-expanded'));
    expanded[q] = btn ? btn.getAttribute('aria-expanded') : null;
  }
  return { open: answers, expanded };
}, list);
// Clicks (or keys) a visible question by its text.
async function ask(page, q, how = 'click', items = FAQ_ITEMS) {
  const el = page.locator('main button, main [role=button], main summary', { hasText: q }).filter({ visible: true }).first();
  if (how === 'click') await el.click();
  else {
    await el.focus();
    await page.keyboard.press(how);
  }
  await page.waitForTimeout(500);
  return faqState(page, items);
}

// The same steps on the original and on the copy, recorded state by state.
async function faqScript(open, items = FAQ_ITEMS) {
  const { page, close } = await open();
  try {
    const [q1, q2, q3] = items.map(([q]) => q);
    const last = items.at(-1)[0];
    const steps = [['start', await faqState(page, items)]];
    for (const [label, q, how] of [['open 1', q1, 'click'], ['open 2', q2, 'click'], ['close 1', q1, 'click'], ['enter 3', q3, 'Enter'], ['space 3', q3, ' '], ['close 2', q2, 'click'], ['open last', last, 'click'], ['close last', last, 'click']]) {
      steps.push([label, await ask(page, q, how === ' ' ? 'Space' : how, items)]);
    }
    return steps;
  } finally {
    await close();
  }
}

for (const mode of ['normal', 'exact']) {
  for (const [file, label, items] of [
    ['faq', 'independent questions'], ['accordion', 'an accordion (one open at a time)'], ['faq-render', 'independent questions rendered only while open'],
    ['faq-height', 'independent questions that slide open'], ['faq-div', 'an accordion of focusable boxes with hidden answers'],
    ['faq-long', 'a long accordion that starts with its first answer open', LONG_ITEMS], ['faq-many', 'a long accordion rendered only while open', LONG_ITEMS], ['faq-swap', 'an accordion that draws only the open answer', LONG_ITEMS.slice(0, 6)],
  ]) {
    test(`${mode}: ${label} open, close and follow the keyboard like the original`, async () => {
      builds[mode] ??= await build(mode === 'exact');
      const orig = await faqScript(() => openOriginal(file), items);
      const copy = await faqScript(() => openCopy(builds[mode], `${file}/`), items);
      for (let i = 0; i < orig.length; i++) assert.deepEqual(copy[i], orig[i], `after "${orig[i][0]}"`);
    });
  }
}

for (const mode of ['normal', 'exact']) {
  test(`${mode}: hovering one nav link changes that link only, and buttons get the original's hover background`, async () => {
    builds[mode] ??= await build(mode === 'exact');
    const orig = await hoverChecks(() => openOriginal(''));
    const copy = await hoverChecks(() => openCopy(builds[mode], 'index.html'));
    assert.deepEqual(copy.rest, orig.rest, 'the links at rest');
    for (const name of Object.keys(orig.hovered)) assert.deepEqual(copy.hovered[name], orig.hovered[name], `hovering ${name}`);
    for (const name of Object.keys(orig.tiles)) assert.deepEqual(copy.tiles[name], orig.tiles[name], `the tiles, ${name}`);
    for (const name of Object.keys(orig.menu)) assert.deepEqual(copy.menu[name], orig.menu[name], `the menu, ${name}`);
    for (const name of Object.keys(orig.buttons)) assert.deepEqual(copy.buttons[name], orig.buttons[name], `the button ${name}`);
    // The values themselves: the rule's hover, and the one a script animates over the rule's.
    assert.equal(copy.buttons['Get started'].hover, 'rgb(194, 65, 12)');
    assert.equal(copy.buttons['Book a call'].hover, 'rgb(22, 163, 74)');
    assert.equal(copy.hovered.Questions.Accordion, 'rgb(51, 51, 51)', 'the link the header probe landed on stays as it is');
    assert.deepEqual([copy.tiles['Tile A']['Tile B'], copy.tiles['Tile A']['Tile C']], ['rgb(254, 215, 170)', 'rgb(243, 244, 246)']);
    assert.deepEqual([copy.menu.Products.Products, copy.menu.Products.Annotate], ['rgb(194, 65, 12)', 'rgb(75, 85, 99)']);
  });
}
