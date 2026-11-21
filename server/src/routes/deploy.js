// @ts-check
// "Go live" API.
//   GET    /api/hosting                       the hosting accounts connected by this person (never a token)
//   PUT    /api/hosting/netlify { token }     connect Netlify: the token is checked with Netlify first, then kept sealed
//   DELETE /api/hosting/netlify               forget it (nothing on Netlify changes)
//   PUT    /api/hosting/remastly { token }    owner only: set up Remastly hosting, Remastly's own Netlify account that every
//                                             website can be published on without an account of its own (Step 1)
//   DELETE /api/hosting/remastly              owner only: forget it (sites already live stay online)
//   PUT    /api/hosting/godaddy { token } | { key, secret }   connect this person's GoDaddy account (checked with GoDaddy, kept sealed),
//                                             so Remastly can point their domains here itself; DELETE forgets it. For the owner,
//                                             SAS_GODADDY_TOKENS (one per GoDaddy account) works without pasting anything
//   GET    /api/projects/:id/deploy[?recreateId=&stack=]   what would be deployed, what stops it or needs a yes, past deploys
//   GET    /api/projects/:id/domain           the owner's domain on the live site and whether its DNS records are in place
//   PUT    /api/projects/:id/domain { domain }   put the domain on the live site; answers with the records to add (Step 2)
//   DELETE /api/projects/:id/domain { pointBack?, ip? }   take it off again; pointBack: when the server it was on before
//                                             answers the site, point the domain back there (kept answered here an hour)
//   GET    /api/projects/:id/domain/back[?ip=]   that server: its address, whether it answers, whether Remastly can point it
//   GET    /api/projects/:id/domain/godaddy   what Remastly would change at GoDaddy for the records to be in place
//   POST   /api/projects/:id/domain/godaddy   change them (what they pointed to before is saved); DELETE puts that back
//   GET    /api/projects/:id/pass-through     the paths passed to the old app, and the ones the copy suggests (Step 3)
//   PUT    /api/projects/:id/pass-through { target, paths }   save them; they apply from the next deploy
//   DELETE /api/projects/:id/pass-through     stop passing anything on (from the next deploy)
//   GET    /api/projects/:id/forms            Form entries: whether the forms save to Remastly, and the latest entries
//   PUT    /api/projects/:id/forms { enabled?, email? }   turn saving / the email on each entry on or off (from the next deploy)
//   GET    /api/projects/:id/forms/entries.csv   every entry, for a spreadsheet
//   DELETE /api/projects/:id/forms/entries/:entryId   remove one entry
//   GET    /api/projects/:id/switch-off       "Can I switch off the old server?": what of this website still needs it
//   GET    /api/projects/:id/snapshot         the copy's data calls (/api/…) and the content snapshot of their answers
//   POST   /api/projects/:id/snapshot         take it (again) from the old site; DELETE removes it (from the next deploy)
//   POST   /api/projects/:id/forms/import     (body: a CSV file) old entries from Webflow, Framer or the old site's database
//   DELETE /api/projects/:id/forms/imports/:importId   take one import back
//   GET    /api/projects/:id/box              "Move logins and data to Remastly": the backup uploaded, the box made from it
//   POST   /api/projects/:id/box/files?name=  (body: one backup file) add it; DELETE /box/files/:name removes it
//   POST   /api/projects/:id/box/start { replace? }   make the box from the files (202; GET follows it)
//   POST   /api/projects/:id/box/use          send "Logins and data" to the box (from the next deploy)
//   DELETE /api/projects/:id/box              remove the box with its data, and stop sending anything to it
//   POST   /api/projects/:id/deploy/:deploymentId/restore   put an earlier finished deploy back as the live one (Step 4)
//   POST   /api/projects/:id/deploy { recreateId?, stack?, accept?: [warning ids], target?: 'remastly' | 'own' }   start a
//          deploy (202); `target` defaults to Remastly hosting when it is set up, otherwise the person's own Netlify account
// Project routes sit behind the accounts' project gate (index.js), like every other /api/projects/:id route.
import express, { Router } from 'express';
import { db } from '../db/index.js';
import { targetStack } from '../recreate/export/fromIr.js';
import { deployReadiness, unaccepted } from '../deploy/readiness.js';
import { DeployError } from '../deploy/bundle.js';
import { HostingError, netlifyClient } from '../deploy/netlify.js';
import { deployRunning, recoverDeploys, runDeploy } from '../deploy/run.js';
import {
  connectionToken, deployReady, getConnection, insertDeployment, listConnections, listDeployments, MIGRATE_HINT, ownerKeyOf,
  insertRestored, liveSiteOf, REMASTLY, removeConnection, restorable, saveConnection, SERVER,
} from '../deploy/store.js';
import { isOwner } from '../accounts/roles.js';
import { checkRecords, domainPlan, parseDomain } from '../deploy/domain.js';
import { applyDns, changedTypes, credentialOf, DnsError, forgetDnsChange, godaddyClient, godaddyConfig, planDns, readDnsChange, saveDnsChange, sealedOf, serverClientFor, TOKEN_SCOPES, undoDns } from '../deploy/godaddy.js';
import { BOX_TARGET, hostingPaths, hostsOf, setHosts, switchRelease } from '../hosting/store.js';
import { addUpload, BOX_LIMITS, BoxError, boxState, deleteBox, hasBox, removeUpload, startBox, WORDPRESS_PATHS } from '../boxes/index.js';
import { boxRunning } from '../boxes/box.js';
import { dockerAvailable } from '../boxes/docker.js';
import { boxSetup } from '../boxes/setup.js';
import { hasCertificate, refreshWantedCerts } from '../hosting/certs.js';
import { hostingIp } from '../config/index.js';
import { SERVER_DIR } from '../config/paths.js';
import { serverSetup, stableServerDir } from '../hosting/setup.js';
import os from 'node:os';

