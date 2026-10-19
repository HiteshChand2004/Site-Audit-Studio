// Perceptual visual diff of two full-page screenshots of the same page and view (Phase 4b.7). It replaces the
// rough 96 px colour-distance comparison (layout.js visualSimilarity, still used where two builds of the
// same IR must match pixel for pixel: verify/equivalence.js) wherever the recreate is compared with the
// ORIGINAL: the fidelity check and the responsive sweep.
//
// Method (structural similarity, SSIM): both screenshots are scaled to the same width and compared block by
// block on luma - mean, contrast and structure of each block - and on the block's mean colour, so a wrong
// background hue or a missing image counts although the brightness is alike. Two scales: a detail scale
// (blocks of 8 px at 384 px wide: edges, text blocks, images) and a layout scale (blocks of 4 px at 96 px
// wide, forgiving about small shifts: section positions, big colour areas). Rows only one page has count as
// completely different, so a wrong page height costs score. Result 0–1, plus the page in horizontal bands
// (where the difference is) and an optional heatmap image.
//
// On request the block scores are also handed out instead of being thrown away: `regions` groups the blocks the two
// pages disagree on into boxes (fractions of the page, so they fit in report.json) and says whether each one is also
// different at the layout scale; `blocks` gives the raw maps. That is what lets the correction loop ask "which
// elements sit in this box" rather than only "this page scores 85".
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// `blur` (sigma, px at that scale) takes the edge off thin structure first: text lines a few px apart in the two pages
// are the same text, not a different page.
export const DETAIL = { width: 384, block: 8, blur: 2 };
export const LAYOUT = { width: 96, block: 4, blur: 0 };
export const SCALE_WEIGHTS = { detail: 0.5, layout: 0.5 };
export const BANDS = 10;
// SSIM stabilisers for 8-bit luma.
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
// Mean-colour difference of a block that is ignored (anti-aliasing, scaling) and the one that counts as fully different.
const COLOR_FREE = 12;
const COLOR_FULL = 112;
// A block this far below 1 is "different" for the purpose of finding WHERE the pages differ (regionsOf). Clusters of
// fewer blocks than MIN_BLOCKS are noise (a letter, an icon edge); neighbouring clusters within MERGE_GAP blocks are
// one place to look at.
export const BAD_BLOCK = 0.65;
const MIN_BLOCKS = 6;
const MERGE_GAP = 1;
const MAX_REGIONS = 12;

async function load(input, { width, blur }) {
  // Read files into memory first: sharp keeps a cached handle on files it opens by path, and Windows cannot
  // rename the workspace folder while a handle is open.
  const buffer = typeof input === 'string' ? await readFile(input) : input;
  let image = sharp(buffer).resize({ width }).removeAlpha();
  if (blur > 0) image = image.blur(blur);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Block scores of one scale: scores[row * cols + col] in 0–1; blocks below the shorter image count as 0.
 * `both` is the number of rows both images have, so a caller can tell a real difference from a height difference.
 * @returns {{ scores: Float32Array, cols: number, rows: number, both: number, onlyOne: number }}
 */
function compareScale(a, b, { block }) {
  const cols = Math.floor(a.width / block);
  const rowsA = Math.floor(a.height / block);
  const rowsB = Math.floor(b.height / block);
  const rows = Math.max(rowsA, rowsB);
  const both = Math.min(rowsA, rowsB);
  const scores = new Float32Array(cols * rows);
  const n = block * block;
  for (let by = 0; by < both; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      let ra = 0;
      let ga = 0;
      let ba = 0;
      let rb = 0;
      let gb = 0;
      let bb = 0;
      for (let y = 0; y < block; y++) {
        let i = ((by * block + y) * a.width + bx * block) * 3;
        for (let x = 0; x < block; x++, i += 3) {
          const ya = 0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2];
          const yb = 0.299 * b.data[i] + 0.587 * b.data[i + 1] + 0.114 * b.data[i + 2];
          sa += ya;
          sb += yb;
          saa += ya * ya;
          sbb += yb * yb;
          sab += ya * yb;
          ra += a.data[i];
          ga += a.data[i + 1];
          ba += a.data[i + 2];
          rb += b.data[i];
          gb += b.data[i + 1];
          bb += b.data[i + 2];
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      const ssim = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      const dColor = Math.max(Math.abs(ra - rb), Math.abs(ga - gb), Math.abs(ba - bb)) / n;
      const colorFactor = 1 - Math.min(1, Math.max(0, dColor - COLOR_FREE) / (COLOR_FULL - COLOR_FREE));
      scores[by * cols + bx] = Math.min(1, Math.max(0, ssim)) * colorFactor;
    }
  }
  return { scores, cols, rows, both, onlyOne: (rows - both) / Math.max(1, rows) };
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const round3 = (n) => Math.round(n * 1000) / 1000;

/** The page in `count` horizontal bands: [{ from, to, score }] (fractions of the longer page). */
function bandsOf({ scores, cols, rows }, count = BANDS) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const r0 = Math.floor((i * rows) / count);
    const r1 = Math.max(r0 + 1, Math.floor(((i + 1) * rows) / count));
    out.push({ from: round3(r0 / rows), to: round3(Math.min(1, r1 / rows)), score: round3(mean(Array.from(scores.subarray(r0 * cols, Math.min(rows, r1) * cols)))) });
  }
  return out;
}

