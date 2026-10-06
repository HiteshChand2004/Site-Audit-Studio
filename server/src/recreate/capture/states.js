// States of tabs, carousels and filtered lists (step 2 of the "as is" fixes). The click probe (capture/clicks.js) finds the
// controls; many of them make the page re-render a part of itself (the detail panel of the selected venture, the cards of
// the selected category), so the other states never exist in the page snapshot. Here every control of a group of equal
// controls (dots, tabs, category chips) is clicked in turn and the part of the page that changes (the "area": the deepest
// element holding the controls and everything they changed) is snapshotted in that state (snapshot.js with `rootPath`).
// Next / previous buttons are clicked once from the first state and matched to the state they lead to (+1 / −1).
// Elements that move by themselves (word rotators, marquees; measured by the click probe, clicks.noise) never count as a change,
// and the area grows from the controls only until it holds what they changed.
//
// Output, on the area's node of the page snapshot (capture/<slug>/desktop.json):
//   node.states = { initial, count, controls: [rel], nav: [{ rel, offset }], variants: [{ index, body }] }
// `rel` = snapshot path relative to the area; `body` = the area snapshotted in state `index` (the initial state is the node
// itself and has no variant). ir/states.js turns this into hidden copies of the area that js/motion.js switches between.
//
// Page functions below are self-contained (Playwright sends only their source).
import { samePage } from './clicks.js';
import { snapshotPage } from './snapshot.js';

const NAV = /next|prev|previous|arrow|›|‹|→|←|»|«|^>$|^<$/i;
const MAX_CONTROLS = 30;
const SETTLE_MS = 450;
const MAX_STATE_NODES = 3000; // elements of all state copies of a many-part set (controls × parts' elements)
const countNodes = (n) => (!n || 'text' in n ? 0 : 1 + (n.children ?? []).reduce((a, c) => a + countNodes(c), 0));

/** Page function: clicks the element at a snapshot path (no mouse: the control may be covered or scrolled away). */
function clickPath(p) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  let el = document.body;
  for (const part of p.split('>').slice(1)) {
    const [tag, n] = part.split(':');
    let k = 0;
    let next = null;
    for (const c of el ? el.children : []) {
      if (SKIP.has(c.tagName) || c.tagName.toLowerCase() !== tag) continue;
      if (++k === Number(n)) {
        next = c;
        break;
      }
    }
    el = next;
  }
  if (!el) return false;
  el.click();
  return true;
}

/**
 * Page function: all controls of a row. The selected dot or tab usually looks different (another class or style), so the
 * probe's group of equal controls misses it; when the group shares one parent, every element child of that parent with
 * the same tag is a control of the row, in page order.
 */
function rowControls(paths) {
  const parentOf = (p) => p.slice(0, p.lastIndexOf('>'));
  const parent = parentOf(paths[0]);
  if (!paths.every((p) => parentOf(p) === parent)) return paths;
  const tag = paths[0].slice(paths[0].lastIndexOf('>') + 1).split(':')[0];
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  let el = document.body;
  for (const part of parent.split('>').slice(1)) {
    const [t, n] = part.split(':');
    let k = 0;
    let next = null;
    for (const c of el ? el.children : []) {
      if (SKIP.has(c.tagName) || c.tagName.toLowerCase() !== t) continue;
      if (++k === Number(n)) {
        next = c;
        break;
      }
    }
    el = next;
  }
  if (!el) return paths;
  const out = [];
  let k = 0;
  for (const c of el.children) {
    if (SKIP.has(c.tagName) || c.tagName.toLowerCase() !== tag) continue;
    k++;
    out.push(`${parent}>${tag}:${k}`);
  }
  return out.length >= paths.length ? out : paths;
}

/**
 * Page function: scrolls through the element at `p` (top to bottom, instantly), so content that appears when scrolled
 * into view is shown before a state is snapshotted. Ends with the element's top in view.
 */
