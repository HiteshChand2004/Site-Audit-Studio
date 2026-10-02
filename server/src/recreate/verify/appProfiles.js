// What an app build (a stack with JavaScript) may contain, per framework. The plain-HTML build may contain
// no script at all; an app may run its own bundles and nothing else.
//   scriptAllowed   a <script> element that is the framework's own: a bundle file under its folder, or (Next.js)
//                   an inline data push whose argument is a JSON array
//   bundleLink      a <link rel=modulepreload> must point into the bundle folder
//   jsAllow         script sinks the framework's runtime itself contains (see checkScript); everything else is banned
//   contentChunk    chunk files that carry the site's own text (skipped by the sink scan: covered by the DOM equivalence)

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
// The app stacks (React + Vite, Next.js, MERN) serve the same file from the site root, and may carry it next to their bundles.
const MOTION_ROOT = '/js/motion.js';

export const APP_PROFILES = {
  motion: {
    bundleLink: /$^/,
    scriptAllowed: ({ src, type, text }) => !type && MOTION_SCRIPT.test(src ?? '') && !text.trim(),
    jsAllow: [],
    contentChunk: () => false,
    // Only this file may be JavaScript at all.
    onlyFile: 'js/motion.js',
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
