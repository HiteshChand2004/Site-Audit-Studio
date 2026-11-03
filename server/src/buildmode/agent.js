// @ts-check
// The build agent: Claude works through the composed prompt (compose.js) with three tools and writes the site into one
// folder. The loop is ours (Messages API, streamed, manual tool loop), so every tool call passes through code that confines
// it: the Anthropic-defined text editor (workspace.js) for the files, check_site for the checks the finished site must pass
// (check.js), and finish for the report. The agent has no shell and no network. A finish while the checks fail is answered
// with the failures, so the agent fixes them first (at most AGENT_LIMITS.fixRounds times). Limits on turns, output tokens
// and time keep a run from going on forever; a stop signal ends it between steps.
import { BUILD_MODEL, FALLBACK_BETA, LlmError, explainError, loadSdk } from './llm.js';
import { ToolError, listFiles, runEditor } from './workspace.js';
import { checkBuiltSite, describeChecks } from './check.js';
import { VIEWS, previewContent, previewSite } from './browser.js';

export const AGENT_LIMITS = { turns: 80, outputTokens: 500000, minutes: 40, fixRounds: 3, lookReminders: 2, maxTokens: 64000 };
export const AGENT_EFFORT = 'medium';
const EDITOR = 'str_replace_based_edit_tool';

const REQ_STATUS = ['done', 'partial', 'not_done'];

/** The tools the agent gets. */
export const AGENT_TOOLS = [
  { type: 'text_editor_20250728', name: EDITOR, max_characters: 60000 },
  {
    name: 'preview_site',
    description: 'Opens the site in a real browser and returns screenshots of each page at phone (375 px), tablet (768 px) and computer (1440 px) width, plus automatic findings: sideways scrolling and what causes it, broken images, browser errors, cramped tap targets, tiny text, clipped text, bracketed placeholders still visible, serious accessibility problems. Look at every screenshot and fix what is not excellent; call it again after the fixes. You cannot finish without looking at your latest version.',
    input_schema: {
      type: 'object',
      properties: {
        pages: { type: 'array', items: { type: 'string' }, description: 'Page addresses to open, e.g. ["/", "/menu/"]. Leave out for every page (at most 6).' },
        sizes: { type: 'array', items: { type: 'string', enum: Object.keys(VIEWS) }, description: 'Leave out for all three.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'check_site',
    description: 'Runs the checks the finished site must pass: safety (only the site\'s own local scripts, nothing loaded from another site, no inline handlers), every page, link and file resolves, and the HTML is valid. Run it after writing the site and again after fixes; call finish only when it passes.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'finish',
    description: 'Call once, when the site is excellent, check_site passes and preview_site shows your latest version looking right at every size. Reports what was done for each requirement id, every placeholder left in the site, and anything that could not be done.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two or three plain sentences for the owner, who is not a developer: what was built and how it helps their goal. No tool names, file names or technical terms; caveats go in not_done.' },
        requirements: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, status: { type: 'string', enum: REQ_STATUS }, note: { type: 'string' } },
            required: ['id', 'status', 'note'],
            additionalProperties: false,
          },
        },
        placeholders: { type: 'array', items: { type: 'string' }, description: 'Facts or images still to be supplied, in plain words.' },
        not_done: { type: 'array', items: { type: 'string' }, description: 'What could not be done or could not be verified, and why, in plain words.' },
      },
      required: ['summary', 'requirements', 'placeholders', 'not_done'],
      additionalProperties: false,
    },
  },
];

/** What the agent is told about the folder it works in, beside the composed prompt. */
export function workspaceNote({ fonts }) {
  const fontLine = fonts?.css
    ? `Fonts: ${fonts.css} already holds the @font-face rules for ${fonts.local.join(' and ')} (the files are in fonts/). Link it before your own stylesheet and use those families by name, each followed by close fallbacks.${fonts.missing.length ? ` ${fonts.missing.join(' and ')} could not be made local: use close system fallbacks for ${fonts.missing.length === 1 ? 'it' : 'them'}.` : ''}`
    : 'Fonts: no font files are available. Name the design\'s families first in each font stack, followed by close system fallbacks.';
  return [
    '<workspace>',
    'You are now building this site. Your tools:',
    `- ${EDITOR}: view, create, str_replace and insert files in the project folder. Paths are relative to the site root (index.html, css/site.css, js/main.js).`,
    '- preview_site: opens the site in a real browser and shows you screenshots at phone, tablet and computer width, with automatic findings.',
    '- check_site: the safety, link and HTML checks the finished site must pass.',
    '- finish: call it once, at the end, with your report.',
    'There is no shell, no build step and no network: write plain files. The project folder is the site root and is served exactly as it is.',
    fontLine,
    'Facts: the brief\'s "Facts you may use" come from the owner. Where one fills a bracketed placeholder in the brief (the business name, phone, hours…), use the fact and drop the placeholder.',
    'Scripts: only local files under js/, loaded with <script src="js/…" defer>. No inline scripts, no on* attributes, no fetch, XMLHttpRequest or eval, nothing loaded from another site (a map or video may be an <iframe>).',
    '',
    'How to work:',
    '1. Write the whole site: every page, the stylesheet and the scripts, each file whole with create.',
    '2. Call preview_site and study every screenshot like the art director of a top studio reviewing a junior\'s work. Fix everything on the visual review list that is not excellent, then look again. Do at least two rounds of looking and fixing; a first draft is never the final site.',
    '3. When it looks excellent at every size, run check_site and fix anything it reports.',
    '4. Call finish. Write the summary for the owner, who is not a developer.',
    '</workspace>',
  ].join('\n');
}

