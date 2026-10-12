// Exact mode, phase A6: the comparison itself. A real original is measured at two slots, then a faithful copy and a
// broken one are rendered at the same slots and compared - pixels, boxes, heights, pictures of what differs.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { captureExactPage } from '../src/recreate/capture/exact.js';
import { compareExact, fidelityExactDir, summarise } from '../src/recreate/verify/exact/compare.js';
import { slotFor } from '../src/recreate/verify/exact/slots.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4206;
const origin = `http://127.0.0.1:${PORT}`;

const body = (extra = '', cellHeight = 120, tagWidth = 200) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Original</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body { margin: 0; font: 16px/1.5 system-ui; background: #fff; }
  .bar { height: 60px; background: #123; color: #fff; }
  .cell { height: ${cellHeight}px; background: #eef; }
  .note { padding: 12px; }
  .tag { display: inline-block; width: ${tagWidth}px; background: #fe6; }
  @media (max-width: 700px) { .bar { height: 40px; } }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .spinner { width: 30px; height: 30px; background: #c33; animation: spin 1s linear infinite; }
</style></head><body>
  <div class="bar">Header</div>
  <div class="spinner"></div>
  <div class="cell">Panel one</div>
  <div class="note">Some words that fill a line or two of text on this page.</div>
  <div style="height: 1200px; background: linear-gradient(#fff, #f6f6f6)"></div>
  <div class="tagwrap"><span class="tag">Tag</span></div>
  ${extra}
<script>var n = 0; setInterval(function tick() { n++; }, 200);</script>
</body></html>`;

let server;
let browser;
let work;
const slots = [slotFor(1280), slotFor(768)];
const page = { path: '/', slug: 'index', url: `${origin}/`, outPath: 'index.html' };

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body());
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
  work = await mkdtemp(path.join(os.tmpdir(), 'sas-exactcmp-'));
  // The baseline: the original measured at both slots, exactly as the pipeline's step does it.
  await captureExactPage(browser, page, work, { slots });
});

after(async () => {
  await browser?.close().catch(() => {});
  server.close();
  await rm(work, { recursive: true, force: true });
});

/** A copy served from its own folder, as dist/ is. */
async function copyAt(folder, html) {
  const root = path.join(work, folder);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.html'), html);
  return root;
}

const baselineOf = async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(path.join(work, 'capture', 'index', 'exact', 'index.json'), 'utf8'));
  return { slots, pages: [manifest], noiseFloor: {} };
};

test('a copy that really is the same page matches at every size', async () => {
  const root = await copyAt('dist-same', body());
  const r = await compareExact({ root, workspace: work, baseline: await baselineOf(), pages: [page], scripts: false });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.slots, 2);
  assert.equal(r.accepted, 2, JSON.stringify(r.pages[0].slots.map((s) => ({ id: s.id, diff: s.diffRaw, boxes: s.boxes, h: [s.heightOriginal, s.heightCopy] }))));
  for (const slot of r.pages[0].slots) {
    assert.equal(slot.heightOk, true);
    assert.ok(slot.diffRaw <= 0.5, `${slot.id}: ${slot.diffRaw}%`);
    assert.equal(slot.boxes.missing, 0);
    assert.equal(slot.boxes.extra, 0);
    assert.equal(slot.boxes.within, slot.boxes.paired);
    // Nothing to show for a size that matches: no map, no crops.
    assert.equal(slot.map, undefined);
    assert.equal(slot.crops, undefined);
  }
  assert.deepEqual(r.causes, {});
});

test('a copy missing an element is caught, named and pictured', async () => {
  const root = await copyAt('dist-missing', body().replace('<div class="note">Some words that fill a line or two of text on this page.</div>', ''));
  const r = await compareExact({ root, workspace: work, baseline: await baselineOf(), pages: [page], scripts: false });
  assert.equal(r.accepted, 0);
  const slot = r.pages[0].slots.find((s) => s.id === '1280');
  assert.equal(slot.boxes.missing, 1);
  assert.equal(slot.boxes.missingItems[0].key.startsWith('some words'), true);
  assert.equal(slot.heightOk, false, 'and the page is shorter for it');
  // A size that failed keeps a map of where and a magnified look at the worst places.
  assert.ok(slot.map, 'a map was written');
  assert.ok(slot.crops?.length >= 1, 'at least one crop');
  const files = await readdir(fidelityExactDir(work, 'index'));
  assert.ok(files.includes(slot.map));
  for (const c of slot.crops) {
    assert.ok(files.includes(c.file));
    assert.equal(c.zoom, 3);
  }
  assert.equal(r.causes['missing-element'], 2, 'once per slot');
  assert.ok(r.causes['page-height'] >= 1);
});

test('a copy whose box is a few pixels out is caught even though the page is the same height', async () => {
  // A panel 8 px taller: the page height changes by 8, the boxes below move, the pixels differ.
  const root = await copyAt('dist-shifted', body('', 128));
  const r = await compareExact({ root, workspace: work, baseline: await baselineOf(), pages: [page], scripts: false });
  const slot = r.pages[0].slots.find((s) => s.id === '1280');
  assert.equal(slot.accepted, false);
  assert.equal(slot.boxes.missing, 0, 'nothing is missing - it moved');
  assert.ok(slot.boxes.within < slot.boxes.paired, 'something is out of place');
  const moved = slot.boxes.worst.some((w) => Math.abs(w.delta[1]) >= 7 || Math.abs(w.delta[3]) >= 7);
  assert.ok(moved, `nothing moved: ${JSON.stringify(slot.boxes.worst.map((w) => w.delta))}`);
  assert.ok(slot.diffRaw > 0);
});

test('the copy is held to loading nothing from anywhere else', async () => {
  const root = await copyAt('dist-external', body('<img src="http://127.0.0.1:9/outside.png" width="40" height="40" alt="">'));
  const r = await compareExact({ root, workspace: work, baseline: await baselineOf(), pages: [page], scripts: false });
  const slot = r.pages[0].slots.find((s) => s.id === '1280');
  // The request is blocked by the renderer, and recorded: a copy must carry its own files.
  assert.ok(slot.failedRequests?.length >= 1, JSON.stringify(slot.failedRequests));
  assert.match(slot.failedRequests[0].url, /outside\.png/);
});

test('a page measured on an earlier attempt is handed back instead of measured again', async () => {
  // The pass costs about four minutes a page on a real site, and an interruption on the last page used to throw
  // away every page before it. So a finished page goes to `onPage` and comes back through `done`.
  const root = await copyAt('dist-reuse', body());
  const base = await baselineOf();

  const kept = new Map();
  const first = await compareExact({
    root, workspace: work, baseline: base, pages: [page], scripts: false,
    onPage: (result) => { kept.set(result.slug, result); },
  });
  assert.equal(first.reused, 0, 'nothing to reuse on the first attempt');
  assert.equal(kept.size, 1, 'the page was written as soon as it was done');
  assert.equal(kept.get(page.slug).slots.length, first.pages[0].slots.length);

  // The second attempt opens no page: the numbers come from what was kept, and they are the same numbers.
  let opened = 0;
  const second = await compareExact({
    root, workspace: work, baseline: base, pages: [page], scripts: false,
    done: (slug) => { opened++; return kept.get(slug) ?? null; },
  });
  assert.equal(opened, 1, 'it asked');
  assert.equal(second.reused, 1);
  assert.equal(second.slots, first.slots, 'the same sizes are accounted for');
  assert.equal(second.accepted, first.accepted);
  assert.deepEqual(second.causes, first.causes);
  assert.equal(second.pages[0].reused, true, 'and the report says it was not measured again');

  // What was never kept is measured: a `done` that answers nothing behaves like the first attempt.
  const third = await compareExact({
    root, workspace: work, baseline: base, pages: [page], scripts: false, done: () => null,
  });
  assert.equal(third.reused, 0);
  assert.equal(third.accepted, first.accepted);
});

test('a page the original was never measured at is said so, not skipped quietly', async () => {
  const root = await copyAt('dist-same', body());
  const r = await compareExact({
    root, workspace: work, baseline: await baselineOf(), scripts: false,
    pages: [page, { path: '/other', slug: 'other', outPath: 'other.html' }],
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /was not measured/);
});

test('the noise floor raises the bar a size has to clear', async () => {
  const root = await copyAt('dist-same', body());
  const base = await baselineOf();
  const strict = await compareExact({ root, workspace: work, baseline: base, pages: [page], scripts: false });
  const lenient = await compareExact({
    root, workspace: work, baseline: base, pages: [page], scripts: false, noise: { 1280: 2 },
  });
  assert.equal(strict.pages[0].slots.find((s) => s.id === '1280').limit, 0.5);
  assert.equal(lenient.pages[0].slots.find((s) => s.id === '1280').limit, 4, 'twice the noise');
});

test('summarise counts the sizes that matched and groups what is left by cause', () => {
  const s = summarise([{
    page: '/',
    slots: [
      { id: '1440', accepted: true, diffRaw: 0.1 },
      {
        id: '375',
        accepted: false,
        diffRaw: 3.2,
        heightOk: true,
        pixelsOk: false,
        // Eight of ten boxes within a pixel; of the two that are not, one is a length the copy wrote itself and
        // one is a text length past its budget. They are different findings and are counted as such.
        boxes: { missing: 2, extra: 0, paired: 10, within: 8, hard: 1, textBeyond: 1, beyondCorrectors: 6, slackUsed: 3 },
        frozen: { loopsOnlyOriginal: 1 },
      },
    ],
  }]);
  assert.equal(s.slots, 2);
  assert.equal(s.accepted, 1);
  assert.equal(s.pct, 50);
  assert.equal(s.diffWorst, 3.2);
  assert.equal(s.causes['missing-element'], 2);
  assert.equal(s.causes['box-out-of-place'], 1, 'a length the copy decided and got wrong');
  assert.equal(s.causes['font-metric'], 1, 'a text length past what type can explain, named separately');
  assert.equal(s.causes.pixels, 1);
  assert.equal(s.causes['loop-missing'], 1);
  assert.equal(s.worst[0].slot, '375');
  // What the box check was able to ask of the copy, which is the number "nothing was kept" has to be read against.
  assert.deepEqual(s.boxes, {
    paired: 10, within: 8, hard: 1, textBeyond: 1, beyondCorrectors: 6, slackUsed: 3, budget: 2, tolerance: 1,
  });
});

test('a box inside the text budget is not a cause at all: it is the one thing no corrector may touch', () => {
  // The whole point of the grading. Before it, every box that was not within a pixel counted against the slot -
  // including the boxes whose size is the text inside them, which every corrector refuses to touch by design
  // (verify/correct.js hasOwnText). A copy differing by a fraction of a pixel of type was scored as a failure.
  const s = summarise([{
    page: '/',
    slots: [{
      id: '1440', accepted: false, diffRaw: 0.17, heightOk: true, pixelsOk: true,
      boxes: { missing: 0, extra: 0, paired: 45, within: 41, hard: 0, textBeyond: 0, beyondCorrectors: 40 },
    }],
  }]);
  assert.equal(s.causes['box-out-of-place'], undefined);
  assert.equal(s.causes['font-metric'], undefined);
  assert.equal(s.boxes.beyondCorrectors, 40);
});

test('the gate holds the copy to a pixel where the copy chose the size, and to a budget where the text did', async () => {
  // The whole of step 1, through a real browser. One text box is a pixel and a half wider in the copy: the page is
  // the same height, the pixels differ by a sliver, and the only thing that can decide the slot is the box rule.
  //
  // Which answer is right depends on something the box itself cannot say. If the copy wrote that width, the number
  // is the copy's own and being 1.5 px out is its error. If the width is whatever the text inside came to, no
  // declaration the copy can write changes it - and every corrector refuses to touch such a box
  // (verify/correct.js hasOwnText), so failing the slot for it asks the engine for something it is forbidden to
  // attempt. That is what made a copy differing by 0.17 % of its pixels score as 0 of 198.
  const root = await copyAt('dist-wider-tag', body('', 120, 201.5));
  const ids = (html) => html.replace('<span class="tag">', '<span class="tag" data-sas-id="7">');
  const overrides = new Map([['index.html', ids(body('', 120, 201.5))]]);
  const cpathOf = (sid) => (Number(sid) === 7 ? 'body>div:6>span:1' : null);
  const base = await baselineOf();
  const run = (extra) => compareExact({ root, workspace: work, baseline: base, pages: [page], scripts: false, overrides, cpathOf, ...extra });

  const sized = await run({ sizedOf: () => 'wh', viewAt: () => 'desktop' });
  const slot = sized.pages[0].slots.find((s) => s.id === '1280');
  assert.equal(slot.boxes.byPath, 1, 'the box was paired by the element it came from');
  assert.equal(slot.heightOk, true, 'the page is the same height');
  assert.equal(slot.boxes.hard, 1, JSON.stringify(slot.boxes.worst));
  assert.equal(slot.boxesOk, false, 'a width the copy wrote and got wrong fails the size');
  assert.equal(sized.causes['box-out-of-place'] >= 1, true);

  // The same difference on a box whose width is its text: reported, under its own name, and not charged.
  const text = await run({});
  const same = text.pages[0].slots.find((s) => s.id === '1280');
  assert.equal(same.boxes.hard, 0);
  assert.equal(same.boxes.textBeyond, 0, 'a pixel and a half is inside what type explains');
  assert.ok(same.boxes.beyondCorrectors >= 1, 'and the report says the loop was never allowed to try it');
  assert.equal(same.boxesOk, true);
  assert.equal(text.causes['font-metric'], undefined);

  // And the pixel the emitter asks for on purpose is expected rather than charged, through the same path.
  const asked = await run({ sizedOf: () => 'wh', slackOf: () => ({ w: [0, 1.5] }), viewAt: () => 'desktop' });
  const excused = asked.pages[0].slots.find((s) => s.id === '1280');
  assert.equal(excused.boxes.hard, 0, JSON.stringify(excused.boxes.worst));
  assert.equal(excused.boxes.slackUsed, 1);

  // The numbers the report needs to be read at all.
  assert.ok(sized.boxes.paired > 0);
  assert.equal(sized.boxes.tolerance, 1);
  assert.equal(sized.boxes.budget, 2);
});
