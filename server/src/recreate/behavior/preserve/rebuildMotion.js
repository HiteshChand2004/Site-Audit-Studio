// The original's animations rebuilt on an as-is copy's own pages, without the original's code: the scroll reveals, hover and
// focus effects, loops, scroll-linked effects, menus and panels that open on a click, the mouse followers - everything the
// capture recorded of the page (capture/<slug>/motion.json and the views' click recordings, kept with the copy by
// recordings.js). It is the machinery exact mode uses on the original markup (ir/motion.js → tokens, emit/motionCss.js, the
// fixed js/motion.js), applied to the lifted page instead of a rebuilt one:
//   1. the capture's snapshots become the IR trees (prepareSite), the recordings become motion tokens on them (applyMotion),
//      the IR is built (buildIR) — no fixer, no stylesheet of ours: only the tokens and ir.motion are used;
//   2. every token is carried to the element of the lifted page at the same capture path (tag:n = the n-th child with that tag,
//      the capture's own path rule), as ir/asis.js carries them into exact mode's as-is markup; what the site's own stylesheet
//      already does (a :hover rule the page ships) is not written again;
//   3. the page gets the rules of the effects its elements carry (one <style>, !important where a state must beat what the
//      page's styles say, as on exact mode's as-is pages) and the fixed script that drives them.
// What cannot be carried is counted, never guessed: an element whose path the lifted page does not have, a state the copy would
// need to add as an element of its own (another slide of a carousel: exact mode builds those from markup only its capture
// keeps), a canvas recording (a file of the capture the copy does not hold).
//
// It changes nothing when the page has no recording. Whether the result looks and moves like the original is not decided
// here: runtimeFree.js holds the page without the original's code and with these effects against the page with that code.
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { buildIR, prepareSite, readPageCaptures } from '../../ir/index.js';
import { applyMotion, readPageMotion } from '../../ir/motion.js';
import { carriedAttrs, withoutOwnCss } from '../../ir/asis.js';
import { motionCss } from '../../emit/motionCss.js';
import { pageMotion, usedCustomProps } from '../../emit/css.js';
import { MOTION_FILE, motionJsMinified } from '../../emit/motionScript.js';

/** The marker of the rules this file adds to a page (and of the script tag), so a page is never given them twice. */
export const MOTION_STYLE_ATTR = 'data-sas-motion';

const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);

/**
 * The element of a parsed page at a capture path ("body>main:1>section:2>h2:1": from <body>, the n-th child element with
 * that tag). Null when the page has no such element.
 */
export function elementAt($, cpath) {
  const steps = String(cpath).split('>');
  if (steps[0] !== 'body') return null;
  let el = $('body')[0];
  for (const step of steps.slice(1)) {
    const m = /^([^:]+):(\d+)$/.exec(step);
    if (!el || !m) return null;
    const tag = m[1].toLowerCase();
    const same = (el.children ?? []).filter((c) => c.type === 'tag' || c.type === 'script' || c.type === 'style').filter((c) => c.name.toLowerCase() === tag);
    el = same[Number(m[2]) - 1] ?? null;
  }
  return el;
}

/**
 * The motion plan of a copy from its capture: per page, the attributes to carry (capture path → attributes) and the site's
 * motion (ir.motion), with what could not be carried counted. Null when the capture holds no recording at all.
 * @param {{ dir: string, pages: { outPath: string }[] }} o  dir: the job folder (its capture/ and capture/manifest.json)
 */
export async function motionPlan({ dir, pages }) {
  const manifest = await readFile(path.join(dir, 'capture', 'manifest.json'), 'utf8').then(JSON.parse, () => null);
  if (!manifest?.pages?.length) return null;
  const wanted = new Set(pages.map((p) => p.outPath));
  const infos = [];
  for (const info of manifest.pages) {
    if (!wanted.has(info.outPath) || !info.views?.desktop) continue;
    if (!(await isFile(path.join(dir, 'capture', info.slug, 'motion.json')))) continue;
    infos.push(info);
  }
  if (!infos.length) return null;
  const loaded = [];
  for (const info of infos) loaded.push({ info, captures: await readPageCaptures(dir, info) });
  const site = prepareSite({ pages: loaded, assets: { map: {}, files: [] }, baseUrl: manifest.origin, origin: manifest.origin, asIs: true });
  for (const t of site.pages) delete t.captures;
  const byPath = new Map();
  for (const info of infos) {
    const found = await readPageMotion(dir, info);
    if (found) byPath.set(info.path, found);
  }
  const applied = applyMotion(site, byPath);
  site.motion = applied.motion;
  const { ir } = buildIR(site, { asIs: true });
  const cssOnly = new Set(ir.motion?.cssOnly ?? []);
  const out = new Map();
  for (const page of ir.pages) {
    const tree = site.pages.find((t) => t.info.outPath === page.outPath);
    const cpathOf = new Map();
    const index = (n) => {
      if (!n || !n.children) return;
      if (n.sid != null && (n.cpath || n.path)) cpathOf.set(n.sid, n.cpath ?? n.path);
      n.children.forEach(index);
    };
    index(tree?.root);
    const notCarried = { states: 0, hoverCards: 0, notices: 0, panels: 0, unmapped: 0 };
    const carried = carriedAttrs(page.body, cpathOf, notCarried, new Set());
    const ownCss = withoutOwnCss(carried, cssOnly);
    for (const s of (ir.motion?.svgTokens ?? []).filter((x) => x.page === page.outPath)) {
      const had = carried.get(s.path) ?? {};
      carried.set(s.path, { ...had, 'data-motion': [had['data-motion'], s.token].filter(Boolean).join(' ') });
    }
    out.set(page.outPath, { carried, notCarried, ownCss });
  }
  return { ir, pages: out, stats: applied.stats };
}

