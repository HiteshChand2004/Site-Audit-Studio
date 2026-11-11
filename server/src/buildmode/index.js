// @ts-check
// Build mode, entry point. A request = where the site comes from (scratch, a website already checked in the app, or uploaded
// source files), an optional stack, and the owner's description. planBuild() runs the whole prompting pipeline:
//   context pack (no model) → understand (model) → pick playbooks (no model) → brief (model) → compose the agent prompt (no model)
// composeBuild() redoes only the last step, for a brief the owner edited, a design direction they chose or their answers to the
// plan's questions (they go into the agent's brief as they are, so answering needs no new plan): no model, no cost.
// A plan counts toward the owner's day (spend.js) and is refused once the day's budget is used up.
// The agent that executes the prompt is the next step of this feature; everything it needs is in the returned `prompt`.
import { loadLibrary, selectModules } from './library.js';
import { buildContext, ContextError } from './context.js';
import { checkBrief, checkUnderstanding, composePrompt, ComposeError } from './compose.js';
import { understand, writeBrief } from './steps.js';
import { createLlm } from './llm.js';
import { planVariety, recordDesigns } from './variety.js';
import { checkDetails, checkImageList, ownerFacts, withOwnerFacts } from './details.js';
import { checkDailyBudget, costOf, recordSpend, roundUsd } from './spend.js';

export { ContextError } from './context.js';
export { ComposeError } from './compose.js';
export { LlmError } from './llm.js';

/** @typedef {import('./library.js').Library} Library */

export const MAX_DESCRIPTION = 8000;
export const MAX_ANSWERS = 4000;

/** @type {Library | null} */
let shared = null;
/** The module library, read once per process. */
export const library = () => (shared ??= loadLibrary());

/**
 * @typedef {{ input: any, stack?: string, stackName?: string, description: string, answers?: string, details?: Record<string, string>,
 *   images?: { role: 'photo' | 'logo', alt?: string, id?: string }[] }} BuildRequest
 *   stackName: the technology's name when stack is "other" (one without a playbook of its own); details / images: what the owner
 *   told about their business and the photos they added (details.js), facts for the plan
 * @typedef {{ library?: Library, llm?: import('./llm.js').Llm, loadProject?: (id: string) => { project: any, audit: any } | null,
 *   fetchGithub?: (github: any) => Promise<any>, readSite?: (url: string) => Promise<any>,
 *   planVariety?: typeof planVariety, recordDesigns?: typeof recordDesigns, ownerId?: string | null }} BuildDeps
 *   ownerId: who asks (null without accounts); their own earlier designs are kept furthest away (variety.js)
 */

function checkRequest(/** @type {any} */ req) {
  const description = typeof req?.description === 'string' ? req.description.trim() : '';
  if (!description) throw new ContextError('Describe what you want in "description".');
  if (description.length > MAX_DESCRIPTION) throw new ContextError(`The description is longer than ${MAX_DESCRIPTION} characters.`);
  if (req.answers != null && typeof req.answers !== 'string') throw new ContextError('"answers" must be text.');
  if (req.answers?.trim().length > MAX_ANSWERS) throw new ContextError(`The answers are longer than ${MAX_ANSWERS} characters.`);
  return { description, answers: req.answers?.trim() || undefined, details: checkDetails(req.details), images: checkImageList(req.images) };
}

/**
 * The whole prompting pipeline for one request.
 * @param {BuildRequest} request
 * @param {BuildDeps} [deps]
 */
export async function planBuild(request, deps = {}) {
  const lib = deps.library ?? library();
  const { description, answers, details, images } = checkRequest(request);
  const ownerId = deps.ownerId ?? null;
  await checkDailyBudget(ownerId);
  // The owner's own facts (the details form, their photos): data for both model steps, and always among the plan's facts.
  const facts = ownerFacts(details, images);
  const context = await buildContext({ input: request.input, stack: request.stack, stackName: request.stackName, stacks: lib.ids('stack'), loadProject: deps.loadProject, fetchGithub: deps.fetchGithub, readSite: deps.readSite });
  const llm = deps.llm ?? createLlm();
  const step1 = await understand({ llm, library: lib, context, description, answers, facts });
  await recordSpend(ownerId, costOf(step1.usage, step1.model));
  step1.understanding.facts = withOwnerFacts(step1.understanding.facts, facts);
  const selected = selectModules(lib, step1.understanding, { input: context.input, stack: context.stack });
  const variety = step1.understanding.task === 'build-new' ? await (deps.planVariety ?? planVariety)({ ownerId }) : undefined;
  const step2 = await writeBrief({ llm, selected, context, understanding: step1.understanding, description, answers, facts, variety });
  await recordSpend(ownerId, costOf(step2.usage, step2.model));
  // Every direction offered is remembered, built or not, so the next plan (this owner's or anyone's) looks different again.
  if (variety) await (deps.recordDesigns ?? recordDesigns)({ directions: step2.brief.design?.directions, siteType: step1.understanding.site_type, ownerId }).catch(() => {});
  const prompt = composePrompt({ selected, context, understanding: step1.understanding, brief: step2.brief, description, answers });
  return {
    setup: { input: context.input, stack: context.stack, ...(context.stackName && { stackName: context.stackName }), stackSource: context.stackSource, site: context.site },
    understanding: step1.understanding,
    brief: step2.brief,
    prompt,
    usage: { model: llm.model, understand: step1.usage, brief: step2.usage, costUsd: roundUsd(costOf(step1.usage, step1.model) + costOf(step2.usage, step2.model)) },
  };
}

/**
 * Composes the agent prompt again from an understanding and brief the caller already has (edited or not), with the chosen
 * design direction and the owner's answers. No model runs (a GitHub repository is read again, so the prompt always reflects the code).
 * @param {BuildRequest & { understanding: any, brief: any, direction?: number }} request
 * @param {BuildDeps} [deps]
 */
export async function composeBuild(request, deps = {}) {
  const lib = deps.library ?? library();
  const { description, answers } = checkRequest(request);
  const context = await buildContext({ input: request.input, stack: request.stack, stackName: request.stackName, stacks: lib.ids('stack'), loadProject: deps.loadProject, fetchGithub: deps.fetchGithub, readSite: deps.readSite });
  const understanding = checkUnderstanding(request.understanding, lib);
  if (context.input === 'scratch' && understanding.task !== 'build-new') throw new ComposeError('A site built from scratch has the task build-new.');
  if (context.input !== 'scratch' && understanding.task === 'build-new') throw new ComposeError('An existing site cannot have the task build-new.');
  const brief = checkBrief(request.brief);
  const selected = selectModules(lib, understanding, { input: context.input, stack: context.stack });
  return {
    setup: { input: context.input, stack: context.stack, ...(context.stackName && { stackName: context.stackName }), stackSource: context.stackSource, site: context.site },
    prompt: composePrompt({ selected, context, understanding, brief, description, direction: request.direction, answers }),
  };
}
