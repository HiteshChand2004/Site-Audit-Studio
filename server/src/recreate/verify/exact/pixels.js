// The exact pixel number: how many pixels of the copy differ from the original, and where.
//
// This is pixelmatch's algorithm - the YIQ colour distance with `threshold` as a fraction of the largest possible
// distance, and its antialias test - written here rather than added as a dependency. pixelmatch cannot read or write
// an image, so taking it would mean taking pngjs too: two packages for sixty lines of arithmetic, against a repo that
// chose node:sqlite to avoid a native build and kept a CSS parser out when the primitives were already there. sharp,
// which is already a dependency, decodes straight to raw RGBA and encodes the heatmap.
//
// The antialias test is the part that matters. Text edges are rasterised slightly differently by two browsers - and by
// one browser with the same text inside a different compositing layer - so without it the count on any page of text is
// dominated by the edges of letters and says nothing about whether the layout is right.
//
// Read in bands. A full-page shot is routinely 1440 x 8000, which is 46 MB of raw RGBA per side, and a phone page is
// worse; a band of a thousand rows is about 6 MB per side, whatever the page's height. Each band is read with a
// one-row halo above and below, because the antialias test looks at a pixel's neighbours and a pixel on a band's edge
// has neighbours in the next band.
//
// The existing SSIM diff (verify/visualDiff.js) is not replaced by this and is still called beside it: its score is
// calibrated on 111 real pairs, it feeds fidelity, responsive, refine and the correction loop's judge(), and its
// `coarse` flag is what separates real geometry from font rasterisation. Two metrics, two jobs - this one for
// acceptance, that one for where to look.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

/** The largest possible YIQ distance, which is what `threshold` is a fraction of (pixelmatch's constant). */
export const MAX_YIQ_DELTA = 35215;
export const DEFAULT_THRESHOLD = 0.1;
/** Rows read at a time. One band is about 6 MB per side at 1440 wide. */
export const BAND_ROWS = 1000;
/** The block map's resolution: fine enough to show a shifted heading, coarse enough to stay small. */
export const BLOCK_PX = 8;

const rgb2y = (r, g, b) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
const rgb2i = (r, g, b) => r * 0.59597799 - g * 0.27417610 - b * 0.32180189;
const rgb2q = (r, g, b) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
const blend = (c, a) => 255 + (c - 255) * a;

/**
 * How far apart two pixels are, as pixelmatch measures it: a weighted YIQ distance, signed so the caller can tell
 * which pixel is the brighter one (the antialias test needs that).
 */
export function colorDelta(a, b, k, m, yOnly = false) {
  let r1 = a[k];
  let g1 = a[k + 1];
  let b1 = a[k + 2];
  let a1 = a[k + 3];
  let r2 = b[m];
  let g2 = b[m + 1];
  let b2 = b[m + 2];
  let a2 = b[m + 3];
  if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;
  if (a1 < 255) {
    a1 /= 255;
    r1 = blend(r1, a1);
    g1 = blend(g1, a1);
    b1 = blend(b1, a1);
  }
  if (a2 < 255) {
    a2 /= 255;
    r2 = blend(r2, a2);
    g2 = blend(g2, a2);
    b2 = blend(b2, a2);
  }
  const y1 = rgb2y(r1, g1, b1);
  const y2 = rgb2y(r2, g2, b2);
  const y = y1 - y2;
  if (yOnly) return y;
  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
  const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
  return y1 > y2 ? -delta : delta;
}

/**
 * Is this pixel on an antialiased edge? True when it differs in brightness from most of its neighbours while at
 * least one neighbour is identical to it, and it is the darkest or brightest of them - the shape a letter's edge has
 * and a moved box does not. The other image is consulted too, as pixelmatch does.
 */