/** What a tool call is doing, in the owner's words, for the progress list. */
function describeCall(/** @type {any} */ block) {
  if (block.name === 'check_site') return 'Checking the site';
  if (block.name === 'preview_site') return 'Opening the site in a browser to look at it';
  if (block.name === 'finish') return 'Writing the report';
  const p = typeof block.input?.path === 'string' ? block.input.path.replace(/^\/+/, '') || 'the project' : 'a file';
  return { create: `Writing ${p}`, str_replace: `Editing ${p}`, insert: `Editing ${p}`, view: `Reading ${p}` }[block.input?.command] ?? `Working on ${p}`;
}

/** A finish input, checked: the server no longer validates a streamed tool input, so it is validated here. */
export function checkReport(/** @type {any} */ input) {
  if (!input || typeof input.summary !== 'string' || !Array.isArray(input.requirements)) return null;
  const strings = (/** @type {any} */ v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const requirements = input.requirements
    .filter((r) => r && typeof r.id === 'string' && REQ_STATUS.includes(r.status))
    .map((r) => ({ id: r.id, status: r.status, note: typeof r.note === 'string' ? r.note : '' }));
  return { summary: input.summary, requirements, placeholders: strings(input.placeholders), notDone: strings(input.not_done) };
}

const addUsage = (/** @type {any} */ total, /** @type {any} */ u) => {
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) total[k] += u?.[k] ?? 0;
};

/**
 * Runs the agent until it finishes with passing checks, a limit is reached, or the signal stops it.
 * @param {{ prompt: { system: any[], messages: any[] }, siteDir: string, fonts?: any, client?: any, model?: string,
 *   onEvent?: (e: { type: string, text?: string, file?: string }) => void, signal?: AbortSignal, limits?: Partial<typeof AGENT_LIMITS>,
 *   preview?: typeof previewSite }} o
 *   client: an Anthropic client (tests pass a fake with the same shape)
 * @returns {Promise<{ report: any, checks: any, turns: number, usage: any, model: string }>}
 */
