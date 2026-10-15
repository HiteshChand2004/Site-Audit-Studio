// @ts-check
// The targeted script lift (CLONER_SPEC decision 1, Phase 2 item 2). Every script the original loaded is classified from
// the job's network record (behavior/scripts.js classifyScripts: library / tracker / framework / app / site-small / …),
// and the copy may carry, byte for byte, the libraries that START BY THEMSELVES from the page's own markup - a library
// that reads its attributes on load (Alpine's x-data, Bootstrap's data-bs-toggle, webflow.js's data-w-id). Their rules
// say which attributes (`selfInit` in detection/rules/<id>.json); a library that needs the site's own code to start it
// (`new Swiper(…)`, `AOS.init()`) would do nothing on its own and is not lifted (the site's code is never copied blind -
// that needs the measured-role rule, decideByMeasurement, which a later step runs).
//
// Only on pages that keep the original markup (an as-is page, ir/asis.js): elsewhere the classes and attributes the
// library looks for are the copy's own. Trackers, auth, integrations, framework and app bundles: never (NEVER_LIFT).
// Where a lifted library drives an element, the copy's own rebuilt click behaviour (js/motion.js widgets and states) is
// taken off that element and everything inside it: one script per element, never two fighting over it.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { LIBRARY_RULES } from '../../detection/engine.js';
import { classifyScripts, liftOrder, readRecordIndex, recordBodyReader } from './scripts.js';

export const LIFT_DIR = 'js/lift';
/** A lifted file is named by its library and the first 10 hex of its own sha256 (verify/safety.js checks both). */
export const LIFT_FILE = /^js\/lift\/([a-z0-9-]+)-([0-9a-f]{10})\.js$/;
export const liftFile = (/** @type {string} */ lib, /** @type {string} */ sha) => `${LIFT_DIR}/${lib}-${sha.slice(0, 10)}.js`;
const sha256 = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');

/** Library ids that may ship as lifted files (the safety gate's list). */
export const LIFTABLE_LIBS = new Set(LIBRARY_RULES.map((r) => r.id));
/** id → the attributes / tags a self-starting library binds to. */
const SELF_INIT = new Map(LIBRARY_RULES.filter((r) => r.selfInit).map((r) => [r.id, { attrs: r.selfInit.attrs ?? [], tags: r.selfInit.tags ?? [] }]));

// What the copy's own script (js/motion.js) switches on an element: taken off where a lifted library drives it. An exact
// list, never a prefix - `data-w-id` is Webflow's own and must stay.
const OUR_ATTRS = ['data-w-set', 'data-w-i', 'data-w-go', 'data-w-auto', 'data-w-feed', 'data-w-off', 'data-w-one', 'data-w-alone', 'data-w-dismiss',
  'data-w-layer', 'data-w-x', 'data-w-stay', 'data-w-open', 'data-w-panel', 'data-w-note', 'data-w-hrest', 'data-w-hv'];
const OUR_COPIES = ['data-w-hcopy', 'data-w-note-of', 'data-w-panel-of'];
const WIDGET_TOKEN = /^w(\d+(p\d+)?|t|h)$/;

/**
 * Classifies the job's scripts and summarises them for the report.
 * @param {string} workspace
 * @returns {Promise<{ scripts: import('./scripts.js').ClassifiedScript[], summary: object, readBody: (e: any) => Promise<string|Buffer|null>, index: any } | null>}
 */
export async function classifyJobScripts(workspace) {
  const dir = path.join(workspace, 'capture', '.network');
  const index = await readRecordIndex(dir).catch(() => null);
  if (!index?.entries?.length) return null;
  const readBody = recordBodyReader(dir);
  const scripts = await classifyScripts(index, readBody);
  const byRole = {};
  for (const s of scripts) byRole[s.role] = (byRole[s.role] ?? 0) + 1;
  const hostOf = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return '';
    }
  };
  const summary = {
    total: scripts.length,
    byRole,
    libraries: [...new Set(scripts.flatMap((s) => (s.role === 'library' || s.libs.length ? s.libs : [])))],
    trackers: [...new Set(scripts.filter((s) => s.role === 'tracker').map((s) => hostOf(s.url)))].slice(0, 20),
    frameworks: [...new Set(scripts.filter((s) => s.role === 'framework' || s.role === 'app').map((s) => s.runtime ?? s.lib ?? s.role))],
    needsMeasurement: scripts.filter((s) => s.needsMeasurement).length,
  };
  return { scripts, summary, readBody, index };
}

