// Click capture (full-site B.1): which parts of a page do something when a visitor clicks them - menus, dropdowns,
// hamburger toggles, accordions, tabs, carousels / sliders, dialogs. Run on the desktop view after the hover and focus
// probe (capture/interactions.js), when everything else has been captured from the page, because clicking changes it.
// Nothing is identified by library or class name: an element is clicked and the page is read before and after, and the
// change itself says what it is:
//   - disclosure: something became visible (or hidden) and the same click toggles it back (menu, dropdown, accordion item);
//   - tabs:       one of several sibling panels became visible while another one was hidden, and the trigger has equal
//                 siblings (the other tabs);
//   - carousel:   a track moved sideways (transform / scroll position), or slide N was hidden and N + 1 shown by a
//                 next / previous / dot control;
//   - dialog:     a fixed layer that covers most of the screen became visible (closed again with Escape).
// Before the click the mouse rests on the element for a moment: a panel that opens then opens on hover (`opensOn: 'hover'`).
// Links to other pages, form submissions and new windows are blocked while probing; a page that navigates anyway ends
// the probe. Elements are identified by the `path` of the DOM snapshot (body>div:1>button:0), like the other probes.
// Output: `motion.json.clicks`.
//
// Page functions below are self-contained (Playwright sends only their source).

const HINT_SOURCE = 'menu|toggle|burger|hamburger|nav|drawer|offcanvas|dropdown|collapse|expand|accordion|faq|tab|slide|carousel|swiper|slick|next|prev|previous|arrow|dot|bullet|pagination|close|open|more|modal|dialog|popup|lightbox';

