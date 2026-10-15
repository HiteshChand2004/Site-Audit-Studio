// @ts-check
// Lottie, Tier 3 embed (CLONER_SPEC Phase 2 item 3): an animation the page played with lottie-web is played in the copy by
// the same kind of player - the pinned lottie-web package's SVG build, vendored byte for byte (js/vendor/, accepted by the
// safety gate only as exactly that file, like gsap) - from the animation's own JSON, never from the site's bundle. The JSON
// is the one the page loaded (the job's network record, capture/.network) or the data the page handed the player inline.
//
// Only an animation that was playing by itself is embedded: one the page drives from the scroll, a hover or a click is
// left as the frame the capture saw (its player's script is not copied) and reported. One whose JSON cannot be found or
// cannot be played alone (images it loads from elsewhere, a .lottie archive) falls back to the video tier
// (behavior/video.js) when the capture recorded it, else the frame the capture saw - and is reported either way.
//
// In the copy the container keeps the frame the capture saw (the rendered SVG) and a motion token `oN`; js/lottie-play.js
// loads the animation into it and removes that frame once the animation has drawn. Nothing runs under
// prefers-reduced-motion: the frame stays. Without script the frame stays.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
// The vendored libraries' folder (emit/anim.js VENDOR_DIR; not imported: emit/anim.js lists this file among its vendored ones).
const VENDOR_DIR = 'js/vendor';

const require = createRequire(import.meta.url);

/** The pinned package (server/package.json) and the build shipped: SVG renderer only, no expression engine (no eval). */
export const LOTTIE_PACKAGE_VERSION = '5.13.0';
export const LOTTIE_VENDOR = `${VENDOR_DIR}/lottie_light.min.js`;
export const LOTTIE_PLAY_FILE = 'js/lottie-play.js';
export const LOTTIE_DIR = 'js/lottie';
export const lottieDataFile = (slug) => `${LOTTIE_DIR}/${slug}.js`;
/** An animation JSON larger than this is not embedded (the recording is lighter). */
export const MAX_LOTTIE_BYTES = 2 * 1024 * 1024;

/** The vendored file of the pinned package, or null when the package is not installed (then nothing is embedded). */
export function lottieVendorPath() {
  try {
    return require.resolve('lottie-web/build/player/lottie_light.min.js');
  } catch {
    return null;
  }
}

/** The fixed player (plain ES5-style JS, no sink: it only calls lottie-web and querySelectorAll). */
export const LOTTIE_PLAY_JS = `(function () {
  var p = window.__sasLottie;
  var L = window.lottie || window.bodymovin;
  if (!p || !L || !L.loadAnimation || !p.entries) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  p.entries.forEach(function (e) {
    var els = document.querySelectorAll('[data-motion~="' + e.token + '"]');
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        var still = [];
        for (var c = el.firstChild; c; c = c.nextSibling) still.push(c);
        try {
          var a = L.loadAnimation({ container: el, renderer: 'svg', loop: e.loop, autoplay: e.autoplay, animationData: JSON.parse(JSON.stringify(e.data)) });
          a.addEventListener('DOMLoaded', function () {
            for (var s = 0; s < still.length; s++) if (still[s].parentNode === el) el.removeChild(still[s]);
          });
        } catch (err) {
          // an animation the player refuses leaves the frame the capture saw
        }
      })(els[i]);
    }
  });
})();
`;

/** Whether a Lottie JSON can be played from itself alone: its layers, and no image it would load from elsewhere. */
export function lottieProblem(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.layers) || !(data.w > 0) || !(data.h > 0)) return 'not-lottie-json';
  const external = (data.assets ?? []).filter((a) => a && typeof a.p === 'string' && a.e !== 1 && !/^data:/i.test(a.p));
  if (external.length) return 'external-images';
  return null;
}

/**
 * Which Lottie animations the copy plays itself: for each page, the animations the capture found (motion.json
 * loops.lottie) whose JSON is in hand and playable, playing by themselves when captured. Marks their containers with an
 * `oN` token and returns the program per page (`t.lottie`, set by the caller on the IR page).
 * @param {{ pages: object[] }} site
 * @param {Map<string, object>} motionByPath
 * @param {{ dir: string }} o  the recreate workspace (its capture/.network record)
 */