/** Mean block score of one scale over a box given as fractions of the whole map. 1 (= agrees) when the box is empty. */
function meanInBox({ scores, cols, rows }, fx, fy, fw, fh) {
  const x0 = Math.max(0, Math.min(cols - 1, Math.floor(fx * cols)));
  const y0 = Math.max(0, Math.min(rows - 1, Math.floor(fy * rows)));
  const x1 = Math.min(cols, Math.max(x0 + 1, Math.ceil((fx + fw) * cols)));
  const y1 = Math.min(rows, Math.max(y0 + 1, Math.ceil((fy + fh) * rows)));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++, n++) sum += scores[y * cols + x];
  }
  return n ? sum / n : 1;
}

/** Connected groups (4-neighbour) of blocks below BAD_BLOCK, within the rows both images have. */
function clusterBad({ scores, cols, both }) {
  const seen = new Uint8Array(cols * both);
  const out = [];
  const stack = [];
  const bad = (i) => !seen[i] && scores[i] < BAD_BLOCK;
  for (let start = 0; start < cols * both; start++) {
    if (!bad(start)) continue;
    seen[start] = 1;
    stack.push(start);
    const box = { x0: cols, y0: both, x1: -1, y1: -1, blocks: 0, miss: 0 };
    while (stack.length) {
      const i = stack.pop();
      const x = i % cols;
      const y = (i - x) / cols;
      box.blocks++;
      box.miss += 1 - scores[i];
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
      if (x > 0 && bad(i - 1)) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < cols - 1 && bad(i + 1)) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && bad(i - cols)) { seen[i - cols] = 1; stack.push(i - cols); }
      if (y < both - 1 && bad(i + cols)) { seen[i + cols] = 1; stack.push(i + cols); }
    }
    out.push(box);
  }
  return out;
}

/** Boxes touching or within `gap` blocks of each other become one box. */
function mergeBoxes(list, gap = MERGE_GAP) {
  const boxes = list.slice();
  for (let again = true; again;) {
    again = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.x0 - gap > b.x1 || b.x0 - gap > a.x1 || a.y0 - gap > b.y1 || b.y0 - gap > a.y1) continue;
        boxes[i] = {
          x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
          blocks: a.blocks + b.blocks, miss: a.miss + b.miss,
        };
        boxes.splice(j, 1);
        again = true;
        break outer;
      }
    }
  }
  return boxes;
}

/**
 * Where the two pages differ, as boxes in fractions of (image width, longer page height), worst first.
 * `coarse` = the same area is also different at the layout scale, so it is a real difference of geometry or of a
 * large colour area; a region that is different at the detail scale only is thin structure - text anti-aliasing, a
 * font rendered a shade differently - and must never drive a correction.
 * `onlyOne` marks the tail only one of the two pages has (a wrong page height), reported as one region.
 * @returns {{ fx: number, fy: number, fw: number, fh: number, score: number, coarse: boolean, blocks: number, miss: number, onlyOne: boolean }[]}
 */
