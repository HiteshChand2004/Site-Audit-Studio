// The copy never holds a page's first paint back with more than the original does (pitchlight, 2026-11-14: a "got worse"
// Eliminate render-blocking resources row the copy's files could not explain). Before a copy is packaged, every page is held
// against the same page as lifted (the original's own markup and files, made local: as-is/lifted): the files its first paint
// waits for (a stylesheet, a script in the head that is neither async, deferred nor a module) must be the lifted page's or
// fewer, in the same order, each no larger on the wire (gzip) than the lifted file. A blocking file the copy added after the
// lift is taken out of that page and listed; a file of the original's that grew, or an order that changed, is listed (it is the
// original's own file: never dropped). Everything the copy adds itself is inline, deferred or async, so on a sound copy this
// finds nothing: it is the guard that keeps it so.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';

/** How much larger (gzip) a blocking file of the copy may be than the lifted one: a share, plus a little for small files. */
export const GROW_SHARE = 0.02;
export const GROW_BYTES = 1024;

/** A stylesheet's media that the page's first paint waits for (no media, all, screen); any other list does not block it. */
const blockingMedia = (m) => !m || /^\s*(all|screen)\s*$/i.test(m);
/** A script type a browser runs as a classic script (blocking when it is neither async nor deferred). */
const classicScript = (t) => !t || /^(text|application)\/(javascript|ecmascript|x-javascript)$/i.test(t.trim());

/** The address a reference names, as a root-relative path + query on the page's own site (null for another host or data:). */
function keyOf(ref, outPath) {
  const dir = `/${outPath.split('/').slice(0, -1).join('/')}${outPath.includes('/') ? '/' : ''}`;
  try {
    const u = new URL(ref, `http://copy.invalid${dir}`);
    return u.host === 'copy.invalid' ? `${u.pathname}${u.search}` : u.href;
  } catch {
    return null;
  }
}

/**
 * The files one page's first paint waits for, in document order: { el, kind, ref, key }. A stylesheet link anywhere (not
 * disabled, not an alternate, media that applies), a script with a src in the head that is neither async, deferred nor a module.
 * Nothing inside <template> or <noscript>.
 */
export function blockingRefs($, outPath) {
  const out = [];
  $('link[rel], script[src]').each((_i, el) => {
    if ($(el).closest('template, noscript').length) return;
    const a = el.attribs ?? {};
    if (el.tagName === 'link') {
      const rel = String(a.rel).toLowerCase().split(/\s+/);
      if (!rel.includes('stylesheet') || rel.includes('alternate') || 'disabled' in a || !a.href || !blockingMedia(a.media)) return;
      out.push({ el, kind: 'stylesheet', ref: a.href, key: keyOf(a.href, outPath) });
    } else {
      if ('async' in a || 'defer' in a || !classicScript(a.type) || !$(el).closest('head').length) return;
      out.push({ el, kind: 'script', ref: a.src, key: keyOf(a.src, outPath) });
    }
  });
  return out.filter((r) => r.key);
}

/** The file name of a key (no folder, no query). */
const baseName = (key) => String(key).split('?')[0].split('/').pop().toLowerCase();

/** The gzip size of a file of a folder at a root-relative key, or null (another host, missing). */
async function wireSize(dir, key) {
  if (!key.startsWith('/')) return null;
  let rel;
  try { rel = decodeURIComponent(key.split('?')[0]).replace(/^\/+/, ''); } catch { return null; }
  const file = path.resolve(dir, rel);
  if (!file.startsWith(path.resolve(dir) + path.sep)) return null;
  const body = await readFile(file).catch(() => null);
  return body ? gzipSync(body).length : null;
}

/**
 * Holds every page of the copy against its lifted page and takes out what the copy added that blocks.
 * @param {{ copyDir: string, liftedDir: string, pages: { outPath: string }[], write?: boolean }} o  write: false = report only
 * @returns {Promise<{ pages: number, checked: number, dropped: object[], larger: object[], reordered: object[], missing: string[] }>}
 */
