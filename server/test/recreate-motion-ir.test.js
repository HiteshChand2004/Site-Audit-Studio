// Recreate 4b.4: motion in the IR (ir/motion.js), its CSS (emit/motionCss.js), the reveal script and its safety profile.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emitCss } from '../src/recreate/emit/css.js';
import { emitPage, emitSite } from '../src/recreate/emit/html.js';
import { MOTION_FILE, MOTION_JS } from '../src/recreate/emit/motionScript.js';
import { applyMotion, revealSpec } from '../src/recreate/ir/motion.js';
import { launchBrowser } from '../src/audit/render.js';
import { scanSite } from '../src/recreate/verify/safety.js';
import { startSiteServer } from '../src/recreate/verify/server.js';

// A merged tree as ir/tree.js builds it: nodes with their desktop path (cpath).
const node = (cpath, tag, children = [], style = {}) => ({ tag, cpath, attrs: {}, views: { desktop: { style, rect: [0, 0, 100, 40], hidden: false } }, children });
const makeSite = () => {
  const spinner = node('body>div:3', 'div', [], { 'animation-name': 'spin' });
  const arrow = node('body>a:1>span:1', 'span');
  const link = node('body>a:1', 'a', [arrow]);
  const link2 = node('body>a:2', 'a');
  const h2 = node('body>section:1>h2:1', 'h2');
  const p = node('body>section:1>p:1', 'p');
  const p2 = node('body>section:1>p:2', 'p');
  const wrapped = node('body>div:9', 'div');
  wrapped.cpathAlt = ['body>div:8'];
  const waapi = node('body>div:4', 'div');
  const spin = node('body>div:5', 'div');
  const sine = node('body>div:6', 'div');
  const root = node('body', 'body', [link, link2, node('body>section:1', 'section', [h2, p, p2]), spinner, waapi, spin, sine, wrapped]);
  return { site: { pages: [{ info: { path: '/', url: 'http://x.test/' }, root }], assetResolve: (u) => (/hero\.png$/.test(u) ? 'images/hero.png' : null) }, nodes: { link, link2, arrow, h2, p, p2, spinner, waapi, spin, sine, wrapped } };
};
const reveal = (path, extra = {}) => ({
  path, tag: 'p', text: '', rect: [0, 900, 100, 40],
  from: { opacity: 0, transform: 'matrix(1, 0, 0, 1, 0, 16)', filter: 'none', motion: { translate: [0, 16], scale: [1, 1], rotate: 0 } },
  to: { opacity: 1, transform: 'none', filter: 'none', motion: { translate: [0, 0], scale: [1, 1], rotate: 0 } },
  timing: { source: 'transition', duration: 700, delay: 0, easing: { css: 'cubic-bezier(0.16, 1, 0.3, 1)' } },
  trigger: { kind: 'scroll', step: 1, topBefore: 1.4, topAfter: 0.5 }, replay: false, group: 'r1', ...extra,
});
const motionFile = () => ({
  hover: [
    { path: 'body>a:1', tag: 'a', changes: { color: ['rgb(17, 17, 17)', 'rgb(225, 29, 72)'] }, kids: [{ path: 'body>a:1>span:1', changes: { opacity: ['0', '1'] } }], pseudo: { after: { width: ['0px', '100%'] } }, domDelta: 0 },
    { path: 'body>a:2', tag: 'a', changes: { color: ['rgb(17, 17, 17)', 'rgb(225, 29, 72)'] }, kids: [{ path: 'body>a:1>span:1', changes: { opacity: ['0', '1'] } }], pseudo: { after: { width: ['0px', '100%'] } }, domDelta: 0 },
    { path: 'body>a:9', tag: 'a', changes: { color: ['a', 'b'] }, domDelta: 0 },
    { path: 'body>a:1', tag: 'a', changes: { 'background-image': ['none', 'url("https://cdn.test/missing.png")'] }, domDelta: 0 },
    { path: 'body>a:2', tag: 'a', changes: { color: ['a', 'b'] }, domDelta: 2 },
  ],
  focus: [{ path: 'body>a:2', tag: 'a', changes: { 'outline-color': ['a', 'rgb(37, 99, 235)'], 'outline-style': ['none', 'solid'] }, domDelta: 0 }],
  reveal: {
    elements: [
      reveal('body>section:1>h2:1', { tag: 'h2' }),
      reveal('body>section:1>p:1', { offsetMs: 70, replay: true }),
      reveal('body>section:1>p:2', { offsetMs: 140 }),
      reveal('body>div:8'),
      reveal('body>div:1', { rect: [0, 200, 100, 40], trigger: { kind: 'timed', step: 0, topBefore: 0.2, topAfter: 0.1 } }),
      reveal('body>div:77'),
      { ...reveal('body>section:1'), from: { opacity: 1, transform: 'none', filter: 'none', motion: { translate: [0, 0], scale: [1, 1], rotate: 0 } } },
    ],
  },
  loops: {
    loops: [
      { path: 'body>div:3', source: 'css-animation', name: 'spin', inStylesheet: true, pattern: 'spin', timing: { duration: 3000, iterations: 'infinite' }, keyframes: [] },
      { path: 'body>div:4', source: 'waapi', pattern: 'float', timing: { duration: 1200, delay: 0, iterations: 'infinite', direction: 'alternate', fill: 'auto', easing: 'ease-in-out', playbackRate: 1 }, keyframes: [{ offset: 0, easing: 'ease', props: { transform: 'translateY(0px)' } }, { offset: 1, easing: 'ease', props: { transform: 'translateY(-12px)' } }] },
      { path: 'body>div:5', source: 'script', pattern: 'spin', params: { pattern: 'spin', rate: 180, direction: 'forward' }, timing: { driver: 'script' } },
      { path: 'body>div:6', source: 'script', pattern: 'oscillate', params: { pattern: 'oscillate', channel: 'y', amplitude: 20, periodMs: 2000 }, timing: { driver: 'script' } },
      { path: 'body>div:6', source: 'script', pattern: 'drift', params: { pattern: 'drift', rate: 120 }, timing: { driver: 'script' } },
      { path: 'body>section:1', source: 'waapi', pattern: 'float', timing: { duration: 1, iterations: 'infinite' }, keyframes: [{ offset: 0, props: {} }, { offset: 1, props: {} }], timeline: 'ScrollTimeline' },
    ],
  },
});

