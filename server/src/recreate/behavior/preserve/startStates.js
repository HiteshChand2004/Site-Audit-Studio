// The start states a removed runtime leaves behind. An animation library renders an element's entrance into the page's own HTML
// as its first frame (`style="opacity:0;transform:translateY(18px)"`) and its script animates it to the end state once the page
// runs. A page written without that runtime (runtimeFree.js) keeps the first frame for good: the element is invisible, also for
// the copy's own rebuilt reveal, whose animation ends on the element's own style - that inline opacity:0 again
// (testpilot.panscience.ai: the homepage's demo picture and every section below it never showed).
//
// The evidence is the capture: the desktop snapshot recorded every element as the original showed it once it was loaded and
// scrolled through (capture/snapshot.js keeps only values that differ from the browser's default, so a missing opacity is 1 and
// a missing transform is none). An inline declaration that hides or moves an element the capture saw shown and in place is the
// script's start state, and is dropped: the page's stylesheet decides, as it did on the original once its script ran. An element
// the capture saw hidden too, or one the capture has no element for at that place, is left as it is.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

/** The inline properties an entrance starts from, and whether a value of each hides or moves the element. */
const START = {
  opacity: (v) => Number.parseFloat(v) < 0.99,
  visibility: (v) => /^(hidden|collapse)$/i.test(v.trim()),
  transform: (v) => !/^(none|matrix\(\s*1,\s*0,\s*0,\s*1,\s*0,\s*0\s*\)|translate[3dXYZ]*\(\s*0(px|%)?(\s*,\s*0(px|%)?){0,2}\s*\)|scale\(\s*1\s*\))$/i.test(v.trim()),
  translate: (v) => !/^(none|0(px|%)?(\s+0(px|%)?){0,2})$/i.test(v.trim()),
  scale: (v) => !/^(none|1(\s+1){0,2})$/i.test(v.trim()),
  rotate: (v) => !/^(none|0(deg|turn|rad)?)$/i.test(v.trim()),
  filter: (v) => /blur\(\s*(?!0(px)?\s*\))|opacity\(/i.test(v),
};
/** The captured value says the original showed the property at rest: absent (the browser's default) or a value that neither
 * hides nor moves. */
const atRest = (prop, v) => v == null || !START[prop](String(v));
const PROPS = Object.keys(START);

/** One inline style split into its declarations (a `;` inside brackets or quotes is not a separator). */
export function declarationsOf(style) {
  const out = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  const s = String(style ?? '');
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if ((c === ';' && depth === 0) || i === s.length) {
      const text = s.slice(from, i).trim();
      from = i + 1;
      if (!text) continue;
      const colon = text.indexOf(':');
      out.push(colon < 0 ? { text } : { text, prop: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).replace(/!important\s*$/i, '').trim() });
    }
  }
  return out;
}

/** The capture path of an element of a parsed page (the rule elementAt reads: from <body>, the n-th child with that tag). */
function capturePathOf(el) {
  const steps = [];
  let node = el;
  while (node && node.name !== 'body') {
    const parent = node.parent;
    if (!parent || !node.name) return null;
    const same = (parent.children ?? []).filter((c) => (c.type === 'tag' || c.type === 'script' || c.type === 'style') && c.name === node.name);
    steps.unshift(`${node.name}:${same.indexOf(node) + 1}`);
    node = parent;
  }
  return node ? ['body', ...steps].join('>') : null;
}

const classSet = (v) => String(v ?? '').split(/\s+/).filter(Boolean).sort().join(' ');

/**
 * Each page's elements as the capture's desktop snapshot recorded them, by capture path: { tag, cls, style } (only the
 * properties an entrance moves). Pages without a snapshot are left out.
 * @param {{ dir: string, pages: { outPath: string }[] }} o  dir: the job folder (its capture/ and capture/manifest.json)
 * @returns {Promise<Map<string, Map<string, { tag: string, cls: string, style: object }>>>} by outPath
 */
export async function settledStyles({ dir, pages }) {
  const out = new Map();
  if (!dir) return out;
  const manifest = await readFile(path.join(dir, 'capture', 'manifest.json'), 'utf8').then(JSON.parse, () => null);
  const wanted = new Set(pages.map((p) => p.outPath));
  for (const info of manifest?.pages ?? []) {
    if (!wanted.has(info.outPath)) continue;
    const snap = await readFile(path.join(dir, 'capture', info.slug, 'desktop.json'), 'utf8').then(JSON.parse, () => null);
    if (!snap?.body) continue;
    const byPath = new Map();
    const walk = (n) => {
      if (!n || typeof n !== 'object' || !n.tag) return;
      if (n.path) byPath.set(n.path, { tag: n.tag, cls: classSet(n.attrs?.class), style: Object.fromEntries(PROPS.map((p) => [p, n.style?.[p]])) });
      for (const c of n.children ?? []) walk(c);
    };
    walk(snap.body);
    out.set(info.outPath, byPath);
  }
  return out;
}

/**
 * The page with every inline start state the capture proves the original's script took away dropped (see the head of this
 * file). `settled`: this page's part of settledStyles.
 * @returns {{ html: string, cleared: number, declarations: number }}
 */
export function withoutStartStates(html, settled) {
  if (!settled?.size) return { html, cleared: 0, declarations: 0 };
  const $ = cheerio.load(html);
  let cleared = 0;
  let declarations = 0;
  $('body [style]').each((_, el) => {
    const decls = declarationsOf($(el).attr('style'));
    const hiding = decls.filter((d) => d.prop && START[d.prop]?.(d.value));
    if (!hiding.length) return;
    const cpath = capturePathOf(el);
    const seen = cpath ? settled.get(cpath) : null;
    // The same element as captured: same tag, same classes (the runtime may have added or removed elements before it).
    if (!seen || seen.tag !== el.name || seen.cls !== classSet($(el).attr('class'))) return;
    const drop = new Set(hiding.filter((d) => atRest(d.prop, seen.style[d.prop])));
    if (!drop.size) return;
    const kept = decls.filter((d) => !drop.has(d)).map((d) => d.text);
    if (kept.length) $(el).attr('style', kept.join(';'));
    else $(el).removeAttr('style');
    cleared++;
    declarations += drop.size;
  });
  return cleared ? { html: $.html(), cleared, declarations } : { html, cleared: 0, declarations: 0 };
}
