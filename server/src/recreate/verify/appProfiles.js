// What an app build (a stack with JavaScript) may contain, per framework. The plain-HTML build may contain
// no script at all; an app may run its own bundles and nothing else.
//   scriptAllowed   a <script> element that is the framework's own: a bundle file under its folder, or (Next.js)
//                   an inline data push whose argument is a JSON array
//   bundleLink      a <link rel=modulepreload> must point into the bundle folder
//   jsAllow         script sinks the framework's runtime itself contains (see checkScript); everything else is banned
//   contentChunk    chunk files that carry the site's own text (skipped by the sink scan: covered by the DOM equivalence)

import { createHash } from 'node:crypto';
import { vendorHashes } from '../emit/anim.js';
import { LIFT_FILE, LIFTABLE_LIBS } from '../behavior/lift.js';

const LIFT_SCRIPT = /^(\.\.\/)*js\/lift\/[a-z0-9-]+-[0-9a-f]{10}\.js$/;
/** A lifted file: a known library's name and the start of its own sha256. Null = not a lifted file's path. */
function liftedOk(rel, content) {
  const m = LIFT_FILE.exec(rel);
  if (!m) return null;
  return LIFTABLE_LIBS.has(m[1]) && createHash('sha256').update(content).digest('hex').startsWith(m[2]);
}

const VITE_BUNDLE = /^\/_app\/[\w.-]+\.js$/;
const ASTRO_BUNDLE = /^\/_astro\/[\w.-]+\.js$/;
// SvelteKit's bundles, linked relative to the page (./_app/…, ../_app/…), and the one inline script it starts every page
// with: the app's base taken from the page's own address, then its two entry bundles imported and started with the page's
// nodes. Held to that exact shape (a site without load functions has no data: every node's is null).
const SVELTEKIT_BUNDLE = /^(\.\.?\/)+_app\/immutable\/[\w./-]+\.js$/;
const SVELTEKIT_REL = '(?:\\.\\.?\\/)+_app\\/immutable\\/entry\\/';
const SVELTEKIT_BOOT = new RegExp([
  '^\\{', '__sveltekit_(\\w+)=\\{base:newURL\\("\\.(?:\\.(?:\\/\\.\\.)*)?",location\\)\\.pathname\\.slice\\(0,-1\\),version:"\\d+"\\};',
  'constelement=document\\.currentScript\\.parentElement;',
  `import\\("${SVELTEKIT_REL}start\\.[\\w-]+\\.js"\\)\\.then\\(async\\(kit\\)=>\\{kit\\.init\\(__sveltekit_\\1\\);`,
  `constapp=awaitimport\\("${SVELTEKIT_REL}app\\.[\\w-]+\\.js"\\);`,
  'kit\\.start\\(app,element,\\{node_ids:\\[\\d+(?:,\\d+)*\\],data:\\[null(?:,null)*\\],form:null,error:null\\}\\);\\}\\);\\}$',
].join(''));
/** SvelteKit's start-up script, with white space removed (the shape is checked, not the formatting). */
const svelteKitBoot = (/** @type {string} */ text) => SVELTEKIT_BOOT.test(text.replace(/\s+/g, ''));
const NEXT_BUNDLE = /^\/_next\/static\/[\w./()%@~-]+\.js$/;
// (self.__next_f = self.__next_f || []).push([...])  /  self.__next_f.push([...])
const NEXT_PUSH = /^\s*(?:\(\s*self\.__next_f\s*=\s*self\.__next_f\s*\|\|\s*\[\]\s*\)|self\.__next_f)\.push\(([\s\S]*)\)\s*;?\s*$/;

function jsonArray(text) {
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false;
  }
}

// The plain-HTML build with scroll reveal (emit/motionScript.js): the one fixed script `js/motion.js`, loaded by <script src defer>
// from each page (a relative path), and nothing else.
const MOTION_SCRIPT = /^(\.\.\/)*js\/motion\.js$/;
// The animation library's replay (emit/anim.js) and Framer appear entrances (behavior/framer/emit.js): the pinned libraries
// (accepted only byte for byte), the fixed replayers, their data.
// Lottie animations (behavior/lottie.js) the same way: the vendored lottie-web build, the fixed player, the page's data.
const ANIM_SCRIPT = /^(\.\.\/)*js\/(vendor\/((gsap|ScrollTrigger|lottie_light)\.min|motion)\.js|((anim|appear)-replay|lottie-play)\.js|(anim|appear|lottie)\/[\w.-]+\.js)$/;
const ANIM_FILE = /^js\/(((anim|appear)-replay|lottie-play)\.js|(anim|appear|lottie)\/[\w.-]+\.js)$/;
// The app stacks (React + Vite, Next.js, MERN) serve the same file from the site root, and may carry it next to their bundles.
const MOTION_ROOT = '/js/motion.js';

