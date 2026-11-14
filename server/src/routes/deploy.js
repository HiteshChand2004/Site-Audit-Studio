// @ts-check
// "Go live" API.
//   GET    /api/hosting                       the hosting accounts connected by this person (never a token)
//   PUT    /api/hosting/netlify { token }     connect Netlify: the token is checked with Netlify first, then kept sealed
//   DELETE /api/hosting/netlify               forget it (nothing on Netlify changes)
//   PUT    /api/hosting/remastly { token }    owner only: set up Remastly hosting, Remastly's own Netlify account that every
//                                             website can be published on without an account of its own (Step 1)
//   DELETE /api/hosting/remastly              owner only: forget it (sites already live stay online)
//   GET    /api/projects/:id/deploy[?recreateId=&stack=]   what would be deployed, what stops it or needs a yes, past deploys
//   GET    /api/projects/:id/domain           the owner's domain on the live site and whether its DNS records are in place
//   PUT    /api/projects/:id/domain { domain }   put the domain on the live site; answers with the records to add (Step 2)
//   DELETE /api/projects/:id/domain           take it off again (the free address keeps working)
//   GET    /api/projects/:id/pass-through     the paths passed to the old app, and the ones the copy suggests (Step 3)
//   PUT    /api/projects/:id/pass-through { target, paths }   save them; they apply from the next deploy
//   DELETE /api/projects/:id/pass-through     stop passing anything on (from the next deploy)
//   POST   /api/projects/:id/deploy { recreateId?, stack?, accept?: [warning ids], target?: 'remastly' | 'own' }   start a
//          deploy (202); `target` defaults to Remastly hosting when it is set up, otherwise the person's own Netlify account
// Project routes sit behind the accounts' project gate (index.js), like every other /api/projects/:id route.
import { Router } from 'express';
import { db } from '../db/index.js';
import { targetStack } from '../recreate/export/fromIr.js';
import { deployReadiness, unaccepted } from '../deploy/readiness.js';
import { DeployError } from '../deploy/bundle.js';
import { HostingError, netlifyClient } from '../deploy/netlify.js';
import { deployRunning, recoverDeploys, runDeploy } from '../deploy/run.js';
import {
  connectionToken, deployReady, getConnection, insertDeployment, listConnections, listDeployments, MIGRATE_HINT, ownerKeyOf,
  liveSiteOf, REMASTLY, removeConnection, saveConnection,
} from '../deploy/store.js';
import { isOwner } from '../accounts/roles.js';
import { checkRecords, domainPlan, parseDomain } from '../deploy/domain.js';
import { parsePaths, parseTarget, readPassThrough, redirectsFor, savePassThrough, suggestedPaths } from '../deploy/passThrough.js';
import { withAsIsSafety } from '../copy/outsideServices.js';

const UUID = /^[0-9a-f-]{36}$/i;
const PROVIDERS = new Set(['netlify']);
// Netlify personal access tokens are ~43 characters (nfp_…); anything with spaces or far outside that is a paste mistake.
const TOKEN = /^[A-Za-z0-9_\-.]{20,200}$/;

/** 503 with the migration hint when the tables are missing; true when the request was answered. */
function notReady(res) {
  if (deployReady()) {
    recoverDeploys();
    return false;
  }
  res.status(503).json({ error: MIGRATE_HINT, needsMigration: true });
  return true;
}

/**
 * Remastly hosting as this person sees it: whether it is set up, whether they may set it up (the owner), and for the owner only,
 * which account it is.
 * @param {any} req
 */
function remastlyOf(req) {
  const account = getConnection(REMASTLY, 'netlify');
  const owner = isOwner(req);
  return { ready: Boolean(account), canManage: owner, account: owner ? account : null };
}

/** A token as Netlify issues it; anything with spaces or far outside its length is a paste mistake. @param {any} body */
const tokenOf = (body) => {
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  return TOKEN.test(token) ? token : null;
};
const TOKEN_HELP = 'Paste the whole personal access token from Netlify (User settings → Applications → Personal access tokens).';

export const hostingRouter = Router();

hostingRouter.get('/', (req, res) => {
  if (notReady(res)) return;
  res.json({ connections: listConnections(ownerKeyOf(req)), remastly: remastlyOf(req) });
});

// Before '/:provider', which would take "remastly" for a provider.
hostingRouter.put('/remastly', async (req, res) => {
  if (notReady(res)) return;
  if (!isOwner(req)) return res.status(403).json({ error: 'Only the owner can set up Remastly hosting.', forbidden: 'owner' });
  const token = tokenOf(req.body);
  if (!token) return res.status(400).json({ error: TOKEN_HELP });
  try {
    const user = await netlifyClient(token).user();
    saveConnection({ ownerKey: REMASTLY, provider: 'netlify', token, accountName: user.name, accountEmail: user.email });
    res.json({ remastly: remastlyOf(req) });
  } catch (err) {
    if (err instanceof HostingError) return res.status(err.code === 'token' ? 400 : 502).json({ error: err.message });
    throw err;
  }
});

