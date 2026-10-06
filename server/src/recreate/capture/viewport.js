// Window-height probe: which boxes follow the height of the browser window. A capture reads every size in px at one
// window size, so a full-screen hero (min-height: 100vh / 100dvh) or a box centred with top: 50% came out as 900 px /
// 450 px: right on a 900 px tall screen only. The page is read once more with a taller window (same width, so nothing
// reflows sideways); a box whose height or offset changed with it follows the window, and by how much says how
// (ir/styles.js viewportStyle turns it into dvh / %). Nothing is identified by class name or framework.
//
// Output: `node.vp = { vh: [h1, h2], h: [a, b], top: [a, b], bottom: [a, b], mh: [a, b] }` on the snapshot nodes whose box
// changed, written into capture/<slug>/<view>.json.

/** Page function: box, insets and min-height of every element, keyed by snapshot path (capture/snapshot.js). */
export function readBoxes({ maxNodes }) {
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const out = {};
  let count = 0;
  const walk = (el, path) => {
    if (count++ >= maxNodes) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // The layout size, which a transform does not change: a spinning or scaled box measures differently from frame to frame,
    // which would look like a size that follows the window (SVG elements have no offset size: their box then).
    const w = el instanceof HTMLElement ? el.offsetWidth : r.width;
    const h = el instanceof HTMLElement ? el.offsetHeight : r.height;
    out[path] = [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(w * 100) / 100, Math.round(h * 100) / 100,
      cs.position, cs.top, cs.bottom, cs.minHeight];
    if (el.tagName === 'svg' || el.tagName === 'CANVAS') return;
    const tagIndex = {};
    const root = el.shadowRoot && el.shadowRoot.mode === 'open' ? el.shadowRoot : el;
    for (const child of root.children) {
      if (SKIP_TAGS.has(child.tagName)) continue;
      const t = child.tagName.toLowerCase();
      tagIndex[t] = (tagIndex[t] || 0) + 1;
      walk(child, `${path}>${t}:${tagIndex[t]}`);
    }
  };
  if (document.body) walk(document.body, 'body');
  return out;
}

const pxOf = (v) => (typeof v === 'string' && /px$/.test(v) ? parseFloat(v) : null);

/**
 * The boxes that changed between the two reads: height, min-height, or a top / bottom inset of a positioned box.
 * Boxes that only moved down with the content above them are left out.
 * @returns {Map<string, object>} path → vp entry
 */
export function compareBoxes(before, after, [h1, h2]) {
  const changed = new Map();
  for (const [path, a] of Object.entries(before)) {
    const b = after[path];
    if (!b) continue;
    const heightChanged = Math.abs(a[3] - b[3]) > 1.5;
    const mh = [pxOf(a[7]), pxOf(b[7])];
    const mhChanged = mh[0] != null && mh[1] != null && Math.abs(mh[0] - mh[1]) > 1.5;
    const positioned = /^(absolute|fixed)$/.test(a[4]);
    const top = [pxOf(a[5]), pxOf(b[5])];
    const bottom = [pxOf(a[6]), pxOf(b[6])];
    const insetChanged = positioned && [top, bottom].some(([x, y]) => x != null && y != null && Math.abs(x - y) > 1.5);
    if (!heightChanged && !mhChanged && !insetChanged) continue;
    // Both heights from these two reads (the snapshot measures rotated boxes differently, capture/snapshot.js rectOf).
    changed.set(path, {
      vh: [h1, h2],
      h: [a[3], b[3]],
      ...(positioned && { top, bottom }),
      ...(mhChanged && { mh }),
    });
  }
  return changed;
}

/** Writes the vp entries onto the snapshot tree (by path). Returns how many nodes got one. */
export function attachProbe(body, changed) {
  let n = 0;
  const walk = (node) => {
    if (!node || 'text' in node) return;
    const vp = changed.get(node.path);
    if (vp) {
      node.vp = vp;
      n++;
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(body);
  return n;
}

/**
 * Reads the page at its window height and at a taller one (same width), then puts the window back.
 * @param {import('playwright').Page} page
 * @param {{ width: number, height: number }} view
 * @returns {Promise<{ changed: Map<string, object>, ms: number }>}
 */
export async function probeViewportHeight(page, view, { maxNodes = 6000 } = {}) {
  const started = Date.now();
  const h1 = view.height;
  const h2 = Math.round(h1 * 1.3);
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
  const before = await page.evaluate(readBoxes, { maxNodes });
  await page.setViewportSize({ width: view.width, height: h2 });
  try {
    await settle();
    const after = await page.evaluate(readBoxes, { maxNodes });
    return { changed: compareBoxes(before, after, [h1, h2]), ms: Date.now() - started };
  } finally {
    await page.setViewportSize({ width: view.width, height: h1 }).catch(() => {});
    await settle().catch(() => {});
  }
}
