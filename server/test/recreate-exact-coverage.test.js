// Exact mode, phase B1: what the capture used to trade away to stay small. A page that uses every one of those
// things is captured in both modes, and the two captures are compared with each other.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { normalizeView } from '../src/recreate/ir/styles.js';

const PORT = 4207;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Edges</title><style>
  body { margin: 0; font: 16px/1.5 system-ui; }
  .masked {
    width: 80px; height: 80px; background: #345;
    -webkit-mask-image: linear-gradient(#000, transparent);
    mask-image: linear-gradient(#000, transparent);
  }
  .layer { will-change: transform, opacity; }
  .pivot { transform-origin: 20px 80%; }
  .deep { perspective: 400px; perspective-origin: 10% 90%; }
  .ratio { aspect-ratio: auto 16 / 9; width: 160px; background: #eee; }
  ul.list { list-style: disc; }
  ul.list li::marker { color: rgb(200, 30, 30); font-weight: 700; }
  input.field::placeholder { color: rgb(120, 120, 120); font-style: italic; }
  p.para::first-line { font-weight: 700; color: rgb(10, 60, 120); }
  p.para::first-letter { font-size: 32px; color: rgb(180, 60, 0); }
  @supports (display: grid) { .grid-only { display: grid; gap: 4px; } }
  @layer theme { .themed { color: rgb(30, 90, 30); } }
  @container (min-width: 1px) { .contained { outline: 1px solid rgb(0, 0, 0); } }
  @keyframes huge { ${Array.from({ length: 1200 }, (_, i) => `${(i / 12).toFixed(3)}% { transform: translate3d(${i}px, ${i}px, 0) rotate(${i}deg) scale(1.${i}); filter: blur(${i % 7}px); }`).join(" ")} }
  @keyframes long { ${Array.from({ length: 140 }, (_, i) => `${(i / 1.4).toFixed(2)}% { transform: translateX(${i}px) rotate(${i}deg); }`).join(' ')} }
  .spin { animation: long 9s linear infinite; }
  .shadowed { --long-shadow: ${Array.from({ length: 40 }, (_, i) => `${i}px ${i}px 0 rgba(0,0,0,0.0${i % 10})`).join(', ')}; box-shadow: var(--long-shadow); }
</style></head><body>
  <div class="masked"></div>
  <div class="layer">A layer of its own</div>
  <div class="pivot">Pivoted</div>
  <div class="deep">Deep</div>
  <div class="ratio"></div>
  <ul class="list"><li>First item</li><li>Second item</li></ul>
  <input class="field" placeholder="Type here">
  <p class="para">A paragraph whose first line and first letter are styled differently from the rest of it.</p>
  <div class="grid-only"><span>one</span><span>two</span></div>
  <div class="themed">Themed</div>
  <div class="contained">Contained</div>
  <div class="spin">Spinning</div>
  <div class="shadowed">Shadowed</div>
</body></html>`;

let server;
let browser;
const snap = {};

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(200);
  snap.normal = await page.evaluate(snapshotPage, {});
  snap.exact = await page.evaluate(snapshotPage, { exact: true });
  await context.close();
});

after(async () => {
  await browser?.close().catch(() => {});
  server.close();
});

/** The first node whose class attribute includes `cls`. */
function find(root, cls) {
  const hit = (n) => {
    if (n.attrs?.class?.split(/\s+/).includes(cls)) return n;
    for (const c of n.children ?? []) {
      const found = c.children || c.attrs ? hit(c) : null;
      if (found) return found;
    }
    return null;
  };
  return hit(root);
}

test('a mask decides which pixels are painted, and is captured', () => {
  const exact = find(snap.exact.body, 'masked');
  assert.ok(exact.style['mask-image'], JSON.stringify(Object.keys(exact.style)));
  // Honest limit: this Chromium does not enumerate the -webkit- mask aliases at all, so the carve-out in SKIP_PROP
  // is future-proofing rather than a fix - and ir/styles.js URL_PROPS' -webkit-mask-image entry stays dead code.
  const enumerated = Object.keys(exact.style).filter((k) => k.startsWith('-webkit-mask'));
  assert.deepEqual(enumerated, []);
});

test('the properties a copy needs only when it must be exact', () => {
  const deep = find(snap.exact.body, 'deep');
  assert.ok(deep.style['perspective-origin'], 'where a 3D transform pivots is kept');
  assert.notEqual(
    deep.style['perspective-origin'],
    `${deep.rect[2] / 2}px ${deep.rect[3] / 2}px`,
    'and it is a real origin, not the centre every element has',
  );
  assert.equal(find(snap.normal.body, 'deep').style?.['perspective-origin'], undefined);
  // An origin with no transform yet: a hover or another view may transform the element later.
  // Chrome resolves the percentage to pixels here too; what matters is that the authored origin survives.
  const pivot = find(snap.exact.body, 'pivot');
  assert.match(pivot.style['transform-origin'], /^20px /);
  assert.notEqual(pivot.style['transform-origin'], `${pivot.rect[2] / 2}px ${pivot.rect[3] / 2}px`);
  assert.equal(find(snap.normal.body, 'pivot').style?.['transform-origin'], undefined);
  // And an origin that is simply the centre of its own box - which every element has - is not written out.
  assert.equal(find(snap.exact.body, 'ratio').style?.['transform-origin'], undefined);
  assert.equal(find(snap.exact.body, 'themed').style?.['perspective-origin'], undefined);
  // "auto 16 / 9" holds a ratio that exists nowhere else.
  assert.match(find(snap.exact.body, 'ratio').style['aspect-ratio'] ?? '', /16/);
  assert.equal(find(snap.normal.body, 'ratio').style['aspect-ratio'], undefined);
});

test('the pseudo-elements that have no content of their own are captured', () => {
  const li = find(snap.exact.body, 'list').children.find((c) => c.tag === 'li');
  assert.equal(li.pseudo.marker.style.color, 'rgb(200, 30, 30)');
  assert.equal(find(snap.exact.body, 'field').pseudo.placeholder.style['font-style'], 'italic');
  const para = find(snap.exact.body, 'para');
  assert.equal(para.pseudo['first-line'].style['font-weight'], '700');
  assert.equal(para.pseudo['first-letter'].style['font-size'], '32px');
  // None of them is captured for an ordinary copy, which is why it stays small.
  assert.equal(find(snap.normal.body, 'para').pseudo, undefined);
});

test('a long animation and a long custom property are kept whole', () => {
  const normalLong = snap.normal.keyframes.find((k) => k.name === 'long');
  const exactLong = snap.exact.keyframes.find((k) => k.name === 'long');
  // A hundred-step animation is a few thousand characters. The ordinary capture used to drop it, which left the
  // element still asking for the animation while the rule it names never shipped: it simply never ran, and nothing
  // anywhere said so. The ordinary cap is now large enough for a real animation.
  assert.ok(normalLong.css && normalLong.css.length > 4000, `the ordinary capture keeps it too, got ${normalLong.css?.length}`);
  assert.ok(exactLong.css && exactLong.css.length > 4000, `kept ${exactLong.css?.length} characters`);
  const normalVar = find(snap.normal.body, 'shadowed').style?.['--long-shadow'];
  const exactVar = find(snap.exact.body, 'shadowed').style?.['--long-shadow'];
  assert.ok(exactVar && exactVar.length > 400, `kept ${exactVar?.length} characters`);
  assert.equal(normalVar, undefined, 'and the normal capture dropped it for being long');
});

test('an animation too long even for the raised cap is named, not quietly thrown away', () => {
  // The rule the project works to: anything the tool could not carry over is a counted, named row. A dropped
  // @keyframes is invisible in the markup - the element keeps `animation: huge ...` and simply stands still - so
  // without this it was the one kind of loss a reader of the report could never find.
  const huge = snap.normal.keyframes.find((k) => k.name === 'huge');
  assert.ok(huge, 'the animation is still listed by name');
  assert.equal(huge.css, null, 'its body was too long to keep');
  assert.ok(huge.bytes > 40000, `and how long is recorded: ${huge.bytes}`);
  // The exact capture keeps far more, so this one is only a loss for an ordinary copy.
  const exactHuge = snap.exact.keyframes.find((k) => k.name === 'huge');
  assert.ok(exactHuge.css && exactHuge.css.length > 40000, `an exact copy keeps it whole, got ${exactHuge.css?.length}`);
});

test('the condition a block of rules hangs off is recorded, not only the rules', () => {
  const kinds = (snap.exact.atRules ?? []).map((r) => r.kind);
  assert.ok(kinds.includes('supports'), JSON.stringify(snap.exact.atRules));
  assert.ok(kinds.includes('layer'));
  assert.ok(kinds.includes('container'));
  const supports = snap.exact.atRules.find((r) => r.kind === 'supports');
  assert.match(supports.condition, /display: *grid/);
  assert.ok(supports.rules >= 1);
  // Media queries keep their own field, with the weight that ranks a breakpoint.
  assert.ok(snap.exact.mediaRules !== undefined);
});

test('will-change survives into the stylesheet of an exact copy, and not otherwise', () => {
  const node = {
    tag: 'div', attrs: {}, children: [],
    views: { desktop: { rect: [0, 0, 100, 20], style: { 'will-change': 'transform', color: 'rgb(1, 2, 3)' } } },
  };
  const opts = { assetFile: () => null };
  const normal = normalizeView(node, 'desktop', [node], { ...opts });
  const exact = normalizeView(node, 'desktop', [node], { ...opts, asIs: true });
  assert.equal(normal['will-change'], undefined, 'an ordinary copy drops the hint');
  assert.equal(exact['will-change'], 'transform', 'an exact copy keeps it: it decides the compositing layer');
  assert.equal(exact.color, 'rgb(1, 2, 3)');
});
