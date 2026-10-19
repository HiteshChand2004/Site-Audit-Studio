// Elements that follow the pointer: a custom cursor (a dot that trails the mouse), a magnetic blob, a card or a picture
// that shifts a little against the mouse (mouse parallax). The page's script moves them on every mouse move, so nothing in
// the snapshot or the stylesheets says they do - and no other probe moves the mouse across the page without stopping on
// an element. This one does: the mouse is moved to a few points of the window, and every element's position is read a
// moment after the move and again once it has settled. An element whose movement keeps a constant ratio to the mouse's
// (on both moves, both axes) follows it: the ratio (`k`: 1 = it sits under the pointer, 0.05 = a slight parallax), where
// it was for one known mouse position (`ref`), and how quickly it catches up (`tauMs`: the time constant of an easing
// that has covered the measured share of the way after `EARLY_MS`). js/motion.js moves the copy's element the same way.
// Nothing here names a library or a class.

/** Where the mouse is taken, as shares of the window. */
export const POINTS = [[0.25, 0.3], [0.72, 0.62], [0.42, 0.78]];
/** First read after a move (the catching-up shows here), and the read once it has settled. */
export const EARLY_MS = 60;
export const SETTLE_MS = 800;
/** A follower moves at least this far for a move of the mouse, and keeps its ratio within this many px. */
export const MIN_MOVE_PX = 4;
export const FIT_TOLERANCE_PX = 4;

/** Page function: the centre of every visible element (page coordinates; viewport ones for fixed), keyed by snapshot path. */
export function readCentres({ maxNodes = 4000 } = {}) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const out = {};
  let count = 0;
  const walk = (el, path, fixedAbove) => {
    if (count++ > maxNodes) return;
    const cs = getComputedStyle(el);
    const fixed = fixedAbove || cs.position === 'fixed';
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && cs.display !== 'none') {
      out[path] = [r.left + r.width / 2 + (fixed ? 0 : scrollX), r.top + r.height / 2 + (fixed ? 0 : scrollY), Math.round(r.width), Math.round(r.height), fixed ? 1 : 0];
    }
    if (el.tagName === 'svg') return;
    const index = {};
    for (const c of el.children) {
      if (SKIP.has(c.tagName)) continue;
      const t = c.tagName.toLowerCase();
      index[t] = (index[t] || 0) + 1;
      walk(c, `${path}>${t}:${index[t]}`, fixed);
    }
  };
  if (document.body) walk(document.body, 'body', false);
  return out;
}

/** The ratio through the origin that maps the mouse's moves onto the element's, and the largest miss. */
function fit(dm, dc) {
  const num = dm.reduce((s, d, i) => s + d * dc[i], 0);
  const den = dm.reduce((s, d) => s + d * d, 0);
  const k = den ? num / den : 0;
  const miss = Math.max(...dm.map((d, i) => Math.abs(dc[i] - k * d)));
  return { k, miss };
}

/**
 * The followers among the elements read at each mouse point. `reads[i] = { m: [x, y], early, settled }` (centre maps).
 * Pure, so it can be checked without a browser.
 * @returns {{ path: string, kx: number, ky: number, ref: object, tauMs: number, fixed: boolean, size: number[] }[]}
 */
export function findFollowers(reads, { viewport = [1440, 900] } = {}) {
  if (reads.length < 3) return [];
  const [first] = reads;
  const out = [];
  for (const [path, c0] of Object.entries(first.settled)) {
    const cs = reads.map((r) => r.settled[path]);
    if (cs.some((c) => !c)) continue;
    // A full-width band or a section moving with the mouse is a parallax of the page, not a thing that follows; the
    // limit keeps the page's own layout from being read as one (nothing moves there).
    if (c0[2] * c0[3] > 0.6 * viewport[0] * viewport[1]) continue;
    const dmx = reads.slice(1).map((r) => r.m[0] - first.m[0]);
    const dmy = reads.slice(1).map((r) => r.m[1] - first.m[1]);
    const dcx = cs.slice(1).map((c) => c[0] - c0[0]);
    const dcy = cs.slice(1).map((c) => c[1] - c0[1]);
    if (Math.max(...dcx.map(Math.abs), ...dcy.map(Math.abs)) < MIN_MOVE_PX) continue;
    const fx = fit(dmx, dcx);
    const fy = fit(dmy, dcy);
    if (fx.miss > FIT_TOLERANCE_PX || fy.miss > FIT_TOLERANCE_PX) continue; // moved, but not with the mouse
    if (Math.abs(fx.k) < 0.02 && Math.abs(fy.k) < 0.02) continue;
    // How quickly it catches up: the share of the last move covered after EARLY_MS, as an easing's time constant.
    const last = reads.length - 1;
    const from = reads[last - 1].settled[path];
    const early = reads[last].early[path];
    const to = cs[last];
    const whole = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const done = early ? Math.hypot(early[0] - from[0], early[1] - from[1]) / Math.max(1e-6, whole) : 1;
    const share = Math.min(1, Math.max(0, done));
    const tauMs = share >= 0.97 || whole < MIN_MOVE_PX ? 0 : Math.round(-EARLY_MS / Math.log(1 - Math.max(0.01, share)));
    out.push({ path, kx: +fx.k.toFixed(3), ky: +fy.k.toFixed(3), ref: { cx: +c0[0].toFixed(1), cy: +c0[1].toFixed(1), mx: first.m[0], my: first.m[1] }, tauMs, fixed: c0[4] === 1, size: [c0[2], c0[3]] });
  }
  // Only the outermost of what moves together: the dot of a cursor, not also the ring inside it.
  return out.filter((f) => !out.some((g) => g !== f && f.path.startsWith(`${g.path}>`) && Math.abs(g.kx - f.kx) < 0.05 && Math.abs(g.ky - f.ky) < 0.05));
}