function regionsOf(detail, layout) {
  const { cols, rows, both } = detail;
  const out = mergeBoxes(clusterBad(detail)).filter((b) => b.blocks >= MIN_BLOCKS).map((b) => {
    const fx = b.x0 / cols;
    const fy = b.y0 / rows;
    const fw = (b.x1 + 1 - b.x0) / cols;
    const fh = (b.y1 + 1 - b.y0) / rows;
    return {
      fx: round3(fx), fy: round3(fy), fw: round3(fw), fh: round3(fh),
      score: round3(1 - b.miss / b.blocks),
      coarse: meanInBox(layout, fx, fy, fw, fh) < BAD_BLOCK,
      blocks: b.blocks,
      miss: round3(b.miss),
      onlyOne: false,
    };
  });
  if (both < rows) {
    const tail = (rows - both) * cols;
    out.push({
      fx: 0, fy: round3(both / rows), fw: 1, fh: round3((rows - both) / rows),
      score: 0, coarse: true, blocks: tail, miss: tail, onlyOne: true,
    });
  }
  return out.sort((a, b) => b.miss - a.miss).slice(0, MAX_REGIONS);
}

/**
 * A region in the page's own pixels. The caller holds the numbers: the screenshot width it rendered at and the
 * height of the longer of the two pages.
 * @param {{ fx: number, fy: number, fw: number, fh: number }} region
 * @param {{ width: number, height: number }} page
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function toPageBox({ fx, fy, fw, fh }, { width, height }) {
  return { x: Math.round(fx * width), y: Math.round(fy * height), w: Math.round(fw * width), h: Math.round(fh * height) };
}

/** Heatmap image (WebP) of the block scores: transparent where the pages agree, red where they differ. */
async function writeHeatmap({ scores, cols, rows }, file, scale) {
  const rgba = Buffer.alloc(cols * rows * 4);
  for (let i = 0; i < scores.length; i++) {
    const miss = 1 - scores[i];
    rgba[i * 4] = 220;
    rgba[i * 4 + 1] = 38;
    rgba[i * 4 + 2] = 38;
    rgba[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, (miss - 0.05) / 0.6)));
  }
  await sharp(rgba, { raw: { width: cols, height: rows, channels: 4 } })
    .resize({ width: cols * scale, height: rows * scale, kernel: 'nearest' })
    .webp({ quality: 70 })
    .toBuffer()
    .then((data) => writeFile(file, data)); // Node writes long Windows paths; sharp cannot (see audit/screenshots.js encode)
}

/**
 * @param {string|Buffer} original   screenshot of the original page
 * @param {string|Buffer} generated  screenshot of the recreated page, same view
 * @param {{ heatmap?: string, regions?: boolean, blocks?: boolean }} [o]  heatmap: path of the WebP to write;
 *   regions: add `regions` (where the pages differ, as fractions - small enough for report.json);
 *   blocks: add `blocks` (the raw per-scale score maps). `blocks` is for a caller in this process only: a
 *   Float32Array does not belong in report.json. Both are off by default, so the existing callers are unchanged.
 * @returns {Promise<{ score: number, scales: { detail: number, layout: number }, bands: object[], worst: object[], heightOnlyOne: number, regions?: object[], blocks?: object }>}
 */
export async function visualDiff(original, generated, { heatmap, regions = false, blocks = false } = {}) {
  const [da, db, la, lb] = await Promise.all([load(original, DETAIL), load(generated, DETAIL), load(original, LAYOUT), load(generated, LAYOUT)]);
  const detail = compareScale(da, db, DETAIL);
  const layout = compareScale(la, lb, LAYOUT);
  const sDetail = mean(detail.scores);
  const sLayout = mean(layout.scores);
  const score = round3(sDetail * SCALE_WEIGHTS.detail + sLayout * SCALE_WEIGHTS.layout);
  const bands = bandsOf(detail);
  if (heatmap) await writeHeatmap(detail, heatmap, DETAIL.block);
  return {
    score,
    scales: { detail: round3(sDetail), layout: round3(sLayout) },
    bands,
    worst: bands.filter((b) => b.score < 0.7).sort((x, y) => x.score - y.score).slice(0, 3),
    heightOnlyOne: round3(detail.onlyOne),
    ...(regions && { regions: regionsOf(detail, layout) }),
    ...(blocks && { blocks: { detail, layout } }),
  };
}
