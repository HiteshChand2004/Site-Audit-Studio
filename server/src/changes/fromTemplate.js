// @ts-check
// A new page made by the site's own template (template.js): the kind of page its address belongs to, that kind's template
// worked out from two of its pages, and the draft put into the template's slots. Without the AI (changes/agent.js, step 3)
// the draft is put in by a plain mapping: heading, intro, sections into the template's cards, questions into its questions.
// A slot nothing honest can fill (another page's picture, a heading that is that page's own) is left out, never copied.
// When the template has no place for the draft's heading or its sections, null: the caller uses the frames way (apply.js).
import * as cheerio from 'cheerio';
import { deriveSingle, deriveTemplate, fillTemplate, folderOf, pageKinds } from './template.js';
import { pageFile, readText } from './site.js';
import { aiEntry } from './agent.js';

/**
 * The kind a new page at `page` belongs to: the kind of its folder ("/ai-video-analytics/spill/" → "/ai-video-analytics/").
 * @param {string} root @param {string} page
 */
export async function kindFor(root, page) {
  const folder = folderOf(page.endsWith('/') ? page : `${page}/`);
  if (folder === '/') return null;
  return (await pageKinds(root)).find((k) => k.folder === folder) ?? null;
}

/** @typedef {import('./template.js').SlotInfo} SlotInfo */

const starts = (/** @type {SlotInfo} */ s, /** @type {string[]} */ tags) => tags.some((t) => s.where === t || s.where.startsWith(`${t}.`) || s.where.startsWith(`${t} `));
const textSlots = (/** @type {SlotInfo[]} */ slots) => slots.filter((s) => s.kind === 'text');

/** A list whose items are a heading and a text (feature cards, steps): where the draft's sections go. */
const isCardList = (/** @type {SlotInfo} */ s) => {
  const t = textSlots(s.item?.slots ?? []);
  return t.length >= 2 && starts(t[0], ['h2', 'h3', 'h4', 'h5', 'strong', 'b']) && !isQuestionList(s);
};
/** A list whose items are a question and its answer. */
const isQuestionList = (/** @type {SlotInfo} */ s) => {
  const t = textSlots(s.item?.slots ?? []);
  if (t.length < 2) return false;
  if (starts(t[0], ['summary', 'dt', 'button'])) return true;
  const q = t[0].examples.filter((e) => /\?\s*$/.test(e)).length;
  return q > 0 && q >= t[0].examples.length / 2;
};

/**
 * The draft put into the template's slots without a model. Returns null when the template has no place for the draft's
 * heading, or none for its sections when it has some.
 * @param {{ slots: SlotInfo[] }} schema @param {any} d  the draft (contract.js)
 */
export function entryFromDraft(schema, d) {
  const top = schema.slots;
  const order = top.map((s) => s.id);
  const h1 = top.find((s) => s.kind === 'text' && starts(s, ['h1']));
  if (!h1) return null;
  /** @type {Record<string, any>} */
  const entry = { [h1.id]: d.h1 || d.title };
  const notes = [];
  const intro = top.find((s) => s.kind === 'text' && starts(s, ['p']) && order.indexOf(s.id) > order.indexOf(h1.id));
  if (intro && d.intro) entry[intro.id] = d.intro;
  else if (d.intro) notes.push('The template has no place for the intro under its heading; it was left out.');
  const cards = top.find((s) => s.kind === 'list' && isCardList(s));
  if (d.sections.length) {
    if (!cards) return null;
    const [head, body] = textSlots(cards.item?.slots ?? []);
    entry[cards.id] = d.sections.map((x) => ({ [head.id]: x.h2, [body.id]: x.body }));
  }
  const questions = top.find((s) => s.kind === 'list' && isQuestionList(s));
  if (questions && d.faq.length) {
    const [q, a] = textSlots(questions.item?.slots ?? []);
    entry[questions.id] = d.faq.map((f) => ({ [q.id]: f.q, [a.id]: f.a }));
  } else if (d.faq.length) notes.push('The template has no questions part; the draft\'s questions were left out.');
  if (d.proof.length) notes.push('The template has no proof part; the draft\'s proof lines were left out (the AI way places them).');
  return { entry, notes };
}

