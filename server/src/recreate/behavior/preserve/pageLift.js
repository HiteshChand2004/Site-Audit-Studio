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

/** Largest file the lift downloads at build time (bytes). */
export const LIFT_MAX_BYTES = 25 * 1024 * 1024;
/** What the guarded download expects for each kind of file (assets/download.js). */
const DOWNLOAD_KIND = { media: 'media', icon: 'icon', style: 'image', script: 'image' };

/** Most assets a page's scripts may name that the record lacks (downloaded at build time). */
export const JS_ASSET_LIMIT = 60;

/** Attempts per download (the guarded download's own back-off applies between them). */
export const LIFT_ATTEMPTS = 3;

/** The extension a file of this content type is saved under (the content, not the address, decides it). */
const EXT_OF_TYPE = { 'image/webp': '.webp', 'image/avif': '.avif', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/svg+xml': '.svg' };

/**
 * The local path (root-relative) of a URL, as the copy serves it. Two addresses of one file that differ only in their query
 * (a responsive variant) are two files: the query's hash is part of the name. The extension follows the content type when
 * the record (or a download) knows it, so a WebP served from a .png address is named .webp.
 */
export function localPathOf(url, type = null) {
  const u = new URL(url);
  let clean = decodeURIComponent(u.pathname);
  if (clean.endsWith('/')) clean += 'index.html';
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
  return clean;
}

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

/** The kind a loading tag gives the file: what the download expects. */
function kindOfTag(tag, rel = '') {
  if (tag === 'script') return 'script';
  if (tag === 'link' && /stylesheet/.test(rel)) return 'style';
  if (tag === 'link' && /icon|manifest/.test(rel)) return 'icon';
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

export async function liftPage({ captureRoot, pageUrl, outDir, fetch = true, fetchImpl = downloadAsset, entry = 'index.html', pageLinks = new Map() }) {
  const recordDir = path.join(captureRoot, '.network');
  const recordIndex = (await readRecordIndex(recordDir)) ?? { entries: [] };
  /** @type {Map<string, any>} */
  const byUrl = new Map();
  for (const e of recordIndex.entries ?? []) if (e.url && e.sha && !e.redirect) byUrl.set(e.url.split('#')[0], e);
  const doc = recordIndex.entries.find((e) => e.kind === 'document' && e.url.split('#')[0] === pageUrl.split('#')[0]) ?? recordIndex.entries.find((e) => e.kind === 'document');
  if (!doc) throw new Error('no document for the page in the record');
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

  /** Copies one recorded file to its path on the copy. */
  const fromRecord = async (abs, entry, kind) => {
    const local = localPathOf(abs, entry.type);
    const target = path.join(outDir, local);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(recordDir, 'files', entry.sha), target);
    files.push({ url: abs, local, kind, sha256: entry.sha, from: abs, reason: 'a file the page loaded (from the network record)' });
    return local;
  };

  /** Downloads a file the record lacks, once, at build time, to its path on the copy. */
  const download = async (abs, kind) => {
    downloads.tried++;
    await mkdir(tmp, { recursive: true });
    const res = await fetchImpl(abs, { dir: tmp, kind: DOWNLOAD_KIND[kind] ?? 'image', maxBytes: LIFT_MAX_BYTES, attempts: LIFT_ATTEMPTS });
    if (!res.ok) {
      downloads.failed++;
      downloads.failedUrls.push({ url: abs, reason: res.reason });
      return null;
    }
    const local = localPathOf(abs, res.mime);
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
    if (!raw || /^(data|blob|javascript|#|mailto|tel)/i.test(raw.trim())) return undefined;
    let abs;
    try {
      abs = new URL(raw.trim(), pageUrl).href.split('#')[0];
    } catch {
      return undefined;
    }
    if (excluded.has(abs)) return null;
    const entry = byUrl.get(abs);
    if (entry) return fromRecord(abs, entry, kind);
    if (fetch) {
      const local = await download(abs, kind);
      if (local) return local;
    }
    blockers.push({ url: abs, reason: fetch ? 'not in the record and could not be downloaded' : 'not in the network record' });
    return raw;
  };

  for (const el of $('script[src], link[href], img[src], source[src], source[srcset], video[src], video[poster], iframe[src], img[srcset]').toArray()) {
    const node = $(el);
    const tag = el.name;
    const attr = tag === 'link' ? 'href' : 'src';
    const rel = node.attr('rel') ?? '';
    // A plain link (a feed, an alternate, a canonical) is not loaded: it stays as it is.
    if (tag === 'link' && !/stylesheet|icon|manifest|preload|modulepreload/.test(rel)) continue;
    const kind = kindOfTag(tag, rel);
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
    const local = localPathOf(abs, entry.type);
    const target = path.join(outDir, local);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(recordDir, 'files', entry.sha), target);
    files.push({ url: abs, local, kind: entry.kind, sha256: entry.sha, from: abs, reason: 'a file of the record (the runtime may load it by address)' });
  }
  // Inside the copied scripts, every address of a file the copy holds is its local path (raw and JSON-escaped forms).
  const localOf = new Map(files.map((f) => [f.url, f.local]));
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
  for (const f of files.filter((x) => x.kind === 'icon' && /\.webmanifest$|\.json$/i.test(x.local))) {
    const manifest = JSON.parse(await readFile(path.join(outDir, f.local), 'utf8').catch(() => 'null') ?? 'null');
    for (const icon of manifest?.icons ?? []) {
      if (!icon?.src) continue;
      await localize(icon.src, 'icon');
    }
  }
  // Stylesheets: their url() references point at the same copies (the record, or a download).
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
        if (entry && !excluded.has(abs)) kept.push(`url("${await fromRecord(abs, entry, 'font')}")${fmt}`);
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
          newSrc = `url("${await fromRecord(abs, entry, 'font')}")${FORMAT[ext] ? ` format("${FORMAT[ext]}")` : ''}`;
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
            newSrc = `url("${local}")${c.fmt}`;
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
      out = out.split(m[0]).join(`url("${local}")`);
    }
    return out;
  }

  // Asset addresses written inside a copied script (an image or a font the runtime fetches, which the capture never loaded):
  // each one the record lacks is downloaded at build time (at most JS_ASSET_LIMIT), and the script points at the copy.
  const JS_ASSET = /https:\/\/[a-z0-9.-]+\/[^\s"'`<>()\\]+?\.(?:svg|png|jpe?g|webp|gif|avif|woff2?|ttf|otf|mp4|webm)(?=["'`\s)])/gi;
  let jsDownloads = 0;
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
      text = text.split(raw).join(local);
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
    dirPrefixes.set(dir, decodeURIComponent(u.pathname));
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
  await rm(tmp, { recursive: true, force: true });
  return { document: { url: doc.url, sha256: doc.sha }, files, removed, blockers, downloads, dropped, matchedBy };
}
