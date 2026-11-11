// @ts-check
// The fonts of a design direction's preview card, served by the app itself: the owner's browser never asks Google (their visit
// is nobody else's business). A family is asked of Google Fonts once, server-side, through fonts.js (the SSRF-guarded fetch,
// latin faces only, 400 and 700), its files kept under <DATA_DIR>/buildmode/fonts/ and shared by every owner.
//   GET /api/build/fonts/:family.css        @font-face rules naming "<family> sas-preview" (a name of its own, so it never
//                                           replaces a font the app or the owner's computer has), files relative to this route
//   GET /api/build/fonts/files/:file.woff2  one of those files; only names this cache wrote are served
// A family Google does not have (a system font) or a failed request answers 404 and is remembered for a while; the preview then
// draws with the fallback stack. The cache holds at most MAX_FAMILIES families and MAX_BYTES bytes, least recently used out first.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { DATA_DIR } from '../config/paths.js';
import { FONT_LIMITS, download, parseFontCss, stylesheetOf } from './fonts.js';

export const PREVIEW_LIMITS = { families: 80, bytes: 24 * 1024 * 1024, facesPerFamily: 4, missingMs: 60 * 60 * 1000, nameLength: 48 };
export const PREVIEW_SUFFIX = 'sas-preview';
const WEIGHTS = '400;700';
const FILE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{12}\.woff2$/;
const TOUCH_MS = 60 * 60 * 1000;

/** The family name as the preview asks for it: letters, digits and single spaces, at least one letter; null otherwise. */
export function checkFamily(/** @type {unknown} */ raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/ {2,}/g, ' ');
  if (!name || name.length > PREVIEW_LIMITS.nameLength || !/^[A-Za-z0-9 ]+$/.test(name) || !/[A-Za-z]/.test(name)) return null;
  return name;
}

/** A file name this cache could have written (the only shape the file route serves). */
export const checkFile = (/** @type {unknown} */ raw) => (typeof raw === 'string' && raw.length <= 96 && FILE_RE.test(raw) ? raw : null);

const slug = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'font';
const fileName = (/** @type {string} */ family, /** @type {string} */ url) => `${slug(family)}-${createHash('sha256').update(`${family}\n${url}`).digest('hex').slice(0, 12)}.woff2`;

/**
 * @typedef {{ file: string, weight: string, style: string, range: string | null, bytes: number }} Face
 * @typedef {{ family: string, used: number, faces: Face[], missingAt?: number }} Entry
 */

/**
 * The cache. Tests pass their own folder and fetchers (no network).
 * @param {{ dir?: string, fetchCss?: (family: string) => Promise<string | null>, fetchFile?: (url: string) => Promise<Buffer | null>,
 *   limits?: Partial<typeof PREVIEW_LIMITS>, now?: () => number }} [o]
 */
