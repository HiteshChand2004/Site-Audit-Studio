// @ts-check
// A script error the copy logs from code the original wrote. An as-is copy keeps the original's scripts as they are, so an error
// thrown by one of them is the original's own code, not something the copy broke, even when only the copy shows it: a script
// that races its own page (pitchlight.panscience.ai fills a header slot when its "who is signed in?" answer arrives, and the
// header script makes that slot only once the page has loaded) loses that race when the answer comes from a local file in a
// few milliseconds, and wins it across the internet. With no rule for it, such an error read "Our bug".
//
// The evidence is the line itself: the line of the copy the error was thrown at must stand in a page or script the original
// served while it was captured (the capture's network record), word for word apart from the addresses the copy rewrites on
// purpose (the site's own origin dropped, "/meeting" written "/meeting/", a file name given its content hash "nav~5333db55.js"):
// pitchlight's line differed from the original only by such a slash. A line the copy wrote (its address shim, the controls
// replay) is not in the original at all, so an error there stays the copy's.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** A line shorter than this ("}", "return;") stands in every script: it proves nothing. */
export const MIN_LINE_CHARS = 15;
/** The most of the original's recorded pages and scripts read for the comparison. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

const bare = (h) => String(h ?? '').replace(/^www\./, '').toLowerCase();

/**
 * A line with the copy's own address rewrites taken out, so the original's line and the copy's compare: the site's origins
 * removed, a content hash in a file name removed, "/index.html" and a trailing slash before a quote, "?" or "#" removed.
 * @param {string} line @param {string[]} origins
 */
export function sameCode(line, origins = []) {
  let s = line.trim();
  for (const o of origins) s = s.split(o).join('');
  return s
    .replace(/~[0-9a-f]{8}(?=\.[a-z0-9]{1,6}\b)/gi, '')
    .replace(/\/index\.html?(?=["'`?#])/gi, '/')
    .replace(/\/+(?=["'`?#])/g, '');
}

/** The site's own origins as a copy may have written them away (with and without www, http and https). */
function originsOf(siteUrl) {
  try {
    const host = bare(new URL(siteUrl).hostname);
    return ['https', 'http'].flatMap((p) => [`${p}://www.${host}`, `${p}://${host}`]);
  } catch {
    return [];
  }
}

/**
 * Where a script error was thrown, from a Lighthouse console item: { url, line, column } (1-based), or null when the item is no
 * script error (a failed request) or names no place.
 * @param {{ description?: string, sourceLocation?: { url?: string, line?: number, column?: number } }} item
 */
export function errorPlace(item) {
  const text = String(item?.description ?? '');
  if (!/\b[A-Z]?\w*(Error|Exception)\b/.test(text) || /^Failed to load resource\b/.test(text)) return null;
  const at = text.match(/(https?:\/\/[^\s()]+?):(\d+):(\d+)/);
  if (at) return { url: at[1], line: Number(at[2]), column: Number(at[3]) };
  const s = item?.sourceLocation;
  if (s?.url && Number.isInteger(s.line)) return { url: s.url, line: Number(s.line) + 1, column: Number(s.column ?? 0) + 1 };
  return null;
}

/** The key a place is looked up by. */
export const placeKey = (p) => `${p.url}:${p.line}`;

/** The copy's file served at an address of the copy's server, or null (never outside the copy's folder). */
async function servedFile(root, url) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const c of candidates) {
    const file = path.resolve(root, c);
    if (file !== root && !file.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
    if ((await stat(file).catch(() => null))?.isFile()) return file;
  }
  return null;
}

/**
 * Every line (at least MIN_LINE_CHARS long, compared through sameCode) of the pages and scripts the original's own site served while it was
 * captured (capture/.network: index.json + files/<sha>).
 * @param {string} networkDir @param {string} siteUrl
 * @returns {Promise<Set<string>>}
 */
export async function originalLines(networkDir, siteUrl) {
  const lines = new Set();
  let site;
  try {
    site = bare(new URL(siteUrl).hostname);
  } catch {
    return lines;
  }
  const index = await readFile(path.join(networkDir, 'index.json'), 'utf8').then(JSON.parse, () => null);
  let read = 0;
  for (const e of Array.isArray(index?.entries) ? index.entries : []) {
    if ((e?.kind !== 'document' && e?.kind !== 'script') || !e.sha || !e.url) continue;
    try {
      if (bare(new URL(e.url).hostname) !== site) continue;
    } catch {
      continue;
    }
    if (read + (e.bytes ?? 0) > MAX_SOURCE_BYTES) break;
    const body = await readFile(path.join(networkDir, 'files', String(e.sha).replace(/[^a-f0-9]/gi, '')), 'utf8').catch(() => null);
    if (body == null) continue;
    read += body.length;
    for (const raw of body.split('\n')) {
      if (raw.trim().length >= MIN_LINE_CHARS) lines.add(sameCode(raw, originsOf(siteUrl)));
    }
  }
  return lines;
}

/**
 * For every script error the copy logged: the copy's line it was thrown at and whether that line is the original's own.
 * @param {{ items: object[], copyRoot: string, networkDir: string, siteUrl: string }} o
 * @returns {Promise<Map<string, { file: string, line: number, text: string, inOriginal: boolean }>>} by placeKey
 */
export async function ownCodeErrors({ items, copyRoot, networkDir, siteUrl }) {
  const out = new Map();
  const places = items.map(errorPlace).filter(Boolean);
  if (!places.length) return out;
  const original = await originalLines(networkDir, siteUrl);
  const files = new Map();
  for (const place of places) {
    const key = placeKey(place);
    if (out.has(key)) continue;
    const file = await servedFile(copyRoot, place.url);
    if (!file) continue;
    if (!files.has(file)) files.set(file, await readFile(file, 'utf8').then((t) => t.split('\n'), () => []));
    const text = (files.get(file)[place.line - 1] ?? '').trim();
    out.set(key, { file: path.relative(copyRoot, file), line: place.line, text, inOriginal: text.length >= MIN_LINE_CHARS && original.has(sameCode(text, originsOf(siteUrl))) });
  }
  return out;
}
