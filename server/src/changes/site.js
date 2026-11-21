// @ts-check
// Which files a change is made on. The website lives inside Remastly: its latest finished copy (served folder), or, when changes
// were published on top of that copy since, the folder of the newest published change. Every change gets a folder of its own,
// hard-linked from that base (seconds, no extra disk for files it leaves alone); a file the change writes is unlinked first, so
// neither the copy nor an earlier change is ever touched.
import { link, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/index.js';
import { projectDir } from '../config/paths.js';
import { recreateDir } from '../recreate/workspace.js';
import { outputRoot, targetStack } from '../recreate/export/fromIr.js';
import { STATIC_STACKS } from '../deploy/bundle.js';
import { lastPublished } from './store.js';

export class SiteError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 409) {
    super(message);
    this.name = 'SiteError';
    this.status = status;
  }
}

/** The folder of all changes of a website, and of one change's files. */
export const changesRoot = (/** @type {string} */ projectId) => path.join(projectDir(projectId), 'changes');
export const changeSiteDir = (/** @type {string} */ projectId, /** @type {string} */ changeId) => path.join(changesRoot(projectId), changeId, 'site');
export const changeShotsDir = (/** @type {string} */ projectId, /** @type {string} */ changeId) => path.join(changesRoot(projectId), changeId, 'shots');

const host = (/** @type {string} */ u) => {
  try {
    return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** The website a request names: by Remastly id, else by its address's host (www. ignored). @param {{ projectId?: string | null, siteUrl?: string }} s */
export function findProject({ projectId, siteUrl }) {
  if (projectId) return /** @type {any} */ (db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)) ?? null;
  const want = host(siteUrl ?? '');
  if (!want) return null;
  const rows = /** @type {any[]} */ (db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all());
  return rows.find((p) => host(p.url) === want) ?? null;
}

const latestDoneCopy = () => db.prepare(`SELECT id, finished_at, result_json FROM recreates WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL AND removed_at IS NULL ORDER BY started_at DESC LIMIT 1`);

const isDir = async (/** @type {string} */ p) => Boolean((await stat(p).catch(() => null))?.isDirectory());

/**
 * What the next change of a website is made on. Throws SiteError when the website has nothing that can take a change.
 * @param {any} project
 * @returns {Promise<{ recreateId: string, stack: string, report: any, root: string, baseChange: string | null }>}
 */
export async function resolveBase(project) {
  const row = /** @type {any} */ (latestDoneCopy().get(project.id));
  if (!row) throw new SiteError('This website has no finished copy in Remastly yet. Make the copy first (Copy → Copy my site).');
  const report = JSON.parse(row.result_json);
  const stack = targetStack(report, project.stack);
  if (!STATIC_STACKS.has(stack)) throw new SiteError(`The copy is a ${stack} project that needs its own server; changes can only be made on a copy served as files (Plain HTML, React + Vite or Next.js).`);
  const copyRoot = outputRoot(recreateDir(project.id, row.id), report, stack);
  if (!(await isDir(copyRoot))) throw new SiteError('The files of the latest copy are gone from the server. Make the copy again.', 404);
  // Changes published on top of this same copy come along; after a newer copy they do not (it was made from the live site).
  const on = await publishedOnCopy(project.id, row.id);
  if (on) return { recreateId: row.id, stack, report, root: on.dir, baseChange: on.changeId };
  return { recreateId: row.id, stack, report, root: copyRoot, baseChange: null };
}

const publishedOnStmt = () => db.prepare(`SELECT id, page, result_json, published_at FROM change_requests
  WHERE project_id = ? AND base_recreate = ? AND status = 'published' ORDER BY published_at`);
/** The changes published on top of one copy, oldest first (none when the changes tables are not there). */
export function publishedOn(/** @type {string} */ projectId, /** @type {string} */ recreateId) {
  try {
    return /** @type {any[]} */ (publishedOnStmt().all(projectId, recreateId));
  } catch {
    return [];
  }
}
/** The page a change made or changed (its served address), for a person to read. */
const pageOfChange = (/** @type {any} */ row) => {
  try {
    return JSON.parse(row.result_json ?? '{}').servedAt ?? row.page;
  } catch {
    return row.page;
  }
};

/**
 * The website as it stands on a copy: the newest published change made on that copy (its folder holds the copy and every
 * change published on it before, each built on the last), or null when none was (the copy itself). Used for the next change
 * (resolveBase) and for a Go live deploy, so a redeploy keeps the pages Growth OS published. `stack`: only a change made on
 * that stack's files counts (a change is made on one stack's output).
 * @param {string} projectId @param {string} recreateId @param {string | null} [stack]
 * @returns {Promise<null | { changeId: string, dir: string, includes: { id: string, page: string }[] }>}
 */
export async function publishedOnCopy(projectId, recreateId, stack = null) {
  let last;
  try {
    last = lastPublished(projectId);
  } catch {
    return null; // the changes tables are not there yet
  }
  if (!last || last.base_recreate !== recreateId) return null;
  if (stack) {
    let made = 'html';
    try { made = JSON.parse(last.result_json ?? '{}').stack ?? 'html'; } catch { /* the copy's own */ }
    if (made !== stack) return null;
  }
  const dir = changeSiteDir(projectId, last.id);
  if (!(await isDir(dir))) return null;
  const includes = publishedOn(projectId, recreateId).filter((r) => r.published_at <= last.published_at).map((r) => ({ id: r.id, page: pageOfChange(r) }));
  return { changeId: last.id, dir, includes };
}

/**
 * What a deploy of a change's folder is given (deploy/run.js runDeploy `dir` and `report`): the folder holding `site/`, and a
 * report naming `site/` as the stack's finished output. Shared by publishing a change and by a Go live deploy.
 * @param {string} projectId @param {string} changeId @param {string} stack
 */
export function changeDeploySource(projectId, changeId, stack) {
  return {
    dir: path.dirname(changeSiteDir(projectId, changeId)),
    report: { stack, outputs: { [stack]: { status: 'ready', dir: 'site', dist: '' } }, pages: [] },
  };
}

/**
 * The published pages a deploy of `recreateId` would take off the live site: those made on the copy the live site was deployed
 * from, when that is another copy (an older one: a new copy is made from the live site, so it does not have them).
 * @param {string} projectId @param {string | null} liveRecreateId @param {string | null} recreateId
 */
export function droppedChanges(projectId, liveRecreateId, recreateId) {
  if (!liveRecreateId || !recreateId || liveRecreateId === recreateId) return [];
  return publishedOn(projectId, liveRecreateId).map((r) => ({ id: r.id, page: pageOfChange(r) }));
}

/** Hard-links (or copies) every file of `from` into `to`. @param {string} from @param {string} to */
export async function linkTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) await linkTree(a, b);
    else if (entry.isFile()) await link(a, b).catch(() => copyFile(a, b));
  }
}

