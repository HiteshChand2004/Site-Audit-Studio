// @ts-check
// The video tier's capture (CLONER_SPEC Phase 2 item 9): self-running layers - a canvas or WebGL background that keeps
// drawing, a shape a script keeps reshaping, a Lottie animation - recorded as short seamless videos, so the copy shows
// them moving without the site's script. Only the animated layer is recorded: whatever lies on top of it (a heading, a
// button, a link) is hidden while recording and stays real HTML in the copy.
//
// What is a candidate is decided by evidence the capture already has, read with the mouse away and the page standing
// still: a canvas that keeps drawing then (captureCanvases `animated`), or an element whose attributes a script keeps
// rewriting then in a way the rebuilt loops cannot express (`findVideoLayers`: a path's `d`, a radius, a gradient - not
// a transform or an opacity, which ir/motion.js rebuilds as clean CSS). A layer that moves only with the mouse or the
// scroll does not change while the page stands still, so it never becomes a candidate; one the pointer or scroll probes
// found anyway is left out by its path (`recordVideoTier`, and again by behavior/video.js).
//
// The recording is deterministic: a fresh visit per view (1440 and the phone view) with the page's own clock replaced
// (Playwright's clock: Date, timers and requestAnimationFrame), paused, and moved on by exactly one frame between two
// pictures of the layer - never a real-time screen recording, so a busy machine records the same video. The frames are
// closed into a loop by the one recorder (capture/loops.js recordLoopFrames: seamless when a frame comes back to the
// first, else forward and back) and encoded in the browser's own encoder (MediaRecorder on a canvas stream, one frame per
// requestFrame): WebM (VP9) and MP4 (H.264) - no new dependency - plus a poster (the first frame, WebP). Never a GIF.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { USER_AGENT } from '../../audit/http.js';
import { MOBILE_UA } from '../../audit/screenshots.js';
import { RECREATE_VIEWS } from '../views.js';
import { recordLoopFrames } from './loops.js';
import { videoIndexFile } from '../behavior/video.js';

export const VIDEO_VERSION = 1;
/** Frames per second of a recording, and how long the layer is watched for a loop (a seamless one is cut shorter). */
export const VIDEO_FPS = 15;
export const VIDEO_WATCH_MS = 4000;
/** The views recorded: the desktop layout (1440) and the phone layout, separately. */
export const VIDEO_VIEWS = ['desktop', 'mobile'];
/** At most this many layers of a page are recorded (each costs a recording per view). */
export const MAX_VIDEO_LAYERS = 3;
/** The widest frame encoded per view (px), and the encoder's target bit rate. */
export const VIDEO_MAX_WIDTH = { desktop: 1280, mobile: 750 };
export const VIDEO_BITRATE = { desktop: 1500000, mobile: 800000 };
/** The containers the browser encodes into, first choice first (VP9 WebM; H.264 MP4 for browsers without WebM). */
export const VIDEO_TYPES = { webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'], mp4: ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4'] };
/** A layer taller than this share of the window is not recorded (only its first screen would be). */
export const MAX_LAYER_SCREENS = 1.2;
/** A layer whose box moves more than this while recorded is not recorded (the video could not stand in its place). */
export const MAX_BOX_DRIFT_PX = 8;
export { videoIndexFile } from '../behavior/video.js';

/**
 * Page function: elements a script keeps rewriting while the page stands still, which the rebuilt loops cannot express.
 * Watches attribute changes for `ms`; an element changed at least `min` times is a candidate, taken up to its outermost
 * <svg> when it is part of one (a morphing path is drawn by its svg). A candidate whose every change is one ir/motion.js
 * rebuilds (transform, opacity, position, filter, an SVG x / y) is left to the loops. One holding text or a control is
 * left out (text and controls stay real HTML); so is a tiny one.
 */
