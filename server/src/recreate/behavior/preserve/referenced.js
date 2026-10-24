// @ts-check
// Files a lifted copy names but does not hold (completing a copy, after complete.js's browser passes). The browser passes only
// see what a visit asks for: a hero video the headless browser cannot play is never requested, an icon is fetched by the
// browser outside the page, a module is imported only after a click. Each of these is still written in the copy's own text
// (a script bundle, a stylesheet, the page's inline data), so the copy's text files are read for file addresses, and every
// address the copy does not hold is asked of the original once, through the guarded download, on the original's own hosts.
// A missing file shows as a 404 in the copy's console and a part of the page that never draws; on the original it worked.
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { downloadAsset } from '../../assets/download.js';
import { localPathOf, storableAsIs } from './pageLift.js';

/** The extensions of files a copy holds (pages, which have none, are never fetched this way). */
const FILE_EXT = 'm?js|css|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|ogv|mov|mp3|ogg|wav|m4a|woff2?|ttf|otf|eot|wasm|json|webmanifest|pdf';
const MEDIA_EXT = /\.(mp4|webm|ogv|mov|mp3|ogg|wav|m4a)$/i;
/** A quoted root-relative address of a file ("/assets/x-1a2b.mp4", "/favicon.ico?v=2"); "//host" is not one. */
const ROOT_REF = new RegExp(`["'\`](/(?!/)[\\w\\-./~%@+]+?\\.(?:${FILE_EXT}))(?:\\?[^"'\`\\s<>]*)?(?=\\\\?["'\`])`, 'gi');
/** A quoted absolute address of a file. */
const ABS_REF = new RegExp(`["'\`](https?://[\\w.-]+(?::\\d+)?/[\\w\\-./~%@+]+?\\.(?:${FILE_EXT}))(?:\\?[^"'\`\\s<>]*)?(?=\\\\?["'\`])`, 'gi');
/** A quoted relative address in a module ("./chunk-1a2b.mjs", "../x.js"): resolved against the module's own address. */
const REL_REF = new RegExp(`["'\`](\\.\\.?/[\\w\\-./~%@+]+?\\.(?:${FILE_EXT}))(?=["'\`])`, 'gi');
/** A file next to a module, as bundlers write it: new URL("hero-1a2b.mp4", import.meta.url). */
const META_URL_REF = new RegExp(`new URL\\(\\s*["'\`]([\\w\\-./~%@+]+?\\.(?:${FILE_EXT}))["'\`]\\s*,\\s*import\\.meta\\.url`, 'gi');
/** The text files of a copy that can name files. */
const TEXT_FILE = /\.(html?|m?js|css|json|webmanifest)$/i;

/** Rounds: a file found this way can name more (a module that imports another). */
export const REFERENCED_ROUNDS = 3;
/** Size limits: a site's own video is part of how the page looks, so it is kept up to this size. */
export const REFERENCED_MAX_BYTES = { media: 250 * 1024 * 1024, other: 25 * 1024 * 1024 };
/** At most this many files and bytes are fetched for one copy; what is left over is reported, never guessed. */
export const REFERENCED_BUDGET = { files: 400, bytes: 600 * 1024 * 1024 };

/**
 * The original addresses one text file of the copy names.
 * @param {string} text
 * @param {{ fileUrl: string | null, pageUrl: string }} o  fileUrl: the original address of this file (null: it is the copy's
 *   own, a page or a file the lift wrote), pageUrl: the original page (root-relative addresses are the site's)
 * @returns {string[]} absolute original addresses, query kept
 */
export function referencedAddresses(text, { fileUrl, pageUrl }) {
  const out = new Set();
  const add = (raw, base) => {
    try {
      const u = new URL(raw.replace(/\\$/, ''), base);
      u.hash = '';
      out.add(u.href);
    } catch { /* not an address */ }
  };
  for (const m of text.matchAll(ROOT_REF)) add(m[0].slice(1), pageUrl);
  for (const m of text.matchAll(ABS_REF)) add(m[0].slice(1), pageUrl);
  // Relative addresses only inside a script or a stylesheet of the original, where they mean that file's own folder.
  if (fileUrl && /\.(m?js|css)(\?|$)/i.test(new URL(fileUrl).pathname)) {
    for (const m of text.matchAll(REL_REF)) add(m[1], fileUrl);
    for (const m of text.matchAll(META_URL_REF)) add(m[1], fileUrl);
  }
  return [...out];
}

async function textFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (TEXT_FILE.test(e.name)) out.push(abs);
    }
  }
  await walk(dir);
  return out;
}

const bareHost = (h) => h.replace(/^www\./, '').toLowerCase();
const exists = (f) => stat(f).then(() => true, () => false);