/** Page function: blocks navigation while probing and picks the elements to click (window.__sasClick). */
function installClicks(opts) {
  const { limit, perSignature, hint } = opts;
  const HINT = new RegExp(hint, 'i');
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const MAX_NODES = 6000;

  if (!window.__sasClickGuard) {
    window.__sasClickGuard = true;
    // A link to another page or a form submission would leave the page: the default action is blocked, the page's own
    // click handlers still run (they decide what a menu button does).
    document.addEventListener('click', (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!a) return;
      const href = (a.getAttribute('href') || '').trim();
      if (!/^(#|javascript:)/i.test(href)) e.preventDefault();
    }, true);
    document.addEventListener('submit', (e) => e.preventDefault(), true);
    window.open = () => null;
  }

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
  const cls = (e) => [...(e?.classList || [])].sort().join('.');
  // Equal controls: same tag, role, classes, ARIA state attributes and the same parent and grandparent kind. Sites styled
  // inline have no classes, so without the ARIA attributes and the grandparent an FAQ question and a category chip looked
  // equal and one was skipped as a duplicate of the other.
  const aria = (el) => ['aria-expanded', 'aria-controls', 'aria-selected', 'aria-pressed'].filter((a) => el.hasAttribute(a)).join(',');
  const up = (el) => (el ? `${el.tagName.toLowerCase()}.${cls(el)}` : '');
  const sigOf = (el) => `${el.tagName.toLowerCase()}|${el.getAttribute('role') || ''}|${cls(el)}|${aria(el)}|${up(el.parentElement)}|${up(el.parentElement?.parentElement)}`;
  const labelOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.id, typeof el.className === 'string' ? el.className : '', el.textContent.trim().slice(0, 40)].filter(Boolean).join(' ');

  const reasonsOf = (el, cs) => {
    const tag = el.tagName;
    const r = [];
    // A button without a type is a submit button only inside a form; elsewhere it is a plain control.
    if (tag === 'BUTTON' && !(el.form && el.type === 'submit')) r.push('button');
    if (tag === 'SUMMARY') r.push('summary');
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'tab' || role === 'switch') r.push(`role:${role}`);
    if (el.hasAttribute('aria-expanded')) r.push('aria-expanded');
    if (el.hasAttribute('aria-controls')) r.push('aria-controls');
    if (el.hasAttribute('aria-haspopup')) r.push('aria-haspopup');
    if (tag === 'A') {
      const href = (el.getAttribute('href') || '').trim();
      if (href === '' || /^(#|javascript:)/i.test(href)) r.push('anchor');
      else return []; // a link to a page is navigation, not a control
    }
    if (!r.length && cs.cursor === 'pointer' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA' && tag !== 'LABEL' && HINT.test(labelOf(el))) r.push('hint');
    return r;
  };

  const found = [];
  const controls = [];
  const bySig = new Map();
  const skipped = { limit: 0, duplicate: 0, hidden: 0, inside: 0 };
  let seen = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (++seen > MAX_NODES) break;
    if (SKIP_TAGS.has(el.tagName) || (el.closest('svg') && el.tagName.toLowerCase() !== 'svg')) continue;
    const cs = getComputedStyle(el);
    const reasons = reasonsOf(el, cs);
    if (!reasons.length) continue;
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 4 || r.height < 4 || parseFloat(cs.opacity) < 0.02) {
      skipped.hidden++;
      continue;
    }
    // A control inside another control (an icon span in a button) is the same control, also when that one was only counted
    // as a duplicate of an equal control.
    if (controls.some((c) => c.contains(el))) {
      skipped.inside++;
      continue;
    }
    controls.push(el);
    const sig = sigOf(el);
    const group = bySig.get(sig) ?? bySig.set(sig, { sig, count: 0, paths: [] }).get(sig);
    group.count++;
    if (group.paths.length < 40) group.paths.push(pathOf(el));
    if (group.count > perSignature) {
      skipped.duplicate++;
      continue;
    }
    if (found.length >= limit) {
      skipped.limit++;
      continue;
    }
    found.push({ el, sig, reasons });
  }
  // Controls that announce a toggle (aria-expanded, <summary>) first: they are quick and undo themselves, so a page whose
  // tabs or filters need reloads cannot use up the time before its accordion was probed.
  const toggles = (f) => (f.reasons.includes('aria-expanded') || f.reasons.includes('summary') ? 0 : 1);
  found.sort((a, b) => toggles(a) - toggles(b));
  window.__sasClick = { els: found.map((f) => f.el), base: null };
  return {
    candidates: found.map((f, i) => ({
      i,
      path: pathOf(f.el),
      tag: f.el.tagName.toLowerCase(),
      text: (f.el.getAttribute('aria-label') || f.el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      sig: f.sig,
      reasons: f.reasons,
    })),
    groups: [...bySig.values()].filter((g) => g.count > 1),
    skipped,
  };
}

/**
 * Page function: reads the state of the page (visibility, a few attributes, sideways position) into window.__sasClick.base
 * when `save` is set; otherwise compares the page with the saved state and returns what changed.
 */
function readClickState(opts) {
  const { save, i } = opts;
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const ATTRS = ['aria-expanded', 'aria-selected', 'aria-hidden', 'aria-current', 'open', 'hidden'];
  const MAX_NODES = 6000;
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
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    // Clipped away: inside a collapsed box with overflow hidden (an accordion answer at grid-template-rows: 0fr or height: 0
    // keeps its own size, so only its clipping parent shows it is closed).
    for (let p = el.parentElement, k = 0; p && p !== document.body && k < 8; p = p.parentElement, k++) {
      const pcs = getComputedStyle(p);
      if (pcs.overflowX === 'visible' && pcs.overflowY === 'visible') continue;
      const pr = p.getBoundingClientRect();
      if (pr.width < 2 || pr.height < 2) return false;
    }
    return true;
  };
  // keepPaths: the reading before a click keeps the path of every visible element, so one the click removes from the page
  // (a filter dropping cards, a slide re-rendered) can still be named afterwards.
  const read = (keepPaths = false) => {
    const map = new Map();
    let n = 0;
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      if (++n > MAX_NODES) break;
      if (SKIP_TAGS.has(el.tagName) || (el.closest('svg') && el.tagName.toLowerCase() !== 'svg')) continue;
      const cs = getComputedStyle(el);
      const attrs = ATTRS.map((a) => el.getAttribute(a) ?? '').join('|');
      // Where the element sits sideways: a resting transform (none, or an identity matrix) and no scroll count as nothing.
      // A translate under half a pixel (a reveal animation finishing: translateY(0.00002px)) is no transform.
      const m = /^matrix\(1, 0, 0, 1, ([-\d.e]+), ([-\d.e]+)\)$/.exec(cs.transform);
      const tf = m && Math.abs(parseFloat(m[1])) < 0.5 && Math.abs(parseFloat(m[2])) < 0.5 ? 'none' : cs.transform;
      // A fixed or sticky bar that slides away on scroll (a header hiding itself) is not a track a click moved.
      const pinned = cs.position === 'fixed' || cs.position === 'sticky';
      const moved = !pinned && (tf !== 'none' || cs.translate !== 'none' || el.scrollLeft > 0) ? `${tf} ${cs.translate} ${el.scrollLeft}` : '';
      const v = visible(el);
      map.set(el, { v, a: attrs, c: typeof el.className === 'string' ? el.className : '', m: moved, ...(keepPaths && v && { p: pathOf(el) }) });
    }
    return map;
  };
  const state = window.__sasClick;
  if (save) {
    state.base = read(true);
    return null;
  }
  const before = state.base;
  const after = read();
  const shown = [];
  const hidden = [];
  const attrs = [];
  const moved = [];
  const added = [];
  const removed = [];
  for (const [el, b] of before) {
    const a = after.get(el);
    if (!a) {
      if (b.p && !el.isConnected) removed.push(b.p);
      continue;
    }
    if (!b.v && a.v) shown.push(el);
    else if (b.v && !a.v) hidden.push(el);
    if (b.a !== a.a || b.c !== a.c) attrs.push({ el, from: b.a, to: a.a, classFrom: b.c, classTo: a.c });
    if (b.m !== a.m) moved.push({ el, from: b.m, to: a.m });
  }
  for (const [el, a] of after) if (!before.has(el) && a.v) added.push(el);
  // Only the outermost changed elements: a panel, not every line inside it.
  const roots = (list) => list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
  const box = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    let fixed = false;
    for (let n = el; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') fixed = true;
    return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], fixed, position: cs.position };
  };
  const trigger = state.els[i];
  const describe = (el) => ({ path: pathOf(el), tag: el.tagName.toLowerCase(), parent: el.parentElement ? pathOf(el.parentElement) : null, ...box(el), inTrigger: trigger ? trigger.contains(el) : false });
  // Removed from the page: only the outermost, named by the path they had.
  const gone = removed.filter((p) => !removed.some((q) => q !== p && p.startsWith(`${q}>`))).slice(0, 12)
    .map((p) => ({ path: p, tag: p.slice(p.lastIndexOf('>') + 1).split(':')[0], parent: p.slice(0, p.lastIndexOf('>')), rect: [0, 0, 0, 0], fixed: false, position: '', inTrigger: false, removed: true }));
  return {
    shown: roots(shown).slice(0, 12).map(describe),
    hidden: [...roots(hidden).slice(0, 12).map(describe), ...gone],
    added: roots(added).slice(0, 6).map(describe),
    attrs: attrs.slice(0, 12).map((x) => ({ path: pathOf(x.el), from: x.from, to: x.to, classFrom: x.classFrom.slice(0, 120), classTo: x.classTo.slice(0, 120), isTrigger: x.el === trigger })),
    moved: moved.filter((x) => x.el.getBoundingClientRect().width >= 100).slice(0, 6).map((x) => ({ path: pathOf(x.el), from: x.from, to: x.to })),
    url: location.href,
    viewport: [innerWidth, innerHeight],
  };
}