async function revealArea(p) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  let el = document.body;
  for (const part of p.split('>').slice(1)) {
    const [tag, n] = part.split(':');
    let k = 0;
    let next = null;
    for (const c of el ? el.children : []) {
      if (SKIP.has(c.tagName) || c.tagName.toLowerCase() !== tag) continue;
      if (++k === Number(n)) {
        next = c;
        break;
      }
    }
    el = next;
  }
  if (!el) return false;
  // Nothing waiting to be revealed (no element at opacity ≈ 0): no scrolling needed.
  if (![el, ...el.querySelectorAll('*')].some((n) => parseFloat(getComputedStyle(n).opacity) < 0.05)) return true;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const top = el.getBoundingClientRect().top + scrollY;
  const bottom = top + el.getBoundingClientRect().height;
  for (let y = Math.max(0, top - innerHeight * 0.2); y < bottom; y += innerHeight * 0.7) {
    window.scrollTo({ top: y, behavior: 'instant' });
    await pause(180);
  }
  window.scrollTo({ top: Math.max(0, top - innerHeight * 0.2), behavior: 'instant' });
  await pause(350);
  return true;
}

/** The deepest snapshot path that contains all the given paths. */
function commonPath(paths) {
  const split = paths.filter(Boolean).map((p) => p.split('>'));
  if (!split.length) return null;
  const out = [];
  for (let i = 0; i < split[0].length; i++) {
    if (split.every((s) => s[i] === split[0][i])) out.push(split[0][i]);
    else break;
  }
  return out.join('>') || null;
}

const related = (a, b) => a === b || a.startsWith(`${b}>`) || b.startsWith(`${a}>`);

/** What a state looks like, for telling states apart: structure, visibility and text, not exact styles. */
export function stateSignature(node) {
  const parts = [];
  const walk = (n) => {
    if (!n) return;
    if ('text' in n) {
      parts.push(n.text.trim());
      return;
    }
    const hidden = n.hidden || n.style?.display === 'none' || n.style?.visibility === 'hidden' || n.style?.opacity === '0' || n.attrs?.['aria-hidden'] === 'true';
    parts.push(`<${n.tag}${hidden ? ' h' : ''}>`);
    if (!hidden) for (const c of n.children ?? []) walk(c);
    parts.push('>');
  };
  walk(node);
  return parts.join('');
}

/**
 * The area as a first-time visitor sees it right after the page loads: a fresh browser context (no cookies or storage: a
 * site may remember the last slide shown), same window size and user agent, the page's intervals and long timers (≥ 1 s:
 * autoplay) made to do nothing before its scripts run, so nothing moves the carousel while it is read.
 */
async function firstVisit(page, url, area) {
  const browser = page.context().browser();
  if (!browser) return null;
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const context = await browser.newContext({ viewport: page.viewportSize(), userAgent, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  try {
    await context.addInitScript(() => {
      const later = window.setTimeout;
      window.setInterval = () => 0;
      window.setTimeout = (fn, ms, ...args) => (Number(ms) >= 1000 ? 0 : later(fn, ms, ...args));
    });
    const fresh = await context.newPage();
    await fresh.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await fresh.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    await fresh.waitForTimeout(800);
    await fresh.evaluate(revealArea, area).catch(() => {});
    return (await fresh.evaluate(snapshotPage, { rootPath: area }))?.body ?? null;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Page function: watches the visible text of the element at `p` (every 100 ms, up to `ms`) and returns each change with its
 * time: [{ t, text }], the first reading included. Stops after `want` readings, or after `quietMs` without any change.
 */
async function watchText({ p, ms, quietMs, want }) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  let el = document.body;
  for (const part of p.split('>').slice(1)) {
    const [tag, n] = part.split(':');
    let k = 0;
    let next = null;
    for (const c of el ? el.children : []) {
      if (SKIP.has(c.tagName) || c.tagName.toLowerCase() !== tag) continue;
      if (++k === Number(n)) {
        next = c;
        break;
      }
    }
    el = next;
  }
  if (!el) return [];
  const visibleText = (node) => {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out.push(c.textContent);
        else if (c.nodeType === 1 && !SKIP.has(c.tagName)) {
          const cs = getComputedStyle(c);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1 || c.getAttribute('aria-hidden') === 'true') continue;
          walk(c);
        }
      }
    };
    walk(node);
    return out.join(' ').replace(/\s+/g, ' ').trim();
  };
  const t0 = performance.now();
  const seen = [{ t: 0, text: visibleText(el) }];
  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now() - t0;
      const text = visibleText(el);
      if (text !== seen[seen.length - 1].text) seen.push({ t: Math.round(now), text });
      const quiet = now - seen[seen.length - 1].t > quietMs;
      if (now > ms || seen.length >= want || (seen.length < 2 && quiet)) resolve();
      else setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
  return seen;
}

