// The copy an app stack (React + Vite, Next.js, MERN) is converted from: every page whose original framework runtime would draw
// over the converted components is written without that runtime, when a browser proves the page does without it.
//
// The problem (convert/runtime.js says why): a page of a hydrating site keeps its framework's runtime and the data it renders
// from; converted into components it loads that runtime, which draws the original's content over whatever the owner changed in a
// component. The components are then not the page's source, which is the one thing a conversion into a stack is for.
//
// Per page, in a browser, against the as-is copy served as it is:
//   1. edits   a marker is written into every section (one per component) and the page is opened and scrolled: a marker that is
//              gone was drawn over. None gone: the page is left as it is (nothing to do). The page has no text to mark (its
//              script draws all of it): left as it is and said so.
//   2. runtime the runtime the page carries is recognised (convert/runtime.js); none recognised: left as it is and said so.
//   3. without it, the page must
//              - keep every marker (or at least lose fewer: the sections still drawn over are named),
//              - look the same at phone and computer width (fixGate: the picture rounds and the noise rule every fix of the copy
//                is held to, and no new console error),
//              - answer every control (button, summary, [aria-expanded], tab) the same way, clicked in turn at both widths,
//              - keep moving by itself when the as-is page does (a carousel or a feed the runtime drove).
//   The page's title and description as the runtime left them (metadata a framework streams in after load) are written into
//   the page's own head first, so the page names itself as visitors saw it.
// Any check failing keeps the page as it is (with its runtime) and says which. Nothing is guessed: a page is changed only when
// all of them pass.
//
// Then the runtime files no page needs any more leave the copy (and the service worker's map), so the download does not ship
// dead code. A later packaging without a browser (the address or the approved-changes stage, which change only head tags and
// single styles) repeats the decisions recorded here instead of proving them again.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { motionPlan, withRebuiltMotion } from './rebuildMotion.js';
import { settledStyles, withoutStartStates } from './startStates.js';
import { CONTROLS_FILE, CONTROLS_JS, planReplay, probeControls, probeScrollStates, withReplay } from './controls.js';
import { MOTION_FILE, motionJsMinified } from '../../emit/motionScript.js';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { markEdits, runtimesOf, withoutRuntime, pruneServiceWorker } from '../../convert/runtime.js';
import { fixGate, isolated, openAndScroll, textDelta, viewOf, GATE_WIDTHS, inPool } from './check.js';
import { serveCopy } from './serve.js';
import { localOfOutPath } from './asis.js';

/** Wait after the scroll for a runtime that hydrates late (on idle, or a section as it comes into view). */
export const SETTLE_MS = 1500;
/** Controls clicked per page and width. */
export const MAX_CONTROLS = 16;
/** How long a page is watched for moving by itself. */
export const MOVE_WATCH_MS = 3000;
const CONTROLS = 'button, summary, [aria-expanded], [role="tab"], [role="button"]';

/** Each marker of `marks` that the page served at base + pagePath no longer shows once loaded, scrolled and settled. */
export async function lostMarks(browser, base, pagePath, marks) {
  const context = await isolated(browser, viewOf(1440), base, []);
  try {
    const page = await context.newPage();
    await openAndScroll(page, `${base}${pagePath}`);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    const text = await page.evaluate(() => document.documentElement.textContent ?? '');
    const head = await page.evaluate(() => ({
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
    }));
    return { lost: marks.filter((m) => !text.includes(m.mark)).map((m) => m.part), head };
  } finally {
    await context.close();
  }
}

/**
 * How the page's controls answer clicks, and whether the page moves by itself, at one width: one load, a still reading
 * MOVE_WATCH_MS apart, then each control clicked in turn (a control that leaves the page reloads it). Both sides of a comparison
 * are read the same way, so what one click leaves behind for the next is the same on both when they behave alike.
 */