// A site written by build mode's agent (buildmode/agent.js): its own scripts, as local files under js/ loaded by <script src>
// (deferred or as modules), never inline, never from another origin; every one sink-scanned like the stacks' bundles.
const BUILT_SCRIPT = /^(\/|(\.\.\/)*)js\/[\w-]+(\/[\w-]+)*\.m?js$/;

export const APP_PROFILES = {
  // Astro (Build mode): the site's own <script>s, bundled into /_astro/ files; nothing inline.
  astro: {
    bundleLink: ASTRO_BUNDLE,
    scriptAllowed: ({ src, type, text }) => !text.trim() && type === 'module' && ASTRO_BUNDLE.test(src ?? ''),
    jsAllow: [],
    contentChunk: () => false,
  },
  sveltekit: {
    bundleLink: SVELTEKIT_BUNDLE,
    scriptAllowed: ({ src, type, text }) => !src && !type && svelteKitBoot(text),
    // SvelteKit's client router loads the site's own pages' data with fetch(), like Next's. The site's own code is held to
    // no fetch before it is built (buildmode/project.js checkSource), so a fetch in the bundles is the framework's.
    jsAllow: ['fetch()'],
    contentChunk: () => false,
  },
  built: {
    bundleLink: BUILT_SCRIPT,
    scriptAllowed: ({ src, type, text }) => !text.trim() && (!type || type === 'module' || type === 'text/javascript') && BUILT_SCRIPT.test(src ?? ''),
    jsAllow: [],
    contentChunk: () => false,
    onlyFile: (rel) => /^js\/[\w-]+(\/[\w-]+)*\.m?js$/.test(rel),
  },
  motion: {
    bundleLink: /$^/,
    scriptAllowed: ({ src, type, text }) => !type && (MOTION_SCRIPT.test(src ?? '') || ANIM_SCRIPT.test(src ?? '') || LIFT_SCRIPT.test(src ?? '')) && !text.trim(),
    // A lifted library of the original (behavior/lift.js): accepted only when its name is a known library and the first
    // 10 hex of its own sha256 (checked by verify/safety.js), never scanned or edited.
    lifted: liftedOk,
    jsAllow: [],
    contentChunk: () => false,
    // Only these files may be JavaScript at all: the generated script, the replayer and its data (sink-scanned), and the
    // vendored library (`vendor`: accepted only when it is exactly the pinned package's file, never scanned or edited).
    onlyFile: (rel) => rel === 'js/motion.js' || ANIM_FILE.test(rel),
    vendor: vendorHashes,
  },
  vite: {
    bundleLink: VITE_BUNDLE,
    scriptAllowed: ({ src, type, text }) => !text.trim() && ((type === 'module' && VITE_BUNDLE.test(src ?? '')) || (!type && src === MOTION_ROOT)),
    jsAllow: [],
    contentChunk: () => false,
    // The original's lifted libraries (public/js/lift/), injected after mount by SiteScripts: name + own hash, as in HTML.
    lifted: liftedOk,
  },
  next: {
    bundleLink: NEXT_BUNDLE,
    scriptAllowed: ({ src, type, text }) => {
      if (src) return !type && (NEXT_BUNDLE.test(src) || src === MOTION_ROOT) && !text.trim();
      const m = NEXT_PUSH.exec(text);
      return !type && Boolean(m) && jsonArray(m[1]);
    },
    // Next's client router fetches same-origin pages and its polyfills feature-detect XMLHttpRequest. The exported
    // pages use plain <a> links, so neither runs on navigation; both are the framework's, not the site's.
    jsAllow: ['fetch()', 'XMLHttpRequest'],
    contentChunk: (rel) => rel.startsWith('_next/static/chunks/app/'),
    lifted: liftedOk,
  },
};

/** `true` (the first app profile) or a profile name → the profile; anything else → null. */
export const appProfile = (app) => (app === true ? APP_PROFILES.vite : APP_PROFILES[app] ?? null);