hostingRouter.delete('/remastly', (req, res) => {
  if (notReady(res)) return;
  if (!isOwner(req)) return res.status(403).json({ error: 'Only the owner can change Remastly hosting.', forbidden: 'owner' });
  removeConnection(REMASTLY, 'netlify');
  res.json({ remastly: remastlyOf(req) });
});

hostingRouter.put('/:provider', async (req, res) => {
  if (notReady(res)) return;
  const { provider } = req.params;
  if (!PROVIDERS.has(provider)) return res.status(404).json({ error: 'Only Netlify can be connected for now.' });
  const token = tokenOf(req.body);
  if (!token) return res.status(400).json({ error: TOKEN_HELP });
  try {
    const user = await netlifyClient(token).user();
    const connection = saveConnection({ ownerKey: ownerKeyOf(req), provider, token, accountName: user.name, accountEmail: user.email });
    res.json({ connection });
  } catch (err) {
    if (err instanceof HostingError) return res.status(err.code === 'token' ? 400 : 502).json({ error: err.message });
    throw err;
  }
});

hostingRouter.delete('/:provider', (req, res) => {
  if (notReady(res)) return;
  if (!PROVIDERS.has(req.params.provider)) return res.status(404).json({ error: 'Only Netlify can be connected for now.' });
  res.json({ removed: removeConnection(ownerKeyOf(req), req.params.provider) });
});

const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const latestDoneCopy = db.prepare(`SELECT id, finished_at, result_json FROM recreates WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL AND removed_at IS NULL ORDER BY started_at DESC LIMIT 1`);
const doneCopy = db.prepare(`SELECT id, finished_at, result_json FROM recreates WHERE id = ? AND project_id = ? AND status = 'done' AND result_json IS NOT NULL AND removed_at IS NULL`);
const latestComparison = db.prepare(`SELECT result_json FROM reaudits WHERE recreate_id = ? AND project_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1`);

/** The copy, its stack and what stands in the way, for one request. @param {any} project @param {any} q @param {any} [passThrough] */
function subjectOf(project, q, passThrough = null) {
  const row = /** @type {any} */ (typeof q?.recreateId === 'string' && UUID.test(q.recreateId) ? doneCopy.get(q.recreateId, project.id) : latestDoneCopy.get(project.id));
  const report = row?.result_json ? withAsIsSafety(JSON.parse(row.result_json)) : null;
  const stack = typeof q?.stack === 'string' && q.stack ? q.stack : (report ? targetStack(report, project.stack) : project.stack);
  const reauditRow = /** @type {any} */ (row ? latestComparison.get(row.id, project.id) : null);
  const reaudit = reauditRow?.result_json ? JSON.parse(reauditRow.result_json) : null;
  return { recreateId: row?.id ?? null, copiedAt: row?.finished_at ?? null, report, stack, readiness: deployReadiness({ project, report, stack, reaudit, passThrough }) };
}

export const deployRouter = Router();

deployRouter.get('/:id/deploy', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const { recreateId, copiedAt, stack, readiness } = subjectOf(project, req.query, await readPassThrough(project.id));
  const owner = isOwner(req);
  res.json({
    recreateId, copiedAt, stack, readiness,
    connection: getConnection(ownerKeyOf(req), 'netlify'),
    remastly: remastlyOf(req),
    running: deployRunning(project.id),
    // A site on Remastly hosting is managed in Remastly's own Netlify account: only the owner gets that link.
    deployments: listDeployments(project.id).map((d) => (d?.hosting === 'remastly' && !owner ? { ...d, adminUrl: null } : d)),
  });
});

deployRouter.post('/:id/deploy', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  // Remastly hosting when it is set up, unless the person chose their own account.
  const remastlyReady = Boolean(getConnection(REMASTLY, 'netlify'));
  const target = req.body?.target === 'own' || req.body?.target === 'remastly' ? req.body.target : (remastlyReady ? 'remastly' : 'own');
  const ownerKey = target === 'remastly' ? REMASTLY : ownerKeyOf(req);
  const token = connectionToken(ownerKey, 'netlify');
  if (!token) {
    return target === 'remastly'
      ? res.status(400).json({ error: 'Remastly hosting is not set up yet. Publish on your own Netlify account, or ask the owner to set it up.', needsRemastly: true })
      : res.status(400).json({ error: 'Connect Netlify first.', needsConnection: true });
  }
  if (deployRunning(project.id)) return res.status(409).json({ error: 'This website is being deployed already. Wait for it to finish.' });
  const { recreateId, report, stack, readiness } = subjectOf(project, req.body, await readPassThrough(project.id));
  if (!readiness.ok) return res.status(409).json({ error: readiness.blockers[0].text, blockers: readiness.blockers });
  const open = unaccepted(readiness.warnings, req.body?.accept);
  if (open.length) return res.status(409).json({ error: 'Confirm what the copy still lacks before it goes live.', warnings: open, needsAccept: true });
  const deployment = insertDeployment({ projectId: project.id, recreateId: /** @type {string} */ (recreateId), stack, provider: 'netlify', ownerKey });
  if (!deployment) throw new DeployError('The deploy could not be recorded.', 500);
  runDeploy({ deployment, projectId: project.id, recreateId: /** @type {string} */ (recreateId), report, stack, token, ownerKey });
  res.status(202).json({ deployment });
});

