// @ts-check
// What goes live: exactly the folder the preview and the comparison serve (export/fromIr.js outputRoot), as one zip with the
// site at its root (index.html at the top, our _headers / _redirects beside it). Nothing of the project around it: no capture,
// report, README, package files or dotfiles. A packaged Next.js copy keeps the original's /_next files in next-assets/ and only
// next.config rewrites map them back (behavior/preserve/nextAssets.js); a static host applies no such rule, so they go into the
// zip at _next/, where the pages ask for them.
import { createWriteStream } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from '../config/paths.js';
import { outputRoot, reportOutputs } from '../recreate/export/fromIr.js';
import { writeZip, ZIP_MAX_BYTES, ZIP_MAX_FILES } from '../recreate/export/zip.js';
import { NEXT_ASSETS_DIR } from '../recreate/behavior/preserve/nextAssets.js';

export class DeployError extends Error {
  /** @param {string} message  safe to show @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.name = 'DeployError';
    this.status = status;
  }
}

/** Stacks whose copy is static files any host can serve. MERN's forms need its own Node server and a database. */
export const STATIC_STACKS = new Set(['html', 'react-vite', 'nextjs']);
// Files a packaged project keeps next to the site for the person who downloads it, never pages of the site.
const PROJECT_NOTES = new Set(['README.md', 'DEPLOY.md', 'KNOWN-ISSUES.md', 'RECREATE-REPORT.md', 'package.json', 'package-lock.json']);
const STORED = /\.(?:webp|png|jpe?g|gif|avif|woff2?|mp4|webm|mov|mp3|m4a|ogg|zip|gz|br|ico)$/i;

/** Every regular file under `root` (no dotfiles, no links): [{ rel, abs, size }], sorted. */
async function listFiles(root) {
  /** @type {{ rel: string, abs: string, size: number }[]} */
  const out = [];
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(abs, rel);
      else if (entry.isFile()) out.push({ rel, abs, size: (await lstat(abs)).size });
    }
  }
  await walk(root, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * The files of a finished copy's output, as they will be served: [{ name, file, size, store }] with `name` the path on the site.
 * Throws DeployError (message safe to show) when this output cannot go on a static host.
 * `redirects`: rules that go first in the site's _redirects (Go live Step 3: the paths passed to the old app), before the copy's own.
 * `extraFiles`: files added beside the copy's own (the content snapshot: { name on the site, file on disk }).
 * `formsEndpoint`: where the copy's forms send (Form entries: this website's address at Remastly), written into its
 * sas-forms.json; null leaves the copy's own setting as it is.
 * @param {{ dir: string, report: any, stack: string, redirects?: string | null, formsEndpoint?: string | null, extraFiles?: { name: string, file: string }[] }} o
 */
export async function planDeploy({ dir, report, stack, redirects = null, formsEndpoint = null, extraFiles = [] }) {
  const out = reportOutputs(report)[stack];
  if (out?.status !== 'ready') throw new DeployError(`This copy has no finished ${stack} version to deploy.`);
  if (!STATIC_STACKS.has(stack)) {
    throw new DeployError('A MERN copy needs its own Node server and a MongoDB database, so it cannot go on Netlify as plain files. Download it and host it on a Node host, or deploy the plain HTML, React or Next.js version.');
  }
  const root = outputRoot(dir, report, stack);
  if (!(await stat(root).catch(() => null))?.isDirectory()) throw new DeployError('The files of this copy are gone from the server (old copies are cleaned up). Make the copy again.', 404);
  const files = await listFiles(root);
  const pages = new Set((report.pages ?? []).map((p) => p.outPath).filter(Boolean));
  const kept = files.filter((f) => !(PROJECT_NOTES.has(f.rel) && !pages.has(f.rel)));
  if (!kept.some((f) => f.rel === 'index.html')) throw new DeployError('This copy has no homepage (index.html) in its built files, so there is nothing to show at the site\'s address.');
  // A packaged Next.js copy: its /_next files where a static host serves them (only when the copy has no _next/ of its own).
  const moveNext = stack === 'nextjs' && !kept.some((f) => f.rel.startsWith('_next/')) && kept.some((f) => f.rel.startsWith(`${NEXT_ASSETS_DIR}/`));
  const entries = kept.map((f) => ({
    name: moveNext && f.rel.startsWith(`${NEXT_ASSETS_DIR}/`) ? `_next/${f.rel.slice(NEXT_ASSETS_DIR.length + 1)}` : f.rel,
    file: f.abs,
    size: f.size,
    store: STORED.test(f.rel),
  }));
  for (const f of extraFiles) entries.push({ name: f.name, file: f.file, size: (await stat(f.file)).size, store: false });
  if (redirects) {
    const at = entries.findIndex((e) => e.name === '_redirects');
    const own = at >= 0 ? await readFile(entries[at].file, 'utf8') : '';
    const content = Buffer.from(`# Remastly, Go live: the content snapshot, then the paths passed to the old app\n${redirects}\n${own ? `\n${own}` : ''}`);
    const entry = { name: '_redirects', content, size: content.length, store: false };
    if (at >= 0) entries[at] = /** @type {any} */ (entry);
    else entries.push(/** @type {any} */ (entry));
  }
  if (formsEndpoint) {
    const at = entries.findIndex((e) => e.name === 'sas-forms.json');
    if (at >= 0) {
      const own = await readFile(entries[at].file, 'utf8').then(JSON.parse, () => ({}));
      const content = Buffer.from(`${JSON.stringify({ ...own, endpoint: formsEndpoint }, null, 2)}\n`);
      entries[at] = /** @type {any} */ ({ name: 'sas-forms.json', content, size: content.length, store: false });
    }
  }
  const bytes = entries.reduce((n, e) => n + e.size, 0);
  if (entries.length > ZIP_MAX_FILES) throw new DeployError(`This copy has ${entries.length} files; a deploy is limited to ${ZIP_MAX_FILES}.`, 413);
  if (bytes > ZIP_MAX_BYTES) throw new DeployError(`This copy is ${Math.round(bytes / 1048576)} MB; a deploy is limited to ${Math.round(ZIP_MAX_BYTES / 1048576)} MB.`, 413);
  return { entries, bytes, files: entries.length, movedNextAssets: moveNext };
}

/**
 * Writes the planned files into a zip in the temp folder. The caller removes it with `done()`.
 * @param {{ entries: { name: string, file: string, size: number, store: boolean }[] }} plan
 */
export async function zipToTemp(plan) {
  const folder = await mkdtemp(path.join(tempDir(), 'sas-deploy-'));
  const file = path.join(folder, 'site.zip');
  try {
    await writeZip(plan, createWriteStream(file));
    return { path: file, size: (await stat(file)).size, done: () => rm(folder, { recursive: true, force: true }) };
  } catch (err) {
    await rm(folder, { recursive: true, force: true });
    throw err;
  }
}
