// @ts-check
// Which captured element each Framer appear id is (behavior/framer/appear.js reads the settings, this says where they go).
// The snapshot keeps only the attributes a copy needs, so it does not carry `data-framer-appear-id`; this page function,
// run on the desktop view right after the snapshot, lists every element that has one by the snapshot's own path
// (capture/snapshot.js: body>div:1>a:2, counting same-tag element siblings), together with how it looked then.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APPEAR_ATTR } from './appear.js';

/** Beside the view captures of a page: capture/<slug>/framer-appear.json (written only when the page has such elements). */
export const APPEAR_FILE = 'framer-appear.json';
const MAX_ELEMENTS = 2000;

/**
 * Page function: `{ attr, elements: [{ id, path, style, opacity, transform }] }` for every element carrying `attr`.
 * @param {string} attr
 */
export function readAppearElements(attr) {
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) {
        parts.push('body');
        break;
      }
      let index = 0;
      for (const s of n.parentElement ? n.parentElement.children : []) {
        if (SKIP_TAGS.has(s.tagName)) continue;
        if (s.tagName === n.tagName) index++;
        if (s === n) break;
      }
      parts.push(`${n.tagName.toLowerCase()}:${index}`);
    }
    return parts.length && parts[parts.length - 1] === 'body' ? parts.reverse().join('>') : null;
  };
  const elements = [];
  for (const el of document.querySelectorAll(`[${attr}]`)) {
    if (elements.length >= 5000) break;
    const cs = getComputedStyle(el);
    elements.push({ id: el.getAttribute(attr), path: pathOf(el), style: (el.getAttribute('style') ?? '').slice(0, 500), opacity: cs.opacity, transform: cs.transform });
  }
  return { attr, elements };
}

/** Lists the page's appear elements (desktop view) and writes them beside its capture; returns the count, or 0. */
export async function captureAppearElements(page, dir) {
  const found = await page.evaluate(readAppearElements, APPEAR_ATTR).catch(() => null);
  const elements = (found?.elements ?? []).filter((e) => e.id && e.path).slice(0, MAX_ELEMENTS);
  if (!elements.length) return 0;
  await writeFile(path.join(dir, APPEAR_FILE), JSON.stringify({ attr: APPEAR_ATTR, elements }));
  return elements.length;
}

/**
 * The page's appear elements, or null when the capture has none (or predates this reader).
 * @param {string} dir   the recreate workspace
 * @param {{ slug: string }} page
 */
export async function readAppearFor(dir, page) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'capture', page.slug, APPEAR_FILE), 'utf8'));
  } catch {
    return null;
  }
}
