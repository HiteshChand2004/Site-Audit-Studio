// @ts-check
// "Run my app on Remastly" API (apps/).
//   GET    /api/github                 Remastly's GitHub app (made or not, and by the owner only, how to make it) and this
//                                       person's GitHub (who, which installations)
//   POST   /api/github/setup           owner only: the form that asks GitHub to make Remastly's app ({ action, manifest })
//   POST   /api/github/connect { returnTo, install? }   where to send the person: GitHub's sign-in, or the page to pick repositories
//   GET    /api/github/repos           the repositories the app may read for this person
//   DELETE /api/github                 forget this person's GitHub (their code on GitHub is untouched)
//   GET    /api/github/created, /api/github/callback   where GitHub sends the browser back (githubReturnRouter: mounted
//                                       before the API's own checks, since GitHub's page is another site; each answer only
//                                       counts in the browser that started it, by a one-time cookie)
//   GET    /api/projects/:id/app       the card: GitHub, the repository, what the app needs, its state
//   POST   /api/projects/:id/app/repo { installationId, fullName, branch }   choose the repository (read now, nothing runs)
//   PUT    /api/projects/:id/app/settings { text?, values? }   the settings (a pasted .env, or single values; "" removes one)
//   POST   /api/projects/:id/app/start   make (or update to the newest code) the app (202; GET follows it)
//   POST   /api/projects/:id/app/use     send "Logins and data" to the app: its paths, and every address the copy has no file for
//   DELETE /api/projects/:id/app         remove the app, its files and settings
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { db } from '../db/index.js';
import { isOwner } from '../accounts/roles.js';
import { cookieSecure, publicOrigin } from '../config/index.js';
import { connectionToken, deployReady, getConnection, MIGRATE_HINT, ownerKeyOf, REMASTLY, removeConnection, saveConnection } from '../deploy/store.js';
import { readPassThrough, savePassThrough } from '../deploy/passThrough.js';
import { BOX_TARGET, hostsOf } from '../hosting/store.js';
import { boxState } from '../boxes/index.js';
import { dockerAvailable } from '../boxes/docker.js';
import { boxSetup } from '../boxes/setup.js';
import { appManifest, authorizeUrl, convertManifest, githubConfig, GitHubError, installationsOf, installUrl, repositoriesOf } from '../apps/github.js';
import { AppError, appState, chooseRepo, deleteApp, hasApp, setSettings, startApp } from '../apps/index.js';

const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');

/** 503 with the migration hint when the connections table is missing. */
function notReady(res) {
  if (deployReady()) return false;
  res.status(503).json({ error: MIGRATE_HINT, needsMigration: true });
  return true;
}

/** Remastly's GitHub app, as GitHub handed it over; null until the owner made it. @returns {any} */
const githubApp = () => {
  const t = connectionToken(REMASTLY, 'github-app');
  return t ? JSON.parse(t) : null;
};
/** This person's GitHub: who, and the installations of the app they can reach. @param {any} req @returns {{ login: string, installations: { id: number, account: string }[] } | null} */
const githubOf = (req) => {
  const t = connectionToken(ownerKeyOf(req), 'github');
  return t ? JSON.parse(t) : null;
};

// ---- one round trip to GitHub and back ----

/** Started round trips, by their state: who started it and where they go back to. Forgotten after 10 minutes. */
const pending = new Map();
const STATE_MS = 10 * 60_000;
const COOKIE = 'sas_github';

/** A new round trip; the browser keeps its state in a cookie, so the way back only counts there. @param {any} res @param {any} trip */
function startTrip(res, trip) {
  for (const [k, v] of pending) if (Date.now() - v.at > STATE_MS) pending.delete(k);
  const state = randomBytes(24).toString('base64url');
  pending.set(state, { ...trip, at: Date.now() });
  res.setHeader('Set-Cookie', [`${COOKIE}=${state}`, 'Path=/api/github', 'HttpOnly', 'SameSite=Lax', ...(cookieSecure() ? ['Secure'] : []), `Max-Age=${STATE_MS / 1000}`].join('; '));
  return state;
}

