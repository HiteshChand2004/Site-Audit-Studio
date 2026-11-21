// @ts-check
// The existing site a build starts from: put in the project folder before the agent writes anything, so changing a site means
// changing its files, not writing a new site around a description of it. Two sources (context.js decides which):
//   files  the owner's own code, uploaded or read from a public GitHub repository (the same files the plan saw);
//   copy   the clean copy of a live site this app made ("Copy my site"): the folder of the copy's output in the build's stack.
// A live site that was never copied has no seed: the agent rebuilds it from what the site shows (<site_content>).
// Only plain files inside the project are written: a path that would leave it, or a build folder (node_modules, dist…), is
// skipped and counted. The copy's own notes (README, DEPLOY, KNOWN-ISSUES) describe the copy, not the site, and are left out.
// The workspace's room is measured from the seed (an existing site may already pass the limits a new one is given), and the
// files' hashes are kept so the run can say which files the agent changed.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { TEXT_FILE, WORKSPACE_LIMITS, listFiles } from './workspace.js';
import { projectFile } from './stacks.js';
import { checkScript, scriptHash } from '../recreate/verify/safety.js';

/** The copy's notes about itself, never part of the site. */
const COPY_NOTES = /^(README|DEPLOY|KNOWN-ISSUES|RECREATE-REPORT)\.md$/i;
/** What the agent may add on top of the existing site. */
export const SEED_HEADROOM = { files: WORKSPACE_LIMITS.files, bytes: WORKSPACE_LIMITS.totalBytes, fileBytes: 100 * 1024 };
const PAGE = /\.html?$/i;
/**
 * A file of a copy that belongs in the project. A copy is a finished site, not source code: its vendor/ folder holds the
 * site's own libraries and fonts (projectFile treats vendor/ as a package folder of source code). Only package folders, the
 * copy's notes about itself and hidden files stay out.
 */
const copyFileKept = (/** @type {string} */ rel) => !/(^|\/)(node_modules|\.[^/]*)(\/|$)/.test(rel) && !COPY_NOTES.test(rel);

/** A relative path from outside as a path inside root, or null when it would leave it. */
export function insideRoot(/** @type {string} */ root, /** @type {unknown} */ rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || /^[a-z]:/i.test(rel)) return null;
  const clean = rel.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((p) => p === '..' || p === '')) return null;
  const abs = path.resolve(root, clean);
  return abs.startsWith(path.resolve(root) + path.sep) ? { abs, rel: clean } : null;
}

const sha = (/** @type {Buffer | string} */ data) => createHash('sha1').update(data).digest('hex');

/**
 * Writes the seed into the (empty) project folder.
 * @param {{ kind: 'files', files: { path: string, content: string }[], from?: string } | { kind: 'copy', dir: string, from?: string, copiedAt?: string } | null | undefined} seed
 * @param {string} siteDir
 * @returns {Promise<null | { kind: string, from: string, files: string[], pages: string[], skipped: number, hashes: Record<string, string>,
 *   room: { files: number, totalBytes: number, fileBytes: number } }>}
 */
export async function placeSeed(seed, siteDir) {
  if (!seed) return null;
  let skipped = 0;
  /** @type {string[]} */
  const written = [];
  const put = async (/** @type {string} */ rel, /** @type {(abs: string) => Promise<void>} */ write) => {
    const at = insideRoot(siteDir, rel);
    if (!at || !(seed.kind === 'copy' ? copyFileKept(at.rel) : projectFile(at.rel))) {
      skipped++;
      return;
    }
    await mkdir(path.dirname(at.abs), { recursive: true });
    await write(at.abs);
    written.push(at.rel);
  };
  if (seed.kind === 'files') {
    for (const f of seed.files ?? []) {
      if (typeof f?.content !== 'string') {
        skipped++;
        continue;
      }
      await put(f.path, (abs) => writeFile(abs, f.content));
    }
  } else if (seed.kind === 'copy') {
    for (const rel of await listFiles(seed.dir)) await put(rel, (abs) => copyFile(path.join(seed.dir, rel), abs));
  } else {
    return null;
  }
  const folded = seed.kind === 'copy' ? await foldVariants(siteDir, written) : 0;
  if (folded) written.splice(0, written.length, ...(await listFiles(siteDir)).filter((f) => written.includes(f)));
  const own = await ownScripts(siteDir, written);
  // Room and hashes from the text files the agent can open.
  /** @type {Record<string, string>} */
  const hashes = {};
  let textFiles = 0;
  let textBytes = 0;
  let largest = 0;
  for (const rel of written) {
    if (!TEXT_FILE.test(rel)) continue;
    const data = await readFile(path.join(siteDir, rel));
    hashes[rel] = sha(data);
    textFiles++;
    textBytes += data.length;
    largest = Math.max(largest, data.length);
  }
  return {
    kind: seed.kind,
    from: seed.from ?? (seed.kind === 'copy' ? 'the copy made in this app' : 'your code'),
    files: written.sort(),
    pages: written.filter((f) => PAGE.test(f)).sort(),
    skipped,
    folded,
    hashes,
    own,
    room: {
      files: Math.max(WORKSPACE_LIMITS.files, textFiles + SEED_HEADROOM.files),
      totalBytes: Math.max(WORKSPACE_LIMITS.totalBytes, textBytes + SEED_HEADROOM.bytes),
      fileBytes: Math.max(WORKSPACE_LIMITS.fileBytes, largest + SEED_HEADROOM.fileBytes),
    },
  };
}

