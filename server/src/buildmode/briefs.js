// @ts-check
// Website prompts from Growth OS (docs/GROWTHOS-INTEGRATION.md, "Website prompt for Build mode"). Growth OS writes ONE prompt
// for a whole website from its insights; here it becomes a saved site of Build mode (sites.js) for the owner of that website in
// Remastly: "An existing website" → "Its live site", the site's own technology kept, the prompt as the description. Nothing is
// planned or built here: the owner opens it in Build mode (/app/?buildSite=<id>), reads it, and presses Continue as with any
// site they describe themselves. Growth OS asks for its status (described → planned → building → built) with GET.
import { accountsEnabled } from '../config/index.js';
import { findProject } from '../changes/site.js';
import { absolute } from '../changes/config.js';
import { createSite, listSites, siteById, summarize } from './sites.js';
import { listBuilds } from './builds.js';

export const PROMPT_MAX = 8000; // Build mode's description limit (client BuildMode.jsx MAX_DESCRIPTION)
const REQUEST_ID = /^[\w:.#@/ -]{1,200}$/;

export class BriefError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const text = (/** @type {any} */ v) => (typeof v === 'string' ? v.trim() : '');

/** Checks a request from Growth OS. @param {any} body */
export function parseBrief(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BriefError('The request must be a JSON object.');
  const requestId = text(body.requestId);
  if (!REQUEST_ID.test(requestId)) throw new BriefError('"requestId" is needed (1–200 letters, digits or : . # @ / - _).');
  const url = text(body.site?.url);
  const projectId = text(body.site?.projectId) || null;
  if (!url && !projectId) throw new BriefError('"site.url" (the website\'s address) is needed.');
  const prompt = typeof body.prompt === 'string' ? body.prompt.replace(/\r\n?/g, '\n').trim() : '';
  if (!prompt) throw new BriefError('"prompt" is empty.');
  if (prompt.length > PROMPT_MAX) throw new BriefError(`"prompt" is ${prompt.length.toLocaleString('en')} characters; Build mode takes at most ${PROMPT_MAX.toLocaleString('en')}.`);
  return { requestId, url, projectId, prompt, venture: text(body.context?.venture).slice(0, 80) || null };
}

/** The saved site's state, as the app saves one the owner described (BuildMode.jsx snapshot, v2). */
export function briefState(/** @type {any} */ project, /** @type {ReturnType<typeof parseBrief>} */ b, now = new Date().toISOString()) {
  return {
    v: 2,
    step: 'start',
    draft: { source: 'url', siteUrl: project.url, authorized: true, code: 'copy', githubUrl: '', githubRef: '', stack: '', stackName: '', description: b.prompt },
    details: { name: `${project.name || project.url} · from Growth OS` },
    images: [],
    request: null,
    plan: null,
    review: null,
    runId: null,
    growthos: { requestId: b.requestId, venture: b.venture, projectId: project.id, sentAt: now },
  };
}

const ownerOf = (/** @type {any} */ project) => (accountsEnabled() ? project.owner_id ?? null : null);

/** Where a saved site stands, for Growth OS. @param {any} site */
export async function briefView(site) {
  const s = summarize(site);
  const builds = await listBuilds(site.ownerId ?? null, [...(s.runs ?? [])].reverse());
  const last = builds[0] ?? null;
  const status = last ? ({ running: 'building', done: 'built', stopped: 'stopped' }[last.status] ?? 'failed') : s.step === 'start' ? 'described' : 'planned';
  return {
    id: site.id,
    requestId: site.state?.growthos?.requestId ?? null,
    status,
    step: s.step,
    openUrl: absolute(`/app/?buildSite=${site.id}`),
    previewUrl: last?.previewUrl ? (/^https?:/.test(last.previewUrl) ? last.previewUrl : absolute(last.previewUrl)) : null,
    publishedUrl: last?.publishedUrl ?? null,
    message: last?.error ?? null,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

/**
 * A website prompt from Growth OS → a saved site in Build mode. The same requestId again returns the site already made.
 * @returns {Promise<{ site: any, existing: boolean }>}
 */
export async function submitBrief(/** @type {any} */ body, { find = findProject } = {}) {
  const b = parseBrief(body);
  const project = find({ projectId: b.projectId, siteUrl: b.url });
  if (!project) throw new BriefError('No website in Remastly with that address. Add the website in Remastly first.', 404);
  const ownerId = ownerOf(project);
  const same = (await listSites(ownerId)).find((x) => x.state?.growthos?.requestId === b.requestId);
  if (same) return { site: same, existing: true };
  return { site: await createSite({ ownerId, state: briefState(project, b) }), existing: false };
}

/** A site Growth OS sent (null for any other saved site, so the key cannot read the owner's own ones). */
export async function sentBrief(/** @type {string} */ id) {
  const site = await siteById(id);
  return site?.state?.growthos ? site : null;
}
