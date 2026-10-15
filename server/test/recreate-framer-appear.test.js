// Framer appear entrances (CLONER_SPEC Phase 2A item 2, fixture 5): the settings Framer embeds in the server-rendered HTML
// are read tolerantly (format variants, garbled input never throws), put on the captured elements, and run in the copy
// with the motion package; an element whose settings are missing or garbled is never left invisible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyframesOf, motionOptions, normalizeTransition, parseAppearConfig, transformOf } from '../src/recreate/behavior/framer/appear.js';
import { appearIds, planAppear, shownStyle, showAsIsAppear } from '../src/recreate/behavior/framer/plan.js';
import { appearFiles, appearTags } from '../src/recreate/behavior/framer/emit.js';
import { vendorHashes, vendorText } from '../src/recreate/emit/anim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = () => readFile(path.join(HERE, 'fixtures', 'animation', 'framer.html'), 'utf8');
const script = (id, body, type = 'framer/appear') => `<script type="${type}" id="${id}">${body}</script>`;
const page = (...scripts) => `<!doctype html><html><head></head><body><div data-framer-appear-id="a1"></div>${scripts.join('')}</body></html>`;

test('the current format: entries by appear id and breakpoint, tween and spring transitions, breakpoints with their media', async () => {
  const r = parseAppearConfig(await fixture());
  assert.equal(r.found, true);
  assert.equal(r.source, 'script#__framer__appearAnimationsContent');
  assert.deepEqual(r.breakpoints, [{ hash: '72rtr7', media: '(min-width: 810px)' }, { hash: 'jokq5q', media: '(max-width: 809.98px)' }]);
  const of = (id, variant = 'default') => r.entries.find((e) => e.appearId === id && e.variant === variant);

  const title = of('t1tle0');
  assert.equal(title.trigger, 'load');
  assert.equal(title.initial.opacity, 0.001);
  assert.equal(title.initial.y, 24);
  assert.deepEqual(title.transition, { type: 'tween', delay: 0.3, duration: 0.9, ease: [0.2, 0, 0, 1] });

  const badge = of('spr1ng');
  assert.equal(badge.transition.type, 'spring');
  assert.deepEqual(badge.transition.spring, { stiffness: 120, damping: 30, mass: 1 });
  assert.equal(badge.animate.rotate, -4);

  // A breakpoint variant carries its media query.
  const narrow = of('sub7x2', 'jokq5q');
  assert.equal(narrow.media, '(max-width: 809.98px)');
  assert.equal(narrow.transition.delay, 0.1);

  // whileInView = an in-view entrance, with its viewport options.
  const card = of('v1ewin');
  assert.equal(card.trigger, 'inView');
  assert.deepEqual(card.viewport, { once: true, amount: 0.2 });
  assert.equal(card.animate.opacity, 1);

  // The garbled one is reported with its reason, never thrown on and never guessed.
  assert.equal(r.entries.some((e) => e.appearId === 'br0ken'), false);
  assert.deepEqual(r.unknown.map((u) => [u.appearId, u.reason]), [['br0ken', 'no usable initial state']]);
});

test('tolerant: the older shape without breakpoints, a perceptual spring, null = off, keyframes, a renamed inert script', () => {
  const r = parseAppearConfig(page(script('appear-settings', JSON.stringify({
    old1: { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0, transition: { duration: 0.5, ease: 'easeOut' } } },
    pop1: { default: { initial: { opacity: 0.001, scale: 0.5 }, animate: { opacity: 1, scale: 1, transition: { type: 'spring', bounce: 0.2, duration: 0.4, delay: 0 } } }, abc123: null },
    kf01: { default: { initial: { opacity: 0 }, animate: { opacity: [0, 0.5, 1], x: [0, 20, 0], transition: { duration: 1, times: [0, 0.5, 1] } } } },
    tpl1: { default: { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transformTemplate: 'translateX(-50%) __Appear_Animation_Transform__' } },
  }))));
  assert.equal(r.found, true);
  assert.equal(r.source, 'script#appear-settings');
  const of = (id) => r.entries.find((e) => e.appearId === id);
  assert.deepEqual(of('old1').transition, { type: 'tween', delay: 0, duration: 0.5, ease: 'easeOut' });
  assert.deepEqual(of('pop1').transition, { type: 'spring', delay: 0, spring: { bounce: 0.2, duration: 0.4 } });
  assert.deepEqual(r.off, [{ appearId: 'pop1', variant: 'abc123' }]);
  assert.deepEqual(keyframesOf(of('kf01')), { transform: ['translateX(0px)', 'translateX(20px)', 'translateX(0px)'], opacity: [0, 0.5, 1] });
  assert.deepEqual(of('kf01').transition.times, [0, 0.5, 1]);
  // A transform template keeps the element's own centring while it moves.
  assert.deepEqual(keyframesOf(of('tpl1')).transform, ['translateX(-50%) translateY(10px)', 'translateX(-50%) translateY(0px)']);
  assert.deepEqual(r.unknown, []);
});

