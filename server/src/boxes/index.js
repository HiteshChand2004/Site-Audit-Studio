// @ts-check
// Go live → "Move logins and data to Remastly", for one website: the backup files the owner uploads, then the box made from
// them (boxes/box.js), and what the card shows. Kept per website in <projectDir>/box/:
//   state.json      where it stands (with the box's own database password, never sent to the browser)
//   uploads/        the files as uploaded; removed once the box runs (they hold the users' passwords, scrambled)
//   work/           the backup unpacked while the box is made; always removed after
// Which port each running box answers on is written for the sites server too (hosting/store.js, boxes.json).
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { projectDir } from '../config/paths.js';
import { readBoxPorts, setBoxPort } from '../hosting/store.js';
import { ArchiveError, kindOf, unpack } from './archive.js';
import { DetectError, findWordPress } from './detect.js';
import { boxRunning, makeBox, removeBox } from './box.js';
import { DockerError } from './docker.js';

const MB = 1024 * 1024;
export const BOX_LIMITS = {
  uploadBytes: (Number(process.env.SAS_BOX_UPLOAD_MB) || 8192) * MB,
  files: 4,
  // Boxes on this server at a time: each holds a database and a web server in memory.
  boxes: Number(process.env.SAS_MAX_BOXES) || 5,
  firstPort: Number(process.env.SAS_BOX_FIRST_PORT) || 4200,
};
// What a WordPress site's logins and accounts need from its back office; the copy has its pages.
export const WORDPRESS_PATHS = ['/wp-login.php', '/wp-admin/*', '/wp-json/*', '/wp-includes/*', '/wp-comments-post.php'];

export class BoxError extends Error {}

const dirOf = (projectId) => path.join(projectDir(projectId), 'box');
const stateFile = (projectId) => path.join(dirOf(projectId), 'state.json');
const uploadsDir = (projectId) => path.join(dirOf(projectId), 'uploads');

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** @returns {Promise<any>} */
const readState = (projectId) => readFile(stateFile(projectId), 'utf8').then(JSON.parse, () => ({ status: 'empty' }));
/** @param {string} projectId @param {any} patch */
async function patchState(projectId, patch) {
  const next = { ...(await readState(projectId)), ...patch };
  await writeJson(stateFile(projectId), next);
  return next;
}

/** The lowest port no other box (or app, apps/) has; the website's own when it has one. @param {string} projectId */
export async function freePort(projectId) {
  const all = await readBoxPorts();
  if (all[projectId]) return all[projectId].port;
  const taken = new Set(Object.values(all).map((b) => b.port));
  let port = BOX_LIMITS.firstPort;
  while (taken.has(port)) port += 1;
  return port;
}

/** The uploaded files, as the card lists them. @param {string} projectId */
async function uploadsOf(projectId) {
  const dir = uploadsDir(projectId);
  const names = await readdir(dir).catch(() => []);
  const out = [];
  for (const name of names.sort()) {
    const s = await stat(path.join(dir, name)).catch(() => null);
    if (s?.isFile() && !name.endsWith('.part')) out.push({ name, bytes: s.size, kind: kindOf(name) });
  }
  return out;
}

/** Boxes being made now, by website: one at a time each. @type {Map<string, Promise<void>>} */
const making = new Map();

/**
 * What the card shows (never the box's password).
 * @param {string} projectId
 */
export async function boxState(projectId) {
  let state = await readState(projectId);
  // Made by a Remastly that has stopped since: it will not finish.
  if (state.status === 'starting' && !making.has(projectId)) {
    state = await patchState(projectId, { status: 'failed', step: null, error: 'Remastly restarted while the box was being made. Start it again.' });
  }
  const running = state.status === 'running' ? await boxRunning(projectId) : false;
  const { secret: _secret, ...shown } = state;
  return { ...shown, status: state.status === 'running' && !running ? 'stopped' : state.status, files: await uploadsOf(projectId) };
}

/** Whether the website has a box that is meant to run (for "Logins and data" and the sites server). @param {string} projectId */
export async function hasBox(projectId) {
  return (await readState(projectId)).status === 'running';
}

/**
 * Saves one uploaded file (the request body, streamed to disk under its own name).
 * @param {string} projectId @param {string} rawName @param {NodeJS.ReadableStream} body @param {number} declared  its content-length
 */