export async function findVideoLayers({ ms = 1500, min = 4, max = 6 } = {}) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) {
        parts.push('body');
        break;
      }
      let index = 0;
      for (const s of n.parentElement ? n.parentElement.children : []) {
        if (SKIP.has(s.tagName)) continue;
        if (s.tagName === n.tagName) index++;
        if (s === n) break;
      }
      parts.push(`${n.tagName.toLowerCase()}:${index}`);
    }
    return parts.length && parts[parts.length - 1] === 'body' ? parts.reverse().join('>') : null;
  };
  // What the rebuilt loops read and rebuild (capture/loops.js findScriptLoops, ir/motion.js scriptLoop).
  const REBUILT_PROPS = new Set(['transform', 'translate', 'rotate', 'scale', 'opacity', 'filter', 'left', 'top', 'right', 'bottom', 'will-change']);
  const REBUILT_ATTRS = new Set(['transform', 'x', 'y', 'cx', 'cy', 'opacity']);
  const styleProps = (s) => {
    const out = new Map();
    for (const part of String(s ?? '').split(';')) {
      const i = part.indexOf(':');
      if (i > 0) out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
    }
    return out;
  };
  const seen = new Map();
  const observer = new MutationObserver((list) => {
    for (const m of list) {
      const el = /** @type {Element} */ (m.target);
      const e = seen.get(el) ?? { count: 0, changed: new Set() };
      e.count++;
      if (m.attributeName === 'style') {
        const before = styleProps(m.oldValue);
        const after = styleProps(el.getAttribute('style'));
        for (const k of new Set([...before.keys(), ...after.keys()])) if (before.get(k) !== after.get(k)) e.changed.add(`style:${k}`);
      } else e.changed.add(`attr:${m.attributeName}`);
      seen.set(el, e);
    }
  });
  observer.observe(document.body, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ['style', 'd', 'points', 'transform', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'fill', 'stroke', 'offset', 'stop-color', 'opacity', 'viewBox', 'stdDeviation', 'baseFrequency', 'path'] });
  await new Promise((r) => setTimeout(r, ms));
  observer.disconnect();
  const layers = new Map();
  for (const [el, e] of seen) {
    if (e.count < min || !el.isConnected) continue;
    let layer = el;
    for (let s = el instanceof SVGElement ? el.ownerSVGElement : null; s; s = s.ownerSVGElement) layer = s;
    const had = layers.get(layer) ?? { count: 0, changed: new Set() };
    had.count += e.count;
    for (const c of e.changed) had.changed.add(c);
    layers.set(layer, had);
  }
  const out = [];
  const skipped = [];
  const chosen = [...layers].sort((a, b) => b[1].count - a[1].count);
  for (const [layer, e] of chosen) {
    const p = pathOf(layer);
    if (!p) continue;
    const changed = [...e.changed];
    const rebuilt = changed.every((c) => (c.startsWith('style:') ? REBUILT_PROPS.has(c.slice(6)) : REBUILT_ATTRS.has(c.slice(5))));
    const r = layer.getBoundingClientRect();
    const rect = [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
    const skip = (reason) => skipped.push({ path: p, tag: layer.tagName.toLowerCase(), reason, changed: changed.slice(0, 8) });
    if (rebuilt) skip('rebuilt-as-loop');
    else if (r.width < 24 || r.height < 24) skip('too-small');
    else if ((layer instanceof HTMLElement ? layer.innerText : layer.textContent ?? '').trim()) skip('has-text');
    else if (layer.querySelector('a[href], button, input, select, textarea, [tabindex], [role="button"], [role="link"]')) skip('has-controls');
    else if (out.some((o) => o.el.contains(layer) || layer.contains(o.el))) skip('inside-another');
    else if (out.length >= max) skip('limit');
    else out.push({ el: layer, path: p, tag: layer.tagName.toLowerCase(), rect, mutations: e.count, changed: changed.slice(0, 8) });
  }
  return { layers: out.map(({ el, ...rest }) => rest), skipped: skipped.slice(0, 12) };
}

/**
 * Page function: the Lottie animations of the page, as the lottie-web player registered them (`lottie` / `bodymovin`):
 * the container (by its capture path), where the animation's JSON came from (`src`, resolved like the player resolved it)
 * or - for one given as data - that data, and how it plays. A <lottie-player> / <dotlottie-player> element is listed with
 * its `src` (a .lottie archive cannot be played from its JSON alone).
 */
