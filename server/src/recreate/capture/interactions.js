// Hover and focus capture (Phase 4b.1). After the screenshots and the DOM snapshot of the desktop view, the page is
// probed the way a visitor would use it - nothing is clicked, nothing is typed:
//   1. rules   - the :hover / :focus / :focus-visible / :focus-within / :active rules of every readable stylesheet,
//                as authored (evidence; the class names do not survive into the recreate);
//   2. hover   - for the interactive elements (links, buttons, fields, tabs, cursor: pointer, then plain transition
//                hosts) the mouse moves onto the element and the computed styles of the element, its pseudo-elements
//                (::before / ::after) and its descendants (3 levels) are compared with their state just before the
//                hover. This is the JavaScript-driven path too: whatever a script does on mouseenter shows in the
//                computed styles, with or without a :hover rule;
//   3. focus   - the Tab key walks through the focusable elements; at each stop the focused state is compared with
//                the same element blurred (a browser's own default focus ring is noted, not recorded).
// The rest state is always read at the same scroll position, after the page had time to settle: scrolling an
// element into view runs scroll-reveal effects, which are not hover effects.
// Elements are identified by the `path` of the DOM snapshot (capture/snapshot.js: body>div:1>a:2), so a later step
// can find the node in the IR. Equal elements (the same tag, role, classes and parent) are probed a few times
// only (`perSignature`), the rest of the group is counted. Output: capture/<slug>/motion.json.
//
// Page functions below are self-contained (Playwright sends only their source).

// Properties compared between rest and hover / focus: what a hover effect usually changes.
export const MOTION_PROPS = [
  'color', 'background-color', 'background-image', 'background-position', 'background-size', 'border-top-color',
  'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-width', 'border-right-width',
  'border-bottom-width', 'border-left-width', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius', 'outline-color', 'outline-style', 'outline-width',
  'outline-offset', 'box-shadow', 'text-shadow', 'opacity', 'transform', 'translate', 'scale', 'rotate', 'filter',
  'backdrop-filter', 'clip-path', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
  'text-decoration-thickness', 'font-weight', 'letter-spacing', 'fill', 'stroke', 'visibility', 'display', 'cursor',
];
// Pseudo-elements also change their size and position (an underline that grows).
const PSEUDO_EXTRA = ['width', 'height', 'left', 'right', 'top', 'bottom'];

/** Page function: the :hover / :focus / :active rules of the readable stylesheets. */
function scanRules(opts) {
  const { max = 600 } = opts || {};
  const STATE = /:(hover|focus-visible|focus-within|focus|active)\b/;
  const rules = [];
  let total = 0;
  const unreadable = [];
  const read = (list, media, href) => {
    for (const rule of list) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const m = STATE.exec(rule.selectorText || '');
        if (!m) continue;
        total++;
        if (rules.length >= max) continue;
        const decls = {};
        for (let i = 0; i < rule.style.length && i < 40; i++) decls[rule.style[i]] = rule.style.getPropertyValue(rule.style[i]);
        rules.push({ selector: rule.selectorText.slice(0, 300), state: m[1], ...(media && { media }), ...(href && { href }), decls });
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        read(rule.cssRules, rule.conditionText || rule.media.mediaText, href);
      } else if (rule.cssRules) {
        read(rule.cssRules, media, href);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      read(sheet.cssRules, null, sheet.href);
    } catch {
      unreadable.push(sheet.href);
    }
  }
  return { rules, total, unreadable };
}

/**
 * Page function: picks the elements to probe and remembers them (window.__sasMotion). Links, buttons, fields and
 * roles come first, then cursor: pointer elements, then plain transition hosts; each group of equal elements is
 * probed `perSignature` times; the chosen ones are kept in document order.
 * @returns {{ candidates: object[], groups: object[], skipped: object, focusable: number }}
 */
