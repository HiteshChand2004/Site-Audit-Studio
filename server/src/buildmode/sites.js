// @ts-check
// Saved sites of Build mode: everything an owner did for one site (the description, the plan, their details and edits, where
// they were) is kept here as the app's own state, so leaving the page, closing the tab or a server restart loses nothing; the
// builds started from it are listed with it, so a built site can always be found again. One JSON file per site in
// data/buildmode/sites, written atomically and one write at a time per site. The state is the app's to shape: the server reads
// only the few fields it names a site by.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config/paths.js';

export const SITES_DIR = path.join(DATA_DIR, 'buildmode', 'sites');
// Under the request body limit (1 MB), with room for the request around it.
export const MAX_STATE_BYTES = 900 * 1024;
const MAX_SITES = 200;
// The builds a site keeps listed; older ones leave its list and the normal clean-up of builds removes them.
const KEEP_RUNS = 5;
const ID = /^[0-9a-f-]{36}$/;

export class SiteError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** @type {Map<string, Promise<any>>} the last write of each site, so writes to one file never overlap */
const writing = new Map();

const fileOf = (/** @type {string} */ id) => path.join(SITES_DIR, `${id}.json`);

async function read(/** @type {string} */ id) {
  if (!ID.test(id)) return null;
  return readFile(fileOf(id), 'utf8').then(JSON.parse, () => null);
}

/** Runs `change` on the stored site and writes the result; the site's writes are queued one after another. */
function update(/** @type {string} */ id, /** @type {(site: any) => any} */ change) {
  const next = (writing.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const site = change(await read(id));
    if (!site) return null;
    await mkdir(SITES_DIR, { recursive: true });
    const tmp = `${fileOf(id)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(site));
    await rename(tmp, fileOf(id));
    return site;
  });
  writing.set(id, next);
  next.finally(() => { if (writing.get(id) === next) writing.delete(id); }).catch(() => {});
  return next;
}

/** The app's state of a site, checked: an object, within the size limit. */
function checkState(/** @type {any} */ state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new SiteError('"state" must be an object.');
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) throw new SiteError('This site is too large to save.', 413);
  return state;
}

const owns = (/** @type {any} */ site, /** @type {string | null} */ ownerId) => Boolean(site) && (site.ownerId ?? null) === (ownerId ?? null);

const text = (/** @type {any} */ v) => (typeof v === 'string' ? v.trim() : '');
const cut = (/** @type {string} */ s, /** @type {number} */ n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** What the owner calls the site: the business name they gave, else the first line of what they asked for. */
export function siteName(/** @type {any} */ state) {
  const name = text(state?.details?.name);
  if (name) return cut(name, 80);
  const first = text(state?.draft?.description).split('\n')[0].replace(/^(a|an|the) (new )?(website|site) for (my |our )?/i, '').replace(/[.:;,!]+$/, '');
  return first ? cut(first.charAt(0).toUpperCase() + first.slice(1), 80) : 'Untitled site';
}

// The app's steps: start (describe) → review (the plan, where the build is started) → build. 'ready' is the step a site was
// saved at before the Review and Ready screens became one; it reads as 'build'.
const STEPS = ['start', 'review', 'build'];

/** A site as a list shows it (no state). */
export function summarize(/** @type {any} */ site) {
  const s = site.state ?? {};
  const step = s.step === 'ready' ? 'build' : s.step;
  return {
    id: site.id,
    name: siteName(s),
    step: STEPS.includes(step) ? step : 'start',
    summary: cut(text(s.plan?.brief?.summary) || text(s.draft?.description), 240),
    siteType: text(s.plan?.understanding?.site_type) || null,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    runs: site.runs ?? [],
  };
}

/** Saves a new site for its owner. */
export async function createSite(/** @type {{ ownerId?: string | null, state: any }} */ { ownerId = null, state }) {
  checkState(state);
  const now = new Date().toISOString();
  const site = { id: randomUUID(), ownerId, createdAt: now, updatedAt: now, state, runs: [] };
  await update(site.id, () => site);
  return site;
}

/** Replaces a site's state; null when it does not exist or is another owner's. */
export async function saveSite(/** @type {string} */ id, /** @type {string | null} */ ownerId, /** @type {any} */ state) {
  checkState(state);
  return update(id, (site) => (owns(site, ownerId) ? { ...site, state, updatedAt: new Date().toISOString() } : null));
}

/** A site with its state, for its owner. */
export async function getSite(/** @type {string} */ id, /** @type {string | null} */ ownerId) {
  await writing.get(id)?.catch(() => {});
  const site = await read(id);
  return owns(site, ownerId) ? site : null;
}

/** Every site of an owner (the latest MAX_SITES), the one worked on last first. */
export async function listSites(/** @type {string | null} */ ownerId) {
  const files = (await readdir(SITES_DIR).catch(() => [])).filter((f) => f.endsWith('.json'));
  const sites = await Promise.all(files.map((f) => read(f.slice(0, -5))));
  return sites.filter((s) => owns(s, ownerId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_SITES);
}

/** Records a build started from a site (newest last); false when the site is not the owner's. */
export async function attachRun(/** @type {string} */ id, /** @type {string | null} */ ownerId, /** @type {string} */ runId) {
  const site = await update(id, (s) => (owns(s, ownerId) ? { ...s, runs: [...(s.runs ?? []).filter((r) => r !== runId), runId].slice(-KEEP_RUNS), updatedAt: new Date().toISOString() } : null));
  return Boolean(site);
}

/** Removes a site with its photos and logo (images.js); its build ids, so the caller can remove them too, or null when it is not the owner's. */
export async function deleteSite(/** @type {string} */ id, /** @type {string | null} */ ownerId) {
  const site = await getSite(id, ownerId);
  if (!site) return null;
  await rm(fileOf(id), { force: true });
  await rm(path.join(SITES_DIR, id), { recursive: true, force: true });
  return site.runs ?? [];
}

/** The builds no clean-up may remove: every build a saved site lists. */
export async function keptRuns() {
  const files = (await readdir(SITES_DIR).catch(() => [])).filter((f) => f.endsWith('.json'));
  const sites = await Promise.all(files.map((f) => read(f.slice(0, -5))));
  return new Set(sites.flatMap((s) => s?.runs ?? []));
}
