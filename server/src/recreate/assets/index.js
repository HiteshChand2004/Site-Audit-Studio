// Recreate step 2, "Extracting assets": downloads every image, icon, font and media file the captured
// pages use into the workspace (assets/{images,icons,fonts,media}/), so the generated site has no
// references to the original host or to platform CDNs (framerusercontent.com, wixstatic.com, ...).
//
// - Every request goes through the SSRF guard, redirect hops included (download.js).
// - Each URL is downloaded once; files with identical bytes are stored once (sha256 in the name).
// - Per-file size and time limits by kind, plus a count/size budget for the whole recreate, so one
//   big video cannot hold up the job. Files over a limit are skipped and reported, never linked live.
// - Cross-origin stylesheets the browser could not read are downloaded and parsed for @font-face
//   and @keyframes.
// Writes assets/manifest.json and sets ctx.assets for the generate step.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { optimizeImages } from './optimize.js';
import path from 'node:path';
import { fetchPage } from '../../audit/http.js';
import { mapLimit } from '../../audit/util.js';
import { platformCdnHost } from './cdn.js';
import { assetKey, collectAssets } from './collect.js';
import { parseStylesheet } from './css.js';
import { downloadAsset, reasonDetail } from './download.js';
import { causeText, recoverHit, RETRYABLE_ASSET_REASONS } from '../interrupts.js';
import { addRemoved, emptyRemoved, sanitizeSvg } from '../fixers/svg.js';

const MB = 1024 * 1024;

export const ASSET_LIMITS = {
  image: { maxBytes: 15 * MB, timeout: 20000 },
  icon: { maxBytes: 1 * MB, timeout: 15000 },
  font: { maxBytes: 5 * MB, timeout: 20000 },
  media: { maxBytes: 40 * MB, timeout: 60000 },
  stylesheet: { maxBytes: 2 * MB, timeout: 15000 },
  // Files the pages link to (PDF, documents, archives).
  document: { maxBytes: 25 * MB, timeout: 60000 },
};
// maxTotalBytes is checked before each download starts, so parallel downloads can pass it slightly.
export const ASSET_BUDGET = { maxAssets: 800, maxTotalBytes: 300 * MB, concurrency: 6, maxSheets: 20 };
// Downloads stop starting this long before the step's own time limit, so the step ends cleanly.
const DEADLINE_MARGIN = 10000;

const FOLDERS = { image: 'images', icon: 'icons', font: 'fonts', media: 'media', document: 'files' };

const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/pjpeg': '.jpg', 'image/png': '.png', 'image/apng': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
  'image/bmp': '.bmp', 'font/woff2': '.woff2', 'font/woff': '.woff', 'application/font-woff': '.woff', 'application/font-woff2': '.woff2',
  'font/ttf': '.ttf', 'application/x-font-ttf': '.ttf', 'font/sfnt': '.ttf', 'font/otf': '.otf', 'application/x-font-opentype': '.otf',
  'application/vnd.ms-fontobject': '.eot', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'text/csv': '.csv', 'application/rtf': '.rtf', 'application/epub+zip': '.epub',
  'application/msword': '.doc', 'application/vnd.ms-excel': '.xls', 'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};
const KNOWN_EXT = new Set(Object.values(MIME_EXT).concat(['.jpeg', '.m4v', '.odt', '.ods', '.odp', '.rar', '.7z', '.gz', '.tgz']));