function install(opts) {
  const { limit, perSignature } = opts;
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'LABEL']);
  const ROLES = /^(button|link|tab|menuitem|option|switch|checkbox|radio|combobox)$/;
  const MAX_NODES = 6000; // the snapshot stops there

  // The path of the snapshot (body>div:1>a:2): the index counts same-tag element siblings without the skipped tags.
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) {
        parts.push('body');
        break;
      }
      const tag = n.tagName.toLowerCase();
      let index = 0;
      for (const s of n.parentElement ? n.parentElement.children : []) {
        if (SKIP_TAGS.has(s.tagName)) continue;
        if (s.tagName === n.tagName) index++;
        if (s === n) break;
      }
      parts.push(`${tag}:${index}`);
    }
    return parts.length && parts[parts.length - 1] === 'body' ? parts.reverse().join('>') : null;
  };
  const sigOf = (el) => {
    const p = el.parentElement;
    const cls = (e) => [...(e?.classList || [])].sort().join('.');
    return `${el.tagName.toLowerCase()}|${el.getAttribute('role') || ''}|${cls(el)}|${p ? `${p.tagName.toLowerCase()}.${cls(p)}` : ''}`;
  };
  const docRect = (el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
  };

  const found = [];
  const bySig = new Map();
  const skipped = { limit: 0, duplicate: 0, hidden: 0 };
  let focusable = 0;
  let seen = 0;
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of all) {
    if (++seen > MAX_NODES) break;
    if (SKIP_TAGS.has(el.tagName) || (el.closest('svg') && el.tagName.toLowerCase() !== 'svg')) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 4 || r.height < 4 || parseFloat(cs.opacity) < 0.02) {
      if (INTERACTIVE.has(el.tagName)) skipped.hidden++;
      continue;
    }
    const reasons = [];
    const tabindex = el.getAttribute('tabindex');
    const isFocusable = (el.tagName === 'A' && el.hasAttribute('href')) || (INTERACTIVE.has(el.tagName) && el.tagName !== 'LABEL' && !el.disabled
      && !(el.tagName === 'INPUT' && el.type === 'hidden')) || (tabindex != null && tabindex !== '-1') || el.tagName === 'SUMMARY';
    if (isFocusable) {
      reasons.push('focusable');
      focusable++;
    }
    if (INTERACTIVE.has(el.tagName) && el.tagName !== 'LABEL') reasons.push('interactive');
    if (ROLES.test(el.getAttribute('role') || '')) reasons.push('role');
    const parentCursor = el.parentElement ? getComputedStyle(el.parentElement).cursor : '';
    if (cs.cursor === 'pointer' && parentCursor !== 'pointer') reasons.push('pointer');
    const dur = parseFloat((cs.transitionDuration || '0s').split(',')[0]);
    if (dur > 0 && cs.transitionProperty !== 'none') reasons.push('transition');
    if (!reasons.length) continue;
    const path = pathOf(el);
    if (!path) continue;
    const sig = sigOf(el);
    const group = bySig.get(sig) || { sig, count: 0, probed: 0 };
    bySig.set(sig, group);
    group.count++;
    const priority = reasons.includes('focusable') || reasons.includes('interactive') || reasons.includes('role') ? 0 : reasons.includes('pointer') ? 1 : 2;
    found.push({
      order: found.length, priority, el, path, tag: el.tagName.toLowerCase(), sig, reasons, cursor: cs.cursor,
      text: (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60),
    });
  }
  const chosen = [];
  const chosenSet = new Set();
  for (const c of [...found].sort((a, b) => a.priority - b.priority || a.order - b.order)) {
    const group = bySig.get(c.sig);
    if (group.probed >= perSignature) {
      skipped.duplicate++;
      continue;
    }
    // A plain transition host inside a chosen element (3 levels) is covered by that element's descendants.
    if (c.priority === 2) {
      let up = c.el.parentElement;
      let covered = false;
      for (let i = 0; i < 3 && up && !covered; i++, up = up.parentElement) covered = chosenSet.has(up);
      if (covered) continue;
    }
    if (chosen.length >= limit) {
      skipped.limit++;
      continue;
    }
    group.probed++;
    chosen.push(c);
    chosenSet.add(c.el);
  }
  chosen.sort((a, b) => a.order - b.order); // document order: the page is scrolled down once, not up and down
  window.__sasMotion = { chosen: chosen.map((c) => c.el), index: new Map(chosen.map((c, i) => [c.el, i])), pathOf };
  return {
    candidates: chosen.map((c, i) => ({ i, path: c.path, tag: c.tag, sig: c.sig, reasons: c.reasons, cursor: c.cursor, text: c.text, rect: docRect(c.el) })),
    groups: [...bySig.values()].filter((g) => g.count > 1).sort((a, b) => b.count - a.count).slice(0, 20),
    skipped,
    focusable,
  };
}

