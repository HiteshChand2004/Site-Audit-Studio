// @ts-check
// Changing a built site's words without the agent (no model, seconds instead of minutes), on the same run:
//   - "Fill in what's missing": a bracketed placeholder the site still shows ([Phone]) is given its value, replaced
//     everywhere it is written in the site's own files;
//   - "Edit the text": a text block of a built page (a heading, a paragraph, a list item, a button or a link) is changed
//     where it is written.
// The text blocks are read from the built pages (cheerio); where each is written is found in the site's own source files
// (sourcetext.js): plain HTML, its .html and script files; React + Vite / Next.js, only the files the agent writes
// (stack.writable), never the fixed setup. A text edit needs the text written exactly once (in a plain-HTML site: once in
// each page that shows it, so a menu written into every page changes on every page); text the code puts together from
// pieces, or written in several places, is refused in plain words. The new text is plain text, bounded, and written the way
// each place needs it (entities in HTML and JSX, escapes in strings). Then an app stack is rebuilt (project.js buildProject,
// no agent) and every stack is checked (check.js); a failed rebuild or check puts every file back as it was. The run records
// what was changed (run.edits), its revision and its checks; its preview shows the change, its download holds it.
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { BuildError, builtDirOf, EDIT_BACKUP, EDIT_JOURNAL, hasPages, lockRun, runDirOf, runRecord, saveRun, siteDirOf, stackOf, viewRun } from './builds.js';
import { buildProject } from './project.js';
import { checkBuiltSite } from './check.js';
import { sitePages } from './browser.js';
import { listFiles, WORKSPACE_LIMITS } from './workspace.js';
import { projectFile } from './stacks.js';
import { fileRuns, findText, replaceHits, shown } from './sourcetext.js';

export const EDIT_LIMITS = { text: 2000, fill: 500, pages: 30, blocks: 300, placeholders: 60, history: 200 };
const SOURCE = /\.(html?|m?jsx?|vue|svelte|astro)$/i;
const PLACEHOLDER = /\[[^[\]\n]{2,80}\]/g;
const SKIP_TAGS = 'script, style, noscript, template, svg, head, title, iframe, textarea, select';
const KINDS = /** @type {[string, string][]} */ ([
  ['h1, h2, h3, h4, h5, h6', 'heading'], ['button, [role=button]', 'button'], ['a', 'link'], ['li', 'list item'],
  ['p', 'paragraph'], ['label', 'label'], ['blockquote', 'quote'], ['figcaption', 'caption'], ['td, th', 'table'],
]);