/**
 * Page function: the styles that make a panel open or closed, for the element at `rootPath` (snapshot path) and its
 * descendants (≤ 400), keyed by their path relative to it ('' = the element itself). Read with the panel open and again
 * closed; the difference is the open state (ir/motion.js widgets).
 */
function readRegion({ rootPath }) {
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const PROPS = ['display', 'visibility', 'opacity', 'transform', 'rotate', 'translate', 'scale', 'height', 'max-height', 'grid-template-rows',
    'padding-top', 'padding-bottom', 'margin-top', 'margin-bottom', 'color', 'background-color', 'border-top-color', 'border-bottom-color'];
  const PSEUDO = ['content', 'transform', 'rotate', 'opacity', 'color', 'background-color'];
  const MAX = 400;
  let el = document.body;
  for (const part of rootPath.split('>').slice(1)) {
    const [tag, n] = part.split(':');
    let count = 0;
    let next = null;
    for (const c of el ? el.children : []) {
      if (SKIP_TAGS.has(c.tagName) || c.tagName.toLowerCase() !== tag) continue;
      if (++count === Number(n)) {
        next = c;
        break;
      }
    }
    el = next;
  }
  if (!el) return null;
  const out = {};
  let seen = 0;
  const walk = (node, rel) => {
    if (seen++ >= MAX) return;
    const cs = getComputedStyle(node);
    const entry = { s: {} };
    for (const p of PROPS) entry.s[p] = cs.getPropertyValue(p);
    for (const w of ['before', 'after']) {
      const pcs = getComputedStyle(node, `::${w}`);
      if (pcs.content && pcs.content !== 'none' && pcs.content !== 'normal') {
        entry[w] = {};
        for (const p of PSEUDO) entry[w][p] = pcs.getPropertyValue(p);
      }
    }
    entry.a = node.getAttribute('aria-expanded');
    out[rel] = entry;
    if (node.tagName.toLowerCase() === 'svg') return;
    const tagIndex = {};
    for (const c of node.children) {
      if (SKIP_TAGS.has(c.tagName)) continue;
      const t = c.tagName.toLowerCase();
      tagIndex[t] = (tagIndex[t] || 0) + 1;
      walk(c, `${rel ? `${rel}>` : ''}${t}:${tagIndex[t]}`);
    }
  };
  walk(el, '');
  return out;
}