/** Writes a file of a change's folder without touching the file it may be linked to. @param {string} file @param {string | Buffer} content */
export async function writeFresh(file, content) {
  await rm(file, { force: true });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Every .html file of a folder, as paths relative to it with forward slashes. @param {string} root */
export async function htmlFiles(root) {
  /** @type {string[]} */
  const out = [];
  const walk = async (/** @type {string} */ dir, /** @type {string} */ rel) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile() && /\.html?$/i.test(e.name)) out.push(r);
    }
  };
  await walk(root, '');
  return out.sort();
}

/** The page path a file is served at: "about/index.html" → "/about/", "about.html" → "/about.html". @param {string} rel */
export const servedPath = (rel) => (rel === 'index.html' ? '/' : rel.endsWith('/index.html') ? `/${rel.slice(0, -'index.html'.length)}` : `/${rel}`);

/** The file that serves a page path, or null. @param {string} root @param {string} page */
export async function pageFile(root, page) {
  const p = page.replace(/^\/+/, '');
  const candidates = p === '' ? ['index.html'] : p.endsWith('/') ? [`${p}index.html`] : /\.html?$/i.test(p) ? [p] : [`${p}/index.html`, `${p}.html`];
  for (const c of candidates) {
    if ((await stat(path.join(root, c)).catch(() => null))?.isFile()) return c;
  }
  return null;
}

/** Where a new page is written: always a folder with index.html (works on every static host and in the preview). @param {string} page */
export const newPageFile = (page) => {
  const p = page.replace(/^\/+|\/+$/g, '').replace(/\.html?$/i, '');
  return `${p}/index.html`;
};

/** @param {string} root @param {string} rel */
export const readText = (root, rel) => readFile(path.join(root, rel), 'utf8');
