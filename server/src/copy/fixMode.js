// Fix mode (Step 11): two kinds of change an as-is copy ("Copy my site") never makes by itself, because they change what the
// original wrote, proposed one by one and applied only when the user approves each:
//   contrast       a text colour too faint against what is behind it (axe / Lighthouse color-contrast): the same hue moved
//                  darker or lighter by the smallest step that reaches the ratio the check asks for (fixers/contrast.js fixColor),
//                  written on that element alone ("#9ca3af → #6b7280, 2.8 → 4.6").
//   heading-level  a heading that skips a level (heading-order): its level for assistive technology set to the one after the
//                  heading before it with aria-level; the tag stays, so every rule that styles it still does ("h4 → heading
//                  level 3, look kept").
// 1. Proposals come from the copy's last re-check as saved (the homepage's axe.json, every page's Lighthouse reports): no browser.
//    A finding is proposed only when its element is in the page as written, found by the check's own selector, exactly once
//    (an element a script draws later cannot be changed in the markup: it is listed as skipped, with why).
// 2. Pictures: the copy with and without a page's proposals, through the look check's own pictures (pictureRounds, the gate's
//    verdict), at 375 and 1440 px; each proposal's element cropped from both pictures, its box marked.
// 3. Apply: a fresh copy of the finished copy with only the approved changes, spliced into the page's own bytes (faithfulHtml),
//    and proved: only those pages changed, every approved change is in place, nothing else of any file moved.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { contrast, fixColor, parseColor } from '../recreate/fixers/contrast.js';
import { faithfulHtml, loadFaithful } from './faithfulHtml.js';
import { bundledTemplate, drawnHtml, withTemplate } from './bundled.js';

export const FIX_MODE_DIR = 'fix-mode';
export const PROPOSALS_FILE = 'proposals.json';
export const FIX_WIDTHS = [375, 1440];
/** A little above the line the check asks for: the browser's rounding must not drop it below. */
export const CONTRAST_MARGIN = 0.15;
/** Room around a proposal's element in its crops, in CSS px. */
const CROP_PAD = 24;
/** Largest crop kept (a heading that spans a whole section is cut to this). */
const CROP_MAX = { width: 1440, height: 600 };
const RULES = { 'color-contrast': 'contrast', 'heading-order': 'heading-level' };

const hex = (rgb) => `#${rgb.slice(0, 3).map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
const round1 = (n) => Math.round(n * 10) / 10;
const idOf = (...parts) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);

/**
 * What a contrast finding says, from its text (axe's failureSummary, Lighthouse's explanation: the same words):
 * "insufficient color contrast of 2.8 (foreground color: #9ca3af, background color: #ffffff, …). Expected contrast ratio of 4.5:1".
 * @returns {{ ratio: number, fg: string, bg: string, expected: number } | null}
 */
export function parseContrastMessage(text) {
  const t = String(text ?? '');
  const ratio = Number(t.match(/contrast of ([\d.]+)/i)?.[1]);
  const fg = t.match(/foreground color: (#[0-9a-f]{3,8})/i)?.[1];
  const bg = t.match(/background color: (#[0-9a-f]{3,8})/i)?.[1];
  const expected = Number(t.match(/Expected contrast ratio of ([\d.]+):1/i)?.[1]);
  if (!fg || !bg || !Number.isFinite(expected)) return null;
  return { ratio: Number.isFinite(ratio) ? ratio : null, fg: fg.toLowerCase(), bg: bg.toLowerCase(), expected };
}

/**
 * The findings of the two rules in a re-check's saved reports, one per page and element.
 * @param {{ axe?: { page: string, json: any } | null, lighthouse?: { page: string, lhr: any }[] }} o
 * @returns {{ rule: string, page: string, selector: string, snippet: string, message: string }[]}
 */
export function findingsOf({ axe = null, lighthouse = [] }) {
  const out = new Map();
  const add = (f) => {
    const key = `${f.page}|${f.rule}|${f.selector}`;
    if (f.selector && !out.has(key)) out.set(key, f);
  };
  for (const v of axe?.json?.violations ?? []) {
    if (!RULES[v.id]) continue;
    for (const n of v.nodes ?? []) {
      // A target of more than one part is inside a frame or a shadow root: not in the page as written.
      if (!Array.isArray(n.target) || n.target.length !== 1 || typeof n.target[0] !== 'string') continue;
      add({ rule: v.id, page: axe.page, selector: n.target[0], snippet: n.html ?? '', message: n.failureSummary ?? n.any?.[0]?.message ?? '' });
    }
  }
  for (const { page, lhr } of lighthouse) {
    for (const rule of Object.keys(RULES)) {
      for (const item of lhr?.audits?.[rule]?.details?.items ?? []) {
        add({ rule, page, selector: item.node?.selector ?? '', snippet: item.node?.snippet ?? '', message: item.node?.explanation ?? '' });
      }
    }
  }
  return [...out.values()];
}

/** The one element a selector names in a page as written, or why there is none. */
function only($, selector) {
  let found;
  try {
    found = $(selector);
  } catch {
    return { why: 'the check named it in a way this page cannot be searched with' };
  }
  if (found.length === 0) return { why: 'not in the page as written (a script draws it after loading)' };
  if (found.length > 1) return { why: `the check's name for it fits ${found.length} elements of the page` };
  return { el: found.first() };
}

