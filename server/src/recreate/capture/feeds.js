// Parts of a page that change by themselves: a feed whose script adds a row every second, a ticker of numbers, a list
// whose highlighted item moves on, a block of text that is rewritten on a timer. None of them has a control, so the state
// probe (capture/states.js) never looks at them - it even treats them as noise - and none of them moves by a transform
// or an opacity a loop recording could see (capture/loops.js): the page inserts, removes or rewrites elements. Without
// this probe the copy kept the one moment the snapshot happened to catch, and stood still.
//
// The page is watched with the mouse away and nothing scrolled (a MutationObserver: elements added or removed, text
// rewritten, classes switched). Where it changes on its own again and again at a steady pace, the smallest element
// holding the changes is the area; its pace is measured, and the area is snapshotted after each of the next updates once
// its own entrance animations have finished (snapshot.js with `rootPath`, which in an exact capture also keeps the markup
// of that state). The result is a set of states the copy cycles through on the same interval - the same `node.states`
// with `autoplay` a carousel that moves on by itself gets, marked `feed` - so ir/states.js, ir/asis.js and js/motion.js
// rebuild it with the machinery they already have, in every stack, with no script of the original.
//
// What it cannot be: live. The copy replays the updates it saw, in order, and starts over after the last one (or exactly
// where the original came back to its first state, when it did). That is reported (`cycle`).
//
// Page functions below are self-contained (Playwright sends only their source).
import { snapshotPage } from './snapshot.js';

/** How long the page is watched for updates; a page where something changes is watched longer, to measure the pace. */
export const WATCH_MS = 4000;
export const WATCH_MORE_MS = 5000;
/** Updates closer together than this belong to one update (a row added and an old one removed in the same tick). */
export const BURST_GAP_MS = 120;
/** The fastest pace rebuilt as states: anything quicker is typing or a count-up, which a set of states cannot be. */
export const MIN_INTERVAL_MS = 250;
/** The most states recorded per area, and the most areas per page. */
export const MAX_STATES = 8;
export const MAX_AREAS = 4;

/**
 * Page function: watches the page for `ms` (more when something changed early) and returns the areas that changed
 * by themselves, each with the times of its updates (ms since the start), grouped into bursts.
 * @returns {{ areas: { path: string, times: number[], kinds: object, nodes: number }[], watchedMs: number }}
 */
export async function watchMutations({ ms, moreMs, burstGap, skip = [] }) {
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
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
  const started = performance.now();
  const hits = new Map(); // element -> { times, kinds }
  const note = (el, kind) => {
    if (!el || el.nodeType !== 1 || SKIP_TAGS.has(el.tagName) || el === document.body || el === document.documentElement) return;
    const h = hits.get(el) ?? { times: [], kinds: {} };
    h.times.push(performance.now() - started);
    h.kinds[kind] = (h.kinds[kind] ?? 0) + 1;
    hits.set(el, h);
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        // An element added or removed: the list it belongs to changed. Text-only nodes count as the text changing.
        const added = [...r.addedNodes, ...r.removedNodes];
        if (added.some((n) => n.nodeType === 1 && !SKIP_TAGS.has(n.tagName))) note(r.target, 'children');
        else if (added.some((n) => n.nodeType === 3 && n.textContent.trim())) note(r.target, 'text');
      } else if (r.type === 'characterData') note(r.target.parentElement, 'text');
      // A class switching: the highlighted item moves among its siblings. `hidden` switching: one of several versions of
      // a part is shown in turn (what a copy's own states do, so the re-audit measures a copy the same way).
      else if (r.type === 'attributes') {
        if (r.attributeName === 'hidden') note(r.target, 'shown');
        else note(r.target.parentElement, 'class');
      }
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  await new Promise((r) => setTimeout(r, ms));
  let watched = ms;
  if (hits.size) {
    await new Promise((r) => setTimeout(r, moreMs));
    watched += moreMs;
  }
  observer.disconnect();

  // One area per group of changes: the outermost changed element holding the others (a list whose rows also change
  // inside). A page that re-renders a large part of itself is not a feed: an area must stay small.
  const els = [...hits.keys()].filter((el) => el.isConnected);
  const tops = els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
  const pageArea = Math.max(1, document.documentElement.scrollWidth * document.documentElement.scrollHeight);
  // Versions of one part shown in turn (siblings of the same tag and class whose `hidden` switches) are one area wherever
  // they stand - even straight under <body>, which is never an area itself.
  const groups = new Map();
  for (const top of tops) {
    const shownOnly = Object.keys(hits.get(top).kinds).every((k) => k === 'shown');
    const key = shownOnly && top.parentElement ? `${pathOf(top.parentElement)}|${top.tagName}|${top.className}` : top;
    groups.set(key, [...(groups.get(key) ?? []), top]);
  }
  const areas = [];
  for (const members of groups.values()) {
    const top = members.find((m) => !m.hidden) ?? members[0];
    const path = pathOf(members[0]);
    if (!path || skip.some((p) => path === p || path.startsWith(`${p}>`) || p.startsWith(`${path}>`))) continue;
    const r = top.getBoundingClientRect();
    const nodes = top.getElementsByTagName('*').length;
    if (r.width < 8 || r.height < 8 || nodes > 3000 || (r.width * r.height) / pageArea > 0.5) continue;
    const times = [];
    const kinds = {};
    for (const el of els) {
      if (!members.some((m) => m.contains(el))) continue;
      times.push(...hits.get(el).times);
      for (const [k, n] of Object.entries(hits.get(el).kinds)) kinds[k] = (kinds[k] ?? 0) + n;
    }
    times.sort((a, b) => a - b);
    // Bursts: changes that come together are one update.
    const bursts = [];
    for (const t of times) if (!bursts.length || t - bursts[bursts.length - 1].end > burstGap) bursts.push({ start: t, end: t });
    else bursts[bursts.length - 1].end = t;
    areas.push({ path, times: bursts.map((b) => Math.round(b.start)), kinds, nodes, rect: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)] });
  }
  return { areas, watchedMs: watched };
}

