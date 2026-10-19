// @ts-check
// Assets a component loads that the capture never recorded (CLONER_SPEC: "every asset used, downloaded and stored
// locally"). They are fetched ONCE, at build time, through the guarded download (SSRF checks, size limits, retries) and
// stored with their hash; the copy never asks the original for anything at run time. When a file cannot be had, the copy
// uses the closest recorded variant of the same image, or the video's poster, and says so. Nothing is hidden.
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { downloadAsset } from '../../assets/download.js';
import { extOf } from './extract.js';

const MB = 1024 * 1024;
/** Largest video a component may carry (bytes). Above it the video falls back to its poster. */
export const VIDEO_MAX_BYTES = 25 * MB;
/** Largest image a component may carry (bytes). */
export const IMAGE_MAX_BYTES = 15 * MB;
/** Downloads are retried this many times, with the guarded download's own back-off. */
export const FETCH_ATTEMPTS = 3;

/** The asset-download kind for a resource kind (assets/download.js knows image, icon, font, media). */
const DOWNLOAD_KIND = { image: 'image', font: 'font', media: 'media', style: 'image' };

/**
 * The recorded variant of an image that is closest to the width the copy asks for (same file, any query string).
 * @param {string} url
 * @param {Map<string, any>} byUrl  recorded entries by URL
 * @returns {{ url: string, entry: any } | null}
 */
export function closestVariant(url, byUrl) {
  const want = widthOf(url);
  const target = new URL(url);
  let best = null;
  let bestGap = Infinity;
  for (const [recorded, entry] of byUrl) {
    let other;
    try {
      other = new URL(recorded);
    } catch {
      continue;
    }
    if (other.origin !== target.origin || other.pathname !== target.pathname) continue;
    const have = widthOf(recorded);
    const gap = want && have ? Math.abs(have - want) : 0;
    if (gap < bestGap) {
      bestGap = gap;
      best = { url: recorded, entry };
    }
  }
  return best;
}

/** The width a URL asks for (`width=` or `w=`), or 0. */
function widthOf(url) {
  try {
    const u = new URL(url);
    return Number(u.searchParams.get('width') ?? u.searchParams.get('w')) || 0;
  } catch {
    return 0;
  }
}

/**
 * Fetches every missing asset of a component into its folder. Mutates and returns the asset list: each entry gets a
 * status (`fetched`, `fallback`, `failed`) and, when it has a file, its path and hash.
 * @param {{ assets: any[], outDir: string, byUrl: Map<string, any>, recordDir: string, base: string, poster?: string|null,
 *   fetchImpl?: typeof downloadAsset, maxBytes?: { media?: number, image?: number } }} o
 */
export async function fetchMissing({ assets, outDir, byUrl, recordDir, base, fetchImpl = downloadAsset, maxBytes = {} }) {
  const tmp = path.join(outDir, '.fetch');
  await mkdir(tmp, { recursive: true });
  try {
    for (const asset of assets) {
      if (asset.status !== 'missing') continue;
      const kind = asset.kind ?? 'image';
      const limit = kind === 'media' ? maxBytes.media ?? VIDEO_MAX_BYTES : maxBytes.image ?? IMAGE_MAX_BYTES;
      const res = await fetchImpl(asset.url, {
        dir: tmp,
        kind: DOWNLOAD_KIND[kind] ?? 'image',
        maxBytes: limit,
        attempts: FETCH_ATTEMPTS,
      });
      if (res.ok) {
        const ext = extOf({ url: asset.url, type: res.mime });
        const file = `assets/${res.sha256.slice(0, 10)}.${ext}`;
        await mkdir(path.join(outDir, 'assets'), { recursive: true });
        await copyFile(res.tmp, path.join(outDir, file));
        Object.assign(asset, { status: 'fetched', file, sha256: res.sha256, bytes: res.bytes, from: base, fetchedFrom: asset.url, reason: 'downloaded at build time (not in the capture record)' });
        continue;
      }
      asset.fetchReason = res.reason;
      if (kind === 'image' || kind === 'style') {
        const near = closestVariant(asset.url, byUrl);
        if (near) {
          const file = `assets/${near.entry.sha.slice(0, 10)}.${extOf(near.entry)}`;
          await mkdir(path.join(outDir, 'assets'), { recursive: true });
          await copyFile(path.join(recordDir, 'files', near.entry.sha), path.join(outDir, file));
          Object.assign(asset, { status: 'fallback', file, fallbackFrom: near.url, reason: `download failed (${res.reason}): the closest recorded variant is used instead` });
          continue;
        }
      }
      Object.assign(asset, { status: 'failed', reason: `download failed (${res.reason}) and no fallback exists` });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return assets;
}
