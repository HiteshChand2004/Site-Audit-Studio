import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

/** Page groups (default off): SAS_PAGE_GROUPS_MIN = the fewest pages a copy needs before its pages are grouped (≥ 2). */
export function groupMin(env = process.env) {
  const n = Number(String(env.SAS_PAGE_GROUPS_MIN ?? '').trim());
  return Number.isInteger(n) && n >= 2 ? n : null;
}

/** A page's shape: its body's tags (6 levels; a run of equal sibling tags counts once) and its stylesheet / script files. */
export function pageShape(html) {
  const $ = cheerio.load(html);
  const walk = (el, depth) => {
    if (!el || depth > 6) return '';
    const kids = $(el).children().toArray().filter((k) => !['script', 'style', 'noscript', 'template'].includes(k.tagName));
    const parts = [];
    for (const k of kids) {
      const s = k.tagName === 'svg' ? 'svg' : `${k.tagName}(${walk(k, depth + 1)})`;
      if (parts.at(-1) !== s) parts.push(s);
    }
    return parts.join(',');
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
