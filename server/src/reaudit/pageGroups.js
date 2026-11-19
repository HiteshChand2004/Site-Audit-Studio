import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

/** Page groups (default off): SAS_PAGE_GROUPS_MIN = the fewest pages a copy needs before its pages are grouped (≥ 2). */
export function groupMin(env = process.env) {
  const n = Number(String(env.SAS_PAGE_GROUPS_MIN ?? '').trim());
  return Number.isInteger(n) && n >= 2 ? n : null;
}

/** A page with less visible text than this is a shell its script fills (its HTML says nothing of its layout): measured alone. */
export const MIN_TEXT = 200;
const SKIP = ['script', 'style', 'noscript', 'template'];

/**
 * A page's shape: which tags each element of its body holds (4 levels; the set, not the order or count, so two posts with
 * their paragraphs and headings in another order are one shape) and its stylesheet / script files. A shell (little text) has
 * no shape (null): it is measured on its own.
 */
export function pageShape(html) {
  const $ = cheerio.load(html);
  const text = $('body').clone().find(SKIP.join(',')).remove().end().text().replace(/\s+/g, ' ').trim().length;
  if (text < MIN_TEXT) return null;
  const walk = (el, depth) => {
    if (!el || depth > 4) return '';
    const set = new Set();
    for (const k of $(el).children().toArray()) if (!SKIP.includes(k.tagName)) set.add(k.tagName === 'svg' ? 'svg' : `${k.tagName}(${walk(k, depth + 1)})`);
    return [...set].sort().join(',');
  };
  const files = [
    ...$('link[rel~=stylesheet][href]').map((_, e) => $(e).attr('href').split('?')[0]).get(),
    ...$('script[src]').map((_, e) => $(e).attr('src').split('?')[0]).get(),
  ].sort();
  return createHash('sha1').update(walk($('body')[0], 0)).update('\n').update(files.join('\n')).digest('hex').slice(0, 12);
}

/**
 * Which pages are measured: the homepage, and the first `reps` pages of each shape (pages in their given order); a page whose
 * shape is unknown (null) is measured. `through` = the pages measured through their group, with the page that stands for them.
 */
export function planGroups(pages, shapeOf, { reps = 2 } = {}) {
  const seen = new Map();
  const measure = [];
  const through = [];
  for (const p of pages) {
    const shape = p.path === '/' ? null : shapeOf(p);
    if (!shape) {
      measure.push(p);
      continue;
    }
    const g = seen.get(shape) ?? [];
    seen.set(shape, g);
    if (g.length < reps) {
      g.push(p.path);
      measure.push(p);
    } else through.push({ path: p.path, rep: g[0], shape });
  }
  return { measure, through, groups: seen.size };
}
