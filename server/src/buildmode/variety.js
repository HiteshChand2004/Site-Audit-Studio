// @ts-check
// Every plan gets designs of its own, every time. Two owners who write almost the same request (or click the same example),
// or one owner asking again, get the same playbooks and, left alone, the model's favourite fonts, colours and hero; the sites
// would look alike. So before the brief is written, with no model, each of the 3 directions is handed its own set of design
// ingredients drawn at random: no two directions of one plan share any ingredient; every set differs from each direction
// the same owner was offered in their last OWN_WINDOW directions in at least MIN_OWN ingredients, and from each direction
// anyone was offered in the last WINDOW in at least MIN_ANY. (Measured over 250 plans in a row: both always hold; 5 of 7 for
// the owner does not.) The brief writer also hears which fonts and main colours those recent designs already use.
// Every plan records its directions (recordDesigns) in data/buildmode/designs.json, the memory the next draw avoids.
import { randomInt } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config/paths.js';

export const HISTORY_FILE = path.join(DATA_DIR, 'buildmode', 'designs.json');
const WINDOW = 300; // directions: about the last 100 plans of everyone (also all that is kept)
const OWN_WINDOW = 90; // directions: the owner's last 30 plans
const MIN_ANY = 3;
const MIN_OWN = 4;
const RECENT = 30; // directions whose fonts and colours the brief writer hears, the owner's and everyone's
const ATTEMPTS = 400;

/** Each axis: options general enough for any kind of site; the brief writer interprets them for this business. */
export const AXES = {
  hero: [
    'full-bleed image with the headline set low on it',
    'split screen: headline and action on one side, image on the other',
    'oversized type filling the first screen, the image below it',
    'a framed image inside a coloured field, the headline overlapping its edge',
    'a narrow centred column of text on a quiet background, the image as a wide band beneath',
    'an editorial collage of two or three offset frames around the headline',
    'stacked horizontal bands: name, promise and action each a strip of its own',
    'an asymmetric grid: the headline in one large cell, key facts and the action in small cells around it',
  ],
  navigation: [
    'a slim top bar, links on the right',
    'the logo centred, links split either side of it',
    'logo left, links centred, the main action as a button on the right',
    'a menu button that opens a full-screen overlay, on every screen size',
    'a vertical side rail on desktop, a top bar on phones',
    'a transparent bar over the first screen that turns solid once scrolled',
  ],
  type: [
    'a high-contrast display serif for headings with a plain grotesque for text',
    'a geometric sans used large and tight for headings, a humanist sans for text',
    'a condensed sans in capitals for headings, a book serif for text',
    'a soft rounded sans throughout, in two weights',
    'a slab serif for headings, a neutral sans for text',
    'an old-style serif throughout, italics for accents',
    'a wide extended sans for headings, a compact sans for text',
    'a monospace for small labels and numbers, a serif for headings, a sans for text',
  ],
  palette: [
    'a dark background with light text and one vivid accent',
    'a light warm neutral background with one deep colour carrying the brand',
    'two strong colours in large blocks, alternating section by section',
    'almost monochrome: tints and shades of one hue, with a single contrasting accent',
    'a pale tinted background (not white), dark ink and a saturated accent',
    'earthy, muted mid-tones anchored by one dark colour',
    'black and white with one bright colour used sparingly',
    'a deep jewel-tone base with a light, luminous accent',
  ],
  rhythm: [
    'full-width sections alternating their background colour',
    'content on a visible column grid, thin rules between sections',
    'cards on a tinted background with generous gaps',
    'a long editorial scroll: big type, wide margins, few boxes',
    'overlapping layers: sections tucked under one another, images offset across their edges',
    'a bento grid of mixed-size tiles for the main content',
    'a narrow reading column with wide images breaking out of it',
  ],
  detail: [
    'numbered sections (01, 02 …) as a structural device',
    'a hand-drawn-feeling underline or circle on a few key words, drawn in SVG',
    'a slowly running band of short phrases between two sections',
    'images in a distinctive shape: arched tops, circles or cut corners',
    'a subtle grain or paper texture over flat colour',
    'thin outlined boxes and hairline rules, no shadows anywhere',
    'large decorative numerals or initials behind headings',
    'a small label beside each section naming it, that stays in view while it scrolls',
  ],
  opening: [
    'the offer itself: what they sell or do, shown first',
    'the place or the atmosphere',
    'the people behind it',
    'where it started: the origin story',
    'what the visitor walks away with',
  ],
};
const AXIS_NAMES = Object.keys(AXES);