export async function runAgent({ prompt, siteDir, fonts, client, model = BUILD_MODEL, onEvent = () => {}, signal, limits = {}, preview = previewSite }) {
  const lim = { ...AGENT_LIMITS, ...limits };
  const Anthropic = await loadSdk();
  let api;
  try {
    api = client ?? new Anthropic();
  } catch (err) {
    throw explainError(err, Anthropic);
  }
  const deadline = Date.now() + lim.minutes * 60000;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const first = prompt.messages[0];
  /** @type {any[]} */
  const messages = [{ ...first, content: [...first.content, { type: 'text', text: workspaceNote({ fonts }) }] }, ...prompt.messages.slice(1)];
  let turns = 0;
  let fixRounds = 0;
  let nudged = false;
  let jsonRetries = 0;
  // The agent must look at its latest version before it finishes: a change after the last look needs another look.
  let changedSinceLook = false;
  let looks = 0;
  let lookReminders = 0;

  while (true) {
    if (signal?.aborted) throw new LlmError('The build was stopped.', 499, 'stopped');
    if (turns >= lim.turns || usage.output_tokens >= lim.outputTokens || Date.now() > deadline) {
      throw new LlmError('The build reached its limit before the agent finished. Nothing was lost: the files written so far are kept.', 504, 'agent-limit');
    }
    turns++;
    let message;
    try {
      message = await api.beta.messages.stream({
        model,
        max_tokens: lim.maxTokens,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        output_config: { effort: AGENT_EFFORT },
        cache_control: { type: 'ephemeral' },
        system: prompt.system,
        tools: AGENT_TOOLS,
        messages,
      }, { signal }).finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (signal?.aborted) throw new LlmError('The build was stopped.', 499, 'stopped');
      // With eager input streaming a tool input that could not be parsed at all rejects the stream: the turn is asked again.
      if (!(err instanceof Anthropic.APIError) && jsonRetries++ < 2) continue;
      throw explainError(err, Anthropic);
    }
    addUsage(usage, message.usage);

    if (message.stop_reason === 'refusal') {
      throw new LlmError(`Claude declined to build this${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`, 422, 'llm-refused');
    }
    const calls = message.content.filter((b) => b.type === 'tool_use');
    for (const b of message.content) {
      if (b.type === 'text' && b.text.trim()) onEvent({ type: 'note', text: b.text.trim().slice(0, 300) });
    }
    if (message.stop_reason === 'max_tokens') {
      // A tool input cut off at the limit may still parse; it is never run.
      throw new LlmError('One step of the agent was longer than allowed. Try again, or ask for fewer pages.', 502, 'llm-too-long');
    }
    messages.push({ role: 'assistant', content: message.content });

    if (!calls.length) {
      // The agent stopped talking without finishing: remind it once, then end with what is there.
      if (!nudged) {
        nudged = true;
        messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue until the site is complete, run check_site, then call finish.' }] });
        continue;
      }
      const checks = await checkBuiltSite(siteDir);
      return { report: null, checks, turns, usage, model: message.model ?? model };
    }

    /** @type {any[]} */
    const results = [];
    let finished = null;
    for (const call of calls) {
      onEvent({ type: 'action', text: describeCall(call) });
      if (call.name === EDITOR) {
        try {
          const out = await runEditor(siteDir, call.input);
          if (out.changed) {
            changedSinceLook = true;
            onEvent({ type: 'file', file: out.changed.path });
          }
          results.push({ type: 'tool_result', tool_use_id: call.id, content: out.text });
        } catch (err) {
          if (!(err instanceof ToolError)) throw err;
          results.push({ type: 'tool_result', tool_use_id: call.id, content: err.message, is_error: true });
        }
      } else if (call.name === 'preview_site') {
        const input = call.input ?? {};
        const pages = Array.isArray(input.pages) ? input.pages.filter((p) => typeof p === 'string') : undefined;
        const sizes = Array.isArray(input.sizes) ? input.sizes.filter((x) => typeof x === 'string' && Object.hasOwn(VIEWS, x)) : undefined;
        try {
          const shown = await preview(siteDir, { pages, sizes: sizes?.length ? sizes : undefined });
          looks++;
          changedSinceLook = false;
          onEvent({ type: 'checks', text: shown.findings.length ? `Looked at the site: ${shown.findings.length} thing(s) to fix` : 'Looked at the site' });
          results.push({ type: 'tool_result', tool_use_id: call.id, content: previewContent(shown) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: `The browser could not open the site: ${String(err?.message ?? err).slice(0, 200)}`, is_error: true });
        }
      } else if (call.name === 'check_site') {
        const checks = await checkBuiltSite(siteDir);
        onEvent({ type: 'checks', text: checks.ok ? 'Checks passed' : `${checks.issues.length} problem(s) found` });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: describeChecks(checks) });
      } else if (call.name === 'finish') {
        const report = checkReport(call.input);
        if (!report) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: 'The report was incomplete: send summary, requirements, placeholders and not_done.', is_error: true });
          continue;
        }
        if ((changedSinceLook || looks === 0) && lookReminders < lim.lookReminders) {
          lookReminders++;
          onEvent({ type: 'checks', text: 'Looking at the latest version before finishing' });
          results.push({ type: 'tool_result', tool_use_id: call.id, content: 'You have not looked at your latest version. Call preview_site, fix what is not excellent, then finish.', is_error: true });
          continue;
        }
        const checks = await checkBuiltSite(siteDir);
        if (!checks.ok && fixRounds < lim.fixRounds) {
          fixRounds++;
          onEvent({ type: 'checks', text: `${checks.issues.length} problem(s) left; fixing` });
          results.push({ type: 'tool_result', tool_use_id: call.id, content: describeChecks(checks), is_error: true });
          continue;
        }
        finished = { report, checks };
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Report received.' });
      } else {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: `Unknown tool ${call.name}.`, is_error: true });
      }
    }
    if (finished) {
      const files = await listFiles(siteDir);
      onEvent({ type: 'done', text: `Site complete: ${files.length} files` });
      return { ...finished, turns, usage, model: message.model ?? model };
    }
    messages.push({ role: 'user', content: results });
  }
}
