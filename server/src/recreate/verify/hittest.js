// @ts-check
// Cursors and hit-testing (CLONER_SPEC Phase 1 item 18, Phase 3 "hit-test guard", Phase 4 checks 5b / 5c).
//
// What a visitor's click lands on is not what the markup says: a layer drawn over a button (a frozen animation layer, an
// overlay a script used to take away, a wrapper stretched on top) takes the click, and the button looks fine but does
// nothing. So for every interactive element the capture records which element `elementFromPoint` returns at its centre and
// the cursor it shows (`pointerMap.json`), and the copy is held to it:
//   - an element whose click reached it (or a part of it) in the original but reaches another element in the copy is
//     blocked; when the blocking element holds nothing clickable itself (a layer, an empty overlay), the copy lets clicks
//     through it (`data-sas-pass` → pointer-events: none) and says so; a blocker that is itself clickable, or holds
//     controls, is reported, never changed (making it click-through would break those);
//   - a cursor that differs from the original's is reported (5b).
// Elements the original also blocked are left as they are: that is how the site works.
import { nodeBySid, openCopyRenderer, withMotion } from './copyRender.js';

/** Elements a visitor can act on, as the capture and the copy both find them. */
const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, label[for], [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], [tabindex]:not([tabindex="-1"]), [onclick]';
/** Elements checked per page and view. */
export const MAX_HIT_ELEMENTS = 400;
export const pointerMapFile = (viewId) => (viewId === 'desktop' ? 'pointerMap.json' : `${viewId}-pointerMap.json`);

/**
 * Page function: per interactive element, its cursor and what receives a click at its centre (brought into view first,
 * without smooth scrolling). The page is scrolled back to where it was. Self-contained.
 * @param {{ max?: number, selector?: string }} o
 */
export function readPointerMap({ max = 400, selector }) {
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  // The snapshot's path (capture/snapshot.js): body>div:1>a:2, the index counts same-tag element siblings.
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
  const shown = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  const sidOf = (el) => el?.closest?.('[data-sas-id]')?.getAttribute('data-sas-id') ?? null;
  const y0 = window.scrollY;
  const html = document.documentElement;
  const smooth = html.style.scrollBehavior;
  html.style.scrollBehavior = 'auto';
  const out = [];
  const candidates = [...document.querySelectorAll(selector)].filter((el) => !el.closest('template'));
  for (const el of candidates) {
    if (out.length >= max) break;
    const r0 = el.getBoundingClientRect();
    if (r0.width < 2 || r0.height < 2 || !shown(el)) continue;
    window.scrollTo(0, Math.max(0, r0.top + window.scrollY + r0.height / 2 - window.innerHeight / 2));
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const entry = { path: pathOf(el), sid: el.getAttribute('data-sas-id'), tag: el.tagName.toLowerCase(), cursor: getComputedStyle(el).cursor };
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      out.push({ ...entry, hit: 'offscreen' });
      continue;
    }
    const hit = document.elementFromPoint(x, y);
    const kind = !hit ? 'none' : hit === el || el.contains(hit) ? 'self' : hit.contains(el) ? 'ancestor' : 'other';
    out.push({
      ...entry,
      hit: kind,
      ...(kind !== 'self' && hit && { hitPath: pathOf(hit), hitTag: hit.tagName.toLowerCase(), hitSid: sidOf(hit) }),
    });
  }
  window.scrollTo(0, y0);
  html.style.scrollBehavior = smooth;
  return out;
}

/** Reads the map of the page in front (capture side). */
export const capturePointerMap = (page) => page.evaluate(readPointerMap, { max: MAX_HIT_ELEMENTS, selector: INTERACTIVE });

/**
 * Compares the copy's map with the original's, element by element (by capture path).
 * @param {object[]} original  the capture's map
 * @param {object[]} copy      the copy's map, each entry with `cpath` (its element's capture path) and `hitCpath`
 * @returns {{ checked: number, blocked: object[], cursors: object[] }}
 */
export function compareHits(original, copy) {
  const byPath = new Map((copy ?? []).filter((c) => c.cpath).map((c) => [c.cpath, c]));
  const blocked = [];
  const cursors = [];
  let checked = 0;
  for (const o of original ?? []) {
    const c = o.path ? byPath.get(o.path) : null;
    if (!c) continue;
    checked++;
    // Reached itself in the original, something else in the copy: a click that no longer arrives.
    if (o.hit === 'self' && (c.hit === 'other' || c.hit === 'ancestor')) blocked.push({ path: o.path, tag: o.tag, sid: c.sid, by: { sid: c.hitSid, tag: c.hitTag, path: c.hitCpath ?? null } });
    if (o.cursor && c.cursor && o.cursor !== c.cursor) cursors.push({ path: o.path, tag: o.tag, original: o.cursor, copy: c.cursor });
  }
  return { checked, blocked, cursors };
}

const CLICKABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label']);
const clickable = (n) => CLICKABLE_TAGS.has(n.t) || ['button', 'link', 'tab', 'menuitem', 'checkbox', 'switch', 'option'].includes(n.attrs?.role) || (n.attrs?.tabindex != null && n.attrs.tabindex !== '-1');
/** Does the IR node hold anything a visitor can act on (itself or inside)? Raw markup (inline SVG) counts by its tags. */
function holdsControls(n) {
  if (!n || 'text' in n) return false;
  if (clickable(n)) return true;
  if (n.raw && /<(a|button|input|select|textarea)\b/i.test(n.raw)) return true;
  return (n.children ?? []).some(holdsControls);
}

/**
 * The guard: renders every page of the copy as a visitor gets it (its scripts running) at the desktop and phone views,
 * compares the click targets with the capture's, lets clicks through layers that hold nothing clickable, and checks again.
 * Changes the IR in place (`data-sas-pass` on the layer, `ir.motion.pass`).
 * @param {{ ir: any, siteDir: string, maps: Map<string, Record<string, object[]>>, cpaths: Record<string, { cpaths: Record<string, string> }>,
 *   views: { id: string, width: number, height: number, dpr: number, mobile: boolean }[], launchBrowser: () => Promise<any>, deadline?: number,
 *   renderer?: import('./copyRender.js').CopyRenderer }} o
 *   maps: page outPath → view id → the capture's pointer map; cpaths: page outPath → sid → capture path (generate.js cpathsOf);
 *   renderer: a renderer shared with the other guards of the run (verify/copyRender.js), else one of its own
 */
export async function hitTestGuard({ ir, siteDir, maps, cpaths, views, launchBrowser, deadline = Infinity, renderer = undefined }) {
  const report = { pages: 0, checked: 0, blocked: 0, fixed: [], unresolved: [], cursors: [], afterFix: 0 };
  const pages = ir.pages.filter((p) => maps.get(p.outPath));
  if (!pages.length) return report;
  const own = renderer ? null : await openCopyRenderer({ siteDir, launchBrowser });
  const render = /** @type {import('./copyRender.js').CopyRenderer} */ (renderer ?? own);
  const measure = () => render.each({
    ir, pages, views, deadline,
    want: (page, view) => (maps.get(page.outPath)?.[view.id]?.length ? maps.get(page.outPath)[view.id] : null),
    visit: async (tab, page, view, original) => {
      const sidPath = cpaths[page.outPath]?.cpaths ?? {};
      const copy = (await tab.evaluate(readPointerMap, { max: MAX_HIT_ELEMENTS * 2, selector: INTERACTIVE }))
        .map((c) => ({ ...c, cpath: c.sid ? sidPath[c.sid] ?? null : null, hitCpath: c.hitSid ? sidPath[c.hitSid] ?? null : null }));
      return compareHits(original, copy);
    },
  });
  try {
    const first = await measure();
    const passed = new Set();
    for (const r of first) {
      if (r.error) continue;
      report.pages++;
      report.checked += r.checked;
      report.blocked += r.blocked.length;
      report.cursors.push(...r.cursors.slice(0, 20).map((c) => ({ page: r.page.path, view: r.view, ...c })));
      for (const b of r.blocked) {
        const layer = b.by.sid ? nodeBySid(r.page.body, b.by.sid) : null;
        const where = { page: r.page.path, view: r.view, element: b.path, tag: b.tag, by: b.by.tag ?? null };
        if (!layer) report.unresolved.push({ ...where, reason: 'blocker not in the copy\'s own markup' });
        else if (holdsControls(layer)) report.unresolved.push({ ...where, reason: 'the covering element is itself clickable or holds controls' });
        else {
          const key = `${r.page.outPath}|${b.by.sid}`;
          if (!passed.has(key)) {
            passed.add(key);
            layer.attrs = { ...(layer.attrs ?? {}), 'data-sas-pass': '' };
            report.fixed.push({ ...where, layer: b.by.path ?? null });
          }
        }
      }
    }
    if (report.fixed.length) {
      // A copy with no motion at all has no ir.motion: the empty shape the emitters read, with the one rule.
      withMotion(ir, { pass: true });
      // Checked again with the fix in: what is still blocked is reported as such.
      const again = await measure();
      report.afterFix = again.reduce((n, r) => n + (r.blocked?.length ?? 0), 0);
    }
  } finally {
    await own?.close();
  }
  return report;
}