/**
 * Fetches the files the copy names and does not hold. A same-site file is stored at its path (a static host answers that path
 * for any query, as the original did); a file of another of the original's hosts at the path the lift gives it, and added to
 * the manifest so the service worker answers its address.
 * @param {object} o
 * @param {string} o.outDir
 * @param {string} o.pageUrl                       the original homepage
 * @param {Set<string>} o.originHosts              the original's hosts, without www.
 * @param {Record<string, string>} o.manifest      original address → local path (added to)
 * @param {typeof downloadAsset} [o.fetchImpl]
 * @returns {Promise<{ named: number, fetched: { url: string, path: string, bytes: number }[], notOnOriginal: number,
 *   failed: { url: string, reason: string }[], leftOver: number, rounds: number }>}
 */
export async function fetchReferenced({ outDir, pageUrl, originHosts, manifest, fetchImpl = downloadAsset }) {
  const root = path.resolve(outDir);
  const site = bareHost(new URL(pageUrl).hostname);
  const tmp = path.join(outDir, '.referenced-tmp');
  await mkdir(tmp, { recursive: true });
  const result = { named: 0, fetched: [], bare: [], notOnOriginal: 0, failed: [], leftOver: 0, rounds: 0 };
  // A same-site address the lift renamed (a query made it favicon~1a2b.ico) is served by the worker, which a first visit does not
  // have yet: the host answers the path itself (any query), so the path gets the file too, unless two addresses share the path.
  const byPath = new Map();
  for (const [url, local] of Object.entries(manifest)) {
    const u = new URL(url);
    if (bareHost(u.hostname) !== site) continue;
    const p = decodeURIComponent(u.pathname);
    byPath.set(p, byPath.has(p) && byPath.get(p) !== local ? null : local);
  }
  for (const [p, local] of byPath) {
    const bare = path.resolve(root, `.${p}`);
    if (!local || p === local || p.endsWith('/') || !storableAsIs(p) || !bare.startsWith(root + path.sep) || (await exists(bare))) continue;
    const from = path.resolve(root, `.${local}`);
    if (!(await exists(from))) continue;
    await mkdir(path.dirname(bare), { recursive: true });
    await copyFile(from, bare);
    result.bare.push({ path: p, from: local });
  }
  const asked = new Set(Object.keys(manifest));
  let bytes = 0;
  const localOfFile = new Map(Object.entries(manifest).map(([url, local]) => [path.resolve(root, `.${local}`), url]));
  try {
    for (let round = 1; round <= REFERENCED_ROUNDS; round++) {
      result.rounds = round;
      const wanted = new Map();
      for (const file of await textFiles(root)) {
        const text = await readFile(file, 'utf8').catch(() => '');
        for (const url of referencedAddresses(text, { fileUrl: localOfFile.get(file) ?? null, pageUrl })) {
          if (asked.has(url)) continue;
          const u = new URL(url);
          if (!originHosts.has(bareHost(u.hostname))) continue;
          // A path of the site that no file system can store under its own name is held like another host's file: under its safe
          // name, found through the worker's map.
          const sameSite = bareHost(u.hostname) === site && storableAsIs(decodeURIComponent(u.pathname));
          const local = sameSite ? decodeURIComponent(u.pathname) : localPathOf(url);
          const target = path.resolve(root, `.${local}`);
          if (!target.startsWith(root + path.sep)) continue;
          // Held already: the same path (any query) answers it on a static host; another host's file needs the worker's entry.
          if (await exists(target)) {
            if (!sameSite) manifest[url] = local;
            asked.add(url);
            continue;
          }
          wanted.set(url, { local, target, sameSite });
        }
      }
      result.named += wanted.size;
      if (!wanted.size) break;
      for (const [url, w] of wanted) {
        asked.add(url);
        if (result.fetched.length >= REFERENCED_BUDGET.files || bytes >= REFERENCED_BUDGET.bytes) {
          result.leftOver++;
          continue;
        }
        const media = MEDIA_EXT.test(new URL(url).pathname);
        const res = await fetchImpl(url, {
          dir: tmp, kind: media ? 'media' : 'image', attempts: 3, idleMs: 20000,
          maxBytes: media ? REFERENCED_MAX_BYTES.media : REFERENCED_MAX_BYTES.other,
          referer: new URL(pageUrl).origin,
        });
        if (!res.ok) {
          // A name in a bundle that the original does not serve either is not a file of the site: counted, not listed.
          // A single-page app answers every path with its page: that is not a file either.
          if (/^http-4\d\d$/.test(res.reason ?? '') || res.reason === 'not-an-asset') result.notOnOriginal++;
          else result.failed.push({ url, reason: res.reason ?? 'error' });
          continue;
        }
        await mkdir(path.dirname(w.target), { recursive: true });
        await copyFile(res.tmp, w.target);
        await rm(res.tmp, { force: true }).catch(() => {});
        if (!w.sameSite) manifest[url] = w.local;
        localOfFile.set(w.target, url);
        bytes += res.bytes ?? 0;
        result.fetched.push({ url, path: w.local, bytes: res.bytes ?? 0 });
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return result;
}
