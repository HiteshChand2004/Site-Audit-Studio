// @ts-check
// The fix rules every copy of a site gets (copy/fixAsIs.js: titles and descriptions that are missing, too long or repeated,
// structured data, the language, alt text, names of links and buttons, ARIA, the icon, theme colour, sitemap.xml, robots.txt,
// security headers…), run on a built plain-HTML site before it is judged (agent.js createToolbox finish). They are the same
// rules as "Copy my site", without the slow part a copy needs (proving each fix leaves the page looking the same): here the
// site is new or redesigned anyway, and the agent looks at it again and the checks run after them.
// Plain HTML only: an app stack's pages are built from its source, so a fix to its output would be lost at the next build;
// there the agent fixes the source from what audit_site reports.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixAsIsCopy } from '../copy/fixAsIs.js';
import { listFiles } from './workspace.js';

const hashOf = async (/** @type {string} */ file) => createHash('sha1').update(await readFile(file).catch(() => Buffer.alloc(0))).digest('hex');

/**
 * Runs the copy's fix rules on the site in `dir`, in place.
 * @param {{ dir: string, siteUrl?: string | null, siteName?: string | null, fix?: typeof fixAsIsCopy }} o
 *   siteUrl: the original's address (links to it count as the site's own); none for a new site
 * @returns {Promise<{ changed: number, counts: Record<string, number> }>}
 */
export async function polishSite({ dir, siteUrl = null, siteName = null, fix = fixAsIsCopy }) {
  const files = await listFiles(dir);
  const html = files.filter((f) => /\.html?$/i.test(f)).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  if (!html.includes('index.html')) return { changed: 0, counts: {} };
  const base = siteUrl ? new URL(siteUrl).origin : 'https://site.invalid';
  const pages = html.map((rel) => {
    const p = `/${rel.replace(/(^|\/)index\.html$/i, '$1')}`;
    return { outPath: rel, path: p, url: `${base}${p}` };
  });
  const before = new Map(await Promise.all(files.map(async (f) => /** @type {[string, string]} */ ([f, await hashOf(path.join(dir, f))]))));
  const out = await fix({ dir, pages, siteUrl: `${base}/`, siteName });
  let changed = 0;
  for (const f of await listFiles(dir)) if (before.get(f) !== (await hashOf(path.join(dir, f)))) changed++;
  return { changed, counts: out?.counts ?? {} };
}
