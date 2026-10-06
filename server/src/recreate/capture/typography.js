// Window-width probe for typography (step 3 of the "as is" fixes). Many sites size text with the window (font-size:
// clamp(40px, 5vw, 76px)); the capture reads px at one width, so on a narrower or wider screen the copy's text was too big or
// too small. The page is read again at a few other widths (same height), and for every element with text the font size,
// line height and letter spacing at each width are kept when they changed; ir/typography.js turns them into the matching
// fluid value. Nothing is identified by class name; the window is put back afterwards.
//
// Output: `node.ty = { widths: [..], 'font-size': [px..], 'line-height': [px|null..], 'letter-spacing': [px|null..] }` on the
// snapshot nodes whose values changed, in capture/<slug>/<view>.json (the captured width is one of `widths`).

export const PROBE_WIDTHS = [1920, 1600, 1280, 1100];

/** Page function: font size, line height and letter spacing (px, null when not px) of every element with own text. */
export function readType({ maxNodes }) {
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const px = (v) => (/^-?[\d.]+px$/.test(v) ? Math.round(parseFloat(v) * 1000) / 1000 : null);
  const out = {};
  let count = 0;
  const walk = (el, path) => {
    if (count++ >= maxNodes) return;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText) {
      const cs = getComputedStyle(el);
      out[path] = [px(cs.fontSize), px(cs.lineHeight), cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing)];
    }
    if (el.tagName === 'svg' || el.tagName.toLowerCase() === 'svg') return;
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

/**
 * The elements whose typography changed with the width: path → { widths, font-size, line-height, letter-spacing }.
 * @param {Record<string, object>} reads  width → readType() result (the captured width included)
 */
export function typeChanges(reads) {
  const widths = Object.keys(reads).map(Number).sort((a, b) => b - a);
  const base = reads[widths[0]];
  const changed = new Map();
  for (const path of Object.keys(base)) {
    const rows = widths.map((w) => reads[w][path]);
    if (rows.some((r) => !r)) continue;
    const series = (k) => rows.map((r) => r[k]);
    const moves = (k) => {
      const s = series(k);
      return s.every((v) => v != null) && Math.max(...s) - Math.min(...s) > 0.25;
    };
    if (!moves(0) && !moves(1) && !moves(2)) continue;
    changed.set(path, { widths, 'font-size': series(0), 'line-height': series(1), 'letter-spacing': series(2) });
  }
  return changed;
}

/** Writes the ty entries onto the snapshot tree (by path). Returns how many nodes got one. */
export function attachType(body, changed) {
  let n = 0;
  const walk = (node) => {
    if (!node || 'text' in node) return;
    const ty = changed.get(node.path);
    if (ty) {
      node.ty = ty;
      n++;
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(body);
  return n;
}

/**
 * Reads the typography at the captured width and at PROBE_WIDTHS (same height), then puts the window back.
 * @param {import('playwright').Page} page
 * @param {{ width: number, height: number }} view
 */
export async function probeTypography(page, view, { widths = PROBE_WIDTHS, maxNodes = 6000 } = {}) {
  const started = Date.now();
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))));
  const reads = { [view.width]: await page.evaluate(readType, { maxNodes }) };
  try {
    for (const w of widths.filter((x) => x !== view.width)) {
      await page.setViewportSize({ width: w, height: view.height });
      await settle();
      reads[w] = await page.evaluate(readType, { maxNodes });
    }
  } finally {
    await page.setViewportSize({ width: view.width, height: view.height }).catch(() => {});
    await settle().catch(() => {});
  }
  return { changed: typeChanges(reads), ms: Date.now() - started };
}