const serverIp = hostingIp;import { appCallsOf, fallbackFor, parsePaths, parseTarget, readPassThrough, redirectsFor, savePassThrough, suggestedPaths, unansweredAppCalls } from '../deploy/passThrough.js';
import { appState, hasApp } from '../apps/index.js';
import { checkOldServer, minutesToKeep, parseOldIp, pointsTo, rememberBefore, rememberedIp } from '../deploy/domainBack.js';
import { appRunning } from '../apps/run.js';
import { formsEndpointOf } from '../forms/connect.js';
import { entriesCsv, importEntries, listEntries, removeEntry, removeImport, saveFormSettings } from '../forms/entries.js';
import { entriesFromRows, IMPORT_LIMITS, parseCsv } from '../forms/importCsv.js';
import { switchOffCheck } from '../deploy/switchOff.js';
import { readSnapshot, removeSnapshot, snapshotForDeploy, takeSnapshot } from '../deploy/snapshot.js';
import { formCounts } from '../copy/formRoutes.js';
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

// The one-time server setup for Remastly's own hosting (hosting/setup.js), with this Remastly's real folders; owner only.
hostingRouter.get('/server-setup', async (req, res) => {
  if (!isOwner(req)) return res.status(403).json({ error: 'Only the owner can see the server setup.', forbidden: 'owner' });
  const sitesPort = Number(process.env.SAS_SITES_PORT) || 4100;
  const email = (process.env.SAS_OWNER_EMAIL ?? '').trim() || /** @type {any} */ (req).user?.email || '';
  let setup;
  try {
    setup = serverSetup({
      // A folder nginx can reach: the default one sits in the data folder, often inside a home folder nginx may not enter.
      hostingDir: process.env.SAS_HOSTING_DIR ? hostingPaths.root : '/srv/remastly-hosting', serverDir: stableServerDir(SERVER_DIR), node: process.execPath, user: os.userInfo().username,
      email: email || 'owner@example.com', ip: hostingIp(), sitesPort,
    });
  } catch (err) {
    return res.status(409).json({ error: /** @type {Error} */ (err).message });
  }
  // Whether the parts already answer: the sites server on its port, and the address Remastly gives domains.
  const sitesServer = await fetch(`http://127.0.0.1:${sitesPort}/`, { signal: AbortSignal.timeout(2000) })
    .then(() => true, () => false);
  res.json({ ...setup, emailMissing: !email, status: { hostingIp: hostingIp(), sitesServer } });
});

hostingRouter.delete('/remastly', (req, res) => {
  if (notReady(res)) return;
  if (!isOwner(req)) return res.status(403).json({ error: 'Only the owner can change Remastly hosting.', forbidden: 'owner' });
  removeConnection(REMASTLY, 'netlify');
  res.json({ remastly: remastlyOf(req) });
});

// GoDaddy: not a host but where the person's domains are, so Remastly can change their DNS records itself (deploy/godaddy.js).
// Before '/:provider' like '/remastly'.
hostingRouter.put('/godaddy', async (req, res) => {
  if (notReady(res)) return;
  const c = credentialOf(req.body);
  if (!c) return res.status(400).json({ error: `Paste the whole personal access token from GoDaddy (with the permissions ${TOKEN_SCOPES.join(' and ')}), or a key and its secret.` });
  try {
    await godaddyClient(sealedOf(c)).check();
    // The end is enough to tell two apart; the token, key or secret is never sent back.
    const connection = saveConnection({ ownerKey: ownerKeyOf(req), provider: 'godaddy', token: sealedOf(c), accountName: `${c.kind === 'token' ? 'token' : 'key'} ending ${c.ending}` });
    res.json({ connection });
  } catch (err) {
    if (err instanceof DnsError) return res.status(err.code === 'key' ? 400 : 502).json({ error: err.message });
    throw err;
  }
});