/**
 * Page function: the centres of the given elements on every frame for `ms` (page clock), to see how a follower catches up
 * after the mouse jumps - read inside the page, because a read from outside takes longer than a frame.
 */
export function sampleFrames({ paths, ms }) {
  const find = (path) => {
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
    return el;
  };
  const els = paths.map(find);
  return new Promise((resolve) => {
    const frames = [];
    const start = performance.now();
    const tick = (now) => {
      frames.push({ t: now, c: els.map((el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      }) });
      if (now - start < ms) requestAnimationFrame(tick);
      else resolve(frames);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * How much of the remaining way a follower covers per frame, from its centres frame by frame after the mouse jumped
 * (`frames`, sampleFrames): the median of 1 - remaining(n + 1) / remaining(n) while it is still more than 2 px away.
 * 1 = it jumps there. Also the time constant that share means at the frame rate measured.
 * @returns {{ share: number, tauMs: number }}
 */
export function frameShare(frames, i) {
  const pts = frames.map((f) => f.c[i]).filter(Boolean);
  if (pts.length < 4) return { share: 1, tauMs: 0 };
  const end = pts[pts.length - 1];
  const left = pts.map((p) => Math.hypot(p[0] - end[0], p[1] - end[1]));
  const shares = [];
  for (let n = 0; n + 1 < left.length; n++) if (left[n] > 2 && left[n + 1] < left[n]) shares.push(1 - left[n + 1] / left[n]);
  if (!shares.length) return { share: 1, tauMs: 0 };
  shares.sort((a, b) => a - b);
  const share = +shares[Math.floor(shares.length / 2)].toFixed(3);
  const dts = frames.slice(1).map((f, n) => f.t - frames[n].t).sort((a, b) => a - b);
  const dt = dts[Math.floor(dts.length / 2)] || 16.67;
  return { share, tauMs: share >= 0.97 ? 0 : Math.round(-dt / Math.log(1 - share)) };
}

/**
 * Moves the mouse over the page and returns what follows it. The mouse is put back off the page.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ followers: object[], ms: number }>}
 */
export async function capturePointer(page) {
  const started = Date.now();
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };
  const reads = [];

  for (const [sx, sy] of POINTS) {
    const m = [Math.round(vp.width * sx), Math.round(vp.height * sy)];
    // One move, so the early read is EARLY_MS after the mouse arrived: a path of several steps takes time of its own, and
    // the follower is already on its way during it - its easing then read several times too quick.
    await page.mouse.move(m[0], m[1]);
    await page.waitForTimeout(EARLY_MS);
    const early = await page.evaluate(readCentres, {});
    await page.waitForTimeout(SETTLE_MS - EARLY_MS);
    const settled = await page.evaluate(readCentres, {});
    reads.push({ m, early, settled });

  }
  const followers = findFollowers(reads, { viewport: [vp.width, vp.height] });
  // How each follower catches up, frame by frame: the mouse jumps once more while the page records every frame.
  if (followers.length) {
    const sampling = page.evaluate(sampleFrames, { paths: followers.map((f) => f.path), ms: 700 }).catch(() => null);
    await page.waitForTimeout(40);
    await page.mouse.move(Math.round(vp.width * POINTS[0][0]), Math.round(vp.height * POINTS[0][1]));
    const frames = await sampling;
    if (frames) {
      followers.forEach((f, i) => {
        const { share, tauMs } = frameShare(frames, i);
        // A follower that jumps keeps 0; one that eases gets the per-frame share and the time it amounts to.
        f.share = share;
        f.tauMs = tauMs;
      });
    }
  }
  await page.mouse.move(-20, -20).catch(() => {});
  return { followers, ms: Date.now() - started };
}