/** Fonts nearly every generated site reaches for; a direction uses them only when the owner named them. */
export const OVERUSED_FONTS = ['Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Playfair Display', 'Raleway', 'Arial', 'Helvetica'];

/** How many ingredients two sets do not share. */
export const distance = (/** @type {Record<string, string>} */ a, /** @type {Record<string, string>} */ b) => AXIS_NAMES.filter((k) => a?.[k] !== b?.[k]).length;

/** A Fisher–Yates shuffle with the given source of randomness (`random(n)` = an integer in [0, n)). */
function shuffled(/** @type {string[]} */ items, /** @type {(n: number) => number} */ random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Draws `count` ingredient sets: no ingredient shared between them, each at least MIN_ANY ingredients away from every set in
 * `used` and MIN_OWN away from every set in `own`. When that is impossible, the draw that comes closest is kept.
 * @param {{ count?: number, used?: Record<string, string>[], own?: Record<string, string>[], random?: (n: number) => number }} [o]
 */
export function drawIngredients({ count = 3, used = [], own = [], random = randomInt } = {}) {
  const nearest = (/** @type {Record<string, string>} */ s, /** @type {Record<string, string>[]} */ list) => (list.length ? Math.min(...list.map((u) => distance(s, u))) : AXIS_NAMES.length);
  /** @type {Record<string, string>[]} */
  let best = [];
  let bestScore = -Infinity;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const columns = Object.fromEntries(AXIS_NAMES.map((k) => [k, shuffled(AXES[/** @type {keyof typeof AXES} */ (k)], random)]));
    const sets = Array.from({ length: count }, (_, i) => Object.fromEntries(AXIS_NAMES.map((k) => [k, columns[k][i]])));
    // The worst set decides: how far it stays from the nearest earlier design, against the rule that applies (0 = just enough).
    const score = Math.min(...sets.map((s) => Math.min(nearest(s, used) - MIN_ANY, nearest(s, own) - MIN_OWN)));
    if (score > bestScore) [best, bestScore] = [sets, score];
    if (score >= 0) break;
  }
  return best;
}

/** The designs recorded so far, newest last; an unreadable file counts as none. */
export async function readHistory(file = HISTORY_FILE) {
  const data = await readFile(file, 'utf8').then(JSON.parse, () => null);
  return Array.isArray(data?.designs) ? data.designs : [];
}

/** One write at a time: two plans finishing together must not drop each other's directions. */
let writing = Promise.resolve();

/**
 * Remembers the directions a plan offered (all of them: the owner may build any, or ask again), so later plans are drawn
 * away from them. Directions without ingredients (a plan for an existing site) are not recorded.
 * @param {{ directions: any[], siteType?: string, ownerId?: string | null }} o
 */
export function recordDesigns({ directions, siteType, ownerId = null }, file = HISTORY_FILE) {
  const fresh = (directions ?? []).filter((d) => d?.ingredients).map((d) => entry(d, ownerId, siteType));
  if (!fresh.length) return Promise.resolve();
  writing = writing.catch(() => {}).then(async () => save([...await readHistory(file), ...fresh], file));
  return writing;
}

/** A direction as the history keeps it. */
const entry = (/** @type {any} */ d, /** @type {string | null} */ ownerId, /** @type {string | null | undefined} */ siteType) => ({
  at: new Date().toISOString(),
  ownerId,
  siteType: siteType ?? null,
  name: d.name ?? '',
  ingredients: d.ingredients,
  fonts: { heading: d.fonts?.heading ?? '', body: d.fonts?.body ?? '' },
  primary: (d.palette ?? []).find((/** @type {any} */ c) => c.role === 'primary')?.hex ?? null,
});