/** The deepest snapshot path that contains all the given paths. */
export function commonPath(paths) {
  const split = paths.filter(Boolean).map((p) => p.split('>'));
  if (!split.length) return null;
  const out = [];
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i];
    if (split.every((s) => s[i] === seg)) out.push(seg);
    else break;
  }
  return out.length ? out.join('>') : null;
}

/** What differs between the open and the closed read of a region: [{ rel, changes: { prop: [closed, open] }, before?, after? }]. */
export function regionDiff(closed, open) {
  const parts = [];
  const pair = (a = {}, b = {}) => {
    const c = {};
    for (const k of Object.keys(b)) if (a[k] !== b[k]) c[k] = [a[k] ?? null, b[k]];
    return c;
  };
  for (const [rel, o] of Object.entries(open ?? {})) {
    const c = closed?.[rel];
    if (!c) continue; // only in the open state: the page added it (a script renders the panel), nothing to style
    const part = { rel, changes: pair(c.s, o.s) };
    for (const w of ['before', 'after']) {
      if (o[w] || c[w]) {
        const pc = pair(c[w] ?? { content: 'none' }, o[w] ?? { content: 'none' });
        if (Object.keys(pc).length) part[w] = pc;
      }
    }
    if (Object.keys(part.changes).length || part.before || part.after) parts.push(part);
  }
  return parts;
}

/** Page function: brings candidate `i` into view and returns where to click it, or null when something covers it. */
function aimClick(i) {
  const el = window.__sasClick?.els[i];
  if (!el || !el.isConnected) return null;
  const before = el.getBoundingClientRect();
  const scrolled = before.top < 0 || before.bottom > innerHeight;
  if (scrolled) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const x = Math.round(Math.min(innerWidth - 2, Math.max(1, r.left + r.width / 2)));
  const y = Math.round(Math.min(innerHeight - 2, Math.max(1, r.top + r.height / 2)));
  const top = document.elementFromPoint(x, y);
  return { x, y, scrolled, reachable: !!top && (top === el || el.contains(top) || top.contains(el)) };
}

/** Page function: clicks candidate `i` without the mouse (a fallback when something covers it). */
function clickIndex(i) {
  window.__sasClick?.els[i]?.click();
}