/** The note for blocks left out because nothing could fill them (template.js emptiedBlocks). */
const EMPTIED = (/** @type {number} */ n) => `${n} block(s) without a heading (an illustration, sample data) were left out: the draft had nothing for them, and an empty frame is not shown.`;

/** Hooks for tests: the AI's answer (null = the real one). */
export const testHooks = { ask: null };

/**
 * The entry for a template: the AI's (checked) first, else the plain mapping. Null when neither can place the draft.
 * @returns {Promise<null | { entry: Record<string, any>, notes: string[], by: any }>}
 */
async function entryFor({ mode, page, kind, from, fromFiles, t, d, root }) {
  const h1 = t.schema.slots.find((s) => s.kind === 'text' && starts(s, ['h1']));
  try {
    const ai = await aiEntry({ mode, page, folder: kind.folder, from, fromFiles, slots: t.schema.slots, draft: d, root, ...(testHooks.ask && { ask: testHooks.ask }) });
    // usable: the page's heading is written (a page without its heading is no page of this kind)
    if (!h1 || (typeof ai.entry[h1.id] === 'string' && ai.entry[h1.id].trim())) return { entry: ai.entry, notes: ai.notes, by: { ai: true, ...ai.by } };
    return mapped(t, d, mode, ["The AI left the page's heading empty; the plain mapping was used instead."]);
  } catch (err) {
    return mapped(t, d, mode, [`The AI was not used (${/** @type {Error} */ (err).message}); the plain mapping was used instead.`]);
  }
}
const mapped = (t, d, mode, notes) => {
  if (mode === 'improve') return null; // keeping a page's own content needs the AI; without it, the page is changed in place (apply.js)
  const m = entryFromDraft(t.schema, d);
  return m ? { entry: m.entry, notes: [...notes, ...m.notes], by: { ai: false } } : null;
};

/**
 * A new page of a kind: the template of two of its pages, filled. Null when the site has no such kind or nothing can place
 * the draft in the template.
 * @param {string} root @param {string} page  the new page's address @param {any} d
 * @returns {Promise<null | { $: cheerio.CheerioAPI, kind: { folder: string, pages: string[] }, from: string[], missing: string[], notes: string[], by: any }>}
 */
export async function templatePage(root, page, d) {
  const kind = await kindFor(root, page);
  if (!kind) return fromHomepage(root, page, d);
  const [pa, pb] = kind.pages;
  return fromPair(root, { mode: 'create', page, kind, pa, pb, d });
}

/**
 * A site with no two pages of a kind for the new page: its homepage is the template (template.js deriveSingle): its top part
 * with the heading, and those of its other parts the draft has content for (feature cards, questions, steps), filled by the
 * AI; the others left out. Needs the AI (only it can tell which parts fit). Returns { why } instead of a page when it cannot
 * be used, so the caller can say why it used the frames way.
 * @param {string} root @param {string} page @param {any} d
 */
