// @ts-check
// The whole original page with its own runtime, saved locally (CLONER_SPEC step 4, page-level approach): the document as
// the server sent it (its inline data, e.g. Next.js's self.__next_f pushes, and its own scripts, unchanged), every file it
// loads from the job's network record (chunks, stylesheets, fonts, images, media) copied to the SAME paths it had on the
// original site, so root-relative references keep working; every URL is rewritten to the local copy. Trackers and
// analytics are removed by rule (scripts classified excluded), never run.
// A file the record does not hold and the page USES (a script, stylesheet, font, image, icon, manifest) is downloaded once
// at build time through the guarded download and stored at the same path. A file that could not be had is a blocker,
// reported, and never silently pointed back at the original. Plain links (a feed in <link rel="alternate">) are left as
// they are: nothing loads them.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { readRecordIndex, classifyScripts, recordBodyReader } from '../scripts.js';
import { scriptCandidates } from './extract.js';
import { RULES } from '../../../detection/engine.js';
import { rewriteHosts } from './hostRewrite.js';
import { downloadAsset } from '../../assets/download.js';
import { rangesOf, sliceOf, RANGED_MAX_BYTES } from './ranged.js';
import { createPrefetch } from './prefetch.js';
import { waitForNetwork } from '../../../audit/interruptions.js';
import { NETWORK_WAIT_MS } from '../../interrupts.js';

/** Largest file the lift downloads at build time (bytes). */
export const LIFT_MAX_BYTES = 25 * 1024 * 1024;
/** What the guarded download expects for each kind of file (assets/download.js). */
// A web app manifest is JSON, which an icon download refuses as "not an asset" (own360.ai's /manifest.json never reached the
// copy, and every page of it asked for the missing file): it is downloaded as data, which accepts JSON.
const DOWNLOAD_KIND = { media: 'media', icon: 'icon', manifest: 'data', style: 'image', script: 'image' };

/** Most assets a page's scripts may name that the record lacks (downloaded at build time). */
export const JS_ASSET_LIMIT = 60;

/** Attempts per download (the guarded download's own back-off applies between them). */
export const LIFT_ATTEMPTS = 3;

/**
 * Download failures that say the network (or the far end's connection) failed, not the file: the address may well answer once
 * the network is back (assets/download.js reasons). Shared by the re-check's reasons (copy/gotWorse.js) and
 * scripts/refetch-missing.js.
 */
export const NETWORK_FAILURE_REASONS = new Set(['dns', 'refused', 'timeout', 'time-limit', 'reset']);
/** The longest a whole copy waits for the network to come back for its build-time downloads, all pages together. */
export const LIFT_NETWORK_WAIT_MS = 2 * NETWORK_WAIT_MS;

/**
 * One job's waiting for the network, shared by the pages it lifts: a build-time download that failed at network level waits
 * for its host to answer again (each wait ≤ NETWORK_WAIT_MS, all of them ≤ maxTotalMs) and is tried once more. A network
 * that did not come back within the time left is not waited for again, so a copy made offline loses minutes, not hours.
 * SAS_NETWORK_WATCH=0 (the test suite, audit/interruptions.js): no waiting unless a test passes its own `wait`.
 * @param {{ maxTotalMs?: number, wait?: typeof waitForNetwork }} [o]
 */
export function createNetworkRetry({ wait, maxTotalMs = !wait && process.env.SAS_NETWORK_WATCH === '0' ? 0 : LIFT_NETWORK_WAIT_MS } = {}) {
  wait ??= waitForNetwork;
  let spent = 0;
  let gaveUp = false;
  const stats = { waits: 0, waitedMs: 0, retried: 0, recovered: 0 };
  return {
    stats,
    /** Waits until `url`'s host answers; true when it did (try the download again). */
    async waitBack(url) {
      if (gaveUp || spent >= maxTotalMs) return false;
      stats.waits++;
      const { back, waitedMs } = await wait(url, { until: Date.now() + Math.min(NETWORK_WAIT_MS, maxTotalMs - spent) });
      spent += waitedMs;
      stats.waitedMs += waitedMs;
      if (!back) gaveUp = true;
      return back;
    },
  };
}