/**
 * Does the area move on by itself (a carousel on a timer)? A fresh first visit with the page's timers running: the area is
 * read twice a second for up to ~13 s and each reading matched to a captured state. Two steps or more give the interval and
 * the direction; nothing in the first 7 s = no autoplay. Returns { ms, step } or null.
 */
async function watchAutoplay(page, url, area, states) {
  const browser = page.context().browser();
  if (!browser) return null;
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const context = await browser.newContext({ viewport: page.viewportSize(), userAgent, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  try {
    const fresh = await context.newPage();
    await fresh.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await fresh.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    await fresh.evaluate(revealArea, area).catch(() => {});
    // The area's visible text, read inside the page every 100 ms with the page's own clock: the change times are exact,
    // whatever the load on this machine (a snapshot per reading from here took up to half a second).
    const changes = await fresh.evaluate(watchText, { p: area, ms: 13000, quietMs: 7000, want: 4 }).catch(() => []);
    const seen = [];
    for (const c of changes) {
      const k = closestByText({ tag: 'div', children: [{ text: c.text }] }, states);
      if (k >= 0 && (!seen.length || seen[seen.length - 1].k !== k)) seen.push({ k, t: c.t });
    }
    if (seen.length < 3) return null; // the first reading plus at least two steps
    const n = states.length;
    const steps = seen.slice(1).map((s, i) => ((s.k - seen[i].k + n) % n));
    const step = steps.every((s) => s === 1) ? 1 : steps.every((s) => s === n - 1) ? -1 : null;
    if (!step) return null;
    const gaps = seen.slice(2).map((s, i) => s.t - seen[i + 1].t).sort((a, b) => a - b);
    return { ms: Math.round(gaps[Math.floor(gaps.length / 2)] / 100) * 100, step };
  } finally {
    await context.close().catch(() => {});
  }
}

/** The words of the visible text of a snapshot subtree. */
function visibleWords(node) {
  const words = [];
  const walk = (n) => {
    if (!n) return;
    if ('text' in n) {
      words.push(...n.text.toLowerCase().split(/\s+/).filter(Boolean));
      return;
    }
    if (n.hidden || n.style?.display === 'none' || n.style?.visibility === 'hidden' || n.style?.opacity === '0') return;
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return words;
}

/** Index of the state whose visible text matches `node`'s best (word overlap ≥ 90 %), or -1. */
export function closestByText(node, states) {
  const a = visibleWords(node);
  let best = -1;
  let score = 0.9;
  states.forEach((s, i) => {
    const b = visibleWords(s);
    const pool = new Map();
    for (const w of b) pool.set(w, (pool.get(w) ?? 0) + 1);
    let common = 0;
    for (const w of a) {
      if (pool.get(w) > 0) {
        common++;
        pool.set(w, pool.get(w) - 1);
      }
    }
    const dice = a.length + b.length ? (2 * common) / (a.length + b.length) : 0;
    if (dice > score) {
      score = dice;
      best = i;
    }
  });
  return best;
}

/**
 * The groups worth capturing: equal controls that switch content (tabs, dots, chips), with the next / previous controls
 * that act on the same content. Paths that change on their own (`noise`) are not evidence.
 */
export function planSets(widgets, noise = []) {
  const quiet = (p) => !noise.some((n) => p === n || p.startsWith(`${n}>`));
  // A fixed element a click shows is a notice (capture/notices.js), not switched content.
  const changedBy = (w) => [...(w.change?.shown ?? []), ...(w.change?.hidden ?? []), ...(w.change?.added ?? [])].filter((x) => !x.fixed).map((x) => x.path).filter(quiet);
  // Panels the same click does not close again (tabs, category chips) switch content too.
  const switching = widgets.filter((w) => w.opensOn === 'click' && (w.kind === 'tabs' || w.kind === 'carousel' || (w.kind === 'disclosure' && !w.closes)));
  const sets = new Map();
  const navs = [];
  for (const w of switching) {
    // One control is enough here: the selected tab often looks different from the others, so its row (rowControls, in the
    // page) supplies the rest; a set needs two controls after that.
    const controls = (w.group?.paths?.length ? w.group.paths : [w.trigger]).slice(0, MAX_CONTROLS);
    // Tabs, chips and dots switch content outside themselves (a panel, a grid, a slide). A change inside the clicked element
    // only (a card that expands) is that element's own panel, not a state of the page.
    const inside = (p) => [w.trigger, ...controls].some((c) => p === c || p.startsWith(`${c}>`));
    const changed = changedBy(w).filter((p) => !inside(p));
    if (!changed.length) continue;
    if (NAV.test(w.text ?? '') && !(w.group?.count > 2)) {
      navs.push({ path: w.trigger, changed });
      continue;
    }
    const key = w.group?.sig ?? w.trigger;
    const set = sets.get(key) ?? { controls: [...controls], changed: new Set(), nav: [], triggers: new Set() };
    changed.forEach((p) => set.changed.add(p));
    set.triggers.add(w.trigger);
    sets.set(key, set);
  }
  const parentOf = (p) => (p.includes('>') ? p.slice(0, p.lastIndexOf('>')) : null);
  // A control with the clicked ones' signature that lies inside what they switch (a button in a filtered section, on a
  // site without classes) belongs to that content, not to the row of controls: it would stretch the area over the page.
  for (const s of sets.values()) {
    const rows = new Set([...s.triggers].map(parentOf));
    s.controls = s.controls.filter((c) => rows.has(parentOf(c)) || ![...s.changed].some((p) => c.startsWith(`${p}>`)));
  }
  for (const n of navs) {
    const set = [...sets.values()].find((s) => n.changed.some((p) => [...s.changed].some((q) => related(p, q))));
    if (set) set.nav.push(n.path);
  }
  // Controls that are part of what another set switches (the cards a filter shows) are content, not a set of their own.
  const all = [...sets.values()];
  const isContent = (s) => all.some((t) => t !== s && s.controls.some((c) => [...t.changed].some((p) => c === p || c.startsWith(`${p}>`))));
  const out = [];
  for (const s of all.filter((x) => !isContent(x))) {
    // The area grows from the controls only until it holds something they changed: a change far away (anything the noise
    // read missed) cannot stretch it over the whole page.
    let area = commonPath(s.controls);
    while (area && ![...s.changed].some((p) => p.startsWith(`${area}>`))) area = parentOf(area);
    if (!area || area === 'body') continue;
    // Tabs whose content is a sibling section (the tabs in one section, the form they switch in the next): under a broad
    // common ancestor (main), only its children holding the controls or what they change are the area - up to three parts.
    let parts = [area];
    if (area.split('>').length < 3) {
      const childOf = (p) => (p.startsWith(`${area}>`) ? `${area}>${p.slice(area.length + 1).split('>')[0]}` : null);
      parts = [...new Set([...s.controls, ...s.changed, ...s.nav].map(childOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      // A tab that adds or removes whole sections shifts the ones after it: no fixed set of parts describes that. The whole
      // common area is then the area, each state a full copy of it: always with a few tabs (≤ 3), with more (a filter that
      // renders only the chosen category's section) while the copies stay small (weighed in captureStates).
      if (parts.length > 3 || parts.length < 2) parts = [area];
    }
    const weigh = parts.length === 1 && parts[0].split('>').length < 3 && s.controls.length > 3;
    const nav = s.nav.filter((p) => p.startsWith(`${area}>`));
    // Next / previous that act on the same content but sit just outside: the area takes them in.
    const outside = s.nav.filter((p) => !p.startsWith(`${area}>`));
    if (outside.length) {
      const wider = commonPath([area, ...outside]);
      if (wider && wider.split('>').length >= 3 && wider.split('>').length >= area.split('>').length - 2) {
        area = wider;
        nav.push(...outside);
      }
    }
    // The selected dot / tab often has a signature of its own: its set and the one of its equal neighbours (same row) are
    // one set. Another row on the same area is left out: one area switches by one row of controls.
    const same = out.find((o) => o.area === area);
    if (same && parentOf(same.controls[0]) !== parentOf(s.controls[0])) continue;
    if (same) {
      for (const c of s.controls) if (!same.controls.includes(c)) same.controls.push(c);
      for (const n of nav) if (!same.nav.includes(n)) same.nav.push(n);
      same.controls.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    } else out.push({ area, parts, controls: [...s.controls], nav, ...(weigh && { weigh }) });
  }
  // A button that adds content and takes it away again on the next click ("View more" / "View less", "Read more"): the
  // content does not exist before the click, so no open / closed styles can rebuild it. Two states of the part holding the
  // button and what it added, the button leading from each to the other.
  for (const w of widgets) {
    if (w.opensOn !== 'click' || w.kind !== 'disclosure' || w.closes !== 'toggle') continue;
    const added = (w.change?.added ?? []).filter((x) => !x.fixed && !x.inTrigger).map((x) => x.path).filter(quiet);
    if (!added.length || out.some((o) => o.controls.includes(w.trigger))) continue;
    const area = commonPath([w.trigger, ...added]);
    if (!area || area === 'body' || out.some((o) => o.area === area)) continue;
    out.push({ area, parts: [area], controls: [], nav: [], toggle: w.trigger, weigh: true });
  }
  return out;
}

/**
 * The window probes (vp: height, ty: typography, scrolled) of the page snapshot's elements, moved onto the same elements
 * (same place, tag and text) of a state that replaces them: states are snapshotted at the captured window only.
 */
function carryProbes(from, to) {
  const text = (n) => (!n ? '' : 'text' in n ? n.text : (n.children ?? []).map(text).join(' ')).replace(/\s+/g, ' ').trim();
  const walk = (a, b) => {
    if (!a || !b || 'text' in a || 'text' in b || a.tag !== b.tag) return;
    if (text(a) === text(b)) for (const k of ['vp', 'ty', 'scrolled']) if (a[k] && !b[k]) b[k] = a[k];
    const ka = (a.children ?? []).filter((c) => !('text' in c));
    const kb = (b.children ?? []).filter((c) => !('text' in c));
    ka.forEach((c, i) => walk(c, kb[i]));
  };
  walk(from, to);
}

const findNode = (body, p) => {
  let hit = null;
  const walk = (n) => {
    if (hit || !n || 'text' in n) return;
    if (n.path === p) hit = n;
    else if (p.startsWith(`${n.path}>`)) (n.children ?? []).forEach(walk);
  };
  walk(body);
  return hit;
};

/**
 * Clicks through the states of the switching controls of a page and stores them on the page snapshot (`body`).
 * Runs last on the desktop view (after captureClicks), because it changes the page.
 * @returns {Promise<{ sets: number, states: number, skipped: object[], ms: number, timedOut: boolean, cssUrls: string[] }>}
 */
export async function captureStates(page, clicks, body, { budgetMs = { min: 30000, max: 60000, perControl: 3000 } } = {}) {
  const started = Date.now();
  const startUrl = page.url();
  const stats = { sets: 0, states: 0, skipped: [], ms: 0, timedOut: false, cssUrls: [] };
  // What moves by itself was measured by the click probe (clicks.noise) and is never evidence.
  const plans = planSets(clicks?.widgets ?? [], clicks?.noise ?? []);
  if (!plans.length) return { ...stats, ms: Date.now() - started };
  // The limit follows the work: a few seconds per control to click, scroll through and snapshot, within bounds.
  const b = typeof budgetMs === 'number' ? { min: budgetMs, max: budgetMs, perControl: 0 } : budgetMs;
  const controls = plans.reduce((n, p) => n + Math.max(p.controls.length, 2) + p.nav.length, 0);
  const deadline = started + Math.min(b.max, Math.max(b.min, controls * b.perControl));
  const snapOne = async (area) => {
    await page.evaluate(revealArea, area).catch(() => {});
    const res = await page.evaluate(snapshotPage, { rootPath: area });
    for (const u of res?.cssUrls ?? []) stats.cssUrls.push(u);
    return res?.body ?? null;
  };
  // One area, or several sibling parts read as one (a virtual node whose children are the parts): signatures and text
  // matching then work the same.
  const asOne = (bodies) => (bodies.length === 1 ? bodies[0] : { tag: 'div', path: '#parts', children: bodies });
  const snap = async (plan) => {
    const bodies = [];
    for (const p of plan.parts) {
      const b = await snapOne(p);
      if (!b) return null;
      bodies.push(b);
    }
    return asOne(bodies);
  };
  const partsOf = (one, plan) => (plan.parts.length === 1 ? [one] : one.children);
  const settle = () => page.waitForTimeout(SETTLE_MS);

  for (const plan of plans) {
    if (Date.now() > deadline) {
      stats.timedOut = true;
      stats.skipped.push({ area: plan.area, reason: 'time' });
      continue;
    }
    plan.parts ??= [plan.area];
    const nodes = plan.parts.map((p) => findNode(body, p));
    if (nodes.some((n) => !n)) {
      stats.skipped.push({ area: plan.area, reason: 'not in the snapshot' });
      continue;
    }
    const node = asOne(nodes);
    // Puts the parts of a captured state in place of the page snapshot's (the copy starts with that state).
    const startWith = (one) => {
      partsOf(one, plan).forEach((b, i) => {
        const { path, ...rest } = b;
        carryProbes(nodes[i], rest);
        for (const k of Object.keys(nodes[i])) if (k !== 'path') delete nodes[i][k];
        Object.assign(nodes[i], rest);
      });
    };
    try {
      if (plan.toggle) {
        if (2 * countNodes(node) > MAX_STATE_NODES) throw new Error('too large to copy per state');
        const initialSig = stateSignature(node);
        if (!(await page.evaluate(clickPath, plan.toggle))) throw new Error('control gone');
        await settle();
        const open = await snap(plan);
        if (!open || stateSignature(open) === initialSig) throw new Error('the control does not change the content');
        await page.evaluate(clickPath, plan.toggle);
        await settle();
        if (stateSignature(await snap(plan)) !== initialSig) throw new Error('the second click does not undo the first');
        nodes[0].states = { initial: 0, count: 2, controls: [], nav: [{ rel: plan.toggle.slice(plan.area.length + 1), offset: 1 }], variants: [{ index: 1, body: open }] };
        stats.sets++;
        stats.states += 2;
        continue;
      }
      plan.controls = (await page.evaluate(rowControls, plan.controls)).slice(0, MAX_CONTROLS);
      if (plan.controls.length < 2) throw new Error('a single control');
      // Many controls over a whole broad area (a filter over sections): every state is a full copy, so only while small.
      if (plan.weigh && plan.controls.length * nodes.reduce((n, x) => n + countNodes(x), 0) > MAX_STATE_NODES) throw new Error('too large to copy per state');
      const initialSig = stateSignature(node);
      // A carousel that moves on a timer may have moved on since the page snapshot: the state it shows now, as a fallback.
      const nowSig = stateSignature(await snap(plan));
      const variants = [];
      let initial = -1;
      const sigs = [];
      for (let j = 0; j < plan.controls.length; j++) {
        if (Date.now() > deadline) throw Object.assign(new Error('time'), { time: true });
        if (!(await page.evaluate(clickPath, plan.controls[j]))) throw new Error('control gone');
        await settle();
        if (!samePage(page.url(), startUrl)) throw new Error('the page navigated');
        const state = await snap(plan);
        if (!state) throw new Error('area gone');
        const sig = stateSignature(state);
        sigs.push(sig);
        if (initial < 0 && sig === initialSig) initial = j;
        variants.push({ index: j, body: state });
      }
      if (initial < 0) {
        // The page snapshot caught the area between two states: the copy starts at the state it showed just now.
        initial = sigs.indexOf(nowSig);
        if (initial < 0) throw new Error('the first state matches no control');
        startWith(variants[initial].body);
      }
      if (new Set(sigs).size < 2) throw new Error('the controls do not change the content');
      // Next / previous: from the first state, which state does one click lead to?
      const nav = [];
      for (const p of plan.nav) {
        await page.evaluate(clickPath, plan.controls[initial]);
        await settle();
        await page.evaluate(clickPath, p);
        await settle();
        const reached = await snap(plan);
        let k = sigs.indexOf(stateSignature(reached));
        if (k < 0) k = closestByText(reached, variants.map((v) => v.body));
        const n = sigs.length;
        const offset = k < 0 ? 0 : ((k - initial + n + Math.floor(n / 2)) % n) - Math.floor(n / 2);
        if (offset) nav.push({ rel: p.slice(plan.area.length + 1), offset });
      }
      // Back to how the page started.
      await page.evaluate(clickPath, plan.controls[initial]).catch(() => {});
      await settle();
      // A carousel (it has next / previous) may advance on a timer, so the page snapshot can have caught it later than a
      // visitor first sees it: the copy starts at the state a first-time visitor sees right after the page loads.
      const loaded = nav.length && plan.parts.length === 1 ? await firstVisit(page, startUrl, plan.area).catch(() => null) : null;
      if (loaded) {
        let k = sigs.indexOf(stateSignature(loaded));
        // Right after load the area can differ in details from the same state reached by a click (which tile is marked):
        // the state with the same visible text then.
        if (k < 0) k = closestByText(loaded, variants.map((v) => v.body));
        if (k >= 0 && k !== initial && variants[k]?.body) {
          startWith(variants[k].body);
          initial = k;
        }
      }
      // A carousel that moves on by itself: how often and which way (the copy does the same).
      const autoplay = nav.length && plan.parts.length === 1 && Date.now() < deadline
        ? await watchAutoplay(page, startUrl, plan.area, variants.map((v) => v.body)).catch(() => null) : null;
      // Each part keeps its own states; parts of one area share the group (one set in the copy). Controls and next / previous
      // are named relative to the part that holds them (null where another part does).
      const group = plan.parts.length > 1 ? `${plan.area}#${plan.parts.length}` : null;
      plan.parts.forEach((part, pi) => {
        const rel = (p) => (p.startsWith(`${part}>`) ? p.slice(part.length + 1) : null);
        nodes[pi].states = {
          ...(group && { group }),
          initial,
          count: plan.controls.length,
          controls: plan.controls.map(rel),
          nav: nav.map((n) => ({ ...n, rel: rel(`${plan.area}>${n.rel}`) })).filter((n) => n.rel != null),
          ...(autoplay && pi === 0 && { autoplay }),
          variants: variants.filter((v) => v.index !== initial).map((v) => ({ index: v.index, body: partsOf(v.body, plan)[pi] })),
        };
      });
      stats.sets++;
      stats.states += plan.controls.length;
    } catch (err) {
      if (err.time) stats.timedOut = true;
      stats.skipped.push({ area: plan.area, reason: err.message });
    }
  }
  stats.ms = Date.now() - started;
  return stats;
}
