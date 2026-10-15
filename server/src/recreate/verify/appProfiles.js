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
const ANIM_SCRIPT = /^(\.\.\/)*js\/(vendor\/((gsap|ScrollTrigger)\.min|motion)\.js|(anim|appear)-replay\.js|(anim|appear)\/[\w.-]+\.js)$/;
const ANIM_FILE = /^js\/((anim|appear)-replay\.js|(anim|appear)\/[\w.-]+\.js)$/;
// The app stacks (React + Vite, Next.js, MERN) serve the same file from the site root, and may carry it next to their bundles.
const MOTION_ROOT = '/js/motion.js';

export const APP_PROFILES = {
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
  },
};

/** `true` (the first app profile) or a profile name → the profile; anything else → null. */
export const appProfile = (app) => (app === true ? APP_PROFILES.vite : APP_PROFILES[app] ?? null);