hostingRouter.delete('/godaddy', (req, res) => {
  if (notReady(res)) return;
  res.json({ removed: removeConnection(ownerKeyOf(req), 'godaddy') });
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

/**
 * What Go live set up for this website besides the copy, which changes what still needs a yes: the paths passed to the old app,
 * forms saved by Remastly, the content snapshot.
 * @param {string} projectId
 */
async function goLiveSetup(projectId) {
  return {
    passThrough: await readPassThrough(projectId),
    formsConnected: Boolean((await formsEndpointOf(projectId)).endpoint),
    snapshotAddresses: ((await readSnapshot(projectId))?.items ?? []).map((i) => i.address),
  };
}

/**
 * The copy, its stack and what stands in the way, for one request.
 * @param {any} project @param {any} q @param {Awaited<ReturnType<typeof goLiveSetup>>} [setup]
 */
function subjectOf(project, q, setup = { passThrough: null, formsConnected: false, snapshotAddresses: [] }) {
  const row = /** @type {any} */ (typeof q?.recreateId === 'string' && UUID.test(q.recreateId) ? doneCopy.get(q.recreateId, project.id) : latestDoneCopy.get(project.id));
  const report = row?.result_json ? withAsIsSafety(JSON.parse(row.result_json)) : null;
  const stack = typeof q?.stack === 'string' && q.stack ? q.stack : (report ? targetStack(report, project.stack) : project.stack);
  const reauditRow = /** @type {any} */ (row ? latestComparison.get(row.id, project.id) : null);
  const reaudit = reauditRow?.result_json ? JSON.parse(reauditRow.result_json) : null;
  return { recreateId: row?.id ?? null, copiedAt: row?.finished_at ?? null, report, stack, readiness: deployReadiness({ project, report, stack, reaudit, ...setup }) };
}

export const deployRouter = Router();

deployRouter.get('/:id/deploy', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const { recreateId, copiedAt, stack, readiness } = subjectOf(project, req.query, await goLiveSetup(project.id));
  const owner = isOwner(req);
  res.json({
    recreateId, copiedAt, stack, readiness,
    connection: getConnection(ownerKeyOf(req), 'netlify'),
    remastly: remastlyOf(req),
    // canSetUp: the one-time server setup is the owner's (GET /api/hosting/server-setup).
    server: { ready: Boolean(serverIp()), ip: serverIp(), domain: (await hostsOf(project.id)).primary, canSetUp: owner },
    running: deployRunning(project.id),
    // A site on Remastly hosting is managed in Remastly's own Netlify account: only the owner gets that link.
    deployments: listDeployments(project.id).map((d) => (d?.hosting === 'remastly' && !owner ? { ...d, adminUrl: null } : d)),
  });
});

deployRouter.post('/:id/deploy', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  // Remastly's own server when it is set up, else Remastly hosting on Netlify, else the person's own account; unless they chose.
  const remastlyReady = Boolean(getConnection(REMASTLY, 'netlify'));
  const wanted = ['server', 'remastly', 'own'].includes(req.body?.target) ? req.body.target : null;
  const target = wanted ?? (serverIp() ? 'server' : remastlyReady ? 'remastly' : 'own');
  if (deployRunning(project.id)) return res.status(409).json({ error: 'This website is being deployed already. Wait for it to finish.' });
  let ownerKey;
  let token = null;
  if (target === 'server') {
    const ip = serverIp();
    if (!ip) return res.status(400).json({ error: 'Remastly\'s own server is not set up for hosting yet (SAS_HOSTING_IP). Use another place, or ask the owner.', needsServer: true });
    ownerKey = SERVER;
    // The site answers at its domain only: the first deploy needs one (a later one keeps it unless another is given).
    if (req.body?.domain !== undefined) {
      const d = parseDomain(req.body.domain);
      if (!d.ok) return res.status(400).json({ error: d.error });
      const plan = domainPlan(d, null, ip);
      try {
        await setHosts(project.id, plan.primary, plan.aliases);
      } catch (err) {
        return res.status(409).json({ error: /** @type {Error} */ (err).message });
      }
      // Where the domain points before anyone moves it here: where "Remove domain" can send it back.
      await rememberBefore(project.id, d, ip).catch(() => {});
    }
    if (!(await hostsOf(project.id)).primary) return res.status(400).json({ error: 'Type the domain this website will answer at.', needsDomain: true });
  } else {
    ownerKey = target === 'remastly' ? REMASTLY : ownerKeyOf(req);
    token = connectionToken(ownerKey, 'netlify');
    if (!token) {
      return target === 'remastly'
        ? res.status(400).json({ error: 'Remastly hosting is not set up yet. Publish on your own Netlify account, or ask the owner to set it up.', needsRemastly: true })
        : res.status(400).json({ error: 'Connect Netlify first.', needsConnection: true });
    }
  }
  const { recreateId, report, stack, readiness } = subjectOf(project, req.body, await goLiveSetup(project.id));
  if (!readiness.ok) return res.status(409).json({ error: readiness.blockers[0].text, blockers: readiness.blockers });
  const open = unaccepted(readiness.warnings, req.body?.accept);
  if (open.length) return res.status(409).json({ error: 'Confirm what the copy still lacks before it goes live.', warnings: open, needsAccept: true });
  const deployment = insertDeployment({ projectId: project.id, recreateId: /** @type {string} */ (recreateId), stack, provider: target === 'server' ? 'server' : 'netlify', ownerKey });
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

/** The original site's own name: offered first as the domain, since a copy usually takes its place. @param {any} project */
const originalHostOf = (project) => { try { return new URL(project.target_domain || project.url).hostname; } catch { return null; } };

/** The domain on the Netlify site, the records to add, and which are in place. @param {any} project @param {any} site @param {any} netlify */
async function domainState(project, site, netlify) {
  if (!site.customDomain) return { domain: null, suggestion: originalHostOf(project), siteHost: site.siteHost, url: site.url };
  const d = parseDomain(site.customDomain);
  if (!d.ok) return { domain: site.customDomain, records: [], connected: false, https: site.ssl, siteHost: site.siteHost, url: site.url };
  const records = await checkRecords(domainPlan(d, /** @type {string} */ (site.siteHost)).records);
  const connected = records.filter((r) => r.required).every((r) => r.ok);
  // Netlify turns the padlock on by itself once the domain points to it; asking speeds it up. A refusal changes nothing here.
  if (connected && !site.ssl) await netlify.provisionSsl(site.id).catch(() => {});
  return { domain: d.host, records, connected, https: site.ssl, siteHost: site.siteHost, url: site.url };
}

/** The same for a website on Remastly's own server: every name is an A record to the server's address. @param {any} project */
async function serverDomainState(project) {
  const { primary } = await hostsOf(project.id);
  if (!primary) return { domain: null, suggestion: originalHostOf(project), url: null };
  const d = parseDomain(primary);
  const records = d.ok ? await checkRecords(domainPlan(d, null, serverIp()).records) : [];
  const connected = records.length > 0 && records.filter((r) => r.required).every((r) => r.ok);
  const https = await hasCertificate(primary);
  // Pointing here and no padlock yet: listed for certbot now, not at the next timed refresh.
  if (connected && !https) await refreshWantedCerts(/** @type {string} */ (serverIp())).catch((err) => console.warn(`[hosting] certs list: ${err.message}`));
  return { domain: primary, records, connected, https, url: `https://${primary}` };
}

/**
 * Where the live site's domain stands, wherever it is hosted; or the answer to send instead (not live, account gone).
 * @param {any} project @returns {Promise<{ state: any } | { error: { status: number, body: any } }>}
 */
async function domainOf(project) {
  const live = liveSiteOf(project.id);
  if (live?.hosting === 'server') return { state: await serverDomainState(project) };
  const c = liveSiteClient(project);
  if (c.error) return { error: c.error };
  return { state: await domainState(project, await c.netlify.site(c.live.siteId), c.netlify) };
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
  try {
    const r = await domainOf(project);
    if ('error' in r) return res.status(r.error.status).json(r.error.body);
    res.json(r.state);
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
  if (liveSiteOf(project.id)?.hosting === 'server') {
    const plan = domainPlan(d, null, serverIp());
    try {
      await setHosts(project.id, plan.primary, plan.aliases);
    } catch (err) {
      return res.status(409).json({ error: /** @type {Error} */ (err).message });
    }
    await rememberBefore(project.id, d, /** @type {string} */ (serverIp())).catch(() => {});
    return res.json(await serverDomainState(project));
  }
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

/**
 * The server the domain was on before Remastly: its address (typed, else what Remastly changed at GoDaddy, else what it noted
 * when the domain was put on the site), whether it still answers the site, and whether Remastly can point the domain back
 * itself (GoDaddy). Null when the website answers no domain.
 * @param {any} project @param {any} req @param {unknown} [typed]
 */
async function oldServerOf(project, req, typed) {
  const { primary } = await hostsOf(project.id);
  const d = primary ? parseDomain(primary) : null;
  if (!d?.ok) return null;
  const saved = await readDnsChange(project.id);
  const mine = saved?.apex === d.apex ? saved : null;
  let ip = null;
  let source = null;
  if (typed !== undefined && typed !== null && typed !== '') {
    const p = parseOldIp(typed, serverIp());
    if (!p.ok) return { domain: d.host, error: p.error };
    [ip, source] = [p.value, 'typed'];
  } else if (mine?.changes.find((c) => c.host === d.host && c.needed)?.before.A?.[0]) {
    [ip, source] = [mine.changes.find((c) => c.host === d.host).before.A[0], 'godaddy'];
  } else if ((ip = await rememberedIp(project.id, d.host))) {
    source = 'remembered';
  }
  let client = null;
  try {
    client = await godaddyFor(req, d.apex);
  } catch (err) {
    if (!(err instanceof DnsError)) throw err;
  }
  const plan = ip ? domainPlan(d, null, ip).records : [];
  return {
    d, mine, client, domain: d.host, ip, source,
    check: ip ? await checkOldServer(ip, d.host) : null,
    auto: Boolean(client),
    records: plan.map(({ type, name, value }) => ({ type, name, value })),
    hosts: plan.map((r) => r.host),
    // Changed by hand already: the domain's own DNS servers send it there.
    pointed: ip && !client ? await pointsTo(plan.map((r) => r.host), ip) : false,
  };
}

deployRouter.get('/:id/domain/back', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (liveSiteOf(project.id)?.hosting !== 'server') return res.json({ supported: false });
  const back = await oldServerOf(project, req, req.query.ip);
  if (back?.error) return res.status(400).json({ error: back.error });
  res.json(back ? { supported: true, domain: back.domain, ip: back.ip, source: back.source, check: back.check, auto: back.auto, pointed: back.pointed, records: back.records } : { supported: true, domain: null });
});

deployRouter.delete('/:id/domain', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (liveSiteOf(project.id)?.hosting === 'server') {
    // Back to the old server: only when it answers the site; then the DNS is pointed there (by Remastly at GoDaddy, else by
    // hand) and Remastly keeps answering while the change spreads.
    if (req.body?.pointBack === true) {
      const back = await oldServerOf(project, req, req.body.ip);
      if (!back) return res.status(409).json({ error: 'This website answers no domain.' });
      if (back.error) return res.status(400).json({ error: back.error });
      if (!back.ip) return res.status(409).json({ error: 'Type the address of the server the domain was on before.' });
      if (!back.check?.works) return res.status(409).json({ error: `The old server ${back.ip} does not answer ${back.domain}: ${back.check?.reason}. The domain stays on Remastly.` });
      // Changed by hand: the domain is let go only once its own DNS servers send it to the old server.
      if (!back.client && !back.pointed) return res.status(409).json({ error: `Change these records first, at the company where ${back.domain} is; then check again.`, records: back.records });
      // How long others may still send visitors here: the lifetime of the names' records (read before Remastly changes them).
      const keepMinutes = await minutesToKeep(back.hosts);
      let how = 'manual';
      if (back.client) {
        try {
          // What Remastly itself changed at GoDaddy is put back exactly; else the names are pointed at the old address.
          try {
            if (back.mine && back.source !== 'typed') await undoDns(back.client, back.d.apex, back.mine.changes);
            else await applyDns(back.client, back.d.apex, await planDns(back.client, back.d.apex, domainPlan(back.d, null, back.ip).records));
          } finally {
            plans.delete(project.id);
          }
          await forgetDnsChange(project.id);
          how = 'godaddy';
        } catch (err) {
          return dnsFailure(res, err);
        }
      }
      await setHosts(project.id, null, [], { keepMinutes });
      return res.json({ ...(await serverDomainState(project)), back: { how, ip: back.ip, domain: back.domain, keepMinutes } });
    }
    await setHosts(project.id, null);
    return res.json(await serverDomainState(project));
  }
  const c = liveSiteClient(project);
  if (c.error) return res.status(c.error.status).json(c.error.body);
  try {
    const site = await c.netlify.setDomain(c.live.siteId, { primary: null, aliases: [] });
    res.json(await domainState(project, site, c.netlify));
  } catch (err) {
    hostingFailure(res, err);
  }
});

// ---- Step 2, done by Remastly: the domain's records changed at GoDaddy ----

/**
 * Which GoDaddy credential this person uses: the one they pasted in the app, else, for the owner only, the server's settings
 * (SAS_GODADDY_TOKENS). A customer never reaches the server's accounts: they hold the owner's own domains.
 * @param {any} req
 */
function godaddySource(req) {
  const own = getConnection(ownerKeyOf(req), 'godaddy');
  if (own) return { kind: 'own', account: own.accountName };
  if (isOwner(req) && godaddyConfig.serverTokens.length) return { kind: 'server', accounts: godaddyConfig.serverTokens.length };
  return null;
}

/**
 * The client for this domain, or a DnsError saying why there is none.
 * @param {any} req @param {string} apex
 */
async function godaddyFor(req, apex) {
  const source = godaddySource(req);
  if (source?.kind === 'own') return godaddyClient(/** @type {string} */ (connectionToken(ownerKeyOf(req), 'godaddy')));
  if (source?.kind === 'server') {
    const client = await serverClientFor(apex);
    if (client) return client;
    throw new DnsError(`${apex} is not in any of the ${source.accounts} GoDaddy account(s) set on this server. Add that account's token to SAS_GODADDY_TOKENS, or change the records by hand.`, 'domain');
  }
  throw new DnsError('Connect GoDaddy first.', 'key');
}

// The card's plan, kept a little while per website: a reload or "Check again" does not ask GoDaddy for every record again.
// Kept with what it was read for (who asks, through which account, the domain and its records); a change made here clears it.
const PLAN_MS = 20_000;
/** @type {Map<string, { key: string, until: number, changes: import('../deploy/godaddy.js').Change[] }>} */
const plans = new Map();

/**
 * What the GoDaddy part of the domain card shows: whether GoDaddy is connected (pasted, or the server's), what Remastly
 * changed there before (and can put back), and what it would change now; or why it cannot (the domain is in no connected
 * account, its DNS is run elsewhere).
 * @param {any} project @param {any} req @param {any} [state]  the domain's state when the caller already read it
 */
async function godaddyCard(project, req, state) {
  const saved = await readDnsChange(project.id);
  const changed = saved ? { at: saved.at, apex: saved.apex, names: saved.changes.filter((c) => changedTypes(c).length).map((c) => c.host) } : null;
  const source = godaddySource(req);
  if (!source) return { connected: false, changed };
  const base = { connected: true, source: source.kind, account: source.kind === 'own' ? source.account : null, accounts: source.kind === 'server' ? source.accounts : null, changed };
  const current = state ?? await domainOf(project).then((r) => ('state' in r ? r.state : null));
  const d = current?.domain ? parseDomain(current.domain) : null;
  if (!d?.ok) return { ...base, plan: null };
  try {
    const key = JSON.stringify([ownerKeyOf(req), source, d.apex, current.records]);
    let kept = plans.get(project.id);
    if (kept?.key !== key || kept.until < Date.now()) {
      kept = { key, changes: await planDns(await godaddyFor(req, d.apex), d.apex, current.records), until: Date.now() + PLAN_MS };
      plans.set(project.id, kept);
    }
    const { changes } = kept;
    return {
      ...base,
      plan: {
        apex: d.apex,
        needed: changes.some((c) => c.needed),
        changes: changes.map((c) => ({ host: c.host, type: c.type, value: c.value, needed: c.needed, now: Object.entries(c.before).flatMap(([t, v]) => v.map((x) => `${t} ${x}`)) })),
      },
    };
  } catch (err) {
    if (err instanceof DnsError) return { ...base, plan: null, problem: err.message };
    throw err;
  }
}

/** @param {any} res @param {unknown} err */
function dnsFailure(res, err) {
  if (err instanceof DnsError) return res.status(err.code === 'api' ? 502 : 409).json({ error: err.message });
  throw err;
}

deployRouter.get('/:id/domain/godaddy', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  try {
    res.json(await godaddyCard(project, req));
  } catch (err) {
    dnsFailure(res, err);
  }
});

deployRouter.post('/:id/domain/godaddy', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const r = await domainOf(project);
  if ('error' in r) return res.status(r.error.status).json(r.error.body);
  const d = r.state.domain ? parseDomain(r.state.domain) : null;
  if (!d?.ok) return res.status(409).json({ error: 'Connect the domain to the site first.' });
  try {
    const client = await godaddyFor(req, d.apex);
    // Read again now, not taken from the page: the records may have changed since the card was shown.
    const changes = await planDns(client, d.apex, r.state.records);
    // Saved as each step starts, so a change that stops half way is put back exactly.
    try {
      await applyDns(client, d.apex, changes, (all) => saveDnsChange(project.id, d.apex, all));
    } finally {
      plans.delete(project.id);
    }
    const after = await domainOf(project);
    const state = 'state' in after ? after.state : r.state;
    res.json({ domain: state, godaddy: await godaddyCard(project, req, state) });
  } catch (err) {
    dnsFailure(res, err);
  }
});

