// Link and asset references of the recreated site.
// - Links to recreated pages become page references (relative paths when emitted).
// - Other same-site links never lead back to the original site: a linked file the assets step downloaded is served
//   locally, everything else (login / cart pages, pages that failed, beyond the safety cap) opens a local notice page at
//   the same path (ir/notice.js). Listed in the report.
// - Asset URLs resolve to the files of the assets step; a file that was not downloaded is never
//   linked live (the reference is dropped).
import path from 'node:path';
import { sameSite, urlKey } from '../../audit/util.js';
import { assetKey } from '../assets/collect.js';
import { outPathFor } from '../discover.js';

// www.example.com and example.com are one site (like sameSite), so their URLs share a key.
const pageKey = (url) => {
  const u = new URL(url);
  u.hostname = u.hostname.replace(/^www\./, '');
  return urlKey(u.href);
};

/**
 * @param {object} o
 * @param {{ url: string, outPath: string }[]} o.pages   recreated pages
 * @param {{ url: string, reason?: string }[]} o.livePages  eligible pages that were not recreated
 * @param {{ url: string, reason: string }[]} o.skipped  discovery skips
 * @param {string} o.origin
 */
export function createLinkResolver({ pages, livePages = [], skipped = [], origin, assetFile = () => null }) {
  const byKey = new Map(pages.map((p) => [pageKey(p.url), p.outPath]));
  const outPaths = new Set(pages.map((p) => p.outPath));
  const reasons = new Map();
  for (const p of livePages) reasons.set(pageKey(p.url), p.reason ?? 'beyond-limit');
  for (const s of skipped) reasons.set(pageKey(s.url), s.reason);
  // Notice pages the links need: outPath → { url, reason } (ir/notice.js; written by buildIR).
  const notices = new Map();

  /**
   * @param {string} href     the resolved (absolute) href
   * @param {string} pageUrl  the URL of the page the link is on
   * @returns {{ page: string, hash: string } | { anchor: string } | { asset: string } | { file: string, hash: string, url: string, reason: string }
   *   | { external: string } | null}
   */
  function resolve(href, pageUrl) {
    if (!href) return null;
    let u;
    try {
      u = new URL(href, pageUrl);
    } catch {
      return null;
    }
    if (/^(mailto|tel|sms):$/.test(u.protocol)) return { external: u.href };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // javascript:, data:, ... are dropped
    if (!sameSite(u.href, origin)) {
      // A file on another host the assets step downloaded (a PDF on the platform's CDN) is served locally.
      const file = assetFile(u.href);
      return file ? { asset: file } : { external: u.href };
    }
    const key = pageKey(u.href);
    if (u.hash && key === pageKey(pageUrl)) return { anchor: u.hash };
    const out = byKey.get(key);
    if (out) return { page: out, hash: u.hash };
    // A query-string variant of a recreated page opens that page.
    if (u.search) {
      const bare = new URL(u.href);
      bare.search = '';
      const page = byKey.get(pageKey(bare.href));
      if (page) return { page, hash: u.hash };
    }
    // A linked file (PDF, document, image, video) that was downloaded is served from the new site.
    const file = assetFile(u.href);
    if (file) return { asset: file };
    // Not part of the copy: a local notice page at the same path, never the live original site.
    const reason = reasons.get(key) ?? 'not-recreated';
    const notice = outPathFor(u.pathname);
    if (outPaths.has(notice)) return { page: notice, hash: u.hash };
    if (!notices.has(notice)) notices.set(notice, { url: u.href, reason });
    return { file: notice, hash: '', url: u.href, reason };
  }
  resolve.notices = notices;
  return resolve;
}

/** Relative link from one generated page to another; folders keep their original "/about/" form. */
export function relPage(fromOut, toOut) {
  const fromDir = path.posix.dirname(fromOut);
  if (toOut === 'index.html' || toOut.endsWith('/index.html')) {
    const dir = toOut === 'index.html' ? '.' : toOut.slice(0, -'/index.html'.length);
    const rel = path.posix.relative(fromDir, dir);
    return rel ? `${rel}/` : './';
  }
  return path.posix.relative(fromDir, toOut);
}

/** Relative path from a generated file to a site file ("assets/images/x.png"). */
export const relFile = (fromOut, file) => path.posix.relative(path.posix.dirname(fromOut), file) || path.posix.basename(file);

/** Resolves an asset URL (absolute or relative to `base`) to its downloaded file, or null. */
export function createAssetResolver(map) {
  return (url, base) => {
    if (!url) return null;
    let abs;
    try {
      abs = new URL(url, base).href;
    } catch {
      return null;
    }
    const key = assetKey(abs);
    return (key && map[key]) || null;
  };
}
