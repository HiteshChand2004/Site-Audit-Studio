// @ts-check
// One deploy of a finished copy to Netlify: package the served folder → the website's own Netlify site (made on the first deploy,
// reused after) → upload the zip → wait until Netlify says it is live. Network work only, no browser: it does not take the job
// lock, so a copy or a comparison of another website keeps running. One deploy per website at a time. Every step is written to
// the row, so the app follows it by asking again (GET …/deploy); a step that fails ends the deploy with a message to show.
import { recreateDir } from '../recreate/workspace.js';
import { planDeploy, zipToTemp } from './bundle.js';
import { HostingError, netlifyClient, PENDING_STATES } from './netlify.js';
import { failInterrupted, siteOfProject, updateDeployment } from './store.js';

/** Deploys this process is working on: deployment id → project id. */
const running = new Map();

export const deployRunning = (projectId) => [...running.values()].includes(projectId);

let recovered = false;
/** Once per start: rows a stopped server left as running are failed. */
export function recoverDeploys() {
  if (recovered) return;
  recovered = true;
  failInterrupted(new Set(running.keys()));
}

export const DEPLOY_LIMITS = { pollMs: 2000, waitMs: 10 * 60_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ deployment: { id: string }, projectId: string, recreateId: string, report: any, stack: string, token: string, ownerKey: string }} o
 * @returns {Promise<void>}  never rejects: the outcome is in the row
 */
export async function runDeploy({ deployment, projectId, recreateId, report, stack, token, ownerKey }) {
  const id = deployment.id;
  running.set(id, projectId);
  let zip = null;
  try {
    updateDeployment(id, { status: 'running', step: 'package' });
    const plan = await planDeploy({ dir: recreateDir(projectId, recreateId), report, stack });
    zip = await zipToTemp(plan);
    updateDeployment(id, { files: plan.files, bytes: plan.bytes, step: 'site' });

    const netlify = netlifyClient(token);
    let site = null;
    const known = siteOfProject(projectId, 'netlify', ownerKey);
    if (known) {
      // The site may have been deleted in Netlify since: then this website gets a new one.
      site = await netlify.site(known).catch((err) => {
        if (err instanceof HostingError && err.code === 'not-found') return null;
        throw err;
      });
    }
    site ??= await netlify.createSite();
    updateDeployment(id, { siteId: site.id, siteName: site.name, adminUrl: site.adminUrl, url: site.url, step: 'upload' });

    let dep = await netlify.deployZip(site.id, zip);
    updateDeployment(id, { deployId: dep.id, deployUrl: dep.deployUrl, step: 'publish' });
    const until = Date.now() + DEPLOY_LIMITS.waitMs;
    while (dep.state !== 'ready' && dep.state !== 'error' && PENDING_STATES.has(dep.state)) {
      if (Date.now() > until) throw new HostingError('Netlify took more than 10 minutes to publish the site. It may still finish: check the site in Netlify, or deploy again.', { code: 'slow' });
      await sleep(DEPLOY_LIMITS.pollMs);
      dep = await netlify.deploy(dep.id);
    }
    if (dep.state !== 'ready') throw new HostingError(`Netlify could not publish the site${dep.error ? `: ${dep.error}` : ` (state "${dep.state}")`}.`, { code: 'deploy-error' });
    updateDeployment(id, { status: 'ready', step: 'done', url: site.url ?? dep.url, deployUrl: dep.deployUrl, finishedAt: new Date().toISOString() });
  } catch (err) {
    const known = err instanceof HostingError || /** @type {any} */ (err)?.name === 'DeployError';
    if (!known) console.error(`[deploy ${id}]`, err);
    updateDeployment(id, {
      status: 'failed',
      error: known ? /** @type {Error} */ (err).message : 'Something went wrong while deploying (the server log has the details). Try again.',
      finishedAt: new Date().toISOString(),
    });
  } finally {
    running.delete(id);
    await zip?.done().catch(() => {});
  }
}