deployRouter.delete('/:id/domain/godaddy', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const saved = await readDnsChange(project.id);
  if (!saved) return res.status(409).json({ error: 'Remastly has not changed anything at GoDaddy for this site.' });
  try {
    const client = await godaddyFor(req, saved.apex);
    try {
      await undoDns(client, saved.apex, saved.changes);
    } finally {
      plans.delete(project.id);
    }
    await forgetDnsChange(project.id);
    const after = await domainOf(project);
    const state = 'state' in after ? after.state : null;
    res.json({ domain: state, godaddy: await godaddyCard(project, req, state) });
  } catch (err) {
    dnsFailure(res, err);
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
  res.json({
    passThrough: passThrough && { ...passThrough, box: passThrough.target === BOX_TARGET },
    rules: passThrough ? [redirectsFor(passThrough), fallbackFor(passThrough)].filter(Boolean).join('\n') : null,
    suggestions: report ? suggestedPaths(report) : [],
  });
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

// ---- Move logins and data to Remastly: the website's back office in a box (boxes/) ----

/** The domain the box answers to: the one the live site has, else the original's. @param {any} project */
const boxDomainOf = async (project) => (await hostsOf(project.id)).primary ?? new URL(project.url).hostname;

/** What the card shows; while the server cannot run boxes, the owner sees how to set it up. @param {any} project @param {any} req */
async function boxCard(project, req) {
  const passThrough = await readPassThrough(project.id);
  const available = await dockerAvailable();
  return {
    available,
    setup: !available && isOwner(req) ? boxSetup({ user: os.userInfo().username }) : null,
    box: await boxState(project.id),
    domain: await boxDomainOf(project),
    usedForLogins: passThrough?.target === BOX_TARGET,
    limits: { uploadMB: Math.round(BOX_LIMITS.uploadBytes / 1024 / 1024), files: BOX_LIMITS.files },
  };
}

/** A BoxError as the card shows it; anything else is the app's own failure. @param {any} res @param {unknown} err */
function boxFailure(res, err) {
  if (err instanceof BoxError) return res.status(409).json({ error: err.message });
  throw err;
}

deployRouter.get('/:id/box', async (req, res) => {
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json(await boxCard(project, req));
});

// The file is the request body, streamed to disk (a backup is gigabytes; it is never held in memory).
deployRouter.post('/:id/box/files', async (req, res) => {
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  try {
    await addUpload(project.id, String(req.query.name ?? ''), req, Number(req.headers['content-length']) || 0);
  } catch (err) {
    return boxFailure(res, err);
  }
  res.json(await boxCard(project, req));
});

deployRouter.delete('/:id/box/files/:name', async (req, res) => {
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  try {
    await removeUpload(project.id, req.params.name);
  } catch (err) {
    return boxFailure(res, err);
  }
  res.json(await boxCard(project, req));
});

deployRouter.post('/:id/box/start', async (req, res) => {
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!(await dockerAvailable())) return res.status(409).json({ error: 'This Remastly server cannot run back offices yet. The owner sets it up once (Go live → server setup).' });
  // One back office per website: an app (apps/) answers it already.
  if (['running', 'starting'].includes((await appState(project.id)).status)) return res.status(409).json({ error: 'This website already runs its own app on Remastly. Remove it first.' });
  try {
    await startBox(project.id, { domain: await boxDomainOf(project), replace: req.body?.replace === true });
  } catch (err) {
    return boxFailure(res, err);
  }
  res.status(202).json(await boxCard(project, req));
});

deployRouter.post('/:id/box/use', async (req, res) => {
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!(await hasBox(project.id))) return res.status(409).json({ error: 'Make the box first.' });
  // The paths already passed on stay (an app path the owner listed), now answered by the box, with WordPress's own.
  const before = await readPassThrough(project.id);
  const paths = [...new Set([...WORDPRESS_PATHS, ...(before?.paths ?? [])])];
  await savePassThrough(project.id, { target: BOX_TARGET, paths });
  res.json(await boxCard(project, req));
});