/** A copy's file kept under a second name for an address with a query (pageLift.js localPathOf: `name~<8 hex>.ext`). */
const VARIANT = /^(.*)~[0-9a-f]{8}(\.[a-z0-9]+)?$/i;
const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A copy keeps a file twice when the original asked for it with a query (`landing.css?v=3` → `landing~1a2b3c4d.css` beside
 * `landing.css`). For a site that is going to be changed, two identical files are a trap: the agent edits one and the page
 * loads the other. Each variant whose content is exactly its plain file's is removed, and every reference to it in the
 * site's text files (pages, styles, scripts, the copy's service worker map) is pointed at the plain file. A variant with
 * content of its own stays.
 * @returns {Promise<number>} the variants folded
 */
export async function foldVariants(/** @type {string} */ siteDir, /** @type {string[]} */ files) {
  const have = new Set(files);
  /** @type {Map<string, string>} variant → plain, both relative */
  const renames = new Map();
  for (const rel of files) {
    const m = rel.match(VARIANT);
    if (!m) continue;
    const plain = `${m[1]}${m[2] ?? ''}`;
    if (!have.has(plain)) continue;
    const [a, b] = await Promise.all([readFile(path.join(siteDir, rel)), readFile(path.join(siteDir, plain))]);
    if (a.equals(b)) renames.set(rel, plain);
  }
  if (!renames.size) return 0;
  // A file name is rewritten on its own only where it belongs to one variant; else only its full path is.
  const byName = new Map();
  for (const rel of renames.keys()) byName.set(path.posix.basename(rel), byName.has(path.posix.basename(rel)) ? null : rel);
  const rules = [...renames].map(([from, to]) => [new RegExp(escapeRe(from), 'g'), to]);
  for (const [name, rel] of byName) {
    if (rel) rules.push([new RegExp(`(?<![\\w.~-])${escapeRe(name)}`, 'g'), path.posix.basename(/** @type {string} */ (renames.get(rel)))]);
  }
  for (const rel of files) {
    if (renames.has(rel) || !TEXT_FILE.test(rel)) continue;
    const abs = path.join(siteDir, rel);
    const text = await readFile(abs, 'utf8');
    let next = text;
    for (const [re, to] of rules) next = next.replace(/** @type {RegExp} */ (re), /** @type {string} */ (to));
    if (next !== text) await writeFile(abs, next);
  }
  for (const rel of renames.keys()) await rm(path.join(siteDir, rel), { force: true });
  return renames.size;
}

/** A script element's src as a path from the site's root (the page's folder resolved), or the address itself when it is another site's. */
export function scriptPath(/** @type {string} */ src, /** @type {string} */ pageRel) {
  const s = String(src).trim();
  if (/^([a-z][\w+.-]*:|\/\/)/i.test(s)) return s;
  try {
    return decodeURIComponent(new URL(s, `http://site.invalid/${pageRel}`).pathname);
  } catch {
    return s;
  }
}

/** The key of a script element or handler (verify/safety.js issue `sig`) on a page. */
export function scriptKey(/** @type {{ kind: string, src?: string, hash?: string, name?: string }} */ sig, /** @type {string} */ pageRel) {
  if (sig.kind === 'src') return `src:${scriptPath(/** @type {string} */ (sig.src), pageRel)}`;
  if (sig.kind === 'on') return `on:${sig.name}:${sig.hash}`;
  return `inline:${sig.hash}`;
}

/**
 * The scripts the existing site runs, so the checks can tell them from scripts the agent adds (check.js): every script element
 * and handler of its pages (by src, or by the hash of its text), its script files, and what each of those files already does
 * that the safety scan would refuse in a new one (fetch(), XMLHttpRequest…).
 * @returns {Promise<{ scripts: string[], files: string[], sinks: Record<string, string[]> }>}
 */
