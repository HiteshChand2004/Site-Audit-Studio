// @ts-check
// The video tier in the copy (CLONER_SPEC Phase 2 item 9): a self-running layer the copy cannot run - a canvas or WebGL
// background, a shape a script keeps reshaping, a Lottie animation whose JSON was not found - plays the recording the
// capture made of it (capture/videotier.js) in its place, while everything on top of it stays real HTML.
//
// It is "approximated" and reported as such, never passed off as copied. Islands do not exist yet (the "own site" switch
// is off), so a layer that is eligible always takes the video when it fits its budget.
//
// In the copy the layer's element becomes a <video> with the same class and box: muted, looping, inline, `preload="none"`,
// no autoplay. Its sources carry a media query - `(prefers-reduced-motion: no-preference)`, and the phone recording below
// the phone breakpoint - so a visitor who asks for less motion never downloads it and sees only the poster (the first
// frame). js/motion.js plays it once it comes near the window and pauses it when it leaves (lazy); without script the
// poster stands. WebM first, MP4 (H.264) second, never a GIF.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_BREAKPOINTS } from '../ir/index.js';
/** Where the capture lists a page's recordings (capture/videotier.js writes it beside the page's capture). */
export const videoIndexFile = 'video.json';

/** One video file larger than this is left out (its other format may still fit); over it on both, the layer stays a still. */
export const MAX_VIDEO_BYTES = 3 * 1024 * 1024;
/** What one view of a page may download for its videos (the larger format of each layer, summed). */
export const MAX_PAGE_VIDEO_BYTES = 8 * 1024 * 1024;
/** The phone recording plays below this width when the IR has no phone breakpoint. */
export const NARROW_DEFAULT = 767.98;

const isElement = (n) => n && !('text' in n);
const sha = (body) => createHash('sha256').update(body).digest('hex');

