// @ts-check
// Go live → "Run my app on Remastly", for one website: the repository chosen on GitHub, the settings the app needs (kept
// sealed), and the app's box made from them (apps/run.js). Kept per website in <projectDir>/app/:
//   state.json   where it stands, with the settings sealed (never sent to the browser)
//   work/        the code downloaded and unpacked while a version is made; always removed after
// A website has one back office: an app here, or a WordPress box (boxes/), never both; both answer on the port registered for
// the website (hosting/store.js, boxes.json), which the sites server passes "Logins and data" to.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectDir } from '../config/paths.js';
import { readBoxPorts, setBoxPort } from '../hosting/store.js';
import { seal, unseal } from '../deploy/secrets.js';
import { ArchiveError, unpack } from '../boxes/archive.js';
import { BOX_LIMITS, freePort } from '../boxes/index.js';
import { DockerError } from '../boxes/docker.js';
import { AppError, findApp, parseEnvText, repoRoot } from './detect.js';
import { downloadRepository, GitHubError } from './github.js';
import { appRunning, removeApp, runApp } from './run.js';

export { AppError };
export const APP_LIMITS = { settings: 200, valueBytes: 32 * 1024 };
// Settings the box sets itself: a value pasted for them would point the app elsewhere than Remastly listens.
const BOX_SETTINGS = new Set(['PORT', 'HOSTNAME', 'NODE_ENV']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const dirOf = (projectId) => path.join(projectDir(projectId), 'app');
const stateFile = (projectId) => path.join(dirOf(projectId), 'state.json');

/** @returns {Promise<any>} */
const readState = (projectId) => readFile(stateFile(projectId), 'utf8').then(JSON.parse, () => ({ status: 'empty' }));
/** @param {string} projectId @param {any} patch */
async function patchState(projectId, patch) {
  const next = { ...(await readState(projectId)), ...patch };
  const file = stateFile(projectId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return next;
}

/** The settings as kept: names → values. @param {any} state @returns {Record<string, string>} */
const settingsOf = (state) => (state.settings ? JSON.parse(unseal(state.settings)) : {});

/** Apps being made now, by website. @type {Map<string, Promise<void>>} */
const making = new Map();

/**
 * What the card shows: never a setting's value, only which are set.
 * @param {string} projectId
 */
export async function appState(projectId) {
  let state = await readState(projectId);
  if (state.status === 'starting' && !making.has(projectId)) {
    state = await patchState(projectId, { status: (await appRunning(projectId)) ? 'running' : 'failed', step: null, error: 'Remastly restarted while the app was being made. Start it again.' });
  }
  const running = state.status === 'running' ? await appRunning(projectId) : false;
  const set = Object.keys(settingsOf(state));
  const { settings: _sealed, ...shown } = state;
  return {
    ...shown,
    status: state.status === 'running' && !running ? 'stopped' : state.status,
    settingsSet: set,
    // The settings the code reads that have no value yet.
    missing: (state.app?.settings ?? []).map((s) => s.name).filter((n) => !set.includes(n)),
  };
}

/** Whether the website has an app that is meant to run. @param {string} projectId */
export const hasApp = async (projectId) => (await readState(projectId)).status === 'running';

/**
 * Downloads a repository and reads what it needs (nothing is run). Saved as the website's app when Remastly can run it.
 * @param {string} projectId @param {any} ghApp  Remastly's GitHub app (its credentials)
 * @param {{ installationId: number, fullName: string, branch: string }} repo
 */
async function fetchCode(projectId, ghApp, repo) {
  const work = path.join(dirOf(projectId), 'work');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const archive = path.join(work, 'code.tar.gz');
  const { commit } = await downloadRepository(ghApp, repo, archive);
  await unpack(archive, path.join(work, 'code'));
  await rm(archive, { force: true });
  const root = await repoRoot(path.join(work, 'code'));
  return { work, root, commit, app: await findApp(root) };
}

/**
 * The repository the website's app comes from: read now, so the card can list the settings it needs before it runs.
 * @param {string} projectId @param {any} ghApp @param {{ installationId: number, fullName: string, branch: string }} repo
 */
export async function chooseRepo(projectId, ghApp, repo) {
  if (making.has(projectId)) throw new AppError('The app is being made right now. Wait for it to finish.');
  const state = await readState(projectId);
  if (state.status === 'running' && state.repo?.fullName !== repo.fullName) {
    throw new AppError(`This website already runs ${state.repo?.fullName}. Remove that app first to run another repository.`);
  }
  let work;
  try {
    const got = await fetchCode(projectId, ghApp, repo);
    work = got.work;
    const next = await patchState(projectId, {
      status: state.status === 'running' ? 'running' : 'ready', step: null, error: null,
      repo: { ...repo, commit: got.commit }, app: got.app,
    });
    return next;
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Adds settings (a pasted .env, or single values); an empty value removes one.
 * @param {string} projectId @param {{ text?: string, values?: Record<string, string> }} input
 */
export async function setSettings(projectId, { text, values }) {
  const state = await readState(projectId);
  if (state.status === 'empty') throw new AppError('Choose the repository first.');
  const current = settingsOf(state);
  const incoming = { ...(text ? parseEnvText(text) : {}), ...(values ?? {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (!NAME.test(k)) throw new AppError(`"${k}" is not a setting name (letters, digits and _).`);
    if (BOX_SETTINGS.has(k)) continue;
    if (typeof v !== 'string' || Buffer.byteLength(v) > APP_LIMITS.valueBytes) throw new AppError(`The value of ${k} is too long.`);
    if (v === '') delete current[k];
    else current[k] = v;
  }
  if (Object.keys(current).length > APP_LIMITS.settings) throw new AppError(`At most ${APP_LIMITS.settings} settings.`);
  await patchState(projectId, { settings: Object.keys(current).length ? seal(JSON.stringify(current)) : null });
  return appState(projectId);
}

/**
 * Makes the app from the newest code of its branch, in the background (the card follows appState). When a version already
 * runs, it keeps running until the new one answers, and stays when the new one does not.
 * @param {string} projectId @param {any} ghApp @param {{ domain: string }} o
 */
export async function startApp(projectId, ghApp, { domain }) {
  if (making.has(projectId)) throw new AppError('The app is being made right now.');
  const state = await readState(projectId);
  if (!state.repo) throw new AppError('Choose the repository first.');
  const ports = await readBoxPorts();
  if (!ports[projectId] && Object.keys(ports).length >= BOX_LIMITS.boxes) throw new AppError(`This server runs at most ${BOX_LIMITS.boxes} back offices. Ask the owner for room.`);
  const wasRunning = state.status === 'running' && (await appRunning(projectId));
  const port = await freePort(projectId);
  await setBoxPort(projectId, port);
  await patchState(projectId, { status: 'starting', step: 'download', error: null, log: null, startedAt: new Date().toISOString() });
  const step = (s) => patchState(projectId, { step: s }).catch(() => {});

  const job = (async () => {
    let work;
    try {
      const got = await fetchCode(projectId, ghApp, state.repo);
      work = got.work;
      await patchState(projectId, { app: got.app });
      const env = Object.fromEntries(Object.entries(settingsOf(await readState(projectId))).filter(([k]) => !BOX_SETTINGS.has(k)));
      await runApp({ projectId, port, domain, srcDir: got.root, app: got.app, env, onStep: step });
      await patchState(projectId, { status: 'running', step: null, port, readyAt: new Date().toISOString(), repo: { ...state.repo, commit: got.commit }, log: null });
    } catch (e) {
      const known = e instanceof AppError || e instanceof GitHubError || e instanceof DockerError || e instanceof ArchiveError;
      if (!known) console.error(`[app] ${projectId}:`, e);
      const error = known ? /** @type {Error} */ (e).message : 'Something went wrong while the app was made. Try again.';
      const log = /** @type {any} */ (e).tail || null;
      // A version that ran before still runs (run.js put it back): the website keeps working, the update is what failed.
      if (wasRunning && (await appRunning(projectId))) {
        await patchState(projectId, { status: 'running', step: null, error: `The update did not work, so the version before keeps running. ${error}`, log });
      } else {
        await removeApp(projectId).catch(() => {});
        await setBoxPort(projectId, null).catch(() => {});
        await patchState(projectId, { status: 'failed', step: null, error, log });
      }
    } finally {
      if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
      making.delete(projectId);
    }
  })();
  making.set(projectId, job);
  return appState(projectId);
}

/** Removes the app, its files and its settings. @param {string} projectId */
export async function deleteApp(projectId) {
  if (making.has(projectId)) throw new AppError('The app is being made right now. Wait for it to finish.');
  await removeApp(projectId);
  if ((await readState(projectId)).status !== 'empty') await setBoxPort(projectId, null);
  await rm(dirOf(projectId), { recursive: true, force: true });
  return appState(projectId);
}
