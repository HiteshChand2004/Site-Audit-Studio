// Notice pages for "Copy my site" (Step 7): a link of a copied page to another page of the same site that was not copied
// opens a small local page that says so (recreate/ir/notice.js, the same page the rebuild uses), instead of a 404 in the copy
// or the live original. Files only: no page load, no browser. What decides is the copy's own files, the analysis's saved list
// of links broken on the original, and the copy's robots.txt.
//
// Left as they are: links to copied pages, anchors, mailto / tel / javascript, other sites, files (pdf, images …), pages the
// analysis found broken on the original (the owner fixes or removes those links; a notice page would hide them), and any
// path where the copy already holds a file (nothing is overwritten).
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { noticePage } from '../recreate/ir/notice.js';
import { needsBackend, outPathFor } from '../recreate/discover.js';
import { parseRobots } from '../audit/robots.js';

const A_TAG = /<a\b[^>]*>/gi;
const HREF_IN_TAG = /(\bhref\s*=\s*)(["'])(.*?)\2/i;
// The last part of a path that names a page rather than a file.
const PAGE_EXT = /\.(html?|php|aspx?|jsp)$/i;

const bareHost = (u) => u.hostname.replace(/^www\./, '').toLowerCase();
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/');

/** One key for the same page however its path is written: "/about/", "/about", "/about/index.html" → "/about". */
export function pathKey(pathname) {
  let p = decodeURIComponent(pathname).toLowerCase().replace(/\/index\.html?$/, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

/** The copy's address of a notice page at `outPath` (the form the lift gives copied pages: "/", "/team.html", "/cart/"). */
const localOf = (outPath) => (outPath === 'index.html' ? '/' : outPath.endsWith('/index.html') ? `/${outPath.slice(0, -'index.html'.length)}` : `/${outPath}`);

/** Is this the address of a page (not a file such as a pdf or a picture)? */
function isPagePath(pathname) {
  const last = pathname.split('/').pop() ?? '';
  return !last.includes('.') || PAGE_EXT.test(last);
}

/** Does the file exist? */
const exists = (f) => stat(f).then((s) => s.isFile(), () => false);

/**
 * @param {object} o
 * @param {string} o.dir                         the copy's folder (rewritten in place)
 * @param {{ url: string, outPath: string }[]} o.pages   the copied pages
 * @param {string} o.siteUrl                     the original site's address
 * @param {string[]} [o.brokenOnOriginal]        addresses the analysis found broken on the original (audit.brokenLinks.broken)
 * @param {string|null} [o.siteName]
 * @returns {Promise<{ pages: { path: string, outPath: string, url: string, reason: string, from: string[] }[], links: number,
 *   files: number, left: { url: string, why: string }[] }>}
 */
export async function addNoticePages({ dir, pages, siteUrl, brokenOnOriginal = [], siteName = null }) {
  const site = new URL(siteUrl);
  const host = bareHost(site);
  const copied = new Set();
  for (const p of pages) {
    copied.add(pathKey(new URL(p.url).pathname));
    copied.add(pathKey(localOf(p.outPath)));
  }
  const broken = new Set();
  for (const u of brokenOnOriginal) {
    try {
      const x = new URL(u, site);
      if (bareHost(x) === host) broken.add(pathKey(x.pathname));
    } catch { /* not an address */ }
  }
  const robotsText = await readFile(path.join(dir, 'robots.txt'), 'utf8').catch(() => '');
  const robots = robotsText ? parseRobots(new URL('/robots.txt', site).href, robotsText) : null;

  const notices = new Map(); // outPath → notice
  const left = new Map(); // url → why it keeps its link
  let links = 0;
  let files = 0;
  for (const page of pages) {
    const file = path.join(dir, page.outPath);
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text == null) continue;
    const from = localOf(page.outPath);
    const decide = async (raw) => {
      const value = decode(raw.trim());
      if (!value || /^(#|mailto:|tel:|javascript:|data:|sms:)/i.test(value)) return null;
      let target;
      try {
        target = new URL(value, page.url);
      } catch {
        return null;
      }
      if (!/^https?:$/.test(target.protocol) || bareHost(target) !== host) return null;
      if (!isPagePath(target.pathname)) return null;
      const key = pathKey(target.pathname);
      if (copied.has(key)) return null;
      const url = `${site.origin}${target.pathname}`;
      // "/about/" next to a copied "/about.html" (or the other way round): many hosts serve them as one page, so this is no
      // proof the page is missing. Not guessed either way: the link stays, and the report says why.
      const twin = key.endsWith('.html') ? key.slice(0, -'.html'.length) : `${key}.html`;
      if (key !== '/' && copied.has(twin)) {
        left.set(url, `may be the copied page ${twin} under another address: left as it is`);
        return null;
      }
      if (broken.has(key)) {
        left.set(url, 'broken on the original: the owner fixes or removes the link');
        return null;
      }
      const outPath = outPathFor(target.pathname);
      if (!notices.has(outPath)) {
        if (await exists(path.join(dir, outPath))) {
          left.set(url, `the copy already holds ${outPath}`);
          return null;
        }
        const reason = robots && !robots.isAllowed(url, '*') ? 'robots' : needsBackend(url) ? 'backend' : 'beyond-limit';
        notices.set(outPath, { path: target.pathname, outPath, url, reason, from: new Set() });
      }
      notices.get(outPath).from.add(from);
      return `${localOf(outPath)}${target.hash}`;
    };
    // Only <a> tags, only their href: the rest of the page is written back byte for byte.
    const tags = [...text.matchAll(A_TAG)];
    const replaced = new Map();
    for (const m of tags) {
      const h = m[0].match(HREF_IN_TAG);
      if (!h || replaced.has(m[0])) continue;
      const next = await decide(h[3]);
      if (next) replaced.set(m[0], m[0].replace(HREF_IN_TAG, `$1$2${next}$2`));
    }
    if (!replaced.size) continue;
    const out = text.replace(A_TAG, (tag) => {
      const next = replaced.get(tag);
      if (next) links++;
      return next ?? tag;
    });
    await writeFile(file, out, 'utf8');
    files++;
  }

  const lang = await readFile(path.join(dir, pages[0]?.outPath ?? 'index.html'), 'utf8').then((t) => t.match(/<html\b[^>]*\blang=["']?([A-Za-z-]+)/i)?.[1] ?? null, () => null);
  for (const n of notices.values()) {
    await mkdir(path.dirname(path.join(dir, n.outPath)), { recursive: true });
    await writeFile(path.join(dir, n.outPath), noticePage({ outPath: n.outPath, url: n.url, reason: n.reason, siteName, lang }), 'utf8');
  }
  return {
    pages: [...notices.values()].map((n) => ({ ...n, from: [...n.from].sort() })),
    links,
    files,
    left: [...left].map(([url, why]) => ({ url, why })),
  };
}
