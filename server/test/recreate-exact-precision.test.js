// Exact mode, step 2 of "make the measurement honest": layout is sub-pixel, and the pipeline used to round it to
// whole pixels three separate times - in the capture, in the copy's own measurement, and again on the way out as
// CSS. One of three columns in a 1000 px row is 333.33 px wide; stored as 333 and written back as 333px, the copy
// was told to be a third of a pixel narrower than the original it was copying, and the exact comparison - which
// grades to a hundredth of a pixel - then charged it for the difference. These tests pin the precision end to end.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { collectRects } from '../src/recreate/verify/layout.js';
import { buildPageTree, isElement } from '../src/recreate/ir/tree.js';
import { buildStyles } from '../src/recreate/ir/styles.js';
import { cpathsOf } from '../src/recreate/generate.js';
import { boxLookups } from '../src/recreate/verify/exact/boxes.js';

const PORT = 4213;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Thirds</title><style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui; }
  .row { display: flex; width: 1000px; }
  .row > div { flex: 1; padding: 3.25px; border: 1.5px solid green; }
  .fixed { box-sizing: border-box; width: 200.5px; height: 60.5px; padding: 10.25px; border: 2.5px solid red; }
  .loose { box-sizing: content-box; width: 200.5px; height: 60.5px; padding: 10.25px; border: 2.5px solid red; }
  .spun { transform: rotate(10deg); width: 120.4px; height: 40.6px; padding: 5.25px; }
  .holder { position: relative; height: 120px; }
  .abs { position: absolute; left: 10.5px; top: 20.5px; width: 150.5px; height: 40.5px; background: #ccc; }
  .bar { display: flex; }
  .label { padding: 4px; background: #f0f0f0; }
  .grower { flex: 1 0 0; }
</style></head><body>
  <div class="row"><div data-sas-id="1">one</div><div data-sas-id="2">two</div><div data-sas-id="3">three</div></div>
  <div class="fixed" data-sas-id="4">fixed</div>
  <div class="loose" data-sas-id="5">loose</div>
  <div class="spun" data-sas-id="6">spun</div>
  <div class="holder"><div class="abs">abs</div></div>
  <div class="bar"><div class="label">label</div><div class="grower"></div></div>
</body></html>`;

let server;
let browser;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise((r) => server.close(r));
});

const open = async () => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  return { context, page };
};

/** Every element's box with no transform anywhere: the sub-pixel truth both sides are measured against. */
const truth = (page) => page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll('[data-sas-id]')) {
    const saved = el.style.transform;
    el.style.transform = 'none';
    const r = el.getBoundingClientRect();
    out[el.getAttribute('data-sas-id')] = [
      Math.round((r.left + scrollX) * 100) / 100, Math.round((r.top + scrollY) * 100) / 100,
      Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100,
    ];
    el.style.transform = saved;
  }
  return out;
});

/** Every captured box, flattened. The capture keys nodes by path; it does not keep data-sas-id. */
const boxesOf = (snap) => {
  const out = [];
  const walk = (n) => {
    if (n?.rect) out.push({ path: n.path, tag: n.tag, rect: n.rect });
    for (const c of n?.children ?? []) if (c?.tag) walk(c);
  };
  walk(snap.body);
  return out;
};

test('the capture keeps the fraction of a pixel the layout actually used', async () => {
  const { context, page } = await open();
  try {
    const boxes = boxesOf(await page.evaluate(snapshotPage, {}));
    assert.ok(boxes.length > 3, 'the page was captured');
    // A third of 1000 px cannot be a whole number, and it is no longer recorded as one.
    const thirds = boxes.filter((b) => /body>div:1>div:\d$/.test(b.path)).map((b) => b.rect[2]);
    assert.deepEqual(thirds, [333.33, 333.34, 333.33], 'three flex thirds, to the hundredth');
    // Never more precision than it claims: two decimals, so the stylesheet stays readable and diffable.
    for (const b of boxes) {
      for (const v of b.rect) assert.equal(v, Math.round(v * 100) / 100, `${b.path}: ${v} carries more than two decimals`);
    }
  } finally {
    await context.close();
  }
});

test('a rotated element is measured by its untransformed layout box, to the hundredth', async () => {
  // offsetWidth/offsetHeight are whole pixels and are not even defined for an SVG, so the box came out up to half a
  // pixel wrong - on both sides and at different points in the layout, so the error did not cancel.
  const { context, page } = await open();
  try {
    const want = await truth(page);
    const spun = boxesOf(await page.evaluate(snapshotPage, {})).find((b) => b.path === 'body>div:4');
    assert.ok(spun, 'the rotated element was captured');
    for (const i of [0, 1, 2, 3]) {
      assert.ok(Math.abs(spun.rect[i] - want['6'][i]) <= 0.01,
        `rotated box ${JSON.stringify(spun.rect)} against the truth ${JSON.stringify(want['6'])}`);
    }
    assert.ok(spun.rect.some((v) => Math.abs(v - Math.round(v)) > 0.001), 'and it is not a whole number');
  } finally {
    await context.close();
  }
});

test('both sides measure by one definition, so none of the difference between them is the measuring', async () => {
  // The copy is measured by verify/layout.js and the original by capture/snapshot.js. Whatever those two disagree
  // about is charged to the copy by the exact comparison, so on the same page they have to agree exactly.
  const { context, page } = await open();
  try {
    const captured = new Set(boxesOf(await page.evaluate(snapshotPage, {})).map((b) => JSON.stringify(b.rect)));
    const mine = await page.evaluate(collectRects);
    const ids = Object.keys(mine.rects);
    assert.equal(ids.length, 6, 'all six marked elements were measured');
    for (const id of ids) {
      assert.ok(captured.has(JSON.stringify(mine.rects[id])),
        `element ${id} measured ${JSON.stringify(mine.rects[id])}, which no captured box matches`);
    }
  } finally {
    await context.close();
  }
});

test('the stylesheet carries the fraction, and the node records what it wrote and what it asked for', async () => {
  // The third rounding: even with a sub-pixel capture, the IR used to write the number back out as a whole pixel,
  // so the copy was told to be a third of a pixel narrower than the original. And the two deliberate slacks - a text
  // width rounded up so the label cannot wrap, a minimum rounded down so boxes sharing a line cannot overflow - are
  // now recorded on the node, because the comparison was charging the copy for them on every run, by construction.
  const { context, page } = await open();
  try {
    const snapshot = await page.evaluate(snapshotPage, {});
    const tree = buildPageTree({ desktop: snapshot.body });
    const { rules } = buildStyles([tree], { assetFile: () => null });
    const nodes = [];
    const walk = (n) => {
      if (!isElement(n)) return;
      nodes.push(n);
      n.children.forEach(walk);
    };
    walk(tree.root);

    const written = rules.flatMap((r) => Object.entries(r.parts.base ?? {}))
      .filter(([, v]) => typeof v === 'string' && /^-?\d+\.\d+px$/.test(v));
    assert.ok(written.length > 0, `the stylesheet keeps fractional lengths, got ${JSON.stringify(rules.map((r) => r.parts.base))}`);
    // A size, not only an inset: the width of a box is the number the exact comparison grades, and it is the one
    // that used to be written back as a whole pixel.
    assert.ok(written.some(([prop]) => prop === 'width' || prop === 'height'),
      `a width or height keeps its fraction, got ${JSON.stringify(written)}`);

    // Which of its two sizes the copy decided, where it decided one. On most boxes it decides neither: a block in
    // normal flow is as wide as its parent and as tall as its content, and the IR writes no size at all - which is
    // exactly why those boxes cannot be held to a pixel. An absolutely positioned box and an empty flex item are
    // sized by the copy, and those are.
    const sized = new Map(nodes.filter((n) => n.sized).map((n) => [n.attrs?.class ?? n.tag, n.sized]));
    assert.equal(sized.get('abs')?.desktop, 'h', 'an absolute box: its height is written, its width comes from two insets');
    assert.equal(sized.get('grower')?.desktop, 'wh', 'an empty flex item: the copy writes both');
    assert.ok(!sized.has('label'), 'a box as big as its text is not something the copy wrote');
    for (const v of sized.values()) for (const value of Object.values(v)) assert.match(value, /^(wh|w|h)$/);

    // And where a pixel was added or taken off on purpose, the node carries the direction and the amount.
    const asked = nodes.filter((n) => n.slack);
    assert.ok(asked.some((n) => n.attrs?.class === 'label'), 'the minimum written a pixel under the captured width is recorded');
    for (const n of asked) {
      for (const view of Object.values(n.slack)) {
        for (const [lo, hi] of Object.values(view)) {
          assert.ok(Number.isFinite(lo) && Number.isFinite(hi) && lo <= 0 && hi >= 0, `slack ${lo}..${hi} must bracket zero`);
          assert.ok(Math.abs(lo) <= 2 && hi <= 2, `slack ${lo}..${hi} is larger than anything the emitter asks for`);
        }
      }
    }
    // What generate saves beside the IR, and what the comparison reads back out of it.
    for (const [i, n] of nodes.entries()) n.sid = i + 1;
    const saved = cpathsOf({ pages: [{ root: tree.root }] });
    assert.equal(saved.version, 2);
    const lookups = boxLookups(saved);
    assert.equal(lookups.graded, Object.keys(saved.sized).length);
    assert.ok(lookups.graded > 0, 'the grading reaches the comparison');
    for (const [sid, views] of Object.entries(saved.sized)) {
      const [view, value] = Object.entries(views)[0];
      assert.equal(lookups.sizedOf(sid, view), value);
    }
  } finally {
    await context.close();
  }
});