deployRouter.delete('/:id/box', async (req, res) => {
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  try {
    await deleteBox(project.id);
  } catch (err) {
    return boxFailure(res, err);
  }
  // Nothing answers there any more.
  if ((await readPassThrough(project.id))?.target === BOX_TARGET) await savePassThrough(project.id, null);
  res.json(await boxCard(project, req));
});

// ---- Step 4: go back ----

deployRouter.post('/:id/deploy/:deploymentId/restore', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!UUID.test(req.params.deploymentId)) return res.status(404).json({ error: 'Deploy not found.' });
  if (deployRunning(project.id)) return res.status(409).json({ error: 'This website is being deployed right now. Wait for it to finish.' });
  const found = restorable(project.id, req.params.deploymentId);
  if (!found) return res.status(409).json({ error: 'Only an earlier finished deploy of the site that is live now can be put back.' });
  if (found.live.hosting === 'server') {
    // Its release is still on disk unless it was pruned (the newest few are kept).
    try {
      await switchRelease(project.id, found.row.deploy_id);
    } catch {
      return res.status(409).json({ error: 'That version is no longer kept on the server (only the newest few are). Put back a newer one.' });
    }
    return res.json({ deployment: insertRestored(found.row) });
  }
  const token = connectionToken(found.live.ownerKey, 'netlify');
  if (!token) return res.status(409).json({ error: found.live.hosting === 'remastly' ? 'Remastly hosting is turned off, so nothing can be put back. Ask the owner to set it up again.' : 'The Netlify account this site is on is no longer connected. Connect it again first.' });
  try {
    const dep = await netlifyClient(token).restoreDeploy(found.row.site_id, found.row.deploy_id);
    if (dep.state && dep.state !== 'ready' && dep.state !== 'unknown') return res.status(502).json({ error: `Netlify did not put it back (state "${dep.state}"). Try again.` });
    res.json({ deployment: insertRestored(found.row) });
  } catch (err) {
    hostingFailure(res, err);
  }
});