/**
 * Page function: the style state of one probed element - itself, its ::before / ::after and its descendants
 * (3 levels, at most 24) - for the compared properties.
 */
function readState(opts) {
  const { i, props, pseudoProps } = opts;
  const m = window.__sasMotion;
  const el = m.chosen[i];
  if (!el || !el.isConnected) return null;
  const pick = (cs, list) => {
    const out = {};
    for (const p of list) out[p] = cs.getPropertyValue(p);
    return out;
  };
  const tr = (cs) => ({ property: cs.transitionProperty, duration: cs.transitionDuration, delay: cs.transitionDelay, timing: cs.transitionTimingFunction });
  // The layout box: offset* ignores transforms (a card that lifts on hover is not a layout change).
  const rectOf = (n) => {
    if (n instanceof HTMLElement) return [n.offsetLeft, n.offsetTop, n.offsetWidth, n.offsetHeight];
    const r = n.getBoundingClientRect();
    return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
  };
  const one = (n, withPseudo) => {
    const cs = getComputedStyle(n);
    const state = { values: pick(cs, props), tr: tr(cs), rect: rectOf(n) };
    if (withPseudo) {
      state.pseudo = {};
      for (const which of ['::before', '::after']) {
        const pcs = getComputedStyle(n, which);
        if (pcs.content && pcs.content !== 'none' && pcs.content !== 'normal') state.pseudo[which.slice(2)] = { values: pick(pcs, [...props, ...pseudoProps]), tr: tr(pcs) };
      }
    }
    return state;
  };
  const kids = [];
  const queue = [[el, 0]];
  while (queue.length && kids.length < 24) {
    const [n, depth] = queue.shift();
    for (const c of n.children) {
      if (kids.length >= 24) break;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(c.tagName)) continue;
      const path = m.pathOf(c);
      if (path) kids.push({ path, ...one(c, false) });
      if (depth < 2 && c.tagName.toLowerCase() !== 'svg') queue.push([c, depth + 1]);
    }
  }
  return { ...one(el, true), kids, domCount: document.getElementsByTagName('*').length };
}

/** Page function: moves the element to the middle of the screen and reports where to point the mouse. */
function aim(i) {
  const el = window.__sasMotion.chosen[i];
  if (!el || !el.isConnected) return null;
  // An element already on screen is left where it is: scrolling runs the page's scroll effects, and a probe that
  // does not scroll has nothing to wait for.
  let r = el.getBoundingClientRect();
  const onScreen = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  if (!onScreen) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    r = el.getBoundingClientRect();
  }
  if (r.width < 1 || r.height < 1) return null;
  const x = Math.min(innerWidth - 2, Math.max(1, r.left + r.width / 2));
  const y = Math.min(innerHeight - 2, Math.max(1, r.top + r.height / 2));
  const top = document.elementFromPoint(x, y);
  // Something else (a fixed bar, an overlay) is on top of the element at this point.
  const reachable = !!top && (el === top || el.contains(top) || top.contains(el));
  return { x, y, reachable, scrolled: !onScreen };
}

