// @ts-check
// Build mode, entry point. A request = where the site comes from (scratch, a website already checked in the app, or uploaded
// source files), an optional stack, and the owner's description. planBuild() runs the whole prompting pipeline:
//   context pack (no model) → understand (model) → pick playbooks (no model) → brief (model) → compose the agent prompt (no model)
// composeBuild() redoes only the last step, for a brief the owner edited or a design direction they chose: no model, no cost.
// The agent that executes the prompt is the next step of this feature; everything it needs is in the returned `prompt`.
import { loadLibrary, selectModules } from './library.js';
import { buildContext, ContextError } from './context.js';
import { checkBrief, checkUnderstanding, composePrompt, ComposeError } from './compose.js';
import { understand, writeBrief } from './steps.js';
import { createLlm } from './llm.js';

export { ContextError } from './context.js';
export { ComposeError } from './compose.js';
export { LlmError } from './llm.js';

/** @typedef {import('./library.js').Library} Library */

export const MAX_DESCRIPTION = 8000;

/** @type {Library | null} */
let shared = null;
/** The module library, read once per process. */
export const library = () => (shared ??= loadLibrary());

/**
 * @typedef {{ input: any, stack?: string, stackName?: string, description: string, answers?: string }} BuildRequest
 *   stackName: the technology's name when stack is "other" (one without a playbook of its own)
 * @typedef {{ library?: Library, llm?: import('./llm.js').Llm, loadProject?: (id: string) => { project: any, audit: any } | null,
 *   fetchGithub?: (github: any) => Promise<any>, readSite?: (url: string) => Promise<any> }} BuildDeps
 */

function checkRequest(/** @type {any} */ req) {
  const description = typeof req?.description === 'string' ? req.description.trim() : '';
  if (!description) throw new ContextError('Describe what you want in "description".');
  if (description.length > MAX_DESCRIPTION) throw new ContextError(`The description is longer than ${MAX_DESCRIPTION} characters.`);
  if (req.answers != null && typeof req.answers !== 'string') throw new ContextError('"answers" must be text.');
  return { description, answers: req.answers?.trim() || undefined };
}

/**
 * The whole prompting pipeline for one request.
 * @param {BuildRequest} request
 * @param {BuildDeps} [deps]
 */
export async function planBuild(request, deps = {}) {
  const lib = deps.library ?? library();
  const { description, answers } = checkRequest(request);
  const context = await buildContext({ input: request.input, stack: request.stack, stackName: request.stackName, stacks: lib.ids('stack'), loadProject: deps.loadProject, fetchGithub: deps.fetchGithub, readSite: deps.readSite });
  const llm = deps.llm ?? createLlm();
  const step1 = await understand({ llm, library: lib, context, description, answers });
  const selected = selectModules(lib, step1.understanding, { input: context.input, stack: context.stack });
  const step2 = await writeBrief({ llm, selected, context, understanding: step1.understanding, description, answers });
  const prompt = composePrompt({ selected, context, understanding: step1.understanding, brief: step2.brief, description });
  return {
    setup: { input: context.input, stack: context.stack, ...(context.stackName && { stackName: context.stackName }), stackSource: context.stackSource, site: context.site },
    understanding: step1.understanding,
    brief: step2.brief,
    prompt,
    usage: { model: llm.model, understand: step1.usage, brief: step2.usage },
  };
}

/**
 * Composes the agent prompt again from an understanding and brief the caller already has (edited or not), with the chosen
 * design direction. No model runs (a GitHub repository is read again, so the prompt always reflects the code).
 * @param {BuildRequest & { understanding: any, brief: any, direction?: number }} request
 * @param {BuildDeps} [deps]
 */
export async function composeBuild(request, deps = {}) {
  const lib = deps.library ?? library();
  const { description } = checkRequest(request);
  const context = await buildContext({ input: request.input, stack: request.stack, stackName: request.stackName, stacks: lib.ids('stack'), loadProject: deps.loadProject, fetchGithub: deps.fetchGithub, readSite: deps.readSite });
  const understanding = checkUnderstanding(request.understanding, lib);
  if (context.input === 'scratch' && understanding.task !== 'build-new') throw new ComposeError('A site built from scratch has the task build-new.');
  if (context.input !== 'scratch' && understanding.task === 'build-new') throw new ComposeError('An existing site cannot have the task build-new.');
  const brief = checkBrief(request.brief);
  const selected = selectModules(lib, understanding, { input: context.input, stack: context.stack });
  return {
    setup: { input: context.input, stack: context.stack, ...(context.stackName && { stackName: context.stackName }), stackSource: context.stackSource, site: context.site },
    prompt: composePrompt({ selected, context, understanding, brief, description, direction: request.direction }),
  };
}