// File type from the first bytes: servers often send application/octet-stream or a wrong type.
function sniffExt(head) {
  if (!head?.length) return null;
  const hex = head.toString('hex');
  const ascii = head.toString('latin1');
  if (hex.startsWith('89504e47')) return '.png';
  if (hex.startsWith('ffd8ff')) return '.jpg';
  if (ascii.startsWith('GIF8')) return '.gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return '.webp';
  if (ascii.slice(4, 12) === 'ftypavif' || ascii.slice(4, 12) === 'ftypavis') return '.avif';
  if (ascii.slice(4, 8) === 'ftyp') return '.mp4';
  if (hex.startsWith('1a45dfa3')) return '.webm';
  if (ascii.startsWith('wOF2')) return '.woff2';
  if (ascii.startsWith('wOFF')) return '.woff';
  if (ascii.startsWith('OTTO')) return '.otf';
  if (hex.startsWith('00010000')) return '.ttf';
  if (hex.startsWith('00000100')) return '.ico';
  if (/^\s*(<\?xml|<svg)/i.test(ascii)) return '.svg';
  return null;
}

function extensionFor(url, mime, head) {
  const sniffed = sniffExt(head);
  if (sniffed) return sniffed;
  if (mime && MIME_EXT[mime]) return MIME_EXT[mime];
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return KNOWN_EXT.has(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : '.bin';
}

// Readable base name from the URL: "hero-image", never a platform hash path.
function baseName(url, kind) {
  const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
  const name = last.replace(/\.[a-z0-9]{1,5}$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return name || kind;
}

async function readCaptures(ctx) {
  const captures = [];
  for (const page of ctx.pages ?? []) {
    for (const [view, info] of Object.entries(page.views)) {
      const file = path.join(ctx.dir, 'capture', page.slug, info.file);
      captures.push({ slug: page.slug, view, data: JSON.parse(await readFile(file, 'utf8')) });
    }
  }
  return captures;
}

// A stylesheet the job's browsers already loaded (the shared cache), in the shape fetchPage returns; null = download it.
async function cachedSheet(cache, url, maxBytes) {
  const entry = cache?.lookup(url);
  if (!entry || entry.bytes > maxBytes) return null;
  try {
    return { status: entry.status, contentType: entry.headers['content-type'] ?? '', body: await readFile(entry.file, 'utf8'), url };
  } catch {
    return null;
  }
}

// Cross-origin stylesheets (and their @imports) the capture could not read.
async function readForeignSheets(urls, { signal, limits, maxSheets, deadline = Infinity, cache = null }) {
  const queue = [...new Set(urls.filter(Boolean))];
  const seen = new Set(queue);
  const sheets = [];
  const fontFaces = [];
  const keyframes = [];
  while (queue.length && sheets.length < maxSheets) {
    const url = queue.shift();
    const left = deadline - DEADLINE_MARGIN - Date.now();
    if (left <= 0) {
      sheets.push({ url, status: 'failed', reason: 'time-limit' });
      continue;
    }
    const res = (await cachedSheet(cache, url, limits.maxBytes)) ?? (await fetchPage(url, { timeout: Math.min(limits.timeout, left), maxBytes: limits.maxBytes, signal, accept: 'text/css,*/*;q=0.1' }));
    const ok = res.status === 200 && !/html/i.test(res.contentType);
    sheets.push({ url, status: ok ? 'read' : 'failed', ...(!ok && { reason: res.error ?? `http-${res.status}` }) });
    if (!ok) continue;
    const parsed = parseStylesheet(res.body, res.url);
    fontFaces.push(...parsed.fontFaces);
    keyframes.push(...parsed.keyframes.map((k) => ({ ...k, sheet: url })));
    for (const imp of parsed.imports) {
      if (!seen.has(imp)) {
        seen.add(imp);
        queue.push(imp);
      }
    }
  }
  for (const url of queue) sheets.push({ url, status: 'failed', reason: 'budget' });
  return { sheets, fontFaces, keyframes };
}

/**
 * Downloads a collected asset list into `root`. Exported for tests; assetsStage() is the pipeline entry.
 * @returns {Promise<{ files: object[], map: Record<string,string>, skipped: object[], reused: number, bytes: number, fromCache: number }>}
 */
export async function downloadAssets(list, root, { signal, referer, deadline = Infinity, limits = ASSET_LIMITS, budget = ASSET_BUDGET, onProgress = () => {}, cache = null } = {}) {
  await Promise.all(Object.values(FOLDERS).map((f) => mkdir(path.join(root, f), { recursive: true })));
  const byHash = new Map();
  const files = [];
  const map = {};
  const skipped = [];
  let bytes = 0;
  let started = 0;
  let done = 0;
  let reused = 0;
  // Files taken from the job's shared cache (what the browsers loaded) instead of the network.
  let fromCache = 0;

  const skip = (asset, reason, extra = {}) => skipped.push({ url: asset.url, kind: asset.kind, reason, detail: extra.detail ?? reasonDetail(reason), ...(extra.bytes && { bytes: extra.bytes }) });

  await mapLimit(list, budget.concurrency, async (asset) => {
    try {
      if (signal?.aborted) return;
      // Already saved as the final URL of an earlier redirect.
      if (map[asset.url]) return void reused++;
      const left = deadline - DEADLINE_MARGIN - Date.now();
      if (left <= 0) return skip(asset, 'time-limit');
      if (started >= budget.maxAssets || bytes >= budget.maxTotalBytes) return skip(asset, 'budget');
      started++;
      const limit = limits[asset.kind];
      const room = budget.maxTotalBytes - bytes;
      const r = await downloadAsset(asset.url, {
        dir: root,
        kind: asset.kind,
        maxBytes: Math.min(limit.maxBytes, room),
        timeout: Math.min(limit.timeout, left),
        signal,
        referer,
        cache,
      });
      if (r.cached) fromCache++;
      if (!r.ok) {
        started--;
        let reason = r.reason;
        if (reason === 'too-large' && room < limit.maxBytes) reason = 'budget';
        if (reason === 'timeout' && left < limit.timeout) reason = 'time-limit';
        const detail = reason === 'too-large' ? `${reasonDetail(reason)} (${asset.kind}: ${Math.round(limit.maxBytes / MB)} MB)` : r.detail;
        return skip(asset, reason, { detail, bytes: r.bytes });
      }

      const existing = byHash.get(r.sha256);
      let file;
      if (existing) {
        // Same bytes under another URL (for example ?w=400 and ?w=800 of one image).
        file = existing.file;
        existing.urls.push(asset.url);
        reused++;
        await rm(r.tmp, { force: true });
      } else {
        file = `${FOLDERS[asset.kind]}/${baseName(asset.url, asset.kind)}-${r.sha256.slice(0, 10)}${extensionFor(r.finalUrl, r.mime, r.head)}`;
        const record = { file, kind: asset.kind, mime: r.mime, bytes: r.bytes, sha256: r.sha256, urls: [asset.url] };
        byHash.set(r.sha256, record);
        files.push(record);
        bytes += r.bytes;
        await rename(r.tmp, path.join(root, file));
      }
      map[asset.url] = file;
      // The final URL of a redirect may be referenced directly elsewhere.
      const finalKey = assetKey(r.finalUrl);
      if (finalKey && !map[finalKey]) map[finalKey] = file;
    } finally {
      onProgress(++done / list.length);
    }
  });
  return { files, map, skipped, reused, bytes, fromCache };
}

/**
 * Adds a second download round (the files that failed in the first) to the first result: same bytes as a file already saved
 * = that file (the new copy is removed), the retried URLs leave `skipped` unless they failed again. Mutates `result`.
 * Exported for tests.
 */
export async function mergeDownloads(result, second, root, retried) {
  const bySha = new Map(result.files.map((f) => [f.sha256, f]));
  const sameAs = new Map();
  for (const f of second.files) {
    const existing = bySha.get(f.sha256);
    if (existing) {
      existing.urls.push(...f.urls);
      if (existing.file !== f.file) await rm(path.join(root, f.file), { force: true });
      sameAs.set(f.file, existing.file);
      result.reused++;
    } else {
      bySha.set(f.sha256, f);
      result.files.push(f);
      result.bytes += f.bytes;
    }
  }
  for (const [url, file] of Object.entries(second.map)) result.map[url] ??= sameAs.get(file) ?? file;
  result.skipped = [...result.skipped.filter((s) => !retried.has(s.url)), ...second.skipped];
  result.reused += second.reused;
  result.fromCache += second.fromCache;
  return result;
}

const looksLikeSvg = (buf) => /^\s*(<\?xml|<!--|<!doctype svg|<svg)/i.test(buf.subarray(0, 512).toString('utf8'));

/**
 * Every downloaded SVG is rewritten through the sanitizer (fixers/svg.js) before any page links it:
 * no scripts, event handlers, javascript: URLs or external references stay in assets/. A file that
 * is not an SVG after all (no <svg> root) is deleted and its URLs are reported as skipped.
 * Mutates `result` (files, map, skipped). Exported for tests.
 */
export async function sanitizeSvgFiles(root, result) {
  const summary = { files: 0, changed: 0, removedFiles: 0, removed: emptyRemoved() };
  for (const record of [...result.files]) {
    if (!record.file.endsWith('.svg') && record.mime !== 'image/svg+xml') continue;
    const target = path.join(root, record.file);
    const buf = await readFile(target);
    if (!record.file.endsWith('.svg') && !looksLikeSvg(buf)) continue;
    summary.files++;
    const clean = sanitizeSvg(buf.toString('utf8'));
    if (!clean.svg) {
      await rm(target, { force: true });
      result.files.splice(result.files.indexOf(record), 1);
      for (const [url, file] of Object.entries(result.map)) {
        if (file !== record.file) continue;
        delete result.map[url];
        result.skipped.push({ url, kind: record.kind, reason: 'not-an-asset', detail: 'Served as SVG but has no <svg> root; removed.' });
      }
      summary.removedFiles++;
      continue;
    }
    addRemoved(summary.removed, clean.removed);
    record.sanitized = true;
    if (clean.changed) summary.changed++;
    await writeFile(target, `${clean.svg}\n`);
  }
  return summary;
}

/**
 * The pipeline stage.
 * @param {object} ctx  pipeline context (recreate/index.js): needs ctx.pages from the inspect step
 * @param {{ limits?: object, budget?: object }} [opts]  overrides, for tests
 */
export async function assetsStage(ctx, opts = {}) {
  const limits = { ...ASSET_LIMITS, ...opts.limits };
  const budget = { ...ASSET_BUDGET, ...opts.budget };
  const { report } = ctx;
  const root = path.join(ctx.dir, 'assets');
  await mkdir(root, { recursive: true });

  ctx.progress(0, 'Reading captured pages');
  const captures = await readCaptures(ctx);
  const foreign = await readForeignSheets(captures.flatMap((c) => c.data.unreadableSheets ?? []), {
    signal: ctx.signal,
    limits: limits.stylesheet,
    maxSheets: budget.maxSheets,
    deadline: ctx.stepDeadline,
    cache: ctx.netCache,
  });
  const { assets, fontFaces, unusedFontFaces } = collectAssets(captures, { fontFaces: foreign.fontFaces });
  captures.length = 0; // the capture trees are large; only the asset list is needed from here

  ctx.progress(0.1, `Downloading ${assets.length} assets`);
  const origin = ctx.discovery?.origin ?? new URL(ctx.audit.url ?? ctx.project.url).origin;
  const downloadStarted = Date.now();
  const result = await downloadAssets(assets, root, {
    signal: ctx.signal,
    referer: `${origin}/`,
    deadline: ctx.stepDeadline,
    limits,
    budget,
    cache: ctx.netCache,
    onProgress: (f) => ctx.progress(0.1 + 0.88 * f, `Downloading assets (${Math.round(f * assets.length)} of ${assets.length})`),
  });
  // Downloads that failed at network level while the network was down or the computer slept: once more, only those,
  // when the network is back (the files already saved are kept).
  const failedUrls = new Set(result.skipped.filter((s) => RETRYABLE_ASSET_REASONS.has(s.reason)).map((s) => s.url));
  if (failedUrls.size && !ctx.signal?.aborted) {
    const hit = await recoverHit(ctx, { step: 'assets', what: `${failedUrls.size} failed downloads`, startedAt: downloadStarted, progress: (m) => ctx.progress(0.97, m) });
    if (hit) {
      const again = assets.filter((a) => failedUrls.has(a.url));
      ctx.progress(0.97, `Downloading ${again.length} assets again (${causeText(hit)})`);
      const second = await downloadAssets(again, root, {
        signal: ctx.signal,
        referer: `${origin}/`,
        deadline: ctx.stepDeadline,
        limits,
        budget: { ...budget, maxAssets: Math.max(0, budget.maxAssets - result.files.length), maxTotalBytes: Math.max(0, budget.maxTotalBytes - result.bytes) },
        cache: ctx.netCache,
      });
      await mergeDownloads(result, second, root, failedUrls);
    }
  }

  ctx.progress(0.98, 'Sanitizing SVG files');
  const svg = await sanitizeSvgFiles(root, result);
  // Lighter images (D.5): PNG / JPEG shrunk to what the pages show (×2) and re-encoded as WebP when that is smaller.
  ctx.progress(0.985, 'Making images lighter');
  const images = await optimizeImages(root, result, new Map(assets.map((a) => [a.url, a])));

  const faces = fontFaces.map((f) => {
    const src = f.src.map((s) => ({ ...s, file: result.map[assetKey(s.url)] ?? null }));
    return { ...f, src, local: src.some((s) => s.file) };
  });

  const cdnUrls = assets.filter((a) => platformCdnHost(a.url));
  const cdnMissing = cdnUrls.filter((a) => !result.map[a.url]);
  const byKind = {};
  for (const f of result.files) {
    byKind[f.kind] ??= { files: 0, bytes: 0 };
    byKind[f.kind].files++;
    byKind[f.kind].bytes += f.bytes;
  }

  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ files: result.files, map: result.map, skipped: result.skipped, fontFaces: faces, keyframes: foreign.keyframes, sheets: foreign.sheets }, null, 1),
  );
  ctx.assets = { dir: root, map: result.map, files: result.files, skipped: result.skipped, fontFaces: faces, keyframes: foreign.keyframes, svg };

  report.assets = {
    found: assets.length,
    downloaded: result.files.length,
    images,
    duplicates: result.reused,
    fromCache: result.fromCache,
    bytes: result.bytes,
    byKind,
    skipped: result.skipped.slice(0, 100),
    skippedCount: result.skipped.length,
    fontFaces: faces.length,
    fontFacesWithoutFile: faces.filter((f) => !f.local).map((f) => f.family),
    unusedFontFaces,
    stylesheets: foreign.sheets,
    svg,
    platformCdn: {
      hosts: [...new Set(cdnUrls.map((a) => platformCdnHost(a.url)))],
      localized: cdnUrls.length - cdnMissing.length,
      missing: cdnMissing.length,
    },
  };

  for (const s of result.skipped.filter((s) => s.kind === 'media' && s.reason === 'too-large')) {
    report.manual.push({
      kind: 'asset',
      title: 'Video or audio file too large to bundle',
      detail: `${s.detail} It is left out of the recreated site; host it yourself and add it back.`,
      url: s.url,
    });
  }
  if (cdnMissing.length) {
    report.manual.push({
      kind: 'asset',
      title: `${cdnMissing.length} platform CDN ${cdnMissing.length === 1 ? 'file' : 'files'} could not be downloaded`,
      detail: 'They are left out of the recreated site instead of linking to the platform CDN. See the skipped assets list.',
    });
  }
  if (result.skipped.some((s) => s.reason === 'budget' || s.reason === 'time-limit')) {
    report.warnings.push('Some assets were skipped because the asset size, count or time limit of one recreate was reached.');
  }
  ctx.progress(1, `Downloaded ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'}`);
}