export async function blockingGate({ copyDir, liftedDir, pages, write = true }) {
  const out = { pages: pages.length, checked: 0, dropped: [], larger: [], reordered: [], missing: [] };
  const sizes = new Map();
  const size = async (dir, key) => {
    const k = `${dir}\n${key}`;
    if (!sizes.has(k)) sizes.set(k, await wireSize(dir, key));
    return sizes.get(k);
  };
  for (const p of pages) {
    const file = path.join(copyDir, p.outPath);
    const [html, lifted] = await Promise.all([readFile(file, 'utf8').catch(() => null), readFile(path.join(liftedDir, p.outPath), 'utf8').catch(() => null)]);
    // A page with no lifted counterpart (a notice page the copy wrote) has no original to be held against.
    if (html == null || lifted == null) {
      if (html != null) out.missing.push(p.outPath);
      continue;
    }
    out.checked++;
    const $ = cheerio.load(html);
    const before = blockingRefs(cheerio.load(lifted), p.outPath);
    const after = blockingRefs($, p.outPath);
    const known = new Set(before.map((r) => r.key));
    // One of the original's own files at another address (a host or address rewrite): the same file name is the same file, kept.
    const names = new Set(before.map((r) => baseName(r.key)));
    let changed = false;
    const kept = [];
    for (const r of after) {
      if (known.has(r.key)) { kept.push(r); continue; }
      if (names.has(baseName(r.key))) {
        const same = before.find((o) => baseName(o.key) === baseName(r.key));
        kept.push({ ...r, key: same.key, moved: r.key });
        continue;
      }
      $(r.el).remove();
      changed = true;
      out.dropped.push({ page: p.outPath, kind: r.kind, ref: r.ref, why: 'the copy added it after the lift and the first paint would wait for it; the original\'s does not' });
    }
    // Order: the kept files must be asked for in the order the lifted page asks for them.
    let from = 0;
    for (const r of kept) {
      const at = before.findIndex((o, i) => i >= from && o.key === r.key);
      if (at < 0) { out.reordered.push({ page: p.outPath, ref: r.ref }); break; }
      from = at + 1;
    }
    for (const r of kept) {
      const [a, b] = [await size(copyDir, r.moved ?? r.key), await size(liftedDir, r.key)];
      if (a != null && b != null && a > b * (1 + GROW_SHARE) + GROW_BYTES) out.larger.push({ page: p.outPath, ref: r.ref, kind: r.kind, bytes: a, original: b });
    }
    if (changed && write) await writeFile(file, $.html(), 'utf8');
  }
  return out;
}

/** The warning line of a gate that found something, else null. */
export function blockingWarning(g) {
  if (!g) return null;
  const parts = [];
  if (g.dropped.length) parts.push(`${g.dropped.length} file${g.dropped.length === 1 ? '' : 's'} the copy added would have held a page's first paint back and ${g.dropped.length === 1 ? 'was' : 'were'} taken out (${g.dropped.slice(0, 3).map((d) => `${d.ref} on ${d.page}`).join(', ')})`);
  if (g.larger.length) parts.push(`${g.larger.length} file${g.larger.length === 1 ? '' : 's'} the first paint waits for ${g.larger.length === 1 ? 'is' : 'are'} larger than the original's (${g.larger.slice(0, 3).map((d) => `${d.ref}: ${Math.round(d.bytes / 1024)} KB against ${Math.round(d.original / 1024)} KB`).join(', ')})`);
  if (g.reordered.length) parts.push(`the files the first paint waits for are asked for in another order than the original on ${g.reordered.length} page${g.reordered.length === 1 ? '' : 's'} (${g.reordered.slice(0, 3).map((d) => d.page).join(', ')})`);
  return parts.length ? `Render-blocking files: ${parts.join('; ')}.` : null;
}