/** Page function: the element with keyboard focus (as an index into the probed elements, -1 for another, null for none). */
function focused() {
  const a = document.activeElement;
  const m = window.__sasMotion;
  return a && a !== document.body ? (m.index.has(a) ? m.index.get(a) : -1) : null;
}

/** Page function: takes the keyboard focus off an element (the browser keeps its place for the next Tab). */
function blurIndex(i) {
  const el = window.__sasMotion.chosen[i];
  if (el && document.activeElement === el) el.blur();
}

/** Page function: puts the keyboard focus before the first element of the page. */
function resetFocus() {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  window.scrollTo(0, 0);
  // The browser continues Tab from where it last was (the element scrolled to for a hover probe): focusing the
  // body moves that starting point to the top of the page.
  document.body.setAttribute('tabindex', '-1');
  document.body.focus({ preventScroll: true });
  document.body.removeAttribute('tabindex');
}

const DURATION = /^-?[\d.]+m?s$/;
/** Longest transition (duration + delay) of a state in ms. */
function transitionMs(state) {
  let longest = 0;
  const parse = (v) => (v || '0s').split(',').map((s) => s.trim()).filter((s) => DURATION.test(s)).map((s) => (s.endsWith('ms') ? parseFloat(s) : parseFloat(s) * 1000));
  for (const t of [state.tr, ...state.kids.map((k) => k.tr), ...Object.values(state.pseudo ?? {}).map((p) => p.tr)]) {
    const d = parse(t.duration);
    const l = parse(t.delay);
    longest = Math.max(longest, ...d.map((x, i) => x + (l[i % Math.max(1, l.length)] ?? 0)));
  }
  return longest;
}

const changed = (a, b) => {
  const out = {};
  for (const k of Object.keys(b)) if (a[k] !== b[k]) out[k] = [a[k], b[k]];
  return out;
};
const MAX_CHANGES = 30;
const limitChanges = (c) => Object.fromEntries(Object.entries(c).slice(0, MAX_CHANGES));

/**
 * What differs between a rest state and a hover / focus state, or null when nothing does.
 * @returns {null | { changes: object, pseudo?: object, kids?: object[], rect?: number[], layout: boolean, transition: object, domDelta: number, uaRing?: boolean }}
 */
export function diffStates(rest, after) {
  const changes = changed(rest.values, after.values);
  // A browser's own focus ring (outline-style: auto) is not part of the site's design.
  const ringKeys = Object.keys(changes).filter((k) => k.startsWith('outline-'));
  const uaRing = ringKeys.length > 0 && changes['outline-style']?.[1] === 'auto';
  if (uaRing) for (const k of ringKeys) delete changes[k];
  const pseudo = {};
  for (const [which, p] of Object.entries(after.pseudo ?? {})) {
    const before = rest.pseudo?.[which];
    // A pseudo-element that appears on hover has no rest values: everything it sets is a change.
    const c = before ? changed(before.values, p.values) : Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, [null, v]]));
    if (Object.keys(c).length) pseudo[which] = limitChanges(c);
  }
  for (const which of Object.keys(rest.pseudo ?? {})) {
    if (!after.pseudo?.[which]) pseudo[which] = { content: ['present', 'none'] };
  }
  const restKids = new Map(rest.kids.map((k) => [k.path, k]));
  const kids = [];
  for (const k of after.kids) {
    const before = restKids.get(k.path);
    const c = before ? changed(before.values, k.values) : { display: ['none', k.values.display] };
    if (Object.keys(c).length) kids.push({ path: k.path, changes: limitChanges(c), transition: k.tr });
  }
  const dRect = after.rect.map((v, i) => v - rest.rect[i]);
  const rectChanged = dRect.some((v) => Math.abs(v) > 1);
  const domDelta = after.domCount - rest.domCount;
  if (!Object.keys(changes).length && !Object.keys(pseudo).length && !kids.length && !rectChanged && !domDelta) return null;
  const out = { changes: limitChanges(changes), transition: after.tr, layout: rectChanged, domDelta };
  if (Object.keys(pseudo).length) out.pseudo = pseudo;
  if (kids.length) out.kids = kids.slice(0, 24);
  if (rectChanged) out.rect = dRect;
  if (uaRing) out.uaRing = true;
  if (JSON.stringify(rest.tr) !== JSON.stringify(after.tr)) out.transitionOut = rest.tr;
  return out;
}