/** The round trip this way back belongs to, once: only with the same state in the query and in this browser's cookie. @param {any} req @param {any} res */
function endTrip(req, res) {
  const state = String(req.query.state ?? '');
  const cookie = String(req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/api/github; HttpOnly; SameSite=Lax; Max-Age=0`);
  const trip = pending.get(state);
  pending.delete(state);
  if (!trip || !cookie || cookie !== state || Date.now() - trip.at > STATE_MS) return null;
  return trip;
}

/** Where the app was when the person left for GitHub (only an address of Remastly itself). @param {unknown} v */
const returnOf = (v) => {
  const app = `${publicOrigin()}/app/`;
  return typeof v === 'string' && v.startsWith(`${publicOrigin()}/`) && !/[\r\n]/.test(v) ? v : app;
};
/** @param {string} to @param {Record<string, string>} q */
const withQuery = (to, q) => {
  const u = new URL(to);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
};

// ---- GitHub's way back (no session: the cookie and the state say whose it is) ----

export const githubReturnRouter = Router();

githubReturnRouter.get('/created', async (req, res) => {
  const trip = endTrip(req, res);
  if (!trip || trip.kind !== 'create') return res.redirect(302, withQuery(`${publicOrigin()}/app/`, { github: 'error', message: 'This GitHub setup was not started here, or took longer than 10 minutes. Start it again.' }));
  try {
    const app = await convertManifest(String(req.query.code ?? ''));
    saveConnection({ ownerKey: REMASTLY, provider: 'github-app', token: JSON.stringify(app), accountName: app.slug, accountEmail: app.htmlUrl });
    res.redirect(302, withQuery(trip.returnTo, { github: 'ready' }));
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    res.redirect(302, withQuery(trip.returnTo, { github: 'error', message: err.message }));
  }
});

githubReturnRouter.get('/callback', async (req, res) => {
  const trip = endTrip(req, res);
  const back = trip?.returnTo ?? `${publicOrigin()}/app/`;
  // Installed from GitHub's own page (no round trip of ours): the person signs in from the card, which proves who they are.
  if (!trip || trip.kind !== 'connect') return res.redirect(302, withQuery(back, { github: req.query.installation_id ? 'installed' : 'error', ...(!req.query.installation_id && { message: 'This GitHub connection was not started here, or took longer than 10 minutes. Start it again.' }) }));
  const app = githubApp();
  if (!app) return res.redirect(302, withQuery(back, { github: 'error', message: 'GitHub is not set up on this Remastly.' }));
  try {
    const { login, installations } = await installationsOf(app, String(req.query.code ?? ''));
    saveConnection({ ownerKey: trip.ownerKey, provider: 'github', token: JSON.stringify({ login, installations }), accountName: login });
    res.redirect(302, withQuery(back, { github: 'connected' }));
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    res.redirect(302, withQuery(back, { github: 'error', message: err.message }));
  }
});

// ---- GitHub, for the signed-in person ----

export const githubRouter = Router();

/** What the app shows of GitHub. @param {any} req */
function githubStatus(req) {
  const app = githubApp();
  const mine = githubOf(req);
  return {
    ready: Boolean(app),
    canSetUp: isOwner(req),
    app: app ? { slug: app.slug, ...(isOwner(req) && { htmlUrl: app.htmlUrl }) } : null,
    connected: mine ? { login: mine.login, installations: mine.installations } : null,
  };
}

githubRouter.get('/', (req, res) => {
  if (notReady(res)) return;
  res.json(githubStatus(req));
});

githubRouter.post('/setup', (req, res) => {
  if (notReady(res)) return;
  if (!isOwner(req)) return res.status(403).json({ error: 'Only the owner can set up GitHub for Remastly.', forbidden: 'owner' });
  const org = typeof req.body?.org === 'string' ? req.body.org.trim() : '';
  if (org && !/^[A-Za-z0-9-]{1,39}$/.test(org)) return res.status(400).json({ error: 'That is not a GitHub organization name.' });
  const state = startTrip(res, { kind: 'create', ownerKey: ownerKeyOf(req), returnTo: returnOf(req.body?.returnTo) });
  // The browser posts the manifest to GitHub itself (GitHub's page asks the owner to confirm, then sends them back here).
  const page = org ? `${githubConfig.web}/organizations/${org}/settings/apps/new` : `${githubConfig.web}/settings/apps/new`;
  res.json({ action: `${page}?${new URLSearchParams({ state })}`, manifest: JSON.stringify(appManifest(publicOrigin())) });
});

githubRouter.post('/connect', (req, res) => {
  if (notReady(res)) return;
  const app = githubApp();
  if (!app) return res.status(409).json({ error: isOwner(req) ? 'Set up GitHub for Remastly first.' : 'GitHub is not set up on this Remastly yet. Ask its owner.' });
  const state = startTrip(res, { kind: 'connect', ownerKey: ownerKeyOf(req), returnTo: returnOf(req.body?.returnTo) });
  res.json({ url: req.body?.install ? installUrl(app, state) : authorizeUrl(app, state, publicOrigin()) });
});

githubRouter.get('/repos', async (req, res) => {
  if (notReady(res)) return;
  const app = githubApp();
  const mine = githubOf(req);
  if (!app || !mine) return res.status(409).json({ error: 'Connect GitHub first.' });
  const repos = [];
  const problems = [];
  for (const i of mine.installations) {
    try {
      for (const r of await repositoriesOf(app, i.id)) repos.push({ ...r, installationId: i.id, account: i.account });
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      problems.push(`${i.account}: ${err.message}`);
    }
  }
  res.json({ repos, problems });
});

githubRouter.delete('/', (req, res) => {
  if (notReady(res)) return;
  removeConnection(ownerKeyOf(req), 'github');
  res.json(githubStatus(req));
});

// ---- the website's app ----

export const appsRouter = Router();

/** The domain the app answers to: the live site's, else the original's. @param {any} project */
const domainOf = async (project) => (await hostsOf(project.id)).primary ?? new URL(project.url).hostname;

/** What the card shows. @param {any} project @param {any} req */
async function appCard(project, req) {
  const available = await dockerAvailable();
  const passThrough = await readPassThrough(project.id);
  return {
    available,
    setup: !available && isOwner(req) ? boxSetup({ user: os.userInfo().username }) : null,
    github: deployReady() ? githubStatus(req) : null,
    app: await appState(project.id),
    domain: await domainOf(project),
    usedForLogins: passThrough?.target === BOX_TARGET && passThrough.fallback === true,
  };
}

/** An AppError or GitHubError as the card shows it. @param {any} res @param {unknown} err */
function appFailure(res, err) {
  if (err instanceof AppError || err instanceof GitHubError) return res.status(409).json({ error: err.message });
  throw err;
}

/** @param {any} req @param {any} res */
const projectOf = (req, res) => {
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) res.status(404).json({ error: 'Project not found.' });
  return project ?? null;
};

/** A WordPress box and an app both answer the website's back office: one at a time. @param {string} projectId */
const boxInTheWay = async (projectId) => ['running', 'starting'].includes((await boxState(projectId)).status);

appsRouter.get('/:id/app', async (req, res) => {
  const project = projectOf(req, res);
  if (!project) return;
  res.json(await appCard(project, req));
});

appsRouter.post('/:id/app/repo', async (req, res) => {
  if (notReady(res)) return;
  const project = projectOf(req, res);
  if (!project) return;
  const app = githubApp();
  const mine = githubOf(req);
  if (!app || !mine) return res.status(409).json({ error: 'Connect GitHub first.' });
  const installationId = Number(req.body?.installationId);
  // Only an installation this person reached when they signed in: a number alone proves nothing.
  if (!mine.installations.some((i) => i.id === installationId)) return res.status(403).json({ error: 'That GitHub installation is not one of yours. Connect GitHub again.' });
  const fullName = String(req.body?.fullName ?? '');
  const branch = String(req.body?.branch ?? '');
  try {
    await chooseRepo(project.id, app, { installationId, fullName, branch });
  } catch (err) {
    return appFailure(res, err);
  }
  res.json(await appCard(project, req));
});

appsRouter.put('/:id/app/settings', async (req, res) => {
  const project = projectOf(req, res);
  if (!project) return;
  const values = req.body?.values && typeof req.body.values === 'object' ? req.body.values : undefined;
  const text = typeof req.body?.text === 'string' ? req.body.text : undefined;
  try {
    await setSettings(project.id, { text, values });
  } catch (err) {
    return appFailure(res, err);
  }
  res.json(await appCard(project, req));
});

appsRouter.post('/:id/app/start', async (req, res) => {
  if (notReady(res)) return;
  const project = projectOf(req, res);
  if (!project) return;
  if (!(await dockerAvailable())) return res.status(409).json({ error: 'This Remastly server cannot run apps yet. The owner sets it up once (Docker).' });
  if (await boxInTheWay(project.id)) return res.status(409).json({ error: 'This website already runs a WordPress back office. Remove it first.' });
  const app = githubApp();
  const mine = githubOf(req);
  const state = await appState(project.id);
  // The newest code is read with the installation chosen; it must still be one this person reaches.
  if (!app || !mine || !mine.installations.some((i) => i.id === state.repo?.installationId)) return res.status(409).json({ error: 'Connect GitHub again, then start the app.' });
  try {
    await startApp(project.id, app, { domain: await domainOf(project) });
  } catch (err) {
    return appFailure(res, err);
  }
  res.status(202).json(await appCard(project, req));
});

appsRouter.post('/:id/app/use', async (req, res) => {
  const project = projectOf(req, res);
  if (!project) return;
  if (!(await hasApp(project.id))) return res.status(409).json({ error: 'Start the app first.' });
  const state = await appState(project.id);
  // Its own paths even where the copy has a page of that name (a notice page for /auth/login), and every address the copy
  // has no file for: its pages after sign-in, its build's own files.
  await savePassThrough(project.id, { target: BOX_TARGET, paths: state.app?.paths?.length ? state.app.paths : ['/api/*'], fallback: true });
  res.json(await appCard(project, req));
});

appsRouter.delete('/:id/app', async (req, res) => {
  const project = projectOf(req, res);
  if (!project) return;
  try {
    await deleteApp(project.id);
  } catch (err) {
    return appFailure(res, err);
  }
  const passThrough = await readPassThrough(project.id);
  if (passThrough?.target === BOX_TARGET && passThrough.fallback) await savePassThrough(project.id, null);
  res.json(await appCard(project, req));
});
