// Builds one responsive element tree per page from the captured views (desktop / laptop / tablet /
// mobile, views.js). Every merged node keeps the captured data of each view it appears in (`views[view]`:
// style diff, box, pseudo-elements), so the stylesheet can be written as a base plus two media queries.
//
// 1. Alignment: the tablet and mobile trees are matched to the desktop tree child by child (same tag
//    sequence → by index; otherwise a longest common subsequence on tag + text). Elements that only
//    exist in one view are inserted where they belong and are hidden in the other views.
// 2. Variant merge: builders such as Framer render the same section two or three times (a Desktop,
//    a Tablet and a Phone copy) and hide all but one per breakpoint. Sibling copies with the same
//    content and disjoint visibility are merged into one element that is restyled per view.
// 3. Cleanup: empty wrappers (no style, one child, same box) are removed; ARIA landmark divs become
//    the matching HTML element.
// Every known view: the trees follow the views the captures have (views.js).
import { KNOWN_VIEW_IDS as VIEW_IDS } from '../views.js';
import { expandHoverCards, expandNotices, expandStates } from './states.js';

export { VIEW_IDS };

export const isText = (n) => n && 'text' in n;
export const isElement = (n) => n && !('text' in n);

/** A captured view node (capture/<slug>/<view>.json) as a merged node with a single view. */
export function fromCapture(node, view) {
  if (isText(node)) return { text: node.text };
  const m = {
    tag: node.tag,
    attrs: node.attrs ?? {},
    views: {
      [view]: {
        style: node.style ?? {},
        rect: node.rect ?? [0, 0, 0, 0],
        hidden: !!node.hidden,
        ...(node.vp && { vp: node.vp }),
        ...(node.ty && { ty: node.ty }),
        ...(node.scrolled && { scrolled: node.scrolled }),
        ...(node.before && { before: node.before }),
        ...(node.after && { after: node.after }),
      },
    },
    children: (node.children ?? []).map((c) => fromCapture(c, view)),
  };
  for (const key of ['lazy', 'src', 'href', 'poster', 'natural', 'svg']) if (node[key] != null) m[key] = node[key];
  // The desktop path of the snapshot (body>div:1>a:2): the motion capture (4b) names its elements by it.
  if (view === 'desktop' && node.path) m.cpath = node.path;
  // The phone snapshot path: controls only the phone layout has (a menu button) are named by it (mobile-clicks.json).
  if (view === 'mobile' && node.path) m.mpath = node.path;
  // The other states of a tab panel / carousel (capture/states.js); ir/states.js puts them into the tree.
  if (node.states) m.states = { ...node.states, variants: node.states.variants.map((v) => ({ index: v.index, node: fromCapture(v.body, view), ...(v.effects && { effects: v.effects }) })) };
  if (node.hoverState?.body) m.hoverState = { node: fromCapture(node.hoverState.body, view) };
  // Short messages a click shows (capture/notices.js), on the body; ir/states.js expandNotices puts them into the tree.
  if (node.notices) m.notices = node.notices.map((n) => ({ ...n, items: n.items.map((it) => ({ control: it.control, node: fromCapture(it.body, view) })) }));
  return m;
}

let textCache = new WeakMap();
/** Forgets cached texts, after a fixer changed the text of a tree. */
export function resetTextCache() {
  textCache = new WeakMap();
}
/** All text inside a node, whitespace collapsed. */
export function deepText(node) {
  if (isText(node)) return node.text;
  if (textCache.has(node)) return textCache.get(node);
  const text = node.children.map(deepText).join(' ').replace(/\s+/g, ' ').trim();
  textCache.set(node, text);
  return text;
}

const imageName = (url) => {
  try {
    return new URL(url).pathname.split('/').pop();
  } catch {
    return '';
  }
};

// Matching key: tag plus the first words of the text (or the image file name).
const matchKey = (n) => `${n.tag}|${deepText(n).slice(0, 80).toLowerCase() || (n.tag === 'img' ? imageName(n.src ?? n.attrs.src ?? '') : '')}`;

