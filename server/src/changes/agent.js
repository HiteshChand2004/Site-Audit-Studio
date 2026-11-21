// @ts-check
// The AI's one job in a change: write the content entry for a page template's slots (template.js) from Growth OS's reviewed
// draft. It writes words only, never markup; code puts them into the site's own template. Its answer is never trusted as it
// is (checkEntry): only the template's own slots, plain text cut to the size the site's pages use, pictures only from the
// site's own files, links only to the site's own pages, and every number not in the draft listed for a person to check.
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { askClaude, AiError } from './claude.js';
import { htmlFiles, pageFile, readText, servedPath } from './site.js';

/** @typedef {import('./template.js').SlotInfo} SlotInfo */

const IMG = /\.(webp|avif|jpe?g|png|gif|svg)$/i;
const MEDIA_MAX = 60;
const PAGES_MAX = 80;

/**
 * The pictures the site already has, for the AI to choose from: the ones the kind's pages use first, then the rest of the
 * copy's image files, each with its size (a picture must be at least as wide as where it is shown).
 * @param {string} root @param {string[]} kindFiles  the kind's page files (their pictures come first)
 */
export async function mediaList(root, kindFiles = []) {
  /** @type {string[]} */
  const seen = [];
  for (const f of kindFiles) {
    const $ = cheerio.load(await readText(root, f).catch(() => ''));
    $('img[src]').each((_, el) => {
      const src = $(el).attr('src') ?? '';
      if (src.startsWith('/') && IMG.test(src.split('?')[0]) && !seen.includes(src)) seen.push(src);
    });
  }
  const walk = async (/** @type {string} */ dir, /** @type {string} */ rel, /** @type {number} */ depth) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (seen.length >= 300 || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory() && depth < 6) await walk(path.join(dir, e.name), r, depth + 1);
      else if (e.isFile() && IMG.test(e.name) && !seen.includes(r)) seen.push(r);
    }
  };
  await walk(root, '', 0);
  const { default: sharp } = await import('sharp');
  const out = [];
  for (const src of seen) {
    if (out.length >= MEDIA_MAX) break;
    const file = path.join(root, decodeURI(src.split('?')[0]).replace(/^\/+/, ''));
    if (!(await stat(file).catch(() => null))?.isFile()) continue;
    const m = /\.svg$/i.test(file) ? {} : await sharp(file).metadata().catch(() => ({}));
    out.push({ src: src.split('?')[0], width: /** @type {any} */ (m).width ?? null, height: /** @type {any} */ (m).height ?? null });
  }
  return out;
}

/** The site's pages with their titles: where a link may point. @param {string} root */
export async function pageList(root) {
  const out = [];
  for (const f of (await htmlFiles(root)).slice(0, 400)) {
    if (out.length >= PAGES_MAX) break;
    const html = await readText(root, f).catch(() => '');
    if (/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html)) continue;
    const $ = cheerio.load(html);
    out.push({ path: servedPath(f), title: ($('title').first().text() || $('h1').first().text()).replace(/\s+/g, ' ').trim().slice(0, 90) });
  }
  return out;
}

/** The schema as the AI reads it: every slot, where it is, and what the site's pages put there. */
function schemaText(/** @type {SlotInfo[]} */ slots, depth = 0) {
  const pad = '  '.repeat(depth);
  return slots.map((s) => {
    const ex = s.examples.slice(0, s.kind === 'list' ? 6 : 2).map((e) => JSON.stringify(e.slice(0, 220))).join(' | ');
    const head = `${pad}- ${s.id} [${s.kind}${s.attr ? ` ${s.attr}` : ''}${s.kind === 'text' ? `, at most ${roomFor(s)} characters` : ''}] ${s.where}: ${ex}`;
    if (s.kind === 'list' && s.item) return `${head}\n${pad}  each item:\n${schemaText(s.item.slots, depth + 2)}`;
    if (s.kind === 'optional' && s.item?.slots.length) return `${head}\n${pad}  its slots (used only when ${s.id} is true):\n${schemaText(s.item.slots, depth + 2)}`;
    return head;
  }).join('\n');
}

const SYSTEM = 'You fill page templates of a company website with content from a reviewed page draft. You write plain words only, never HTML or Markdown. You never invent a customer, a number, a result, a certification or a quote: every fact comes from the draft or its approved claims. Finish with one ```json block.';

/**
 * The prompt for one entry.
 * @param {{ mode: 'create' | 'improve', page: string, folder: string, from: string[], slots: SlotInfo[], draft: any, media: any[], pages: any[] }} o
 */
