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
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { readRecordIndex, classifyScripts, recordBodyReader } from '../scripts.js';
import { scriptCandidates } from './extract.js';
import { downloadAsset } from '../../assets/download.js';

/** Largest file the lift downloads at build time (bytes). */
export const LIFT_MAX_BYTES = 25 * 1024 * 1024;
/** What the guarded download expects for each kind of file (assets/download.js). */
const DOWNLOAD_KIND = { media: 'media', icon: 'icon', style: 'image', script: 'image' };

/** Attempts per download (the guarded download's own back-off applies between them). */
export const LIFT_ATTEMPTS = 3;

/** The local path (root-relative) of a URL, as the copy serves it. */
export function localPathOf(url) {
  const u = new URL(url);
  const clean = decodeURIComponent(u.pathname);
  return clean.endsWith('/') ? `${clean}index.html` : clean;
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
export async function liftPage({ captureRoot, pageUrl, outDir, fetch = true, fetchImpl = downloadAsset }) {
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

  const classified = await classifyScripts(recordIndex, recordBodyReader(recordDir), { origin: pageUrl });
  const excluded = new Set(scriptCandidates(classified, siteHost).filter((s) => s.status === 'excluded').map((s) => s.url));

  const $ = load(html);
  /** @type {{ url: string, reason: string }[]} */
  const blockers = [];
  /** @type {{ url: string, local: string, kind: string, from: string, reason: string, sha256: string }[]} */
  const files = [];
  const removed = [];
  const downloads = { tried: 0, ok: 0, failed: 0, failedUrls: [] };
  /** @type {{ url: string, family: string, reason: string }[]} font sources the copy does not keep */
  const dropped = [];

  /** Copies one recorded file to its path on the copy. */
  const fromRecord = async (abs, entry, kind) => {
    const local = localPathOf(abs);
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
    const local = localPathOf(abs);
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
  for (const entry of byUrl.values()) {
    if (!COPIED_KINDS.has(entry.kind) || entry.status !== 200 || excluded.has(entry.url.split('#')[0])) continue;
    const abs = entry.url.split('#')[0];
    if (files.some((f) => f.url === abs)) continue;
    const local = localPathOf(abs);
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
  // Inline <style> blocks and style="" attributes: the same rules as a stylesheet file (font sources, url() references).
  for (const st of $('style').toArray()) {
    const css = $(st).html() ?? '';
    if (/url\(|@font-face/.test(css)) $(st).html(await rewriteCss(css, pageUrl));
  }
  for (const el of $('[style]').toArray()) {
    const style = $(el).attr('style') ?? '';
    if (/url\(/.test(style)) $(el).attr('style', await rewriteCss(style, pageUrl));
  }

  // The copy\'s entry point: the document itself (its inline scripts and data are unchanged).
  await writeFile(path.join(outDir, 'index.html'), $.html(), 'utf8');
  await rm(tmp, { recursive: true, force: true });
  return { document: { url: doc.url, sha256: doc.sha }, files, removed, blockers, downloads, dropped };
}