function antialiased(img, x, y, width, height, other) {
  const x0 = Math.max(x - 1, 0);
  const y0 = Math.max(y - 1, 0);
  const x1 = Math.min(x + 1, width - 1);
  const y1 = Math.min(y + 1, height - 1);
  const pos = (y * width + x) * 4;
  let zeroes = x === x0 || x === x1 || y === y0 || y === y1 ? 1 : 0;
  let min = 0;
  let max = 0;
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (let ax = x0; ax <= x1; ax++) {
    for (let ay = y0; ay <= y1; ay++) {
      if (ax === x && ay === y) continue;
      const delta = colorDelta(img, img, pos, (ay * width + ax) * 4, true);
      if (delta === 0) {
        zeroes++;
        if (zeroes > 2) return false;
      } else if (delta < min) {
        min = delta;
        minX = ax;
        minY = ay;
      } else if (delta > max) {
        max = delta;
        maxX = ax;
        maxY = ay;
      }
    }
  }
  if (min === 0 || max === 0) return false;
  return (hasManySiblings(img, minX, minY, width, height) && hasManySiblings(other, minX, minY, width, height))
    || (hasManySiblings(img, maxX, maxY, width, height) && hasManySiblings(other, maxX, maxY, width, height));
}

/** A pixel with three or more identical neighbours sits inside a solid area, not on an edge. */
function hasManySiblings(img, x, y, width, height) {
  const x0 = Math.max(x - 1, 0);
  const y0 = Math.max(y - 1, 0);
  const x1 = Math.min(x + 1, width - 1);
  const y1 = Math.min(y + 1, height - 1);
  const pos = (y * width + x) * 4;
  let zeroes = x === x0 || x === x1 || y === y0 || y === y1 ? 1 : 0;
  for (let ax = x0; ax <= x1; ax++) {
    for (let ay = y0; ay <= y1; ay++) {
      if (ax === x && ay === y) continue;
      const p = (ay * width + ax) * 4;
      if (img[pos] === img[p] && img[pos + 1] === img[p + 1] && img[pos + 2] === img[p + 2] && img[pos + 3] === img[p + 3]) zeroes++;
      if (zeroes > 2) return true;
    }
  }
  return false;
}

/**
 * Read into memory with Node, never with sharp: sharp keeps a handle on a file it opened, and Windows then refuses to
 * rename or remove the workspace that holds it.
 */
const open = async (input) => sharp(Buffer.isBuffer(input) ? input : await readFile(input), { limitInputPixels: false });

/**
 * Compares two full-page shots pixel for pixel.
 * @param {string|Buffer} original
 * @param {string|Buffer} generated
 * @param {{ threshold?: number, includeAntialiased?: boolean, bandRows?: number, block?: number,
 *   exclude?: {x:number,y:number,w:number,h:number}[], offsetY?: number }} [o]  exclude: areas counted as masked
 *   instead of as differences (a third-party frame, a canvas, a video); offsetY: where this band sits in the page,
 *   so the areas can be given in page coordinates
 * @returns {Promise<{ pct: number, diff: number, antialiased: number, compared: number, total: number,
 *   width: number, height: number, heights: [number, number], heightOnlyOne: number, widthMismatch: boolean,
 *   blocks: { cols: number, rows: number, px: number, counts: Uint32Array } }>}
 */
