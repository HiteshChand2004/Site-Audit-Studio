// @ts-check
// Subresource integrity in a copy. A page may name the hash of a file it loads (`<link rel="stylesheet" integrity="sha384-…">`,
// `<script integrity=…>`), and the browser refuses the file when its bytes do not hash to it. Webflow writes one on its shared
// stylesheet and its scripts. The copy changes those files on purpose (the lift points their url() addresses at the copy's own
// files, a fix may rewrite them), so the hash the page names no longer fits: onfinance.ai's copy was refused its only stylesheet
// and its Webflow script, and every page showed unstyled ("Failed to find a valid digest in the 'integrity' attribute").
//
// The hash stands for "this is the file the page was written for", and the copy's file is that file as the copy serves it: so
// a hash naming a file the copy holds is computed again from the file, with the algorithm the page used. A file the copy does not
// hold (another site's) keeps its hash as written. Only the attribute's value changes; the page is not parsed and written back.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ALGORITHMS = ['sha512', 'sha384', 'sha256'];
/** A <link> or <script> start tag that names an integrity hash. */
const TAG = /<(link|script)\b[^>]*?\sintegrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi;
const attrOf = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};

/**
 * The integrity value for these bytes, with the strongest algorithm the page's value names (sha384 when it names none known).
 * @param {Buffer} bytes @param {string} declared
 */
export function integrityOf(bytes, declared = '') {
  const named = String(declared).split(/\s+/).map((t) => t.split('-')[0].toLowerCase());
  const alg = ALGORITHMS.find((a) => named.includes(a)) ?? 'sha384';
  return `${alg}-${createHash(alg).update(bytes).digest('base64')}`;
}

/** The copy's file an address of a page points at (root-relative, or relative to the page), or null (another host, outside). */
function fileOf(root, pageFile, address) {
  const raw = String(address ?? '').trim();
  if (!raw || /^(data|blob):/i.test(raw) || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(raw)) return null;
  let rel;
  try {
    rel = decodeURIComponent(raw.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const file = rel.startsWith('/') ? path.join(root, rel) : path.join(path.dirname(pageFile), rel);
  const resolved = path.resolve(file);
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`) ? resolved : null;
}

/**
 * One page's text with every integrity hash of a file the copy holds computed from that file.
 * @param {string} html @param {{ root: string, pageFile: string, read: (file: string) => Promise<Buffer|null> }} o
 * @returns {Promise<{ html: string, changed: number, kept: number }>}
 */
export async function withTrueIntegrity(html, { root, pageFile, read }) {
  let changed = 0;
  let kept = 0;
  const tags = [...String(html).matchAll(TAG)].map((m) => m[0]);
  let out = String(html);
  for (const tag of new Set(tags)) {
    const declared = attrOf(tag, 'integrity') ?? '';
    const file = fileOf(root, pageFile, attrOf(tag, /^<link/i.test(tag) ? 'href' : 'src'));
    const bytes = file ? await read(file) : null;
    if (!bytes) {
      kept++;
      continue;
    }
    const value = integrityOf(bytes, declared);
    if (declared.split(/\s+/).includes(value)) continue;
    const next = tag.replace(/(\sintegrity\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `$1"${value}"`);
    out = out.split(tag).join(next);
    changed++;
  }
  return { html: out, changed, kept };
}

/**
 * Every page of a copy folder (its .html files, at any depth) with true integrity hashes (in place).
 * @param {string} dir
 * @returns {Promise<{ pages: number, changed: number }>}
 */
export async function refreshIntegrity(dir) {
  const root = path.resolve(dir);
  const cache = new Map();
  const read = async (file) => {
    if (!cache.has(file)) cache.set(file, await readFile(file).catch(() => null));
    return cache.get(file);
  };
  let pages = 0;
  let changed = 0;
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') await walk(file);
      } else if (/\.html?$/i.test(entry.name)) {
        const text = await readFile(file, 'utf8');
        if (!/\sintegrity\s*=/i.test(text)) continue;
        const r = await withTrueIntegrity(text, { root, pageFile: file, read });
        if (r.changed) {
          await writeFile(file, r.html, 'utf8');
          pages++;
          changed += r.changed;
        }
      }
    }
  };
  await walk(root);
  return { pages, changed };
}
