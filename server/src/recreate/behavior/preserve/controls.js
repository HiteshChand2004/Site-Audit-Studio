// Every button of a converted page works as it does on the original, once the original's framework code is taken out
// (runtimeFree.js). The rebuilt animations (rebuildMotion.js) cover the menus, panels and tabs the capture recorded; what a
// button's click did through the framework alone - a "Back to top" that scrolls up, a toggle the capture did not see, a panel
// the framework draws only while open - is measured here and replayed by the copy's own small script.
//
// Measured, not guessed, on the page itself: the as-is page runs the original's code in a local browser, so what each click
// does can be read there directly (what the capture of the live site might have missed included).
//   clicks  every visible control (button, summary, [aria-expanded], [role=button|tab]) is clicked: the attributes and text
//           that change on any element, the elements the click adds (their markup) or takes away, where the page scrolls to;
//           then clicked again: when that brings the page back, the control is a toggle. The same is read on the page without
//           the framework code; a control whose visible outcome differs (the text that appears or goes, the elements shown
//           or hidden, the scroll) gets the original's effect as a replay.
//   scroll  fixed and sticky elements (and <html>, <body>) are read at the top, further down and at the top again: an
//           attribute that changes going down and comes back going up (a class that shows a "Back to top" button) is a scroll
//           state; the scroll position where it changes is searched. Inline styles are left out (a scroll-linked transform
//           changes them continuously; the rebuilt animations handle those).
// The replay is data (one inert <script type="application/json">) and one fixed script (js/sas-controls.js); the elements it
// changes get a data-sas-c number. Markup a click adds is the original's own, with scripts and inline handlers taken out.
import * as cheerio from 'cheerio';
import { isolated, viewOf, openAndScroll } from './check.js';
import { elementAt } from './rebuildMotion.js';

export const CONTROLS_SELECTOR = 'button, summary, [aria-expanded], [role="tab"], [role="button"]';
/** Controls measured per page and width. */
export const MAX_CONTROLS = 40;
export const CONTROLS_FILE = 'js/sas-controls.js';
export const CONTROLS_DATA_ID = 'sas-controls';
const CLICK_WAIT_MS = 700;

// ---------------------------------------------------------------------------------------------------------------- in the page
// One function, sent to the page once (window.__sasCtl): the path rule is the capture's (tag:n among element siblings with
// that tag, page-structure tags skipped), so a path names the same element as in the capture and in the lifted page.
function install() {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const IGNORED = /^(src|srcset|sizes|loading|decoding|fetchpriority|data-sas-.*|style)$/;
  const pathOf = (el) => {
    if (el === document.documentElement) return 'html';
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) { parts.push('body'); break; }
      let i = 0;
      for (const s of n.parentElement ? n.parentElement.children : []) {
        if (SKIP.has(s.tagName)) continue;
        if (s.tagName === n.tagName) i++;
        if (s === n) break;
      }
      parts.push(`${n.tagName.toLowerCase()}:${i}`);
    }
    return parts.reverse().join('>');
  };
  const attrsOf = (el, withStyle) => {
    const out = {};
    for (const a of el.attributes) if (!IGNORED.test(a.name) || (withStyle && a.name === 'style')) out[a.name] = a.value;
    return out;
  };
  const ownText = (el) => (el.childNodes.length && [...el.childNodes].every((c) => c.nodeType === 3) ? el.textContent : null);
  const snapshot = ({ withStyle = true, only = null } = {}) => {
    const map = new Map();
    const els = only ?? [document.documentElement, document.body, ...document.body.querySelectorAll('*')];
    for (const el of els) {
      if (SKIP.has(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      const seen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      map.set(el, { path: pathOf(el), attrs: attrsOf(el, withStyle), text: ownText(el), seen });
    }
    return map;
  };
  const clean = (el) => {
    const c = el.cloneNode(true);
    for (const s of c.querySelectorAll('script')) s.remove();
    for (const n of [c, ...c.querySelectorAll('*')]) for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
    return c.outerHTML;
  };
  const diff = (before, after) => {
    const attrs = [];
    const text = [];
    const add = [];
    const remove = [];
    for (const [el, b] of before) {
      const a = after.get(el);
      if (!a) {
        if (el.parentElement && after.has(el.parentElement)) remove.push(b.path);
        continue;
      }
      for (const name of new Set([...Object.keys(b.attrs), ...Object.keys(a.attrs)])) {
        if (b.attrs[name] !== a.attrs[name]) attrs.push({ path: b.path, name, from: b.attrs[name] ?? null, to: a.attrs[name] ?? null, seen: b.seen || a.seen, both: b.seen && a.seen });
      }
      if (b.text !== a.text && b.text != null && a.text != null) text.push({ path: b.path, from: b.text, to: a.text });
    }
    for (const [el] of after) {
      if (before.has(el) || !el.parentElement || !before.has(el.parentElement)) continue;
      const index = [...el.parentElement.children].indexOf(el);
      add.push({ parent: pathOf(el.parentElement), index, html: clean(el) });
    }
    return { attrs, text, add, remove };
  };
  const shown = () => {
    const out = new Set();
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
      out.add(pathOf(el));
    }
    return out;
  };
  const isFixed = (el) => { const p = getComputedStyle(el).position; return p === 'fixed' || p === 'sticky'; };
  window.__sasCtl = { pathOf, snapshot, diff, shown, isFixed, controls: () => [...document.querySelectorAll('button, summary, [aria-expanded], [role="tab"], [role="button"]')] };
}

