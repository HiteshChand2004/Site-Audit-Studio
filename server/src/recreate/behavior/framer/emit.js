// @ts-check
// The files a plain-HTML copy ships to run a page's Framer appear entrances (behavior/framer/plan.js): the motion package's
// own browser build, byte for byte (js/vendor/motion.js, listed in emit/anim.js VENDOR_FILES so the safety gate accepts it
// only as exactly that file), one fixed replayer (js/appear-replay.js, the same for every site) and the page's program as
// data (js/appear/<slug>.js). The app stacks read the same program from the IR page (`page.appear`).
//
// The replayer picks the spec of the breakpoint the window is in, the way Framer's runtime does (the first breakpoint
// whose media query matches; its own spec, else the default one; `null` = no entrance there), puts each target in its
// first pose at once and runs motion's animate() - on load, or through motion's inView() for an in-view entrance (once,
// as Framer's appear effects play). Nothing runs under prefers-reduced-motion: the page then stays as the stylesheet
// draws it, every element in its end state. Without the script the page is the same finished page.
import { VENDOR_DIR } from '../../emit/anim.js';

export const MOTION_VENDOR = `${VENDOR_DIR}/motion.js`;
export const APPEAR_REPLAY_FILE = 'js/appear-replay.js';
export const APPEAR_DIR = 'js/appear';
export const appearDataFile = (slug) => `${APPEAR_DIR}/${slug}.js`;

/** The fixed replayer (plain ES5-style JS, no sink: it only calls motion and querySelectorAll). */
export const APPEAR_REPLAY_JS = `(function () {
  var p = window.__sasAppear;
  var M = window.Motion;
  if (!p || !M || !M.animate || !p.entries) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var hash = null;
  (p.breakpoints || []).some(function (b) {
    if (b.media && window.matchMedia(b.media).matches) { hash = b.hash; return true; }
    return false;
  });
  function pick(v) {
    var own = hash !== null && Object.prototype.hasOwnProperty.call(v, hash) ? v[hash] : undefined;
    if (own === null) return null;
    if (own === undefined && v['default'] === null) return null;
    return own || v['default'] || null;
  }
  function pose(el, kf, on) {
    for (var k in kf) {
      if (!Object.prototype.hasOwnProperty.call(kf, k)) continue;
      el.style[k] = on ? String(kf[k][0]) : '';
    }
  }
  p.entries.forEach(function (e) {
    var s = pick(e.variants || {});
    if (!s || !s.keyframes) return;
    var els = document.querySelectorAll('[data-sas-a~="' + e.target + '"]');
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        try {
          pose(el, s.keyframes, true);
          var run = function () {
            try { M.animate(el, s.keyframes, s.options); } catch (err) { pose(el, s.keyframes, false); }
          };
          if (s.trigger === 'inView' && M.inView) M.inView(el, function () { run(); }, s.viewport || {});
          else run();
        } catch (err) {
          // an entrance the library refuses leaves the element as the stylesheet draws it, never in its first pose
          pose(el, s.keyframes, false);
        }
      })(els[i]);
    }
  });
})();
`;

/**
 * Files of the plain-HTML copy for every page with an appear program: motion's browser build, the replayer, the data.
 * @param {{ pages: { slug: string, appear?: object }[] }} ir
 * @param {(rel: string) => string} vendorText  the pinned package's file for a vendored path (emit/anim.js)
 * @returns {Map<string, string>}
 */
export function appearFiles(ir, vendorText) {
  const files = new Map();
  const pages = ir.pages.filter((p) => p.appear);
  if (!pages.length) return files;
  files.set(MOTION_VENDOR, vendorText(MOTION_VENDOR));
  files.set(APPEAR_REPLAY_FILE, APPEAR_REPLAY_JS);
  // JSON is valid JavaScript; `<` is escaped so the data can never close a tag anywhere it is pasted.
  for (const p of pages) files.set(appearDataFile(p.slug), `window.__sasAppear = ${JSON.stringify(p.appear).replace(/</g, '\\u003c')};\n`);
  return files;
}

/**
 * The page's script tags, in the order they must run (all deferred): motion, the page's data, the replayer.
 * @param {{ slug: string, appear?: object }} page
 * @param {(file: string) => string} rel  the page-relative path of a site file
 */
export function appearTags(page, rel) {
  if (!page.appear) return [];
  return [MOTION_VENDOR, appearDataFile(page.slug), APPEAR_REPLAY_FILE].map((f) => `  <script src="${rel(f)}" defer></script>`);
}