export async function addUpload(projectId, rawName, body, declared) {
  const name = path.basename(String(rawName ?? '')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (!name || !kindOf(name)) throw new BoxError('Upload the backup as .tar.gz, .zip or .tar, and the database as .sql or .sql.gz.');
  if (making.has(projectId)) throw new BoxError('The box is being made right now. Wait for it to finish.');
  const files = await uploadsOf(projectId);
  if (files.length >= BOX_LIMITS.files && !files.some((f) => f.name === name)) throw new BoxError(`At most ${BOX_LIMITS.files} files. Remove one first.`);
  if (declared > BOX_LIMITS.uploadBytes) throw new BoxError(`The file is larger than ${BOX_LIMITS.uploadBytes / 1024 / MB} GB.`);
  const dir = uploadsDir(projectId);
  await mkdir(dir, { recursive: true });
  const part = path.join(dir, `${name}.part`);
  let bytes = 0;
  try {
    await pipeline(body, async function* limit(source) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > BOX_LIMITS.uploadBytes) throw new BoxError(`The file is larger than ${BOX_LIMITS.uploadBytes / 1024 / MB} GB.`);
        yield chunk;
      }
    }, createWriteStream(part, { mode: 0o600 }));
  } catch (e) {
    await rm(part, { force: true });
    throw e instanceof BoxError ? e : new BoxError('The upload stopped before the end. Try again.');
  }
  if (!bytes) {
    await rm(part, { force: true });
    throw new BoxError('The file is empty.');
  }
  await rename(part, path.join(dir, name));
  const state = await readState(projectId);
  if (state.status === 'empty' || state.status === 'failed') await patchState(projectId, { status: 'ready', error: null });
  return boxState(projectId);
}

/** @param {string} projectId @param {string} name */
export async function removeUpload(projectId, name) {
  if (making.has(projectId)) throw new BoxError('The box is being made right now. Wait for it to finish.');
  const safe = path.basename(name);
  await rm(path.join(uploadsDir(projectId), safe), { force: true });
  const state = await readState(projectId);
  if (state.status === 'ready' && !(await uploadsOf(projectId)).length) await patchState(projectId, { status: 'empty' });
  return boxState(projectId);
}

/**
 * Makes the box from the uploaded files, in the background (the card follows boxState).
 * @param {string} projectId @param {{ domain: string, replace?: boolean }} o  domain = the website's own (the site answers to it)
 */
export async function startBox(projectId, { domain, replace = false }) {
  if (making.has(projectId)) throw new BoxError('The box is being made right now.');
  const state = await readState(projectId);
  // A running box holds what people did on it since; it is only replaced when the owner said so.
  if (state.status === 'running' && !replace) throw new BoxError('This website already has a box. Replacing it deletes everything people did on it since it started.');
  const files = await uploadsOf(projectId);
  if (!files.length) throw new BoxError('Upload the backup first.');
  const ports = await readBoxPorts();
  if (!ports[projectId] && Object.keys(ports).length >= BOX_LIMITS.boxes) throw new BoxError(`This server runs at most ${BOX_LIMITS.boxes} boxes. Ask the owner for room.`);

  const port = await freePort(projectId);
  // Taken now, so a box another website starts meanwhile gets another port.
  await setBoxPort(projectId, port);
  const secret = state.secret ?? randomBytes(24).toString('base64url');
  await patchState(projectId, { status: 'starting', step: 'unpack', error: null, secret, startedAt: new Date().toISOString(), site: null });
  const work = path.join(dirOf(projectId), 'work');
  const step = (s) => patchState(projectId, { step: s }).catch(() => {});

  const job = (async () => {
    try {
      await rm(work, { recursive: true, force: true });
      const roots = [];
      for (const [i, f] of files.entries()) {
        if (f.kind === 'sql') continue;
        const dir = path.join(work, String(i));
        await unpack(path.join(uploadsDir(projectId), f.name), dir);
        roots.push(dir);
      }
      await step('find');
      const site = await findWordPress({ roots, uploads: files.filter((f) => f.kind === 'sql').map((f) => path.join(uploadsDir(projectId), f.name)), domain });
      const made = await makeBox({ projectId, port, secret, domain, workDir: work, site, onStep: step });
      const warnings = [];
      const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
      if (made.home && hostOf(made.home) !== domain.replace(/^www\./, '')) warnings.push(`The backup is of ${made.home}, not ${domain}. WordPress will send visitors there.`);
      if (site.version && Number(site.version.split('.')[0]) < 6) warnings.push(`This WordPress is old (${site.version}) and may not work fully with PHP 8.2.`);
      await patchState(projectId, {
        status: 'running', step: null, port, readyAt: new Date().toISOString(),
        site: { kind: site.kind, version: site.version, database: site.db.name, users: made.users, home: made.home, warnings },
      });
      // The box has the data now; the uploads hold the same users (and their scrambled passwords), so they go.
      await rm(uploadsDir(projectId), { recursive: true, force: true });
    } catch (e) {
      const known = e instanceof ArchiveError || e instanceof DetectError || e instanceof DockerError;
      if (!known) console.error(`[box] ${projectId}:`, e);
      await removeBox(projectId).catch(() => {});
      await setBoxPort(projectId, null).catch(() => {});
      await patchState(projectId, { status: 'failed', step: null, error: known ? /** @type {Error} */ (e).message : 'Something went wrong while the box was made. Try again.' });
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
      making.delete(projectId);
    }
  })();
  making.set(projectId, job);
  return boxState(projectId);
}

/** Removes the box, its data and the uploads. @param {string} projectId */
export async function deleteBox(projectId) {
  if (making.has(projectId)) throw new BoxError('The box is being made right now. Wait for it to finish.');
  await removeBox(projectId);
  await setBoxPort(projectId, null);
  await rm(dirOf(projectId), { recursive: true, force: true });
  return boxState(projectId);
}
