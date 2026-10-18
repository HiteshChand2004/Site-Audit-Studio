// A preload is a request the browser makes before the page needs the file. A copy must not ask for a file it does not hold:
// the request fails (a console error on every visit) and nothing is gained. The original page preloads its responsive images
// through the framework's image optimiser (/_next/image?url=…), which the copy does not have; the saved file the page uses is
// already in the copy. So a preload whose local files are all missing is removed, and a preload with a file that exists is kept.
// Links to other hosts are left alone (the copy keeps them as they were). No network is used here.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const LINK_TAG = /<link\b[^>]*>/gi;

function attrOf(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&');
}

/** The local file a URL names inside the copy, or null when it is not a local file. */
function localFileOf(url, htmlDir, copyDir) {
  const clean = url.trim();
  if (!clean || /^(https?:|\/\/|data:|blob:|javascript:)/i.test(clean)) return null;
  const bare = decodeURIComponent(clean.split('#')[0].split('?')[0]);
  return clean.startsWith('/') ? path.join(copyDir, bare) : path.resolve(htmlDir, bare);
}

const isFile = (p) => existsSync(p) && statSync(p).isFile();

/** The preload links of one page that ask for a local file the copy does not hold. */
export function missingPreloads(html, htmlDir, copyDir) {
  const gone = [];
  for (const tag of html.match(LINK_TAG) ?? []) {
    if (!/\brel\s*=\s*["']?[^"'>]*\bpreload\b/i.test(tag)) continue;
    const srcset = attrOf(tag, 'imagesrcset');
    const href = attrOf(tag, 'href');
    const candidates = srcset !== null
      ? srcset.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)
      : href !== null ? [href] : [];
    if (!candidates.length) continue;
    const local = candidates.map((u) => localFileOf(u, htmlDir, copyDir)).filter((p) => p !== null);
    if (!local.length) continue; // external only: left as it was
    if (local.some(isFile)) continue; // at least one file the page can use is there
    gone.push({ tag, url: candidates[0] });
  }
  return gone;
}

/** Removes the missing preloads from every page of a copy. Returns what was removed, page by page. */
export async function dropMissingPreloads(copyDir) {
  const removed = [];
  const walk = async (rel = '') => {
    for (const e of await readdir(path.join(copyDir, rel), { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (/\.html?$/i.test(e.name)) {
        const file = path.join(copyDir, r);
        const html = await readFile(file, 'utf8');
        const gone = missingPreloads(html, path.dirname(file), copyDir);
        if (!gone.length) continue;
        let next = html;
        for (const g of gone) next = next.replace(g.tag, '');
        await writeFile(file, next, 'utf8');
        for (const g of gone) removed.push({ page: r, url: g.url });
      }
    }
  };
  await walk();
  return removed;
}