// ---- Form entries saved by Remastly ----

const SHOWN_ENTRIES = 50;

/** What the Form entries card shows. @param {any} project */
async function formsState(project) {
  const state = await formsEndpointOf(project.id);
  // The latest copy says how many of its forms sent to the original's own server (the ones saved here once connected).
  const row = /** @type {any} */ (latestDoneCopy.get(project.id));
  const report = row?.result_json ? JSON.parse(row.result_json) : null;
  const entries = await listEntries(project.id);
  return {
    enabled: state.enabled,
    email: state.email,
    // Live sites can send here only when this Remastly has a public address (not a laptop's localhost).
    reachable: state.reachable,
    connected: Boolean(state.endpoint),
    forms: formCounts(report?.asIs?.formRoutes ?? []).waiting,
    count: entries.length,
    entries: entries.slice(0, SHOWN_ENTRIES),
  };
}

deployRouter.get('/:id/forms', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json(await formsState(project));
});

deployRouter.put('/:id/forms', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const change = {};
  if (typeof req.body?.enabled === 'boolean') change.enabled = req.body.enabled;
  if (typeof req.body?.email === 'boolean') change.email = req.body.email;
  await saveFormSettings(project.id, change);
  res.json(await formsState(project));
});

deployRouter.get('/:id/forms/entries.csv', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  let host = 'site';
  try { host = new URL(project.url).hostname.replace(/[^a-z0-9.-]/gi, ''); } catch { /* default */ }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${host}-form-entries.csv"`);
  // A byte-order mark, so a spreadsheet reads the text as UTF-8 (names with accents, other scripts).
  res.send(`\ufeff${entriesCsv(await listEntries(project.id))}`);
});

