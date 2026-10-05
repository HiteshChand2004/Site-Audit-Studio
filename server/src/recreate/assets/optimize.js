// Lighter images for the copy (full-site D.5: Lighthouse "Properly size images", "Serve images in next-gen formats",
// "Efficiently encode images", page weight). After the downloads, every PNG / JPEG image is
//   - shrunk to twice the widest size any page shows it at (sharp, never enlarged) when every use of it has a known width
//     (an <img>); a CSS background or a meta image of unknown size keeps its pixel size;
//   - re-encoded as WebP (alpha kept),
// and the result replaces the original file only when it is at least 10 % smaller. Animated GIFs, SVG, WebP, AVIF and icons
// are left alone. The new file keeps the naming scheme (<name>-<sha256:10>.webp); every URL that mapped to the old file
// maps to the new one, so the IR, every stack and the srcset handling need no change.
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MIN_GAIN = 0.9; // keep the new file only when it is ≤ 90 % of the old one
const DPR = 2;
const WEBP = { quality: 82, effort: 4 };
const RASTER = /^image\/(png|jpe?g)$/i;

/**
 * @param {string} root  the assets folder
 * @param {{ files: object[], map: Record<string, string> }} result  the download result (mutated)
 * @param {Map<string, { maxWidth?: number, unsized?: boolean }>} uses  asset URL → how the pages show it
 * @returns {Promise<{ files: number, converted: number, resized: number, bytesBefore: number, bytesAfter: number }>}
 */
export async function optimizeImages(root, result, uses) {
  const out = { files: 0, converted: 0, resized: 0, bytesBefore: 0, bytesAfter: 0 };
  for (const record of result.files) {
    if (record.kind !== 'image' || !RASTER.test(record.mime ?? '') || !/\.(png|jpe?g)$/i.test(record.file)) continue;
    const from = path.join(root, record.file);
    let input;
    try {
      input = await readFile(from);
    } catch {
      continue;
    }
    out.files++;
    try {
      const meta = await sharp(input).metadata();
      // How wide the pages show it: the widest use, if every use is known.
      const shown = (record.urls ?? []).map((u) => uses.get(u));
      const known = shown.length && shown.every((s) => s && !s.unsized && s.maxWidth > 0);
      const target = known ? Math.ceil(Math.max(...shown.map((s) => s.maxWidth)) * DPR) : null;
      let image = sharp(input, { failOn: 'none' }).rotate();
      const resize = target && meta.width && meta.width > target * 1.1;
      if (resize) image = image.resize({ width: target, withoutEnlargement: true });
      const data = await image.webp(WEBP).toBuffer();
      out.bytesBefore += input.length;
      if (data.length > input.length * MIN_GAIN) {
        out.bytesAfter += input.length;
        continue;
      }
      const sha256 = createHash('sha256').update(data).digest('hex');
      const name = path.basename(record.file).replace(/-[0-9a-f]{10}\.(png|jpe?g)$/i, '').replace(/\.(png|jpe?g)$/i, '');
      const dir = path.posix.dirname(record.file.replace(/\\/g, '/'));
      const file = `${dir === '.' ? '' : `${dir}/`}${name}-${sha256.slice(0, 10)}.webp`;
      await writeFile(path.join(root, file), data);
      await rm(from, { force: true });
      for (const [url, f] of Object.entries(result.map)) if (f === record.file) result.map[url] = file;
      Object.assign(record, { file, mime: 'image/webp', bytes: data.length, sha256, optimized: { from: input.length, ...(resize && { width: target }) } });
      out.converted++;
      if (resize) out.resized++;
      out.bytesAfter += data.length;
    } catch {
      // An image sharp cannot read stays as it was downloaded.
    }
  }
  return out;
}
