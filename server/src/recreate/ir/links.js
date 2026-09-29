// Link and asset references of the recreated site.
// - Links to recreated pages become page references (relative paths when emitted).
// - Other same-site links (beyond the page limit, skipped pages, files) keep the original live URL
//   and are listed in the report (Phase 4a decision).
// - Asset URLs resolve to the files of the assets step; a file that was not downloaded is never
//   linked live (the reference is dropped).
import path from 'node:path';
import { sameSite, urlKey } from '../../audit/util.js';
import { assetKey } from '../assets/collect.js';

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
export function createLinkResolver({ pages, livePages = [], skipped = [], origin }) {
  const byKey = new Map(pages.map((p) => [pageKey(p.url), p.outPath]));
  const reasons = new Map();
  for (const p of livePages) reasons.set(pageKey(p.url), p.reason ?? 'beyond-limit');
  for (const s of skipped) reasons.set(pageKey(s.url), s.reason);

  /**
   * @param {string} href     the resolved (absolute) href
   * @param {string} pageUrl  the URL of the page the link is on
   * @returns {{ page: string, hash: string } | { anchor: string } | { live: string, reason: string } | { external: string } | null}
   */
  return function resolve(href, pageUrl) {
    if (!href) return null;
    let u;
    try {
      u = new URL(href, pageUrl);
    } catch {
      return null;
    }
    if (/^(mailto|tel|sms):$/.test(u.protocol)) return { external: u.href };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // javascript:, data:, ... are dropped
    if (!sameSite(u.href, origin)) return { external: u.href };
    const key = pageKey(u.href);
    if (u.hash && key === pageKey(pageUrl)) return { anchor: u.hash };
    const out = byKey.get(key);
    if (out) return { page: out, hash: u.hash };
    return { live: u.href, reason: reasons.get(key) ?? 'not-recreated' };
  };
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