// ---- Step 2: the owner's own domain ----

/** The live site and a Netlify client for the account it is on, or the answer to send instead. @param {any} project */
function liveSiteClient(project) {
  const live = liveSiteOf(project.id);
  if (!live) return { error: { status: 409, body: { error: 'Put the site online first; then its domain can be connected.', notLive: true } } };
  const token = connectionToken(live.ownerKey, 'netlify');
  if (!token) {
    const error = live.hosting === 'remastly'
      ? 'Remastly hosting is turned off, so the domain of this site cannot be changed. Ask the owner to set it up again.'
      : 'The Netlify account this site is on is no longer connected. Connect it again to change the domain.';
    return { error: { status: 409, body: { error } } };
  }
  return { live, netlify: netlifyClient(token) };
}

/** The domain on the site, the records to add, and which are in place. @param {any} project @param {any} site @param {any} netlify */
async function domainState(project, site, netlify) {
  const original = (() => { try { return new URL(project.target_domain || project.url).hostname; } catch { return null; } })();
  if (!site.customDomain) return { domain: null, suggestion: original, siteHost: site.siteHost, url: site.url };
  const d = parseDomain(site.customDomain);
  if (!d.ok) return { domain: site.customDomain, records: [], connected: false, https: site.ssl, siteHost: site.siteHost, url: site.url };
  const records = await checkRecords(domainPlan(d, /** @type {string} */ (site.siteHost)).records);
  const connected = records.filter((r) => r.required).every((r) => r.ok);
  // Netlify turns the padlock on by itself once the domain points to it; asking speeds it up. A refusal changes nothing here.
  if (connected && !site.ssl) await netlify.provisionSsl(site.id).catch(() => {});
  return { domain: d.host, records, connected, https: site.ssl, siteHost: site.siteHost, url: site.url };
}

/** @param {any} res @param {unknown} err */
function hostingFailure(res, err) {
  if (err instanceof HostingError) return res.status(err.code === 'token' ? 409 : 502).json({ error: err.message });
  throw err;
}

deployRouter.get('/:id/domain', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const c = liveSiteClient(project);
  if (c.error) return res.status(c.error.status).json(c.error.body);
  try {
    const site = await c.netlify.site(c.live.siteId);
    res.json(await domainState(project, site, c.netlify));
  } catch (err) {
    hostingFailure(res, err);
  }
});

deployRouter.put('/:id/domain', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const d = parseDomain(req.body?.domain);
  if (!d.ok) return res.status(400).json({ error: d.error });
  const c = liveSiteClient(project);
  if (c.error) return res.status(c.error.status).json(c.error.body);
  try {
    const before = await c.netlify.site(c.live.siteId);
    const plan = domainPlan(d, /** @type {string} */ (before.siteHost));
    const site = await c.netlify.setDomain(c.live.siteId, { primary: plan.primary, aliases: plan.aliases });
    res.json(await domainState(project, site, c.netlify));
  } catch (err) {
    hostingFailure(res, err);
  }
});

deployRouter.delete('/:id/domain', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const c = liveSiteClient(project);
  if (c.error) return res.status(c.error.status).json(c.error.body);
  try {
    const site = await c.netlify.setDomain(c.live.siteId, { primary: null, aliases: [] });
    res.json(await domainState(project, site, c.netlify));
  } catch (err) {
    hostingFailure(res, err);
  }
});

// ---- Step 3: logins and data passed to the old app ----

/** The names the old app's address may not have: the site's own (original and new). @param {any} project */
const ownHostsOf = (project) => [project.url, project.target_domain].map((u) => { try { return new URL(u).hostname; } catch { return null; } });

deployRouter.get('/:id/pass-through', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const { report } = subjectOf(project, req.query);
  const passThrough = await readPassThrough(project.id);
  res.json({ passThrough, rules: passThrough ? redirectsFor(passThrough) : null, suggestions: report ? suggestedPaths(report) : [] });
});

deployRouter.put('/:id/pass-through', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const target = parseTarget(req.body?.target, ownHostsOf(project));
  if (!target.ok) return res.status(400).json({ error: target.error });
  const paths = parsePaths(req.body?.paths);
  if (!paths.ok) return res.status(400).json({ error: paths.error });
  const passThrough = { target: /** @type {string} */ (target.value), paths: /** @type {string[]} */ (paths.value) };
  await savePassThrough(project.id, passThrough);
  res.json({ passThrough, rules: redirectsFor(passThrough), insecure: Boolean(target.insecure) });
});

deployRouter.delete('/:id/pass-through', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  await savePassThrough(project.id, null);
  res.json({ passThrough: null, rules: null });
});
