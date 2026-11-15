// @ts-check
// Content snapshot (Go live): the answers the old app gave to the copy's data calls (a blog list at /api/blogs), saved once,
// so the live copy shows that content without the old server. Only what any visitor gets: each address is asked with GET,
// without cookies, from the original site's own address while it still runs. It is a picture of that moment: content added on
// the old site later is not in it until a new snapshot is taken. A login or a form is never snapshotted (it needs the app).
//
// Kept per website in <projectDir>/snapshot/ (index.json and one file per answer); a deploy ships the files under
// _remastly/snapshot/ and maps each address to its file in _redirects (deploy/bundle.js).
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from '../config/paths.js';
import { fetchPage } from '../audit/http.js';

export const SNAPSHOT_LIMITS = { addresses: 50, bytes: 2 * 1024 * 1024 };
/** Where a deploy puts the files, beside the copy's own. */
export const SNAPSHOT_DIR = '_remastly/snapshot';

const dirOf = (projectId) => path.join(projectDir(projectId), 'snapshot');

/**
 * @param {string} projectId
 * @returns {Promise<{ takenAt: string, items: { address: string, file: string, contentType: string, bytes: number }[], failed: { address: string, why: string }[] } | null>}
 */
export async function readSnapshot(projectId) {
  return readFile(path.join(dirOf(projectId), 'index.json'), 'utf8').then(JSON.parse, () => null);
}

/**
 * Asks the original for each address and keeps the answers that are content (status 200, not a web page: an HTML answer is
 * an error or a login page, not the data asked for). Replaces an earlier snapshot of this website.
 * @param {string} projectId @param {string} origin  the original site's own address @param {string[]} addresses  path + query
 * @param {{ fetch?: typeof fetchPage }} [o]
 */
export async function takeSnapshot(projectId, origin, addresses, { fetch = fetchPage } = {}) {
  const dir = dirOf(projectId);
  const tmp = `${dir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const items = [];
  const failed = [];
  for (const address of addresses.slice(0, SNAPSHOT_LIMITS.addresses)) {
    const res = await fetch(`${origin}${address}`, { maxBytes: SNAPSHOT_LIMITS.bytes, accept: 'application/json, text/plain, */*' });
    const why = res.error ? `could not be reached (${res.error})`
      : res.status !== 200 ? `answered ${res.status}`
      : /text\/html|application\/xhtml/i.test(res.contentType) ? 'answered with a web page, not data' : null;
    if (why) {
      failed.push({ address, why });
      continue;
    }
    const json = /json/i.test(res.contentType);
    const file = `${items.length + 1}.${json ? 'json' : 'txt'}`;
    await writeFile(path.join(tmp, file), /** @type {string} */ (res.body));
    items.push({ address, file, contentType: json ? 'application/json' : 'text/plain', bytes: Buffer.byteLength(/** @type {string} */ (res.body)) });
  }
  const index = { takenAt: new Date().toISOString(), items, failed };
  await writeFile(path.join(tmp, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  // The new snapshot takes the old one's place in one step, so a deploy never reads half of each.
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  return index;
}

/** Removes the website's snapshot (from the next deploy its addresses are no longer answered by it). @param {string} projectId */
export const removeSnapshot = (projectId) => rm(dirOf(projectId), { recursive: true, force: true });

/**
 * What a deploy adds: the files, and one _redirects rule per path. A static host matches a rule by path, not query, so when
 * the copy asked for one path with several queries only the first is served (`shadowed` lists the others).
 * @param {string} projectId
 */
export async function snapshotForDeploy(projectId) {
  const snap = await readSnapshot(projectId);
  if (!snap?.items.length) return null;
  const byPath = new Map();
  const shadowed = [];
  for (const item of snap.items) {
    const p = item.address.split('?')[0];
    if (byPath.has(p)) shadowed.push(item.address);
    else byPath.set(p, item);
  }
  return {
    files: [...byPath.values()].map((i) => ({ name: `${SNAPSHOT_DIR}/${i.file}`, file: path.join(dirOf(projectId), i.file) })),
    redirects: [...byPath].map(([p, i]) => `${p}  /${SNAPSHOT_DIR}/${i.file}  200!`).join('\n'),
    shadowed,
  };
}