/**
 * Page function: snapshot paths of elements that move or fade by themselves within `ms` (word rotators, marquees, spinners,
 * floating shapes): their own transform and opacity. Display, visibility, text and position are not read.
 */
export async function selfMoving(ms) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const read = () => {
    const out = new Map();
    let n = 0;
    const walk = (el, path) => {
      if (n++ > 6000) return;
      // Its own animation only: a position change can be a layout shift above it (an image loading), which would mark a
      // whole section as moving and hide every real change inside it.
      const cs = getComputedStyle(el);
      out.set(path, `${cs.transform}|${cs.translate}|${cs.rotate}|${cs.scale}|${cs.opacity}`);
      if (el.tagName.toLowerCase() === 'svg') return;
      const idx = {};
      for (const c of el.children) {
        if (SKIP.has(c.tagName)) continue;
        const t = c.tagName.toLowerCase();
        idx[t] = (idx[t] || 0) + 1;
        walk(c, `${path}>${t}:${idx[t]}`);
      }
    };
    if (document.body) walk(document.body, 'body');
    return out;
  };
  const a = read();
  await new Promise((r) => setTimeout(r, ms));
  const b = read();
  const changed = [];
  for (const [p, v] of a) if (b.has(p) && b.get(p) !== v) changed.push(p);
  // The outermost ones: what is inside a moving element moves with it.
  return changed.filter((p) => !changed.some((q) => q !== p && p.startsWith(`${q}>`))).slice(0, 500);
}

/**
 * Page function: do the controls still to probe sit where the page started (same element, same snapshot path)? A part
 * re-rendered in place (a carousel's panel) keeps them; a section inserted above them (a tab adding a form) does not.
 */
export function controlsInPlace(list) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) {
        parts.push('body');
        break;
      }
      let index = 0;
      for (const s of n.parentElement ? n.parentElement.children : []) {
        if (SKIP.has(s.tagName)) continue;
        if (s.tagName === n.tagName) index++;
        if (s === n) break;
      }
      parts.push(`${n.tagName.toLowerCase()}:${index}`);
    }
    return parts.reverse().join('>');
  };
  const els = window.__sasClick?.els ?? [];
  return list.every(({ i, path }) => els[i] && els[i].isConnected && pathOf(els[i]) === path);
}

/** Page function: clears every pending timeout and interval of the page (timer ids are consecutive numbers). */
export function stopTimers() {
  const last = setTimeout(() => {}, 0);
  for (let id = 0; id <= last; id++) {
    clearTimeout(id);
    clearInterval(id);
  }
  return last;
}

/** A change list without what changes by itself (`noise`: elements moving on their own, and what is inside them). */
export function withoutNoise(d, noise) {
  if (!d || !noise?.length) return d;
  const quiet = (p) => !noise.some((n) => p === n || p.startsWith(`${n}>`));
  return {
    ...d,
    shown: d.shown.filter((x) => quiet(x.path)),
    hidden: d.hidden.filter((x) => quiet(x.path)),
    added: d.added.filter((x) => quiet(x.path)),
    moved: d.moved.filter((x) => quiet(x.path)),
    attrs: d.attrs.filter((x) => quiet(x.path)),
  };
}

/** Same page: same origin and path (a query or hash the page writes itself, like ?tab=join, is not another page). */
export function samePage(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
  } catch {
    return a === b;
  }
}

const empty = (d) => !d || (!d.shown.length && !d.hidden.length && !d.added.length && !d.moved.length && !d.attrs.length);
const visibleChange = (d) => d && (d.shown.length || d.hidden.length || d.added.length);
const parentOf = (p) => (p ? p.slice(0, p.lastIndexOf('>')) : null);

/**
 * What a click did, from the change it made. `group` = the trigger's equal siblings (other tabs, dots).
 * @returns {{ kind: 'dialog'|'tabs'|'carousel'|'disclosure'|'state', targets: string[] } | null}
 */
