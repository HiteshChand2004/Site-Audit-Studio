// Site-wide pass over the page heads once every page has one: a title or description that is too short,
// too long or the same as another page's is rewritten from the page's own content (its heading, its
// address, paragraphs no other page has), so the copy passes the same SEO checks the audit runs
// (title 10–60 characters, description 50–160, both unique). The homepage keeps its own text when it is
// fine; every rewritten value is reported as auto-generated with the reason. Also: the page language
// guessed from the text when the original declares none.
import { clip } from './head.js';
import { deepText, isElement } from './tree.js';

export const TITLE_RANGE = [10, 60];
export const DESCRIPTION_RANGE = [50, 160];

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fits = (t, [min, max]) => t.length >= min && t.length <= max;
const SEPARATOR = /\s+[|–—·•:-]\s+(?!.*\s[|–—·•:-]\s)/;

// Copies the page shows only on demand (other tab states, hover copies, click messages) are not page text.
const shownNode = (n) => n.attrs?.hidden == null && n.attrs?.['data-w-hcopy'] == null && n.attrs?.['data-w-note-of'] == null
  && !(n.views?.desktop?.hidden);

function collect(root, test) {
  const out = [];
  const walk = (n) => {
    if (!isElement(n) || !shownNode(n)) return;
    if (test(n)) out.push(n);
    else n.children.forEach(walk);
  };
  walk(root);
  return out;
}

const firstHeading = (root) => {
  for (const tag of ['h1', 'h2']) {
    const hit = collect(root, (n) => n.tag === tag && clean(deepText(n)))[0];
    if (hit) return clean(deepText(hit));
  }
  return '';
};