/** cpath → node of a page tree (the capture's own paths, with the alternatives a merge left). */
function nodesByPath(root) {
  const byPath = new Map();
  const walk = (n) => {
    if (!isElement(n)) return;
    for (const p of [n.cpath, ...(n.cpathAlt ?? [])]) if (p && !byPath.has(p)) byPath.set(p, n);
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  return byPath;
}

const within = (p, host) => p === host || p.startsWith(`${host}>`);

/**
 * Decides which recorded layers the copy plays as videos, copies their files into the assets and marks their nodes with
 * a `vN` motion token (so an as-is page, which keeps the original markup, gets them too). Eligible: recorded on desktop,
 * not driven by the visitor (no pointer follower, scroll-linked effect, hover or click control at or inside it), not a
 * Lottie the copy plays itself, present in the copy, within the size budget.
 * @param {{ pages: object[] }} site
 * @param {Map<string, object>} motionByPath  page path → its desktop motion.json
 * @param {{ dir: string, assetsDir: string, embedded?: Map<string, Set<string>> }} o  embedded: page path → Lottie container paths played as Lottie
 */
export async function planVideoTier(site, motionByPath, { dir, assetsDir, embedded = new Map() }) {
  const files = [];
  const rules = [];
  const entries = [];
  const skipped = [];
  const keep = async (src, name, ext, kind, mime) => {
    const body = await readFile(src);
    const sha256 = sha(body);
    const file = `${kind === 'image' ? 'images' : 'media'}/${name}-${sha256.slice(0, 10)}.${ext}`;
    await mkdir(path.join(assetsDir, path.dirname(file)), { recursive: true });
    await writeFile(path.join(assetsDir, file), body);
    files.push({ file, kind, mime, bytes: body.length, sha256, urls: [], generated: 'video-tier' });
    return file;
  };
  for (const t of site.pages) {
    const capDir = path.join(dir, 'capture', t.info.slug);
    const index = await readFile(path.join(capDir, videoIndexFile), 'utf8').then(JSON.parse, () => null);
    for (const s of index?.skipped ?? []) skipped.push({ page: t.info.path, ...s });
    if (!index?.layers?.length) continue;
    const motion = motionByPath.get(t.info.path) ?? {};
    // Driven by the visitor: what the pointer, the scroll, a hover or a click moves is not self-running.
    const driven = [
      ...(motion.pointer?.followers ?? []).map((f) => f.path),
      ...(motion.scrollLinked?.elements ?? []).map((e) => e.path),
      ...(motion.hover ?? []).map((h) => h.path),
      ...(motion.clicks?.widgets ?? []).flatMap((w) => [w.path, w.trigger]),
    ].filter(Boolean);
    const lottie = embedded.get(t.info.path) ?? new Set();
    const byPath = nodesByPath(t.root);
    const height = t.htmlNode?.views?.desktop?.rect?.[3] ?? t.root?.views?.desktop?.rect?.[3] ?? 0;
    const spent = { desktop: 0, mobile: 0 };
    for (const layer of index.layers) {
      const why = (reason, extra = {}) => skipped.push({ page: t.info.path, path: layer.path, kind: layer.kind, reason, ...extra });
      const desk = layer.views?.desktop;
      if ([...lottie].some((p) => within(layer.path, p) || within(p, layer.path))) {
        why('played-as-lottie');
        continue;
      }
      if (!desk?.files) {
        why('not-recorded', { error: desk?.error ?? 'missing' });
        continue;
      }
      if (driven.some((d) => within(d, layer.path))) {
        why('driven-by-the-visitor');
        continue;
      }
      const node = byPath.get(layer.path);
      if (!node) {
        why('not-in-copy');
        continue;
      }
      // Per file and per page: a format over its budget is left out; a layer with no format left, or a page whose videos
      // would exceed what one view may download, keeps the still frame (and the animated picture of a canvas).
      const pick = (v) => {
        if (!v?.files) return null;
        const kinds = ['webm', 'mp4'].filter((k) => v.files[k] && (v.bytes?.[k] ?? 0) <= MAX_VIDEO_BYTES);
        return kinds.length ? { v, kinds, cost: Math.max(...kinds.map((k) => v.bytes[k])) } : null;
      };
      const d = pick(desk);
      const m = pick(layer.views?.mobile);
      if (!d) {
        why('over-budget', { bytes: desk.bytes });
        continue;
      }
      if (spent.desktop + d.cost > MAX_PAGE_VIDEO_BYTES || (m && spent.mobile + m.cost > MAX_PAGE_VIDEO_BYTES)) {
        why('page-budget', { bytes: desk.bytes });
        continue;
      }
      spent.desktop += d.cost;
      if (m) spent.mobile += m.cost;
      const token = `v${rules.length + 1}`;
      const copy = async ({ v, kinds }, view) => {
        const out = { w: v.width, h: v.height, seamless: v.seamless, durationMs: v.durationMs, frames: v.frames };
        const name = `video-${t.info.slug}-${layer.id}-${view}`;
        for (const k of kinds) out[k] = await keep(path.join(capDir, v.files[k]), name, k, 'media', k === 'webm' ? 'video/webm' : 'video/mp4');
        out.poster = await keep(path.join(capDir, v.files.poster), `${name}-poster`, 'webp', 'image', 'image/webp');
        out.bytes = Object.fromEntries(kinds.map((k) => [k, v.bytes[k]]));
        return out;
      };
      const rule = { token, kind: layer.kind, page: t.info.path, path: layer.path, desktop: await copy(d, 'desktop'), mobile: m ? await copy(m, 'mobile') : null };
      rules.push(rule);
      node.motionTokens = [...new Set([...(node.motionTokens ?? []), token])];
      const box = desk.box ?? [0, 0, 0, 0];
      entries.push({
        page: t.info.path, path: layer.path, kind: layer.kind, token, reason: layer.kind === 'canvas' ? 'canvas drawn by script' : layer.kind === 'lottie' ? 'Lottie animation without its JSON' : `reshaped by script (${(layer.changed ?? []).join(', ')})`,
        formats: d.kinds, mobile: Boolean(m), seamless: desk.seamless, durationMs: desk.durationMs,
        bytes: { desktop: d.cost, mobile: m?.cost ?? 0 }, area: box[2] * box[3], pageArea: 1440 * height,
      });
    }
  }
  return { files, rules, entries, skipped };
}

/** The attributes of an inline SVG's root tag (raw markup), by name. */
function svgRootAttrs(raw) {
  const tag = /^<svg\b([^>]*)>/i.exec(String(raw ?? ''))?.[1] ?? '';
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/**
 * Turns every element of the IR that carries a `vN` token into its video (both a rebuilt page and an as-is one: the token
 * travels with the element). Keeps its id, class and box (width / height / style); everything the element drew is in the
 * recording. Returns how many elements became videos.
 * @param {{ pages: object[], breakpoints?: { mobile?: number } }} ir
 * @param {object[]} rules  planVideoTier's rules
 */
export function applyVideoTier(ir, rules) {
  if (!rules?.length) return 0;
  const byToken = new Map(rules.map((r) => [r.token, r]));
  const narrow = `(max-width: ${ir.breakpoints?.mobile ?? NARROW_DEFAULT}px)`;
  const calm = '(prefers-reduced-motion: no-preference)';
  let made = 0;
  const convert = (n) => {
    if (!n || 'text' in n) return;
    const own = n.t === 'svg' && n.raw ? svgRootAttrs(n.raw) : null;
    const tokens = String(n.attrs?.['data-motion'] ?? own?.['data-motion'] ?? '').split(/\s+/);
    const rule = tokens.map((t) => byToken.get(t)).find(Boolean);
    if (!rule) {
      for (const c of n.children ?? []) convert(c);
      return;
    }
    const from = { ...(own ?? {}), ...(n.attrs ?? {}) };
    const attrs = {};
    // The box: what sized the element sizes the video (a canvas's width / height attributes are its size the same way).
    for (const k of ['width', 'height', 'style', 'title']) if (from[k] != null && from[k] !== '') attrs[k] = from[k];
    for (const [k, v] of Object.entries(from)) if (/^data-(motion|sas-|w-)/.test(k)) attrs[k] = v;
    Object.assign(attrs, {
      muted: '', loop: '', playsinline: '', preload: 'none', 'aria-hidden': 'true', tabindex: '-1',
      poster: { asset: rule.desktop.poster }, 'data-w-video': rule.token,
      ...(rule.mobile && { 'data-poster-narrow': { asset: rule.mobile.poster }, 'data-narrow': narrow }),
    });
    const source = (v, media) => ['webm', 'mp4'].filter((k) => v[k]).map((k) => ({ t: 'source', attrs: { src: { asset: v[k] }, type: k === 'webm' ? 'video/webm' : 'video/mp4', media }, children: [] }));
    n.t = 'video';
    delete n.raw;
    if (own?.class && !n.class) n.class = own.class;
    // The box the rebuilt copy gave the layer (its class rules, view by view), kept on the rule: an as-is page styles the
    // element with the site's own sheets, whose selectors may name its tag (`.hero canvas`) and so miss the video.
    if (n.cpath === undefined && n.class && !rule.box) {
      const classes = new Set(String(n.class).split(/\s+/).filter(Boolean).map((c) => `.${c}`));
      const parts = (ir.rules ?? []).filter((r) => classes.has(r.selector)).map((r) => r.parts);
      if (parts.length) {
        const merge = (view) => Object.assign({}, ...parts.map((p) => p[view] ?? {}));
        rule.box = {
          base: merge('base'),
          media: [...new Set(parts.flatMap((p) => Object.keys(p)))].filter((v) => v !== 'base')
            .map((v) => ({ view: v, maxWidth: ir.breakpoints?.[v] ?? DEFAULT_BREAKPOINTS[v], decls: merge(v) }))
            .filter((m) => typeof m.maxWidth === 'number' && Object.keys(m.decls).length)
            .sort((a, b) => b.maxWidth - a.maxWidth),
        };
      }
    }
    n.attrs = attrs;
    n.children = [...(rule.mobile ? source(rule.mobile, `${calm} and ${narrow}`) : []), ...source(rule.desktop, calm)];
    made++;
  };
  for (const p of ir.pages) convert(p.body);
  return made;
}

/** The stylesheet part of the video tier: the recording fills the element's box exactly as the layer drew it. */
export function videoCss(rules, { asis = false, D = null } = {}) {
  if (!rules?.length) return '';
  const sel = (r) => `video[data-w-video="${r.token}"]`;
  const all = rules.map(sel).join(',\n');
  // A reshaped element's own look (its radius, background, shadow, opacity) is in the recording already: drawn again on
  // the video it would cut or fade the recording twice.
  const layers = rules.filter((r) => r.kind !== 'canvas').map(sel);
  // An as-is page: the box the rebuilt copy measured for the layer, view by view (applyVideoTier `box`), since the site's
  // own rules may select the element by the tag it no longer has. A rebuilt page has it through the element's class.
  const boxes = asis && D ? rules.filter((r) => r.box).flatMap((r) => {
    const out = [];
    const base = D(r.box.base, '  ');
    if (base) out.push(`${sel(r)} {\n${base}\n}`);
    for (const m of r.box.media ?? []) {
      const body = D(m.decls, '    ');
      if (body) out.push(`@media (max-width: ${m.maxWidth}px) {\n  ${sel(r)} {\n${body}\n  }\n}`);
    }
    return out;
  }) : [];
  return [
    ...boxes,
    '/* Video tier: recordings of self-running layers (approximated; text and controls stay HTML on top) */',
    `${all} {\n  object-fit: fill;\n  pointer-events: none;\n}`,
    ...(layers.length ? [`${layers.join(',\n')} {\n  border-radius: 0 !important;\n  background: none !important;\n  box-shadow: none !important;\n  clip-path: none !important;\n  mask: none !important;\n  filter: none !important;\n  opacity: 1 !important;\n  animation: none !important;\n}`] : []),
  ].join('\n');
}

/**
 * The share of each page that is clean code, approximated (a recording standing in for a layer) and islands (none yet),
 * by area of the desktop page: what a visitor sees as recorded rather than rebuilt.
 * @returns {Record<string, { clean: number, approximated: number, islands: number, basis: string }>}
 */
export function compositionOf(site, entries) {
  const out = {};
  for (const t of site.pages) {
    const mine = entries.filter((e) => e.page === t.info.path);
    const pageArea = mine[0]?.pageArea || 0;
    const area = mine.reduce((s, e) => s + e.area, 0);
    const approximated = pageArea ? Math.min(100, Math.round((area / pageArea) * 1000) / 10) : 0;
    out[t.info.path] = { clean: Math.round((100 - approximated) * 10) / 10, approximated, islands: 0, basis: 'share of the desktop page area (1440 px wide)' };
  }
  return out;
}