export function classifyClick(d, { text = '', group = null, triggerPath = null } = {}) {
  if (empty(d)) return null;
  const [vw, vh] = d.viewport ?? [1440, 900];
  const opened = [...d.shown, ...d.added].filter((x) => !x.inTrigger);
  const closed = d.hidden.filter((x) => !x.inTrigger);
  // A fixed layer that covers most of the screen.
  const layer = opened.find((x) => x.fixed && x.rect[2] * x.rect[3] >= 0.5 * vw * vh);
  if (layer) return { kind: 'dialog', targets: [layer.path] };
  const NAV = /next|prev|previous|arrow|›|‹|→|←|»|«|>|<|dot|bullet|slide/i;
  // Siblings swapped: one panel hidden, a sibling shown.
  const swap = opened.find((o) => closed.some((c) => c.parent && c.parent === o.parent));
  if (swap) {
    const isNav = NAV.test(text) || (group && group.count >= 2 && !/tab/i.test(group.sig) && /dot|bullet|pagination/i.test(group.sig));
    const kind = group && group.count >= 2 && !isNav ? 'tabs' : isNav ? 'carousel' : 'tabs';
    return { kind, targets: [swap.path, ...closed.filter((c) => c.parent === swap.parent).map((c) => c.path)].slice(0, 8) };
  }
  // A track moved sideways (and nothing else opened): a slider.
  if (!opened.length && !closed.length && d.moved.length) return { kind: 'carousel', targets: d.moved.map((m) => m.path).slice(0, 4) };
  if (opened.length || closed.length) {
    const outside = [...opened, ...closed];
    return { kind: 'disclosure', targets: outside.map((x) => x.path).slice(0, 6) };
  }
  // Only attributes / classes changed (a toggle that changes its own look, a switch): recorded, nothing to rebuild yet.
  if (d.attrs.length) return { kind: 'state', targets: d.attrs.filter((a) => !a.isTrigger).map((a) => a.path).slice(0, 4), ...(triggerPath && { trigger: triggerPath }) };
  return null;
}

/**
 * Clicks the controls of a page (desktop view) and records what each one does. Stops at the budget, or when the page
 * leaves (a script navigated in spite of the guard).
 * @param {import('playwright').Page} page
 * @param {{ limit?: number, perSignature?: number, budgetMs?: number }} [o]
 * @returns {Promise<object>} `motion.json.clicks`
 */