export function findLottie({ maxDataBytes = 3 * 1024 * 1024 } = {}) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) {
        parts.push('body');
        break;
      }
      let index = 0;
      for (const s of n.parentElement ? n.parentElement.children : []) {
        if (SKIP.has(s.tagName)) continue;
        if (s.tagName === n.tagName) index++;
        if (s === n) break;
      }
      parts.push(`${n.tagName.toLowerCase()}:${index}`);
    }
    return parts.length && parts[parts.length - 1] === 'body' ? parts.reverse().join('>') : null;
  };
  const w = /** @type {any} */ (window);
  const L = w.lottie || w.bodymovin;
  const items = typeof L?.getRegisteredAnimations === 'function' ? L.getRegisteredAnimations() : [];
  const animations = [];
  for (const item of items) {
    const el = item?.wrapper;
    if (!(el instanceof Element) || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    let src = null;
    try {
      if (item.fileName) src = new URL(`${item.path ?? ''}${item.fileName}.json`, location.href).href;
    } catch {
      src = null;
    }
    let data = null;
    if (!src && item.animationData) {
      try {
        const text = JSON.stringify(item.animationData);
        if (text.length <= maxDataBytes) data = text;
      } catch {
        data = null;
      }
    }
    animations.push({
      path: pathOf(el),
      tag: el.tagName.toLowerCase(),
      rect: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)],
      src,
      ...(data && { data }),
      loop: item.loop === undefined ? true : item.loop,
      autoplay: item.autoplay !== false,
      renderer: item.animType ?? item.renderer?.rendererType ?? null,
      frames: Math.round(item.totalFrames ?? 0),
      fps: item.frameRate ?? null,
      playing: item.isPaused === false,
    });
  }
  const players = [...document.querySelectorAll('lottie-player, dotlottie-player')].map((el) => ({ path: pathOf(el), tag: el.tagName.toLowerCase(), src: el.getAttribute('src'), autoplay: el.hasAttribute('autoplay') }));
  return { version: L?.version ?? null, animations, players };
}

/**
 * Page function: gets the layer at `p` ready to be recorded alone. It is brought into view, and every element painted on
 * top of it (asked of the browser's own hit test at the centre of where the two overlap, with pointer-events forced on so
 * a heading the original lets clicks pass through counts too) is hidden - text, buttons and links stay real HTML in the
 * copy, so they must not be in the video. What lies under the layer stays: the video covers its box, so those pixels are
 * what the copy must show there. Returns the layer's box in the window, or why it cannot be recorded.
 */
export function prepareLayer({ path: p, maxScreens }) {
  const find = (q) => {
    const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
    const parts = String(q).split('>');
    if (parts[0] !== 'body') return null;
    let el = document.body;
    for (const part of parts.slice(1)) {
      const i = part.lastIndexOf(':');
      const tag = part.slice(0, i).toUpperCase();
      const index = Number(part.slice(i + 1));
      let n = 0;
      let next = null;
      for (const c of el.children) {
        if (SKIP.has(c.tagName) || c.tagName !== tag) continue;
        if (++n === index) {
          next = c;
          break;
        }
      }
      if (!next) return null;
      el = next;
    }
    return el;
  };
  const layer = find(p);
  if (!layer) return { error: 'missing' };
  const box = layer.getBoundingClientRect();
  if (box.width < 24 || box.height < 24) return { error: 'too-small' };
  if (box.height > innerHeight * maxScreens) return { error: 'taller-than-the-window' };
  window.scrollTo(0, Math.max(0, box.top + scrollY - Math.max(0, (innerHeight - box.height) / 2)));
  const r = layer.getBoundingClientRect();
  const force = document.createElement('style');
  force.textContent = '*, *::before, *::after { pointer-events: auto !important; }';
  document.head.appendChild(force);
  const covering = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (el === layer || el.contains(layer) || layer.contains(el)) continue;
    const e = el.getBoundingClientRect();
    const left = Math.max(e.left, r.left, 0);
    const right = Math.min(e.right, r.right, innerWidth);
    const top = Math.max(e.top, r.top, 0);
    const bottom = Math.min(e.bottom, r.bottom, innerHeight);
    if (right - left < 1 || bottom - top < 1) continue;
    const stack = document.elementsFromPoint((left + right) / 2, (top + bottom) / 2);
    const at = stack.indexOf(layer);
    const mine = stack.indexOf(el);
    if (mine >= 0 && (at < 0 || mine < at)) covering.add(el);
  }
  force.remove();
  for (const el of covering) el.setAttribute('data-sas-cover', '');
  const hide = document.createElement('style');
  hide.setAttribute('data-sas-rec', '');
  hide.textContent = '[data-sas-cover], [data-sas-cover] * { visibility: hidden !important; } html { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }';
  document.head.appendChild(hide);
  return { x: r.left, y: r.top, width: r.width, height: r.height, covering: covering.size };
}