async function fromHomepage(root, page, d) {
  const home = await pageFile(root, '/');
  if (!home) return { why: 'The site has no homepage to use as a template.' };
  const html = await readText(root, home);
  const $h = cheerio.load(html);
  if (!$h('h1').length) return { why: 'The homepage has no main heading to use as a template.' };
  let t;
  try {
    t = deriveSingle(html);
  } catch (err) {
    return { why: `The homepage could not be made into a template (${/** @type {Error} */ (err).message}).` };
  }
  const h1 = t.schema.slots.find((x) => x.kind === 'text' && starts(x, ['h1']));
  let ai;
  try {
    ai = await aiEntry({ mode: 'create', page, folder: '/', from: ['/'], fromFiles: [home], slots: t.schema.slots, draft: d, root, single: true, ...(testHooks.ask && { ask: testHooks.ask }) });
  } catch (err) {
    return { why: `The homepage could be the template, but the AI was not used (${/** @type {Error} */ (err).message}).` };
  }
  if (!h1 || !(typeof ai.entry[h1.id] === 'string' && ai.entry[h1.id].trim())) return { why: 'The AI left the main heading empty.' };
  // the homepage's own links stay where the AI gives none (its buttons lead where the site's do); its pictures do not
  /** @type {Record<string, string>} */
  const defaults = {};
  const linksOf = (/** @type {import('./template.js').SlotInfo[]} */ slots) => {
    for (const x of slots) {
      if (x.kind === 'attr' && x.attr?.toLowerCase() === 'href' && x.examples[0]) defaults[x.id] = x.examples[0];
      if (x.kind === 'optional' && x.item) linksOf(x.item.slots);
    }
  };
  linksOf(t.schema.slots);
  const { html: body, missing, emptied } = fillTemplate(t.root, ai.entry, { dropEmpty: true, defaults });
  if (emptied) ai.notes.push(EMPTIED(emptied));
  const $ = cheerio.load(html);
  $('body').replaceWith(body);
  const used = t.schema.slots.filter((x) => x.kind === 'optional' && ai.entry[x.id] === true).length;
  const parts = t.schema.slots.filter((x) => x.kind === 'optional').length;
  return {
    $, kind: { folder: '/', pages: ['/'] }, from: ['/'], missing, single: true, heading: ai.entry[h1.id],
    notes: [`Made with the site's homepage as the template (the site has no other page of this kind): its top, and ${used} of its ${parts} other parts that fit the draft; the rest left out.`, ...ai.notes],
    by: { ai: true, ...ai.by },
  };
}

/**
 * An existing page of a kind, made again by its template with the draft's changes (its own content kept where the draft does
 * not change it). Needs the AI. Null when the page is not one of a kind, or nothing usable came back.
 * @param {string} root @param {string} page @param {any} d
 */
export async function templateImprove(root, page, d) {
  const folder = folderOf(page.endsWith('/') || /\.html?$/i.test(page) ? page.replace(/\.html?$/i, '') : `${page}/`);
  const kind = (await pageKinds(root)).find((k) => k.folder === folder && k.pages.includes(page));
  if (!kind) return null;
  const sibling = kind.pages.find((p) => p !== page);
  if (!sibling) return null;
  return fromPair(root, { mode: 'improve', page, kind, pa: page, pb: sibling, d });
}

async function fromPair(root, { mode, page, kind, pa, pb, d }) {
  const fa = await pageFile(root, pa);
  const fb = await pageFile(root, pb);
  if (!fa || !fb) return null;
  const htmlA = await readText(root, fa);
  let t;
  try {
    t = deriveTemplate(htmlA, await readText(root, fb));
  } catch {
    return null; // too different to be one template
  }
  const made = await entryFor({ mode, page, kind, from: [pa, pb], fromFiles: [fa, fb], t, d, root });
  if (!made) return null;
  const { html, missing, emptied } = fillTemplate(t.root, made.entry, { dropEmpty: true });
  if (emptied) made.notes.push(EMPTIED(emptied));
  // the head of the first page (the page itself when improving): its styles, fonts and icons; title and address set by the caller
  const $ = cheerio.load(htmlA);
  $('body').replaceWith(html);
  // the heading as written (the AI may shorten the draft's to the site's style): what the "still there" check looks for
  const h1 = t.schema.slots.find((x) => x.kind === 'text' && starts(x, ['h1']));
  const heading = h1 && typeof made.entry[h1.id] === 'string' ? made.entry[h1.id] : null;
  return { $, kind, from: [pa, pb], missing, notes: made.notes, by: made.by, heading };
}