/** The extension a file of this content type is saved under (the content, not the address, decides it). */
const EXT_OF_TYPE = { 'image/webp': '.webp', 'image/avif': '.avif', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/svg+xml': '.svg' };

/**
 * The local path (root-relative) of a URL, as the copy serves it. Two addresses of one file that differ only in their query
 * (a responsive variant) are two files: the query's hash is part of the name. The extension follows the content type when
 * the record (or a download) knows it, so a WebP served from a .png address is named .webp.
 */
export function localPathOf(url, type = null, kind = null) {
  const u = new URL(url);
  let clean = decodeURIComponent(u.pathname);
  if (clean.endsWith('/')) {
    // An address ending in / is a document only when its content is one. A script or stylesheet served there (a CDN's root
    // with a query: cdn.tailwindcss.com/?plugins=…) named index.html is served as HTML by every host, and the browser refuses
    // to run it ("tailwind is not defined" on every page of botza's copy). Its content type names it; failing that, the tag
    // that loads it.
    const mime = String(type ?? '').split(';')[0].trim().toLowerCase();
    const ext = EXT_ANY_TYPE[mime] ?? (/html/.test(mime) ? null : EXT_OF_KIND[kind]);
    clean += ext ? `index${ext}` : 'index.html';
  }
  if (u.search) {
    const hash = createHash('sha256').update(u.search).digest('hex').slice(0, 8);
    const dot = clean.lastIndexOf('.');
    const slash = clean.lastIndexOf('/');
    clean = dot > slash ? `${clean.slice(0, dot)}~${hash}${clean.slice(dot)}` : `${clean}~${hash}`;
  }
  const typed = EXT_OF_TYPE[String(type ?? '').split(';')[0].trim().toLowerCase()];
  if (typed && /\.[a-z0-9]+$/i.test(clean) && /^image\//.test(String(type))) clean = clean.replace(/\.[a-z0-9]+$/i, typed);
  // A host decides a file's type from its extension (CDNs, static hosts, Vercel and Netlify alike). A name that does not end in
  // a known one gets one: a version after the extension (menu.js@0.0.29) moves before it (menu@0.0.29.js); any other name takes
  // the extension of its content type. The version stays in the name, so two versions are two files.
  if (!KNOWN_EXT.test(clean)) {
    const versioned = clean.match(/^(.*)\.([a-z0-9]+)@([\w.-]+)$/i);
    if (versioned && KNOWN_EXT.test(`.${versioned[2]}`)) clean = `${versioned[1]}@${versioned[3]}.${versioned[2]}`;
    else if (EXT_ANY_TYPE[String(type ?? '').split(';')[0].trim().toLowerCase()]) clean += EXT_ANY_TYPE[String(type).split(';')[0].trim().toLowerCase()];
  }
  return fileSafePath(clean);
}

/** The extension of a file a tag loads as code, when its content type does not say (localPathOf). */
const EXT_OF_KIND = { script: '.js', style: '.css' };
/** Kinds of file a page runs or applies: an HTML page in their place breaks the page. */
const CODE_KINDS = new Set(['script', 'style']);
const isHtmlType = (t) => /^text\/html\b/i.test(String(t ?? '').trim());
/**
 * A file name that carries a build hash: a part of 8+ characters after a - . _ or ~ holding a digit or an upper-case letter
 * (index-DdEuaEXJ.js, main.4f2a9c1b.css, favicon-32x32-R45_galS.png). A plain word (my-analytics.js, apple-touch-icon.png) is
 * not one, and a page (.html) never is.
 */
export const hashedName = (name) => {
  const m = String(name ?? '').match(/[-.~_]([A-Za-z0-9_-]{8,})\.([a-z0-9]+)$/i);
  return !!m && !/^html?$/i.test(m[2]) && /[0-9A-Z]/.test(m[1]);
};

/** Characters no file name may hold on some system (Windows forbids them all; a decoded %2F or %5C would be a folder). */
const UNSAFE_IN_NAME = /[<>:"\\|?*\u0000-\u001f]/g;
/** Names Windows keeps for devices, with or without an extension. */
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/**
 * A root-relative path every file system can store, the same on every machine (a copy made on Linux and one made on Windows
 * name their files alike): a character a name may not hold becomes ~ and its code (`Special:FilePath` → `Special~3aFilePath`),
 * a dot segment, a trailing dot or space and a device name are spelled so they are plain names. A path that needs none of it
 * is returned unchanged. The copy's references are rewritten to the result, so the address still finds the file.
 * @param {string} p  decoded path, starting with /
 */
export function fileSafePath(p) {
  const code = (c) => `~${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  return p.split('/').map((seg, i) => {
    if (i === 0 && seg === '') return seg;
    let s = seg.replace(UNSAFE_IN_NAME, code);
    if (s === '.' || s === '..') s = s.replace(/\./g, '~2e');
    s = s.replace(/[. ]+$/, (tail) => [...tail].map(code).join(''));
    if (RESERVED_NAME.test(s)) s = s.replace(/^([^.]+)/, '$1~');
    return s;
  }).join('/');
}

/** Whether a decoded path can be stored under its own name (fileSafePath leaves it as it is). */
export const storableAsIs = (p) => fileSafePath(p) === p;

/**
 * The address the copy's text writes for a file at a local path. A local path is decoded (localPathOf), and a name may hold
 * what an address reads otherwise: Webflow names a smaller size of a picture after the picture's address, so the file is
 * "Screenshot%202024-12-28 at 7.59.16 PM-p-500.png" with a literal "%20" in it (the original writes %2520). Written as it
 * is, the browser decodes that %20 to a space and asks for a name the copy does not have (onfinance.ai: 7 pictures 404), and
 * a space ends an address inside a srcset. A "%", white space, a quote, "#" and "?" are written encoded; every other
 * character stays as it is, so a plain path is unchanged.
 * @param {string} local  root-relative decoded path
 */
export const addressOf = (local) => String(local).replace(/[%\s"#?]/g, (c) => encodeURIComponent(c));

/** Extensions a host serves with the right type. */
const KNOWN_EXT = /\.(html?|m?js|css|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|ogv|mp3|ogg|wav|m4a|wasm|txt|xml|webmanifest|map)$/i;
/** A versioned name in a copy's text, as a runtime writes it after its parts: name.js@0.0.32 (the version then ends the name). */
const VERSIONED_IN_TEXT = /\.(m?js|css|json)@(\d[\w.-]*)(?=[`"'\s),;?#]|$)/g;
/** The extension a file of a content type gets when its address has none the host knows. */
const EXT_ANY_TYPE = {
  'text/javascript': '.js', 'application/javascript': '.js', 'text/css': '.css', 'application/json': '.json', 'text/plain': '.txt',
  'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf', 'video/mp4': '.mp4', 'video/webm': '.webm',
  'audio/mpeg': '.mp3', 'application/wasm': '.wasm', 'image/svg+xml': '.svg', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/gif': '.gif', 'image/x-icon': '.ico', 'application/manifest+json': '.webmanifest',
};

/**
 * A file the copy renamed (localPathOf): every reference to its old name in the copy's text (HTML, scripts, styles, the
 * manifests) is rewritten to the new one. A reference is a whole path segment, so a word that merely contains the name is left
 * alone. Returns how many references changed.
 * @param {string} outDir
 * @param {Map<string, string>} renames  old file name → new file name
 */
export async function renameReferences(outDir, renames) {
  const names = [...renames.keys()].sort((a, b) => b.length - a.length);
  const pattern = names.length
    ? new RegExp(`(?<=[/"'\`(])(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=[?#"'\`)\\s,;]|$)`, 'g')
    : null;
  let changed = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
      } else if (/\.(html?|m?js|css|json|svg|webmanifest|txt|xml)$/i.test(entry.name)) {
        const text = await readFile(file, 'utf8');
        const named = pattern ? text.replace(pattern, (m) => {
          changed++;
          return renames.get(m);
        }) : text;
        // A name a runtime builds from parts (`${base}${name}.js@0.0.32`) is not in the text whole: the same rule applies to it
        // wherever the version follows the extension, so the address it builds is the one localPathOf gave the file.
        const next = named.replace(VERSIONED_IN_TEXT, (m, ext, version) => {
          changed++;
          return `@${version}.${ext}`;
        });
        if (next !== text) await writeFile(file, next, 'utf8');
      }
    }
  };
  await walk(outDir);
  return changed;
}

/** Whether a URL is on the page's own site (or a subdomain of it). */
function sameSite(url, siteHost) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === siteHost || host.endsWith(`.${siteHost}`);
  } catch {
    return false;
  }
}

/** Link header parameters a `<link>` tag can carry as attributes (others, like `nopush`, mean nothing in a page). */
const LINK_PARAMS = new Set(['as', 'crossorigin', 'type', 'media', 'fetchpriority', 'imagesrcset', 'imagesizes', 'integrity', 'referrerpolicy']);

