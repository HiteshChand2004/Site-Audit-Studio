// @ts-check
// Puts the agent's prompt together from the selected modules, the context pack and the confirmed brief. No model runs here.
// Order follows the prompt cache (a prefix match): system = the fixed core + the playbooks this kind of request gets (the same
// for every request of that kind), then the project's context pack (the same for every change on the project), then what this
// one request wants. Each of the first two ends in a cache breakpoint.
import { TASKS } from './schemas.js';
import { asData } from './context.js';

/** @typedef {import('./library.js').BuildModule} BuildModule */

const ROLE = 'You are the build agent of Site Audit Studio. You build and change websites by editing the files of one project, '
  + 'and you hold yourself to the standard of an expert studio: every page you ship is designed, written, accessible, fast and '
  + 'findable. The sections below are the playbooks chosen for this request; follow all of them.';

export class ComposeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * Checks an understanding (from the model, or edited by the user before composing) against the library's choices.
 * @param {any} u
 * @param {import('./library.js').Library} library
 */
export function checkUnderstanding(u, library) {
  if (!u || typeof u !== 'object') throw new ComposeError('understanding is missing.');
  if (!TASKS.includes(u.task)) throw new ComposeError(`understanding.task must be one of: ${TASKS.join(', ')}.`);
  for (const [field, kind] of [['site_type', 'site'], ['goal', 'goal']]) {
    if (!library.ids(kind).includes(u[field])) throw new ComposeError(`understanding.${field} must be one of: ${library.ids(kind).join(', ')}.`);
  }
  for (const field of ['pages', 'must_haves', 'keep_unchanged', 'facts', 'unknowns', 'questions']) {
    if (u[field] != null && !Array.isArray(u[field])) throw new ComposeError(`understanding.${field} must be a list.`);
  }
  const quality = library.ids('quality');
  const focus = (u.quality_focus ?? []).filter((q) => quality.includes(q));
  return { ...u, quality_focus: focus };
}

// How long the owner's edits to the brief may be (the Review step edits each section's name and text, and the requirements).
export const MAX_SECTION_NAME = 200;
export const MAX_SECTION_TEXT = 6000;
export const MAX_REQUIREMENT_TEXT = 2000;

/** Checks a brief (from the model, or edited by the user) has what the agent and the verify step rely on. */
export function checkBrief(/** @type {any} */ b) {
  if (!b || typeof b !== 'object') throw new ComposeError('brief is missing.');
  if (!Array.isArray(b.pages) || !b.pages.length) throw new ComposeError('brief.pages must list at least one page.');
  for (const p of b.pages) {
    if (!p || typeof p !== 'object' || typeof p.path !== 'string') throw new ComposeError('Every page needs a path.');
    if (p.sections != null && !Array.isArray(p.sections)) throw new ComposeError(`The sections of page ${p.path} must be a list.`);
    for (const s of p.sections ?? []) {
      if (!s || typeof s.name !== 'string' || typeof s.content !== 'string' || !s.name.trim() || !s.content.trim()) {
        throw new ComposeError(`Every section of page ${p.path} needs a name and its text.`);
      }
      if (s.name.length > MAX_SECTION_NAME) throw new ComposeError(`A section name on page ${p.path} is longer than ${MAX_SECTION_NAME} characters.`);
      if (s.content.length > MAX_SECTION_TEXT) throw new ComposeError(`The text of "${s.name.slice(0, 60)}" on page ${p.path} is longer than ${MAX_SECTION_TEXT} characters.`);
      if (s.notes != null && typeof s.notes !== 'string') throw new ComposeError(`The notes of "${s.name.slice(0, 60)}" on page ${p.path} must be text.`);
    }
  }
  if (!Array.isArray(b.requirements) || !b.requirements.length) throw new ComposeError('brief.requirements must list at least one requirement.');
  const ids = new Set();
  for (const r of b.requirements) {
    if (!r || typeof r.id !== 'string' || typeof r.text !== 'string') throw new ComposeError('Every requirement needs an id and a text.');
    if (r.text.length > MAX_REQUIREMENT_TEXT) throw new ComposeError(`Requirement ${r.id} is longer than ${MAX_REQUIREMENT_TEXT} characters.`);
    if (ids.has(r.id)) throw new ComposeError(`Requirement ${r.id} is listed twice.`);
    ids.add(r.id);
  }
  return b;
}

/**
 * The design direction the agent follows: the one the user chose, or the only one there is.
 * @param {any} brief
 * @param {number | undefined} choice  index into brief.design.directions
 */