/** A readable name from the page address: "/about-us/" → "About us". */
export function pathLabel(path) {
  const last = decodeURIComponent(String(path ?? '').replace(/\/+$/, '').split('/').pop() ?? '').replace(/\.html?$/i, '');
  const words = last.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/** Shortens a title: drops trailing " | Site" style parts first, then cuts at a word. Too short → site name added. */
export function fitTitle(text, siteName) {
  let t = clean(text);
  while (t.length > TITLE_RANGE[1] && SEPARATOR.test(t)) {
    const cut = t.replace(SEPARATOR, '\u0000').split('\u0000')[0].trim();
    if (cut.length < TITLE_RANGE[0]) break;
    t = cut;
  }
  if (t.length > TITLE_RANGE[1]) t = clip(t, TITLE_RANGE[1]);
  if (t.length < TITLE_RANGE[0] && siteName && !t.includes(siteName)) {
    const longer = t ? `${t} | ${siteName}` : siteName;
    if (longer.length <= TITLE_RANGE[1]) t = longer;
  }
  return t;
}

/** Joins texts until the description range is reached, cut at a sentence or word. */
export function fitDescription(parts) {
  let out = '';
  for (const p of parts.map(clean).filter(Boolean)) {
    if (out.includes(p)) continue;
    out = out ? `${out.replace(/[.!?]?$/, (m) => m || '.')} ${p}` : p;
    if (out.length >= DESCRIPTION_RANGE[0]) break;
  }
  return out.length > DESCRIPTION_RANGE[1] ? clip(out, DESCRIPTION_RANGE[1]) : out;
}

/**
 * Rewrites titles and descriptions that fail the length or uniqueness checks. Mutates t.head / t.headAuto.
 * @param {{ info: { path: string }, root: object, head: object, headAuto: object[] }[]} trees  homepage first
 * @param {string} siteName
 * @returns {{ titles: number, descriptions: number }}
 */
export function refineHeadTexts(trees, siteName) {
  const counts = { titles: 0, descriptions: 0 };
  // Paragraph texts per page; one shared by several pages (footer, newsletter box) never describes a page.
  const paragraphs = trees.map((t) => collect(t.root, (n) => /^(p|li|blockquote|dd)$/.test(n.tag)).map((n) => clean(deepText(n))).filter((x) => x.length >= 25));
  const seenOn = new Map();
  paragraphs.forEach((list) => new Set(list).forEach((p) => seenOn.set(p, (seenOn.get(p) ?? 0) + 1)));
  const own = paragraphs.map((list) => list.filter((p) => seenOn.get(p) === 1));

  const record = (t, field, value, reason) => {
    const old = t.head[field];
    t.head[field] = value;
    t.headAuto = t.headAuto.filter((a) => a.field !== field);
    t.headAuto.push({ field, value, source: reason });
    // An og: copy the recreate filled from the old value follows it.
    const og = `og:${field}`;
    if (t.headAuto.some((a) => a.field === og)) {
      const m = t.head.meta.find((x) => x.property === og && x.content === old);
      if (m) {
        m.content = value;
        t.headAuto = t.headAuto.map((a) => (a.field === og ? { ...a, value, source: field } : a));
      }
    }
  };

  // Duplicates are judged on the original texts (an earlier page's may already be rewritten below).
  const titles = trees.map((t) => clean(t.head.title));
  const descriptions = trees.map((t) => clean(t.head.description));
  const used = new Set();
  trees.forEach((t, i) => {
    const original = titles[i];
    const heading = firstHeading(t.root);
    const label = i === 0 ? '' : pathLabel(t.info.path);
    const duplicate = original && titles.some((o, j) => j < i && o === original);
    const candidates = [
      ...(duplicate ? [] : [fitTitle(original, siteName)]),
      heading && fitTitle(`${heading} | ${siteName}`, siteName),
      heading && fitTitle(heading, siteName),
      label && fitTitle(`${label} | ${siteName}`, siteName),
      heading && label && fitTitle(`${heading} – ${label}`, siteName),
      original && label && fitTitle(`${label} – ${original}`, siteName),
    ].filter((c) => c && fits(c, TITLE_RANGE));
    let title = candidates.find((c) => !used.has(c)) ?? candidates[0] ?? original;
    for (let n = 2; used.has(title) && n < 100; n++) title = `${clip(title.replace(/ \(\d+\)$/, ''), TITLE_RANGE[1] - 5)} (${n})`;
    used.add(title);
    if (title !== original) {
      const reason = duplicate ? 'the same title is on another page' : !original ? 'missing' : original.length > TITLE_RANGE[1] ? 'longer than 60 characters' : 'shorter than 10 characters';
      record(t, 'title', title, `rewritten from the page heading / address (${reason})`);
      counts.titles++;
    }
  });

  const usedDesc = new Set();
  trees.forEach((t, i) => {
    const original = descriptions[i];
    const duplicate = original && descriptions.some((o, j) => j < i && o === original);
    const heading = firstHeading(t.root);
    const candidates = [
      ...(duplicate || !original ? [] : [fitDescription([original, ...own[i]])]),
      fitDescription(own[i]),
      fitDescription([heading, ...own[i]]),
      original && fitDescription([heading || t.head.title, original]),
      fitDescription([t.head.title, original, ...paragraphs[i]]),
    ].filter((c) => c && fits(c, DESCRIPTION_RANGE));
    const description = candidates.find((c) => !usedDesc.has(c)) ?? original;
    usedDesc.add(description);
    if (description && description !== original) {
      const reason = duplicate ? 'the same description is on another page' : !original ? 'missing' : original.length > DESCRIPTION_RANGE[1] ? 'longer than 160 characters' : 'shorter than 50 characters';
      record(t, 'description', description, `rewritten from the page's own text (${reason})`);
      counts.descriptions++;
    }
  });
  return counts;
}

// Language from the text when the page declares none: the script first, then common words of
// Latin-script languages. Returns null unless one language clearly wins.
const SCRIPTS = [
  [/[ऀ-ॿ]/g, 'hi'], [/[ঀ-৿]/g, 'bn'], [/[؀-ۿ]/g, 'ar'], [/[Ѐ-ӿ]/g, 'ru'],
  [/[぀-ヿ]/g, 'ja'], [/[가-힯]/g, 'ko'], [/[一-鿿]/g, 'zh'], [/[฀-๿]/g, 'th'],
  [/[Ͱ-Ͽ]/g, 'el'], [/[֐-׿]/g, 'he'],
];
const WORDS = {
  en: 'the and of to in is for with that on are you your our we this from by as be at or it an have more',
  es: 'el la de que y en los las un una por con para es su al lo como más pero sus le ya o este',
  fr: 'le la les de et des un une est pour que qui dans en du sur au pas plus par avec vous nous ce',
  de: 'der die und das ist zu den mit von nicht sie ein eine für auf dem des im sich wir ihr auch',
  pt: 'o a de que e do da em um uma para com não os as por mais dos das seu sua no na',
  it: 'il la di che e un una per con non sono del della le gli in è al dei più questo',
  nl: 'de het een en van in is dat op te voor met zijn niet aan er ook als bij wij onze',
};
const WORD_SETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

export function detectLang(text) {
  const t = clean(text).slice(0, 20000);
  if (t.length < 80) return null;
  const letters = (t.match(/\p{L}/gu) ?? []).length || 1;
  for (const [re, lang] of SCRIPTS) if ((t.match(re) ?? []).length / letters > 0.3) return lang;
  const words = t.toLowerCase().match(/\p{L}+/gu) ?? [];
  const score = Object.fromEntries(Object.keys(WORD_SETS).map((k) => [k, 0]));
  for (const w of words) for (const [k, set] of Object.entries(WORD_SETS)) if (set.has(w)) score[k]++;
  const [best, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (best[1] < 8 || best[1] < second[1] * 1.6 || best[1] / words.length < 0.08) return null;
  return best[0];
}
