// @ts-check
// The files a plain-HTML copy ships to replay a page's animation-library calls (behavior/gsap.js): the library itself,
// byte for byte the pinned package (js/vendor/), one fixed replayer (js/anim-replay.js, the same for every site) and the
// page's program as data (js/anim/<slug>.js). The app stacks import gsap from npm instead (emit/react, emit/next).
//
// The replayer resolves targets by their replay ids (`data-sas-a`), builds the program's timelines, then makes each call
// in the original's order: fromTo(start, vars) where the capture read a start, from / fromTo / set as they were, chained
// calls on their timeline at their position, ScrollTrigger options with their elements. Nothing runs under
// prefers-reduced-motion: the page then stays as captured (the end state, every element shown). Without the script the
// page is the same finished page.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const GSAP_DIST = path.dirname(require.resolve('gsap/dist/gsap.min.js'));

export const VENDOR_DIR = 'js/vendor';
export const REPLAY_FILE = 'js/anim-replay.js';
export const ANIM_DIR = 'js/anim';
/** The library files a copy may ship, by their path in the copy → the file of the pinned package. */
export const VENDOR_FILES = {
  [`${VENDOR_DIR}/gsap.min.js`]: path.join(GSAP_DIST, 'gsap.min.js'),
  [`${VENDOR_DIR}/ScrollTrigger.min.js`]: path.join(GSAP_DIST, 'ScrollTrigger.min.js'),
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const cache = new Map();
const vendorText = (rel) => {
  if (!cache.has(rel)) cache.set(rel, readFileSync(VENDOR_FILES[rel], 'utf8'));
  return cache.get(rel);
};
/** rel → sha256 of the pinned package's file: the safety gate accepts a vendored file only when it is exactly that. */
export const vendorHashes = () => Object.fromEntries(Object.keys(VENDOR_FILES).map((rel) => [rel, sha256(vendorText(rel))]));
export const animDataFile = (slug) => `${ANIM_DIR}/${slug}.js`;

/**
 * The replay itself, one source for every stack: the plain-HTML replayer below wraps it, the app stacks import it as a
 * module (src/anim/replay.js) and run it inside gsap.context(). Plain ES5-style JS with no sink: it only calls the library
 * and querySelectorAll. `ST` is ScrollTrigger (or null).
 */
export const REPLAY_CORE = `function replayProgram(g, ST, p) {
  if (!p || !g || !p.calls) return;
  if (p.scrollTrigger && ST) g.registerPlugin(ST);
  function els(ids) {
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var found = document.querySelectorAll('[data-sas-a~="' + ids[i] + '"]');
      for (var j = 0; j < found.length; j++) if (out.indexOf(found[j]) < 0) out.push(found[j]);
    }
    return out;
  }
  function vars(v) {
    if (!v || typeof v !== 'object') return v;
    var o = {};
    for (var k in v) {
      var x = v[k];
      if (k === 'scrollTrigger' && x && typeof x === 'object') {
        var s = {};
        for (var j in x) s[j] = x[j] && typeof x[j] === 'object' && x[j].ref ? els([x[j].ref])[0] : x[j];
        o[k] = s;
      } else o[k] = x;
    }
    return o;
  }
  function starts(list) {
    var from = {};
    Object.keys(list[0]).forEach(function (k) {
      from[k] = function (i) { return (list[i] || list[0])[k]; };
    });
    return from;
  }
  var tls = {};
  (p.timelines || []).forEach(function (t) { tls[t.id] = g.timeline(vars(t.vars) || {}); });
  p.calls.forEach(function (c) {
    try {
      if (c.lib === 'ScrollTrigger') {
        if (ST) ST.create(vars(c.vars));
        return;
      }
      var host = c.timeline != null && tls[c.timeline] ? tls[c.timeline] : g;
      var pos = host === g ? undefined : c.position;
      if (c.method === 'add' || c.method === 'addLabel') {
        if (host === g) return;
        if (c.child != null && tls[c.child]) host.add(tls[c.child], c.position);
        else if (c.label) host.addLabel(c.label, c.position);
        return;
      }
      var t = els(c.targets || []);
      if (!t.length) return;
      if (c.start) host.fromTo(t, starts(c.start), vars(c.vars), pos);
      else if (c.method === 'fromTo') host.fromTo(t, vars(c.fromVars), vars(c.vars), pos);
      else host[c.method](t, vars(c.vars), pos);
    } catch (e) {
      // one call the library refuses must not stop the others
    }
  });
}`;

/** The plain-HTML replayer (js/anim-replay.js): the core, run once the deferred library and data are in, not under reduced motion. */
export const REPLAY_JS = `(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  ${REPLAY_CORE.split('\n').join('\n  ')}
  replayProgram(window.gsap, window.ScrollTrigger || null, window.__sasAnim);
})();
`;

/** The same core as an ES module for the app stacks (src/anim/replay.js). */
export const REPLAY_MODULE = `// Generated: replays the animation calls the original page made, with the real gsap package (see SiteAnimations.jsx).
${REPLAY_CORE}

export { replayProgram };
`;

/**
 * The app stacks' component (React + Vite, MERN client, Next.js with `'use client'`): runs a page's program with the gsap
 * package inside gsap.context() in a layout effect, and reverts it on unmount, so React StrictMode's double mount (and a
 * client-side route change) never leaves two copies of a tween. Nothing under reduced motion; renders nothing.
 * @param {{ client?: boolean, base?: string }} [o]  client: the Next.js directive; base: the import path of src/anim
 */
export function siteAnimationsJsx({ client = false, base = './anim' } = {}) {
  return [
    ...(client ? ["'use client';", ''] : []),
    '// Generated: replays the animation calls the original page made, with the real gsap package.',
    "import { useLayoutEffect } from 'react';",
    "import { gsap } from 'gsap';",
    "import { ScrollTrigger } from 'gsap/ScrollTrigger';",
    `import { replayProgram } from '${base}/replay.js';`,
    '',
    'export default function SiteAnimations({ program }) {',
    '  useLayoutEffect(() => {',
    "    if (!program || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;",
    '    const ctx = gsap.context(() => replayProgram(gsap, program.scrollTrigger ? ScrollTrigger : null, program));',
    '    return () => ctx.revert();',
    '  }, [program]);',
    '  return null;',
    '}',
    '',
  ].join('\n');
}

/** The program of a page as a module the page component imports (src/anim/<name>.json). */
export const programJson = (page) => `${JSON.stringify(page.anim)}\n`;

/**
 * Files of the plain-HTML copy for every page with a program: the library (only the parts used), the replayer, the data.
 * @param {{ pages: { slug: string, anim?: { scrollTrigger?: boolean } }[] }} ir
 * @returns {Map<string, string>}
 */
export function animFiles(ir) {
  const files = new Map();
  const pages = ir.pages.filter((p) => p.anim);
  if (!pages.length) return files;
  files.set(`${VENDOR_DIR}/gsap.min.js`, vendorText(`${VENDOR_DIR}/gsap.min.js`));
  if (pages.some((p) => p.anim.scrollTrigger)) files.set(`${VENDOR_DIR}/ScrollTrigger.min.js`, vendorText(`${VENDOR_DIR}/ScrollTrigger.min.js`));
  files.set(REPLAY_FILE, REPLAY_JS);
  // JSON is valid JavaScript; `<` is escaped so the data can never close a tag anywhere it is pasted.
  for (const p of pages) files.set(animDataFile(p.slug), `window.__sasAnim = ${JSON.stringify(p.anim).replace(/</g, '\\u003c')};\n`);
  return files;
}

/**
 * The page's script tags, in the order they must run (all deferred): library, ScrollTrigger, its data, the replayer.
 * @param {{ slug: string, anim?: { scrollTrigger?: boolean } }} page
 * @param {(file: string) => string} rel  the page-relative path of a site file
 */
export function animTags(page, rel) {
  if (!page.anim) return [];
  return [
    `${VENDOR_DIR}/gsap.min.js`,
    ...(page.anim.scrollTrigger ? [`${VENDOR_DIR}/ScrollTrigger.min.js`] : []),
    animDataFile(page.slug),
    REPLAY_FILE,
  ].map((f) => `  <script src="${rel(f)}" defer></script>`);
}