/**
 * The preloads of a document's `Link` response header (RFC 8288): `<url>; rel=preload; as=font; crossorigin; type="font/woff2"`,
 * comma-separated. Only `preload` and `modulepreload` (what the browser fetches at once); `preconnect` and the rest are left.
 * @param {string} header
 * @returns {{ href: string, rel: string, attrs: Record<string, string> }[]}
 */
export function headerPreloads(header) {
  const out = [];
  for (const m of String(header ?? '').matchAll(/<([^>]*)>((?:\s*;\s*[^;,]+(?:=(?:"[^"]*"|[^;,]*))?)*)/g)) {
    const attrs = {};
    let rel = '';
    for (const p of m[2].split(';').map((s) => s.trim()).filter(Boolean)) {
      const eq = p.indexOf('=');
      const name = (eq < 0 ? p : p.slice(0, eq)).trim().toLowerCase();
      const value = eq < 0 ? '' : p.slice(eq + 1).trim().replace(/^"|"$/g, '');
      if (name === 'rel') rel = value.toLowerCase();
      else if (LINK_PARAMS.has(name)) attrs[name] = value;
    }
    const kind = rel.split(/\s+/).find((r) => r === 'preload' || r === 'modulepreload');
    if (m[1].trim() && kind) out.push({ href: m[1].trim(), rel: kind, attrs });
  }
  return out;
}

/** The kind a loading tag gives the file: what the download expects. */
function kindOfTag(tag, rel = '', as = '') {
  if (tag === 'script') return 'script';
  if (tag === 'link' && /stylesheet/.test(rel)) return 'style';
  if (tag === 'link' && /(^|\s)manifest(\s|$)/.test(rel)) return 'manifest';
  if (tag === 'link' && /icon|manifest/.test(rel)) return 'icon';
  // A preload is the kind it names: a font or a picture copied as a "script" would be read and rewritten as script text later.
  if (tag === 'link' && /(^|\s)preload/.test(rel) && /^font$/i.test(as ?? '')) return 'font';
  if (tag === 'link' && /(^|\s)preload/.test(rel) && /^image$/i.test(as ?? '')) return 'media';
  if (tag === 'link' && /preload|modulepreload/.test(rel)) return 'script';
  return 'media';
}

/**
 * Saves the page: document, its files and its scripts (trackers removed) into outDir, served from its root.
 * @param {{ captureRoot: string, pageUrl: string, outDir: string, fetch?: boolean, fetchImpl?: typeof downloadAsset }} o
 */
/**
 * The identity of a page for links between copies: host without www, path without its trailing slash or index.html, no
 * query and no fragment. `https://www.site.test/about/?x=1#top` and `https://site.test/about` are the same page.
 * @param {string} url
 */
export function pageKeyOf(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '');
  return `${u.hostname.replace(/^www\./, '')}${p}`;
}

/**
 * The record's document of this page, and only of this page: the same address, else where the record's redirects from it lead
 * (≤ 5 hops), else a document with the same page identity (pageKeyOf: www, trailing slash, index.html). Never another page's
 * document: a page the capture never loaded has none, and the copy must not show the homepage in its place.
 * @param {{ entries?: any[] }} recordIndex
 * @param {string} pageUrl
 * @returns {any|null}
 */
export function pageDocumentOf(recordIndex, pageUrl) {
  const entries = recordIndex?.entries ?? [];
  const bare = (u) => String(u).split('#')[0];
  const docs = entries.filter((e) => e.kind === 'document' && e.sha && !e.redirect);
  let url = bare(pageUrl);
  for (let hop = 0; hop <= 5; hop++) {
    const doc = docs.find((e) => bare(e.url) === url);
    if (doc) return doc;
    const moved = entries.find((e) => e.redirect && bare(e.url) === url);
    if (!moved) break;
    url = bare(moved.redirect);
  }
  const keyOf = (u) => {
    try {
      return pageKeyOf(u);
    } catch {
      return null;
    }
  };
  const key = keyOf(pageUrl);
  return (key && docs.find((e) => keyOf(e.url) === key)) ?? null;
}

export async function liftPage({ captureRoot, pageUrl, outDir, fetch = true, fetchImpl = downloadAsset, entry = 'index.html', pageLinks = new Map(), networkRetry = createNetworkRetry(), lifted = [] }) {
  const recordDir = path.join(captureRoot, '.network');
  const recordIndex = (await readRecordIndex(recordDir)) ?? { entries: [] };
  /** @type {Map<string, any>} */
  const byUrl = new Map();
  for (const e of recordIndex.entries ?? []) if (e.url && e.sha && !e.redirect) byUrl.set(e.url.split('#')[0], e);
  const doc = pageDocumentOf(recordIndex, pageUrl);
  if (!doc) throw Object.assign(new Error(`no document for ${pageUrl} in the record: the page was not captured`), { code: 'not-captured' });
  const html = await readFile(path.join(recordDir, 'files', doc.sha), 'utf8');
  const siteHost = new URL(pageUrl).hostname.replace(/^www\./, '');
  const tmp = path.join(outDir, '.lift-tmp');
  await mkdir(outDir, { recursive: true });

  const classified = await classifyScripts(recordIndex, recordBodyReader(recordDir), { origin: pageUrl });
  const excluded = new Set(scriptCandidates(classified, siteHost).filter((s) => s.status === 'excluded').map((s) => s.url));
  // A builder's editor (its own host, under /edit) is not part of the site: the original never ran it for a visitor.
  const builderHosts = new Set(RULES.flatMap((r) => r.cleanup?.cdnHosts ?? []).map((h) => h.replace(/^www\./, '')));
  for (const e of recordIndex.entries ?? []) {
    try {
      const u = new URL(e.url);
      if (e.kind === 'script' && builderHosts.has(u.hostname.replace(/^www\./, '')) && /^\/edit(\/|$)/.test(u.pathname)) excluded.add(e.url);
    } catch {
      // Not a URL.
    }
  }

  // Which recorded font file a face of the same family, weight and style uses: the page's own @font-face rules (its sheets
  // and inline blocks) name the same font at the address the record holds, even when a face names another address.
  /** @type {Map<string, string[]>} family|weight|style → recorded font addresses */
  const faceIndex = new Map();
  const faceKey = (block) => {
    const family = (block.match(/font-family\s*:\s*([^;]+);/)?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    const weight = (block.match(/font-weight\s*:\s*([^;]+);/)?.[1] ?? '400').trim().replace(/\s+/g, ' ');
    const style = (block.match(/font-style\s*:\s*([^;]+);/)?.[1] ?? 'normal').trim();
    return `${family}|${weight}|${style}`;
  };
  const indexCss = (text, base) => {
    for (const block of [...String(text).matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0])) {
      const srcDecl = block.match(/src\s*:([^;]+);/);
      if (!srcDecl) continue;
      for (const m of srcDecl[1].matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
        let abs;
        try {
          abs = new URL(m[2].trim(), base).href.split('#')[0];
        } catch {
          continue;
        }
        if (!byUrl.has(abs) || excluded.has(abs)) continue;
        const key = faceKey(block);
        faceIndex.set(key, [...(faceIndex.get(key) ?? []), abs]);
      }
    }
  };
  for (const e of recordIndex.entries ?? []) {
    if (e.kind !== 'style' || !e.sha || e.redirect) continue;
    const text = await readFile(path.join(recordDir, 'files', e.sha), 'utf8').catch(() => '');
    indexCss(text, e.url);
  }
  for (const st of load(html)('style').toArray()) indexCss(load(html)(st).html() ?? '', pageUrl);

  // Host names of the original (its site and every host the record holds, excluded scripts' hosts left out): inside the copy
  // they are local paths (hostRewrite.js), so the copy never names the original, even before its service worker is active.
  const originHosts = [...new Set([siteHost, ...(recordIndex.entries ?? []).filter((e) => !excluded.has(e.url)).map((e) => {
    try {
      return new URL(e.url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })].filter(Boolean))];
  const $ = load(html);
  // Preloads the original host sent as a `Link` header (a framework's fonts and styles, fetched at the first byte). A static
  // copy is served with no such header, so its fonts were found only once the stylesheet was parsed: the same page painted its
  // text later. They are written as tags at the top of the head (after the charset), only for files the record holds (so the
  // copy has them) and that no tag of the page already loads; the walk below localises them like any other tag. A preload
  // only fetches earlier: nothing it names is drawn differently.
  const tagged = new Set($('link[href]').toArray().map((el) => {
    try {
      return new URL($(el).attr('href').trim(), pageUrl).href.split('#')[0];
    } catch {
      return '';
    }
  }));
  const headerTags = [];
  for (const p of headerPreloads(doc.link)) {
    let abs;
    try {
      abs = new URL(p.href, pageUrl).href.split('#')[0];
    } catch {
      continue;
    }
    if (!byUrl.has(abs) || excluded.has(abs) || tagged.has(abs)) continue;
    tagged.add(abs);
    const tag = $('<link>').attr('rel', p.rel).attr('href', abs);
    for (const [k, v] of Object.entries(p.attrs)) tag.attr(k, v);
    headerTags.push(tag);
  }
  if (headerTags.length) {
    const charset = $('head meta[charset]').first();
    if (charset.length) charset.after(headerTags);
    else $('head').prepend(headerTags);
  }
  /** @type {{ url: string, reason: string }[]} */
  const blockers = [];
  /** @type {{ url: string, local: string, kind: string, from: string, reason: string, sha256: string }[]} */
  const files = [];
  const removed = [];
  const downloads = { tried: 0, ok: 0, failed: 0, failedUrls: [] };
  /** @type {{ url: string, family: string, reason: string }[]} font sources the copy does not keep */
  const dropped = [];
  /** @type {{ family: string, from: string }[]} faces given the recorded file of the same font */
  const matchedBy = [];
  /** @type {{ url: string, to: string, kind: string, reason: string }[]} code addresses answered with HTML, given their real file */
  const healed = [];
  /**
   * The site's own file for an address its server does not serve the file at (it answers its HTML page, or nothing): a recorded
   * file of the same name, on the same origin, of the right type. Only a name carrying a build hash (index-DdEuaEXJ.js,
   * favicon-32x32-R45_galS.png), so the match names the same build output, and only when exactly one distinct file has that
   * name; null otherwise.
   */
  const codeTwinOf = (abs, kind) => {
    let u;
    try {
      u = new URL(abs);
    } catch {
      return null;
    }
    const name = u.pathname.split('/').pop() ?? '';
    if (!hashedName(name)) return null;
    const found = new Map();
    for (const e of byUrl.values()) {
      if (e.status !== 200 || !e.sha || isHtmlType(e.type)) continue;
      let v;
      try {
        v = new URL(e.url);
      } catch {
        continue;
      }
      if (v.origin !== u.origin || v.pathname === u.pathname || v.pathname.split('/').pop() !== name) continue;
      const right = kind === 'style' ? /css/i.test(e.type ?? '') || e.kind === 'style'
        : kind === 'script' ? /javascript|ecmascript/i.test(e.type ?? '') || e.kind === 'script'
          : true; // an icon, a picture, a font, a manifest: any file that is not a page (checked above)
      if (right) found.set(e.sha, e.url.split('#')[0]);
    }
    return found.size === 1 ? [...found.values()][0] : null;
  };
  /** The same, among the files earlier pages of this copy brought in (`lifted`: { url, local }): one distinct file, or null. */
  const liftedTwinOf = (abs) => {
    let u;
    try {
      u = new URL(abs);
    } catch {
      return null;
    }
    const name = u.pathname.split('/').pop() ?? '';
    if (!hashedName(name)) return null;
    const found = new Map();
    for (const f of lifted) {
      let v;
      try {
        v = new URL(f.url);
      } catch {
        continue;
      }
      if (v.origin !== u.origin || v.pathname === u.pathname || v.pathname.split('/').pop() !== name || !f.local) continue;
      found.set(f.sha256 ?? f.local, f);
    }
    return found.size === 1 ? [...found.values()][0] : null;
  };

  /** Copies one recorded file to its path on the copy. */
  const fromRecord = async (abs, entry, kind) => {
    const local = localPathOf(abs, entry.type, kind);
    const target = path.join(outDir, local);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(recordDir, 'files', entry.sha), target);
    files.push({ url: abs, local, kind, sha256: entry.sha, from: abs, reason: 'a file the page loaded (from the network record)' });
    return local;
  };

  // The downloads each walk below will certainly make are started ahead of it, several at once (prefetch.js); the walk takes
  // each answer where it asks for it, so names, the file list and its order are those of a walk that fetched one by one.
  const prefetch = createPrefetch(fetchImpl);
  const liftOpts = (kind) => ({ dir: tmp, kind: DOWNLOAD_KIND[kind] ?? 'image', maxBytes: LIFT_MAX_BYTES, attempts: LIFT_ATTEMPTS });
  const startAhead = async (list) => {
    if (!fetch || !list.length) return;
    await mkdir(tmp, { recursive: true });
    for (const [abs, kind] of list) prefetch.ahead(`${kind}|${abs}`, abs, liftOpts(kind));
  };
  /** A URL a walk would download (not excluded, not in the record), as localize resolves it; null when it would not. */
  const wouldDownload = (raw, base = pageUrl) => {
    if (!raw || /^(data|blob|javascript|#|mailto|tel)/i.test(raw.trim())) return null;
    let abs;
    try {
      abs = new URL(raw.trim(), base).href.split('#')[0];
    } catch {
      return null;
    }
    return excluded.has(abs) || byUrl.has(abs) ? null : abs;
  };
  /** The url() references rewriteCss downloads (outside @font-face, whose sources are decided by the record first). */
  const cssDownloads = (css, base) => {
    const list = [];
    for (const m of String(css).replace(/@font-face\s*\{[^}]*\}/g, '').matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      if (/^(data|blob|#|\/)/i.test(m[2].trim())) continue;
      try {
        if (decodeURIComponent(m[2].trim()).startsWith('#')) continue;
      } catch {
        continue;
      }
      const abs = wouldDownload(m[2], base);
      if (abs) list.push([abs, 'media']);
    }
    return list;
  };

  /** Downloads a file the record lacks, once, at build time, to its path on the copy. */
  const download = async (abs, kind) => {
    downloads.tried++;
    await mkdir(tmp, { recursive: true });
    let res = await prefetch.take(`${kind}|${abs}`, abs, liftOpts(kind));
    // The network dropped (not the file): wait for it to come back and try once more (createNetworkRetry).
    if (!res.ok && NETWORK_FAILURE_REASONS.has(res.reason) && networkRetry && (await networkRetry.waitBack(abs))) {
      networkRetry.stats.retried++;
      downloads.retried = (downloads.retried ?? 0) + 1;
      res = await fetchImpl(abs, liftOpts(kind));
      if (res.ok) networkRetry.stats.recovered++;
    }
    if (!res.ok) {
      downloads.failed++;
      downloads.failedUrls.push({ url: abs, reason: res.reason });
      return null;
    }
    // A script or stylesheet the original's server answers with an HTML page: the file of the same name the site serves
    // elsewhere, when there is exactly one (codeTwinOf); else it is kept as the original has it, and said so.
    if (CODE_KINDS.has(kind) && isHtmlType(res.mime)) {
      const twin = codeTwinOf(abs, kind);
      if (twin) {
        healed.push({ url: abs, to: twin, kind, reason: 'the original answers this address with an HTML page; the file of the same name it serves elsewhere is used' });
        downloads.ok++;
        return fromRecord(twin, byUrl.get(twin), kind);
      }
      blockers.push({ url: abs, reason: 'the original answers this script or stylesheet with an HTML page (broken on the original too), and no file of its name was found' });
    }
    const local = localPathOf(abs, res.mime, kind);
    const target = path.join(outDir, local);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(res.tmp, target);
    downloads.ok++;
    files.push({ url: abs, local, kind, sha256: res.sha256, from: abs, reason: 'downloaded at build time (not in the network record)' });
    return local;
  };

  /**
   * The local address of one URL the page loads, or null when the page must drop it (an excluded script).
   * @returns {Promise<string|null|undefined>} undefined = not a URL to change
   */
  const localize = async (raw, kind) => {
    const r = await localPathFor(raw, kind);
    // A local path is written as an address (addressOf); an address the copy could not have is kept as the page wrote it.
    return r && typeof r === 'object' ? r.keep : typeof r === 'string' ? addressOf(r) : r;
  };
  /** @returns {Promise<string|null|undefined|{ keep: string }>} the local path (decoded), or the page's own value to keep */
  const localPathFor = async (raw, kind) => {
    if (!raw || /^(data|blob|javascript|#|mailto|tel)/i.test(raw.trim())) return undefined;
    let abs;
    try {
      abs = new URL(raw.trim(), pageUrl).href.split('#')[0];
    } catch {
      return undefined;
    }
    if (excluded.has(abs)) return null;
    const entry = byUrl.get(abs);
    // The record holds an HTML page under a script's or stylesheet's address (a single-page app answering an address it does
    // not have with its own page: ./assets/index-x.js resolved under a sub-folder). Copied as it is, that page is the copy's
    // script, and the page stays blank (sankalpam.ai /yatra/destinations/). The site's own file of that name is used instead.
    if (entry && CODE_KINDS.has(kind) && isHtmlType(entry.type)) {
      const twin = codeTwinOf(abs, kind);
      if (twin) {
        healed.push({ url: abs, to: twin, kind, reason: 'the original answers this address with an HTML page; the file of the same name it serves elsewhere is used' });
        return fromRecord(twin, byUrl.get(twin), kind);
      }
      blockers.push({ url: abs, reason: 'the original answers this script or stylesheet with an HTML page (broken on the original too), and no file of its name was found' });
    }
    if (entry) return fromRecord(abs, entry, kind);
    if (fetch) {
      const local = await download(abs, kind);
      if (local) return local;
    }
    // Not in the record and not served at this address (the original answers its HTML page, or an error), but the site serves
    // a file of the same build-hashed name elsewhere (sankalpam.ai: ./assets/favicon-32x32-R45_galS.png under /yatra/): that one,
    // from the record, else from what an earlier page of this copy already brought in.
    if (!entry) {
      const why = 'the original does not serve this file at this address; the file of the same name it serves elsewhere is used';
      const twin = codeTwinOf(abs, kind);
      if (twin) {
        healed.push({ url: abs, to: twin, kind, reason: why });
        return fromRecord(twin, byUrl.get(twin), kind);
      }
      const earlier = liftedTwinOf(abs);
      if (earlier) {
        healed.push({ url: abs, to: earlier.url, kind, reason: why });
        return earlier.local;
      }
    }
    blockers.push({ url: abs, reason: fetch ? 'not in the record and could not be downloaded' : 'not in the network record' });
    return { keep: raw };
  };

  const LOADED = 'script[src], link[href], img[src], source[src], source[srcset], video[src], video[poster], iframe[src], img[srcset]';
  // What the walk below downloads, in its order: an element's own address, then its srcset, then a poster (an excluded
  // address removes the element, so the rest of it is never asked for).
  const htmlAhead = [];
  for (const el of $(LOADED).toArray()) {
    const node = $(el);
    const tag = el.name;
    const attr = tag === 'link' ? 'href' : 'src';
    const rel = node.attr('rel') ?? '';
    if (tag === 'link' && !/stylesheet|icon|manifest|preload|modulepreload/.test(rel)) continue;
    if (node.attr(attr)) {
      const raw = node.attr(attr);
      let abs = null;
      try {
        abs = raw && !/^(data|blob|javascript|#|mailto|tel)/i.test(raw.trim()) ? new URL(raw.trim(), pageUrl).href.split('#')[0] : null;
      } catch {
        abs = null;
      }
      if (abs && excluded.has(abs)) continue;
      const own = wouldDownload(raw);
      if (own) htmlAhead.push([own, kindOfTag(tag, rel, node.attr('as'))]);
    }
    for (const part of (node.attr('srcset') ?? '').split(',')) {
      const own = node.attr('srcset') ? wouldDownload(part.trim().split(/\s+/)[0]) : null;
      if (own) htmlAhead.push([own, 'media']);
    }
    if (tag === 'video' && node.attr('poster')) {
      const own = wouldDownload(node.attr('poster'));
      if (own) htmlAhead.push([own, 'media']);
    }
  }
  await startAhead(htmlAhead);

  for (const el of $(LOADED).toArray()) {
    const node = $(el);
    const tag = el.name;
    const attr = tag === 'link' ? 'href' : 'src';
    const rel = node.attr('rel') ?? '';
    // A plain link (a feed, an alternate, a canonical) is not loaded: it stays as it is.
    if (tag === 'link' && !/stylesheet|icon|manifest|preload|modulepreload/.test(rel)) continue;
    const kind = kindOfTag(tag, rel, node.attr('as'));
    if (node.attr(attr)) {
      const local = await localize(node.attr(attr), kind);
      if (local === null) {
        removed.push({ url: node.attr(attr), tag, rule: 'excluded script' });
        node.remove();
        continue;
      }
      if (local !== undefined) node.attr(attr, local);
    }
    if (node.attr('srcset')) {
      const parts = [];
      for (const part of node.attr('srcset').split(',')) {
        const [u, ...rest] = part.trim().split(/\s+/);
        const local = await localize(u, 'media');
        if (local) parts.push([local, ...rest].join(' '));
      }
      if (parts.length) node.attr('srcset', parts.join(', ')); else node.removeAttr('srcset');
    }
    if (tag === 'video' && node.attr('poster')) {
      const local = await localize(node.attr('poster'), 'media');
      if (local) node.attr('poster', local);
    }
  }

  // Every file of the record the page can load is copied to its path, not only the ones the HTML names: a runtime imports
  // its own modules by URL, from inside its JavaScript (Framer, Next.js chunks loaded later). Excluded scripts never are.
  const COPIED_KINDS = new Set(['script', 'style', 'font', 'image', 'media']);
  // A file the page fetched as data (an SVG read by script, not by an <img>) is still a file the runtime loads by address.
  const isMediaType = (type) => /^(image|font|video|audio)\//.test(String(type ?? ''));
  for (const entry of byUrl.values()) {
    if (!(COPIED_KINDS.has(entry.kind) || (entry.kind === 'data' && isMediaType(entry.type))) || entry.status !== 200 || excluded.has(entry.url.split('#')[0])) continue;
    const abs = entry.url.split('#')[0];
    if (files.some((f) => f.url === abs)) continue;
    // An HTML page recorded under a code address whose real file the copy uses (codeTwinOf) is not written there: a runtime
    // importing that address would run the page as code.
    if (CODE_KINDS.has(entry.kind) && isHtmlType(entry.type) && codeTwinOf(abs, entry.kind)) continue;
    const local = localPathOf(abs, entry.type, entry.kind);
    const target = path.join(outDir, local);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(recordDir, 'files', entry.sha), target);
    files.push({ url: abs, local, kind: entry.kind, sha256: entry.sha, from: abs, reason: 'a file of the record (the runtime may load it by address)' });
  }
  // A file the original serves in pieces: the record holds the answer to one `?range=a-b` (a runtime reading a binary index
  // in slices; the host answers 200 with exactly those bytes and the runtime checks the length). The slice alone is no use -
  // the next visit asks for another - so the whole file is downloaded once at its bare address and kept when it holds the
  // recorded slice at those offsets (on another site `?range=` may mean anything); the copy then slices it itself
  // (ranged.js: an inline script on a first visit, the service worker later). Its record entry is `data`, which the loop
  // above leaves out on purpose. Skipped ones are reported, never guessed at.
  /** @type {{ files: { url: string, local: string, bytes: number, first: string }[], skipped: { url: string, reason: string }[] }} */
  const ranged = { files: [], skipped: [] };
  for (const entry of byUrl.values()) {
    if (entry.status !== 200 || !entry.sha || excluded.has(entry.url.split('#')[0])) continue;
    const abs = entry.url.split('#')[0];
    const ranges = rangesOf(abs);
    if (!ranges) continue;
    const bare = abs.split('?')[0];
    if (files.some((f) => f.url === bare)) continue;
    if (!fetch) {
      ranged.skipped.push({ url: bare, reason: 'the record holds one slice of it, and downloads are off' });
      continue;
    }
    downloads.tried++;
    await mkdir(tmp, { recursive: true });
    const res = await fetchImpl(bare, { dir: tmp, kind: 'image', maxBytes: RANGED_MAX_BYTES, attempts: LIFT_ATTEMPTS });
    if (!res.ok) {
      downloads.failed++;
      downloads.failedUrls.push({ url: bare, reason: res.reason });
      ranged.skipped.push({ url: bare, reason: `the whole file could not be downloaded: ${res.reason}` });
      continue;
    }
    const whole = await readFile(res.tmp);
    const expected = sliceOf(whole, ranges);
    if (!expected || !expected.equals(await readFile(path.join(recordDir, 'files', entry.sha)))) {
      downloads.failed++;
      ranged.skipped.push({ url: bare, reason: 'the whole file does not hold the recorded slice at those offsets, so the host does not slice it by this query' });
      continue;
    }
    downloads.ok++;
    const local = localPathOf(bare, res.mime ?? entry.type);
    await mkdir(path.dirname(path.join(outDir, local)), { recursive: true });
    await copyFile(res.tmp, path.join(outDir, local));
    files.push({ url: bare, local, kind: 'data', sha256: res.sha256, bytes: whole.length, type: res.mime ?? entry.type ?? null, from: abs, ranged: true, reason: 'a file the original serves in pieces (?range=): kept whole, sliced by the copy' });
    ranged.files.push({ url: bare, local, bytes: whole.length, first: new URL(abs).searchParams.get('range') ?? '' });
  }
  // Inside the copied scripts, every address of a file the copy holds is its local path (raw and JSON-escaped forms).
  const localOf = new Map(files.map((f) => [f.url, addressOf(f.local)]));
  for (const f of files.filter((x) => x.kind === 'script')) {
    const target = path.join(outDir, f.local);
    let text = await readFile(target, 'utf8').catch(() => null);
    if (text === null) continue;
    let changed = false;
    for (const [abs, local] of localOf) {
      if (!text.includes(abs)) continue;
      text = text.split(abs).join(local);
      changed = true;
    }
    for (const [abs, local] of localOf) {
      const escaped = abs.replace(/\//g, '\/');
      if (!text.includes(escaped)) continue;
      text = text.split(escaped).join(local.replace(/\//g, '\/'));
      changed = true;
    }
    if (changed) await writeFile(target, text, 'utf8');
  }

  // A web app manifest names icons the page never loads itself (the browser fetches them for the install prompt): every
  // icon it names is a file the copy uses, so it is copied or downloaded like any other.
  for (const f of files.filter((x) => (x.kind === 'manifest' || x.kind === 'icon') && /\.webmanifest$|\.json$/i.test(x.local))) {
    const manifest = JSON.parse(await readFile(path.join(outDir, f.local), 'utf8').catch(() => 'null') ?? 'null');
    for (const icon of manifest?.icons ?? []) {
      if (!icon?.src) continue;
      await localize(icon.src, 'icon');
    }
  }
  // Stylesheets: their url() references point at the same copies (the record, or a download).
  // What they and the document's own style blocks download is started first (the walks below take the answers in order).
  const cssAhead = [];
  for (const f of files.filter((x) => x.kind === 'style')) cssAhead.push(...cssDownloads(await readFile(path.join(outDir, f.local), 'utf8').catch(() => ''), f.url));
  for (const st of $('style').toArray()) {
    const css = $(st).html() ?? '';
    if (/url\(|@font-face/.test(css)) cssAhead.push(...cssDownloads(css, pageUrl));
  }
  for (const el of $('[style]').toArray()) {
    const style = $(el).attr('style') ?? '';
    if (/url\(/.test(style)) cssAhead.push(...cssDownloads(style, pageUrl));
  }
  await startAhead(cssAhead);
  for (const f of files.filter((x) => x.kind === 'style')) {
    const target = path.join(outDir, f.local);
    const css = await readFile(target, 'utf8');
    await writeFile(target, await rewriteCss(css, f.url), 'utf8');
  }

  async function rewriteCss(css, base) {
    let out = css;
    // @font-face: a face keeps only the sources the record holds (loaded with 200). A source that is not recorded (it 404s
    // or was never loaded) is dropped. A family with no recorded source at all gets its first downloadable candidate.
    for (const block of [...out.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0])) {
      const srcDecl = block.match(/src\s*:([^;]+);/);
      if (!srcDecl) continue;
      const family = (block.match(/font-family\s*:\s*([^;]+);/)?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
      const sources = srcDecl[1].split(/,(?![^(]*\))/).map((e) => e.trim()).filter(Boolean);
      const absOf = (raw) => new URL(raw.trim(), base).href.split('#')[0];
      const kept = [];
      const candidates = [];
      for (const e of sources) {
        // local() is a font on this machine, not a file the page loads: it stays as written.
        if (/^local\(/i.test(e)) {
          kept.push(e);
          continue;
        }
        const m = e.match(/^url\(\s*(['"]?)([^'")]+)\1\s*\)(\s*format\([^)]*\))?/i);
        if (!m) continue;
        const fmt = m[3] ?? '';
        candidates.push({ raw: m[2], fmt });
        const abs = absOf(m[2]);
        const entry = byUrl.get(abs);
        if (entry && !excluded.has(abs)) kept.push(`url("${addressOf(await fromRecord(abs, entry, 'font'))}")${fmt}`);
        else dropped.push({ url: abs, family, reason: entry ? 'excluded' : 'not in the record' });
      }
      let newSrc = kept.length ? kept.join(', ') : null;
      const hasLocal = kept.some((k) => /^local\(/i.test(k));
      // The same font (family, weight, style) the page names at an address the record holds: that file is the face.
      if (!newSrc) {
        const FORMAT = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };
        for (const abs of faceIndex.get(faceKey(block)) ?? []) {
          const entry = byUrl.get(abs);
          if (!entry || excluded.has(abs)) continue;
          const ext = (abs.split(/[?#]/)[0].match(/\.(woff2?|ttf|otf)$/i)?.[1] ?? '').toLowerCase();
          newSrc = `url("${addressOf(await fromRecord(abs, entry, 'font'))}")${FORMAT[ext] ? ` format("${FORMAT[ext]}")` : ''}`;
          matchedBy.push({ family, from: abs });
          break;
        }
      }
      if (!newSrc && fetch) {
        for (const c of candidates) {
          const abs = absOf(c.raw);
          if (excluded.has(abs)) continue;
          const local = await download(abs, 'media');
          if (local) {
            newSrc = `url("${addressOf(local)}")${c.fmt}`;
            break;
          }
        }
      }
      if (!newSrc && !hasLocal) {
        // The family has no file the copy can use: its face is removed (reported), never left pointing at the original.
        out = out.split(block).join('');
        blockers.push({ url: family, reason: 'no file of this font family could be had: the face is removed' });
        continue;
      }
      out = out.split(srcDecl[0]).join(`src: ${newSrc};`);
    }
    // Other url() references (images, fonts outside @font-face): the same copies.
    for (const m of [...out.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]) {
      // A fragment (an SVG reference such as url(#n) or its percent-encoded form) names something inside the document.
      if (/^(data|blob|#|\/)/i.test(m[2].trim()) || decodeURIComponent(m[2].trim()).startsWith('#')) continue;
      const abs = new URL(m[2].trim(), base).href.split('#')[0];
      if (excluded.has(abs)) continue;
      const entry = byUrl.get(abs);
      let local = null;
      if (entry) local = await fromRecord(abs, entry, 'css-asset');
      else if (fetch) local = await download(abs, 'media');
      if (!local) {
        if (sameSite(abs, siteHost)) blockers.push({ url: abs, reason: 'css url not in the record and not downloadable' });
        continue;
      }
      // The copy is served from its root, so the same root-relative path works from any stylesheet.
      out = out.split(m[0]).join(`url("${addressOf(local)}")`);
    }
    return out;
  }

  // Asset addresses written inside a copied script (an image or a font the runtime fetches, which the capture never loaded):
  // each one the record lacks is downloaded at build time (at most JS_ASSET_LIMIT), and the script points at the copy.
  const JS_ASSET = /https:\/\/[a-z0-9.-]+\/[^\s"'`<>()\\]+?\.(?:svg|png|jpe?g|webp|gif|avif|woff2?|ttf|otf|mp4|webm)(?=["'`\s)])/gi;
  let jsDownloads = 0;
  {
    // Started ahead: the same addresses in the same order, up to the same limit.
    const seen = new Set(files.map((x) => x.url));
    const jsAhead = [];
    for (const f of files.filter((x) => x.kind === 'script')) {
      const text = await readFile(path.join(outDir, f.local), 'utf8').catch(() => null);
      if (text === null) continue;
      for (const raw of new Set(text.match(JS_ASSET) ?? [])) {
        const abs = raw.split('#')[0];
        if (excluded.has(abs) || seen.has(abs) || byUrl.has(abs) || jsAhead.length >= JS_ASSET_LIMIT) continue;
        seen.add(abs);
        jsAhead.push([abs, 'image']);
      }
    }
    await startAhead(jsAhead);
  }
  for (const f of files.filter((x) => x.kind === 'script')) {
    const target = path.join(outDir, f.local);
    let text = await readFile(target, 'utf8').catch(() => null);
    if (text === null) continue;
    const found = [...new Set(text.match(JS_ASSET) ?? [])];
    let changed = false;
    for (const raw of found) {
      const abs = raw.split('#')[0];
      if (excluded.has(abs) || files.some((x) => x.url === abs)) continue;
      if (byUrl.has(abs)) continue;
      if (!fetch || jsDownloads >= JS_ASSET_LIMIT) continue;
      jsDownloads++;
      const local = await download(abs, 'image');
      if (!local) continue;
      text = text.split(raw).join(addressOf(local));
      changed = true;
    }
    if (changed) await writeFile(target, text, 'utf8');
  }
  // A runtime often builds an address from a directory and a file name (a base constant plus a name): the directories of
  // the recorded files, two or more levels deep, are rewritten too, so the copy\'s scripts never build an original address.
  const dirPrefixes = new Map();
  for (const f of files) {
    const dir = f.url.slice(0, f.url.lastIndexOf('/') + 1);
    let u;
    try {
      u = new URL(dir);
    } catch {
      continue;
    }
    if (u.pathname.split('/').filter(Boolean).length < 2) continue;
    if (excluded.has(dir)) continue;
    dirPrefixes.set(dir, addressOf(decodeURIComponent(u.pathname)));
  }
  for (const f of files.filter((x) => x.kind === 'script')) {
    const target = path.join(outDir, f.local);
    let text = await readFile(target, 'utf8').catch(() => null);
    if (text === null) continue;
    let changed = false;
    for (const [dir, local] of [...dirPrefixes].sort((a, b) => b[0].length - a[0].length)) {
      if (!text.includes(dir)) continue;
      text = text.split(dir).join(local);
      changed = true;
    }
    if (changed) await writeFile(target, text, 'utf8');
  }
  // The original's host names inside the copied scripts and stylesheets, and in the document's own <style> blocks, become
  // local paths (hostRewrite.js): a runtime that builds an address from a host fragment asks the copy, not the original.
  for (const f of files.filter((x) => x.kind === 'script' || x.kind === 'style')) {
    const target = path.join(outDir, f.local);
    const text = await readFile(target, 'utf8').catch(() => null);
    if (text === null) continue;
    const rewritten = rewriteHosts(text, originHosts);
    if (rewritten.count) await writeFile(target, rewritten.text, 'utf8');
  }
  // A site's robots.txt is read by the page's tooling (Lighthouse\'s SEO checks): it is fetched once, when the copy lacks it.
  if (fetch && !files.some((f) => f.local === '/robots.txt')) {
    await download(new URL('/robots.txt', pageUrl).href, 'icon').catch(() => null);
  }

  // Inline <style> blocks and style="" attributes: the same rules as a stylesheet file (font sources, url() references).
  for (const st of $('style').toArray()) {
    const css = $(st).html() ?? '';
    if (/url\(|@font-face/.test(css)) $(st).html(await rewriteCss(css, pageUrl));
  }
  for (const el of $('[style]').toArray()) {
    const style = $(el).attr('style') ?? '';
    if (/url\(/.test(style)) $(el).attr('style', await rewriteCss(style, pageUrl));
  }
  // The original's host names inside the document's <style> blocks, after their references were resolved above: a host name
  // turned into a path first would be read as a path of the page's own host (the font download went to the wrong server).
  for (const st of $('style').toArray()) {
    const css = $(st).html() ?? '';
    const rewritten = rewriteHosts(css, originHosts);
    if (rewritten.count) $(st).html(rewritten.text);
  }

  // Links to pages of this copy that were selected: the copy's own address for them (a page of a site is one copy of it).
  // Every other link stays as the original wrote it: a page that was not selected is an ordinary link to the original.
  // The keys of pageLinks are the pages' addresses without query or fragment (pageKeyOf in asis.js).
  if (pageLinks.size) {
    for (const a of $('a[href]').toArray()) {
      const raw = String($(a).attr('href') ?? '').trim();
      if (!raw || /^(mailto|tel|javascript|data|#)/i.test(raw)) continue;
      let target;
      try {
        target = new URL(raw, pageUrl);
      } catch {
        continue;
      }
      const local = pageLinks.get(pageKeyOf(target.href));
      if (local) $(a).attr('href', `${local}${target.hash}`);
    }
  }
  // The copy's entry point: the document itself (its inline scripts and data are unchanged).
  await writeFile(path.join(outDir, entry), $.html(), 'utf8');
  // Files the copy renamed for the hosts (a version after the extension, a name with no known extension): every reference
  // to the old name in the copy's text follows the new one, so nothing asks for a name that is no longer there.
  const renames = new Map();
  for (const f of files) {
    if (!f.url) continue;
    const oldName = decodeURIComponent(new URL(f.url).pathname.split('/').pop() ?? '');
    const newName = path.basename(f.local);
    if (oldName && oldName !== newName && !newName.includes('~') && !renames.has(oldName)) renames.set(oldName, newName);
  }
  downloads.renamed = await renameReferences(outDir, renames);
  downloads.renamedFiles = renames.size;
  // Downloads started ahead and never asked for finish before their folder goes.
  await prefetch.settle();
  await rm(tmp, { recursive: true, force: true });
  return { document: { url: doc.url, sha256: doc.sha }, files, removed, blockers, downloads, dropped, matchedBy, ranged, healed, headerPreloads: headerTags.length };
}