test('garbled input is reported, never thrown: bad JSON, not an object, a spec without states, odd ids, no HTML', () => {
  const bad = parseAppearConfig(page(script('__framer__appearAnimationsContent', '{"a1":{"default":{"initial":')));
  assert.equal(bad.found, false);
  assert.match(bad.unknown[0].reason, /not valid JSON/);
  const notObject = parseAppearConfig(page(script('__framer__appearAnimationsContent', '[1,2,3]')));
  assert.match(notObject.unknown[0].reason, /not an object/);
  const shapes = parseAppearConfig(page(script('__framer__appearAnimationsContent', JSON.stringify({
    a1: 'text', b2: { default: { animate: { opacity: 1 } } }, c3: { default: { initial: { opacity: 0 }, animate: { color: { r: 1 } } } }, 'bad id!': { default: {} },
  }))));
  assert.deepEqual(shapes.unknown.map((u) => u.reason), ['not an object (string)', 'no usable initial state', 'no usable target state', 'an id the page could not carry']);
  assert.equal(shapes.entries.length, 0);
  // Values that could carry markup or code are dropped, not passed on.
  const unsafe = parseAppearConfig(page(script('__framer__appearAnimationsContent', JSON.stringify({ a1: { default: { initial: { opacity: 0, filter: 'url(javascript:x)' }, animate: { opacity: 1, filter: 'blur(1px)<b>' } } } }))));
  assert.deepEqual(unsafe.entries[0].dropped, ['filter', 'filter']);
  assert.deepEqual(keyframesOf(unsafe.entries[0]), { opacity: [0, 1] });
  for (const input of [null, undefined, 42, '', '<html>no config</html>']) {
    const r = parseAppearConfig(/** @type {any} */ (input));
    assert.equal(r.found, false);
    assert.deepEqual(r.entries, []);
  }
  // Executable JavaScript naming the config (Framer's own appear script) is never read as one.
  const code = parseAppearConfig(page(script('', '{"initial":1,"animate":2}', 'text/javascript')));
  assert.equal(code.found, false);
});

test('keyframes and options: both ends list the same transform functions, springs keep their own settings', () => {
  const kf = keyframesOf({ initial: { opacity: 0.001, x: 0, y: 20, scale: 1, rotate: 0 }, animate: { opacity: 1, x: 0, y: 0, scale: 1, rotate: -8 } });
  assert.deepEqual(kf, { transform: ['translateY(20px) rotate(0deg)', 'translateY(0px) rotate(-8deg)'], opacity: [0.001, 1] });
  // Nothing moves on the transform: it is left to the stylesheet.
  assert.deepEqual(keyframesOf({ initial: { opacity: 0, y: 0 }, animate: { opacity: 1, y: 0 } }), { opacity: [0, 1] });
  assert.equal(transformOf({}, []), 'none');
  assert.equal(transformOf({ transformPerspective: 800, rotateX: 10 }, ['transformPerspective', 'rotateX']), 'perspective(800px) rotateX(10deg)');
  assert.deepEqual(motionOptions(normalizeTransition({ type: 'spring', stiffness: 500, damping: 60, mass: 1, delay: 0.5 })), { delay: 0.5, type: 'spring', stiffness: 500, damping: 60, mass: 1 });
  assert.deepEqual(motionOptions(normalizeTransition({ delay: 0.35, duration: 0.45, ease: [0.2, 0, 0, 1], type: 'tween' })), { delay: 0.35, duration: 0.45, ease: [0.2, 0, 0, 1] });
  assert.deepEqual(motionOptions(normalizeTransition(undefined)), { delay: 0, duration: 0.3 });
});

