// @ts-check
// Framer's appear animations (CLONER_SPEC Phase 2A item 2), read from the page's own server-rendered HTML.
//
// A Framer page is rendered on the server with every element that "appears" already in its first pose (inline
// `opacity: 0.001; transform: translateY(10px)`) and marked `data-framer-appear-id="<id>"`. The settings of each
// entrance travel in the same HTML, as JSON in an inert script the runtime reads before hydration. Seen on real pages
// (2026-10):
//
//   <script type="framer/appear" id="__framer__breakpoints">[{"hash":"72rtr7","mediaQuery":"(min-width: 1200px)"}, …]</script>
//   <script type="framer/appear" id="__framer__appearAnimationsContent">
//     {"9sv04s":{"default":{"initial":{"opacity":0.001,"x":0,"y":10,"scale":1,"rotate":0,…},
//                           "animate":{"opacity":1,"x":0,"y":0,…,"transition":{"delay":0.35,"duration":0.45,"ease":[0.2,0,0,1],"type":"tween"}}},
//                "112t26v":{…same shape, for the breakpoint whose hash this is…}}, …}
//   </script>
//
// One entry per appear id; under it one spec per breakpoint hash, `default` for the rest. A spec of `null` means "no
// entrance at this breakpoint". Transitions are tweens (duration / delay / ease as a cubic-bezier array or a name) or
// springs, given either physically (stiffness / damping / mass) or perceptually (bounce / duration). A spec may carry a
// `transformTemplate` with a placeholder the runtime fills with the animated transform (an element centred by its own
// transform keeps it while it moves).
//
// The format is Framer's, not a public contract, so this reader is tolerant: the config is looked for by what it holds
// (an inert script whose JSON maps ids to {initial, animate}), not only by its current id; an older shape without the
// breakpoint level ({id: {initial, animate}}) and keyframe arrays are accepted; a spec that names `whileInView` (or says
// its trigger is the element coming into view) is an in-view entrance. Anything not understood is reported with the
// reason and never throws: the element then falls back to being shown as it ends (behavior/framer/plan.js).
import { load } from 'cheerio';

export const APPEAR_ATTR = 'data-framer-appear-id';
export const CONFIG_ID = '__framer__appearAnimationsContent';
export const BREAKPOINTS_ID = '__framer__breakpoints';
/** Framer's placeholder in a transformTemplate (the runtime passes it to its appear script). */
export const TRANSFORM_PLACEHOLDER = '__Appear_Animation_Transform__';

/** Transform shorthands, in the order motion (and Framer) compose them into one `transform`. */
export const TRANSFORM_ORDER = ['transformPerspective', 'x', 'y', 'z', 'translateX', 'translateY', 'translateZ', 'scale', 'scaleX', 'scaleY',
  'rotate', 'rotateX', 'rotateY', 'rotateZ', 'skew', 'skewX', 'skewY'];
const TRANSFORM_KEYS = new Set(TRANSFORM_ORDER);
/** The value each transform shorthand has when it does nothing. */
const IDENTITY = { scale: 1, scaleX: 1, scaleY: 1 };
/** Transition keys of a tween / spring this reader understands; anything else is kept under `extra` and reported. */
const TWEEN_KEYS = new Set(['type', 'duration', 'delay', 'ease', 'repeat', 'repeatType', 'repeatDelay', 'times']);
const SPRING_KEYS = new Set(['stiffness', 'damping', 'mass', 'bounce', 'velocity', 'restDelta', 'restSpeed', 'visualDuration']);
/** Style properties an appear spec may animate besides opacity and the transform (passed to the browser as they are). */
const STYLE_KEY = /^[a-z][a-zA-Z]*$/;
const MAX_ENTRIES = 2000;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isValue = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200 && !/[<>;{}]|url\(|expression/i.test(v));
const isKeyframes = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every((x) => x === null || isValue(x));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?[\d.]+$/.test(v.trim()) ? Number(v) : null);

/**
 * The inert scripts of a page that may hold appear settings: Framer's own ids first, then any non-JavaScript script
 * whose body is a JSON object (a renamed config is still found by what it holds).
 * @param {string} html
 * @returns {{ config: { text: string, source: string }[], breakpoints: string | null }}
 */
export function findAppearScripts(html) {
  const out = { config: [], breakpoints: null };
  if (typeof html !== 'string' || !html.includes('appear')) return out;
  const $ = load(html);
  $('script').each((_, el) => {
    const s = $(el);
    const id = s.attr('id') ?? '';
    const type = (s.attr('type') ?? '').toLowerCase();
    const text = s.text().trim();
    if (!text) return;
    if (id === BREAKPOINTS_ID || /breakpoints/i.test(id)) {
      out.breakpoints ??= text;
      return;
    }
    if (id === CONFIG_ID) return void out.config.unshift({ text, source: `script#${id}` });
    // Executable JavaScript is never a config (the runtime's own appear script names the id but is code).
    const inert = type && !/^(text\/javascript|application\/javascript|module|text\/babel)$/.test(type);
    if ((inert || /appear/i.test(id)) && text.startsWith('{') && /"(initial|animate)"/.test(text)) out.config.push({ text, source: id ? `script#${id}` : `script[type=${type}]` });
  });
  return out;
}