// ---------------------------------------------------------------------------------------------------------------- measuring
/** Waits until the page stops scrolling (a smooth scroll a click started), at most a few seconds. */
async function settleScroll(page, { maxMs = 3000 } = {}) {
  await page.evaluate(async (max) => {
    const end = Date.now() + max;
    let last = scrollY;
    let still = 0;
    while (Date.now() < end && still < 3) {
      await new Promise((r) => setTimeout(r, 100));
      if (Math.abs(scrollY - last) < 1) still++;
      else { still = 0; last = scrollY; }
    }
  }, maxMs).catch(() => {});
}
const lines = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
/** Lines of text added and removed between two readings (each line counted once per occurrence). */
function textDelta(before, after) {
  const left = lines(before);
  const added = lines(after).filter((l) => { const i = left.indexOf(l); if (i < 0) return true; left.splice(i, 1); return false; });
  return { added, removed: left };
}

/**
 * What every control of the page does when clicked, at one width (see the head of this file).
 * @returns {Promise<{ width: number, controls: object[], errors: string[] }>}
 */
export async function probeControls(browser, base, pagePath, width, { max = MAX_CONTROLS } = {}) {
  const errors = [];
  const context = await isolated(browser, viewOf(width), base, []);
  await context.addInitScript(install);
  const url = `${base}${pagePath}`;
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    const open = async () => {
      await openAndScroll(page, url);
      await page.waitForTimeout(600);
      // Halfway down: a control that appears only once the page is scrolled ("Back to top") is there to be clicked.
      await page.evaluate(() => window.scrollTo({ top: Math.round((document.documentElement.scrollHeight - innerHeight) / 2), behavior: 'instant' }));
      await page.waitForTimeout(700);
    };
    await open();
    // What changes by itself (a demo that plays, a feed, a rotating headline) is not a click's doing: read over a few seconds
    // with nothing clicked, and left out of every click's reading.
    const noise = await page.evaluate(async (wait) => {
      const c = window.__sasCtl;
      const paths = new Set();
      const texts = new Set();
      const lines = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean);
      let prev = c.snapshot();
      let prevLines = new Set(lines(document.body.innerText));
      for (let k = 0; k < 3; k++) {
        await new Promise((r) => setTimeout(r, wait));
        const now = c.snapshot();
        const d = c.diff(prev, now);
        for (const a of d.attrs) paths.add(a.path);
        for (const t of d.text) paths.add(t.path);
        for (const a of d.add) paths.add(a.parent);
        for (const r of d.remove) paths.add(r);
        const nowLines = new Set(lines(document.body.innerText));
        for (const l of nowLines) if (!prevLines.has(l)) texts.add(l);
        for (const l of prevLines) if (!nowLines.has(l)) texts.add(l);
        prev = now;
        prevLines = nowLines;
      }
      // What scrolling alone changes (a section marked as in view, a header that changes once scrolled): read going to the
      // top and back, by element and attribute, so a click that scrolls is not credited with it.
      const scrolled = new Set();
      const y0 = scrollY;
      for (const y of [0, y0]) {
        const before = c.snapshot();
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise((r) => setTimeout(r, wait));
        for (const a of c.diff(before, c.snapshot()).attrs) scrolled.add(`${a.path}|${a.name}`);
      }
      return { paths: [...paths], texts: [...texts], scrolled: [...scrolled] };
    }, CLICK_WAIT_MS);
    const byScroll = new Set(noise.scrolled);
    const noisy = (p) => noise.paths.some((n) => p === n || p.startsWith(`${n}>`));
    // A style that only moves or scales something, or sets custom properties, follows the scroll or the pointer (a progress
    // bar, a parallax): not what the click did, and the rebuilt animations drive it.
    const MOVES_ONLY = /^\s*((transform|translate|scale|rotate|--[\w-]+)\s*:[^;]*;?\s*)*$/;
    const moveOnly = (a) => a.name === 'style' && MOVES_ONLY.test(a.from ?? '') && MOVES_ONLY.test(a.to ?? '');
    // An element off screen before and after the click, outside the control and not <html> / <body>: what changed there is
    // the page's own bookkeeping (a section marked out of view), not what the visitor's click does.
    const related = (p, control) => p === 'html' || p === 'body' || p.startsWith(control) || control.startsWith(`${p}>`);
    // When the click scrolled the page, an element that came into or left the view did so because of the scroll.
    const quiet = (change, control = '', moved = false) => ({
      attrs: change.attrs.filter((a) => !noisy(a.path) && !moveOnly(a) && !byScroll.has(`${a.path}|${a.name}`) && ((moved ? a.both : a.seen) || related(a.path, control))).map(({ seen, both, ...a }) => a),
      text: change.text.filter((t) => !noisy(t.path)),
      add: change.add.filter((a) => !noisy(a.parent)),
      remove: change.remove.filter((r) => !noisy(r)),
    });
    const noiseTexts = new Set(noise.texts);
    const paths = await page.evaluate((m) => window.__sasCtl.controls().slice(0, m).map((el) => window.__sasCtl.pathOf(el)), max);
    const out = [];
    let dirty = false;
    for (const path of paths) {
      if (dirty) { await open(); dirty = false; }
      const handle = await page.evaluateHandle((p) => window.__sasCtl.controls().find((el) => window.__sasCtl.pathOf(el) === p) ?? null, path);
      let el = handle.asElement();
      // A control shown only further down the page ("Back to top" once scrolled): looked for halfway down and at the end.
      for (const at of ['middle', 'end']) {
        if (!el || (await el.isVisible().catch(() => false))) break;
        await page.evaluate((w) => window.scrollTo({ top: w === 'end' ? document.documentElement.scrollHeight : Math.round((document.documentElement.scrollHeight - innerHeight) / 2), behavior: 'instant' }), at);
        await page.waitForTimeout(500);
      }
      if (!el || !(await el.isVisible().catch(() => false))) { out.push({ path, shown: false }); continue; }
      const label = ((await el.getAttribute('aria-label').catch(() => null)) || (await el.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(200);
      const read = () => page.evaluate(() => ({ y: Math.round(scrollY), url: location.pathname, text: document.body.innerText, shown: [...window.__sasCtl.shown()] }));
      await page.evaluate(() => { window.__sasBefore = window.__sasCtl.snapshot(); });
      const r0 = await read();
      await el.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(CLICK_WAIT_MS);
      await settleScroll(page);
      const r1 = await read().catch(() => null);
      if (!r1 || r1.url !== r0.url) { out.push({ path, label, shown: true, navigates: true }); dirty = true; continue; }
      const change = quiet(await page.evaluate(() => window.__sasCtl.diff(window.__sasBefore, window.__sasCtl.snapshot())), path, Math.abs(r1.y - r0.y) > 100);
      // The second click: back where the page started = a toggle.
      await page.evaluate(() => { window.__sasAfter1 = window.__sasCtl.snapshot(); });
      const again = await page.evaluateHandle((p) => window.__sasCtl.controls().find((x) => window.__sasCtl.pathOf(x) === p) ?? null, path);
      let toggle = false;
      let second = null;
      if (again.asElement() && (await again.asElement().isVisible().catch(() => false))) {
        await again.asElement().click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(CLICK_WAIT_MS);
        await settleScroll(page);
        const back = quiet(await page.evaluate(() => window.__sasCtl.diff(window.__sasBefore, window.__sasCtl.snapshot())), path);
        // What the second click itself changed: a switch that goes dark → light (not back to "no theme") alternates two steps.
        second = quiet(await page.evaluate(() => window.__sasCtl.diff(window.__sasAfter1, window.__sasCtl.snapshot())), path);
        // A toggle: what the first click changed is back as it was (whatever else moved meanwhile).
        const still = new Set([...back.attrs.map((a) => `a|${a.path}|${a.name}`), ...back.text.map((t) => `t|${t.path}`), ...back.add.map((a) => `+|${a.parent}`), ...back.remove.map((r) => `-|${r}`)]);
        const first = [...change.attrs.map((a) => `a|${a.path}|${a.name}`), ...change.text.map((t) => `t|${t.path}`), ...change.add.map((a) => `+|${a.parent}`), ...change.remove.map((r) => `-|${r}`)];
        toggle = first.length > 0 && first.every((k) => !still.has(k));
        dirty = !toggle;
      } else dirty = true;
      const shownBefore = new Set(r0.shown);
      const shownAfter = new Set(r1.shown);
      const scroll = r0.y > 200 && r1.y < 5 ? 'top' : Math.abs(r1.y - r0.y) > 100 ? { y: r1.y } : null;
      out.push({
        path, label, shown: true, toggle, scroll, change, ...(second && !toggle && (second.attrs.length || second.text.length) && { second: { attrs: second.attrs, text: second.text } }),
        outcome: {
          text: (({ added, removed }) => ({ added: added.filter((l) => !noiseTexts.has(l)), removed: removed.filter((l) => !noiseTexts.has(l)) }))(textDelta(r0.text, r1.text)),
          appeared: r1.shown.filter((p) => !shownBefore.has(p) && !noisy(p)).length,
          vanished: r0.shown.filter((p) => !shownAfter.has(p) && !noisy(p)).length,
          scroll: scroll === 'top' ? 'top' : scroll ? 'moved' : null,
        },
      });
    }
    return { width, controls: out, errors };
  } finally {
    await context.close();
  }
}

