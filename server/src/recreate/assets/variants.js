// Responsive image files for the recreated site (fix for "properly size images", "serve images in modern formats",
// "avoid enormous network payloads"). The original may send one large picture to every screen; the copy knows the width
// each image is shown at in every captured view (IR `rw`), so it gets WebP files at those widths (and twice them, for
// sharp screens), never wider than the original file, and every <img> lists them in srcset + sizes. The browser then
// downloads the smallest file that is sharp on its screen. The picture itself is the original's (same pixels, scaled).
// Animated images, SVG and tiny files are left as they are; a variant that would not be smaller is not written.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const RASTER = /\.(jpe?g|png|webp|avif|tiff?)$/i;
const MIN_BYTES = 12 * 1024; // smaller files gain little and cost a request each
const QUALITY = 80;
const AVIF_QUALITY = 55; // AVIF at this quality looks like WebP at 80; an AVIF original stays AVIF (WebP of it is larger)
const CLOSE = 0.12; // widths closer than this share one file
const MAX_FILES = 600; // per recreate, a safety cap on the work

/** Image nodes of the IR pages (outside <picture>, whose sources the page chose itself) with their shown widths. */
export function imageUses(ir) {
  const uses = new Map(); // asset → Set<px>
  const walk = (n, parent) => {
    if (!n || 'text' in n) return;
    if (n.t === 'img' && n.attrs?.src?.asset && n.rw && parent?.t !== 'picture') {
      const set = uses.get(n.attrs.src.asset) ?? new Set();
      for (const w of Object.values(n.rw)) if (w > 0) {
        set.add(Math.ceil(w));
        set.add(Math.ceil(w * 2));
      }
      uses.set(n.attrs.src.asset, set);
    }
    (n.children ?? []).forEach((c) => walk(c, n));
  };
  for (const p of ir.pages) walk(p.body, null);
  return uses;
}

// Widths worth a file: sorted, close ones merged upward, none wider than the original.
function pickWidths(wanted, natural) {
  const out = [];
  for (const w of [...wanted].map((x) => Math.min(x, natural)).sort((a, b) => a - b)) {
    if (out.length && w <= out[out.length - 1] * (1 + CLOSE)) out[out.length - 1] = Math.max(out[out.length - 1], w);
    else out.push(w);
  }
  return out;
}

/**
 * Writes the variants next to the downloaded images and returns them.
 * @param {object} o
 * @param {object} o.ir
 * @param {string} o.assetsDir   the recreate's assets/ folder
 * @param {number} [o.deadline]  no new file after this time (ms since epoch)
 * @returns {Promise<{ variants: Map<string, { asset: string, w: number }[]>, files: object[], stats: object }>}
 *   files: manifest entries of the new files (assets/manifest.json)
 */
export async function makeImageVariants({ ir, assetsDir, deadline = Infinity }) {
  const variants = new Map();
  const files = [];
  const stats = { images: 0, files: 0, originalBytes: 0, servedBytes: 0, skipped: 0 };
  for (const [asset, wanted] of imageUses(ir)) {
    if (Date.now() > deadline || files.length >= MAX_FILES) break;
    if (!RASTER.test(asset)) continue;
    const source = path.join(assetsDir, asset);
    let input;
    let meta;
    try {
      const { size } = await stat(source);
      if (size < MIN_BYTES) continue;
      input = await readFile(source);
      meta = await sharp(input).metadata();
    } catch {
      stats.skipped++;
      continue;
    }
    if (!meta.width || (meta.pages ?? 1) > 1) continue;
    const list = [];
    let largest = 0;
    const avif = meta.format === 'heif' || /\.avif$/i.test(asset);
    const ext = avif ? 'avif' : 'webp';
    for (const w of pickWidths(wanted, meta.width)) {
      try {
        const resized = sharp(input).resize({ width: w, withoutEnlargement: true });
        const out = await (avif ? resized.avif({ quality: AVIF_QUALITY, effort: 4 }) : resized.webp({ quality: QUALITY })).toBuffer();
        // Not smaller than the original at full width: the original file serves that width.
        if (w >= meta.width * (1 - CLOSE) && out.length >= input.length) {
          list.push({ asset, w: meta.width });
          continue;
        }
        const sha256 = createHash('sha256').update(out).digest('hex');
        const file = `${asset.replace(/\.[^./]+$/, '')}-${w}w.${ext}`;
        await sharp(out).toFile(path.join(assetsDir, file));
        files.push({ file, kind: 'image', mime: `image/${ext}`, bytes: out.length, sha256, urls: [], variantOf: asset, width: w });
        list.push({ asset: file, w });
        largest = Math.max(largest, out.length);
      } catch {
        stats.skipped++;
      }
    }
    if (!list.length) continue;
    variants.set(asset, list.filter((v, i, all) => all.findIndex((x) => x.w === v.w) === i));
    stats.images++;
    stats.originalBytes += input.length;
    stats.servedBytes += largest || input.length;
  }
  stats.files = files.length;
  return { variants, files, stats };
}

const VIEW_ORDER = ['mobile', 'tablet', 'laptop', 'desktop'];

/** The sizes attribute from the shown widths per view and the breakpoints: "(max-width: 767.98px) 343px, …, 600px". */
export function sizesFor(rw, breakpoints) {
  const parts = [];
  let last = null;
  const widest = rw.desktop ?? rw.laptop ?? rw.tablet ?? rw.mobile;
  for (const v of VIEW_ORDER.slice(0, 3)) {
    const w = rw[v];
    const bp = breakpoints?.[v];
    if (!w || !bp) continue;
    const px = `${Math.ceil(w)}px`;
    if (px === last) continue;
    parts.push(`(max-width: ${bp}px) ${px}`);
    last = px;
  }
  parts.push(`${Math.ceil(widest)}px`);
  return parts.join(', ');
}

/** Points every <img> with variants at them (srcset with widths + sizes). Mutates the IR. Returns how many changed. */
export function applyImageVariants(ir, variants) {
  let changed = 0;
  const walk = (n, parent) => {
    if (!n || 'text' in n) return;
    const list = n.t === 'img' && parent?.t !== 'picture' && n.rw ? variants.get(n.attrs?.src?.asset) : null;
    if (list?.length) {
      const desktop = Math.ceil(n.rw.desktop ?? Math.max(...Object.values(n.rw)));
      const best = list.find((v) => v.w >= desktop) ?? list[list.length - 1];
      n.attrs.src = { asset: best.asset };
      n.attrs.srcset = list.map((v) => ({ asset: v.asset, d: `${v.w}w` }));
      n.attrs.sizes = sizesFor(n.rw, ir.breakpoints);
      changed++;
    }
    (n.children ?? []).forEach((c) => walk(c, n));
  };
  for (const p of ir.pages) walk(p.body, null);
  return changed;
}