/** `[{ hash, media }]` from Framer's breakpoint list; [] when absent or not understood. */
export function parseBreakpoints(text) {
  if (!text) return [];
  try {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return [];
    return list
      .filter((b) => isObject(b) && typeof b.hash === 'string' && /^[\w-]{1,40}$/.test(b.hash))
      .map((b) => ({ hash: b.hash, media: typeof b.mediaQuery === 'string' && b.mediaQuery.length <= 300 && !/[<>{};]/.test(b.mediaQuery) ? b.mediaQuery : null }));
  } catch {
    return [];
  }
}

/**
 * One state (`initial` or `animate`) as plain values: numbers, short CSS strings or keyframe arrays, by property.
 * Returns null when nothing in it is usable.
 */
function normalizeState(raw, dropped) {
  if (!isObject(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'transition' || k === 'transitionEnd') continue;
    if (!STYLE_KEY.test(k)) {
      dropped.push(k);
      continue;
    }
    if (isValue(v) || isKeyframes(v)) out[k] = v;
    else dropped.push(k);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A transition as `{ type, duration?, delay, ease?, spring? }`: a tween keeps its duration (s) and ease (a cubic-bezier
 * array or a name), a spring its physical (stiffness / damping / mass) or perceptual (bounce / duration) settings. Keys
 * not understood are kept under `extra`; per-property transitions (`{ opacity: {...} }`) under `properties`.
 */
export function normalizeTransition(raw) {
  const t = isObject(raw) ? raw : {};
  const out = { type: 'tween', delay: Math.max(0, num(t.delay) ?? 0) };
  const springy = t.type === 'spring' || ['stiffness', 'damping', 'mass', 'bounce'].some((k) => k in t);
  if (springy) {
    out.type = 'spring';
    const spring = {};
    for (const k of SPRING_KEYS) if (num(t[k]) != null) spring[k] = num(t[k]);
    // Perceptual spring: its duration belongs to the spring (motion and Framer read it the same way, in seconds).
    if (num(t.duration) != null) spring.duration = num(t.duration);
    out.spring = spring;
  } else {
    if (typeof t.type === 'string' && t.type !== 'tween' && t.type !== 'keyframes') out.type = t.type;
    out.duration = Math.max(0, num(t.duration) ?? 0.3);
    if (Array.isArray(t.ease) && t.ease.length === 4 && t.ease.every((x) => num(x) != null)) out.ease = t.ease.map(Number);
    else if (typeof t.ease === 'string' && /^[a-zA-Z]{1,24}$/.test(t.ease)) out.ease = t.ease;
    else if (Array.isArray(t.ease) && t.ease.length && t.ease.length <= 20) {
      // One easing per keyframe segment.
      const list = t.ease.filter((e) => (Array.isArray(e) && e.length === 4 && e.every((x) => num(x) != null)) || (typeof e === 'string' && /^[a-zA-Z]{1,24}$/.test(e)));
      if (list.length === t.ease.length) out.ease = list;
    }
    if (Array.isArray(t.times) && t.times.every((x) => num(x) != null)) out.times = t.times.map(Number);
  }
  for (const k of ['repeat', 'repeatDelay']) if (num(t[k]) != null) out[k] = num(t[k]);
  if (typeof t.repeatType === 'string' && /^(loop|reverse|mirror)$/.test(t.repeatType)) out.repeatType = t.repeatType;
  const extra = {};
  const properties = {};
  for (const [k, v] of Object.entries(t)) {
    if (TWEEN_KEYS.has(k) || SPRING_KEYS.has(k)) continue;
    if (isObject(v) && STYLE_KEY.test(k)) properties[k] = normalizeTransition(v);
    else extra[k] = v;
  }
  if (Object.keys(properties).length) out.properties = properties;
  if (Object.keys(extra).length) out.extra = Object.keys(extra);
  return out;
}

/** In-view: the spec says so (`whileInView`, a trigger naming the view, viewport options); else on load. */
function triggerOf(spec) {
  if (isObject(spec.whileInView)) return 'inView';
  const t = String(spec.trigger ?? spec.appearTrigger ?? '').toLowerCase();
  if (/view|scroll|visible/.test(t)) return 'inView';
  return 'load';
}

/**
 * One spec (`{ initial, animate | whileInView, transformTemplate? }`) normalised, or `{ error }` with the reason.
 * @returns {{ initial: object, animate: object, transition: object, trigger: 'load' | 'inView', viewport?: object, transformTemplate?: string, dropped?: string[] } | { error: string }}
 */
export function normalizeSpec(spec) {
  if (!isObject(spec)) return { error: `not an object (${spec === null ? 'null' : Array.isArray(spec) ? 'array' : typeof spec})` };
  const trigger = triggerOf(spec);
  const target = trigger === 'inView' && isObject(spec.whileInView) ? spec.whileInView : spec.animate;
  const dropped = [];
  const initial = normalizeState(spec.initial, dropped);
  const animate = normalizeState(target, dropped);
  if (!initial) return { error: 'no usable initial state' };
  if (!animate) return { error: 'no usable target state' };
  const out = { initial, animate, transition: normalizeTransition(target?.transition ?? spec.transition), trigger };
  if (trigger === 'inView' && isObject(spec.viewport)) {
    const v = {};
    if (typeof spec.viewport.once === 'boolean') v.once = spec.viewport.once;
    if (num(spec.viewport.amount) != null) v.amount = num(spec.viewport.amount);
    else if (spec.viewport.amount === 'all' || spec.viewport.amount === 'some') v.amount = spec.viewport.amount;
    if (typeof spec.viewport.margin === 'string' && /^[-\d.px%\s]{1,60}$/.test(spec.viewport.margin)) v.margin = spec.viewport.margin;
    out.viewport = v;
  }
  if (typeof spec.transformTemplate === 'string' && spec.transformTemplate.length <= 300 && !/[<>;{}]|url\(/i.test(spec.transformTemplate)) out.transformTemplate = spec.transformTemplate;
  if (dropped.length) out.dropped = dropped;
  return out;
}

const looksLikeSpec = (v) => isObject(v) && ('initial' in v || 'animate' in v || 'whileInView' in v);

/**
 * Every appear entry of a page's raw HTML, normalised. Never throws.
 * @param {string} html  the document as the server sent it (before any script ran)
 * @returns {{
 *   found: boolean, source: string | null, breakpoints: { hash: string, media: string | null }[],
 *   entries: { appearId: string, variant: string, initial: object, animate: object, transition: object, trigger: 'load' | 'inView', media: string | null, viewport?: object, transformTemplate?: string, dropped?: string[] }[],
 *   off: { appearId: string, variant: string }[],
 *   unknown: { appearId: string | null, variant: string | null, reason: string }[]
 * }}
 */
export function parseAppearConfig(html) {
  const result = { found: false, source: null, breakpoints: [], entries: [], off: [], unknown: [] };
  let scripts;
  try {
    scripts = findAppearScripts(html);
  } catch (err) {
    result.unknown.push({ appearId: null, variant: null, reason: `the page could not be read (${String(err?.message ?? err).slice(0, 120)})` });
    return result;
  }
  result.breakpoints = parseBreakpoints(scripts.breakpoints);
  const mediaOf = new Map(result.breakpoints.map((b) => [b.hash, b.media]));
  for (const { text, source } of scripts.config) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      result.unknown.push({ appearId: null, variant: null, reason: `${source} is not valid JSON (${String(err?.message ?? err).slice(0, 120)})` });
      continue;
    }
    if (!isObject(json)) {
      result.unknown.push({ appearId: null, variant: null, reason: `${source} is not an object` });
      continue;
    }
    result.found = true;
    result.source ??= source;
    for (const [appearId, raw] of Object.entries(json).slice(0, MAX_ENTRIES)) {
      if (result.entries.some((e) => e.appearId === appearId) || result.off.some((e) => e.appearId === appearId)) continue;
      if (!/^[\w-]{1,64}$/.test(appearId)) {
        result.unknown.push({ appearId: appearId.slice(0, 64), variant: null, reason: 'an id the page could not carry' });
        continue;
      }
      // The older shape: the spec itself, with no breakpoint level.
      const variants = looksLikeSpec(raw) ? { default: raw } : raw;
      if (!isObject(variants)) {
        result.unknown.push({ appearId, variant: null, reason: `not an object (${raw === null ? 'null' : typeof raw})` });
        continue;
      }
      for (const [variant, spec] of Object.entries(variants)) {
        if (spec === null) {
          result.off.push({ appearId, variant });
          continue;
        }
        const n = normalizeSpec(spec);
        if ('error' in n) {
          result.unknown.push({ appearId, variant, reason: n.error });
          continue;
        }
        const legacy = isObject(spec) && spec.legacy === true;
        result.entries.push({ appearId, variant, media: variant === 'default' ? null : mediaOf.get(variant) ?? null, ...(legacy && { legacy: true }), ...n });
      }
    }
  }
  return result;
}

// ---- the copy's keyframes ---------------------------------------------------------------------------------------------

const unit = (key, v) => {
  if (typeof v === 'string') return v;
  if (/^(x|y|z|translate[XYZ]|transformPerspective)$/.test(key)) return `${v}px`;
  if (/^(rotate[XYZ]?|skew[XY]?)$/.test(key)) return `${v}deg`;
  return String(v);
};
const FN = { x: 'translateX', y: 'translateY', z: 'translateZ', transformPerspective: 'perspective' };
const isIdentity = (key, v) => (typeof v === 'number' ? v === (IDENTITY[key] ?? 0) : /^(0(px|deg|%)?|none)$/.test(String(v).trim()) && !(key in IDENTITY));

/**
 * The transform of one state, built like motion and Framer build it: the shorthands in their fixed order, each as its
 * CSS function, and the keys of `keys` written even where they do nothing (so both ends of an animation are lists of
 * the same functions and the browser interpolates each one, as the original does). With a template, the built
 * transform replaces its placeholder (empty when it does nothing).
 * @param {object} state
 * @param {string[]} keys  the transform keys either end of the animation moves
 * @param {string} [template]
 */
export function transformOf(state, keys, template) {
  const parts = [];
  for (const k of TRANSFORM_ORDER) {
    if (!keys.includes(k)) continue;
    const raw = state[k] ?? IDENTITY[k] ?? 0;
    const v = Array.isArray(raw) ? raw[0] : raw;
    parts.push(`${FN[k] ?? k}(${unit(k, v)})`);
  }
  const built = parts.join(' ');
  if (template) return template.includes(TRANSFORM_PLACEHOLDER) ? template.replace(TRANSFORM_PLACEHOLDER, built).trim() || 'none' : `${template} ${built}`.trim();
  return built || 'none';
}

/**
 * The browser keyframes of one entry: `{ opacity: [from, to], transform: [from, to], <style>: [from, to] }`, only the
 * properties that change (a property whose ends are equal is left to the stylesheet). Keyframe arrays are kept.
 * @param {{ initial: object, animate: object, transformTemplate?: string }} entry
 */
export function keyframesOf(entry) {
  const { initial, animate } = entry;
  const keys = [...new Set([...Object.keys(initial), ...Object.keys(animate)])];
  const out = {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const val = (state, k) => first(state[k]) ?? IDENTITY[k] ?? 0;
  const tkeys = keys.filter((k) => TRANSFORM_KEYS.has(k));
  const differs = (k) => Array.isArray(animate[k]) || String(val(initial, k)) !== String(val(animate, k));
  if (tkeys.some(differs)) {
    // What moves, plus what is not at rest at either end (a rotate the element keeps once it has arrived).
    const used = tkeys.filter((k) => differs(k) || !isIdentity(k, val(initial, k)) || !isIdentity(k, val(animate, k)));
    const steps = Math.max(1, ...used.map((k) => (Array.isArray(animate[k]) ? animate[k].length : 1)));
    if (steps > 1) {
      // Keyframes (motion's meaning: the whole path, first value included): one transform per step.
      const at = (i) => Object.fromEntries(used.map((k) => {
        const v = animate[k];
        return [k, Array.isArray(v) ? v[Math.min(i, v.length - 1)] ?? val(initial, k) : v ?? val(initial, k)];
      }));
      out.transform = Array.from({ length: steps }, (_, i) => transformOf(at(i), used, entry.transformTemplate));
    } else {
      out.transform = [transformOf(initial, used, entry.transformTemplate), transformOf(animate, used, entry.transformTemplate)];
    }
  }
  for (const k of keys) {
    if (TRANSFORM_KEYS.has(k)) continue;
    const a = first(initial[k]);
    const b = animate[k];
    if (b === undefined) continue;
    if (Array.isArray(b)) out[k] = b;
    else if (a !== undefined && String(a) !== String(b)) out[k] = [a, b];
  }
  return out;
}

/**
 * motion's animate() options for a normalised transition: seconds, a cubic-bezier array or name, a spring by its own
 * settings (motion and Framer share the spring model; perceptual springs keep bounce + duration).
 * @param {ReturnType<typeof normalizeTransition>} t
 */
export function motionOptions(t) {
  const o = { delay: t.delay ?? 0 };
  if (t.type === 'spring') Object.assign(o, { type: 'spring' }, t.spring);
  else {
    o.duration = t.duration ?? 0.3;
    if (t.ease != null) o.ease = t.ease;
    if (t.times) o.times = t.times;
  }
  for (const k of ['repeat', 'repeatDelay', 'repeatType']) if (t[k] != null) o[k] = t[k];
  return o;
}
