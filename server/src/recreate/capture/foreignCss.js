// The state rules of stylesheets the page itself may not read.
//
// A cross-origin stylesheet served without CORS is opaque to the page: `sheet.cssRules` throws, so the hover and
// focus rules of a CDN-hosted design system were invisible to the capture - and nothing counted how many were lost.
// Here the text is read server-side instead (from the shared cache, which already holds every file the job's
// browsers loaded, so usually at no network cost) and parsed with assets/css.js parseStateRules.
//
// Why not simply let the browser read it: making a sheet readable means asking for it with CORS, and a CORS fetch
// that fails means the stylesheet does not apply at all. The capture would silently lose the site's styling and
// every number would read as though the site had looked plain. A server-side parse cannot affect the capture.
import { readFile } from 'node:fs/promises';
import { parseStateRules } from '../assets/css.js';

// Kept small on purpose: this runs inside a page's capture budget, beside everything else it has to do.
export const MAX_FOREIGN_SHEETS = 6;
export const FOREIGN_BUDGET_MS = 4000;
export const MAX_FOREIGN_BYTES = 2 * 1024 * 1024;
export const MAX_FOREIGN_RULES = 400;

/** A stylesheet the job's browsers already loaded, read back from the shared cache. null = not there. */
async function fromCache(cache, url) {
  const entry = cache?.lookup?.(url);
  if (!entry || entry.bytes > MAX_FOREIGN_BYTES) return null;
  try {
    return await readFile(entry.file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Reads the stylesheets the page could not and returns their state rules, in the shape
 * capture/interactions.js scanRules produces for a readable sheet.
 * @param {string[]} hrefs                  snapshot.unreadableSheets
 * @param {object} o
 * @param {object} [o.cache]                the job's shared cache (audit/sharedCache.js)
 * @param {(url: string) => Promise<string|null>} [o.fetchText]  fallback for a sheet the cache does not hold
 * @param {number} [o.deadline]
 * @returns {Promise<{ rules: object[], stats: object }>}
 */
export async function harvestForeignStateRules(hrefs, { cache = null, fetchText = null, deadline = Infinity, max = MAX_FOREIGN_SHEETS } = {}) {
  const stats = { sheets: 0, fromCache: 0, fetched: 0, failed: 0, rules: 0, truncated: 0, unparsed: 0, bytes: 0, skipped: 0 };
  const rules = [];
  const list = [...new Set((hrefs ?? []).filter((h) => typeof h === 'string' && /^https?:/i.test(h)))];
  if (list.length > max) stats.skipped = list.length - max;
  for (const url of list.slice(0, max)) {
    if (Date.now() > deadline || rules.length >= MAX_FOREIGN_RULES) {
      stats.skipped++;
      continue;
    }
    stats.sheets++;
    let text = await fromCache(cache, url);
    if (text != null) stats.fromCache++;
    else if (fetchText) {
      try {
        text = await fetchText(url);
        if (text != null) stats.fetched++;
      } catch {
        text = null;
      }
    }
    if (text == null) {
      stats.failed++;
      continue;
    }
    stats.bytes += Buffer.byteLength(text);
    const parsed = parseStateRules(text, { max: MAX_FOREIGN_RULES - rules.length });
    stats.rules += parsed.rules.length;
    stats.unparsed += parsed.unparsed;
    if (parsed.truncated) stats.truncated++;
    for (const rule of parsed.rules) rules.push({ ...rule, href: url, source: 'downloaded' });
  }
  return { rules, stats };
}

/**
 * The harvested rules as a stylesheet to put into the page, so the probe reads them exactly as it reads the sheets
 * the browser allowed. Only state rules are written, so nothing of the page's resting look can change: a
 * `:hover` rule matches nothing until the probe forces the state.
 */
export function foreignStyleText(rules) {
  const body = (rule) => {
    const decls = Object.entries(rule.decls ?? {}).map(([prop, value]) => `${prop}: ${value}`).join('; ');
    return decls ? `${rule.selector} { ${decls} }` : '';
  };
  return (rules ?? []).map((rule) => {
    const text = body(rule);
    if (!text) return '';
    return rule.media ? `@media ${rule.media} { ${text} }` : text;
  }).filter(Boolean).join('\n');
}