export function pickDirection(brief, choice) {
  const directions = brief.design?.directions ?? [];
  if (choice != null) {
    if (!Number.isInteger(choice) || !directions[choice]) throw new ComposeError(`direction must be 0–${Math.max(0, directions.length - 1)}.`);
    return { direction: directions[choice], needsChoice: false };
  }
  return { direction: directions[0] ?? null, needsChoice: directions.length > 1 };
}

const list = (/** @type {string[] | undefined} */ items, empty = 'None.') => (items?.length ? items.map((i) => `- ${i}`).join('\n') : empty);

/**
 * The brief as the agent reads it: what to build, in the chosen direction, against numbered requirements.
 * answers: the owner's answers to the plan's questions, given on the Review step (they need no new plan).
 */
export function renderBrief(/** @type {any} */ brief, /** @type {any} */ understanding, /** @type {any} */ direction, /** @type {string | undefined} */ answers) {
  const out = [`# Summary\n${brief.summary ?? ''}`];
  out.push(`# Audience and tone\nAudience: ${understanding.audience || 'not stated'}\nTone: ${understanding.tone || 'not stated'}\nMain goal: ${understanding.goal}`);
  out.push(`# Facts you may use (never invent others)\n${list(understanding.facts)}`);
  if (answers) out.push(`# The owner's answers to the plan's questions (facts you may use; where the brief says otherwise, follow these)\n${answers}`);
  const design = [`Mode: ${brief.design?.mode ?? 'new'}`];
  if (brief.design?.existing_notes) design.push(`Existing design: ${brief.design.existing_notes}`);
  if (direction) {
    design.push(
      `Direction: ${direction.name}`,
      `Palette: ${(direction.palette ?? []).map((c) => `${c.role} ${c.hex}`).join(', ')}`,
      `Fonts: headings ${direction.fonts?.heading}, body ${direction.fonts?.body}`,
      `Layout: ${direction.layout}`, `Imagery: ${direction.imagery}`, `Motion: ${direction.motion}`, `Why: ${direction.why}`,
    );
    // The ingredients that make this site unlike any other: the build must show every one of them, interpreted as the brief does.
    if (direction.ingredients) {
      design.push('Signature (what makes this site unlike any other; every one must be visible in the result):',
        ...Object.entries(direction.ingredients).map(([k, v]) => `- ${k}: ${v}`));
    }
  }
  out.push(`# Design\n${design.join('\n')}`);
  out.push(`# Pages\n${brief.pages.map((p) => [
    `## ${p.path} — ${p.title}`, `Description: ${p.description}`, `Purpose: ${p.purpose}`,
    ...(p.sections ?? []).map((s, i) => `${i + 1}. ${s.name}: ${s.content}${s.notes ? ` (${s.notes})` : ''}`),
  ].join('\n')).join('\n\n')}`);
  out.push(`# Requirements (report on each by id in finish)\n${brief.requirements.map((r) => `- ${r.id}: ${r.text}${r.check ? `\n  Check: ${r.check}` : ''}`).join('\n')}`);
  out.push(`# Keep unchanged\n${list(brief.keep_unchanged ?? understanding.keep_unchanged)}`);
  out.push(`# Placeholders (show as marked placeholders, list them in finish)\n${list(brief.placeholders)}`);
  out.push(`# Structured data\n${list(brief.structured_data)}`);
  return out.join('\n\n');
}

/**
 * The agent prompt for one request, ready for the Messages API (system blocks + the first user message), plus a record of
 * which module versions shaped it.
 * @param {{ selected: { module: BuildModule, reason: string }[], context: { text: string }, understanding: any, brief: any,
 *   description: string, direction?: number, answers?: string }} o
 */
export function composePrompt({ selected, context, understanding, brief, description, direction, answers }) {
  const picked = pickDirection(brief, direction);
  const playbooks = selected.map(({ module: m }) => `## ${m.title}\n${m.body}`).join('\n\n');
  const system = [
    { type: 'text', text: `${ROLE}\n\n${playbooks}`, cache_control: { type: 'ephemeral' } },
  ];
  const request = `<user_request>\n${asData(description)}\n</user_request>\n<build_brief>\n${asData(renderBrief(brief, understanding, picked.direction, answers))}\n</build_brief>`;
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: context.text, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `${request}\n\n${understanding.task === 'build-new'
        ? 'Build it now. Start by reading what is in the project, then work through the requirements.'
        : 'This site already exists. Before changing anything, read it: <site_content> and <source_code> above, and the files in the project with the tools. Then do the work the brief asks for, keeping everything it does not change, and work through the requirements.'}` },
    ],
  }];
  return {
    system,
    messages,
    modules: selected.map(({ module: m, reason }) => ({ kind: m.kind, id: m.id, version: m.version, title: m.title, reason })),
    direction: picked.direction,
    needsChoice: picked.needsChoice,
  };
}