/**
 * Page function: waits for the next update of the area at `path` and for it to settle (no further change for a moment,
 * its own entrance animations finished), then returns when that happened (on the page's own clock, so the times of
 * several calls compare), the area's visible text, and whether elements it already showed (same tag and text) played an
 * entrance too (`replayed`: a list re-rendered whole, each row coming in again) or only the new ones did.
 * @returns {Promise<{ t: number, text: string, replayed: boolean } | null>}  null when no update came in time
 */
export async function nextUpdate({ path, timeoutMs, quietMs, burstGap }) {
  let el = document.body;
  for (const part of path.split('>').slice(1)) {
    const [tag, n] = part.split(':');
    let k = 0;
    let next = null;
    for (const c of el ? el.children : []) {
      if (/^(SCRIPT|NOSCRIPT|STYLE|TEMPLATE|LINK|META|HEAD|TITLE|BASE)$/.test(c.tagName) || c.tagName.toLowerCase() !== tag) continue;
      if (++k === Number(n)) {
        next = c;
        break;
      }
    }
    el = next;
  }
  if (!el) return null;
  const area = el;
  const keyOf = (x) => `${x.tagName}|${(x.textContent || '').replace(/\s+/g, ' ').trim()}`;
  const before = new Set([...area.querySelectorAll('*')].map(keyOf));
  return new Promise((resolve) => {
    let last = null;
    let timer = null;
    const done = async () => {
      observer.disconnect();
      clearTimeout(giveUp);
      // The update's own entrance (a row sliding in) runs to its end before the state is read.
      const running = area.getAnimations ? area.getAnimations({ subtree: true }).filter((a) => {
        const t = a.effect?.getTiming?.();
        return t && Number.isFinite(t.iterations) && Number.isFinite(t.duration) && a.playState === 'running';
      }) : [];
      const replayed = running.some((a) => a.effect?.target instanceof Element && before.has(keyOf(a.effect.target)));
      await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => null))), new Promise((r) => setTimeout(r, 1500))]);
      resolve({ t: Math.round(last), text: (area.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000), replayed });
    };
    const observer = new MutationObserver(() => {
      last ??= performance.now();
      clearTimeout(timer);
      timer = setTimeout(done, Math.max(quietMs, burstGap));
    });
    observer.observe(area, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    const giveUp = setTimeout(() => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Only measures: the parts of a page that change by themselves and their pace, nothing recorded (the re-audit of a copy).
 * @returns {Promise<{ path: string, ms: number }[]>}
 */
export async function measureFeeds(page) {
  await page.mouse.move(-20, -20).catch(() => {});
  const seen = await page.evaluate(watchMutations, { ms: WATCH_MS, moreMs: WATCH_MORE_MS, burstGap: BURST_GAP_MS });
  return seen.areas.map((a) => ({ path: a.path, ...paceOf(a.times, seen.watchedMs) })).filter((a) => a.ms);
}

/** The node of a snapshot tree at `path`, or null. */
export function nodeAt(body, path) {
  let hit = null;
  const walk = (n) => {
    if (hit || !n || !n.tag) return;
    if (n.path === path) {
      hit = n;
      return;
    }
    if (path.startsWith(`${n.path}>`)) for (const c of n.children ?? []) walk(c);
  };
  walk(body);
  return hit;
}

/**
 * The pace of an area from the start times of its updates: the median gap, when the updates are steady enough to be a
 * timer (most gaps within 40 % of the median) and the area was still changing near the end of the watch.
 * @returns {{ ms: number } | { reason: string }}
 */
export function paceOf(times, watchedMs) {
  if (times.length < 3) return { reason: times.length ? 'changed once or twice' : 'no change' };
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median < MIN_INTERVAL_MS) return { reason: `changes every ${Math.round(median)} ms (typing or counting, too fast to rebuild as states)` };
  const steady = gaps.filter((g) => Math.abs(g - median) <= median * 0.4).length / gaps.length;
  if (steady < 0.6) return { reason: 'changes at no steady pace' };
  if (watchedMs - times[times.length - 1] > median * 2.5) return { reason: 'stopped changing (an entrance, not a timer)' };
  return { ms: Math.round(median / 10) * 10 };
}

/**
 * Finds the parts of the page that change by themselves and records their states onto the page snapshot.
 * @param {import('playwright').Page} page
 * @param {object} body  the page snapshot's body (snapshot.js); the areas' nodes get `states`
 * @param {{ budgetMs?: number, skip?: string[] }} [o]  skip: paths already given states (a carousel)
 * @returns {Promise<{ areas: object[], skipped: object[], states: number, cssUrls: string[], ms: number, watchedMs: number }>}
 */
export async function captureFeeds(page, body, { budgetMs = 30000, skip = [] } = {}) {
  const started = Date.now();
  const out = { areas: [], skipped: [], states: 0, cssUrls: [], ms: 0, watchedMs: 0 };
  // The mouse away and the page where it is: a hover or a scroll must not count as the page changing by itself.
  await page.mouse.move(-20, -20).catch(() => {});
  const seen = await page.evaluate(watchMutations, { ms: WATCH_MS, moreMs: WATCH_MORE_MS, burstGap: BURST_GAP_MS, skip });
  out.watchedMs = seen.watchedMs;
  const deadline = started + budgetMs;
  const candidates = seen.areas
    .map((a) => ({ ...a, pace: paceOf(a.times, seen.watchedMs) }))
    .sort((a, b) => b.times.length - a.times.length);
  for (const a of candidates) {
    if (a.pace.reason) {
      out.skipped.push({ path: a.path, reason: a.pace.reason });
      continue;
    }
    if (out.areas.length >= MAX_AREAS) {
      out.skipped.push({ path: a.path, reason: 'more areas than one page records' });
      continue;
    }
    const node = nodeAt(body, a.path);
    if (!node) {
      out.skipped.push({ path: a.path, reason: 'not in the page snapshot' });
      continue;
    }
    if (node.states) {
      out.skipped.push({ path: a.path, reason: 'already has states' });
      continue;
    }
    // The next updates, each read once it has settled: as many as the time allows, at most MAX_STATES, and no more once
    // the area is back where the series started (the original cycles: the copy then cycles exactly).
    const variants = [];
    const times = [];
    let first = null;
    let cycle = false;
    let replays = 0;
    for (let k = 1; k <= MAX_STATES && Date.now() + a.pace.ms * 3 < deadline; k++) {
      const update = await page.evaluate(nextUpdate, { path: a.path, timeoutMs: a.pace.ms * 3, quietMs: Math.min(400, a.pace.ms / 3), burstGap: BURST_GAP_MS }).catch(() => null);
      if (!update) break;
      times.push(update.t);
      if (update.replayed) replays++;
      if (first == null) first = update.text;
      else if (update.text === first) {
        cycle = true;
        break;
      }
      const res = await page.evaluate(snapshotPage, { rootPath: a.path }).catch(() => null);
      if (!res?.body) break;
      for (const u of res.cssUrls ?? []) out.cssUrls.push(u);
      variants.push({ index: variants.length + 1, body: res.body });
    }
    if (!variants.length) {
      out.skipped.push({ path: a.path, reason: 'no update came while it was recorded' });
      continue;
    }
    // The pace measured over the whole recording, not only the first watch.
    const all = [...a.times];
    const gaps = times.slice(1).map((t, i) => t - times[i]).filter((g) => g > 0);
    const ms = gaps.length >= 2 ? Math.round(gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)] / 10) * 10 : a.pace.ms;
    node.states = {
      initial: 0,
      count: variants.length + 1,
      controls: [],
      nav: [],
      autoplay: { ms, step: 1 },
      feed: true,
      // Most updates played the entrance of what was already there too: the copy replays the whole state (else only what is new).
      ...(replays * 2 > times.length && { replay: 'all' }),
      cycle,
      variants,
    };
    out.areas.push({ path: a.path, ms, states: variants.length + 1, cycle, kinds: a.kinds, updates: all.length, replay: replays * 2 > times.length ? 'all' : 'new' });
    out.states += variants.length + 1;
  }
  out.ms = Date.now() - started;
  return out;
}