async function save(/** @type {any[]} */ designs, /** @type {string} */ file) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ designs: designs.slice(-WINDOW) }, null, 2));
  await rename(tmp, file);
}

/**
 * Notes that a direction is being built; true when it was built before (the owner pressed "Build again"), which earns the
 * build a design of its own. A direction the history no longer holds is added.
 * @param {{ direction: any, ownerId?: string | null }} o
 * @returns {Promise<boolean>}
 */
export function claimBuild({ direction, ownerId = null }, file = HISTORY_FILE) {
  if (!direction?.ingredients) return Promise.resolve(false);
  let before = false;
  writing = writing.catch(() => {}).then(async () => {
    const designs = await readHistory(file);
    const same = designs.filter((d) => (d.ownerId ?? null) === ownerId && distance(d.ingredients, direction.ingredients) === 0);
    before = same.some((d) => d.built);
    if (same.length) for (const d of same) d.built = (d.built ?? 0) + 1;
    else designs.push({ ...entry(direction, ownerId, null), built: 1 });
    await save(designs, file);
  });
  return writing.then(() => before);
}

/**
 * What the brief writer gets for a new site: an ingredient set per direction, and what recent designs (the owner's own
 * first) already look like.
 * @param {{ ownerId?: string | null, file?: string, random?: (n: number) => number }} [o]
 */
export async function planVariety({ ownerId = null, file = HISTORY_FILE, random } = {}) {
  const history = await readHistory(file);
  const mine = history.filter((d) => (d.ownerId ?? null) === ownerId).slice(-OWN_WINDOW);
  const ingredients = drawIngredients({ used: history.map((d) => d.ingredients), own: mine.map((d) => d.ingredients), random });
  const recent = [...mine.slice(-RECENT), ...history.slice(-RECENT)].map((d) => ({ fonts: d.fonts, primary: d.primary }));
  return { ingredients, recent };
}

/** The variety block of the brief writer's instructions. */
export function varietyText(/** @type {{ ingredients: Record<string, string>[], recent: any[] }} */ variety) {
  const sets = variety.ingredients.map((set, i) => [`Direction ${i + 1}:`, ...AXIS_NAMES.map((k) => `- ${k}: ${set[k]}`)].join('\n'));
  const pairs = [...new Set(variety.recent.filter((r) => r.fonts?.heading).map((r) => `${r.fonts.heading} + ${r.fonts.body}`))];
  const colours = [...new Set(variety.recent.map((r) => r.primary).filter(Boolean))];
  return [
    '# Design ingredients',
    'Every site this service builds must look like no other, and an owner who asks again must get something new. Each',
    'direction is built on its own set below (direction 1 on',
    'set 1, and so on): read each ingredient as a starting point and interpret it so it suits this business and audience;',
    'it shapes that direction\'s palette, fonts, layout, imagery and the order of the homepage. Where one truly cannot fit,',
    'use the nearest thing that does and say so in why. The owner\'s own words come first: a colour, font or layout the owner',
    'asked for is kept in every direction, and the ingredients decide everything the owner left open.',
    '',
    ...sets.flatMap((s) => [s, '']),
    `Fonts: pick a distinctive pair per direction, three different pairs. Never use ${OVERUSED_FONTS.join(', ')} unless the owner named them.`,
    ...(pairs.length ? [`Heading + body pairs recent sites already use (never repeat one): ${pairs.join('; ')}.`] : []),
    ...(colours.length ? [`Main colours recent sites already use (choose a primary clearly different from each): ${colours.join(', ')}.`] : []),
  ].join('\n');
}

/** Puts each drawn ingredient set on its direction, so the agent and the history get the same one. */
export function attachIngredients(/** @type {any} */ brief, /** @type {Record<string, string>[]} */ ingredients) {
  const directions = brief.design?.directions;
  if (!Array.isArray(directions)) return brief;
  return { ...brief, design: { ...brief.design, directions: directions.map((d, i) => (ingredients[i] ? { ...d, ingredients: ingredients[i] } : d)) } };
}