/** Page function: the layer's box in the window now. */
function layerBox({ path: p }) {
  const find = (q) => {
    const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
    const parts = String(q).split('>');
    if (parts[0] !== 'body') return null;
    let el = document.body;
    for (const part of parts.slice(1)) {
      const i = part.lastIndexOf(':');
      const tag = part.slice(0, i).toUpperCase();
      const index = Number(part.slice(i + 1));
      let n = 0;
      let next = null;
      for (const c of el.children) {
        if (SKIP.has(c.tagName) || c.tagName !== tag) continue;
        if (++n === index) {
          next = c;
          break;
        }
      }
      if (!next) return null;
      el = next;
    }
    return el;
  };
  const el = find(p);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/**
 * Encodes frames (PNG / JPEG buffers of one size) into the browser's video formats, in a blank page of its own: each
 * frame drawn on a canvas and handed to the encoders with requestFrame(), one frame every `delayMs`, so the video's
 * timing is the recording's. Both formats are encoded from the same frames at once. A format the browser cannot write is
 * left out (null).
 * @param {import('playwright').Browser} browser
 * @param {Buffer[]} frames
 * @returns {Promise<{ webm: Buffer | null, mp4: Buffer | null, webmType: string | null, mp4Type: string | null }>}
 */
export async function encodeFrames(browser, frames, { delayMs, bitrate }) {
  const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
  try {
    const page = await context.newPage();
    await page.setContent('<!doctype html><canvas></canvas>');
    const result = await page.evaluate(async ({ urls, delayMs: every, bitrate: bits, types }) => {
      const blobs = await Promise.all(urls.map((u) => fetch(u).then((r) => r.blob())));
      const bitmaps = await Promise.all(blobs.map((b) => createImageBitmap(b)));
      const canvas = document.querySelector('canvas');
      canvas.width = bitmaps[0].width;
      canvas.height = bitmaps[0].height;
      const g = canvas.getContext('2d');
      g.drawImage(bitmaps[0], 0, 0);
      const stream = canvas.captureStream(0);
      const track = /** @type {any} */ (stream.getVideoTracks()[0]);
      const pick = (list) => list.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
      const recorders = [];
      for (const kind of ['webm', 'mp4']) {
        const type = pick(types[kind]);
        if (!type) continue;
        try {
          const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bits });
          const chunks = [];
          rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
          const done = new Promise((resolve) => { rec.onstop = resolve; });
          recorders.push({ kind, type, rec, chunks, done });
        } catch {
          // this container cannot be written here
        }
      }
      for (const r of recorders) r.rec.start();
      const t0 = performance.now();
      for (let i = 0; i < bitmaps.length; i++) {
        g.drawImage(bitmaps[i], 0, 0);
        track.requestFrame();
        const wait = t0 + (i + 1) * every - performance.now();
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
      }
      for (const r of recorders) r.rec.stop();
      await Promise.all(recorders.map((r) => r.done));
      const out = {};
      for (const r of recorders) {
        const buf = new Uint8Array(await new Blob(r.chunks).arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        out[r.kind] = { type: r.rec.mimeType || r.type, b64: btoa(s) };
      }
      return out;
    }, { urls: frames.map((f) => `data:image/png;base64,${f.toString('base64')}`), delayMs, bitrate, types: VIDEO_TYPES });
    const buf = (x) => (x?.b64 ? Buffer.from(x.b64, 'base64') : null);
    return { webm: buf(result.webm), mp4: buf(result.mp4), webmType: result.webm?.type ?? null, mp4Type: result.mp4?.type ?? null };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Even dimensions (H.264 needs them), at most `maxWidth` wide. */
const evenSize = (width, height, maxWidth) => {
  const scale = Math.min(1, maxWidth / width);
  const even = (v) => Math.max(2, Math.floor((v * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
};

/**
 * The layers of a page to record, from what the desktop capture found (motion.json): canvases that keep drawing, elements
 * a script keeps reshaping, and the containers of Lottie animations (recorded too: the copy plays the animation itself when
 * its JSON is found, and falls back to the recording when it is not). A layer the pointer or scroll probes found moving
 * is driven by the visitor, not self-running: left out.
 */
export function videoCandidates(motion) {
  const driven = new Set([
    ...(motion?.pointer?.followers ?? []).map((f) => f.path),
    ...(motion?.scrollLinked?.elements ?? []).map((e) => e.path),
  ].filter(Boolean));
  const out = [];
  const skipped = [];
  const add = (c) => {
    if (!c.path) return;
    if ([...driven].some((d) => d === c.path || d.startsWith(`${c.path}>`) || c.path.startsWith(`${d}>`))) return void skipped.push({ path: c.path, kind: c.kind, reason: 'driven-by-the-visitor' });
    if (out.some((o) => o.path === c.path || c.path.startsWith(`${o.path}>`))) return;
    out.push(c);
  };
  for (const c of motion?.loops?.canvas ?? []) if (c.animated) add({ kind: 'canvas', path: c.path, context: c.context });
  // A Lottie playing by itself is recorded only when the copy cannot play it from its JSON (none was named or handed
  // over, or a player element, which may load a .lottie archive); one the copy embeds needs no recording.
  for (const l of motion?.loops?.lottie?.animations ?? []) if (l.playing && !l.src && !l.data) add({ kind: 'lottie', path: l.path });
  for (const l of motion?.loops?.lottie?.players ?? []) if (l.autoplay) add({ kind: 'lottie', path: l.path });
  // What a Lottie the copy plays itself draws (its SVG) is not recorded as a layer as well.
  const lottie = (motion?.loops?.lottie?.animations ?? []).filter((l) => l.src || l.data).map((l) => l.path).filter(Boolean);
  for (const l of motion?.loops?.videoLayers?.layers ?? []) {
    if (lottie.some((p) => l.path === p || l.path.startsWith(`${p}>`))) skipped.push({ path: l.path, kind: 'layer', reason: 'lottie-json' });
    else add({ kind: 'layer', path: l.path, changed: l.changed });
  }
  return { layers: out.slice(0, MAX_VIDEO_LAYERS), skipped: [...skipped, ...out.slice(MAX_VIDEO_LAYERS).map((c) => ({ path: c.path, kind: c.kind, reason: 'limit' }))] };
}

/**
 * Records the page's self-running layers at 1440 and at the phone width, each in a visit of its own with a stepped clock,
 * and writes the videos, posters and `video.json` beside the capture. Never throws: a layer or a view that cannot be
 * recorded is listed with the reason.
 * @param {import('playwright').Browser} browser
 * @param {{ url: string }} pageInfo
 * @param {string} dir  the page's capture folder
 * @param {{ motion: object, document?: string | null, watchMs?: number, fps?: number }} o
 */
/**
 * Pauses the page's clock a little ahead of its own time. The time is read from the page and the pause sent back, so on a
 * busy machine the page may already be past the target ("Cannot fast-forward to the past"): it is read again with a
 * wider margin. Nothing has been recorded yet at this point, so a retry changes nothing about the result.
 * @param {import('playwright').Page} page
 */
export async function pauseClock(page, { margins = [50, 500, 2000] } = {}) {
  let last;
  for (const margin of margins) {
    try {
      const now = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(now + margin);
      return margin;
    } catch (err) {
      last = err;
      if (!/past/i.test(String(err?.message ?? err))) throw err;
    }
  }
  throw last;
}

export async function recordVideoTier(browser, pageInfo, dir, { motion, document = null, watchMs = VIDEO_WATCH_MS, fps = VIDEO_FPS }) {
  const { layers, skipped } = videoCandidates(motion);
  if (!layers.length) return null;
  const started = Date.now();
  const sharp = (await import('sharp')).default;
  const every = Math.round(1000 / fps);
  const out = { version: VIDEO_VERSION, fps, watchMs, layers: layers.map((l, i) => ({ id: i + 1, ...l, views: {} })), skipped, ms: 0 };
  // The two views side by side (each its own context and clock): a recording waits mostly on the encoder's real time.
  await Promise.all(VIDEO_VIEWS.map(async (viewId) => {
    const view = RECREATE_VIEWS.find((v) => v.id === viewId);
    if (!view) return;
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      deviceScaleFactor: view.dpr,
      isMobile: view.mobile,
      hasTouch: view.mobile,
      userAgent: view.id === 'mobile' ? MOBILE_UA : USER_AGENT,
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
      reducedMotion: 'no-preference',
    });
    try {
      // The page's own clock (Date, timers, requestAnimationFrame) from its first script on: it runs normally while the
      // page loads and is paused for the recording.
      await context.clock.install();
      if (document) {
        await context.route((u) => u.href === pageInfo.url, (route) => (route.request().isNavigationRequest()
          ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: document })
          : route.continue()));
      }
      for (const layer of out.layers) {
        const entry = {};
        layer.views[viewId] = entry;
        // A visit per layer: the previous layer's hidden covers and scroll position must not carry over.
        const page = await context.newPage();
        try {
          await page.goto(pageInfo.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
          await page.mouse.move(0, 0).catch(() => {});
          await page.waitForTimeout(1200);
          const prep = await page.evaluate(prepareLayer, { path: layer.path, maxScreens: MAX_LAYER_SCREENS });
          if (prep.error) {
            entry.error = prep.error;
            continue;
          }
          await page.waitForTimeout(250);
          await pauseClock(page);
          const clip = { x: Math.max(0, prep.x), y: Math.max(0, prep.y), width: Math.min(prep.width, view.width - Math.max(0, prep.x)), height: Math.min(prep.height, view.height - Math.max(0, prep.y)) };
          let drift = 0;
          const shoot = async () => {
            const box = await page.evaluate(layerBox, { path: layer.path });
            if (box) drift = Math.max(drift, Math.abs(box.x - prep.x), Math.abs(box.y - prep.y), Math.abs(box.width - prep.width), Math.abs(box.height - prep.height));
            return page.screenshot({ clip, animations: 'allow', scale: 'device', timeout: 10000 });
          };
          const size = evenSize(clip.width * view.dpr, clip.height * view.dpr, VIDEO_MAX_WIDTH[viewId] ?? 1280);
          const loop = await recordLoopFrames(null, sharp, { ms: watchMs, every, width: size.width, advance: (ms) => page.clock.runFor(ms), shoot, minFrames: 8, seamlessDiff: 0.01 });
          if (!loop) {
            entry.error = 'no-frames';
            continue;
          }
          if (drift > MAX_BOX_DRIFT_PX) {
            entry.error = 'moves-outside-its-box';
            entry.drift = Math.round(drift);
            continue;
          }
          const frames = await Promise.all(loop.frames.map((f) => sharp(f).resize(size.width, size.height, { fit: 'fill' }).png().toBuffer()));
          const encoded = await encodeFrames(browser, frames, { delayMs: loop.delayMs, bitrate: VIDEO_BITRATE[viewId] ?? 1000000 });
          if (!encoded.webm && !encoded.mp4) {
            entry.error = 'no-encoder';
            continue;
          }
          const poster = await sharp(frames[0]).webp({ quality: 80 }).toBuffer();
          const base = `${viewId}-video-${layer.id}`;
          entry.files = { poster: `${base}-poster.webp` };
          entry.bytes = { poster: poster.length };
          await writeFile(path.join(dir, entry.files.poster), poster);
          for (const kind of /** @type {const} */ (['webm', 'mp4'])) {
            const body = encoded[kind];
            if (!body) continue;
            entry.files[kind] = `${base}.${kind}`;
            entry.bytes[kind] = body.length;
            entry[`${kind}Type`] = encoded[`${kind}Type`];
            await writeFile(path.join(dir, entry.files[kind]), body);
          }
          Object.assign(entry, {
            width: size.width, height: size.height, box: [Math.round(prep.x), Math.round(prep.y), Math.round(prep.width), Math.round(prep.height)],
            frames: loop.frames.length, delayMs: loop.delayMs, seamless: loop.seamless, closeness: loop.closeness, durationMs: loop.frames.length * loop.delayMs,
            covering: prep.covering,
          });
        } catch (err) {
          entry.error = String(err?.message ?? err).split('\n')[0].slice(0, 200);
        } finally {
          await page.close().catch(() => {});
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  }));
  out.ms = Date.now() - started;
  await writeFile(path.join(dir, videoIndexFile), JSON.stringify(out));
  return { layers: out.layers.length, recorded: out.layers.filter((l) => Object.values(l.views).some((v) => v.files)).length, ms: out.ms };
}