/** Motion tokens among carried attributes (the ones whose rules a page needs). */
function tokensOf(attrsList) {
  const tokens = new Set();
  for (const attrs of attrsList) for (const t of String(attrs['data-motion'] ?? '').split(/\s+/)) if (t) tokens.add(t);
  return tokens;
}

/**
 * One page with the planned effects written in: the attributes on their elements, the rules in one <style> at the end of the
 * head, the script before </body> (deferred). Returns the page and what was carried.
 * @param {string} html  the lifted page
 * @param {{ carried: Map<string, object>, notCarried: object }} plan  this page's part of motionPlan
 * @param {object} ir  motionPlan's ir (its motion and custom properties)
 * @param {{ outPath: string, scriptSrc: string }} o
 */
export function withRebuiltMotion(html, plan, ir, { outPath, scriptSrc }) {
  const $ = cheerio.load(html);
  if ($(`style[${MOTION_STYLE_ATTR}]`).length) return { html, placed: 0, lost: 0, tokens: 0, already: true };
  let placed = 0;
  const lost = [];
  const placedAttrs = [];
  for (const [cpath, attrs] of plan.carried) {
    const el = elementAt($, cpath);
    if (!el) { lost.push(cpath); continue; }
    for (const [k, v] of Object.entries(attrs)) {
      const had = $(el).attr(k);
      const value = k === 'data-motion' && had ? [...new Set(`${had} ${v}`.split(/\s+/).filter(Boolean))].join(' ') : v;
      $(el).attr(k, value === true ? '' : String(value));
    }
    placedAttrs.push(attrs);
    placed++;
  }
  const tokens = tokensOf(placedAttrs);
  if (!placed) return { html, placed: 0, lost: lost.length, lostPaths: lost.slice(0, 20), tokens: 0 };
  // Only the effects this page's elements carry; canvas and video recordings are files of the capture the copy does not hold.
  const body = { attrs: { 'data-motion': [...tokens].join(' ') }, children: [] };
  const m = { ...pageMotion(ir.motion, { body }), canvas: [], video: [] };
  const css = motionCss(m, { tokenOf: new Map(), from: outPath, usedVars: usedCustomProps(ir), important: true });
  if (css) $('head').append(`<style ${MOTION_STYLE_ATTR}>\n${css}\n</style>`);
  $('body').append(`<script src="${scriptSrc}" defer ${MOTION_STYLE_ATTR}></script>`);
  return { html: $.html(), placed, lost: lost.length, lostPaths: lost.slice(0, 20), tokens: tokens.size, cssBytes: css.length };
}

/**
 * Writes the rebuilt effects into the pages of a copy folder (in place), and the fixed script beside them. `only`: the pages
 * to change (outPaths); the others are left as they are.
 * @returns {Promise<{ pages: object[], placed: number, lost: number, script: string|null } | null>}  null: nothing recorded
 */
export async function rebuildMotion({ dir, copyDir, pages, only = null }) {
  const plan = await motionPlan({ dir, pages });
  if (!plan) return null;
  // The fixed script, at the address the app stacks serve it from; a copy whose original has a file there of its own keeps
  // it, and the script gets a name of its own.
  const source = motionJsMinified();
  let file = MOTION_FILE;
  const existing = await readFile(path.join(copyDir, file), 'utf8').catch(() => null);
  if (existing != null && existing !== source) file = `js/sas-motion-${createHash('sha256').update(source).digest('hex').slice(0, 10)}.js`;
  const results = [];
  for (const p of pages) {
    if (only && !only.includes(p.outPath)) continue;
    const pagePlan = plan.pages.get(p.outPath);
    if (!pagePlan) { results.push({ outPath: p.outPath, recorded: false }); continue; }
    const file2 = path.join(copyDir, p.outPath);
    const html = await readFile(file2, 'utf8');
    const r = withRebuiltMotion(html, pagePlan, plan.ir, { outPath: p.outPath, scriptSrc: `/${file}` });
    if (r.placed) await writeFile(file2, r.html, 'utf8');
    const { html: _h, ...rest } = r;
    results.push({ outPath: p.outPath, recorded: true, ...rest, notCarried: pagePlan.notCarried, ownCss: pagePlan.ownCss });
  }
  const placed = results.reduce((s, r) => s + (r.placed ?? 0), 0);
  if (placed) {
    await mkdir(path.dirname(path.join(copyDir, file)), { recursive: true });
    await writeFile(path.join(copyDir, file), source, 'utf8');
  }
  return { pages: results, placed, lost: results.reduce((s, r) => s + (r.lost ?? 0), 0), script: placed ? `/${file}` : null, stats: plan.stats };
}