deployRouter.delete('/:id/forms/entries/:entryId', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!UUID.test(req.params.entryId)) return res.status(404).json({ error: 'Entry not found.' });
  if (!(await removeEntry(project.id, req.params.entryId))) return res.status(404).json({ error: 'Entry not found.' });
  res.json(await formsState(project));
});

deployRouter.post('/:id/forms/import', express.raw({ type: () => true, limit: IMPORT_LIMITS.bytes }), async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a CSV file to import.' });
  const read = entriesFromRows(parseCsv(req.body.toString('utf8')));
  if ('error' in read) return res.status(400).json({ error: read.error });
  const kept = await importEntries(project.id, read.entries);
  if ('full' in kept) return res.status(507).json({ error: 'This website cannot keep that many entries. Remove older ones or import a smaller file.' });
  res.json({ ...(await formsState(project)), imported: { ...kept, dateColumn: read.dateColumn, pageColumn: read.pageColumn } });
});

deployRouter.delete('/:id/forms/imports/:importId', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!UUID.test(req.params.importId)) return res.status(404).json({ error: 'Import not found.' });
  const removed = await removeImport(project.id, req.params.importId);
  if (!removed) return res.status(404).json({ error: 'Import not found.' });
  res.json({ ...(await formsState(project)), removed });
});

