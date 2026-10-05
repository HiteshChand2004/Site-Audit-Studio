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
    // Client-side routers change the address with the History API: kept on this page while probing.
    history.pushState = () => {};
    history.replaceState = () => {};
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
  const sigOf = (el) => `${el.tagName.toLowerCase()}|${el.getAttribute('role') || ''}|${cls(el)}|${el.parentElement ? `${el.parentElement.tagName.toLowerCase()}.${cls(el.parentElement)}` : ''}`;
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
    // A control inside another chosen control (an icon span in a button) is the same control.
    if (found.some((f) => f.el.contains(el))) {
      skipped.inside++;
      continue;
    }
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
    return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  };
  const read = () => {
    const map = new Map();
    let n = 0;
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      if (++n > MAX_NODES) break;
      if (SKIP_TAGS.has(el.tagName) || (el.closest('svg') && el.tagName.toLowerCase() !== 'svg')) continue;
      const cs = getComputedStyle(el);
      const attrs = ATTRS.map((a) => el.getAttribute(a) ?? '').join('|');
      // Where the element sits sideways: a resting transform (none, or an identity matrix) and no scroll count as nothing.
      const tf = cs.transform === 'matrix(1, 0, 0, 1, 0, 0)' ? 'none' : cs.transform;
      const moved = tf !== 'none' || cs.translate !== 'none' || el.scrollLeft > 0 ? `${tf} ${cs.translate} ${el.scrollLeft}` : '';
      map.set(el, { v: visible(el), a: attrs, c: typeof el.className === 'string' ? el.className : '', m: moved });
    }
    return map;
  };
  const state = window.__sasClick;
  if (save) {
    state.base = read();
    return null;
  }
  const before = state.base;
  const after = read();
  const shown = [];
  const hidden = [];
  const attrs = [];
  const moved = [];
  const added = [];
  for (const [el, b] of before) {
    const a = after.get(el);
    if (!a) continue;
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
  // The element's look in its new state (open panel, shown tab): what a rebuilt widget switches to (full-site C.1).
  const OPEN_PROPS = ['display', 'visibility', 'opacity', 'transform', 'translate', 'height', 'max-height', 'overflow', 'clip-path', 'pointer-events', 'z-index'];
  const styleOf = (el) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(OPEN_PROPS.map((p) => [p, cs.getPropertyValue(p)]));
  };
  const describe = (el) => ({ path: pathOf(el), tag: el.tagName.toLowerCase(), parent: el.parentElement ? pathOf(el.parentElement) : null, ...box(el), style: styleOf(el), inTrigger: trigger ? trigger.contains(el) : false, hasTrigger: trigger ? el !== trigger && el.contains(trigger) : false });
  return {
    shown: roots(shown).slice(0, 12).map(describe),
    hidden: roots(hidden).slice(0, 12).map(describe),
    added: roots(added).slice(0, 6).map(describe),
    attrs: attrs.slice(0, 12).map((x) => ({ path: pathOf(x.el), from: x.from, to: x.to, classFrom: x.classFrom.slice(0, 120), classTo: x.classTo.slice(0, 120), isTrigger: x.el === trigger })),
    moved: moved.filter((x) => x.el.getBoundingClientRect().width >= 100).slice(0, 6).map((x) => ({ path: pathOf(x.el), from: x.from, to: x.to })),
    url: location.href,
    viewport: [innerWidth, innerHeight],
  };
}

/** Page function: brings candidate `i` into view and returns where to click it, or null when something covers it. */
function aimClick(i) {
  const el = window.__sasClick?.els[i];
  if (!el || !el.isConnected) return null;
  const before = el.getBoundingClientRect();
  if (before.top < 0 || before.bottom > innerHeight) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const x = Math.round(Math.min(innerWidth - 2, Math.max(1, r.left + r.width / 2)));
  const y = Math.round(Math.min(innerHeight - 2, Math.max(1, r.top + r.height / 2)));
  const top = document.elementFromPoint(x, y);
  return { x, y, reachable: !!top && (top === el || el.contains(top) || top.contains(el)) };
}

/** Page function: clicks candidate `i` without the mouse (a fallback when something covers it). */
function clickIndex(i) {
  window.__sasClick?.els[i]?.click();
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
  // A control that hides the block it sits in (a "close" or "collapse" button) is a toggle, not a tab.
  const own = closed.find((c) => c.hasTrigger);
  if (own) return { kind: 'disclosure', targets: [own.path, ...opened.map((o) => o.path)].slice(0, 6) };
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
  // A full page load started by a script (location.href = …) is answered with 204 No Content while probing: the browser
  // then stays on the page (an aborted navigation would show an error page). Resources still load.
  const blockNavigation = (route) => (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame() ? route.fulfill({ status: 204, body: '' }) : route.fallback());
  await page.route('**/*', blockNavigation);
  const picked = await page.evaluate(installClicks, { limit, perSignature, hint: HINT_SOURCE });
  const stats = { candidates: picked.candidates.length, probed: 0, found: 0, noChange: 0, covered: 0, notRestored: 0, left: false, timedOut: false, skipped: picked.skipped, kinds: {} };
  const groupOf = new Map();
  for (const g of picked.groups) for (const p of g.paths) groupOf.set(p, g);
  const read = (i) => page.evaluate(readClickState, { save: false, i });
  const save = () => page.evaluate(readClickState, { save: true });
  const settleTime = 350;

  const widgets = [];
  for (const c of picked.candidates) {
    if (Date.now() > deadline) {
      stats.timedOut = true;
      break;
    }
    if (page.url() !== startUrl) {
      stats.left = true;
      break;
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
      await page.waitForTimeout(80);
      await save();
      // Hover first: a dropdown that opens when the mouse rests on its trigger.
      let opensOn = 'click';
      if (spot.reachable) {
        await page.mouse.move(spot.x, spot.y);
        await page.waitForTimeout(280);
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
      if (page.url() !== startUrl && page.url().split('#')[0] !== startUrl.split('#')[0]) {
        stats.left = true;
        break;
      }
      let d = await read(c.i);
      // Read again while it is still moving (a slide or panel animating in).
      const again = await page.waitForTimeout(200).then(() => read(c.i));
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
        entry.closes = await restore(page, c, spot, read);
        if (!entry.closes) stats.notRestored++;
      }
      widgets.push(entry);
      stats.found++;
      stats.kinds[kind.kind] = (stats.kinds[kind.kind] ?? 0) + 1;
    } catch {
      // A probe that throws (the element went away, the page navigated) is skipped; the next one decides.
      if (page.url() !== startUrl) {
        stats.left = true;
        break;
      }
    }
  }
  await page.mouse.move(-20, -20).catch(() => {});
  if (Date.now() > deadline) stats.timedOut = true;
  await page.unroute('**/*', blockNavigation).catch(() => {});
  return { version: 1, view: 'desktop', widgets, groups: picked.groups, stats: { ...stats, ms: Date.now() - started } };
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
  const slim = (x) => ({ path: x.path, rect: x.rect, style: x.style, ...(x.fixed && { fixed: true }) });
  return {
    shown: d.shown.map(slim),
    hidden: d.hidden.map(slim),
    added: d.added.map(slim),
    attrs: d.attrs.map(({ path, from, to, isTrigger }) => ({ path, from, to, ...(isTrigger && { isTrigger }) })),
    moved: d.moved,
  };
}