/**
 * The scroll states of the page at one width: attributes of fixed / sticky elements (and <html>, <body>) that change going
 * down and come back going up, with the scroll position where they change.
 */
export async function probeScrollStates(browser, base, pagePath, width) {
  const context = await isolated(browser, viewOf(width), base, []);
  await context.addInitScript(install);
  try {
    const page = await context.newPage();
    await openAndScroll(page, `${base}${pagePath}`);
    await page.waitForTimeout(600);
    const far = await page.evaluate(() => Math.min(1500, Math.max(0, document.documentElement.scrollHeight - innerHeight)));
    if (far < 50) return { width, states: [] };
    const at = async (y) => {
      await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), y);
      await page.waitForTimeout(450);
    };
    await at(0);
    await page.evaluate(() => {
      const c = window.__sasCtl;
      window.__sasFixed = [document.documentElement, document.body, ...[...document.body.querySelectorAll('*')].filter((el) => c.isFixed(el))];
      window.__sasTop = c.snapshot({ withStyle: false, only: window.__sasFixed });
    });
    await at(far);
    const down = await page.evaluate(() => window.__sasCtl.diff(window.__sasTop, window.__sasCtl.snapshot({ withStyle: false, only: window.__sasFixed })));
    if (!down.attrs.length) return { width, states: [] };
    await at(0);
    const up = await page.evaluate(() => window.__sasCtl.diff(window.__sasTop, window.__sasCtl.snapshot({ withStyle: false, only: window.__sasFixed })));
    const stays = new Set(up.attrs.map((a) => `${a.path}|${a.name}`));
    const flips = down.attrs.filter((a) => !stays.has(`${a.path}|${a.name}`));
    // Where each one changes: halving the range until it is known within ~10 px.
    const states = [];
    for (const f of flips.slice(0, 12)) {
      let lo = 0;
      let hi = far;
      while (hi - lo > 10) {
        const mid = Math.round((lo + hi) / 2);
        await at(mid);
        const v = await page.evaluate(({ path, name }) => {
          const el = window.__sasFixed.find((e) => window.__sasCtl.pathOf(e) === path);
          return el ? el.getAttribute(name) : null;
        }, f);
        if (v === f.to) hi = mid;
        else lo = mid;
      }
      states.push({ ...f, at: hi });
    }
    return { width, states };
  } finally {
    await context.close();
  }
}