export async function planLottie(site, motionByPath, { dir, lookup = null }) {
  const programs = new Map();
  const embedded = new Map();
  const entries = [];
  const skipped = [];
  const found = site.pages.some((t) => motionByPath.get(t.info.path)?.loops?.lottie);
  if (!found) return { programs, embedded, entries, skipped, available: Boolean(lottieVendorPath()) };
  const vendor = lottieVendorPath();
  const { readRecordIndex, recordBodyReader } = await import('./scripts.js');
  const recordDir = path.join(dir, 'capture', '.network');
  const index = await readRecordIndex(recordDir);
  const read = recordBodyReader(recordDir);
  const byUrl = new Map((index?.entries ?? []).map((e) => [e.url, e]));
  let n = 0;
  for (const t of site.pages) {
    const lottie = motionByPath.get(t.info.path)?.loops?.lottie;
    if (!lottie) continue;
    for (const p of lottie.players ?? []) skipped.push({ page: t.info.path, path: p.path, reason: 'player-element', src: p.src });
    const nodes = new Map();
    const walk = (x) => {
      if (!x || 'text' in x) return;
      for (const c of [x.cpath, ...(x.cpathAlt ?? [])]) if (c && !nodes.has(c)) nodes.set(c, x);
      (x.children ?? []).forEach(walk);
    };
    walk(t.root);
    const list = [];
    for (const a of lottie.animations ?? []) {
      const why = (reason) => skipped.push({ page: t.info.path, path: a.path, reason, ...(a.src && { src: a.src }) });
      if (!vendor) {
        why('player-not-installed');
        continue;
      }
      if (!a.playing || !a.autoplay) {
        why('not-self-running');
        continue;
      }
      let text = a.data ?? null;
      if (!text && a.src) {
        const entry = byUrl.get(a.src);
        // The running job's record first (its index is written when the job ends), else a saved one (a rebuild).
        const live = lookup?.(a.src);
        const body = live?.file ? await readFile(live.file).catch(() => null) : entry ? await read(entry) : null;
        text = body ? body.toString('utf8') : null;
      }
      if (!text) {
        why('json-not-found');
        continue;
      }
      if (text.length > MAX_LOTTIE_BYTES) {
        why('json-too-large');
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        why('json-not-readable');
        continue;
      }
      const problem = lottieProblem(data);
      if (problem) {
        why(problem);
        continue;
      }
      const node = nodes.get(a.path);
      if (!node) {
        why('not-in-copy');
        continue;
      }
      const token = `o${++n}`;
      node.motionTokens = [...new Set([...(node.motionTokens ?? []), token])];
      list.push({ token, loop: a.loop === false ? false : a.loop === true || a.loop == null ? true : a.loop, autoplay: true, data });
      entries.push({ page: t.info.path, path: a.path, token, source: a.data ? 'inline data' : a.src, frames: a.frames, fps: a.fps, bytes: text.length });
      embedded.set(t.info.path, new Set([...(embedded.get(t.info.path) ?? []), a.path]));
    }
    if (list.length) programs.set(t.info.path, { version: LOTTIE_PACKAGE_VERSION, entries: list });
  }
  return { programs, embedded, entries, skipped, available: Boolean(vendor) };
}

/** Puts each page's program on its IR page (`page.lottie`), which every stack reads. */
export function applyLottiePages(ir, programs) {
  if (!programs?.size) return;
  for (const p of ir.pages) {
    const program = programs.get(p.path);
    if (program) p.lottie = program;
    else delete p.lottie;
  }
}

/**
 * Files of the plain-HTML copy for every page with a Lottie program: the player library, the fixed player, the data.
 * @param {{ pages: { slug: string, lottie?: object }[] }} ir
 * @param {(rel: string) => string} vendorText  the pinned package's file for a vendored path (emit/anim.js)
 * @returns {Map<string, string>}
 */
export function lottieFiles(ir, vendorText) {
  const files = new Map();
  const pages = ir.pages.filter((p) => p.lottie);
  if (!pages.length) return files;
  files.set(LOTTIE_VENDOR, vendorText(LOTTIE_VENDOR));
  files.set(LOTTIE_PLAY_FILE, LOTTIE_PLAY_JS);
  // JSON is valid JavaScript; `<` is escaped so the data can never close a tag anywhere it is pasted.
  for (const p of pages) files.set(lottieDataFile(p.slug), `window.__sasLottie = ${JSON.stringify(p.lottie).replace(/</g, '\\u003c')};\n`);
  return files;
}

/**
 * The page's script tags, in the order they must run (all deferred): the library, the page's data, the player.
 * @param {{ slug: string, lottie?: object }} page
 * @param {(file: string) => string} rel  the page-relative path of a site file
 */
export function lottieTags(page, rel) {
  if (!page.lottie) return [];
  return [LOTTIE_VENDOR, lottieDataFile(page.slug), LOTTIE_PLAY_FILE].map((f) => `  <script src="${rel(f)}" defer></script>`);
}
