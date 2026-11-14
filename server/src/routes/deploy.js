// @ts-check
// "Go live" API.
//   GET    /api/hosting                       the hosting accounts connected by this person (never a token)
//   PUT    /api/hosting/netlify { token }     connect Netlify: the token is checked with Netlify first, then kept sealed
//   DELETE /api/hosting/netlify               forget it (nothing on Netlify changes)
//   GET    /api/projects/:id/deploy[?recreateId=&stack=]   what would be deployed, what stops it or needs a yes, past deploys
//   POST   /api/projects/:id/deploy { recreateId?, stack?, accept?: [warning ids] }   start a deploy (202)
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
  removeConnection, saveConnection,
} from '../deploy/store.js';

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

export const hostingRouter = Router();

hostingRouter.get('/', (req, res) => {
  if (notReady(res)) return;
  res.json({ connections: listConnections(ownerKeyOf(req)) });
});

hostingRouter.put('/:provider', async (req, res) => {
  if (notReady(res)) return;
  const { provider } = req.params;
  if (!PROVIDERS.has(provider)) return res.status(404).json({ error: 'Only Netlify can be connected for now.' });
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!TOKEN.test(token)) return res.status(400).json({ error: 'Paste the whole personal access token from Netlify (User settings → Applications → Personal access tokens).' });
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

/** The copy, its stack and what stands in the way, for one request. @param {any} project @param {any} q */
function subjectOf(project, q) {
  const row = /** @type {any} */ (typeof q?.recreateId === 'string' && UUID.test(q.recreateId) ? doneCopy.get(q.recreateId, project.id) : latestDoneCopy.get(project.id));
  const report = row?.result_json ? JSON.parse(row.result_json) : null;
  const stack = typeof q?.stack === 'string' && q.stack ? q.stack : (report ? targetStack(report, project.stack) : project.stack);
  const reauditRow = /** @type {any} */ (row ? latestComparison.get(row.id, project.id) : null);
  const reaudit = reauditRow?.result_json ? JSON.parse(reauditRow.result_json) : null;
  return { recreateId: row?.id ?? null, copiedAt: row?.finished_at ?? null, report, stack, readiness: deployReadiness({ project, report, stack, reaudit }) };
}

export const deployRouter = Router();

deployRouter.get('/:id/deploy', (req, res) => {
  if (notReady(res)) return;
  const project = selectProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const { recreateId, copiedAt, stack, readiness } = subjectOf(project, req.query);
  res.json({
    recreateId, copiedAt, stack, readiness,
    connection: getConnection(ownerKeyOf(req), 'netlify'),
    running: deployRunning(project.id),
    deployments: listDeployments(project.id),
  });
});

deployRouter.post('/:id/deploy', (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const ownerKey = ownerKeyOf(req);
  const token = connectionToken(ownerKey, 'netlify');
  if (!token) return res.status(400).json({ error: 'Connect Netlify first.', needsConnection: true });
  if (deployRunning(project.id)) return res.status(409).json({ error: 'This website is being deployed already. Wait for it to finish.' });
  const { recreateId, report, stack, readiness } = subjectOf(project, req.body);
  if (!readiness.ok) return res.status(409).json({ error: readiness.blockers[0].text, blockers: readiness.blockers });
  const open = unaccepted(readiness.warnings, req.body?.accept);
  if (open.length) return res.status(409).json({ error: 'Confirm what the copy still lacks before it goes live.', warnings: open, needsAccept: true });
  const deployment = insertDeployment({ projectId: project.id, recreateId: /** @type {string} */ (recreateId), stack, provider: 'netlify', ownerKey });
  if (!deployment) throw new DeployError('The deploy could not be recorded.', 500);
  runDeploy({ deployment, projectId: project.id, recreateId: /** @type {string} */ (recreateId), report, stack, token, ownerKey });
  res.status(202).json({ deployment });
});