/** Does this IR body (an as-is page) carry markup a self-starting library binds to? */
function usesMarkup(body, spec) {
  let found = false;
  const walk = (n) => {
    if (found || !n || 'text' in n) return;
    if (spec.tags.includes(n.t) || spec.attrs.some((a) => n.attrs && a in n.attrs)) found = true;
    else (n.children ?? []).forEach(walk);
  };
  walk(body);
  return found;
}

/** Takes the copy's own click behaviour off every element a lifted library binds to, and off what is inside it. */
function yieldToLibrary(body, spec) {
  let released = 0;
  const strip = (n) => {
    if (!n || 'text' in n) return;
    n.children = (n.children ?? []).filter((c) => !(c.attrs && (OUR_COPIES.some((a) => a in c.attrs) || ('data-w-set' in c.attrs && 'hidden' in c.attrs))));
    if (n.attrs) {
      for (const a of OUR_ATTRS) if (a in n.attrs) {
        delete n.attrs[a];
        released++;
      }
      if (n.attrs['data-motion']) {
        const kept = String(n.attrs['data-motion']).split(/\s+/).filter((t) => t && !WIDGET_TOKEN.test(t));
        if (kept.length) n.attrs['data-motion'] = kept.join(' ');
        else delete n.attrs['data-motion'];
      }
    }
    n.children.forEach(strip);
  };
  const walk = (n) => {
    if (!n || 'text' in n) return;
    if (spec.tags.includes(n.t) || spec.attrs.some((a) => n.attrs && a in n.attrs)) strip(n);
    else (n.children ?? []).forEach(walk);
  };
  walk(body);
  return released;
}

/**
 * Plans the lift for a built IR: which library files ship (rel → text) and which as-is page loads which, in dependency
 * order. Sets `page.lift = [rel, …]` on those pages and takes the copy's own click behaviour off the elements they drive.
 * @param {{ pages: any[] }} ir
 * @param {Awaited<ReturnType<typeof classifyJobScripts>>} job
 * @returns {Promise<{ files: Map<string, string>, report: object }>}
 */
export async function planLift(ir, job) {
  const files = new Map();
  const report = { lifted: [], pages: 0, released: 0, notLifted: [] };
  if (!job) return { files, report };
  const ordered = liftOrder(job.scripts);
  // Self-starting libraries, and every library one of them requires (jQuery under a plugin), as the record holds them.
  const selfStarting = ordered.filter((s) => s.lib && SELF_INIT.has(s.lib));
  for (const s of job.scripts.filter((x) => x.role === 'library' && x.lib && !SELF_INIT.has(x.lib))) {
    report.notLifted.push({ lib: s.lib, reason: s.liftable ? 'needs the site\'s own code to start' : s.reason });
  }
  if (!selfStarting.length) return { files, report };
  const entryOf = new Map((job.index.entries ?? []).map((e) => [e.url, e]));
  const textOf = new Map();
  const fileFor = async (s) => {
    if (textOf.has(s.url)) return textOf.get(s.url);
    const body = await job.readBody(entryOf.get(s.url));
    const text = body == null ? null : String(body);
    const rel = text && liftFile(s.lib, sha256(text));
    textOf.set(s.url, rel ? { rel, text } : null);
    return textOf.get(s.url);
  };
  for (const page of ir.pages.filter((p) => p.asis)) {
    const libs = selfStarting.filter((s) => usesMarkup(page.body, SELF_INIT.get(s.lib)));
    if (!libs.length) continue;
    // What those need, in the order liftOrder gave (dependencies first).
    const needed = new Set(libs.flatMap((s) => [s.url, ...s.requires.map((r) => ordered.find((d) => d.libs.includes(r))?.url).filter(Boolean)]));
    const rels = [];
    for (const s of ordered.filter((x) => needed.has(x.url))) {
      const f = await fileFor(s);
      if (!f) {
        report.notLifted.push({ lib: s.lib, reason: 'body not in the record' });
        continue;
      }
      files.set(f.rel, f.text);
      rels.push(f.rel);
      if (!report.lifted.some((l) => l.file === f.rel)) report.lifted.push({ lib: s.lib, url: s.url, file: f.rel, bytes: Buffer.byteLength(f.text) });
    }
    if (!rels.length) continue;
    page.lift = rels;
    report.pages++;
    for (const s of libs) report.released += yieldToLibrary(page.body, SELF_INIT.get(s.lib));
  }
  return { files, report };
}

/** The page's lifted scripts, deferred, in order (before the copy's own script, which runs last). */
export function liftTags(page, rel) {
  return (page.lift ?? []).map((f) => `  <script src="${rel(f)}" defer></script>`);
}
