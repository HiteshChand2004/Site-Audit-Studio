// @ts-check
// DOM helpers for the preserved-component extraction (CLONER_SPEC: "preserve, don't regenerate").
// A capture path is `body>div:1>section:2>ul:1`: each step is a tag and its 1-based index among the SAME-TAG siblings
// (capture/snapshot.js `tagIndex`). These helpers resolve such a path in the original's as-is HTML (capture/asis.js) and
// give a path back for an element, so the two notations meet. Nothing here fetches or runs anything.
import { load } from 'cheerio';

/**
 * Resolves a capture path in a cheerio document, or null when it does not exist there.
 * @param {ReturnType<typeof load>} $
 * @param {string} path
 */
export function resolvePath($, path) {
  const steps = String(path ?? '').split('>');
  if (steps.shift() !== 'body') return null;
  /** @type {any} */
  let el = $('body')[0];
  for (const step of steps) {
    const [tag, index] = step.split(':');
    const kids = (el?.children ?? []).filter((/** @type {any} */ c) => c.type === 'tag' && c.name === tag);
    el = kids[Number(index) - 1];
    if (!el) return null;
  }
  return el ?? null;
}

/**
 * The capture path of an element in the document (the inverse of resolvePath).
 * @param {any} el
 * @returns {string|null}
 */
export function pathOfElement(el) {
  const steps = [];
  let node = el;
  while (node && node.type === 'tag' && node.name !== 'html') {
    if (node.name === 'body') {
      steps.unshift('body');
      return steps.join('>');
    }
    const parent = node.parent;
    if (!parent) return null;
    const same = (parent.children ?? []).filter((/** @type {any} */ c) => c.type === 'tag' && c.name === node.name);
    steps.unshift(`${node.name}:${same.indexOf(node) + 1}`);
    node = parent;
  }
  return null;
}

/**
 * The snapshot tree (capture desktop.json `body`) indexed by path: rect and tag of every node that has a path.
 * @param {any} body
 * @returns {Map<string, { tag: string, rect: number[]|null }>}
 */
export function indexSnapshot(body) {
  /** @type {Map<string, { tag: string, rect: number[]|null }>} */
  const map = new Map();
  const walk = (/** @type {any} */ node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.path === 'string') map.set(node.path, { tag: node.tag, rect: Array.isArray(node.rect) ? node.rect : null });
    for (const child of node.children ?? []) walk(child);
  };
  walk(body);
  return map;
}

/** The ancestor paths of a capture path, nearest last: `body>div:1>p:1` → [`body`, `body>div:1`]. */
export function ancestorsOf(path) {
  const steps = String(path).split('>');
  const out = [];
  for (let i = 1; i < steps.length; i++) out.push(steps.slice(0, i).join('>'));
  return out;
}