// ---- Can I switch off the old server? ----

deployRouter.get('/:id/switch-off', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const live = liveSiteOf(project.id);
  // Where the domain points is asked of the host (DNS records and its site); only once the copy is online.
  let domain = null;
  let domainError = null;
  if (live) {
    try {
      const r = await domainOf(project);
      if ('error' in r) domainError = r.error.body.error;
      else domain = r.state;
    } catch (err) {
      if (!(err instanceof HostingError)) throw err;
      domainError = err.message;
    }
  }
  const row = /** @type {any} */ (latestDoneCopy.get(project.id));
  const report = row?.result_json ? withAsIsSafety(JSON.parse(row.result_json)) : null;
  const entries = await listEntries(project.id);
  const passThrough = await readPassThrough(project.id);
  const snapshot = await readSnapshot(project.id);
  res.json(switchOffCheck({
    live, domain, domainError, report, passThrough,
    // The website's back office on Remastly: its WordPress box, or its app (apps/).
    boxRunning: passThrough?.target === BOX_TARGET && (((await hasBox(project.id)) && (await boxRunning(project.id))) || ((await hasApp(project.id)) && (await appRunning(project.id)))),
    appCalls: unansweredAppCalls(report, { passThrough, snapshotAddresses: (snapshot?.items ?? []).map((i) => i.address) }),
    snapshot: snapshot?.items.length ? { takenAt: snapshot.takenAt, count: snapshot.items.length } : null,
    formsWaiting: formCounts(report?.asIs?.formRoutes ?? []).waiting,
    formsSaved: Boolean((await formsEndpointOf(project.id)).endpoint),
    imported: entries.filter((e) => e.importId).length,
  }));
});

// ---- Content snapshot ----

/** What the Content card shows. @param {any} project */
async function snapshotState(project) {
  const row = /** @type {any} */ (latestDoneCopy.get(project.id));
  const report = row?.result_json ? JSON.parse(row.result_json) : null;
  const snapshot = await readSnapshot(project.id);
  return { calls: appCallsOf(report), snapshot, shadowed: (await snapshotForDeploy(project.id))?.shadowed ?? [] };
}

deployRouter.get('/:id/snapshot', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json(await snapshotState(project));
});

deployRouter.post('/:id/snapshot', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const { calls } = await snapshotState(project);
  if (!calls.length) return res.status(409).json({ error: 'The copy asks the old site for no data, so there is nothing to save.' });
  // Asked of the old app's own address when one is set (Logins and data): once the domain points to the copy, the site's own
  // address answers with the copy, not with the old app.
  const passThrough = await readPassThrough(project.id);
  const origin = passThrough && passThrough.target !== BOX_TARGET ? passThrough.target : new URL(project.url).origin;
  await takeSnapshot(project.id, origin, calls);
  res.json(await snapshotState(project));
});

deployRouter.delete('/:id/snapshot', async (req, res) => {
  if (notReady(res)) return;
  const project = /** @type {any} */ (selectProject.get(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  await removeSnapshot(project.id);
  res.json(await snapshotState(project));
});
