// What shape an authored :hover / :focus selector has.
//
// capture/interactions.js scanRules has kept the authored selector text of every state rule since Phase 4b, and
// nothing ever read it: it was evidence with no reader. Classifying it gives the one number that says whether an
// effect reaching outside the hovered element was rebuilt or lost - `report.motion.rules.shapes` counts what the
// original has, and ir/motion.js counts what the copy carries. The class names in these selectors never survive
// into the copy, so this is for accounting only; the effects themselves are measured by the probe.
const STATE = /:(hover|focus-visible|focus-within|focus|active)\b/;

/** Splits a selector list on commas that are not inside brackets or quotes. */
export function splitSelectorList(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * The shape of one complex selector that carries a state:
 *   `self`        the state is on the element the rule styles (`.card:hover`)
 *   `descendant`  the rule styles something inside it (`.card:hover .arrow`)
 *   `sibling`     something after it (`.card:hover ~ .card`)
 *   `adjacent`    the one right after it (`.a:hover + .b`)
 *   `ancestorHas` the element that contains the hovered one (`.nav:has(a:hover)`)
 *   `negated`     the opposite state (`.card:not(:hover) .panel`)
 *   `pseudoEl`    a pseudo-element of it (`.link:hover::after`)
 *   `other`       carries no state at all
 * `sibling`, `adjacent` and `ancestorHas` are the ones that were silently dropped before this step.
 * @returns {string|null} null when the selector has no state in it
 */
export function selectorShape(part) {
  if (!part || !STATE.test(part)) return null;
  if (/:not\(\s*:(hover|focus(-visible|-within)?|active)/.test(part)) return 'negated';
  // Where the state sits, ignoring anything inside brackets.
  let depth = 0;
  let quote = null;
  let at = -1;
  let inHas = false;
  const opens = [];
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') {
      const fn = /:([\w-]+)$/.exec(part.slice(0, i));
      opens.push(fn ? fn[1].toLowerCase() : '');
      depth++;
    } else if (c === '[') { opens.push('['); depth++; } else if (c === ')' || c === ']') { opens.pop(); depth--; } else if (c === ':' && part[i + 1] !== ':' && STATE.test(part.slice(i, i + 16))) {
      const m = /^:(hover|focus-visible|focus-within|focus|active)\b/.exec(part.slice(i));
      if (m && at < 0) {
        at = i;
        inHas = opens.includes('has');
      }
    }
  }
  if (at < 0) return 'other';
  if (inHas) return 'ancestorHas';
  // What follows the compound that holds the state decides the rest.
  const rest = part.slice(at + 1).replace(/^[\w-]+/, '');
  if (/^::?[\w-]/.test(rest.trim())) return 'pseudoEl';
  const combinator = /^\s*([>+~])\s*|^\s+/.exec(rest);
  if (!combinator) return 'self';
  const sign = combinator[1];
  if (sign === '~') return 'sibling';
  if (sign === '+') return 'adjacent';
  return 'descendant';
}

/**
 * How many rules of each shape the original has.
 * @param {{ selector: string }[]} rules  motion.json `rules` (capture/interactions.js scanRules)
 * @returns {Record<string, number>}
 */
export function shapeCounts(rules) {
  const out = {};
  for (const rule of rules ?? []) {
    for (const part of splitSelectorList(rule.selector ?? '')) {
      const shape = selectorShape(part);
      if (shape) out[shape] = (out[shape] ?? 0) + 1;
    }
  }
  return out;
}

/** The shapes whose effects reach outside the hovered element: what step 4 of the gap work exists to rebuild. */
export const OUTWARD_SHAPES = ['sibling', 'adjacent', 'ancestorHas'];
