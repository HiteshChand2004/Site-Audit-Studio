// Recreate 4b.1: hover / focus capture (capture/interactions.js) on a local page with known effects.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { captureInteractions, diffStates, keepReverting } from '../src/recreate/capture/interactions.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { isScrollReveal, spreadToGroups } from '../src/recreate/ir/motion.js';
import { startSiteServer } from '../src/recreate/verify/server.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Motion</title>
<style>
body { margin: 0; font: 16px sans-serif; }
a.link { color: #111111; text-decoration: none; transition: color 0.2s; }
a.link:hover { color: #e11d48; }
.card { display: block; width: 200px; padding: 20px; margin: 10px; background: #ffffff; color: #111111; box-shadow: 0 0 0 rgba(0,0,0,0); transition: box-shadow 0.2s, transform 0.2s; }
.card:hover { box-shadow: 0 8px 20px rgba(0,0,0,0.25); transform: translateY(-4px); }
.card .arrow { opacity: 0; transition: opacity 0.2s; }
.card:hover .arrow { opacity: 1; }
.under { position: relative; display: inline-block; }
.under::after { content: ''; position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: #000000; transform: scaleX(0); transition: transform 0.2s; }
.under:hover::after { transform: scaleX(1); }
button.b:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; background: #dbeafe; }
.ptr { cursor: pointer; width: 100px; height: 40px; background: #eeeeee; }
.dup { display: block; width: 120px; height: 30px; margin: 4px; background: #cccccc; transition: background-color 0.1s; }
.dup:hover { background: #999999; }
.rev { transform: translateY(60px); transition: transform 0.3s; }
.jsh { display: inline-block; }
@media (hover: hover) { .only-hover:hover { color: red; } }
</style></head><body>
<nav><a class="link" href="#a">First link</a> <a class="plain" href="#b">Plain link</a></nav>
<a class="card" href="#c"><span>Card title</span> <span class="arrow">go</span></a>
<p><a class="under" href="#d">Underline</a></p>
<p><button class="b" type="button">Focus me</button></p>
<div class="ptr">pointer only</div>
<div style="position: relative; width: 150px; height: 40px"><a class="link" href="#e">Covered link</a><div style="position: absolute; inset: 0"></div></div>
<div style="height: 900px"></div>
<div class="rev">reveal host (moves when scrolled into view)</div>
<p><a class="jsh" href="#j">JS hover</a></p>
<script>
new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.style.transform = 'none'; }), { threshold: 0.5 }).observe(document.querySelector('.rev'));
const j = document.querySelector('.jsh');
j.addEventListener('mouseenter', () => { j.style.letterSpacing = '3px'; j.style.color = 'rgb(0, 128, 0)'; });
j.addEventListener('mouseleave', () => { j.style.letterSpacing = ''; j.style.color = ''; });
</script>
<div id="dups">${Array.from({ length: 8 }, (_, i) => `<a class="dup" href="#x${i}">dup ${i}</a>`).join('')}</div>
</body></html>`;

// An entrance animation that is still running while the mouse is probed (it also changes without the mouse), a loop with a
// real hover on the same element, and a plain hover.
const ENTRANCE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Entrance</title>
<style>
body { margin: 0; font: 16px sans-serif; }
.ent { cursor: pointer; width: 200px; height: 40px; background: #eeeeee; animation: ent-in 3s linear both; }
@keyframes ent-in { from { opacity: 0.1; } to { opacity: 1; } }
.real { display: block; width: 200px; color: #111111; transition: color 0.2s; }
.real:hover { color: #e11d48; }
.spinwrap { display: block; width: 200px; padding: 10px; transition: background-color 0.2s; }
.spinwrap:hover { background-color: #dbeafe; }
.spinner { display: inline-block; width: 14px; height: 14px; background: #333333; animation: turn 1.5s linear infinite; }
@keyframes turn { to { transform: rotate(360deg); } }
</style></head><body>
<div class="ent">Entrance</div>
<a class="real" href="#r">Real link</a>
<a class="spinwrap" href="#s"><span class="spinner"></span> Spin card</a>
</body></html>`;

let dir;
let site;
let browser;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-motion-'));
  await writeFile(path.join(dir, 'index.html'), PAGE);
  await writeFile(path.join(dir, 'entrance.html'), ENTRANCE);
  site = await startSiteServer(dir);
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function openPage() {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await page.goto(`${site.origin}/`, { waitUntil: 'load' });
  return page;
}

test('hover effects are captured as style changes with their transition', async () => {
  const page = await openPage();
  const found = await captureInteractions(page, { budgetMs: 20000 });
  const byText = (t) => found.hover.find((h) => h.text.startsWith(t));

  const link = byText('First link');
  assert.deepEqual(link.changes.color, ['rgb(17, 17, 17)', 'rgb(225, 29, 72)']);
  assert.match(link.transition.duration, /0\.2s/);
  assert.match(link.transition.property, /color/);

  const card = byText('Card title');
  assert.ok(card.changes['box-shadow'] && card.changes.transform, JSON.stringify(card.changes));
  // The arrow inside the card fades in: a descendant change, found through its path.
  const arrow = card.kids.find((k) => k.changes.opacity);
  assert.deepEqual(arrow.changes.opacity, ['0', '1']);

  const under = byText('Underline');
  assert.ok(under.pseudo.after.transform, JSON.stringify(under.pseudo));
  assert.notEqual(under.pseudo.after.transform[0], under.pseudo.after.transform[1]);

  // Nothing changes on hover: not listed, but counted. Effects the stylesheet declares are read from the rules on every
  // element they apply to (no mouse), so they are found and the mouse probe does not try them again.
  assert.ok(found.hover.every((h) => !h.text.startsWith('pointer only')));
  assert.ok(found.stats.noChange >= 1);
  assert.equal(link.source, 'css');
  assert.equal(found.hover.find((h) => h.text.startsWith('Covered link'))?.source, 'css');
  assert.ok(found.stats.fromRules.hover >= 4, JSON.stringify(found.stats.fromRules));

  // Layout does not move on these hovers (the transform of the card is not a layout change).
  assert.equal(link.layout, false);
  assert.equal(card.layout, false);
  await page.context().close();
});

test('a hover effect driven by script is found without any :hover rule; a scroll-reveal is not mistaken for a hover', async () => {
  const page = await openPage();
  const found = await captureInteractions(page, { budgetMs: 30000 });
  const js = found.hover.find((h) => h.text === 'JS hover');
  assert.equal(js.changes['letter-spacing'][1], '3px');
  assert.equal(js.changes.color[1], 'rgb(0, 128, 0)');
  assert.ok(!found.rules.some((r) => /jsh/.test(r.selector)), 'no authored rule for it: only the probe can know');
  // The reveal host moved because it was scrolled into view, not because of the mouse.
  assert.ok(found.hover.every((h) => !h.text.startsWith('reveal host')), JSON.stringify(found.hover.map((h) => h.text)));
  await page.context().close();
});

test('a change that stays when the mouse leaves is no hover effect (entrance animation, timer, loop)', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await page.goto(`${site.origin}/entrance.html`, { waitUntil: 'load' });
  const found = await captureInteractions(page, { budgetMs: 20000 });
  const texts = found.hover.map((h) => h.text);
  assert.ok(!texts.includes('Entrance'), `the entrance animation is not a hover: ${JSON.stringify(texts)}`);
  assert.ok(found.stats.notReverted >= 1, JSON.stringify(found.stats));
  assert.ok(texts.includes('Real link'), 'a real hover still reverts and is kept');
  // A loop inside the element does not hide its real hover: only the properties the hover changed must revert.
  const card = found.hover.find((h) => h.text.includes('Spin card'));
  assert.ok(card && card.changes['background-color'], JSON.stringify(found.hover.map((h) => [h.text, Object.keys(h.changes)])));
  await page.context().close();
});

test('keepReverting: what stays after the mouse left is dropped from the effect, a fully stuck change is null', () => {
  const kid = (transform) => ({ path: 'p>k:1', values: { transform }, tr: {} });
  const state = (values, kids = []) => ({ values, tr: {}, rect: [0, 0, 10, 10], pseudo: {}, kids, domCount: 5 });
  const rest = state({ color: 'a', opacity: '1' }, [kid('none')]);
  const d = diffStates(rest, state({ color: 'b', opacity: '1' }, [kid('x')]));
  // Everything is back: the effect as it was.
  assert.deepEqual(keepReverting(rest, state({ color: 'a', opacity: '1' }, [kid('none')]), d), d);
  // The child keeps moving (a loop): the card's own colour change stays, the child part goes.
  const loop = keepReverting(rest, state({ color: 'a', opacity: '1' }, [kid('x')]), d);
  assert.deepEqual(loop.changes, { color: ['a', 'b'] });
  assert.equal(loop.kids, undefined);
  // The colour stayed and the child is back: only the child part is left.
  const stuck = keepReverting(rest, state({ color: 'b', opacity: '1' }, [kid('none')]), d);
  assert.deepEqual(stuck.changes, {});
  assert.equal(stuck.kids.length, 1);
  // Nothing reverted: not a hover effect.
  assert.equal(keepReverting(rest, state({ color: 'b', opacity: '1' }, [kid('x')]), d), null);
  // An unrelated property moving on does not matter.
  assert.deepEqual(keepReverting(rest, state({ color: 'a', opacity: '0.4' }, [kid('none')]), d).changes, { color: ['a', 'b'] });
});

test('a hover the stylesheet declares is found on every equal element, not only the few the mouse probes', async () => {
  const page = await openPage();
  const found = await captureInteractions(page, { budgetMs: 20000, perSignature: 3 });
  const dups = found.hover.filter((h) => h.text.startsWith('dup'));
  assert.equal(dups.length, 8);
  assert.ok(dups.every((d) => d.source === 'css' && d.changes['background-color'][1] === 'rgb(153, 153, 153)'));
  // Its transition is the element's own, read before transitions were switched off for the comparison.
  assert.match(dups[0].transition.duration, /0\.1s/);
  await page.context().close();
});

test('equal elements with a script-driven hover are probed a few times; the group lists every member', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await page.setContent(`<!doctype html><body style="margin:0">${Array.from({ length: 8 }, (_, i) => `<a class="js" href="#j${i}" style="display:block;width:120px;height:30px">js ${i}</a>`).join('')}
<script>document.querySelectorAll('.js').forEach((a) => { a.onmouseenter = () => { a.style.color = 'rgb(0, 128, 0)'; }; a.onmouseleave = () => { a.style.color = ''; }; });</script></body>`);
  const found = await captureInteractions(page, { budgetMs: 20000, perSignature: 3 });
  assert.equal(found.hover.filter((h) => h.text.startsWith('js')).length, 3);
  const group = found.groups.find((g) => g.count === 8);
  assert.equal(group.probed, 3);
  assert.equal(group.paths.length, 8);
  assert.ok(found.stats.skipped.duplicate >= 5);
  await page.context().close();
});

test('keyboard focus: a custom focus style is captured, the browser default ring is not', async () => {
  const page = await openPage();
  const found = await captureInteractions(page, { budgetMs: 20000 });
  const button = found.focus.find((f) => f.tag === 'button');
  assert.equal(button.changes['outline-style'][1], 'solid');
  assert.equal(button.changes['outline-color'][1], 'rgb(37, 99, 235)');
  assert.equal(button.changes['background-color'][1], 'rgb(219, 234, 254)');
  // The plain link only gets the browser's own ring.
  assert.ok(found.focus.every((f) => f.text !== 'Plain link'));
  assert.ok(found.stats.focused >= 3);
  await page.context().close();
});

test('the authored :hover / :focus rules are listed, with their media condition', async () => {
  const page = await openPage();
  const found = await captureInteractions(page, { budgetMs: 20000 });
  const rule = (sel) => found.rules.find((r) => r.selector === sel);
  assert.equal(rule('a.link:hover').state, 'hover');
  assert.equal(rule('a.link:hover').decls.color, 'rgb(225, 29, 72)');
  assert.equal(rule('button.b:focus-visible').state, 'focus-visible');
  assert.match(rule('.only-hover:hover').media, /hover:\s*hover/);
  assert.equal(found.stats.unreadableSheets, 0);
  assert.equal(found.stats.rulesTotal, found.rules.length);
  await page.context().close();
});

test('captured paths are the paths of the DOM snapshot', async () => {
  const page = await openPage();
  const found = await captureInteractions(page, { budgetMs: 20000 });
  const snap = await page.evaluate(snapshotPage, {});
  const paths = new Set();
  const walk = (n) => {
    if (n.path) paths.add(n.path);
    (n.children ?? []).forEach(walk);
  };
  walk(snap.body);
  assert.ok(found.hover.length >= 4);
  for (const e of [...found.hover, ...found.focus]) {
    assert.ok(paths.has(e.path), `hover/focus path ${e.path} is in the snapshot`);
    for (const k of e.kids ?? []) assert.ok(paths.has(k.path), `descendant path ${k.path} is in the snapshot`);
  }
  await page.context().close();
});

// A card whose panel shows on hover, hidden by a rule for the opposite state (`:not(:hover)`), as builders often write it.
const NEGATED = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif } .card { display: block; width: 240px; height: 120px; position: relative; border: 1px solid #ccc }
.panel { position: absolute; inset: 0; opacity: 0; background: #111; color: #fff; transition: opacity .3s }
.card:hover .panel { opacity: 1; transition-delay: .2s }
.card:not(:hover) .panel { opacity: 0; transition-delay: 0s }
</style></head><body><div class="card" tabindex="0"><span>Label</span><div class="panel">Details shown on hover</div></div></body></html>`;

test('a panel hidden by a :not(:hover) rule still counts as shown on hover', async () => {
  await writeFile(path.join(dir, 'negated.html'), NEGATED);
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await page.goto(`${site.origin}/negated.html`, { waitUntil: 'load' });
  const found = await captureInteractions(page, { budgetMs: 20000 });
  const card = found.hover.find((h) => h.text.startsWith('Label'));
  assert.ok(card, JSON.stringify(found.hover.map((h) => h.text)));
  const panel = (card.kids ?? []).find((k) => k.changes.opacity);
  assert.deepEqual(panel?.changes.opacity, ['0', '1'], JSON.stringify(card));
  // The page's own rules are back as they were.
  assert.equal(await page.evaluate(() => [...document.styleSheets[0].cssRules].some((r) => r.selectorText === '.card:not(:hover) .panel')), true);
  await page.context().close();
});

test('the time budget stops the probing and says so', async () => {
  const page = await openPage();
  const found = await captureInteractions(page, { budgetMs: 1 });
  assert.equal(found.stats.timedOut, true);
  assert.ok(found.stats.probed <= 1);
  await page.context().close();
});

test('diffStates: no change is null, a UA focus ring is not a change, a shifted box is a layout change', () => {
  const state = (values, rect = [0, 0, 100, 20]) => ({ values, tr: { duration: '0s' }, rect, kids: [], pseudo: {}, domCount: 10 });
  const rest = state({ color: 'red', 'outline-style': 'none', 'outline-color': 'x', 'outline-width': '0px' });
  assert.equal(diffStates(rest, state({ ...rest.values })), null);
  assert.equal(diffStates(rest, state({ ...rest.values, 'outline-style': 'auto', 'outline-color': 'blue', 'outline-width': '1px' })), null);
  const moved = diffStates(rest, state({ ...rest.values, color: 'blue' }, [0, 6, 100, 20]));
  assert.deepEqual(moved.changes, { color: ['red', 'blue'] });
  assert.equal(moved.layout, true);
  assert.deepEqual(moved.rect, [0, 6, 0, 0]);
});

test('spreadToGroups: a probed effect reaches the other members of its group, with its descendants rebased', () => {
  const groups = [{ sig: 'a|x', count: 3, paths: ['body>a:1', 'body>a:2', 'body>a:3'] }];
  const probe = { path: 'body>a:1', sig: 'a|x', source: 'probe', changes: { color: ['a', 'b'] }, kids: [{ path: 'body>a:1>span:1', changes: { opacity: ['0', '1'] } }] };
  const css = { path: 'body>div:1', sig: 'div|', source: 'css', changes: { color: ['a', 'b'] } };
  const { list, spread } = spreadToGroups([probe, css], groups);
  assert.equal(spread, 2);
  assert.deepEqual(list.map((e) => e.path), ['body>a:1', 'body>div:1', 'body>a:2', 'body>a:3']);
  assert.equal(list[3].kids[0].path, 'body>a:3>span:1');
  // Old captures (groups without paths) are left as they are.
  assert.equal(spreadToGroups([probe], [{ sig: 'a|x', count: 3 }]).spread, 0);
});

test('isScrollReveal: scroll triggers, and timed ones below the first screen; timed ones in the first screen are not', () => {
  assert.equal(isScrollReveal({ trigger: { kind: 'scroll' }, rect: [0, 100, 10, 10] }), true);
  assert.equal(isScrollReveal({ trigger: { kind: 'timed' }, rect: [0, 2400, 10, 10] }), true);
  assert.equal(isScrollReveal({ trigger: { kind: 'timed' }, rect: [0, 400, 10, 10] }), false);
});
