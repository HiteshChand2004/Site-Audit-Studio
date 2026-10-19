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

/**
 * The replay itself, one source for every stack (like emit/anim.js REPLAY_CORE): `M` is motion's API ({ animate, inView }),
 * `p` the page's program. Returns a function that stops what it started (the app stacks call it on unmount). Plain
 * ES5-style JS, no sink: it only calls motion and querySelectorAll.
 */
export const APPEAR_CORE = `function replayAppear(M, p) {
  var stops = [];
  var stop = function () { stops.forEach(function (s) { try { s(); } catch (err) { /* already stopped */ } }); stops = []; };
  if (!p || !M || !M.animate || !p.entries) return stop;
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
          stops.push(function () { pose(el, s.keyframes, false); });
          var run = function () {
            try {
              var c = M.animate(el, s.keyframes, s.options);
              if (c && c.stop) stops.push(function () { c.stop(); });
            } catch (err) { pose(el, s.keyframes, false); }
          };
          if (s.trigger === 'inView' && M.inView) {
            var off = M.inView(el, function () { run(); }, s.viewport || {});
            if (typeof off === 'function') stops.push(off);
          } else run();
        } catch (err) {
          // an entrance the library refuses leaves the element as the stylesheet draws it, never in its first pose
          pose(el, s.keyframes, false);
        }
      })(els[i]);
    }
  });
  return stop;
}`;

/** The plain-HTML replayer (js/appear-replay.js): the core, run once motion and the data are in, not under reduced motion. */
export const APPEAR_REPLAY_JS = `(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  ${APPEAR_CORE.split('\n').join('\n  ')}
  replayAppear(window.Motion, window.__sasAppear);
})();
`;

/** The same core as an ES module for the app stacks (src/anim/appear.js). */
export const APPEAR_MODULE = `// Generated: plays the page's Framer appear entrances with the motion package (see SiteAppear.jsx).
${APPEAR_CORE}

export { replayAppear };
`;

/**
 * The app stacks' component: runs a page's appear program with the motion package in a layout effect (before the first
 * paint, so the first pose is set before anything is seen) and stops it on unmount. Nothing under reduced motion.
 * @param {{ client?: boolean, base?: string }} [o]
 */
export function siteAppearJsx({ client = false, base = './anim' } = {}) {
  return [
    ...(client ? ["'use client';", ''] : []),
    "// Generated: plays the original's Framer appear entrances with the motion package.",
    "import { useLayoutEffect } from 'react';",
    "import { animate, inView } from 'motion';",
    `import { replayAppear } from '${base}/appear.js';`,
    '',
    'export default function SiteAppear({ program }) {',
    '  useLayoutEffect(() => {',
    "    if (!program || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;",
    '    return replayAppear({ animate, inView }, program);',
    '  }, [program]);',
    '  return null;',
    '}',
    '',
  ].join('\n');
}

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