export function entryPrompt({ mode, page, folder, from, slots, draft: d, media, pages, single = false }) {
  return `${single
    ? `Make a NEW page at ${page}. The site has no other page of this kind, so its page ${from[0]} is the template: its top part (with the main heading) is the new page's top, and every other part is optional. Use a part only when the draft has content of that kind for it (feature cards for the draft's sections, a questions part for its FAQ, steps for steps), and fill it with the draft's content; leave out every part about something else (prices, logos, testimonials, sign-up forms, the other page's own topic).`
    : mode === 'create'
    ? `Make a NEW page at ${page}. It is one more page of the kind the site keeps under ${folder} (like ${from.join(' and ')}), made by the same template.`
    : `IMPROVE the existing page ${page}. It is made by the template the site uses for its ${folder} pages. Its current content is the FIRST example of every slot below: keep it where the draft does not change it.`}

The template's slots (id [kind] where on the page: what the site's pages put there):
${schemaText(slots)}

Kinds: text = words for that element; attr = the value of that attribute (src: a picture, href: a link, alt: a picture's description);
list = as many items as the page needs, each item filling the item slots (use the item count the content needs, within what the site's pages use);
optional = true to use a part some pages of this kind have (only when the draft gives its content), false to leave it out.

The reviewed draft (the content to use; the search it must answer: "${(d.targetSearches?.[0] ?? '')}"):
${JSON.stringify({ title: d.title, h1: d.h1, intro: d.intro, sections: d.sections, faq: d.faq, cta: d.cta, proof: d.proof, changes: d.changes }, null, 1).slice(0, 12000)}

Pictures the site has (choose a picture slot's value ONLY from these; pick one whose name fits the page and that is at least as wide as the pictures in that slot on the site's pages; leave the slot out if none fits):
${media.map((m) => `- ${m.src}${m.width ? ` (${m.width}×${m.height})` : ''}`).join('\n') || '- (none)'}

Pages of the site (a link slot's value ONLY from these, or what the site's pages already put there):
${pages.map((p) => `- ${p.path} ${p.title ? `(${p.title})` : ''}`).join('\n')}

Rules:
- Fill every slot the draft has content for, in the length and tone of the site's own examples for that slot (a short label stays short), never longer than its "at most" number of characters: shorten the words, never cut a sentence.
- Growth OS's claim labels like (C1) or (C3) never appear on the page.
- Words come from the draft and its approved claims; you may shorten and reorder them to fit a slot, never add a fact. Approved claims keep their wording.
- A slot the draft has nothing for: leave it out (never copy another page's words, never write a placeholder).
- The draft's sections and questions go into the lists that hold that kind of content.
Return ONLY: \`\`\`json {"entry": {"<slot id>": "..." | true | false | [ { "<item slot id>": "..." } ]}, "notes": ["what you could not place, one line each"]}\`\`\``;
}