export async function captureClicks(page, { limit = 30, perSignature = 3, budgetMs = 10000 } = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const startUrl = page.url();
  // A tab that writes its state into the address (?tab=join, #faq) without loading another page has not left the page.
  const left = () => !samePage(page.url(), startUrl);
  const picked = await page.evaluate(installClicks, { limit, perSignature, hint: HINT_SOURCE });
  const stats = { candidates: picked.candidates.length, probed: 0, found: 0, noChange: 0, covered: 0, notRestored: 0, left: false, timedOut: false, skipped: picked.skipped, kinds: {} };
  const groupOf = new Map();
  for (const g of picked.groups) for (const p of g.paths) groupOf.set(p, g);
  // A carousel that advances on a timer changes the page in the middle of other probes (a "hover" that opened nothing, a
  // panel that seems not to close). Clicks are the last thing done on the page, so its pending timers are stopped: click
  // handlers still run (and may start new timers), CSS animations go on and are measured as noise just below.
  if (picked.candidates.length) await page.evaluate(stopTimers).catch(() => {});
  // What moves by itself (a word rotator in the hero, a logo marquee) changes during every probe: it is never what a click did.
  const noise = picked.candidates.length ? await page.evaluate(selfMoving, 1500).catch(() => []) : [];
  const read = (i) => page.evaluate(readClickState, { save: false, i }).then((d) => withoutNoise(d, noise));
  const save = () => page.evaluate(readClickState, { save: true });
  const settleTime = 450;
  // A click that is not undone by clicking again and inserts or removes part of the page (a tab adding a form section)
  // shifts the paths of the controls after it: the next probes would read the wrong elements. The page is then loaded again
  // (the candidates are the same elements by path) before the next probe, and at the end, so the state capture starts from
  // the page as captured. A part re-rendered in place (a carousel's panel) moves no control: no reload.
  stats.reloads = 0;
  const reset = async () => {
    // The address the probe started on: a tab may have written its own state into the current one (?tab=join).
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.evaluate(stopTimers).catch(() => {});
    const again = await page.evaluate(installClicks, { limit, perSignature, hint: HINT_SOURCE });
    stats.reloads++;
    return again.candidates.length === picked.candidates.length && again.candidates.every((x, k) => x.path === picked.candidates[k].path);
  };
  const all = picked.candidates.map((x) => ({ i: x.i, path: x.path }));
  const changed = async (from = 0) => !(await page.evaluate(controlsInPlace, all.slice(from)).catch(() => true));

  const widgets = [];
  for (const c of picked.candidates) {
    if (Date.now() > deadline) {
      stats.timedOut = true;
      break;
    }
    if (left()) {
      stats.left = true;
      break;
    }
    if (await changed(c.i)) {
      if (!(await reset().catch(() => false))) {
        stats.left = true;
        break;
      }
    }
    let spot;
    try {
      spot = await page.evaluate(aimClick, c.i);
    } catch {
      stats.left = true;
      break;
    }
    if (!spot) {
      stats.covered++;
      continue;
    }
    stats.probed++;
    try {
      await page.mouse.move(-20, -20).catch(() => {});
      // After scrolling the control into view, what reacts to the scroll (a header sliding away, reveals) settles first, and
      // the control is aimed at again: a smooth scroll moved it after the first aim.
      await page.waitForTimeout(spot.scrolled ? 700 : 150);
      if (spot.scrolled) spot = (await page.evaluate(aimClick, c.i)) ?? spot;
      await save();
      // Hover first: a dropdown that opens when the mouse rests on its trigger.
      let opensOn = 'click';
      if (spot.reachable) {
        await page.mouse.move(spot.x, spot.y);
        await page.waitForTimeout(350);
        const hovered = await read(c.i);
        if (visibleChange(hovered)) {
          const kind = classifyClick(hovered, { text: c.text, group: groupOf.get(c.path), triggerPath: c.path });
          if (kind && kind.kind !== 'state') {
            opensOn = 'hover';
            widgets.push({ ...kind, trigger: c.path, tag: c.tag, text: c.text, reasons: c.reasons, opensOn, change: compact(hovered) });
            stats.found++;
            stats.kinds[kind.kind] = (stats.kinds[kind.kind] ?? 0) + 1;
            await page.mouse.move(-20, -20).catch(() => {});
            await page.waitForTimeout(350);
            continue;
          }
        }
      }
      if (spot.reachable) await page.mouse.click(spot.x, spot.y);
      else await page.evaluate(clickIndex, c.i);
      await page.waitForTimeout(settleTime);
      if (left()) {
        stats.left = true;
        break;
      }
      let d = await read(c.i);
      // Read again while it is still moving (a slide or panel animating in).
      const again = await page.waitForTimeout(250).then(() => read(c.i));
      if (JSON.stringify(again) !== JSON.stringify(d)) d = again;
      const kind = classifyClick(d, { text: c.text, group: groupOf.get(c.path), triggerPath: c.path });
      if (!kind) {
        stats.noChange++;
        continue;
      }
      const entry = { ...kind, trigger: c.path, tag: c.tag, text: c.text, reasons: c.reasons, opensOn, change: compact(d) };
      const group = groupOf.get(c.path);
      if (group) entry.group = { sig: group.sig, count: group.count, paths: group.paths };
      // Put the page back: the same click (a toggle), then Escape, then a click outside.
      if (kind.kind === 'disclosure' || kind.kind === 'dialog') {
        // The open state as styles (accordion answers, dropdowns): the part of the page that holds the trigger and what it
        // opened, read open now and closed again after the restoring click.
        const common = kind.kind === 'disclosure' ? commonPath([c.path, ...kind.targets]) : null;
        const root = common && common !== 'body' ? common : null;
        const open = root ? await page.evaluate(readRegion, { rootPath: root }).catch(() => null) : null;
        entry.closes = await restore(page, c, spot, read);
        if (!entry.closes) stats.notRestored++;
        else if (open) {
          await page.waitForTimeout(200);
          const closed = await page.evaluate(readRegion, { rootPath: root }).catch(() => null);
          const parts = closed ? regionDiff(closed, open) : [];
          if (parts.length) entry.state = { root, parts, ...(Object.keys(open).length > Object.keys(closed).length && { added: true }) };
        }
      }
      widgets.push(entry);
      stats.found++;
      stats.kinds[kind.kind] = (stats.kinds[kind.kind] ?? 0) + 1;
    } catch {
      // A probe that throws (the element went away, the page navigated) is skipped; the next one decides.
      if (left()) {
        stats.left = true;
        break;
      }
    }
  }
  await page.mouse.move(-20, -20).catch(() => {});
  if (Date.now() > deadline) stats.timedOut = true;
  if (!left() && (await changed())) await reset().catch(() => {});

  // One panel open at a time? For each list of equal panels (two probed members whose open state the same click undoes):
  // open the first, then the second, and see whether the first closed by itself (an accordion) or stayed open.
  stats.exclusive = 0;
  const lists = new Map();
  for (const w of widgets) {
    if (w.kind !== 'disclosure' || w.opensOn !== 'click' || !w.state || w.closes !== 'toggle' || !w.group?.sig) continue;
    if (!lists.has(w.group.sig)) lists.set(w.group.sig, []);
    lists.get(w.group.sig).push(w);
  }
  for (const list of lists.values()) {
    if (list.length < 2 || left()) continue;
    const [a, b] = list;
    const ia = picked.candidates.find((x) => x.path === a.trigger)?.i;
    const ib = picked.candidates.find((x) => x.path === b.trigger)?.i;
    if (ia == null || ib == null) continue;
    try {
      const closedA = await page.evaluate(readRegion, { rootPath: a.state.root });
      await page.evaluate(clickIndex, ia);
      await page.waitForTimeout(500);
      const openA = await page.evaluate(readRegion, { rootPath: a.state.root });
      await page.evaluate(clickIndex, ib);
      await page.waitForTimeout(500);
      const afterB = await page.evaluate(readRegion, { rootPath: a.state.root });
      if (closedA && openA && afterB && regionDiff(closedA, openA).length) {
        const stillOpen = regionDiff(closedA, afterB).length > 0;
        for (const w of list) w.exclusive = !stillOpen;
        if (!stillOpen) stats.exclusive++;
        // Close what is open again.
        if (stillOpen) await page.evaluate(clickIndex, ia);
        await page.evaluate(clickIndex, ib);
        await page.waitForTimeout(400);
      }
    } catch {
      /* the list is left as found */
    }
  }
  return { version: 1, view: 'desktop', widgets, groups: picked.groups, noise, stats: { ...stats, noise: noise.length, ms: Date.now() - started } };
}

/** Closes what a click opened; returns how ('toggle' | 'escape' | 'outside') or null when it stays open. */
async function restore(page, c, spot, read) {
  const closed = async () => {
    await page.waitForTimeout(350);
    const d = await read(c.i);
    return !visibleChange(d);
  };
  try {
    if (spot.reachable) {
      const again = await page.evaluate(aimClick, c.i);
      if (again?.reachable) {
        await page.mouse.click(again.x, again.y);
        if (await closed()) return 'toggle';
      }
    }
    await page.keyboard.press('Escape');
    if (await closed()) return 'escape';
    await page.mouse.click(4, 4);
    if (await closed()) return 'outside';
  } catch {
    /* the next probe reads the page as it is */
  }
  return null;
}

/** The parts of a change worth keeping in motion.json. */
function compact(d) {
  const slim = (x) => ({ path: x.path, rect: x.rect, ...(x.fixed && { fixed: true }) });
  return {
    shown: d.shown.map(slim),
    hidden: d.hidden.map(slim),
    added: d.added.map(slim),
    attrs: d.attrs.map(({ path, from, to, isTrigger }) => ({ path, from, to, ...(isTrigger && { isTrigger }) })),
    moved: d.moved,
  };
}