/**
 * Does the effect found by a hover go away again when the mouse leaves? `back` is the state read after the mouse left,
 * `rest` the state before the hover, `d` the effect (diffStates(rest, hovered)). A real hover effect reverts; a change that
 * a timer, an entrance animation or a loop makes (it also happens without the mouse) does not, so it is not a hover effect.
 * Judged part by part: a looping child inside a hovered card keeps changing, but the card's own hover is real, so only the
 * parts that did not revert are dropped from the effect.
 * @returns {object|null} the effect without the parts that stayed, or null when nothing of it reverted
 */
export function keepReverting(rest, back, d) {
  const gone = diffStates(rest, back);
  if (!gone) return d;
  const out = { ...d, changes: Object.fromEntries(Object.entries(d.changes).filter(([k]) => !(k in gone.changes))) };
  const pseudo = {};
  for (const [which, changes] of Object.entries(d.pseudo ?? {})) {
    const kept = Object.fromEntries(Object.entries(changes).filter(([k]) => !(k in (gone.pseudo?.[which] ?? {}))));
    if (Object.keys(kept).length) pseudo[which] = kept;
  }
  if (Object.keys(pseudo).length) out.pseudo = pseudo;
  else delete out.pseudo;
  const kids = [];
  for (const kid of d.kids ?? []) {
    const left = gone.kids?.find((x) => x.path === kid.path);
    const kept = Object.fromEntries(Object.entries(kid.changes).filter(([k]) => !(k in (left?.changes ?? {}))));
    if (Object.keys(kept).length) kids.push({ ...kid, changes: kept });
  }
  if (kids.length) out.kids = kids;
  else delete out.kids;
  if (d.layout && gone.layout) {
    out.layout = false;
    delete out.rect;
  }
  const nothing = !Object.keys(out.changes).length && !out.pseudo && !out.kids && !out.layout && !out.domDelta;
  return nothing ? null : out;
}

/**
 * Probes a page (desktop view) for hover and focus effects. Hover may use up to 60 % of the budget, focus the rest.
 * @param {import('playwright').Page} page
 * @param {{ limit?: number, perSignature?: number, focusStops?: number, budgetMs?: number }} [o]
 * @returns {Promise<object>} the content of motion.json
 */
