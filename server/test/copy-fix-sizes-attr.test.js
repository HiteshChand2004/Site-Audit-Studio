// The `sizes` fix for pictures that already choose among their own files (copy/perfAsIs.js planPerf sizesBySrc, fixImageSizes
// → fixSizesAttr). A builder writes srcset with a `sizes` far larger than where the picture is drawn (Framer: 100vw for a card),
// so the browser takes a larger file than it needs. The copy keeps every file, src and srcset, and only says where the
// picture is drawn. No browser: the probe is written by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import { fixImageSizes, planPerf, sizesAttr } from '../src/copy/perfAsIs.js';

const WIDTHS = [[375, 812], [1440, 900]];
const page = { path: '/', outPath: 'index.html' };
const DRAWN = [[320, 280], [375, 300], [768, 300], [1440, 300], [1920, 300]];

const img = (src, k, total, extra = {}) => ({ src, k, total, visible: true, top: 3000, left: 0, right: 300, inScroller: false, lazyLib: false, loading: null, fetchpriority: null, chooses: true, moves: false, nw: 1600, ...extra });
/** A probe of two widths; the desktop one carries the drawn widths of every image it saw. */
const probe = (images) => ({
  widths: WIDTHS.map(([width, viewportH]) => {
    const list = images(width);
    return { width, viewportH, lcp: null, lcpChain: [], images: list, ...(width === 1440 && { drawn: Object.fromEntries(list.map((im) => [`${im.k}|${im.src}`, DRAWN])) }) };
  }),
});
const markup = (body) => load(`<!doctype html><html><head></head><body>${body}</body></html>`);
const SRCSET = '/img/a-320.jpg 320w, /img/a-1024.jpg 1024w, /img/a.jpg 1600w';

async function withCopy(files, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-sizes-'));
  try {
    await mkdir(path.join(dir, 'img'), { recursive: true });
    for (const f of files) await writeFile(path.join(dir, f), 'x');
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const ALL = ['img/a-320.jpg', 'img/a-1024.jpg', 'img/a.jpg'];

test('a 100vw sizes on a picture drawn 300 px wide is rewritten; src and srcset stay as written', () => withCopy(ALL, async (dir) => {
  const $ = markup(`<img src="/img/a.jpg" srcset="${SRCSET}" sizes="100vw" alt="">`);
  const plan = planPerf(probe(() => [img('/img/a.jpg', 0, 1)]), '/');
  assert.ok(plan.sizesBySrc.has('/img/a.jpg'));
  const r = await fixImageSizes($, page, dir, plan);
  const a = $('img').get(0).attribs;
  assert.equal(a.sizes, sizesAttr(DRAWN));
  assert.equal(a.srcset, SRCSET);
  assert.equal(a.src, '/img/a.jpg');
  assert.equal(r.fixed.length, 1);
  assert.deepEqual({ attr: r.fixed[0].attr, from: r.fixed[0].from, file: r.fixed[0].file }, { attr: 'sizes', from: '100vw', file: undefined });
  assert.deepEqual(r.open, []);
}));

test('an x srcset, a picture inside <picture>, sizes="auto" and a candidate missing from the copy are left as they are', () => withCopy(ALL.slice(1), async (dir) => {
  const $ = markup([
    '<img src="/img/a.jpg" srcset="/img/a-1024.jpg 1x, /img/a.jpg 2x" alt="">',
    `<picture><img src="/img/a.jpg" srcset="/img/a-1024.jpg 1024w, /img/a.jpg 1600w" sizes="100vw" alt=""></picture>`,
    '<img src="/img/a.jpg" srcset="/img/a-1024.jpg 1024w, /img/a.jpg 1600w" sizes="auto, 100vw" loading="lazy" alt="">',
    `<img src="/img/a.jpg" srcset="${SRCSET}" sizes="100vw" alt="">`,
  ].join(''));
  const plan = planPerf(probe(() => [0, 1, 2, 3].map((k) => img('/img/a.jpg', k, 4))), '/');
  const before = $('img').toArray().map((el) => ({ ...el.attribs }));
  const r = await fixImageSizes($, page, dir, plan);
  assert.equal(r.fixed.length, 0);
  assert.deepEqual($('img').toArray().map((el) => ({ ...el.attribs })), before);
}));

test('three copies in the markup, one in the page (a builder\'s breakpoint versions): every copy gets the new sizes', () => withCopy(ALL, async (dir) => {
  const $ = markup(Array.from({ length: 3 }, () => `<img src="/img/a.jpg" srcset="${SRCSET}" sizes="100vw" alt="">`).join(''));
  const plan = planPerf(probe(() => [img('/img/a.jpg', 0, 1)]), '/');
  const r = await fixImageSizes($, page, dir, plan);
  assert.equal(r.fixed.length, 3);
  assert.ok($('img').toArray().every((el) => el.attribs.sizes === sizesAttr(DRAWN)));
}));

test('a picture that does not choose, or moves, is not given a sizes; a srcset whose smallest file is too wide is reported', () => withCopy(['img/b-1200.jpg', 'img/b.jpg'], async (dir) => {
  const moving = planPerf(probe(() => [img('/img/a.jpg', 0, 1, { moves: true })]), '/');
  assert.equal(moving.sizesBySrc.has('/img/a.jpg'), false);
  const single = planPerf(probe(() => [img('/img/a.jpg', 0, 1, { chooses: false })]), '/');
  assert.equal(single.sizesBySrc.has('/img/a.jpg'), false);
  const $ = markup('<img src="/img/b.jpg" srcset="/img/b-1200.jpg 1200w, /img/b.jpg 2400w" sizes="100vw" alt="">');
  const plan = planPerf(probe(() => [img('/img/b.jpg', 0, 1)]), '/');
  const r = await fixImageSizes($, page, dir, plan);
  assert.equal(r.fixed.length, 1);
  assert.equal(r.open.length, 1);
  assert.match(r.open[0].detail, /\/img\/b\.jpg: the smallest file it offers is 1200 px wide, drawn at most 300 px/);
}));