function lcs(a, b, key) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [];
  if (n * m > 250000) {
    // Very long child lists: greedy in-order matching keeps this linear.
    const pairs = [];
    let j = 0;
    for (let i = 0; i < n && j < m; i++) {
      const k = key(a[i]);
      const hit = b.slice(j, j + 50).findIndex((x) => key(x) === k);
      if (hit >= 0) {
        pairs.push([i, j + hit]);
        j += hit + 1;
      }
    }
    return pairs;
  }
  const ka = a.map(key);
  const kb = b.map(key);
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ka[i] === kb[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Pairs of matching element children, in order. Exported for tests. */
export function matchChildren(a, b) {
  if (a.length === b.length && a.every((x, i) => x.tag === b[i].tag)) {
    // Same tags, same content, another order (a builder's phone variant puts a list item's text before its bullet):
    // pairing by position would give the bullet the text's styles in that view; matched by content below instead.
    const ka = a.map(matchKey);
    const kb = b.map(matchKey);
    const reordered = ka.some((k, i) => k !== kb[i]) && [...ka].sort().join('\n') === [...kb].sort().join('\n');
    if (!reordered) return a.map((x, i) => [x, b[i]]);
  }
  // Strong anchors first (tag + text), then the gaps between anchors by tag alone.
  const anchors = lcs(a, b, matchKey);
  const pairs = [];
  let pa = 0;
  let pb = 0;
  for (const [i, j] of [...anchors, [a.length, b.length]]) {
    for (const [x, y] of lcs(a.slice(pa, i), b.slice(pb, j), (n) => n.tag)) pairs.push([a[pa + x], b[pb + y]]);
    if (i < a.length) pairs.push([a[i], b[j]]);
    pa = i + 1;
    pb = j + 1;
  }
  return pairs;
}

/** Removes the given views from a subtree (before another copy's data is aligned in). */
function clearViews(node, views) {
  if (!isElement(node)) return;
  for (const v of views) delete node.views[v];
  node.children.forEach((c) => clearViews(c, views));
}

/**
 * Aligns merged node `b` into `a` for the given views: `a` takes b's data for those views, children
 * are matched, and children only b has are inserted at their position. Mutates `a`.
 */
export function alignInto(a, b, views) {
  for (const v of views) if (b.views[v]) a.views[v] = b.views[v];
  for (const key of ['src', 'href', 'poster', 'natural', 'svg', 'lazy', 'cpath', 'mpath']) if (a[key] == null && b[key] != null) a[key] = b[key];
  const ae = a.children.filter(isElement);
  const be = b.children.filter(isElement);
  const partner = new Map();
  for (const [x, y] of matchChildren(ae, be)) {
    alignInto(x, y, views);
    partner.set(y, x);
  }
  if (!ae.length && be.length && a.children.some(isText)) {
    // a has only text here while b has elements: keep the base view's content as it is.
    return;
  }
  let after = null;
  for (const child of b.children) {
    if (!isElement(child)) continue;
    if (partner.has(child)) {
      after = partner.get(child);
      continue;
    }
    const index = after ? a.children.indexOf(after) + 1 : a.children.findIndex(isElement);
    a.children.splice(index < 0 ? a.children.length : index, 0, child);
    after = child;
  }
}

const shown = (node, v) => {
  const d = node.views[v];
  return !!d && !d.hidden && d.style.display !== 'none' && d.rect[2] * d.rect[3] > 0;
};
export const visibleViews = (node, views = VIEW_IDS) => views.filter((v) => shown(node, v));

const tokens = (s) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
function tagBag(node, bag = new Map()) {
  for (const c of node.children) {
    if (!isElement(c)) continue;
    bag.set(c.tag, (bag.get(c.tag) ?? 0) + 1);
    tagBag(c, bag);
  }
  return bag;
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function bagSimilarity(a, b) {
  let inter = 0;
  let union = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    inter += Math.min(a.get(k) ?? 0, b.get(k) ?? 0);
    union += Math.max(a.get(k) ?? 0, b.get(k) ?? 0);
  }
  return union ? inter / union : 1;
}

/** Two sibling copies of one section: same tag, similar text (or, without text, similar structure). */
export function sameContent(a, b) {
  if (a.tag !== b.tag) return false;
  const ta = tokens(deepText(a));
  const tb = tokens(deepText(b));
  if (ta.size || tb.size) return jaccard(ta, tb) >= 0.6;
  return bagSimilarity(tagBag(a), tagBag(b)) >= 0.7;
}

/**
 * Merges duplicate responsive variants among siblings, recursively.
 * @returns {number} merges done
 */
export function mergeVariants(node, views = VIEW_IDS) {
  let merged = 0;
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) {
    const a = kids[i];
    if (!isElement(a)) continue;
    let va = visibleViews(a, views);
    if (!va.length || va.length === views.length) continue;
    for (let j = i + 1; j < kids.length; j++) {
      const b = kids[j];
      if (!isElement(b)) continue;
      const vb = visibleViews(b, views);
      if (!vb.length || vb.some((v) => va.includes(v)) || !sameContent(a, b)) continue;
      clearViews(a, vb);
      alignInto(a, b, vb);
      kids.splice(j, 1);
      j--;
      merged++;
      va = visibleViews(a, views);
      if (va.length === views.length) break;
    }
  }
  for (const c of kids) if (isElement(c)) merged += mergeVariants(c, views);
  return merged;
}

/**
 * One captured view only (a capture made while only desktop was on, views.js): a site builder's copies of a section for other screen sizes
 * (Framer / Webflow Desktop / Tablet / Phone variants) are in the page but hidden. Without the other views they can't be
 * merged, and kept they would put hidden duplicate content (three main headings) into the copy. A hidden element is
 * dropped only when a visible sibling has the same content (`sameContent`), so a menu or dialog that is merely hidden
 * (no visible twin) stays.
 * @returns {number} copies dropped
 */