export async function captureInteractions(page, { limit = 40, perSignature = 3, focusStops = 80, budgetMs = 10000 } = {}) {
  const started = Date.now();
  const hoverDeadline = started + budgetMs * 0.6;
  const deadline = started + budgetMs;
  const scan = await page.evaluate(scanRules, {});
  const picked = await page.evaluate(install, { limit, perSignature });
  const args = (i) => ({ i, props: MOTION_PROPS, pseudoProps: PSEUDO_EXTRA });
  const stats = { candidates: picked.candidates.length, focusable: picked.focusable, probed: 0, hovered: 0, focused: 0, noChange: 0, notReverted: 0, covered: 0, skipped: picked.skipped, timedOut: false };
  const settle = (state) => Math.min(700, Math.max(80, (state ? transitionMs(state) : 200) + 60));

  const hover = [];
  let lastWait = 200;
  for (const c of picked.candidates) {
    if (Date.now() > hoverDeadline) {
      stats.timedOut = true;
      break;
    }
    const spot = await page.evaluate(aim, c.i);
    if (!spot || !spot.reachable) {
      stats.covered++;
      continue;
    }
    stats.probed++;
    // The rest state is read here, with the mouse out of the page, after the scroll that brought the element
    // into view has had time to run its reveal effects: those are not hover effects.
    await page.mouse.move(-20, -20).catch(() => {});
    // Not scrolled: only the previous probe's hover can still be fading out; scrolled: reveal effects may run.
    await page.waitForTimeout(spot.scrolled ? Math.min(450, lastWait + 100) : 60);
    let before = await page.evaluate(readState, args(c.i));
    // Read again until it holds still: a reveal that started with the scroll may still be running.
    for (let again = 0; before && spot.scrolled && again < 4; again++) {
      await page.waitForTimeout(150);
      const next = await page.evaluate(readState, args(c.i));
      if (!next) break;
      const steady = JSON.stringify([next.values, next.pseudo, next.kids.map((k) => k.values), next.rect]) === JSON.stringify([before.values, before.pseudo, before.kids.map((k) => k.values), before.rect]);
      before = next;
      if (steady) break;
    }
    if (!before) continue;
    lastWait = settle(before);
    await page.mouse.move(spot.x, spot.y);
    // The effect needs its transition to run (plus a frame); JavaScript-driven effects get the same time.
    await page.waitForTimeout(lastWait);
    const after = await page.evaluate(readState, args(c.i));
    if (!after) continue;
    const d = diffStates(before, after);
    if (!d) {
      stats.noChange++;
      continue;
    }
    // Control: a hover effect goes away when the mouse leaves. A change that stays (or goes on) is an entrance animation,
    // a timer or a loop that happened to run while the mouse was there - not a hover effect.
    await page.mouse.move(-20, -20).catch(() => {});
    await page.waitForTimeout(Math.min(600, settle(before) + 100));
    const back = await page.evaluate(readState, args(c.i));
    const kept = back ? keepReverting(before, back, d) : d;
    if (!kept) {
      stats.notReverted++;
      continue;
    }
    stats.hovered++;
    hover.push({ path: c.path, tag: c.tag, text: c.text, sig: c.sig, reasons: c.reasons, rect: c.rect, cursor: c.cursor, ...kept });
  }
  await page.mouse.move(-20, -20).catch(() => {});

  // Focus: the Tab key from the start of the page. At each stop the focused state is compared with the same
  // element blurred (same scroll position, same reveal state); a stop is probed once per element.
  const focus = [];
  const seen = new Set();
  await page.evaluate(resetFocus);
  for (let n = 0; n < focusStops && Date.now() <= deadline; n++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);
    const i = await page.evaluate(focused);
    if (i === null) break; // focus left the page
    if (i < 0 || seen.has(i)) continue;
    seen.add(i);
    const probe = await page.evaluate(readState, args(i));
    if (!probe) continue;
    await page.waitForTimeout(settle(probe));
    const focusedState = await page.evaluate(readState, args(i));
    await page.evaluate(blurIndex, i);
    await page.waitForTimeout(settle(probe));
    const blurred = await page.evaluate(readState, args(i));
    const d = focusedState && blurred && diffStates(blurred, focusedState);
    const c = picked.candidates[i];
    stats.focused++;
    if (d) focus.push({ path: c.path, tag: c.tag, text: c.text, sig: c.sig, rect: c.rect, ...d });
  }
  if (Date.now() > deadline) stats.timedOut = true;

  return {
    version: 1,
    view: 'desktop',
    capturedAt: new Date().toISOString(),
    props: MOTION_PROPS,
    hover,
    focus,
    groups: picked.groups,
    rules: scan.rules,
    stats: { ...stats, rules: scan.rules.length, rulesTotal: scan.total, unreadableSheets: scan.unreadable.length, ms: Date.now() - started },
  };
}