const MEDIA_ATTRS = new Set(['src', 'srcset', 'poster', 'data-src', 'data-srcset']);
const LINK_ATTRS = new Set(['href']);
const clean = (/** @type {any} */ v) => String(v).replace(/\s*\((?:C\d{1,2}(?:\s*[,/&]\s*|\s+and\s+)?)+\)/g, '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim();

/** The longest a value may be: what the site's pages put there, with room to spare (a label stays a label). */
function roomFor(/** @type {SlotInfo} */ s) {
  return Math.min(2000, Math.max(60, Math.round(Math.max(0, ...s.examples.map((e) => e.length)) * 2.2) + 40));
}

/**
 * The AI's entry, checked. Unknown slots are dropped; text is plain and cut to size; a picture must be one of the site's own
 * files, a link one of its pages (or what its pages already link to there); numbers not in the draft are listed.
 * @param {SlotInfo[]} slots @param {any} raw @param {{ media: { src: string }[], root: string, draft: any }} ctx
 */
export async function checkEntry(slots, raw, { media, root, draft }) {
  const notes = [];
  const pictures = new Set(media.map((m) => m.src));
  const visit = async (/** @type {SlotInfo[]} */ list, /** @type {any} */ e, /** @type {string} */ at) => {
    /** @type {Record<string, any>} */
    const out = {};
    if (!e || typeof e !== 'object' || Array.isArray(e)) return out;
    for (const s of list) {
      // an optional part's own slots sit at the same level of the entry: checked when the part is used
      if (s.kind === 'optional' && s.item?.slots.length && e[s.id] === true) Object.assign(out, await visit(s.item.slots, e, at));
      const v = e[s.id];
      if (v == null) continue;
      // words and links are text: a true/false ("leave it out") or a number in their place is no value
      if ((s.kind === 'text' || s.kind === 'attr') && typeof v !== 'string') continue;
      if (s.kind === 'optional') {
        if (typeof v === 'boolean') out[s.id] = v;
      } else if (s.kind === 'list') {
        if (!Array.isArray(v)) continue;
        const max = Math.max(12, ...s.examples.length ? [s.examples.length] : []);
        const items = [];
        for (const it of v.slice(0, max)) items.push(await visit(s.item?.slots ?? [], it, `${at}${s.id}[]`));
        out[s.id] = items.filter((x) => Object.keys(x).length);
      } else if (s.kind === 'attr') {
        const val = clean(v);
        const attr = (s.attr ?? '').toLowerCase();
        if (!val) continue;
        if (MEDIA_ATTRS.has(attr)) {
          if (pictures.has(val.split(/[?\s]/)[0])) out[s.id] = val.split(/\s/)[0];
          else notes.push(`Left out a picture the site does not have (${val.slice(0, 80)}).`);
        } else if (LINK_ATTRS.has(attr)) {
          const ok = s.examples.includes(val) || (val.startsWith('/') && !val.startsWith('//') && ((await pageFile(root, val.replace(/[?#].*$/, ''))) || (await stat(path.join(root, decodeURI(val.replace(/[?#].*$/, '')).replace(/^\/+/, ''))).catch(() => null))?.isFile())) || /^#[\w-]*$/.test(val);
          if (ok) out[s.id] = val;
          else notes.push(`Left out a link to a page the site does not have (${val.slice(0, 80)}).`);
        } else out[s.id] = val.slice(0, 250);
      } else {
        const text = clean(v);
        if (!text) continue;
        const room = roomFor(s);
        out[s.id] = text.length > room ? `${text.slice(0, room).replace(/\s+\S*$/, '')}…` : text;
      }
    }
    return out;
  };
  const entry = await visit(slots, raw, '');
  // numbers a reader would see that the draft (or its approved claims) does not have
  const source = JSON.stringify(draft);
  const known = new Set((source.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/[.,]+$/, '')));
  const words = [];
  const collect = (/** @type {any} */ v) => {
    // words a reader sees: not a picture's or a link's address (a file name's hash has digits)
    if (typeof v === 'string') { if (!/^(\/|https?:|#)/.test(v)) words.push(v); }
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(entry);
  const strange = [...new Set((words.join(' ').match(/\d[\d.,]*%?/g) ?? []).map((n) => n.replace(/[.,]+$/, '')).filter((n) => !known.has(n.replace(/%$/, '')) && !/^(19|20)\d\d$/.test(n)))];
  if (strange.length) notes.push(`Numbers the draft does not have, for a person to check: ${strange.slice(0, 12).join(', ')}.`);
  return { entry, notes };
}

/** The JSON block of an answer. */
export function parseAnswer(/** @type {string} */ text) {
  const block = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(block);
  } catch {
    throw new AiError('The AI\'s answer was not the JSON asked for.');
  }
}

/**
 * The AI's entry for a template, checked. Rejects with AiError when the AI is off or did not answer usefully (the caller then
 * uses the plain mapping).
 * @param {{ mode: 'create' | 'improve', page: string, folder: string, from: string[], fromFiles: string[], slots: SlotInfo[], draft: any, root: string, ask?: typeof askClaude }} o
 */
export async function aiEntry({ mode, page, folder, from, fromFiles, slots, draft, root, single = false, ask = askClaude }) {
  const media = await mediaList(root, fromFiles);
  const pages = await pageList(root);
  const answer = await ask({ system: SYSTEM, prompt: entryPrompt({ mode, page, folder, from, slots, draft, media, pages, single }) });
  const parsed = parseAnswer(answer.text);
  const checked = await checkEntry(slots, parsed?.entry, { media, root, draft });
  const told = Array.isArray(parsed?.notes) ? parsed.notes.filter((n) => typeof n === 'string').map((n) => `The AI: ${clean(n).slice(0, 200)}`).slice(0, 6) : [];
  return { entry: checked.entry, notes: [...checked.notes, ...told], by: { model: answer.model, way: answer.way, ms: answer.ms, costUsd: answer.costUsd } };
}