test('planning: each appear id goes on its captured element; missing / garbled settings fall back; both counts reported', async () => {
  const config = parseAppearConfig(await fixture());
  const nodes = new Map(['body>div:1>div:1>h1:1', 'body>div:1>div:1>p:1', 'body>div:1>div:1>div:1', 'body>div:1>div:2', 'body>div:1>div:4', 'body>div:1>div:9']
    .map((p) => [p, { tag: 'div', cpath: p, children: [] }]));
  const elements = [
    { id: 't1tle0', path: 'body>div:1>div:1>h1:1' }, { id: 'sub7x2', path: 'body>div:1>div:1>p:1' }, { id: 'spr1ng', path: 'body>div:1>div:1>div:1' },
    { id: 'br0ken', path: 'body>div:1>div:2' }, { id: 'v1ewin', path: 'body>div:1>div:4' }, { id: 'nocfg1', path: 'body>div:1>div:9' }, { id: 'gone01', path: 'body>div:7' },
  ];
  const plan = planAppear({ config, elements, nodes, ids: appearIds(), measured: new Set(['body>div:1>div:1>h1:1', 'body>div:1>div:4']) });
  assert.deepEqual(
    { replayed: plan.stats.replayed, load: plan.stats.load, inView: plan.stats.inView, spring: plan.stats.spring, variants: plan.stats.variants, garbled: plan.stats.garbled, missing: plan.stats.missing, unmapped: plan.stats.unmapped, measuredReplaced: plan.stats.measuredReplaced },
    { replayed: 4, load: 3, inView: 1, spring: 1, variants: 1, garbled: 1, missing: 1, unmapped: 1, measuredReplaced: 2 },
  );
  assert.equal(nodes.get('body>div:1>div:1>h1:1').appear, 'replay');
  assert.deepEqual(nodes.get('body>div:1>div:1>h1:1').animIds, ['f1']);
  assert.equal(nodes.get('body>div:1>div:2').appear, 'fallback');
  assert.equal(nodes.get('body>div:1>div:9').appear, 'fallback');
  assert.equal(plan.owned.has('body>div:1>div:2'), false, 'a fallback element is not owned: nothing runs on it');
  const sub = plan.program.entries.find((e) => e.appearId === 'sub7x2');
  assert.deepEqual(Object.keys(sub.variants), ['default', 'jokq5q']);
  assert.equal(sub.variants.jokq5q.options.delay, 0.1);
  assert.deepEqual(plan.program.breakpoints.map((b) => b.hash), ['72rtr7', 'jokq5q']);
  // No settings at all (the document was not recorded): every element falls back.
  const none = planAppear({ config: null, elements, nodes: new Map(nodes), ids: appearIds() });
  assert.equal(none.program, null);
  assert.equal(none.stats.missing, 6);
});

test('as-is pages: an inline first pose is replaced by the end state, or removed when there are no settings', () => {
  assert.equal(shownStyle('opacity: 1; transform: none; will-change: transform', null), null, 'already shown: untouched');
  assert.equal(shownStyle('will-change: transform; opacity: 0.001; transform: translateY(10px)', null), 'will-change: transform');
  assert.equal(
    shownStyle('opacity:0.001;transform:translateY(20px)', { animate: { opacity: 1, y: 0, rotate: -8 } }),
    'opacity: 1; transform: translateY(0px) rotate(-8deg)',
  );
  const ir = { pages: [{ path: '/', body: { t: 'body', attrs: {}, children: [
    { t: 'div', attrs: { 'data-framer-appear-id': 'x1', style: 'opacity:0.001;transform:translateY(10px)' }, children: [] },
    { t: 'div', attrs: { 'data-framer-appear-id': 'x2', style: { css: 'opacity:0;background:url("asset:a.png")' } }, children: [] },
  ] } }] };
  const config = parseAppearConfig(page(script('__framer__appearAnimationsContent', JSON.stringify({ x1: { default: { initial: { opacity: 0.001, y: 10 }, animate: { opacity: 1, y: 0 } } } }))));
  const out = showAsIsAppear(ir, new Map([['/', config]]), (p) => p.path);
  assert.deepEqual(out, { shown: 2, withSettings: 1 });
  assert.equal(ir.pages[0].body.children[0].attrs.style, 'opacity: 1; transform: translateY(0px)');
  assert.equal(ir.pages[0].body.children[1].attrs.style.css, 'background: url("asset:a.png")');
});

test('plain HTML output: motion byte for byte from the pinned package, the fixed replayer, the data; scripts deferred in order', () => {
  const ir = { pages: [{ slug: 'index', outPath: 'index.html', appear: { version: 1, entries: [{ target: 'f1', variants: { default: { keyframes: { opacity: [0, 1] }, options: { duration: 0.3 } } } }] } }, { slug: 'about', outPath: 'about.html' }] };
  const files = appearFiles(ir, vendorText);
  assert.deepEqual([...files.keys()], ['js/vendor/motion.js', 'js/appear-replay.js', 'js/appear/index.js']);
  assert.ok(vendorHashes()['js/vendor/motion.js'], 'the safety gate knows the vendored file by its hash');
  assert.match(files.get('js/vendor/motion.js'), /\.Motion=\{\}/);
  assert.match(files.get('js/appear/index.js'), /^window\.__sasAppear = \{/);
  assert.deepEqual(appearTags(ir.pages[0], (f) => f), [
    '  <script src="js/vendor/motion.js" defer></script>',
    '  <script src="js/appear/index.js" defer></script>',
    '  <script src="js/appear-replay.js" defer></script>',
  ]);
  assert.deepEqual(appearTags(ir.pages[1], (f) => f), []);
});