export function fontPreviewStore({
  dir = path.join(DATA_DIR, 'buildmode', 'fonts'),
  fetchCss = (family) => stylesheetOf(family, WEIGHTS),
  fetchFile = download,
  limits = {},
  now = Date.now,
} = {}) {
  const lim = { ...PREVIEW_LIMITS, ...limits };
  const indexFile = path.join(dir, 'index.json');
  /** @type {Map<string, Entry> | null} */
  let index = null;
  /** @type {Promise<Map<string, Entry>> | null} */
  let loading = null;
  /** @type {Map<string, Promise<Entry>>} */
  const pending = new Map();
  let writing = Promise.resolve();

  /** Reads the index once; files it does not list (a crash between writes) are removed. */
  const load = () => (loading ??= readIndex());
  async function readIndex() {
    await mkdir(dir, { recursive: true });
    /** @type {Map<string, Entry>} */
    const map = new Map();
    try {
      const saved = JSON.parse(await readFile(indexFile, 'utf8'));
      for (const e of Array.isArray(saved?.families) ? saved.families : []) {
        const family = checkFamily(e?.family);
        if (!family || !Array.isArray(e.faces)) continue;
        const faces = e.faces.filter((f) => checkFile(f?.file)).map((f) => ({ file: f.file, weight: String(f.weight).replace(/[^\d ]/g, '') || '400', style: f.style === 'italic' ? 'italic' : 'normal', range: typeof f.range === 'string' && /^[\w+\-?, ]+$/.test(f.range) ? f.range : null, bytes: Number(f.bytes) || 0 }));
        map.set(family, { family, used: Number(e.used) || 0, faces, ...(Number.isFinite(e.missingAt) && { missingAt: e.missingAt }) });
      }
    } catch {
      // No index yet, or an unreadable one: start empty.
    }
    const listed = new Set([...map.values()].flatMap((e) => e.faces.map((f) => f.file)));
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.endsWith('.woff2') && !listed.has(name)) await rm(path.join(dir, name), { force: true });
    }
    index = map;
    return map;
  }

  /** Writes the index (one write at a time, through a temporary file). */
  function save() {
    const map = /** @type {Map<string, Entry>} */ (index);
    writing = writing.then(async () => {
      const tmp = `${indexFile}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, families: [...map.values()] }));
      await rename(tmp, indexFile);
    }).catch(() => {});
    return writing;
  }

  /** Least recently used families out until the cache is within its limits (the one just added stays). */
  async function trim(/** @type {string} */ keep) {
    const map = /** @type {Map<string, Entry>} */ (index);
    const size = () => [...map.values()].reduce((n, e) => n + e.faces.reduce((m, f) => m + f.bytes, 0), 0);
    let bytes = size();
    for (const e of [...map.values()].sort((a, b) => a.used - b.used)) {
      if (map.size <= lim.families && bytes <= lim.bytes) break;
      if (e.family === keep) continue;
      map.delete(e.family);
      for (const f of e.faces) await rm(path.join(dir, f.file), { force: true });
      bytes = size();
    }
  }

  /** Asks Google for the family and stores its latin faces; an entry without faces means "not available". */
  async function fetchFamily(/** @type {string} */ family) {
    const css = await fetchCss(family).catch(() => null);
    const seen = new Map();
    /** @type {Face[]} */
    const faces = [];
    for (const face of css ? parseFontCss(css).filter((f) => f.subset === 'latin') : []) {
      if (faces.length >= lim.facesPerFamily) break;
      const file = fileName(family, face.url);
      if (!seen.has(file)) {
        const data = await fetchFile(face.url).catch(() => null);
        // Only a woff2 file of a face's size is kept.
        const ok = Buffer.isBuffer(data) && data.length > 4 && data.length <= FONT_LIMITS.faceBytes && data.subarray(0, 4).toString('latin1') === 'wOF2';
        if (ok) await writeFile(path.join(dir, file), data);
        seen.set(file, ok ? data.length : 0);
      }
      if (!seen.get(file)) continue;
      faces.push({ file, weight: face.weight.replace(/[^\d ]/g, '') || '400', style: face.style === 'italic' ? 'italic' : 'normal', range: face.range && /^[\w+\-?, ]+$/.test(face.range) ? face.range : null, bytes: seen.get(file) });
    }
    /** @type {Entry} */
    const entry = { family, used: now(), faces, ...(!faces.length && { missingAt: now() }) };
    const map = /** @type {Map<string, Entry>} */ (index);
    map.set(family, entry);
    await trim(family);
    await save();
    return entry;
  }

  /** The family's entry, from the cache or fetched now (one fetch per family at a time). */
  async function entryOf(/** @type {string} */ family) {
    const map = await load();
    const hit = map.get(family);
    const fresh = hit && (hit.faces.length || now() - (hit.missingAt ?? 0) < lim.missingMs);
    if (hit && fresh) {
      if (now() - hit.used > TOUCH_MS) {
        hit.used = now();
        save();
      }
      return hit;
    }
    if (!pending.has(family)) pending.set(family, fetchFamily(family).finally(() => pending.delete(family)));
    return /** @type {Promise<Entry>} */ (pending.get(family));
  }

  return {
    dir,
    /**
     * The @font-face rules of a family, or null when it is not available.
     * @param {string} family  already checked (checkFamily)
     */
    async css(family) {
      const entry = await entryOf(family);
      if (!entry.faces.length) return null;
      const name = `${family} ${PREVIEW_SUFFIX}`;
      return `/* ${family}, served by the app for the design preview. */\n${entry.faces.map((f) => `@font-face {\n  font-family: "${name}";\n  font-style: ${f.style};\n  font-weight: ${f.weight};\n  font-display: swap;\n  src: url("files/${f.file}") format("woff2");${f.range ? `\n  unicode-range: ${f.range};` : ''}\n}`).join('\n')}\n`;
    },
    /**
     * A stored file, or null. The name is looked up in the index: nothing the client sends becomes a path by itself.
     * @param {string} name  already checked (checkFile)
     */
    async file(name) {
      const map = await load();
      for (const e of map.values()) {
        const face = e.faces.find((f) => f.file === name);
        if (face) return readFile(path.join(dir, face.file)).catch(() => null);
      }
      return null;
    },
    /** For tests: which families the cache holds. */
    async families() {
      return [...(await load()).keys()];
    },
  };
}

/**
 * The routes, mounted at /api/build/fonts. Owner-agnostic: the same fonts for everyone.
 * @param {ReturnType<typeof fontPreviewStore>} [store]
 */
export function fontPreviewRouter(store) {
  let shared = store;
  const cache = () => (shared ??= fontPreviewStore());
  const router = Router();
  const missing = (/** @type {import('express').Response} */ res, status = 404) => res.status(status).set('Cache-Control', 'no-store').json({ error: 'This font is not available for the preview.' });

  router.get('/files/:file', async (req, res, next) => {
    try {
      const name = checkFile(req.params.file);
      if (!name) return missing(res, 400);
      const data = await cache().file(name);
      if (!data) return missing(res);
      res.set({ 'Content-Type': 'font/woff2', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }).send(data);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:name', async (req, res, next) => {
    try {
      const raw = String(req.params.name);
      const family = raw.endsWith('.css') ? checkFamily(raw.slice(0, -4)) : null;
      if (!family) return missing(res, 400);
      const css = await cache().css(family);
      if (!css) return missing(res);
      res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }).send(css);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
