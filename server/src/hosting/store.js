// @ts-check
// The websites Remastly hosts itself (Go live → "Remastly server"), on disk under HOSTING_DIR, written by the app and read by
// the sites server (hosting/server.js, its own process):
//   hosts.json                         every domain answered: { "<host>": { projectId, primary: "<host>", alias?, until? } }
//                                      (until: a domain taken off that is still answered while DNS moves it away)
//   sites/<projectId>/releases/<id>/   one folder per deploy: the copy's files as they are served
//   sites/<projectId>/current          a link to the release that is live; switched in one step (a deploy, Go back)
// Folders are by website, not by domain, so changing a website's domain only changes hosts.json.
//   certs/<host>/                      its HTTPS certificate (hosting/certs.js), read by nginx
//   acme/                              the answers Let's Encrypt asks for while it checks a domain
//   boxes.json                         the port of each website's box, its back office run here (boxes/box.js): { <projectId>: { port } }
import { copyFile, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HOSTING_DIR } from '../config/paths.js';

/** Where hosting lives; tests point it elsewhere. */
export const hostingPaths = { root: HOSTING_DIR };

// A host name as Go live checks it (deploy/domain.js parseDomain); checked again here because it becomes a folder name.
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const RELEASE = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT = /^[0-9a-f-]{36}$/i;

/** @param {string} host */
function checkHost(host) {
  if (!HOST.test(host)) throw new Error(`Not a host name: ${host}`);
  return host;
}
/** @param {string} projectId */
export function siteDir(projectId) {
  if (!PROJECT.test(projectId)) throw new Error(`Not a website id: ${projectId}`);
  return path.join(hostingPaths.root, 'sites', projectId);
}
const hostsFile = () => path.join(hostingPaths.root, 'hosts.json');

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/** @typedef {{ projectId: string, primary: string, alias?: boolean, until?: string }} HostEntry */

/** Every domain answered, those leaving included. @returns {Promise<Record<string, HostEntry>>} */
export async function readHosts() {
  return readFile(hostsFile(), 'utf8').then(JSON.parse, () => ({}));
}

/** Whether an entry still answers: a leaving one until its time. @param {HostEntry | undefined} e */
export const answers = (e) => Boolean(e) && (!e.until || Date.parse(e.until) > Date.now());

/**
 * Answers `primary` (and `aliases`, which lead to it) for this website, in place of the domains it had before.
 * `keepMinutes`: the domains taken off are still answered that long (the DNS is being moved back to the old server, and some
 * visitors still reach this one); a leaving domain is no website's any more.
 * @param {string} projectId @param {string | null} primary  null = this website answers no domain any more @param {string[]} [aliases]
 * @param {{ keepMinutes?: number }} [o]
 */
export async function setHosts(projectId, primary, aliases = [], { keepMinutes = 0 } = {}) {
  const hosts = await readHosts();
  const until = keepMinutes > 0 ? new Date(Date.now() + keepMinutes * 60_000).toISOString() : null;
  for (const [h, v] of Object.entries(hosts)) {
    // Gone by now: forgotten whoever's it was.
    if (!answers(v)) delete hosts[h];
    else if (v.projectId === projectId) {
      if (until && !v.until) hosts[h] = { ...v, until };
      else delete hosts[h];
    }
  }
  if (primary) {
    // A domain another website already answers is not taken from it; one leaving it is.
    for (const h of [primary, ...aliases]) {
      checkHost(h);
      if (hosts[h] && hosts[h].projectId !== projectId && !hosts[h].until) throw new Error(`${h} is already a domain of another website on this server.`);
    }
    hosts[primary] = { projectId, primary };
    for (const a of aliases) hosts[a] = { projectId, primary, alias: true };
  }
  await writeAtomic(hostsFile(), `${JSON.stringify(hosts, null, 2)}\n`);
  return hosts;
}

// The address "Logins and data" passes to when the website's box answers them; the sites server sends it to that website's
// own box, so it never reaches the internet (.invalid is never a real domain).
export const BOX_TARGET = 'http://box.remastly.invalid';
const boxesFile = () => path.join(hostingPaths.root, 'boxes.json');

/** Every running box's port. @returns {Promise<Record<string, { port: number }>>} */
export async function readBoxPorts() {
  return readFile(boxesFile(), 'utf8').then(JSON.parse, () => ({}));
}

/** @param {string} projectId @param {number | null} port  null = the website has no box any more */
export async function setBoxPort(projectId, port) {
  siteDir(projectId);
  const all = await readBoxPorts();
  if (port) all[projectId] = { port };
  else delete all[projectId];
  await writeAtomic(boxesFile(), `${JSON.stringify(all, null, 2)}\n`);
}

/** The domain a website answers at (its primary) and the others that lead to it. @param {string} projectId */
export async function hostsOf(projectId) {
  // A domain leaving the website is not its domain any more (it is only still answered for a while).
  const mine = Object.entries(await readHosts()).filter(([, v]) => v.projectId === projectId && !v.until);
  return { primary: mine.find(([, v]) => !v.alias)?.[0] ?? null, aliases: mine.filter(([, v]) => v.alias).map(([h]) => h) };
}

/**
 * Writes a release (the files of one deploy) and makes it the live one.
 * @param {string} projectId @param {string} releaseId
 * @param {{ name: string, file?: string, content?: Buffer }[]} entries  as deploy/bundle.js plans them
 */
export async function publishRelease(projectId, releaseId, entries) {
  if (!RELEASE.test(releaseId)) throw new Error(`Not a release id: ${releaseId}`);
  const dir = path.join(siteDir(projectId), 'releases', releaseId);
  const tmp = `${dir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  for (const e of entries) {
    const to = path.resolve(tmp, e.name);
    // A name that would leave the release folder is refused (the names come from the copy's own files).
    if (!to.startsWith(`${tmp}${path.sep}`)) throw new Error(`A file name leaves the site's folder: ${e.name}`);
    await mkdir(path.dirname(to), { recursive: true });
    if (e.content) await writeFile(to, e.content);
    else await copyFile(/** @type {string} */ (e.file), to);
  }
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  await switchRelease(projectId, releaseId);
}

/** Makes an existing release the live one, in one step (a link replaced by rename). @param {string} projectId @param {string} releaseId */
export async function switchRelease(projectId, releaseId) {
  if (!RELEASE.test(releaseId)) throw new Error(`Not a release id: ${releaseId}`);
  const site = siteDir(projectId);
  const dir = path.join(site, 'releases', releaseId);
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) throw new Error(`No release ${releaseId}`);
  const link = path.join(site, 'current');
  const tmp = `${link}.${randomBytes(4).toString('hex')}.tmp`;
  await symlink(path.join('releases', releaseId), tmp);
  await rename(tmp, link);
}

/** The release that is live, or null. @param {string} projectId */
export async function currentRelease(projectId) {
  return readlink(path.join(siteDir(projectId), 'current')).then((t) => path.basename(t), () => null);
}

/** Removes all but the newest `keep` releases (by the order given) and the live one. @param {string} projectId @param {string[]} newestFirst @param {number} keep */
export async function pruneReleases(projectId, newestFirst, keep = 5) {
  const live = await currentRelease(projectId);
  const wanted = new Set([...newestFirst.slice(0, keep), live]);
  const dir = path.join(siteDir(projectId), 'releases');
  for (const name of await readdir(dir).catch(() => [])) {
    if (!wanted.has(name)) await rm(path.join(dir, name), { recursive: true, force: true });
  }
}