test('revealSpec: a from-state relative to the element, timing and easing from the capture', () => {
  assert.deepEqual(revealSpec(reveal('x')), { duration: 700, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', opacity: 0, translate: [0, 16] });
  const odd = revealSpec(reveal('x', { timing: { duration: 99999, easing: { css: 'evil(); x' } } }));
  assert.equal(odd.duration, 3000);
  assert.equal(odd.easing, 'ease');
});

test('applyMotion: tokens on mapped elements, shared effects, skipped cases counted', () => {
  const { site, nodes } = makeSite();
  const { motion, stats } = applyMotion(site, new Map([['/', motionFile()]]));

  // Hover: two links with equal effects share one token; the kid and the pseudo-element ride along.
  assert.deepEqual(nodes.link.motionTokens, ['h1']);
  assert.deepEqual(nodes.link2.motionTokens, ['h1', 'f1']);
  assert.deepEqual(nodes.arrow.motionTokens, ['h1k1']);
  assert.equal(motion.hover.length, 1);
  assert.deepEqual(motion.hover[0].decls, { color: 'rgb(225, 29, 72)' });
  assert.deepEqual(motion.hover[0].pseudo, { after: { width: '100%' } });
  assert.equal(stats.hover.skipped.unmapped, 1);
  assert.equal(stats.hover.skipped.script, 1);
  assert.equal(stats.hover.skipped.empty, 1, 'a background that was not downloaded is never linked live');
  assert.equal(motion.focus.length, 1);

  // Reveal: marker + effect + delay + replay; a wrapper that was removed passes its path on; timed and flat ones are skipped.
  assert.deepEqual(nodes.h2.motionTokens, ['rv', 'r1']);
  assert.deepEqual(nodes.p.motionTokens, ['rv', 'r1', 'd70', 'rp']);
  assert.deepEqual(nodes.p2.motionTokens, ['rv', 'r1', 'd140']);
  assert.deepEqual(nodes.wrapped.motionTokens, ['rv', 'r1']);
  assert.deepEqual(motion.delays, [70, 140]);
  assert.equal(motion.reveal.length, 1);
  assert.equal(stats.reveal.skipped.timed, 1);
  assert.equal(stats.reveal.skipped.unmapped, 1);
  assert.equal(stats.reveal.skipped.flat, 1);
  assert.equal(motion.script, true);

  // Loops: the page's own CSS animation is carried, the Web Animation and the script-driven ones are rebuilt.
  assert.equal(stats.loops.carried, 1);
  assert.equal(stats.loops.rebuilt, 3);
  assert.deepEqual(nodes.waapi.motionTokens, ['l1']);
  assert.deepEqual(nodes.spin.motionTokens, ['l2']);
  assert.deepEqual(nodes.sine.motionTokens, ['l3']);
  assert.equal(motion.loops[1].timing.duration, 2000); // 180 deg/s
  assert.equal(motion.loops[2].timing.direction, 'alternate');
  assert.deepEqual(stats.loops.skipped.map((s) => s.reason), ['script-driven', 'scroll-linked']);
});

test('without motion nothing changes: no tokens, no script', () => {
  const { site, nodes } = makeSite();
  const { motion } = applyMotion(site, new Map());
  assert.equal(motion, null);
  assert.equal(nodes.link.motionTokens, undefined);
});

const irFor = (motion) => ({
  baseUrl: 'http://x.test', siteName: 'X', breakpoints: { tablet: 1023.98, mobile: 767.98 }, tokens: {}, fontFaces: [], keyframes: [], boxSizingReset: false, rules: [], files: [],
  ...(motion && { motion }),
  pages: [{ outPath: 'a/index.html', head: { lang: 'en', title: 'A', canonical: 'http://x.test/a/', meta: [], alternates: [], icons: [], jsonLd: [] }, html: { class: null }, body: { t: 'body', sid: 1, attrs: {}, children: [] } }],
});

test('the stylesheet: hover for pointer devices, focus, reveal under .js-motion, rebuilt loops', () => {
  const { site } = makeSite();
  const { motion } = applyMotion(site, new Map([['/', motionFile()]]));
  const css = emitCss(irFor(motion));
  assert.match(css, /@media \(hover: hover\) \{\n {2}\[data-motion~="h1"\]:hover \{\n {4}color: #e11d48;/);
  assert.match(css, /\[data-motion~="h1"\]:hover::after \{\n {4}width: 100%;/);
  assert.match(css, /\[data-motion~="h1"\]:hover \[data-motion~="h1k1"\] \{\n {4}opacity: 1;/);
  assert.match(css, /\[data-motion~="f1"\]:focus-visible \{\n {2}outline-color: #2563eb;\n {2}outline-style: solid;/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\n {2}\.js-motion \[data-motion~="rv"\]\[data-motion~="r1"\]:not\(\.is-in\) \{\n {4}opacity: 0;\n {4}translate: 0px 16px;/);
  assert.match(css, /\.js-motion \[data-motion~="rv"\]\[data-motion~="r1"\]\.is-in \{\n {4}animation: m-r1 700ms cubic-bezier\(0\.16, 1, 0\.3, 1\) var\(--md, 0ms\) backwards;/);
  // The same effect as a first-screen entrance (`rl`): played once on load, no script and no hidden state.
  assert.match(css, /\[data-motion~="rl"\]\[data-motion~="r1"\] \{\n {4}animation: m-r1 700ms/);
  assert.doesNotMatch(css, /\[data-motion~="rl"\][^{]*:not\(\.is-in\)/);
  assert.match(css, /\[data-motion~="d70"\] \{\n {4}--md: 70ms;/);
  assert.match(css, / {2}@keyframes m-l1 \{\n {4}0% \{\n {6}transform: translateY\(0px\);\n {6}animation-timing-function: ease;/);
  assert.match(css, /\[data-motion~="l1"\] \{\n {4}animation: m-l1 1200ms ease-in-out infinite alternate;/);
  assert.match(css, /\[data-motion~="l2"\] \{\n {4}animation: m-l2 2000ms linear infinite;/);
  assert.equal(emitCss(irFor(null)).includes('data-motion'), false);
});

test('pages get the reveal script only when the IR has reveal effects', () => {
  const html = emitPage(irFor(null).pages[0], { motionScript: true });
  assert.match(html, /<script src="\.\.\/js\/motion\.js" defer><\/script>\n<\/head>/);
  assert.doesNotMatch(emitPage(irFor(null).pages[0]), /<script/);
  const withReveal = emitSite(irFor({ version: 1, hover: [], focus: [], reveal: [{ token: 'r1', opacity: 0, duration: 400, easing: 'ease' }], delays: [], loops: [], script: true }));
  assert.equal(withReveal.files.get(MOTION_FILE), MOTION_JS);
  const cssOnly = emitSite(irFor({ version: 1, hover: [{ token: 'h1', decls: { color: '#fff' }, kids: [] }], focus: [], reveal: [], delays: [], loops: [], script: false }));
  assert.equal(cssOnly.files.has(MOTION_FILE), false);
  assert.doesNotMatch(cssOnly.files.get('a/index.html'), /<script/);
});

let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-motion-ir-'));
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
const site = async (name, files) => {
  const root = path.join(dir, name);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
};
const page = (head) => `<!doctype html><html><head><title>t</title>${head}</head><body><p>x</p></body></html>`;

test('safety: the fixed reveal script is the only script a plain-HTML build may carry', async () => {
  const good = await site('good', { 'a/index.html': page('<script src="../js/motion.js" defer></script>'), 'index.html': page('<script src="js/motion.js" defer></script>'), 'js/motion.js': MOTION_JS });
  const ok = await scanSite(good, { app: 'motion' });
  assert.equal(ok.safe, true, JSON.stringify(ok.issues));
  assert.equal(ok.checked.js, 1);
  // Without the profile any script fails, as before.
  assert.equal((await scanSite(good)).safe, false);

  const inline = await site('inline', { 'index.html': page('<script>alert(1)</script>'), 'js/motion.js': MOTION_JS });
  assert.equal((await scanSite(inline, { app: 'motion' })).safe, false);
  const other = await site('other', { 'index.html': page('<script src="js/other.js" defer></script>'), 'js/motion.js': MOTION_JS, 'js/other.js': 'x()' });
  const bad = await scanSite(other, { app: 'motion' });
  assert.ok(bad.issues.some((i) => i.file === 'js/other.js' && /unexpected script file/.test(i.detail)) && bad.issues.some((i) => i.file === 'index.html'), JSON.stringify(bad.issues));
  const remote = await site('remote', { 'index.html': page('<script src="https://evil.test/js/motion.js" defer></script>'), 'js/motion.js': MOTION_JS });
  assert.equal((await scanSite(remote, { app: 'motion' })).safe, false);
  const sink = await site('sink', { 'index.html': page('<script src="js/motion.js" defer></script>'), 'js/motion.js': `${MOTION_JS}\nfetch('/x');` });
  assert.equal((await scanSite(sink, { app: 'motion' })).safe, false);
});

// ---- the generated site in a real browser ----------------------------------------------------------------------

const el = (cls, tokens, text) => ({ t: 'div', sid: Math.floor(Math.random() * 1e6), class: cls, attrs: tokens ? { 'data-motion': tokens } : {}, children: [{ text }], b: 1 });
test('in a browser: hidden only with script, shown when scrolled into view, repeated for rp, never hidden without script', async () => {
  const motion = {
    version: 1, hover: [{ token: 'h1', decls: { color: '#e11d48' }, kids: [] }], focus: [],
    reveal: [{ token: 'r1', opacity: 0, translate: [0, 24], duration: 300, easing: 'ease-out' }], delays: [], loops: [], script: true,
  };
  const ir = {
    ...irFor(motion),
    rules: [{ selector: '.gap', parts: { base: { height: '1600px' } } }, { selector: '.box', parts: { base: { height: '80px' } } }],
    pages: [{
      outPath: 'index.html', head: { lang: 'en', title: 'T', canonical: 'http://x.test/', meta: [], alternates: [], icons: [], jsonLd: [] }, html: { class: null },
      body: { t: 'body', sid: 1, attrs: {}, children: [el('gap', null, 'top'), el('box', 'rv r1', 'once'), el('gap', null, 'between'), el('box', 'rv r1 rp', 'again'), el('gap', null, 'end')] },
    }],
  };
  const dirName = await mkdtemp(path.join(os.tmpdir(), 'sas-motion-site-'));
  const out = emitSite(ir);
  for (const [file, content] of out.files) {
    await mkdir(path.dirname(path.join(dirName, file)), { recursive: true });
    await writeFile(path.join(dirName, file), content);
  }
  const server = await startSiteServer(dirName);
  const browser = await launchBrowser();
  try {
    const open = async (options) => {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 }, ...options });
      const page = await context.newPage();
      await page.goto(`${server.origin}/`, { waitUntil: 'load' });
      return { context, page };
    };
    const state = (page, text) => page.evaluate((t) => {
      const e = [...document.querySelectorAll('.box')].find((x) => x.textContent === t);
      const cs = getComputedStyle(e);
      return { opacity: cs.opacity, translate: cs.translate, isIn: e.classList.contains('is-in') };
    }, text);

    const { context, page } = await open({});
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('js-motion')), true);
    assert.deepEqual(await state(page, 'once'), { opacity: '0', translate: '0px 24px', isIn: false });
    await page.evaluate(() => document.querySelector('.box').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(700);
    assert.deepEqual(await state(page, 'once'), { opacity: '1', translate: 'none', isIn: true });
    // Scrolling away does not hide it again; the `rp` one is hidden again when it leaves the view.
    await page.evaluate(() => [...document.querySelectorAll('.box')][1].scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(700);
    assert.equal((await state(page, 'again')).isIn, true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    assert.equal((await state(page, 'once')).isIn, true);
    assert.equal((await state(page, 'again')).isIn, false);
    assert.equal((await state(page, 'again')).opacity, '0');
    await context.close();

    // Without script nothing is hidden.
    const noJs = await open({ javaScriptEnabled: false });
    assert.deepEqual(await state(noJs.page, 'once'), { opacity: '1', translate: 'none', isIn: false });
    await noJs.context.close();
    // Reduced motion: the script stays out of the way.
    const reduced = await open({ reducedMotion: 'reduce' });
    assert.equal(await reduced.page.evaluate(() => document.documentElement.classList.contains('js-motion')), false);
    assert.equal((await state(reduced.page, 'once')).opacity, '1');
    await reduced.context.close();
  } finally {
    await browser.close();
    await server.close();
    await rm(dirName, { recursive: true, force: true });
  }
});
