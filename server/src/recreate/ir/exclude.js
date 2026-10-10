// The parts of a page that are not the site: the builder's own badge, a consent banner, a chat bubble bolted on by
// another company. A copy that keeps them is wrong twice - it shows someone else's branding, and it reports pixels
// that differ because the original's banner was dismissed on one visit and not on another.
//
// No selector lists, no brand names, no per-site rules. Every exclusion is decided from evidence the capture already
// measured, and every one is reported with that evidence so it can be argued with:
//
// - **A builder's badge**: pinned to a corner of the window, small, and it links to or loads from the host of the
//   platform the site was detected as. The host comes from `cleanup.cdnHosts` in detection/rules/<platform>.json,
//   which is where this project already keeps platform knowledge - so a new platform file teaches this too.
// - **A consent banner**: fixed at an edge of the window or covering it, *and* the click probe found a control of
//   its own whose click made it go away and not come back. That second half is what separates a cookie bar from a
//   sticky header: the page itself treats it as something to dismiss.
// - **A chat or booking bubble**: pinned to a corner and drawn by a frame from another company that is not one of
//   the embeds a page means to show (a video, a map, a calendar). An unknown third-party frame is **kept and
//   reported**, never removed: being unsure is not a reason to delete someone's content.
//
// What is excluded is excluded from both sides of the comparison - the copy does not carry it, and the area it
// occupied in the original is masked - so an exclusion can never be the reason a slot fails.
import { PLATFORM_CDN_HOSTS, platformCdnHost } from '../assets/cdn.js';

/** A badge or bubble lives in a corner of the window, and is small. */
export const CORNER_MAX = 420;
/** A banner spans most of the window at an edge of it, or covers the whole of it. */
export const BANNER_SPAN = 0.6;
/** Services a page embeds on purpose. Kinds of service, not sites: an unknown frame is kept, not removed. */
export const EMBED_HOSTS = [
  'youtube.com', 'youtube-nocookie.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com', 'dailymotion.com',
  'google.com/maps', 'maps.google.com', 'openstreetmap.org', 'mapbox.com',
  'calendly.com', 'cal.com', 'hsforms.net', 'docs.google.com', 'forms.gle',
  'soundcloud.com', 'spotify.com', 'open.spotify.com', 'instagram.com', 'x.com', 'twitter.com', 'platform.twitter.com',
  'codepen.io', 'codesandbox.io', 'figma.com', 'loom.com', 'wistia.net', 'typeform.com', 'airtable.com',
];

const hostOf = (url) => {
  try {
    return new URL(url, 'https://example.invalid').hostname.toLowerCase();
  } catch {
    return null;
  }
};

const isEmbed = (url) => {
  const host = hostOf(url);
  if (!host) return false;
  return EMBED_HOSTS.some((h) => {
    const bare = h.split('/')[0];
    return host === bare || host.endsWith(`.${bare}`);
  });
};

/** Every URL this subtree points at or loads from. */
function urlsIn(node, out = [], depth = 0) {
  if (!node?.tag || depth > 6) return out;
  for (const key of ['href', 'src', 'data-src', 'poster']) {
    const value = node.attrs?.[key];
    if (value) out.push(value);
  }
  for (const v of Object.values(node.views ?? {})) {
    const image = v?.style?.['background-image'];
    if (image) for (const m of image.matchAll(/url\(["']?([^"')]+)/g)) out.push(m[1]);
  }
  for (const child of node.children ?? []) urlsIn(child, out, depth + 1);
  return out;
}

const framesIn = (node, out = [], depth = 0) => {
  if (!node?.tag || depth > 6) return out;
  if (node.tag === 'iframe' && node.attrs?.src) out.push(node.attrs.src);
  for (const child of node.children ?? []) framesIn(child, out, depth + 1);
  return out;
};

const textOf = (node, depth = 0) => {
  if (!node || depth > 6) return '';
  if (node.text) return node.text;
  return (node.children ?? []).map((c) => textOf(c, depth + 1)).join(' ');
};

/** Where this box sits in the window, from the view it is widest in. */
function placement(node, viewWidths) {
  for (const [view, width] of Object.entries(viewWidths)) {
    const v = node.views?.[view];
    if (!v?.rect) continue;
    const position = v.style?.position;
    if (position !== 'fixed' && position !== 'sticky') continue;
    const [x, y, w, h] = v.rect;
    return {
      view,
      fixed: true,
      small: w <= CORNER_MAX && h <= CORNER_MAX,
      // An edge band, or something covering the window: what a consent bar and a scrim look like.
      spans: w >= width * BANNER_SPAN,
      corner: x + w >= width - CORNER_MAX || x <= CORNER_MAX,
      rect: v.rect,
    };
  }
  return null;
}

/**
 * @param {object} tree  a page tree (ir/tree.js)
 * @param {{ platforms?: string[], dismissed?: Set<string>, viewWidths?: object, hosts?: string[] }} o
 *   dismissed: paths of controls whose click made something go away for good (capture/clicks.js)
 * @returns {{ path: string, reason: string, evidence: string, rect: number[]|null, text: string }[]}
 */
export function findExcludable(tree, { dismissed = new Set(), viewWidths = { desktop: 1440 }, hosts = PLATFORM_CDN_HOSTS } = {}) {
  const out = [];
  const walk = (node) => {
    if (!node?.tag) return;
    const place = placement(node, viewWidths);
    if (place) {
      const urls = urlsIn(node);
      const frames = framesIn(node);
      const text = textOf(node).replace(/\s+/g, ' ').trim().slice(0, 60);
      const platformUrl = urls.map((u) => platformCdnHost(u, hosts)).find(Boolean);

      if (place.small && place.corner && platformUrl) {
        out.push({ path: node.cpath ?? node.path, reason: 'builder-badge', evidence: `pinned to a corner and points at ${platformUrl}`, rect: place.rect, text });
      } else if (place.spans && [...dismissed].some((p) => String(p).startsWith(String(node.cpath ?? node.path)))) {
        out.push({ path: node.cpath ?? node.path, reason: 'consent-banner', evidence: 'fixed across the window, and a control inside it made it go away for good', rect: place.rect, text });
      } else if (place.small && place.corner && frames.length && frames.every((f) => !isEmbed(f))) {
        const host = hostOf(frames[0]);
        out.push({ path: node.cpath ?? node.path, reason: 'chat-widget', evidence: `pinned to a corner and drawn by a frame from ${host}`, rect: place.rect, text });
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree.root);
  // A parent that is excluded takes its children with it; no need to list both.
  return out.filter((e, i) => !out.some((other, j) => j !== i && e.path !== other.path && String(e.path).startsWith(`${other.path}>`)));
}

/** Removes them from the tree. Returns what was removed, for the report. */
export function applyExcludes(tree, list) {
  const paths = new Set(list.map((e) => e.path));
  if (!paths.size) return [];
  const removed = [];
  const walk = (node) => {
    if (!node?.children) return;
    node.children = node.children.filter((child) => {
      const path = child.cpath ?? child.path;
      if (path && paths.has(path)) {
        removed.push(path);
        return false;
      }
      return true;
    });
    for (const child of node.children) walk(child);
  };
  walk(tree.root);
  return removed;
}