export async function exactDiff(original, generated, {
  threshold = DEFAULT_THRESHOLD, includeAntialiased = false, bandRows = BAND_ROWS, block = BLOCK_PX,
  exclude = [], offsetY = 0,
} = {}) {
  const a = await open(original);
  const b = await open(generated);
  const ma = await a.metadata();
  const mb = await b.metadata();
  const width = Math.min(ma.width, mb.width);
  const height = Math.min(ma.height, mb.height);
  // Rows only one of the two has: counted as different in full, the same convention the SSIM diff uses, because a
  // page that is taller than the original differs everywhere below it.
  const heightOnlyOne = Math.abs(ma.height - mb.height) * width;
  const maxDelta = MAX_YIQ_DELTA * threshold * threshold;

  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const counts = new Uint32Array(cols * rows);
  let diff = 0;
  let anti = 0;
  let masked = 0;
  // In this band's own coordinates, and only the parts of an area that fall inside it.
  const areas = exclude
    .map((r) => ({ x0: Math.floor(r.x), y0: Math.floor(r.y - offsetY), x1: Math.ceil(r.x + r.w), y1: Math.ceil(r.y - offsetY + r.h) }))
    .filter((r) => r.y1 > 0 && r.y0 < height && r.x1 > 0 && r.x0 < width);
  const inside = (x, y) => areas.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);

  for (let top = 0; top < height; top += bandRows) {
    const rowsHere = Math.min(bandRows, height - top);
    // A one-row halo, so the antialias test can look at the neighbours of the band's own edge rows.
    const haloTop = Math.max(0, top - 1);
    const haloRows = Math.min(height - haloTop, rowsHere + (top - haloTop) + 1);
    const region = { left: 0, top: haloTop, width, height: haloRows };
    const [bufA, bufB] = await Promise.all([
      a.clone().extract(region).raw().toBuffer(),
      b.clone().extract(region).raw().toBuffer(),
    ]);
    const offset = top - haloTop; // the first row of this band inside the halo
    for (let y = offset; y < offset + rowsHere; y++) {
      const pageY = haloTop + y;
      for (let x = 0; x < width; x++) {
        const pos = (y * width + x) * 4;
        const delta = colorDelta(bufA, bufB, pos, pos);
        if (delta === 0) continue;
        if (Math.abs(delta) <= maxDelta) continue;
        if (areas.length && inside(x, pageY)) {
          masked++;
          continue;
        }
        if (!includeAntialiased
          && (antialiased(bufA, x, y, width, haloRows, bufB) || antialiased(bufB, x, y, width, haloRows, bufA))) {
          anti++;
          continue;
        }
        diff++;
        counts[Math.floor(pageY / block) * cols + Math.floor(x / block)]++;
      }
    }
  }

  const compared = width * height;
  const total = compared + heightOnlyOne;
  return {
    pct: total ? Math.round(((diff + heightOnlyOne) / total) * 1e6) / 1e4 : 0,
    diff,
    antialiased: anti,
    masked,
    compared,
    total,
    width,
    height,
    heights: [ma.height, mb.height],
    heightOnlyOne,
    widthMismatch: ma.width !== mb.width,
    blocks: { cols, rows, px: block, counts },
  };
}

/**
 * The places worth looking at, as fractions of the page, so a report can point at them whatever the page's size.
 * Flood-filled from the block map, biggest first.
 */
export function diffRegions({ blocks }, { minBlocks = 2, max = 12, merge = 1 } = {}) {
  const { cols, rows, counts, px } = blocks;
  const seen = new Uint8Array(cols * rows);
  const regions = [];
  for (let i = 0; i < counts.length; i++) {
    if (seen[i] || counts[i] === 0) continue;
    // One cluster: every touching block that also differs.
    const stack = [i];
    seen[i] = 1;
    let x0 = cols;
    let y0 = rows;
    let x1 = -1;
    let y1 = -1;
    let pixels = 0;
    let n = 0;
    while (stack.length) {
      const at = stack.pop();
      const cx = at % cols;
      const cy = Math.floor(at / cols);
      pixels += counts[at];
      n++;
      if (cx < x0) x0 = cx;
      if (cy < y0) y0 = cy;
      if (cx > x1) x1 = cx;
      if (cy > y1) y1 = cy;
      for (let dy = -merge; dy <= merge; dy++) {
        for (let dx = -merge; dx <= merge; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const j = ny * cols + nx;
          if (seen[j] || counts[j] === 0) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (n < minBlocks) continue;
    regions.push({
      x: x0 * px,
      y: y0 * px,
      w: (x1 - x0 + 1) * px,
      h: (y1 - y0 + 1) * px,
      blocks: n,
      pixels,
    });
  }
  regions.sort((p, q) => q.pixels - p.pixels);
  return regions.slice(0, max);
}

/**
 * A small picture of where the difference is: one pixel per block, the darker the more pixels differ. Written only
 * for a slot that failed - a full-size diff image of a long page is megabytes nobody opens.
 */
export async function writeDiffMap({ blocks }, file) {
  const { cols, rows, counts, px } = blocks;
  const per = px * px;
  const rgb = Buffer.alloc(cols * rows * 3);
  for (let i = 0; i < counts.length; i++) {
    const share = Math.min(1, counts[i] / per);
    rgb[i * 3] = 255;
    rgb[i * 3 + 1] = Math.round(255 * (1 - share));
    rgb[i * 3 + 2] = Math.round(255 * (1 - share));
  }
  await sharp(rgb, { raw: { width: cols, height: rows, channels: 3 } })
    .webp({ quality: 80 })
    .toFile(file);
  return { file, cols, rows };
}
