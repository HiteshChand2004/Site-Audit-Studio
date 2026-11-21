// @ts-check
// Puts an approved change live. Where: the website's Go live place when it has one (the same Netlify site or Remastly's own
// server it went live on, else the default Go live would pick), through Go live's own deploy (deploy/run.js) with the change's
// folder; or, on a computer with no hosting (SAS_CHANGES_PUBLISH=local, or nothing set up), at this Remastly's own address
// /live/<slug>/, which keeps one address per website and always shows its newest published change.
import { hostingIp } from '../config/index.js';
import { runDeploy } from '../deploy/run.js';
import { connectionToken, deployReady, getConnection, getDeployment, insertDeployment, liveSiteOf, REMASTLY, SERVER } from '../deploy/store.js';
import { hostsOf } from '../hosting/store.js';
import { absolute, publishMode } from './config.js';
import { changeDeploySource, changeSiteDir } from './site.js';
import { changeRow, liveBySlug, setLive } from './store.js';

export const LIVE_PREFIX = '/live';
const SLUG = /^[A-Za-z0-9_-]{16}$/;

export class PublishError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PublishError';
  }
}

/** The local live address's folder for the preview router (mounted at LIVE_PREFIX). @param {string} slug */
export async function resolveLive(slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) return null;
  const row = liveBySlug(slug);
  if (!row) return null;
  return { root: changeSiteDir(row.project_id, row.change_id), kind: /** @type {'as-is'} */ ('as-is'), scripts: true };
}
export const livePath = (/** @type {string} */ slug) => `${LIVE_PREFIX}/${slug}/`;

/**
 * Where a website's change goes live.
 * @param {string} projectId @param {string} ownerKeyOfApprover  'local' while accounts are off, else the approver's id
 * @returns {Promise<{ kind: 'local' } | { kind: 'deploy', ownerKey: string, token: string | null, provider: 'server' | 'netlify' }>}
 */
export async function publishTarget(projectId, ownerKeyOfApprover) {
  const mode = publishMode();
  if (mode === 'local') return { kind: 'local' };
  const hostingReady = deployReady();
  if (hostingReady) {
    const live = liveSiteOf(projectId);
    if (live?.ownerKey === SERVER && hostingIp() && (await hostsOf(projectId)).primary) return { kind: 'deploy', ownerKey: SERVER, token: null, provider: 'server' };
    if (live && live.ownerKey !== SERVER) {
      const token = connectionToken(live.ownerKey, 'netlify');
      if (token) return { kind: 'deploy', ownerKey: live.ownerKey, token, provider: 'netlify' };
    }
    if (hostingIp() && (await hostsOf(projectId)).primary) return { kind: 'deploy', ownerKey: SERVER, token: null, provider: 'server' };
    if (getConnection(REMASTLY, 'netlify')) return { kind: 'deploy', ownerKey: REMASTLY, token: connectionToken(REMASTLY, 'netlify'), provider: 'netlify' };
    const own = connectionToken(ownerKeyOfApprover, 'netlify');
    if (own) return { kind: 'deploy', ownerKey: ownerKeyOfApprover, token: own, provider: 'netlify' };
  }
  if (mode === 'hosting') throw new PublishError('No place to put it live: this website has not gone live from Remastly, and no Netlify account or Remastly server is set up (Go live).');
  return { kind: 'local' };
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** The full address of a page under a site's root address. */
const under = (/** @type {string} */ base, /** @type {string | null} */ page) => `${base.replace(/\/+$/, '')}${page && page !== '/' ? page : '/'}`;

/**
 * Publishes a change (its row must be 'publishing'). Resolves with where it is live; throws PublishError.
 * @param {string} changeId @param {{ ownerKey?: string, pollMs?: number }} [o]
 * @returns {Promise<{ liveUrl: string, deploymentId: string | null, where: string }>}
 */
export async function publishChange(changeId, { ownerKey = 'local', pollMs = 1500 } = {}) {
  const row = changeRow(changeId);
  if (!row) throw new PublishError('No such change.');
  const result = row.result_json ? JSON.parse(row.result_json) : {};
  const page = result.servedAt ?? row.page;
  const target = await publishTarget(row.project_id, ownerKey);
  if (target.kind === 'local') {
    const live = setLive(row.project_id, row.id);
    return { liveUrl: absolute(under(livePath(live.slug), page)), deploymentId: null, where: 'this Remastly (local address)' };
  }
  const stack = result.stack ?? 'html';
  const source = changeDeploySource(row.project_id, row.id, stack);
  const deployment = insertDeployment({ projectId: row.project_id, recreateId: row.base_recreate, stack, provider: target.provider, ownerKey: target.ownerKey });
  if (!deployment) throw new PublishError('The deploy could not be recorded.');
  await runDeploy({
    deployment, projectId: row.project_id, recreateId: row.base_recreate, report: source.report, stack, token: target.token, ownerKey: target.ownerKey,
    dir: source.dir,
  });
  // runDeploy resolves once the deploy has finished either way; the row says how
  let d = getDeployment(deployment.id);
  for (let i = 0; i < 5 && d && !['ready', 'failed'].includes(d.status); i++) {
    await sleep(pollMs);
    d = getDeployment(deployment.id);
  }
  if (!d || d.status !== 'ready') throw new PublishError(d?.error ?? 'The deploy did not finish.');
  if (!d.url) throw new PublishError('The deploy finished but has no address.');
  return { liveUrl: under(d.url, page), deploymentId: d.id, where: target.provider === 'server' ? 'Remastly\'s server' : 'Netlify' };
}