export async function ownScripts(/** @type {string} */ siteDir, /** @type {string[]} */ files) {
  const scripts = new Set();
  /** @type {Record<string, string[]>} */
  const sinks = {};
  const scriptFiles = [];
  for (const rel of files) {
    if (PAGE.test(rel)) {
      const $ = load(await readFile(path.join(siteDir, rel), 'utf8'));
      $('script').each((_, el) => {
        if ($(el).parents('svg').length) return;
        scripts.add(scriptKey(el.attribs.src != null ? { kind: 'src', src: el.attribs.src } : { kind: 'inline', hash: scriptHash($(el).text()) }, rel));
      });
      $('*').each((_, el) => {
        for (const [name, value] of Object.entries(el.attribs ?? {})) {
          if (name.toLowerCase().startsWith('on')) scripts.add(scriptKey({ kind: 'on', name: name.toLowerCase(), hash: scriptHash(value) }, rel));
        }
      });
    } else if (/\.m?js$/i.test(rel)) {
      scriptFiles.push(rel);
      const found = checkScript(await readFile(path.join(siteDir, rel), 'utf8')).map((i) => i.detail);
      if (found.length) sinks[rel] = found;
    }
  }
  return { scripts: [...scripts].sort(), files: scriptFiles.sort(), sinks };
}

/**
 * The safety scan's allow rule for a site that started from an existing one (verify/safety.js scanSite allow): a script
 * element or handler the site already had (on any page), a script file of the site's own, and in such a file what it already
 * did. Everything the agent adds is checked as strictly as in a new site.
 * @param {{ own?: { scripts: string[], files: string[], sinks: Record<string, string[]> } } | null | undefined} seeded
 */
export function allowOwnScripts(seeded) {
  const own = seeded?.own;
  if (!own) return null;
  const scripts = new Set(own.scripts);
  const scriptFiles = new Set(own.files);
  return (/** @type {string} */ rel, /** @type {{ type: string, detail: string, sig?: any }} */ issue) => {
    if (issue.type !== 'script') return false;
    if (issue.sig) return scripts.has(scriptKey(issue.sig, rel));
    if (issue.detail === 'unexpected script file') return scriptFiles.has(rel);
    return (own.sinks[rel] ?? []).includes(issue.detail);
  };
}

/** The project's files that are new or changed since the seed was placed (all of them without a seed). */
export async function changedSince(/** @type {string} */ siteDir, /** @type {{ hashes: Record<string, string> } | null} */ seeded, /** @type {string[]} */ files) {
  if (!seeded) return files;
  const placed = new Set(seeded.files);
  const out = [];
  for (const rel of files) {
    if (Object.hasOwn(seeded.hashes, rel)) {
      const now = await readFile(path.join(siteDir, rel)).then(sha, () => null);
      if (now !== seeded.hashes[rel]) out.push(rel);
    } else if (!placed.has(rel)) out.push(rel);
  }
  return out;
}

/** The existing pages no longer in the project. */
export async function missingPages(/** @type {string} */ siteDir, /** @type {{ pages: string[] } | null} */ seeded) {
  if (!seeded?.pages?.length) return [];
  const now = new Set(await listFiles(siteDir));
  return seeded.pages.filter((p) => !now.has(p));
}

/** What the agent is told about the existing site already in its folder. */
export function seedNote(/** @type {{ kind: string, from: string, files: string[], pages: string[] } | null | undefined} */ seeded) {
  if (!seeded) return [];
  const pages = seeded.pages.length ? ` Its pages: ${seeded.pages.slice(0, 40).join(', ')}${seeded.pages.length > 40 ? ` and ${seeded.pages.length - 40} more` : ''}.` : '';
  return [
    `The project folder already holds the existing site (${seeded.files.length} files, from ${seeded.from}).${pages}`,
    'This is a change to that site, not a new one: view the files before you change them, change them with str_replace or insert where you can, and rewrite a whole file with create only when most of it changes.',
    'Keep every existing page, its address and its words unless the brief says otherwise; keep the images and fonts already there. Remove a page only when the brief asks for it.',
    'The site\'s own scripts (its script files, vendor/ libraries, and the script tags and handlers already in its pages, including a copy\'s small helpers such as sw.js) pass the checks as they are: keep them, and do not rewrite them into new scripts. A script you add is checked as strictly as in a new site (a local file under js/, no fetch, eval or inline code).',
  ];
}
