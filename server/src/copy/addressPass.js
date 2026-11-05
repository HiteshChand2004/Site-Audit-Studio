// The address pass at download (Step 6): the new site's address written into a finished as-is copy that was made without one.
// It works on a fresh copy of the finished copy's folder (the finished copy is never changed) and writes only what an address
// decides, with the same code the full fix stage uses (copy/fixAsIs.js applyAddress, addressFiles):
//   pages  canonical, og:url (moved or added), og:image / twitter:image (moved when the copy holds the file)
//   files  sitemap.xml, robots.txt, llms.txt
// Then it proves the result before anything is packaged:
//   1. every page is the same as before once those four tags are left out of both sides (so nothing a visitor sees changed:
//      only <link> and <meta> tags in the head did, which are never painted);
//   2. every other file of the copy is byte for byte the same (only the three site files may change or appear);
//   3. every address written names the new site and a page or file the copy holds; every sitemap entry, too, and robots.txt
//      points at the new sitemap.
// A failed proof puts the folder back exactly as the finished copy is, and says why: the copy then names no address, and the
// rows that need one stay "Needs information from you". No browser and no page load: files only.
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { ADDRESS_TAGS, addressFiles, applyAddress } from './fixAsIs.js';
import { emptyCounts } from './fixRegistry.js';

/** The site files an address may write or create. */
export const ADDRESS_SITE_FILES = new Set(['sitemap.xml', 'robots.txt', 'llms.txt']);

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const bareHost = (h) => String(h ?? '').toLowerCase().replace(/^www\./, '');

/** Every file under `dir`, as its path from `dir` (forward slashes) → sha256 of its bytes. */
async function hashes(dir) {
  const out = new Map();
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    out.set(path.relative(dir, file).split(path.sep).join('/'), createHash('sha256').update(await readFile(file)).digest('hex'));
  }
  return out;
}

/** A page's HTML with the address tags left out (for the proof: what must not change). */
function withoutAddressTags(html) {
  const $ = cheerio.load(html);
  for (const t of ADDRESS_TAGS) $(t.selector).remove();
  return $.html();
}

/**
 * @param {object} o
 * @param {string} o.fromDir     the finished copy (read only)
 * @param {string} o.dir         where the addressed copy is made (emptied first)
 * @param {{ path: string, outPath: string, url?: string }[]} o.pages  the copy's pages, homepage first
 * @param {string} o.siteUrl     the original's address
 * @param {string} o.newSiteUrl  the new site's address, already checked and confirmed (copy/address.js addressForCopy)
 * @param {string|null} [o.siteName]
 * @param {{ afterWrite?: (dir: string) => Promise<void> }} [o.hooks]  tests only: runs after the writes, before the proof
 * @returns {Promise<{ ok: boolean, origin: string, why?: string, pages: object[], files: object|null, counts: object, open: object[] }>}
 */
export async function addressPass({ fromDir, dir, pages, siteUrl, newSiteUrl, siteName = null, hooks = {} }) {
  const origin = new URL(newSiteUrl).origin;
  const siteHost = bareHost(new URL(siteUrl).hostname);
  await rm(dir, { recursive: true, force: true });
  await cp(fromDir, dir, { recursive: true });
  const before = await hashes(dir);

  const docs = [];
  for (const p of pages) {
    const html = await readFile(path.join(dir, p.outPath), 'utf8').catch(() => null);
    if (html != null) docs.push({ ...p, html, $: cheerio.load(html) });
  }
  const byPath = new Map();
  for (const d of docs) {
    byPath.set(d.path, d.outPath);
    byPath.set(d.path.replace(/\/$/, '') || '/', d.outPath);
  }
  const name = siteName || clean(docs[0]?.$('meta[property="og:site_name"]').attr('content')) || siteHost;

  const result = [];
  const open = [];
  const counts = emptyCounts();
  for (const d of docs) {
    const { $ } = d;
    const fixes = [];
    const { own } = applyAddress($, d, { dir, siteHost, newOrigin: origin, byPath, fixes, open });
    d.head = { title: clean($('title').first().text()), description: clean($('meta[name="description"]').attr('content')), canonical: own };
    if (fixes.length) await writeFile(path.join(dir, d.outPath), $.html(), 'utf8');
    for (const f of fixes) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    result.push({ path: d.path, outPath: d.outPath, fixes });
  }
  const files = await addressFiles({ dir, docs, newOrigin: origin, siteName: name, siteUrl });
  await hooks.afterWrite?.(dir);

  const why = await prove({ dir, docs, before, origin, byPath, result });
  if (why) {
    await rm(dir, { recursive: true, force: true });
    await cp(fromDir, dir, { recursive: true });
    return { ok: false, origin, why, pages: [], files: null, counts: emptyCounts(), open: [] };
  }
  return { ok: true, origin, pages: result, files, counts, open };
}

/** Why the addressed copy is not what an address may change (null: it is). */
async function prove({ dir, docs, before, origin, byPath, result }) {
  // 1. Pages: the same once the address tags are left out of both sides.
  for (const d of docs) {
    const now = await readFile(path.join(dir, d.outPath), 'utf8').catch(() => null);
    if (now == null) return `${d.outPath} is gone`;
    if (withoutAddressTags(now) !== withoutAddressTags(d.html)) return `${d.outPath} changed outside its address tags`;
  }
  // 2. Every other file: the same bytes; only the site files may change or appear; nothing disappears.
  const pageFiles = new Set(docs.map((d) => d.outPath.split(path.sep).join('/')));
  const after = await hashes(dir);
  for (const [rel, hash] of before) {
    if (!after.has(rel)) return `${rel} is gone`;
    if (after.get(rel) !== hash && !pageFiles.has(rel) && !ADDRESS_SITE_FILES.has(rel)) return `${rel} changed`;
  }
  for (const rel of after.keys()) if (!before.has(rel) && !ADDRESS_SITE_FILES.has(rel)) return `${rel} appeared`;
  // 3. Every address written names the new site and something the copy holds.
  const page = (href) => {
    const u = new URL(href);
    if (u.origin !== origin) return false;
    const p = decodeURIComponent(u.pathname);
    return byPath.has(p) || byPath.has(p.replace(/\/$/, '') || '/');
  };
  const file = (href) => {
    const u = new URL(href);
    return u.origin === origin && after.has(decodeURIComponent(u.pathname).replace(/^\/+/, ''));
  };
  for (const r of result) {
    for (const f of r.fixes) {
      const ok = f.field.endsWith(':image') ? file(f.value) : page(f.value);
      if (!ok) return `the ${f.field} written on ${r.path} (${f.value}) does not name a page or file of the copy on ${origin}`;
    }
  }
  const sitemap = await readFile(path.join(dir, 'sitemap.xml'), 'utf8').catch(() => '');
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  for (const loc of locs) if (!page(loc)) return `sitemap.xml lists ${loc}, which is not a page of the copy on ${origin}`;
  const robots = await readFile(path.join(dir, 'robots.txt'), 'utf8').catch(() => '');
  if (!robots.split(/\r?\n/).some((l) => l.trim() === `Sitemap: ${origin}/sitemap.xml`)) return 'robots.txt does not point at the new sitemap';
  return null;
}