export async function behaviourAt(browser, base, pagePath, width) {
  const errors = [];
  const context = await isolated(browser, viewOf(width), base, []);
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
    const url = `${base}${pagePath}`;
    await openAndScroll(page, url);
    await page.waitForTimeout(SETTLE_MS);
    // What a script changes on its own: the text, and the inline styles and classes it writes.
    const still = () => page.evaluate(() => {
      const parts = [document.body?.innerText ?? ''];
      for (const el of document.body?.querySelectorAll('*') ?? []) parts.push(`${el.getAttribute('style') ?? ''}|${typeof el.className === 'string' ? el.className : ''}`);
      return parts.join('\n');
    });
    const first = await still();
    await page.waitForTimeout(MOVE_WATCH_MS);
    const moves = first !== (await still());
    const count = Math.min(await page.locator(CONTROLS).count(), MAX_CONTROLS);
    const clicks = [];
    for (let i = 0; i < count; i++) {
      const el = page.locator(CONTROLS).nth(i);
      if (!(await el.isVisible().catch(() => false))) { clicks.push({ i, shown: false }); continue; }
      const label = ((await el.getAttribute('aria-label').catch(() => null)) || (await el.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const before = await page.evaluate(() => document.body?.innerText ?? '');
      await el.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      const at = page.url().replace(base, '');
      clicks.push({ i, shown: true, label, delta: textDelta(before, after), at });
      if (at.split('#')[0] !== pagePath) await openAndScroll(page, url);
    }
    return { width, moves, controls: await page.locator(CONTROLS).count().catch(() => count), clicks, errors };
  } finally {
    await context.close();
  }
}

/** Where two behaviour readings of the same page differ, in words (empty: the same). */
export function behaviourGaps(free, asIs) {
  const gaps = [];
  if (asIs.moves && !free.moves) gaps.push(`at ${asIs.width} px the page stops changing by itself (a carousel, a feed or an animation the runtime drove)`);
  const n = Math.max(free.clicks.length, asIs.clicks.length);
  for (let i = 0; i < n; i++) {
    const f = free.clicks[i];
    const a = asIs.clicks[i];
    if (!f || !a) { gaps.push(`at ${asIs.width} px the page has ${free.clicks.length} controls instead of ${asIs.clicks.length}`); break; }
    if (!f.shown && !a.shown) continue;
    const same = f.shown === a.shown && f.at === a.at && JSON.stringify(f.delta) === JSON.stringify(a.delta);
    if (!same) gaps.push(`at ${asIs.width} px ${a.label ? `the “${a.label}” control` : `control ${i + 1}`} does not answer a click as it does with the runtime`);
  }
  return gaps;
}

/** The page's head with the title and description the runtime left (null when there is nothing to change). */
export function withHead(html, head) {
  if (!head) return null;
  const $ = cheerio.load(html);
  let changed = null;
  const title = $('head > title').first();
  if (head.title && head.title !== title.text()) {
    changed = { ...changed, title: { from: title.length ? title.text() : null, to: head.title } };
    if (title.length) title.text(head.title);
    else $('head').append($('<title>').text(head.title));
  }
  const desc = $('head > meta[name="description"]').first();
  if (head.description && desc.length && head.description !== desc.attr('content')) {
    changed = { ...changed, description: { from: desc.attr('content'), to: head.description } };
    desc.attr('content', head.description);
  }
  return changed ? { html: $.html(), changed } : null;
}

/** Serves the copy with some pages (and files, such as the rebuilt animations' script) replaced; its base address and close. */
async function served(copyDir, pagesHtml, files = {}) {
  const overrides = new Map([...Object.entries(pagesHtml), ...Object.entries(files)].map(([rel, text]) => [path.resolve(copyDir, rel), Buffer.from(text)]));
  const s = await serveCopy(copyDir, { overrides });
  return { base: s.url.replace(/\/$/, ''), close: s.close };
}

/**
 * The animations the copy rebuilds for its pages (rebuildMotion.js), planned once for the whole copy: the plan, the script's
 * address and source. Null when the job's capture holds no recording (an older copy): the pages are then checked bare.
 */
export async function motionFor({ jobDir, copyDir, pages }) {
  if (!jobDir) return null;
  const plan = await motionPlan({ dir: jobDir, pages }).catch(() => null);
  if (!plan) return null;
  const source = motionJsMinified();
  const existing = await readFile(path.join(copyDir, MOTION_FILE), 'utf8').catch(() => null);
  const file = existing != null && existing !== source ? `js/sas-motion-${createHash('sha256').update(source).digest('hex').slice(0, 10)}.js` : MOTION_FILE;
  return { plan, file, source };
}

/**
 * The page without its runtime, with the head the runtime left, the start states that runtime would have animated away
 * dropped (startStates.js; `settled` = the capture's reading of this page) and the rebuilt animations.
 */
export function freePage(html, { only = null, head = null, motion = null, settled = null, outPath }) {
  const stripped = withoutRuntime(html, only ? { only } : {});
  const withH = head ? withHead(stripped.html, head) : null;
  let out = withH?.html ?? stripped.html;
  const shown = withoutStartStates(out, settled);
  out = shown.html;
  let rebuilt = null;
  const pagePlan = motion?.plan.pages.get(outPath);
  if (pagePlan) {
    const r = withRebuiltMotion(out, pagePlan, motion.plan.ir, { outPath, scriptSrc: `/${motion.file}` });
    out = r.html;
    rebuilt = { placed: r.placed, lost: r.lost, tokens: r.tokens, notCarried: pagePlan.notCarried, ...(r.lostPaths?.length && { lostPaths: r.lostPaths.slice(0, 5) }) };
  }
  return { html: out, stripped, head: withH?.changed ?? null, rebuilt, ...(shown.cleared && { shown: { elements: shown.cleared, declarations: shown.declarations } }) };
}

/**
 * Decides one page (see the head of this file). Returns its record; `html` (not recorded) is the page to convert from when its
 * runtime goes. Every difference the checks find is kept (`gaps`): with `prefer: 'editable'` (the default) the runtime goes
 * anyway and the gaps are what the owner is told the page loses; with `prefer: 'exact'` any gap keeps the runtime.
 */
export async function decidePage({ browser, copyDir, outPath, motion = null, settled = null, prefer = 'editable', log = () => {} }) {
  const pagePath = localOfOutPath(outPath);
  const html = await readFile(path.join(copyDir, outPath), 'utf8');
  const runtimes = runtimesOf(html);
  const record = { path: pagePath, runtimes: runtimes.map((r) => r.name) };
  const marked = markEdits(html);
  if (!marked.marks.length) return { ...record, status: 'scriptDrawn' };

  log(`runtime ${pagePath}: are edits kept?`);
  const files = motion ? { [motion.file]: motion.source } : {};
  // The page without its runtime and with the rebuilt animations, marked and read side by side with the page as it is (the
  // second reading is used only when the first loses a marker).
  const bare = runtimes.length ? freePage(html, { motion, settled, outPath }) : null;
  const marks = async (doc, extra = {}) => {
    const m = markEdits(doc);
    const side = await served(copyDir, { [outPath]: m.html }, extra);
    try { return await lostMarks(browser, side.base, pagePath, m.marks); } finally { await side.close(); }
  };
  const [before, after] = await Promise.all([marks(html), bare ? marks(bare.html, files) : null]);
  if (!before.lost.length) return { ...record, status: 'fine' };
  record.overwritten = before.lost;
  if (!bare) return { ...record, status: 'kept', why: 'unknown' };
  if (after.lost.length >= before.lost.length) return { ...record, status: 'kept', why: 'stillOverwritten', stillOverwritten: after.lost };
  // The head as the runtime left it changes no text of the body, so the reading above holds for it too.
  const free = freePage(html, { head: before.head, motion, settled, outPath });

  // Every button as on the original: what a click does there that it does not do here is replayed (controls.js).
  log(`runtime ${pagePath}: do the buttons work as on the original?`);
  let replay = null;
  {
    const a = await served(copyDir, {});
    const f = await served(copyDir, { [outPath]: free.html }, files);
    try {
      const clicks = { asIs: [], free: [] };
      const scroll = { asIs: [], free: [] };
      for (const width of GATE_WIDTHS) {
        const [ca, cf, sa, sf] = await Promise.all([
          probeControls(browser, a.base, pagePath, width), probeControls(browser, f.base, pagePath, width),
          probeScrollStates(browser, a.base, pagePath, width), probeScrollStates(browser, f.base, pagePath, width),
        ]);
        clicks.asIs.push(ca); clicks.free.push(cf); scroll.asIs.push(sa); scroll.free.push(sf);
      }
      const plan = planReplay(clicks, scroll);
      const done = withReplay(free.html, plan);
      if (done.controls || done.scroll) {
        free.html = done.html;
        replay = { controls: done.controls, scroll: done.scroll, lost: done.lost, buttons: [...new Set(plan.differs.map((d) => d.label).filter(Boolean))], plan };
      }
    } finally {
      await Promise.all([a.close(), f.close()]);
    }
  }
  const sideFiles = replay ? { ...files, [CONTROLS_FILE]: CONTROLS_JS } : files;

  log(`runtime ${pagePath}: does it look and work the same without ${runtimes.map((r) => r.name).join(', ')}?`);
  const gaps = [];
  const asIs = await served(copyDir, {});
  const freeSide = await served(copyDir, { [outPath]: free.html }, sideFiles);
  try {
    const look = await fixGate(browser, freeSide.base, asIs.base, pagePath, { widths: GATE_WIDTHS, parallel: true });
    for (const v of look.views.filter((x) => !x.invisible)) {
      if (v.newErrors?.length) gaps.push({ kind: 'error', width: v.width, text: `a new error on the page at ${v.width} px: ${v.newErrors[0]}` });
      else if (v.sizeChanged) gaps.push({ kind: 'look', width: v.width, text: `the page's height changes at ${v.width} px (${v.heights?.join(' → ') ?? ''} px)` });
      else gaps.push({ kind: 'look', width: v.width, text: `${v.changedPct}% of the page looks different at ${v.width} px` });
    }
    // Both sides at every width at once (as many contexts as the look gate opens).
    const readings = await Promise.all(GATE_WIDTHS.map((width) => Promise.all([behaviourAt(browser, freeSide.base, pagePath, width), behaviourAt(browser, asIs.base, pagePath, width)])));
    for (const [f, a] of readings) {
      for (const text of behaviourGaps(f, a)) gaps.push({ kind: /changing by itself/.test(text) ? 'motion' : 'control', width: f.width, text });
      const newErrors = f.errors.filter((e) => !a.errors.some((x) => x.includes(e)));
      if (newErrors.length) gaps.push({ kind: 'error', width: f.width, text: `a new error on the page at ${f.width} px: ${newErrors[0]}` });
    }
  } finally {
    await Promise.all([asIs.close(), freeSide.close()]);
  }
  const common = { ...(free.rebuilt && { rebuilt: free.rebuilt }), ...(free.shown && { shown: free.shown }), ...(replay && { replay }), ...(gaps.length && { gaps: gaps.slice(0, 8) }) };
  if (gaps.length && prefer !== 'editable') {
    const first = gaps[0];
    return { ...record, status: 'kept', why: first.kind === 'control' || first.kind === 'motion' ? 'behaviour' : 'look', detail: gaps.slice(0, 3).map((g) => g.text).join('; '), ...common };
  }
  return {
    ...record,
    status: 'removed',
    removed: free.stripped.removed.length,
    ids: free.stripped.runtimes.map((r) => r.id),
    files: free.stripped.files,
    ...(after.lost.length && { stillOverwritten: after.lost }),
    ...(free.head && { head: free.head }),
    ...common,
    html: free.html,
  };
}

/** Every file under a folder, '/'-separated, relative to it. */
async function listFiles(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out;
}
const TEXT = /\.(html?|css|m?js|json|webmanifest|txt|xml|svg)$/i;

/**
 * Writes the copy to convert from into outDir: copyDir, with the decided pages written without their runtime and the runtime
 * files nothing else names any more taken out.
 * @param {object} o
 * @param {import('playwright').Browser|null} o.browser  null: no proof is made, `decided` is applied
 * @param {{ pages?: object[] }|null} [o.decided]  an earlier record of this function (its `pages`)
 * @returns {Promise<{ dir: string, record: object }>}  record: { pages[], removedPages, keptPages, filesRemoved, bytesRemoved, reused? }
 */
export async function runtimeFreeCopy({ browser, copyDir, outDir, pages, decided = null, log = () => {}, pagesAtOnce = 1, jobDir = null, prefer = 'editable' }) {
  await rm(outDir, { recursive: true, force: true });
  await cp(copyDir, outDir, { recursive: true });
  const results = [];
  // The original's animations, rebuilt from what the capture recorded, go with every page whose runtime goes.
  const motion = await motionFor({ jobDir, copyDir, pages });
  // What the capture saw of every element once the original's script had run: the start states that script would clear.
  const settled = await settledStyles({ dir: jobDir, pages }).catch(() => new Map());
  if (browser) {
    await inPool(pages, pagesAtOnce, async (p) => {
      try {
        results.push({ outPath: p.outPath, ...(await decidePage({ browser, copyDir, outPath: p.outPath, motion, settled: settled.get(p.outPath), prefer, log })) });
      } catch (err) {
        results.push({ outPath: p.outPath, path: localOfOutPath(p.outPath), status: 'kept', why: 'error', detail: String(err?.message ?? err).slice(0, 200) });
      }
    });
  } else {
    // Repeated from the earlier proof: the same runtimes taken out of the same pages, the head as it was set then.
    const earlier = new Map((decided?.pages ?? []).map((r) => [r.path, r]));
    for (const p of pages) {
      const r = earlier.get(localOfOutPath(p.outPath));
      if (r?.status !== 'removed') {
        if (r) results.push({ outPath: p.outPath, ...r });
        continue;
      }
      const html = await readFile(path.join(copyDir, p.outPath), 'utf8');
      const head = r.head ? { title: r.head.title?.to, description: r.head.description?.to } : null;
      const free = freePage(html, { only: r.ids, head, motion, settled: settled.get(p.outPath), outPath: p.outPath });
      if (r.replay?.plan) free.html = withReplay(free.html, r.replay.plan).html;
      results.push({ outPath: p.outPath, ...r, ...(free.rebuilt && { rebuilt: free.rebuilt }), ...(free.shown && { shown: free.shown }), files: free.stripped.files, html: free.html });
    }
  }
  const order = new Map(pages.map((p, i) => [p.outPath, i]));
  results.sort((a, b) => order.get(a.outPath) - order.get(b.outPath));

  // The pages as decided.
  const removed = results.filter((r) => r.status === 'removed');
  for (const r of removed) await writeFile(path.join(outDir, r.outPath), r.html, 'utf8');
  // The script that drives the rebuilt animations, beside the pages that use it.
  const animated = removed.filter((r) => r.rebuilt?.placed);
  if (motion && animated.length) {
    await mkdir(path.dirname(path.join(outDir, motion.file)), { recursive: true });
    await writeFile(path.join(outDir, motion.file), motion.source, 'utf8');
  }
  // The script that replays the buttons' clicks and the scroll states the framework drove.
  const replayed = removed.filter((r) => r.replay);
  if (replayed.length) {
    await mkdir(path.dirname(path.join(outDir, CONTROLS_FILE)), { recursive: true });
    await writeFile(path.join(outDir, CONTROLS_FILE), CONTROLS_JS, 'utf8');
  }

  // Runtime files no remaining file names (by path or by file name: bundles load each other by both) leave the copy.
  const candidates = [...new Set(removed.flatMap((r) => r.files ?? []))].map((f) => f.replace(/^\//, ''));
  const gone = [];
  let bytesRemoved = 0;
  if (candidates.length) {
    const candidateSet = new Set(candidates);
    const texts = [];
    for (const rel of await listFiles(outDir)) {
      if (candidateSet.has(rel) || rel === 'sw.js' || !TEXT.test(rel)) continue;
      texts.push(await readFile(path.join(outDir, rel), 'utf8').catch(() => ''));
    }
    for (const rel of candidates) {
      const name = path.posix.basename(rel);
      if (texts.some((t) => t.includes(name))) continue;
      const size = await readFile(path.join(outDir, rel)).then((b) => b.length, () => null);
      if (size == null) continue;
      await rm(path.join(outDir, rel), { force: true });
      gone.push(`/${rel}`);
      bytesRemoved += size;
    }
    const swPath = path.join(outDir, 'sw.js');
    const sw = await readFile(swPath, 'utf8').catch(() => null);
    const pruned = sw && gone.length ? pruneServiceWorker(sw, gone) : null;
    if (pruned && pruned !== sw) await writeFile(swPath, pruned, 'utf8');
  }

  const record = {
    pages: results.map(({ html, files, outPath, ...r }) => r),
    removedPages: removed.length,
    keptPages: results.filter((r) => r.status === 'kept').length,
    filesRemoved: gone.length,
    bytesRemoved,
    ...(!browser && { reused: true }),
    ...(animated.length && { animations: { pages: animated.length, placed: animated.reduce((n, r) => n + r.rebuilt.placed, 0), lost: animated.reduce((n, r) => n + (r.rebuilt.lost ?? 0), 0), script: `/${motion.file}` } }),
    ...(!motion && removed.length && { animations: { none: true } }),
    ...(replayed.length && { buttons: { pages: replayed.length, controls: replayed.reduce((n, r) => n + r.replay.controls, 0), scroll: replayed.reduce((n, r) => n + r.replay.scroll, 0), script: `/${CONTROLS_FILE}` } }),
    prefer,
  };
  return { dir: outDir, record };
}