const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const levelOf = ($, el) => {
  const aria = Number(el.attr('aria-level'));
  if (Number.isInteger(aria) && aria >= 1) return aria;
  const m = /^h([1-6])$/.exec(el.get(0)?.name ?? '');
  return m ? Number(m[1]) : 2; // role=heading without a level is level 2
};

/**
 * Proposals from findings, each checked against its page as written.
 * @param {{ findings: ReturnType<typeof findingsOf>, pages: { path: string, outPath: string, html: string }[] }} o
 * @returns {{ proposals: object[], skipped: object[] }}
 */
export function proposalsFrom({ findings, pages }) {
  const proposals = [];
  const skipped = [];
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const loaded = new Map();
  for (const f of findings) {
    const page = byPath.get(f.page);
    const kind = RULES[f.rule];
    const base = { page: f.page, kind, selector: f.selector, snippet: String(f.snippet).slice(0, 200) };
    if (!page) {
      skipped.push({ ...base, why: 'the page is not in the copy' });
      continue;
    }
    // The document the browser draws (a bundled page's template, copy/bundled.js): where the check found the element.
    if (!loaded.has(page.path)) loaded.set(page.path, cheerio.load(drawnHtml(page.html)));
    const $ = loaded.get(page.path);
    const { el, why } = only($, f.selector);
    if (!el) {
      skipped.push({ ...base, why });
      continue;
    }
    if (kind === 'contrast') {
      const m = parseContrastMessage(f.message);
      const fg = m && parseColor(m.fg);
      const bg = m && parseColor(m.bg);
      if (!m || !fg || !bg) {
        skipped.push({ ...base, why: 'the check did not name both colours (text over a picture or a gradient)' });
        continue;
      }
      const to = hex(fixColor(fg, bg, m.expected + CONTRAST_MARGIN));
      const before = round1(m.ratio ?? contrast(fg, bg));
      const after = round1(contrast(parseColor(to), bg));
      if (after < m.expected) {
        skipped.push({ ...base, why: `no shade of this colour reaches ${m.expected}:1 on ${m.bg}` });
        continue;
      }
      proposals.push({
        id: idOf(f.page, kind, f.selector), ...base, outPath: page.outPath,
        change: { property: 'color', from: m.fg, to, background: m.bg },
        before: { ratio: before }, after: { ratio: after }, needs: m.expected,
        text: `${m.fg.toUpperCase()} → ${to.toUpperCase()}, ${before} → ${after}`,
      });
    } else {
      // The heading before it in the page, as written: the level after that one is the first that skips nothing.
      const all = $(HEADING).toArray();
      const at = all.indexOf(el.get(0));
      const prev = at > 0 ? levelOf($, $(all[at - 1])) : 0;
      const from = levelOf($, el);
      const to = prev + 1;
      if (at < 0 || to >= from) {
        skipped.push({ ...base, why: 'in the page as written the headings before it skip no level' });
        continue;
      }
      const tag = el.get(0).name;
      proposals.push({
        id: idOf(f.page, kind, f.selector), ...base, outPath: page.outPath,
        change: { attribute: 'aria-level', from, to, tag },
        text: `${/^h[1-6]$/.test(tag) ? tag : 'heading'} → heading level ${to} (aria-level="${to}"), tag and look kept`,
      });
    }
  }
  return { proposals, skipped };
}

