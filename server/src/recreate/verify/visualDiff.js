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
import { readFile } from 'node:fs/promises';
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
 * @returns {{ scores: Float32Array, cols: number, rows: number, onlyOne: number }}
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
  return { scores, cols, rows, onlyOne: (rows - both) / Math.max(1, rows) };
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
    .toFile(file);
}

/**
 * @param {string|Buffer} original   screenshot of the original page
 * @param {string|Buffer} generated  screenshot of the recreated page, same view
 * @param {{ heatmap?: string }} [o]  heatmap: path of the WebP to write
 * @returns {Promise<{ score: number, scales: { detail: number, layout: number }, bands: object[], worst: object[], heightOnlyOne: number }>}
 */
export async function visualDiff(original, generated, { heatmap } = {}) {
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
  };
}