export function dropHiddenVariants(node, view) {
  let dropped = 0;
  const kids = node.children;
  const visible = kids.filter((c) => isElement(c) && shown(c, view));
  for (let i = kids.length - 1; i >= 0; i--) {
    const c = kids[i];
    if (!isElement(c) || shown(c, view)) continue;
    if (visible.some((v) => sameContent(v, c))) {
      kids.splice(i, 1);
      dropped++;
    }
  }
  for (const c of kids) if (isElement(c)) dropped += dropHiddenVariants(c, view);
  return dropped;
}

const LANDMARKS = { navigation: 'nav', banner: 'header', contentinfo: 'footer', main: 'main', complementary: 'aside' };
const sameRect = (a, b) => a && b && a.every((x, i) => Math.abs(x - b[i]) <= 1);
const BLOCKISH = new Set(['block', 'flow-root', 'list-item']);

/**
 * Removes empty wrappers and upgrades ARIA landmark divs. A wrapper goes when it has no style, no
 * attributes that matter, exactly one element child with the same box in every view, no text, and
 * sits in normal block flow (so removing it cannot change layout or inheritance).
 * @returns {number} wrappers removed
 */
export function cleanTree(node, views = VIEW_IDS, parentDisplay = 'block') {
  let removed = 0;
  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i];
    if (!isElement(c)) continue;
    if (c.tag === 'div' && LANDMARKS[c.attrs.role]) {
      c.tag = LANDMARKS[c.attrs.role];
      delete c.attrs.role;
    }
    const inner = c.children.filter(isElement);
    const plain =
      (c.tag === 'div' || c.tag === 'span') &&
      BLOCKISH.has(parentDisplay) &&
      inner.length === 1 &&
      !c.children.some((t) => isText(t) && t.text.trim()) &&
      !Object.keys(c.attrs).some((k) => k !== 'class') &&
      !c.stateAttrs && // an area or control of a tab panel / carousel (ir/states.js)
      views.every((v) => {
        const d = c.views[v];
        const cd = inner[0].views[v];
        if (!d) return !cd;
        // box-sizing alone (from a global reset) has no effect on a box without padding, border or size.
        return cd && !Object.keys(d.style).some((k) => k !== 'box-sizing') && !d.before && !d.after && sameRect(d.rect, cd.rect);
      });
    if (plain) {
      // What the motion capture said about the wrapper now applies to the element that took its place.
      if (c.cpath) inner[0].cpathAlt = [...(inner[0].cpathAlt ?? []), c.cpath];
      if (c.mpath) inner[0].mpathAlt = [...(inner[0].mpathAlt ?? []), c.mpath];
      node.children.splice(i, 1, inner[0]);
      removed++;
      i--;
      continue;
    }
    const display = c.views.desktop?.style.display ?? (BLOCK_TAGS.has(c.tag) ? 'block' : 'inline');
    removed += cleanTree(c, views, display);
  }
  return removed;
}

export const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'html', 'legend', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'summary', 'ul',
]);

/** The display a node has in a view: its captured value or the tag's browser default. */
export function displayOf(node, v) {
  const d = node.views[v];
  if (d?.style.display) return d.style.display;
  if (BLOCK_TAGS.has(node.tag)) return 'block';
  if (node.tag === 'li') return 'list-item';
  if (node.tag === 'table') return 'table';
  if (node.tag === 'td' || node.tag === 'th') return 'table-cell';
  if (node.tag === 'tr') return 'table-row';
  return 'inline';
}

/**
 * Builds the merged tree of one page.
 * @param {Record<string, object>} bodies  captured body per view (a missing view is simply left out)
 * @returns {{ root: object, views: string[], stats: { variantsMerged: number, wrappersRemoved: number, viewOnly: number } }}
 */
export function buildPageTree(bodies) {
  const views = VIEW_IDS.filter((v) => bodies[v]);
  if (!bodies.desktop) throw new Error('The desktop capture is required.');
  const root = fromCapture(bodies.desktop, 'desktop');
  for (const v of views.slice(1)) alignInto(root, fromCapture(bodies[v], v), [v]);
  // Tab / carousel / filter states as hidden copies of their area, while the capture's relative paths still hold.
  const states = expandStates(root);
  const notices = expandNotices(root);
  const hoverCards = expandHoverCards(root);
  const variantsMerged = views.length > 1 ? mergeVariants(root, views) : dropHiddenVariants(root, views[0]);
  const wrappersRemoved = cleanTree(root, views);
  let viewOnly = 0;
  const count = (n) => {
    if (!isElement(n)) return;
    if (views.some((v) => !n.views[v])) viewOnly++;
    n.children.forEach(count);
  };
  count(root);
  return { root, views, stats: { variantsMerged, wrappersRemoved, viewOnly, stateSets: states.sets, states: states.states, notices, hoverCards } };
}