/** Does a control's click end the same way on both sides (what a visitor sees: text, what shows or goes, the scroll)? */
export function sameOutcome(a, b) {
  if (!a?.shown || !b?.shown) return false;
  if (a.navigates || b.navigates) return Boolean(a.navigates) === Boolean(b.navigates);
  const o = a.outcome;
  const p = b.outcome;
  // A scroll counts when it goes to the top ("Back to top"); a few hundred px of the browser bringing a control into view do not.
  return JSON.stringify(o.text) === JSON.stringify(p.text) && (o.scroll === 'top') === (p.scroll === 'top')
    && Math.sign(o.appeared) === Math.sign(p.appeared) && Math.sign(o.vanished) === Math.sign(p.vanished);
}

/**
 * What the original's click does that the copy's own click (the browser's, or the rebuilt animations') does not: a replay
 * never repeats what already happens, so an FAQ the browser opens is not opened a second time (which would close it).
 */
export function missingChange(orig, free) {
  const has = new Set([
    ...(free?.change?.attrs ?? []).map((a) => `a|${a.path}|${a.name}|${a.to}`),
    ...(free?.change?.text ?? []).map((t) => `t|${t.path}|${t.to}`),
    ...(free?.change?.add ?? []).map((a) => `+|${a.parent}|${a.index}`),
    ...(free?.change?.remove ?? []).map((r) => `-|${r}`),
  ]);
  return {
    attrs: orig.change.attrs.filter((a) => !has.has(`a|${a.path}|${a.name}|${a.to}`)),
    text: orig.change.text.filter((t) => !has.has(`t|${t.path}|${t.to}`)),
    add: orig.change.add.filter((a) => !has.has(`+|${a.parent}|${a.index}`)),
    remove: orig.change.remove.filter((r) => !has.has(`-|${r}`)),
    scroll: orig.scroll === 'top' && free?.outcome?.scroll !== 'top' ? 'top' : null,
  };
}

