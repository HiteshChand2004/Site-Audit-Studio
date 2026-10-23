// The "Original as-is" copy of a whole selection of pages (CLONER_SPEC): each page is lifted from the capture's network record
// (pageLift.js), its links to the other selected pages point at their copies, the pages are completed together
// (complete.js: one service worker for the site), and the copy is ready to package (pack.js). Pages that were not selected
// stay ordinary links to the original.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { liftPage, pageKeyOf } from './pageLift.js';
import { completeCopy } from './complete.js';
import { readRecordIndex } from '../scripts.js';

/** The pages of an as-is copy: addresses of this project's site, the homepage always among them; null when one is not. */
const AS_IS_MAX_PAGES = 40;
export function asIsPagesOf(project, given) {
  let home;
  try {
    home = new URL(project.url);
  } catch {
    return null;
  }
  const list = Array.isArray(given) ? given.slice(0, AS_IS_MAX_PAGES) : [];
  const pages = [home.href];
  for (const raw of list) {
    let u;
    try {
      u = new URL(String(raw), home);
    } catch {
      return null;
    }
    if (u.hostname.replace(/^www\./, '') !== home.hostname.replace(/^www\./, '')) return null;
    u.hash = '';
    u.search = '';
    pages.push(u.href);
  }
  const seen = new Set();
  return pages.filter((u) => (seen.has(pageKeyOf(u)) ? false : (seen.add(pageKeyOf(u)), true)));
}

/** The copy's address of a page, from the discovery's output path: index.html → "/", about/index.html → "/about/", about.html → "/about.html". */
export function localOfOutPath(outPath) {
  if (outPath === 'index.html') return '/';
  if (outPath.endsWith('/index.html')) return `/${outPath.slice(0, -'index.html'.length)}`;
  return `/${outPath}`;
}

/** The original's hosts a copy must never ask: the record's hosts, minus the ones the lift excluded by rule. */
export async function hostsOfRecord(captureRoot, excludedHosts = []) {
  const index = await readRecordIndex(path.join(captureRoot, '.network')).catch(() => null);
  const hosts = new Set();
  for (const e of index?.entries ?? []) {
    try {
      hosts.add(new URL(e.url).hostname.replace(/^www\./, ''));
    } catch { /* not an address */ }
  }
  for (const h of excludedHosts) hosts.delete(h.replace(/^www\./, ''));
  return [...hosts].filter(Boolean);
}

/**
 * Lifts the selected pages into one copy.
 * @param {object} o
 * @param {string} o.captureRoot   the capture folder (its .network record)
 * @param {{ url: string, outPath: string }[]} o.pages  the selected pages (the homepage first)
 * @param {string} o.siteUrl       the homepage address
 * @param {string} o.outDir        the copy's folder (written in place)
 * @param {import('playwright').Browser} o.browser  for the completion passes
 * @param {string[]} [o.excludedHosts]  hosts excluded by rule (not asked for by the copy)
 * @param {(msg: string) => void} [o.log]
 */
export async function liftSite({ captureRoot, pages, siteUrl, outDir, browser, excludedHosts = [], log = () => {} }) {
  await mkdir(outDir, { recursive: true });
  const pageLinks = new Map(pages.map((p) => [pageKeyOf(p.url), localOfOutPath(p.outPath)]));
  const byLocal = new Map();
  const lifts = [];
  for (const page of pages) {
    const dir = path.dirname(path.join(outDir, page.outPath));
    await mkdir(dir, { recursive: true });
    const lift = await liftPage({ captureRoot, pageUrl: page.url, outDir, entry: page.outPath, pageLinks });
    lifts.push({ url: page.url, path: localOfOutPath(page.outPath), blockers: lift.blockers, downloads: lift.downloads, dropped: lift.dropped, removed: lift.removed, matchedBy: lift.matchedBy });
    for (const f of lift.files) if (!byLocal.has(f.local)) byLocal.set(f.local, f);
    log(`lifted ${page.url} (${lift.files.length} files, ${lift.blockers.length} blockers)`);
  }
  const hosts = await hostsOfRecord(captureRoot, excludedHosts);
  const files = [...byLocal.values()];
  const entries = pages.map((p) => p.outPath);
  const done = await completeCopy({ browser, outDir, pageUrl: siteUrl, hosts, files, entries });
  log(`completed ${entries.length} page(s) in ${done.passes} pass(es), manifest ${Object.keys(done.manifest).length}`);
  return { files, entries, hosts, lifts, completion: { passes: done.passes, manifest: Object.keys(done.manifest).length, log: done.log, sameOrigin: done.sameOrigin, referenced: done.referenced } };
}

/** The lifted document of a page (for the checks and for a reader of the report). */
export async function documentOf(outDir, outPath) {
  return readFile(path.join(outDir, outPath), 'utf8').catch(() => '');
}