/**
 * The proposals of a finished copy from its last re-check as saved, kept in `<recreate>/fix-mode/proposals.json` (made again
 * only when a newer re-check exists). Files only: the homepage's axe.json and the first run of each page's Lighthouse reports.
 * @param {{ folder: string, reauditId: string, pages: { path: string, outPath: string }[], pageSlugStem: (p: string) => string }} o
 */
export async function proposalsForCopy({ folder, reauditId, pages, pageSlugStem }) {
  const file = path.join(folder, FIX_MODE_DIR, PROPOSALS_FILE);
  const kept = await readFile(file, 'utf8').then(JSON.parse, () => null);
  if (kept?.reauditId === reauditId) return kept;
  const rdir = path.join(folder, 'reaudit', reauditId);
  const copyDir = path.join(folder, 'as-is', 'copy');
  const axe = await readFile(path.join(rdir, 'axe.json'), 'utf8').then(JSON.parse, () => null);
  const lhFiles = await readdir(path.join(rdir, 'lighthouse-pages')).catch(() => []);
  const lighthouse = [];
  for (const p of pages) {
    const stem = pageSlugStem(p.path);
    for (const f of lhFiles.filter((n) => new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{8}-(mobile|desktop)-1\\.json\\.full\\.json$`).test(n))) {
      const lhr = await readFile(path.join(rdir, 'lighthouse-pages', f), 'utf8').then(JSON.parse, () => null);
      if (lhr) lighthouse.push({ page: p.path, lhr });
    }
  }
  const withHtml = [];
  for (const p of pages) {
    const html = await readFile(path.join(copyDir, p.outPath), 'utf8').catch(() => null);
    if (html != null) withHtml.push({ ...p, html });
  }
  const findings = findingsOf({ axe: axe && pages[0] ? { page: pages[0].path, json: axe } : null, lighthouse });
  const out = { reauditId, madeAt: new Date().toISOString(), ...proposalsFrom({ findings, pages: withHtml }), pictures: null, looks: null };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(out, null, 1), 'utf8');
  return out;
}

/** One proposal written into a parsed page; false when its element is not there exactly once. */
function applyOne($, p) {
  const { el } = only($, p.selector);
  if (!el) return false;
  if (p.kind === 'contrast') {
    const style = (el.attr('style') ?? '').trim();
    el.attr('style', `${style ? `${style.replace(/;?\s*$/, ';')} ` : ''}color: ${p.change.to} !important`);
  } else {
    el.attr('aria-level', String(p.change.to));
  }
  return true;
}

/**
 * A page's HTML with these proposals in it, its other bytes kept (faithfulHtml).
 * @returns {{ html: string, applied: string[], missed: string[], faithful: boolean }}
 */
export function applyToHtml(html, proposals) {
  // A bundled page's changes go into the document its template draws (copy/bundled.js), the rest of the page as it was.
  const t = bundledTemplate(html);
  const doc = t ? t.inner : html;
  const $ = loadFaithful(doc);
  const applied = [];
  const missed = [];
  for (const p of proposals) (applyOne($, p) ? applied : missed).push(p.id);
  const out = faithfulHtml($, doc);
  return { html: t ? withTemplate(html, t, out.html) : out.html, applied, missed, faithful: out.faithful };
}

/** Every file under `dir` → sha256. */
async function hashes(dir) {
  const out = new Map();
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    out.set(path.relative(dir, file).split(path.sep).join('/'), createHash('sha256').update(await readFile(file)).digest('hex'));
  }
  return out;
}

/**
 * The approved proposals written into a fresh copy of the finished copy, and proved. A failed proof leaves `dir` exactly the
 * finished copy and says why. Proposals not approved are never written.
 * @param {{ fromDir: string, dir: string, proposals: object[], approved: string[] }} o
 * @returns {Promise<{ ok: boolean, why?: string, applied: object[], notApproved: number, missed: object[] }>}
 */
export async function applyApproved({ fromDir, dir, proposals, approved }) {
  const yes = new Set(approved);
  const chosen = proposals.filter((p) => yes.has(p.id));
  await rm(dir, { recursive: true, force: true });
  await cp(fromDir, dir, { recursive: true });
  const before = await hashes(dir);
  const byFile = new Map();
  for (const p of chosen) byFile.set(p.outPath, [...(byFile.get(p.outPath) ?? []), p]);
  const applied = [];
  const missed = [];
  const reset = async (why) => {
    await rm(dir, { recursive: true, force: true });
    await cp(fromDir, dir, { recursive: true });
    return { ok: false, why, applied: [], notApproved: proposals.length - chosen.length, missed: chosen };
  };
  for (const [outPath, list] of byFile) {
    const file = path.join(dir, outPath);
    const html = await readFile(file, 'utf8').catch(() => null);
    if (html == null) {
      missed.push(...list);
      continue;
    }
    const out = applyToHtml(html, list);
    for (const p of list) (out.applied.includes(p.id) ? applied : missed).push(p);
    if (out.applied.length) await writeFile(file, out.html, 'utf8');
  }
  // Proof: only the pages with an applied change differ; each applied change is in its page; the rest is byte for byte the same.
  const changedPages = new Set(applied.map((p) => p.outPath.split(path.sep).join('/')));
  const after = await hashes(dir);
  for (const [rel, h] of before) {
    if (!after.has(rel)) return reset(`${rel} is gone`);
    if (after.get(rel) !== h && !changedPages.has(rel)) return reset(`${rel} changed`);
  }
  for (const rel of after.keys()) if (!before.has(rel)) return reset(`${rel} appeared`);
  for (const p of applied) {
    const $ = cheerio.load(drawnHtml(await readFile(path.join(dir, p.outPath), 'utf8')));
    const { el } = only($, p.selector);
    const inPlace = el && (p.kind === 'contrast' ? (el.attr('style') ?? '').includes(`color: ${p.change.to} !important`) : el.attr('aria-level') === String(p.change.to));
    if (!inPlace) return reset(`the change "${p.text}" is not in ${p.outPath}`);
  }
  return { ok: true, applied, notApproved: proposals.length - chosen.length, missed };
}

/** A crop of one PNG around a box (CSS px = picture px: the look check pictures at scale 1), with the box marked. */
async function cropMarked(png, box, file) {
  const meta = await sharp(png).metadata();
  const left = Math.max(0, Math.floor(box.x - CROP_PAD));
  const top = Math.max(0, Math.floor(box.y - CROP_PAD));
  const width = Math.min(meta.width - left, Math.ceil(box.width + 2 * CROP_PAD), CROP_MAX.width);
  const height = Math.min(meta.height - top, Math.ceil(box.height + 2 * CROP_PAD), CROP_MAX.height);
  if (width <= 0 || height <= 0) return false;
  const bx = Math.max(1, Math.round(box.x - left));
  const by = Math.max(1, Math.round(box.y - top));
  const bw = Math.max(2, Math.min(width - bx - 1, Math.round(box.width)));
  const bh = Math.max(2, Math.min(height - by - 1, Math.round(box.height)));
  const mark = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="#c2410c" stroke-width="2" stroke-dasharray="6 3"/></svg>`);
  await sharp(png).extract({ left, top, width, height }).composite([{ input: mark }]).png().toFile(file);
  return true;
}

/**
 * The same change, wherever it is: a colour moved the same way on the same background (a header link on every page), or a
 * heading level moved the same way on the same element. The app shows one row per group, and one picture per group is enough.
 */
export const groupKey = (p) => (p.kind === 'contrast'
  ? `contrast|${p.change.from}|${p.change.to}|${p.change.background}`
  : `${p.kind}|${p.selector}|${p.change.from}|${p.change.to}`);

/** One proposal of each group, in order: the ones worth picturing. */
export function representatives(proposals) {
  const seen = new Set();
  return proposals.filter((p) => !seen.has(groupKey(p)) && seen.add(groupKey(p)));
}

/** Most proposals pictured in one go (each costs one look per width); the rest are listed without pictures. */
export const MAX_PICTURED = 40;

/**
 * Before / after pictures of every proposal, through the look check's own pictures: each proposal ALONE in a copy of the
 * finished copy, pictured side by side with the finished copy (one round, frozen the same way) at each width; the gate's
 * verdict says how many pixels that one change moves, and its element is cropped from both pictures with its box marked.
 * @param {{ browser: import('playwright').Browser, copyDir: string, workDir: string, proposals: object[], widths?: number[],
 *   serve: (dir: string) => Promise<{ url: string, close: () => Promise<void> }>,
 *   pictureRounds: Function, gateVerdict: Function, viewOf: (width: number) => object }} o
 * @returns {Promise<{ pictures: Record<string, { width: number, before?: string, after?: string, missing?: true }[]>, looks: object[] }>}
 */
export async function proposalPictures({ browser, copyDir, workDir, proposals, widths = FIX_WIDTHS, serve, pictureRounds, gateVerdict, viewOf }) {
  const out = {};
  const looks = [];
  const fixedDir = path.join(workDir, 'with');
  await mkdir(workDir, { recursive: true });
  const unfixed = await serve(copyDir);
  const baseOf = (s) => s.url.replace(/\/$/, '');
  try {
    for (const p of proposals.slice(0, MAX_PICTURED)) {
      const applied = await applyApproved({ fromDir: copyDir, dir: fixedDir, proposals: [p], approved: [p.id] });
      if (!applied.applied.length) {
        out[p.id] = widths.map((width) => ({ width, missing: true }));
        continue;
      }
      const fixed = await serve(fixedDir);
      try {
        for (const width of widths) {
          // The element's box, read in each side's page after its picture (no extra load: the look check's own visit).
          const read = (page) => page.evaluate((sel) => {
            const r = document.querySelector(sel)?.getBoundingClientRect();
            return r && r.width > 0 && r.height > 0 ? { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height } : null;
          }, p.selector);
          const sides = [
            { base: baseOf(fixed), url: `${baseOf(fixed)}${p.page}`, inspect: read },
            { base: baseOf(unfixed), url: `${baseOf(unfixed)}${p.page}`, inspect: read },
          ];
          const [[after], [before]] = await pictureRounds(browser, viewOf(width), sides, 1);
          const verdict = await gateVerdict([after], [before]);
          looks.push({ id: p.id, page: p.page, width, changedPx: verdict.changedPx, sizeChanged: verdict.sizeChanged });
          const box = sides[0].inspected?.error ? null : (sides[0].inspected ?? sides[1].inspected);
          const entry = { width };
          if (box && !box.error) {
            const name = (side) => `${p.id}-${width}-${side}.png`;
            if (await cropMarked(before, box, path.join(workDir, name('before')))) entry.before = name('before');
            if (await cropMarked(after, box, path.join(workDir, name('after')))) entry.after = name('after');
          }
          if (!entry.before) entry.missing = true; // not drawn at this width (hidden, or the page shows another version)
          (out[p.id] ??= []).push(entry);
        }
      } finally {
        await fixed.close();
      }
    }
  } finally {
    await unfixed.close();
    await rm(fixedDir, { recursive: true, force: true });
  }
  return { pictures: out, looks };
}
