// @ts-check
// The websites Remastly hosts itself (Go live → "Remastly server"), on disk under HOSTING_DIR, written by the app and read by
// the sites server (hosting/server.js, its own process):
//   hosts.json                         every domain answered: { "<host>": { site: "<primary host>", projectId, alias? } }
//   sites/<primary>/releases/<id>/     one folder per deploy: the copy's files as they are served
//   sites/<primary>/current            a link to the release that is live; switched in one step (a deploy, Go back)
//   certs/<host>/                      its HTTPS certificate (hosting/certs.js), read by nginx
//   acme/                              the answers Let's Encrypt asks for while it checks a domain
import { copyFile, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HOSTING_DIR } from '../config/paths.js';

/** Where hosting lives; tests point it elsewhere. */
export const hostingPaths = { root: HOSTING_DIR };

// A host name as Go live checks it (deploy/domain.js parseDomain); checked again here because it becomes a folder name.
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const RELEASE = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {string} host */
function checkHost(host) {
  if (!HOST.test(host)) throw new Error(`Not a host name: ${host}`);
  return host;
}
export const siteDir = (host) => path.join(hostingPaths.root, 'sites', checkHost(host));
const hostsFile = () => path.join(hostingPaths.root, 'hosts.json');

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/** @returns {Promise<Record<string, { site: string, projectId: string, alias?: boolean }>>} */
export async function readHosts() {
  return readFile(hostsFile(), 'utf8').then(JSON.parse, () => ({}));
}

/**
 * Answers `primary` (and `aliases`, which lead to it) for this website, in place of the domains it had before.
 * @param {string} projectId @param {string | null} primary  null = this website answers no domain any more @param {string[]} [aliases]
 */
export async function setHosts(projectId, primary, aliases = []) {
  const hosts = await readHosts();
  for (const [h, v] of Object.entries(hosts)) if (v.projectId === projectId) delete hosts[h];
  if (primary) {
    // A domain another website already answers is not taken from it.
    for (const h of [primary, ...aliases]) {
      checkHost(h);
      if (hosts[h] && hosts[h].projectId !== projectId) throw new Error(`${h} is already a domain of another website on this server.`);
    }
    hosts[primary] = { site: primary, projectId };
    for (const a of aliases) hosts[a] = { site: primary, projectId, alias: true };
  }
  await writeAtomic(hostsFile(), `${JSON.stringify(hosts, null, 2)}\n`);
  return hosts;
}

/**
 * Writes a release (the files of one deploy) and makes it the live one.
 * @param {string} host @param {string} releaseId
 * @param {{ name: string, file?: string, content?: Buffer }[]} entries  as deploy/bundle.js plans them
 */
export async function publishRelease(host, releaseId, entries) {
  if (!RELEASE.test(releaseId)) throw new Error(`Not a release id: ${releaseId}`);
  const dir = path.join(siteDir(host), 'releases', releaseId);
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
  await switchRelease(host, releaseId);
}

/** Makes an existing release the live one, in one step (a link replaced by rename). @param {string} host @param {string} releaseId */
export async function switchRelease(host, releaseId) {
  if (!RELEASE.test(releaseId)) throw new Error(`Not a release id: ${releaseId}`);
  const site = siteDir(host);
  const link = path.join(site, 'current');
  const tmp = `${link}.${randomBytes(4).toString('hex')}.tmp`;
  await symlink(path.join('releases', releaseId), tmp);
  await rename(tmp, link);
}

/** The release that is live, or null. @param {string} host */
export async function currentRelease(host) {
  return readlink(path.join(siteDir(host), 'current')).then((t) => path.basename(t), () => null);
}

/** Removes all but the newest `keep` releases (by the order given) and the live one. @param {string} host @param {string[]} newestFirst @param {number} keep */
export async function pruneReleases(host, newestFirst, keep = 5) {
  const live = await currentRelease(host);
  const wanted = new Set([...newestFirst.slice(0, keep), live]);
  const dir = path.join(siteDir(host), 'releases');
  for (const name of await readdir(dir).catch(() => [])) {
    if (!wanted.has(name)) await rm(path.join(dir, name), { recursive: true, force: true });
  }
}