/**
 * The replay of a page: the original's click effects for every control whose outcome differs without the framework code, and
 * the scroll states the page without it does not have. Readings are by width (the narrow layout's controls included).
 * @param {{ asIs: object[], free: object[] }} clicks  probeControls results per width, both sides
 * @param {{ asIs: object[], free: object[] }} scroll  probeScrollStates results per width, both sides
 */
export function planReplay(clicks, scroll) {
  const controls = new Map();
  const differs = [];
  for (const [i, asIs] of clicks.asIs.entries()) {
    const free = new Map((clicks.free[i]?.controls ?? []).map((c) => [c.path, c]));
    for (const c of asIs.controls) {
      if (!c.shown || c.navigates || controls.has(c.path)) continue;
      const f = free.get(c.path);
      // Replayed when the click ends differently, or when it changes something the copy's click does not (a theme switch
      // changes only colours: no text, nothing shown or hidden, no scroll).
      const missing = missingChange(c, f?.shown ? f : null);
      if (sameOutcome(c, f) && !missing.attrs.length && !missing.text.length && !missing.add.length && !missing.remove.length) continue;
      if (!missing.attrs.length && !missing.text.length && !missing.add.length && !missing.remove.length && !missing.scroll) continue;
      differs.push({ path: c.path, label: c.label, width: asIs.width });
      // A switch between two looks: the second click's own change, as the original makes it, alternates with the first.
      const second = !c.toggle && c.second ? { attrs: c.second.attrs.filter((a) => missing.attrs.some((m) => m.path === a.path && m.name === a.name)), text: c.second.text.filter((t) => missing.text.some((m) => m.path === t.path)) } : null;
      controls.set(c.path, { path: c.path, label: c.label, toggle: c.toggle, ...missing, ...(second && (second.attrs.length || second.text.length) && { second }) });
    }
  }
  const states = [];
  const seen = new Set();
  for (const [i, asIs] of scroll.asIs.entries()) {
    const freeKeys = new Set((scroll.free[i]?.states ?? []).map((s) => `${s.path}|${s.name}|${s.to}`));
    for (const s of asIs.states) {
      const key = `${s.path}|${s.name}|${s.to}`;
      if (freeKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      states.push({ ...s, width: asIs.width });
    }
  }
  return { controls: [...controls.values()], scroll: states, differs };
}

// ---------------------------------------------------------------------------------------------------------------- the page
/**
 * The page with its replay: every element the replay touches numbered (data-sas-c), each replayed control marked
 * (data-sas-ctl), the data in one inert script, the fixed script loaded. Parts whose element is not on the page are counted.
 */
export function withReplay(html, plan, { scriptSrc = `/${CONTROLS_FILE}` } = {}) {
  if (!plan.controls.length && !plan.scroll.length) return { html, controls: 0, scroll: 0, lost: 0 };
  const $ = cheerio.load(html);
  if ($(`#${CONTROLS_DATA_ID}`).length) return { html, controls: 0, scroll: 0, lost: 0, already: true };
  const ids = new Map();
  let lost = 0;
  const idOf = (path) => {
    if (path === 'html' || path === 'body') return path;
    if (ids.has(path)) return ids.get(path);
    const el = elementAt($, path);
    if (!el) return null;
    const id = String(ids.size + 1);
    $(el).attr('data-sas-c', id);
    ids.set(path, id);
    return id;
  };
  const map = (list, key = 'path') => list.map((x) => ({ ...x, el: idOf(x[key]) })).filter((x) => x.el != null);
  const controls = [];
  for (const c of plan.controls) {
    const ctl = idOf(c.path);
    if (!ctl || ctl === 'html' || ctl === 'body') { lost++; continue; }
    $(`[data-sas-c="${ctl}"]`).attr('data-sas-ctl', String(controls.length));
    const attrs = map(c.attrs).map(({ path, el, name, from, to }) => ({ el, name, from, to }));
    const text = map(c.text).map(({ el, from, to }) => ({ el, from, to }));
    const add = c.add.map((a) => ({ parent: idOf(a.parent), index: a.index, html: a.html })).filter((a) => a.parent);
    const remove = c.remove.map((p) => idOf(p)).filter(Boolean);
    const second = c.second ? { attrs: map(c.second.attrs).map(({ el, name, from, to }) => ({ el, name, from, to })), text: map(c.second.text).map(({ el, from, to }) => ({ el, from, to })) } : null;
    controls.push({ toggle: c.toggle, scroll: c.scroll === 'top' ? 'top' : c.scroll?.y ?? null, attrs, text, add, remove, ...(second && { second }) });
  }
  const scroll = map(plan.scroll).map(({ el, name, from, to, at, width }) => ({ el, name, from, to, at, narrow: width < 600 }));
  const data = JSON.stringify({ controls, scroll }).replace(/</g, '\\u003c');
  $('body').append(`<script type="application/json" id="${CONTROLS_DATA_ID}">${data}</script><script src="${scriptSrc}" defer></script>`);
  return { html: $.html(), controls: controls.length, scroll: scroll.length, lost };
}

/** The fixed script that plays a page's replay (no data of its own; nothing happens on a page without the data). */
export const CONTROLS_JS = `(function () {
  var d = document.getElementById(${JSON.stringify(CONTROLS_DATA_ID)});
  if (!d) return;
  var spec;
  try { spec = JSON.parse(d.textContent); } catch (e) { return; }
  var style = document.createElement('style');
  style.textContent = '[data-sas-removed]{display:none!important}';
  document.head.appendChild(style);
  function el(id) { return id === 'html' ? document.documentElement : id === 'body' ? document.body : document.querySelector('[data-sas-c="' + id + '"]'); }
  function set(e, name, v) { if (!e) return; if (v === null || v === undefined) e.removeAttribute(name); else e.setAttribute(name, v); }
  function apply(c, k, on) {
    (c.attrs || []).forEach(function (a) { set(el(a.el), a.name, on ? a.to : a.from); });
    (c.text || []).forEach(function (t) { var e = el(t.el); if (e) e.textContent = on ? t.to : t.from; });
    (c.add || []).forEach(function (a, i) {
      var p = el(a.parent); if (!p) return;
      var key = k + '-' + i;
      var had = p.querySelector(':scope > [data-sas-added="' + key + '"]');
      if (!on) { if (had) had.remove(); return; }
      if (had) return;
      var t = document.createElement('template'); t.innerHTML = a.html;
      var n = t.content.firstElementChild; if (!n) return;
      n.setAttribute('data-sas-added', key);
      p.insertBefore(n, p.children[a.index] || null);
    });
    (c.remove || []).forEach(function (id) { var e = el(id); if (!e) return; if (on) e.setAttribute('data-sas-removed', ''); else e.removeAttribute('data-sas-removed'); });
    if (on && c.scroll === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
    else if (on && typeof c.scroll === 'number') window.scrollTo({ top: c.scroll, behavior: 'smooth' });
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-sas-ctl]');
    if (!t) return;
    var k = t.getAttribute('data-sas-ctl');
    var c = spec.controls[Number(k)];
    if (!c) return;
    var on = t.hasAttribute('data-sas-on');
    if (c.toggle && on) { apply(c, k, false); t.removeAttribute('data-sas-on'); }
    else if (c.second && on) { apply({ add: c.add, remove: c.remove }, k, false); apply(c.second, k + 'b', true); t.removeAttribute('data-sas-on'); }
    else { apply(c, k, true); if (c.toggle || c.second) t.setAttribute('data-sas-on', ''); }
  });
  var states = spec.scroll || [];
  if (!states.length) return;
  var narrow = window.matchMedia('(max-width: 599px)');
  var done = {};
  function scrolled() {
    var y = window.scrollY;
    states.forEach(function (s, i) {
      if (Boolean(s.narrow) !== narrow.matches && states.some(function (o) { return o.el === s.el && o.name === s.name && Boolean(o.narrow) === narrow.matches; })) return;
      var on = y >= s.at;
      if (done[i] === on) return;
      done[i] = on;
      set(el(s.el), s.name, on ? s.to : s.from);
    });
  }
  var queued = false;
  window.addEventListener('scroll', function () { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; scrolled(); }); }, { passive: true });
  scrolled();
})();
`;