/** The built file of a page address: / → index.html, /menu/ → menu/index.html. */
const pageFile = (/** @type {string} */ page) => (page === '/' ? 'index.html' : page.endsWith('/') ? `${page.slice(1)}index.html` : page.slice(1));
/** Plain text as the owner gave it: one line, no control characters, white space collapsed. */
const plain = (/** @type {unknown} */ v) => (typeof v === 'string' ? shown(v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')) : '');
const clip = (/** @type {string} */ s) => (s.length > 200 ? `${s.slice(0, 199)}…` : s);

/** The text blocks of a built page, in page order, each text once: { text, kind }. */
export async function pageBlocks(/** @type {string} */ dir, /** @type {string} */ page) {
  const html = await readFile(path.join(dir, pageFile(page)), 'utf8').catch(() => null);
  if (html == null) return [];
  const $ = load(html);
  $(SKIP_TAGS).remove();
  const seen = new Set();
  const out = [];
  // Every text node is a block of its own: an inline link or a value the code put in (React marks those apart) is its own.
  const walk = (/** @type {any} */ node) => {
    for (const child of node.children ?? []) {
      if (out.length >= EDIT_LIMITS.blocks) return;
      if (child.type === 'text') {
        const text = shown(child.data);
        if (!text || !/[\p{L}\p{N}]/u.test(text) || seen.has(text)) continue;
        seen.add(text);
        // The nearest element that says what the text is: a link inside a list item is a link.
        let kind = null;
        for (let el = $(child.parent); el.length && !kind && !el.is('body'); el = el.parent()) kind = KINDS.find(([sel]) => el.is(sel))?.[1] ?? null;
        kind ??= 'text';
        out.push({ text, kind: /** @type {string} */ (kind) });
      } else if (child.type === 'tag') walk(child);
    }
  };
  walk($('body').get(0) ?? $.root().get(0));
  return out;
}

/** The bracketed placeholders a built page still shows, in its text and in what a visitor sees or hears of its tags. */
async function pagePlaceholders(/** @type {string} */ dir, /** @type {string} */ page) {
  const html = await readFile(path.join(dir, pageFile(page)), 'utf8').catch(() => null);
  if (html == null) return [];
  const $ = load(html);
  $('script, style, noscript, template').remove();
  const texts = [$.root().text(), ...$('[alt], [title], [aria-label], [placeholder], meta[content], [href]').map((_i, el) => ['alt', 'title', 'aria-label', 'placeholder', 'content', 'href'].map((a) => $(el).attr(a) ?? '').join('\n')).get()];
  return [...new Set(texts.flatMap((t) => t.match(PLACEHOLDER) ?? []))].filter((t) => /\p{L}/u.test(t));
}

/** The site's own files that may hold its words, with their runs (sourcetext.js). */
async function sources(/** @type {any} */ run) {
  const stack = stackOf(run);
  const dir = siteDirOf(run.id);
  const fonts = stack.publicDir ? `${stack.publicDir}/fonts/` : 'fonts/';
  const out = [];
  for (const rel of await listFiles(dir)) {
    if (!SOURCE.test(rel) || !projectFile(rel) || !stack.writable(rel) || rel.startsWith(fonts)) continue;
    const info = await stat(path.join(dir, rel)).catch(() => null);
    if (!info || info.size > WORKSPACE_LIMITS.fileBytes) continue;
    const text = await readFile(path.join(dir, rel), 'utf8');
    out.push({ rel, text, runs: fileRuns(rel, text) });
  }
  return out;
}

/**
 * Where a text block is written, and whether it may be changed there. Plain HTML: once in the page's own file and at most
 * once in any other page (a header written into every page changes on every page); an app: once in all its files.
 * @param {any} stack @param {{ rel: string, text: string, runs: any[] }[]} files @param {string} text @param {string} page
 */
function locate(stack, files, text, page) {
  const found = files.map((f) => ({ ...f, hits: findText(f.text, f.runs, text, { whole: true }) })).filter((f) => f.hits.length);
  const total = found.reduce((n, f) => n + f.hits.length, 0);
  if (!total) return { ok: false, why: 'This text is put together by the site’s code from several pieces, so it can’t be changed here.', found };
  const once = stack.toolchain
    ? total === 1
    : found.every((f) => f.hits.length === 1) && found.some((f) => f.rel === pageFile(page));
  if (!once) return { ok: false, why: 'This exact text is used in more than one place on the page, so it can’t be changed here safely.', found };
  return { ok: true, why: '', found };
}

/** A finished run the owner may change: its record, or a clear refusal. */
async function changeable(/** @type {string} */ id, /** @type {string | null} */ ownerId) {
  const run = await runRecord(id, ownerId);
  if (!run) throw new BuildError('Build not found.', 404);
  if (run.status === 'running') throw new BuildError('The site is still being built.', 409);
  if (run.status !== 'done' || run.checks?.ok === false || !(await hasPages(run))) throw new BuildError('Only a finished site that passed its checks can be changed here. Build it again.', 409);
  return run;
}

/**
 * The words of a finished run, as the owner changes them: every page's text blocks (each marked whether it can be changed
 * here, and why not), the placeholders it still shows, and the facts the build reported missing that are not marked on a page.
 */
export async function siteTexts(/** @type {string} */ id, /** @type {string | null} */ ownerId = null) {
  const run = await changeable(id, ownerId);
  const stack = stackOf(run);
  const dir = builtDirOf(run);
  const files = await sources(run);
  const pages = [];
  /** @type {Map<string, Set<string>>} */
  const marked = new Map();
  for (const page of (await sitePages(dir)).slice(0, EDIT_LIMITS.pages)) {
    const blocks = (await pageBlocks(dir, page)).map((b) => {
      const where = locate(stack, files, b.text, page);
      return { ...b, editable: where.ok, ...(where.ok ? {} : { why: where.why }) };
    });
    pages.push({ path: page, title: blocks.find((b) => b.kind === 'heading')?.text ?? null, blocks });
    for (const token of await pagePlaceholders(dir, page)) marked.set(token, (marked.get(token) ?? new Set()).add(page));
  }
  const placeholders = [...marked].slice(0, EDIT_LIMITS.placeholders).map(([token, on]) => ({
    token, label: token.slice(1, -1).trim(), pages: [...on],
    fillable: files.some((f) => findText(f.text, f.runs, token, { whole: false }).length > 0),
  }));
  const labels = new Set(placeholders.map((p) => p.label.toLowerCase()));
  const notMarked = (run.report?.placeholders ?? []).map((p) => String(p).replace(/^\[|\]$/g, '').trim()).filter((p) => p && !labels.has(p.toLowerCase()));
  return { revision: run.revision ?? 0, stack: stack.id, pages, placeholders, notMarked };
}

/**
 * One change: { kind: 'fill', token: '[Phone]', value } or { kind: 'text', page: '/menu/', from, to }.
 * @param {string} id @param {string | null} ownerId @param {any} body
 * @param {{ build?: typeof buildProject, check?: typeof checkBuiltSite }} [o]  tests
 */
export async function editSite(id, ownerId, body, { build = buildProject, check = checkBuiltSite } = {}) {
  const run = await changeable(id, ownerId);
  const stack = stackOf(run);
  const kind = body?.kind;
  if (kind !== 'fill' && kind !== 'text') throw new BuildError('kind must be "fill" or "text".');
  let from;
  let to;
  let page = null;
  if (kind === 'fill') {
    from = typeof body.token === 'string' ? body.token : '';
    if (!new RegExp(`^${PLACEHOLDER.source}$`).test(from)) throw new BuildError('That is not a placeholder of the site.');
    to = plain(body.value);
    if (!to) throw new BuildError('Type what should go there.');
    if (to.length > EDIT_LIMITS.fill) throw new BuildError(`Keep it under ${EDIT_LIMITS.fill} characters.`);
  } else {
    page = typeof body.page === 'string' ? body.page : '';
    from = plain(body.from);
    to = plain(body.to);
    if (!(await sitePages(builtDirOf(run))).includes(page)) throw new BuildError('That page is not part of the site.');
    if (!(await pageBlocks(builtDirOf(run), page)).some((b) => b.text === from)) throw new BuildError('That text is not on the page (it may have been changed already). Reload and try again.', 409);
    if (!to) throw new BuildError('The new text cannot be empty.');
    if (to.length > EDIT_LIMITS.text) throw new BuildError(`Keep it under ${EDIT_LIMITS.text} characters.`);
    if (to === from) throw new BuildError('That is the text the page already has.');
  }

  return lockRun(id, async () => {
    const files = await sources(run);
    /** @type {{ rel: string, text: string, hits: any[] }[]} */
    let changes;
    if (kind === 'fill') {
      changes = files.map((f) => ({ ...f, hits: findText(f.text, f.runs, from, { whole: false }) })).filter((f) => f.hits.length);
      if (!changes.length) throw new BuildError('This placeholder is put together by the site’s code, so it can’t be filled in here.', 422);
    } else {
      const where = locate(stack, files, from, /** @type {string} */ (page));
      if (!where.ok) throw new BuildError(where.why, 422);
      changes = where.found;
    }

    const dir = siteDirOf(run.id);
    const out = builtDirOf(run);
    const backup = path.join(runDirOf(run.id), EDIT_BACKUP);
    const journal = path.join(runDirOf(run.id), EDIT_JOURNAL);
    const rollback = async () => {
      for (const c of changes) await writeFile(path.join(dir, c.rel), c.text);
      if (stack.toolchain) {
        await rm(out, { recursive: true, force: true });
        await rename(backup, out).catch(() => {});
      }
      await rm(journal, { force: true });
    };
    // What a restart in the middle puts back (builds.js undoInterruptedEdit): the files as they were, the built site moved aside.
    await writeFile(journal, JSON.stringify({ files: changes.map((c) => ({ rel: c.rel, text: c.text })), out: stack.toolchain ? stack.out : null }));
    if (stack.toolchain) {
      await rm(backup, { recursive: true, force: true });
      await rename(out, backup);
    }
    let result;
    try {
      for (const c of changes) await writeFile(path.join(dir, c.rel), replaceHits(c.text, c.hits, to));
      if (stack.toolchain) {
        const built = await build({ stack, dir, tmp: path.join(runDirOf(run.id), 'tmp-edit') });
        if (!built.ok) throw new BuildError(`The site could not be built with this change, so nothing was changed. ${built.problems[0] ?? ''}`.trim(), 422);
      }
      result = await check(out, { app: stack.safety });
      if (!result.ok) throw new BuildError(`With this change the site would not pass its checks, so nothing was changed. ${result.issues[0] ?? ''}`.trim(), 422);
      if (kind === 'text' && !(await pageBlocks(out, /** @type {string} */ (page))).some((b) => b.text === to)) {
        throw new BuildError('The page did not show the new text after the change, so nothing was changed.', 422);
      }
    } catch (err) {
      await rollback();
      throw err;
    } finally {
      await rm(path.join(runDirOf(run.id), 'tmp-edit'), { recursive: true, force: true }).catch(() => {});
    }
    await rm(journal, { force: true });
    await rm(backup, { recursive: true, force: true }).catch(() => {});

    const at = new Date().toISOString();
    run.revision = (run.revision ?? 0) + 1;
    run.changedAt = at;
    run.checks = { ok: result.ok, issues: result.issues, pages: result.pages };
    run.edits = [...(run.edits ?? []), { at, kind, ...(page && { page }), from: clip(from), to: clip(to), files: changes.map((c) => c.rel) }].slice(-EDIT_LIMITS.history);
    await saveRun(run);
    return { run: viewRun(run), files: changes.map((c) => c.rel) };
  });
}
