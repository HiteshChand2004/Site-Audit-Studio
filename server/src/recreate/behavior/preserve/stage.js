// The "Original as-is" stage of a Recreate job (mode "as-is"). It lifts the pages captured by the job's inspect step (or, for a
// repack, takes the lifted copy of an earlier as-is job: the lift is not repeated), keeps the copy with its page set in
// as-is/, packages the chosen stack, builds and runs it, checks it (check.js) and measures it once with Lighthouse on desktop.
// The result is recorded in the job's report with `mode: 'as-is'`, so the download, the report and the app's stacks read it
// the same way as a clean copy.
import { cp, mkdir, rm, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { liftSite, localOfOutPath } from './asis.js';
import { pageDocumentOf } from './pageLift.js';
import { readRecordIndex } from '../scripts.js';
import { packLifted, servedDir } from './pack.js';
import { buildConvertedReact, convertToReact, REACT_EXPORT_DIR, verifyConverted } from '../../convert/react.js';
import { buildConverted, convertToNext, dropBuildFolder, EXPORT_DIR } from '../../convert/next.js';
import { buildConvertedMern, convertToMern, MERN_EXPORT_DIR, verifyConvertedMern } from '../../convert/mern.js';
import { dropMissingPreloads } from './preloads.js';
import { buildStack, startStack } from './serveStack.js';
import { writeLockfiles } from '../../../toolchains/lockfile.js';
import { anchorClicks, checkCopy, excludedHostsOf, fixGate, formsInCopy, NOISE_SHOTS, perfProbe, probeOriginal } from './check.js';
import { localFileOf, namesStillUsed, PERF_KINDS, planPerf, stylesheetCandidates } from '../../../copy/perfAsIs.js';
import { formRoutesOfCopy, formsReadmeSection } from '../../../copy/formRoutes.js';
import { fixAsIsCopy, fixGroup, revertPage } from '../../../copy/fixAsIs.js';
import { axeRulesFor, checkGone, judgeAxe, mergeVerdicts } from '../../../copy/fixGone.js';
import { addressForCopy } from '../../../copy/address.js';
import { addressPass } from '../../../copy/addressPass.js';
import { applyApproved, FIX_MODE_DIR, PROPOSALS_FILE } from '../../../copy/fixMode.js';
import { measureServed, servedOutcome } from '../../../copy/served.js';
import { slugFor } from '../../discover.js';
import { serveCopy } from './serve.js';
import { domainLockedParts, lockedItems } from './domainLock.js';
import { fetchLlmsTxt } from '../../../audit/robots.js';
import { runLighthouse } from '../../../audit/lighthouse/run.js';
import { RecreateError } from '../../errors.js';
import { openLinkChecker } from '../../../copy/linkBrowser.js';
import { linkCounts, linkPass } from '../../../copy/linkPass.js';
import { addNoticePages } from '../../../copy/noticePages.js';
import { copyChecksOf } from '../../../copy/checks.js';
import { issueLogger } from '../../../copy/serverLog.js';
import { LOGS_DIR } from '../../../config/paths.js';
import { PAGE_MB, parallelism } from '../../../audit/resources.js';

// Pages whose fixes are proved at the same time: a look opens both sides at both widths (4 contexts), so as many pages as the
// job's memory holds that many for, at most FIX_PAGES_MAX (one by one, 25 pages took about 8 min each: 2026-11-10, predco.ai).
const FIX_PAGES_MAX = 2;
const fixPagesAtOnce = () => parallelism({ perUnitMB: PAGE_MB * 4, max: FIX_PAGES_MAX, min: 1 });

/** Runs `task` for every item, at most `size` at once, each started in the items' order. */
async function inPool(items, size, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
}

/** The stacks an as-is copy can be packaged into (the plain copy and the three app stacks). */
export const ASIS_STACKS = ['html', 'react-vite', 'nextjs', 'mern'];
/**
 * The stacks whose copy is converted into real code (recreate/convert/): the words the progress and the report use, the writer,
 * its build, the check of the built pages against the as-is pages (where the stack has one), the folder the build writes, and
 * what runs it: `static` (the export is static files, served as a static host serves them) or `server` (the project's own
 * server: MERN, whose Express server serves the built client and stores the forms).
 */
const CONVERTERS = {
  'react-vite': { code: 'React', project: 'React + Vite', convert: convertToReact, build: buildConvertedReact, verify: verifyConverted, exportDir: REACT_EXPORT_DIR, runs: 'static' },
  nextjs: { code: 'Next.js', project: 'Next.js', convert: convertToNext, build: buildConverted, verify: null, exportDir: EXPORT_DIR, runs: 'static' },
  mern: { code: 'React', project: 'MERN', convert: convertToMern, build: buildConvertedMern, verify: verifyConvertedMern, exportDir: MERN_EXPORT_DIR, runs: 'server' },
};
/** The lifted copy and its page set, kept in the job's folder: a repack for another stack starts from them. */
export const ASIS_DIR = 'as-is';
export const ASIS_PAGES_FILE = path.join(ASIS_DIR, 'pages.json');

/** Sizes of the copy's own scripts, raw and gzipped (the JavaScript a visitor downloads from the copy). */
async function javascriptOf(dir) {
  let files = 0;
  let bytes = 0;
  let gzipBytes = 0;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') await walk(p);
      } else if (/\.m?js$/i.test(e.name)) {
        const buf = await readFile(p);
        files++;
        bytes += buf.length;
        gzipBytes += gzipSync(buf).length;
      }
    }
  };
  await walk(dir);
  return { files, bytes, gzipBytes };
}

/**
 * The report's page list of a repack (another stack from a kept copy). Such a job runs no capture, which is what fills
 * `report.pages` in a copy made from the site, so it would say "0 pages copied": the earlier job's list is taken (without its
 * capture folder, which stays in that job), else one entry per page of the saved page set.
 * @returns {Promise<{ url: string, path: string, outPath: string }[]>}
 */
export async function repackPages(fromDir, pages) {
  const earlier = await readFile(path.join(fromDir, 'report.json'), 'utf8').then(JSON.parse, () => null);
  const byOutPath = new Map((earlier?.pages ?? []).map(({ slug, ...p }) => [p.outPath, p]));
  return pages.map((p) => byOutPath.get(p.outPath) ?? { url: p.url, path: new URL(p.url).pathname, outPath: p.outPath, source: 'reused' });
}

/**
 * The page set and lift of a finished as-is job's folder. A job that kept as-is/pages.json gives it; an older one (before the
 * page set was kept) gives the pages its report recorded, with the same addresses (its own lift is still in as-is/copy).
 * @returns {Promise<{ pages: { url: string, outPath: string }[], excludedHosts: string[], lift: object | null } | null>}
 */
export async function readLifted(dir) {
  const saved = await readFile(path.join(dir, ASIS_PAGES_FILE), 'utf8').then(JSON.parse, () => null);
  if (saved?.pages?.length) return { pages: saved.pages, excludedHosts: saved.excludedHosts ?? [], lift: saved.lift ?? null };
  const report = await readFile(path.join(dir, 'report.json'), 'utf8').then(JSON.parse, () => null);
  const pages = report?.asIs?.pages ?? [];
  if (!pages.length) return null;
  const outPathOf = (p) => (p === '/' ? 'index.html' : p.endsWith('/') ? `${p.slice(1)}index.html` : p.slice(1));
  return {
    pages: pages.map((p) => ({ url: p.url, outPath: outPathOf(p.path) })),
    excludedHosts: report.asIs.excludedByRule ?? [],
    lift: report.asIs.lift ?? null,
  };
}

/**
 * The local stylesheets without their whitespace (copy/perfAsIs.js stylesheetCandidates: the browser reads the same rules from
 * both), proved on EVERY page that loaded the file in the probe, against the copy before any fix (fixGate, 375 and 1440 px,
 * nothing else changed yet), each look conclusive (proven). First all candidates together; when one page is not proven, every
 * file is put back and each file is tried alone on its own pages; when more than one file passed alone, they are looked at
 * together once more. A file that is not proven keeps its original bytes. Cost: one look per page using a candidate, then (only
 * on a failure) one per page per file, and one more round together.
 * Nothing on disk changes while the files are being proved: the minified text is served in place of the file (serveCopy
 * `overrides`), so a run stopped at any moment of the proof leaves every stylesheet with its original bytes. Only the files
 * proven are written, at the very end, each one whole (written beside the gate folder, outside the copy, then renamed over it).
 */
async function minifyAndProve({ browser, copyDir, gateDir, uses, integrity, complete, measuredPages, log, lookGate = fixGate, guard = null }) {
  let found;
  try {
    found = await stylesheetCandidates({ dir: copyDir, uses, integrity, complete, measured: measuredPages, browser });
  } catch (err) {
    return { open: [{ kind: 'css', page: null, reason: 'd', detail: `The stylesheets could not be checked (${String(err?.message ?? err).slice(0, 120)}): left as they are` }], report: { files: [], looks: [] } };
  }
  const open = found.open.map((o) => ({ kind: 'css', ...o }));
  const looks = [];
  if (!found.candidates.length) return { open, report: { files: [], looks } };
  const unfixed = await serveCopy(gateDir);
  const base = unfixed.url.replace(/\/$/, '');
  // Serves these candidates minified (every other file as it is on disk), then looks at every page that uses one of them.
  const tryFiles = async (set, label) => {
    const overrides = new Map(set.map((c) => [path.resolve(c.file), Buffer.from(c.min, 'utf8')]));
    const pagesToLook = [...new Set(set.flatMap((c) => c.pages))];
    for (const pagePath of pagesToLook) {
      let side = null;
      let g;
      const seen = guard?.count ?? 0;
      try {
        side = await serveCopy(copyDir, { overrides });
        g = await lookGate(browser, side.url.replace(/\/$/, ''), base, pagePath);
      } catch (err) {
        g = { path: pagePath, invisible: false, error: String(err?.message ?? err).split('\n')[0].slice(0, 160) };
      } finally {
        await side?.close();
      }
      if ((guard?.count ?? 0) !== seen) g = { path: pagePath, invisible: false, error: STRAY_WHY };
      const ok = proven(g);
      looks.push({ files: set.map((c) => c.rel), path: pagePath, ok, width: g.width ?? null, ...(g.error && { error: g.error }) });
      log(`stylesheets (${label}) on ${pagePath}: ${ok ? 'the same' : 'not proven the same'}`);
      if (!ok) return { ok: false, why: g.invisible ? whyNotProven(g) : whyNotKept(g), page: pagePath };
    }
    return { ok: true };
  };
  let kept = [];
  try {
    const all = await tryFiles(found.candidates, 'all');
    if (all.ok) kept = found.candidates;
    else {
      for (const c of found.candidates) {
        const one = await tryFiles([c], c.rel);
        if (one.ok) kept.push(c);
        else open.push({ kind: 'css', page: one.page, reason: 'd', detail: `${c.rel} is not minified: ${one.why}` });
      }
      if (kept.length > 1 && !(await tryFiles(kept, 'together')).ok) {
        open.push({ kind: 'css', page: null, reason: 'd', detail: `${kept.map((c) => c.rel).join(', ')} are not minified: each was the same alone, not together` });
        kept = [];
      }
    }
  } catch (err) {
    kept = [];
    open.push({ kind: 'css', page: null, reason: 'd', detail: `No stylesheet is minified: the check stopped (${String(err?.message ?? err).slice(0, 120)})` });
  } finally {
    await unfixed.close();
  }
  // Only now is anything written: each proven file whole, through a temporary file outside the copy and a rename. A file that
  // cannot be replaced keeps its original bytes: a rename that fails leaves the old file as it was, so nothing is written back
  // (a plain write of the original would itself not be atomic).
  const swap = `${gateDir}-css`;
  const written = [];
  if (kept.length) {
    await rm(swap, { recursive: true, force: true });
    await mkdir(swap, { recursive: true });
    for (const [i, c] of kept.entries()) {
      const tmp = path.join(swap, `${i}.css`);
      try {
        await writeFile(tmp, c.min, 'utf8');
        await rename(tmp, c.file);
        written.push(c);
      } catch (err) {
        open.push({ kind: 'css', page: null, reason: 'd', detail: `${c.rel} is not minified: it could not be replaced (${String(err?.message ?? err).slice(0, 120)})` });
      }
    }
    await rm(swap, { recursive: true, force: true });
  }
  return {
    open,
    report: { files: written.map((c) => ({ file: c.rel, from: c.original.length, to: Buffer.byteLength(c.min), pages: c.pages })), looks },
  };
}

/** Lighthouse scores and the metrics the report shows, from one saved desktop report. */
export function scoresOf(lhr) {
  const a = lhr.audits ?? {};
  return {
    performance: Math.round((lhr.categories?.performance?.score ?? 0) * 100),
    seo: Math.round((lhr.categories?.seo?.score ?? 0) * 100),
    accessibility: Math.round((lhr.categories?.accessibility?.score ?? 0) * 100),
    bestPractices: Math.round((lhr.categories?.['best-practices']?.score ?? 0) * 100),
    lcpMs: Math.round(a['largest-contentful-paint']?.numericValue ?? 0),
    tbtMs: Math.round(a['total-blocking-time']?.numericValue ?? 0),
  };
}

/** The new site's address, or null when none was set (the job's base address is then the original's own). */
export function newSiteOf(baseUrl, siteUrl) {
  try {
    const host = (u) => new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    return baseUrl && host(baseUrl) !== host(siteUrl) ? new URL(baseUrl).origin : null;
  } catch {
    return null;
  }
}

/**
 * A speed fix (lcp, lazy, webp, css) is kept only on a look that is conclusive, not merely one that found no change: no error,
 * at every width the same picture size, no side left unscrolled (a lazy image further down was never pictured), and nothing
 * that differed only sometimes or where the page moves by itself (inNoisePx: such pixels cannot be judged either way).
 */
export function proven(g) {
  return Boolean(g?.invisible) && !g.error && !(g.views ?? []).some((v) => v.widthMismatch || v.scrollCapped || v.inNoisePx > 0);
}

/** A group's fixes, one per kind and field (the open items of a group undone for having no effect). */
const uniqueFields = (fixes) => [...new Map(fixes.map((f) => [`${f.kind}|${f.field ?? ''}`, f])).values()];

/** Why a look that found no change still does not prove a speed fix (see proven). */
const whyNotProven = (g) => {
  const v = (g.views ?? []).find((x) => x.widthMismatch || x.scrollCapped || x.inNoisePx > 0);
  if (!v) return 'the check could not prove it unchanged';
  return `the check could not prove it unchanged at ${v.width} px (${v.scrollCapped ? 'the page was not scrolled to its end' : v.widthMismatch ? 'the pictures were not the same width' : `${v.inNoisePx} px differed where the page moves by itself`})`;
};

/** Why a look at a page's fixes failed, in the report's words: what changed, and at which width. */
const whyNotKept = (g) => (g.error
  ? `the check could not prove them invisible: ${g.error}`
  : g.clicks?.differs?.length
    ? `a link given role="button" does not do the same when clicked at ${g.clicks.differs[0].width} px (link ${g.clicks.differs[0].index + 1} of the page)`
    : `they changed the page${g.width ? ` at ${g.width} px` : ''} (${g.sizeChanged ? `its height ${g.heights?.[0]} → ${g.heights?.[1]} px` : `${g.changedPx} px where the page does not move by itself`}${g.newErrors?.length ? `, ${g.newErrors.length} new console error(s)` : ''})`);

/**
 * The safe fixes (copy/fixAsIs.js), then the proof: every page they changed is compared with itself before them (fixGate, at
 * 375 and 1440 px). A page whose fixes are not invisible gets its lifted HTML back; then each group of its fixes (fixAsIs.js
 * fixGroup) is made alone from the lifted pages and looked at, and the groups invisible alone are made together and looked at
 * once more. What passes that is kept; every other group is listed as dropped (reason d, with the width and what changed), and a
 * page that keeps nothing is listed as reverted, as before. A look that cannot decide (an error), or a group that cannot be made
 * again on its own, drops what it covers: a fix is kept only when it is shown to change nothing. The fixed side is served by a
 * fresh server for every look, because a server keeps each file it has sent and a retry rewrites the page.
 */
export async function fixAndProve({ browser, copyDir, gateDir, pages, siteUrl, newSiteUrl, addressSkipped = null, log = () => {}, fetchLlms = null, speed = true, gone = checkGone, lookGate = fixGate, proc = process, exact = false }) {
  // While the proof runs, the browser connection's stray replies (isStrayReply) are counted instead of ending the process; the
  // page whose look or measurement saw one is not proved (its fixes are undone). Removed when the proof ends, however it ends.
  const guard = strayReplyGuard({ proc });
  try {
    return await proveFixes({ browser, copyDir, gateDir, pages, siteUrl, newSiteUrl, addressSkipped, log, fetchLlms, speed, gone, lookGate, guard, exact });
  } finally {
    guard.close();
  }
}

/**
 * The groups whose fixes only write head tags the browser never draws (title, description, the meta tags, the structured data).
 * Proved without pictures in an exact copy only (fixAndProve `exact`), where none of the original's scripts run and the one script
 * the copy ships (js/motion.js) reads no head tag: nothing can bring them onto the screen. In "Copy my site" the original's own
 * scripts run (one may print the title), so there they are looked at like every other fix.
 */
export const QUIET_GROUPS = new Set(['head:title', 'head:description', 'head:meta', 'data']);

/** A meta tag that changes how the page is drawn (the viewport, the colour scheme) or read (http-equiv, charset). */
const drawsMeta = (tag) => /\bhttp-equiv\s*=|\bcharset\s*=/i.test(tag)
  || /\bname\s*=\s*["']?\s*(viewport|color-scheme|supported-color-schemes)\b/i.test(tag);
/** A link tag that only names the page or its icon, never loads anything the page draws with. */
const quietLink = (tag) => /\brel\s*=\s*["']?\s*(canonical|alternate|icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon|manifest)\s*["']?[\s/>]/i.test(tag);

/**
 * A page's HTML without the tags nothing draws: in its head the title, the meta tags other than the ones that change the drawing
 * (drawsMeta), the naming links (quietLink), and the white space between head tags; anywhere, the structured data scripts. Two
 * pages with the same result differ only in what the browser never paints. Everything else is compared byte for byte.
 */
export function withoutUnpainted(html) {
  const s = String(html);
  const end = s.search(/<\/head\s*>/i);
  const head = (end < 0 ? '' : s.slice(0, end))
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, (tag) => (drawsMeta(tag) ? tag : ''))
    .replace(/<link\b[^>]*>/gi, (tag) => (quietLink(tag) ? '' : tag))
    .replace(/>\s+</g, '><');
  return `${head}${end < 0 ? s : s.slice(end)}`.replace(/<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>[\s\S]*?<\/script\s*>/gi, '');
}

/** Why a look or a measurement that saw a stray reply of the browser connection proves nothing. */
const STRAY_WHY = 'the browser connection gave a reply to a request it no longer had (a Playwright race while a page closed); not proved';

/**
 * Playwright's own assertion when Chrome answers a request the session no longer tracks (CRSession._onMessage: a reply with an
 * id and no callback, a race while a page or context closes). Thrown in Playwright's message loop, outside any promise of ours,
 * so it reaches the process as an uncaught exception. The reply belongs to no live request (Playwright drops the same kind of
 * reply with error -32001 silently), so nothing waits on it.
 */
export function isStrayReply(err) {
  return err instanceof Error && err.message === 'Assertion error' && /CRSession\._onMessage/.test(String(err.stack ?? ''));
}

/**
 * An `uncaughtException` listener on `proc` for the time of a proof: a stray reply (isStrayReply) is counted (`count`) and the
 * process goes on; any other error removes the listener and is thrown again on its own (Node then ends the process as it would
 * have without the listener). `close()` removes it.
 * @param {{ proc?: NodeJS.EventEmitter, rethrow?: (err: unknown) => void }} [o]
 */
export function strayReplyGuard({ proc = process, rethrow = (err) => setImmediate(() => { throw err; }) } = {}) {
  let count = 0;
  const listener = (err) => {
    if (isStrayReply(err)) {
      count++;
      return;
    }
    proc.off('uncaughtException', listener);
    rethrow(err);
  };
  proc.on('uncaughtException', listener);
  return {
    get count() { return count; },
    close: () => proc.off('uncaughtException', listener),
  };
}

async function proveFixes({ browser, copyDir, gateDir, pages, siteUrl, newSiteUrl, addressSkipped, log, fetchLlms, speed, gone, lookGate, guard, exact }) {
  // Every group judged by the "problem gone?" check (copy/fixGone.js): { path, group, result, keys }.
  const goneList = [];
  await rm(gateDir, { recursive: true, force: true });
  await cp(copyDir, gateDir, { recursive: true });
  const list = pages.map((p) => ({ path: localOfOutPath(p.outPath), outPath: p.outPath, url: p.url }));
  try {
    // Speed fixes (copy/perfAsIs.js), planned from the copy before any fix, measured at both gate widths. speed: false = none of
    // them, exactly as before C3 (a caller that proves only the markup fixes).
    const perf = new Map();
    const perfOpen = [];
    const uses = new Map();
    const integrity = new Set();
    let measured = true;
    if (speed) {
      const before = await serveCopy(gateDir);
      try {
        for (const p of list) {
          const seen = guard.count;
          try {
            // An exact copy measures both widths at the same time (two contexts in the same browser).
            const probe = await perfProbe(browser, before.url.replace(/\/$/, ''), p.path, { parallel: exact });
            if (guard.count !== seen) throw new Error(STRAY_WHY);
            const plan = planPerf(probe, p.path);
            perf.set(p.outPath, plan);
            perfOpen.push(...plan.open.map((o) => ({ kind: 'lcp', ...o })));
            for (const w of probe.widths) {
              if (!w.scrolled) {
                measured = false;
                perfOpen.push({ kind: 'css', page: p.path, reason: 'd', detail: `The page could not be scrolled to its end at ${w.width} px, so the stylesheets it loads on the way are not known: no stylesheet is minified` });
              }
              for (const s of w.styles ?? []) {
                const file = localFileOf(copyDir, 'index.html', s);
                if (file) uses.set(file, new Set([...(uses.get(file) ?? []), p.path]));
              }
              for (const s of w.integrity ?? []) {
                const file = localFileOf(copyDir, 'index.html', s);
                if (file) integrity.add(file);
              }
            }
            log(`speed plan ${p.path}: ${plan.lcp.size} largest image(s), ${plan.lazy.size} below the first screen`);
          } catch (err) {
            measured = false;
            perfOpen.push({ kind: 'lcp', page: p.path, reason: 'd', detail: `The page could not be measured (${String(err?.message ?? err).split('\n')[0].slice(0, 120)}): its images are left as they are` });
          }
        }
      } finally {
        await before.close();
      }
    }
    // An exact copy's stylesheets were minified by its build (build/minify.js, esbuild): there is nothing to try.
    const css = speed && exact
      ? { open: [], report: { files: [], looks: [], skipped: 'minified by the build' } }
      : speed
      ? await minifyAndProve({ browser, copyDir, gateDir, uses, integrity, complete: measured, measuredPages: new Set(list.map((p) => p.outPath)), log, lookGate, guard })
      : { open: [], report: null };
    const fixed = await fixAsIsCopy({ dir: copyDir, siteUrl, newSiteUrl, fetchLlms, pages: list, ...(speed && { perf }) });
    fixed.open.push(...perfOpen, ...css.open);
    // Every WebP the first pass wrote: the ones no kept fix points at are removed at the end (never a file of the original).
    const webpWritten = new Set(fixed.pages.flatMap((p) => p.fixes.filter((f) => f.kind === 'webp').map((f) => f.file)));
    const changed = fixed.pages.filter((p) => p.fixes.length);
    const gate = [];
    // Exact copy: groups proved without a picture, and looks served by an earlier identical one (no page load).
    const lighter = { structural: 0, reused: 0 };
    if (changed.length) {
      // The unfixed side never changes: one server for all of it.
      const b = await serveCopy(gateDir);
      const unfixed = b.url.replace(/\/$/, '');
      // The axe rules a page's fixes answer (Step 5c, copy/fixGone.js axeRulesFor), read in each look's own visit; the lifted
      // side once per page and width. Every look at one group alone is kept (which group made a rule worse), and the look that
      // kept a page's fixes (its axe verdict).
      const axeBefore = new Map();
      const aloneLooks = new Map();
      const finalLook = new Map();
      // A page without some of its groups, made in memory from the lifted pages (nothing written): which group made a check worse,
      // and (exact copy) whether its head fixes change only what nothing draws.
      const rebuild = (p, groups) => fixAsIsCopy({ dir: copyDir, readDir: gateDir, siteUrl, newSiteUrl, pages: list, ...(speed && { perf }), only: new Map([[p.outPath, new Set(groups)]]), write: false })
        .then((again) => again.html.get(p.outPath) ?? null);
      // Exact copy: per page, the QUIET_GROUPS whose fixes were shown to change only tags nothing draws (withoutUnpainted: the page
      // with only those groups is, apart from those tags, byte for byte the page before its fixes). Such groups need no picture,
      // and a look at other groups is the same picture with or without them: one look serves both (`reused`).
      const quietOf = new Map();
      const reused = new Map();
      if (exact) {
        for (const p of changed) {
          const qs = [...new Set(p.fixes.map(fixGroup))].filter((x) => QUIET_GROUPS.has(x));
          if (!qs.length) continue;
          const html = await rebuild(p, qs).catch(() => null);
          // Both sides go through the same parser and writer, so what is compared is the document the browser parses, not how its
          // bytes were laid out.
          const lifted = await readFile(path.join(gateDir, p.outPath), 'utf8').then((s) => cheerio.load(s).html(), () => null);
          const parsed = html == null ? null : cheerio.load(html).html();
          if (parsed != null && lifted != null && withoutUnpainted(parsed) === withoutUnpainted(lifted)) quietOf.set(p.outPath, new Set(qs));
          else log(`fixes ${p.path}: the head fixes change more than tags nothing draws; they are looked at like the others`);
        }
      }
      const look = async (p, groups = null) => {
        const quiet = quietOf.get(p.outPath);
        const painted = quiet ? (groups ?? [...new Set(p.fixes.map(fixGroup))]).filter((x) => !quiet.has(x)) : null;
        if (painted && !painted.length) {
          // Only tags nothing draws: proved by the page itself, no picture.
          lighter.structural++;
          const s = { path: p.path, invisible: true, structural: true, views: [], ...(groups && { groups }) };
          log(`fixes ${p.path}${groups ? ` [${groups.join(', ')}]` : ''}: only tags nothing draws, the rest of the page byte for byte the same`);
          return s;
        }
        const key = painted ? [...painted].sort().join(',') : null;
        const before = key ? reused.get(p.outPath)?.get(key) : null;
        if (before) {
          lighter.reused++;
          const r = { ...before, ...(groups ? { groups } : {}), reused: true };
          if (groups?.length === 1 && r.views) aloneLooks.set(p.outPath, new Map([...(aloneLooks.get(p.outPath) ?? []), [groups[0], r.views]]));
          log(`fixes ${p.path}${groups ? ` [${groups.join(', ')}]` : ''}: the same picture as the look at [${key}] (the other groups draw nothing)`);
          return r;
        }
        let a = null;
        let g;
        const seen = guard.count;
        try {
          a = await serveCopy(copyDir);
          const fixedBase = a.url.replace(/\/$/, '');
          // Both widths pictured at the same time (same rounds, same verdict per width; the first failing width in order decides).
          // One after the other halved nothing but the time: most looks pass, and a passing look pictures both widths anyway.
          g = await lookGate(browser, fixedBase, unfixed, p.path, { axeRules: axeRulesFor(p.fixes), axeBefore, parallel: true });
          // A link given a role is also clicked on both sides: invisible is not enough for something a visitor uses.
          if (g.invisible && (groups ? groups.includes('anchors') : p.fixes.some((f) => f.kind === 'anchors'))) {
            const clicks = await anchorClicks(browser, fixedBase, unfixed, p.path);
            g.clicks = { clicked: clicks.clicked, notShown: clicks.notShown, differs: clicks.differs.slice(0, 3) };
            if (!clicks.same) g.invisible = false;
          }
        } catch (err) {
          // A fixed side that cannot be served, or a look that cannot decide: not proven, so what it covers is dropped.
          g = { path: p.path, invisible: false, error: String(err?.message ?? err).split('\n')[0].slice(0, 160) };
        } finally {
          await a?.close();
        }
        // A stray reply of the browser connection during this look: nothing it saw is trusted (stray: the page is undone).
        if (guard.count !== seen) g = { path: p.path, invisible: false, error: STRAY_WHY, stray: true };
        if (key && !g.error) reused.set(p.outPath, new Map([...(reused.get(p.outPath) ?? []), [key, g]]));
        if (groups) g.groups = groups;
        if (groups?.length === 1 && g.views) aloneLooks.set(p.outPath, new Map([...(aloneLooks.get(p.outPath) ?? []), [groups[0], g.views]]));
        gate.push(g);
        log(`fixes ${p.path}${groups ? ` [${groups.join(', ')}]` : ''} ${JSON.stringify(g)}`);
        return g;
      };
      // Only these groups on this page, made again from the lifted pages; the fixes made, or null when that failed.
      const makeOnly = (p, groups) => fixAsIsCopy({ dir: copyDir, readDir: gateDir, siteUrl, newSiteUrl, pages: list, ...(speed && { perf }), only: new Map([[p.outPath, new Set(groups)]]) })
        .then((again) => {
          const q = again.pages.find((x) => x.outPath === p.outPath);
          // The page as now written: its own bytes with only these fixes, or (said why) the whole page rewritten.
          p.reserialized = q?.reserialized;
          return q?.fixes ?? [];
        }, () => null);
      const notMade = (made) => ({ invisible: false, error: made ? 'the fix is not made on its own' : 'the fix could not be made again' });
      try {
        // Each page's fixes are proved on their own page only (its HTML, its looks; the files beside the pages are already written),
        // so pages are proved side by side, as many as the memory holds (each look pictures both widths at once).
        const checkPage = async (p) => {
          const groups = [...new Set(p.fixes.map(fixGroup))];
          // Speed fixes are always proved on their own, strictly (proven), even when the page passed with everything.
          const speedGroups = groups.filter((x) => PERF_KINDS.includes(x));
          const isSpeed = (x) => speedGroups.includes(x);
          const g = await look(p);
          if (g.invisible && !speedGroups.length) {
            finalLook.set(p.outPath, g);
            return;
          }
          const original = fixed.originals.get(p.outPath);
          await revertPage(copyDir, p.outPath, original);
          if (g.stray) {
            // The look was disturbed by the browser connection: the page keeps its HTML as it was, no group is tried again.
            p.dropped = groups.map((group) => ({ group, reason: 'd', why: STRAY_WHY }));
            p.reverted = { reason: 'd', why: STRAY_WHY };
            return;
          }
          const dropped = [];
          // A first look that passed keeps its verdict for the markup groups (C1 + C2, unchanged); every group is tried alone
          // only when it failed. A page with one group was already looked at alone: that look is reused.
          let kept = g.invisible ? groups.filter((x) => !isSpeed(x)) : [];
          const alone = g.invisible ? speedGroups : groups;
          if (groups.length > 1 || g.invisible) {
            for (const group of alone) {
              const made = groups.length === 1 ? p.fixes : await makeOnly(p, [group]);
              const k = groups.length === 1 ? g : made?.length ? await look(p, [group]) : notMade(made);
              await revertPage(copyDir, p.outPath, original);
              const ok = isSpeed(group) ? proven(k) : k.invisible;
              if (ok) kept.push(group);
              else dropped.push({ group, reason: 'd', why: k.invisible ? whyNotProven(k) : whyNotKept(k) });
            }
            if (kept.length) {
              // Fixes invisible alone can still show together (a rule that needs both): one more look at them all, unless they
              // are exactly what the first look already passed.
              const made = await makeOnly(p, kept);
              const same = g.invisible && kept.length === groups.length;
              const t = !made?.length ? notMade(made) : same ? g : await look(p, kept);
              const ok = t.invisible && (!kept.some(isSpeed) || proven(t));
              if (ok) {
                p.fixes = made;
                finalLook.set(p.outPath, t);
              } else if (t.invisible && kept.some(isSpeed) && kept.some((x) => !isSpeed(x))) {
                // No change, but not proven strictly with the speed fixes in: those go, and the markup fixes are judged on their
                // own by the rule they always had (C1 + C2 unchanged).
                const markup = kept.filter((x) => !isSpeed(x));
                dropped.push(...kept.filter(isSpeed).map((group) => ({ group, reason: 'd', why: `not proven together with the other fixes: ${whyNotProven(t)}` })));
                await revertPage(copyDir, p.outPath, original);
                const m = await makeOnly(p, markup);
                const u = m?.length ? await look(p, markup) : notMade(m);
                if (u.invisible) {
                  p.fixes = m;
                  kept = markup;
                  finalLook.set(p.outPath, u);
                } else {
                  await revertPage(copyDir, p.outPath, original);
                  dropped.push(...markup.map((group) => ({ group, reason: 'd', why: `invisible alone, not together with the other kept fixes: ${whyNotKept(u)}` })));
                  kept = [];
                }
              } else {
                await revertPage(copyDir, p.outPath, original);
                dropped.push(...kept.map((group) => ({ group, reason: 'd', why: `invisible alone, not together with the other kept fixes: ${t.invisible ? whyNotProven(t) : whyNotKept(t)}` })));
                kept = [];
              }
            }
          } else dropped.push({ group: groups[0], reason: 'd', why: whyNotKept(g) });
          p.dropped = dropped;
          if (!kept.length) p.reverted = { reason: 'd', why: g.invisible ? dropped[0]?.why ?? 'not proven' : whyNotKept(g) };
        };
        await inPool(changed, fixPagesAtOnce(), checkPage);
        // The looks in page order, as when the pages were proved one after the other.
        const order = new Map(changed.map((p, i) => [p.path, i]));
        gate.sort((x, y) => (order.get(x.path) ?? 0) - (order.get(y.path) ?? 0));
        // Is the problem gone? (Step 5b, copy/fixGone.js): the markup checks each kept group targets, read from the page as lifted
        // and as fixed, no page load. A group whose problem is still there, or that made a check worse, is undone (noEffect): the
        // page is made again from the lifted pages with its other groups. Taking a group away from fixes the gate saw unchanged
        // adds nothing to the page, so it is not looked at again.
        const verdicts = await gone({ copyDir, gateDir, pages: list, fixed: fixed.pages, rebuild });
        // Step 5c: the axe rules each group answers, from the look that kept the page's fixes (width rule: only where the lifted
        // page failed them); merged with the markup verdict of the same group.
        for (const p of fixed.pages) {
          const kept = finalLook.get(p.outPath);
          if (p.reverted || !kept?.views || !p.fixes?.length) continue;
          const ax = judgeAxe({ fixes: p.fixes, views: kept.views, alone: aloneLooks.get(p.outPath) ?? new Map() });
          if (!Object.keys(ax).length) continue;
          const v = verdicts.get(p.outPath) ?? {};
          for (const [group, x] of Object.entries(ax)) v[group] = mergeVerdicts(v[group], x);
          verdicts.set(p.outPath, v);
        }
        for (const p of fixed.pages) {
          const v = verdicts.get(p.outPath);
          if (!v) continue;
          for (const [group, x] of Object.entries(v)) {
            if (x.result !== 'unjudged' || x.why) goneList.push({ path: p.path, group, result: x.result, keys: x.keys, ...(x.why && { why: x.why }) });
          }
          const bad = Object.entries(v).filter(([, x]) => x.result === 'still' || x.result === 'worse');
          if (!bad.length) continue;
          const badGroups = new Set(bad.map(([group]) => group));
          const keep = [...new Set(p.fixes.map(fixGroup))].filter((x) => !badGroups.has(x));
          const original = fixed.originals.get(p.outPath);
          for (const [group, x] of bad) {
            const why = x.result === 'worse' ? x.why : `fixed by the copy, but ${x.why}`;
            (p.dropped ??= []).push({ group, reason: 'noEffect', why });
            for (const f of uniqueFields(p.fixes.filter((f) => fixGroup(f) === group))) fixed.open.push({ kind: f.kind, ...(f.field && { field: f.field }), group, page: p.path, reason: 'noEffect', detail: why });
          }
          await revertPage(copyDir, p.outPath, original);
          const made = keep.length ? await makeOnly(p, keep) : [];
          if (made?.length) p.fixes = made;
          else {
            await revertPage(copyDir, p.outPath, original);
            p.reverted = { reason: 'noEffect', why: keep.length ? `${bad[0][1].why}; the other fixes could not be made again` : bad[0][1].why };
          }
          log(`fixes ${p.path}: undone, no effect [${[...badGroups].join(', ')}]`);
        }
      } finally {
        await b.close();
      }
    }
    // A WebP no kept fix uses is removed, but only one the fixes wrote (".sas-" in its name, not in the copy before the fixes)
    // and only when no file of the copy still names it.
    const webpKept = new Set(fixed.pages.filter((p) => !p.reverted).flatMap((p) => p.fixes.filter((f) => f.kind === 'webp').map((f) => f.file)));
    const unused = [];
    for (const f of webpWritten) {
      if (webpKept.has(f) || !path.basename(f).includes('.sas-')) continue;
      if (await readFile(path.join(gateDir, f)).then(() => true, () => false)) continue;
      unused.push(f);
    }
    if (unused.length) {
      const named = await namesStillUsed(copyDir, unused.map((f) => path.basename(f)), unused);
      for (const f of unused) if (!named.has(path.basename(f))) await rm(path.join(copyDir, f), { force: true });
    }
    const counts = {};
    for (const p of fixed.pages) if (!p.reverted) for (const f of p.fixes) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    // Fixed pages whose bytes could not be kept apart from the fixes (copy/faithfulHtml.js): written whole, with the reason.
    const reserialized = fixed.pages.filter((p) => !p.reverted && p.fixes.length && p.reserialized).map((p) => ({ path: p.path, why: p.reserialized }));
    return {
      ...(reserialized.length && { reserialized }),
      counts,
      total: Object.values(counts).reduce((s, n) => s + n, 0),
      pages: fixed.pages.map((p) => ({ path: p.path, fixes: p.fixes, ...(p.reverted && { reverted: p.reverted }), ...(p.dropped?.length && { dropped: p.dropped }) })),
      reverted: fixed.pages.filter((p) => p.reverted).length,
      // Pages that kept some of their fixes and dropped others.
      dropped: fixed.pages.filter((p) => !p.reverted && p.dropped?.length).length,
      open: [...(addressSkipped ? [{ kind: 'address', page: null, ...addressSkipped }] : []), ...fixed.open],
      // Groups the look gate kept but the "problem gone?" check undid (reason noEffect), and every verdict it reached.
      noEffect: fixed.pages.reduce((n, p) => n + (p.dropped ?? []).filter((d) => d.reason === 'noEffect').length, 0),
      gone: goneList,
      files: fixed.files,
      ...(speed && { css: css.report }),
      ...(exact && { lighter }),
      gate,
    };
  } finally {
    await rm(gateDir, { recursive: true, force: true });
  }
}

/**
 * The finished copy (copyDir) packaged as the stack's project in outDir: plain files for HTML, else converted into the stack's
 * code and built (or packed as static files inside a project of the stack when that fails: a download never fails). Writes
 * report.build / convert / lockfiles. The full stage and the address stage package the same way.
 */
async function packageCopy({ ctx, stack, copyDir, outDir, pages, siteUrl, report }) {
  ctx.progress(0.35, 'Packaging the copy');
  await rm(outDir, { recursive: true, force: true });
  if (stack === 'html') {
    await cp(copyDir, outDir, { recursive: true });
    await writeFile(path.join(outDir, 'README.md'), [
      '# Plain HTML copy',
      '',
      'The copy is static files: upload this folder as it is to any static host (Netlify, Vercel, Cloudflare Pages, GitHub Pages, S3, nginx).',
      'Every page and file is the copy\'s own; it loads nothing from the original site, and its service worker serves the files it has.',
      '',
      '## Hosting',
      '',
      'Hosting must serve HTTP/2 (or HTTP/3) and compressed text (gzip or brotli). Static hosts do both by default.',
      '',
      '## GitHub Pages',
      '',
      'The file `.nojekyll` (empty) is in this folder on purpose: without it GitHub Pages leaves out folders whose names start with `_`,',
      'and this copy keeps the original\'s `_next` folder. Keep the file when you upload.',
      '',
      // Where each form's data goes in this download (copy/formRoutes.js).
      formsReadmeSection(await formRoutesOfCopy(copyDir, pages)),
    ].join('\n'), 'utf8');
  } else if (CONVERTERS[stack]) {
    // The finished copy converted into real code of the stack (recreate/convert/): pages and components, prerendered and never
    // hydrated, so no runtime is added to what the original loads (React + Vite also holds every built page against its as-is
    // page: same DOM, no file added). If the conversion, its build or that check fails, the copy is packaged as static files
    // inside a project of the stack instead (the earlier route), and the report says so: a download never fails.
    const conv = CONVERTERS[stack];
    ctx.progress(0.4, `Converting the copy into ${conv.code} pages and components`);
    try {
      const converted = await conv.convert({ copyDir, outDir, pages, pageUrl: siteUrl });
      ctx.progress(0.45, `Building the ${conv.project} project`);
      const built = await conv.build(outDir);
      const verified = conv.verify ? await conv.verify({ copyDir, outDir, pages }) : null;
      report.build = built?.steps?.map((s) => ({ label: s.label, ms: s.ms })) ?? null;
      report.convert = { mode: 'converted', ...converted, ...(verified && { verified }) };
    } catch (err) {
      const why = String(err?.message ?? err).slice(0, 400);
      ctx.report.warnings.push(`The copy could not be converted into ${conv.code} pages and components (${why.split('\n')[0]}); it is packaged as static files inside a ${conv.project} project instead.`);
      await rm(outDir, { recursive: true, force: true });
      await packLifted({ stack, copyDir, outDir, pageUrl: siteUrl });
      ctx.progress(0.45, 'Building the stack');
      const built = await buildStack(stack, outDir);
      report.build = built?.steps?.map((s) => ({ label: s.label, ms: s.ms })) ?? null;
      report.convert = { mode: 'packed', failed: why };
    }
  } else {
    await packLifted({ stack, copyDir, outDir, pageUrl: siteUrl });
    ctx.progress(0.45, 'Building the stack');
    const built = await buildStack(stack, outDir);
    report.build = built?.steps?.map((s) => ({ label: s.label, ms: s.ms })) ?? null;
  }
  // The lockfile of every package of the project (the top, client/, server/), cut from the toolchain it was just built with:
  // `npm ci` in the download installs exactly the packages this copy was built and checked with.
  if (stack !== 'html') report.lockfiles = await writeLockfiles(outDir, { stack });
}

/** The open items of the copy's list that the address leaves for the owner (the JSON-LD note), shared by both stages. */
export function addressOpenItems(fixOpen = []) {
  return fixOpen.filter((o) => o.kind === 'address' && o.field === 'json-ld').map((o) => ({
    page: o.page ?? '/', check: 'structured data names the original', values: o.detail, tried: 'kept as the original wrote it', reason: 'owner',
  }));
}

/**
 * Open items for the pages that were not copied (copy/noticePages.js): their links open a notice page in the copy. One item
 * per page: a page that needs a server is reason b, any other (not chosen, closed by robots.txt) is the owner's choice (c).
 */
export function noticeOpenItems(notices) {
  return (notices?.pages ?? []).map((n) => ({
    page: n.path,
    check: 'page not copied',
    values: [n.reason === 'not-captured' ? 'not captured when the site was copied' : null, n.from.length ? `linked from ${n.from.join(', ')}` : null].filter(Boolean).join('; '),
    tried: n.reason === 'not-captured' ? 'a notice page of the copy stands at its address; no other page is shown in its place' : 'its links open a notice page of the copy that says so',
    reason: n.reason === 'backend' ? 'backend' : 'owner',
  }));
}

/**
 * The address stage (Step 6, ctx.asIs.addressOnly): the new site's address written into a finished copy that was made without
 * one, at download. From the finished job (`fromDir`): its fixed copy gets the address (copy/addressPass.js: files only, proved,
 * undone when the proof fails), then it is packaged as before. Nothing is lifted, fixed, pictured or measured again (no browser,
 * no page load), so the finished job's checks and Lighthouse are carried over, and its safety: the pass changes only head tags
 * and site files, which load nothing. The finished job is never changed; this job keeps the lift too, for a later repack.
 */
async function addressStage(ctx, { stack, fromDir }) {
  const earlier = fromDir ? await readFile(path.join(fromDir, 'report.json'), 'utf8').then(JSON.parse, () => null) : null;
  const saved = fromDir ? await readLifted(fromDir) : null;
  const fixedDir = fromDir ? path.join(fromDir, ASIS_DIR, 'copy') : null;
  const hasFixed = fixedDir ? await readdir(fixedDir).then((l) => l.length > 0, () => false) : false;
  if (!earlier?.asIs || !saved || !hasFixed) throw new RecreateError('The finished copy to write the address into is gone: make the copy again.');
  if (earlier.asIs.address?.used) throw new RecreateError(`This copy already names ${earlier.asIs.address.used}; make the copy again to use another address.`);
  const { pages, excludedHosts } = saved;
  const siteUrl = pages[0].url;
  const copyDir = path.join(ctx.dir, ASIS_DIR, 'copy');
  const outDir = path.join(ctx.dir, 'stacks', stack);
  ctx.report.pages = await repackPages(fromDir, pages);

  ctx.progress(0.1, 'Keeping the lifted copy');
  await mkdir(path.join(ctx.dir, ASIS_DIR), { recursive: true });
  for (const part of ['lifted', 'baseline']) {
    await cp(path.join(fromDir, ASIS_DIR, part), path.join(ctx.dir, ASIS_DIR, part), { recursive: true }).catch(() => {});
  }
  await writeFile(path.join(ctx.dir, ASIS_PAGES_FILE), `${JSON.stringify({
    createdAt: new Date().toISOString(), pages, excludedHosts, lift: saved.lift, reusedFrom: path.basename(fromDir),
  }, null, 1)}\n`, 'utf8');

  ctx.progress(0.2, 'Writing the new site\'s address');
  const address = addressForCopy({ saved: newSiteOf(ctx.baseUrl, siteUrl), confirmed: ctx.asIs?.address ?? null, siteUrl });
  const list = pages.map((p) => ({ path: localOfOutPath(p.outPath), outPath: p.outPath, url: p.url }));
  const pass = address.origin ? await addressPass({ fromDir: fixedDir, dir: copyDir, pages: list, siteUrl, newSiteUrl: address.origin }) : null;
  if (!pass) {
    await rm(copyDir, { recursive: true, force: true });
    await cp(fixedDir, copyDir, { recursive: true });
  }
  const report = { ...earlier.asIs, createdAt: new Date().toISOString(), addressedFrom: path.basename(fromDir) };
  const fixes = structuredClone(earlier.asIs.fixes ?? { counts: {}, total: 0, pages: [], open: [], files: { written: [] } });
  if (pass?.ok) {
    report.address = { used: pass.origin, at: 'download' };
    for (const p of pass.pages) {
      if (!p.fixes.length) continue;
      const entry = fixes.pages.find((q) => q.path === p.path);
      if (entry) entry.fixes = [...entry.fixes, ...p.fixes];
      else fixes.pages.push({ path: p.path, fixes: p.fixes });
    }
    for (const [kind, n] of Object.entries(pass.counts)) if (n) fixes.counts[kind] = (fixes.counts[kind] ?? 0) + n;
    fixes.total = Object.values(fixes.counts).reduce((s, n) => s + n, 0);
    // The item that said no address was given is answered; what the address leaves for the owner takes its place.
    fixes.open = [...(fixes.open ?? []).filter((o) => !(o.kind === 'address' && o.page == null)), ...pass.open];
    fixes.files = { ...(fixes.files ?? {}), ...pass.files, written: [...new Set([...(fixes.files?.written ?? []), ...pass.files.written])] };
  } else {
    const why = pass ? `the address could not be written into the copy safely (${pass.why}), so the copy is unchanged` : address.skipped.detail;
    report.address = { used: null, reason: 'c', detail: pass ? `No address was written into the copy: ${why}.` : why };
    if (pass) ctx.report.warnings.push(`The new site's address was not written: ${why}.`);
  }
  report.addressPass = pass ? { ok: pass.ok, origin: pass.origin, ...(pass.why && { why: pass.why }), counts: pass.counts } : { ok: false, skipped: true };
  report.fixes = fixes;

  await packageCopy({ ctx, stack, copyDir, outDir, pages, siteUrl, report });
  if (stack === 'nextjs') await dropBuildFolder(outDir).catch(() => {});
  const converted = report.convert?.mode === 'converted';
  report.forms = await formsInCopy(copyDir, pages.map((p) => p.outPath));
  report.formRoutes = converted && report.convert.forms ? report.convert.forms : await formRoutesOfCopy(copyDir, pages);
  // What was measured on the finished copy holds for this one: the pass changed only head tags and site files.
  report.carried = { from: path.basename(fromDir), what: 'checks, Lighthouse and safety: the address pass changes only head tags and site files' };

  const copy = structuredClone(earlier.copy ?? { openItems: [] });
  const openItems = (copy.openItems ?? []).filter((o) => !(o.check === 'new-site address' || o.check === 'structured data names the original'));
  if (!report.address.used) openItems.unshift({ page: '/', check: 'new-site address', values: report.address.detail, tried: 'canonical, link previews, robots.txt, sitemap.xml and structured data were left without an address', reason: 'owner' });
  openItems.push(...addressOpenItems(fixes.open));
  copy.openItems = openItems;
  if (copy.fixes) {
    copy.fixes = {
      ...copy.fixes, counts: fixes.counts, total: fixes.total, open: fixes.open,
      // A static copy serves every file it holds; a converted one was measured on the finished copy (the new files are not counted).
      files: stack === 'html' ? (fixes.files?.written ?? []).filter((f) => f !== '_headers') : copy.fixes.files,
    };
  }
  ctx.report.copy = copy;
  ctx.report.asIs = report;
  ctx.report.outputs[stack] = { status: 'ready', dir: path.join('stacks', stack), dist: servedDir(stack, outDir), mode: 'as-is', pages: pages.map((p) => ({ outPath: p.outPath, path: localOfOutPath(p.outPath) })) };
  ctx.report.safety = earlier.safety ?? report.safety;
  ctx.progress(1, report.address.used ? `The copy names ${report.address.used}` : 'The copy is unchanged: no address was written');
  return {};
}

/**
 * The fix-mode stage (Step 11, ctx.asIs.fixOnly): the changes the user approved one by one (copy/fixMode.js: a text colour,
 * a heading's level) written into a finished copy, files only, like the address stage. Only the approved proposals of the
 * finished job's `fix-mode/proposals.json` are written; the rest never are. Proved (only those pages changed, every change in
 * place), else the copy stays as it was and the job says why. The report lists them as changed on purpose
 * (`asIs.changedOnPurpose`): the copy differs from the original there because the user chose it, so the look check and the
 * re-check rows read those places as choices, not as differences. Nothing is lifted, pictured or measured again here; the
 * re-check that follows every copy measures the result.
 */
async function fixStage(ctx, { stack, fromDir }) {
  const earlier = fromDir ? await readFile(path.join(fromDir, 'report.json'), 'utf8').then(JSON.parse, () => null) : null;
  const saved = fromDir ? await readLifted(fromDir) : null;
  const fixedDir = fromDir ? path.join(fromDir, ASIS_DIR, 'copy') : null;
  const stored = fromDir ? await readFile(path.join(fromDir, FIX_MODE_DIR, PROPOSALS_FILE), 'utf8').then(JSON.parse, () => null) : null;
  if (!earlier?.asIs || !saved || !stored?.proposals) throw new RecreateError('The finished copy or its proposed changes are gone: make the copy again.');
  const approved = Array.isArray(ctx.asIs?.approved) ? ctx.asIs.approved : [];
  const { pages } = saved;
  const siteUrl = pages[0].url;
  const copyDir = path.join(ctx.dir, ASIS_DIR, 'copy');
  const outDir = path.join(ctx.dir, 'stacks', stack);
  ctx.report.pages = await repackPages(fromDir, pages);

  ctx.progress(0.1, 'Keeping the lifted copy');
  await mkdir(path.join(ctx.dir, ASIS_DIR), { recursive: true });
  for (const part of ['lifted', 'baseline']) {
    await cp(path.join(fromDir, ASIS_DIR, part), path.join(ctx.dir, ASIS_DIR, part), { recursive: true }).catch(() => {});
  }
  await writeFile(path.join(ctx.dir, ASIS_PAGES_FILE), `${JSON.stringify({
    createdAt: new Date().toISOString(), pages, excludedHosts: saved.excludedHosts, lift: saved.lift, reusedFrom: path.basename(fromDir),
  }, null, 1)}\n`, 'utf8');

  ctx.progress(0.3, 'Writing the changes you approved');
  const pass = await applyApproved({ fromDir: fixedDir, dir: copyDir, proposals: stored.proposals, approved });
  const report = { ...earlier.asIs, createdAt: new Date().toISOString(), fixedFrom: path.basename(fromDir) };
  const carriedOver = earlier.asIs.changedOnPurpose ?? [];
  report.changedOnPurpose = [...carriedOver, ...pass.applied.map((p) => ({
    id: p.id, page: p.page, kind: p.kind, selector: p.selector, change: p.change, text: p.text, approvedAt: new Date().toISOString(),
  }))];
  report.fixPass = { ok: pass.ok, approved: approved.length, applied: pass.applied.length, notApproved: pass.notApproved, missed: pass.missed.map((p) => p.id), ...(pass.why && { why: pass.why }) };
  if (!pass.ok) ctx.report.warnings.push(`The approved changes were not written: ${pass.why}. The copy is unchanged.`);
  else if (pass.missed.length) ctx.report.warnings.push(`${pass.missed.length} approved change(s) could not be placed in their page and were left out.`);

  await packageCopy({ ctx, stack, copyDir, outDir, pages, siteUrl, report });
  if (stack === 'nextjs') await dropBuildFolder(outDir).catch(() => {});
  const converted = report.convert?.mode === 'converted';
  report.forms = await formsInCopy(copyDir, pages.map((p) => p.outPath));
  report.formRoutes = converted && report.convert.forms ? report.convert.forms : await formRoutesOfCopy(copyDir, pages);
  report.carried = { from: path.basename(fromDir), what: 'checks, Lighthouse and safety: the approved changes are one style colour or one aria-level per element, which load nothing', changedOnPurpose: report.changedOnPurpose.length };
  ctx.report.copy = structuredClone(earlier.copy ?? { openItems: [] });
  ctx.report.asIs = report;
  ctx.report.outputs[stack] = { status: 'ready', dir: path.join('stacks', stack), dist: servedDir(stack, outDir), mode: 'as-is', pages: pages.map((p) => ({ outPath: p.outPath, path: localOfOutPath(p.outPath) })) };
  ctx.report.safety = earlier.safety ?? report.safety;
  ctx.progress(1, pass.ok ? `${pass.applied.length} approved change(s) written` : 'The copy is unchanged');
  return {};
}

/**
 * The as-is stage. `ctx.asIs`: { stack, pages?, fromDir?, addressOnly? } — `fromDir` is the folder of an earlier as-is job whose
 * copy is reused (a repack): its page set and lift are taken from there, and nothing is captured or lifted again. With
 * `addressOnly` it is that job's finished copy that is reused, and only the new site's address is written (addressStage).
 */
export async function asIsStage(ctx) {
  const stack = ctx.asIs?.stack ?? 'html';
  if (!ASIS_STACKS.includes(stack)) throw new RecreateError(`The ${stack} stack has no as-is packaging.`);
  const fromDir = ctx.asIs?.fromDir ?? null;
  if (ctx.asIs?.addressOnly) return addressStage(ctx, { stack, fromDir });
  if (ctx.asIs?.fixOnly) return fixStage(ctx, { stack, fromDir });
  const captureRoot = path.join(ctx.dir, 'capture');
  const copyDir = path.join(ctx.dir, ASIS_DIR, 'copy');
  const outDir = path.join(ctx.dir, 'stacks', stack);
  let pages;
  let excludedHosts;
  let lifted = null;
  if (fromDir) {
    const saved = await readLifted(fromDir);
    if (!saved) throw new RecreateError('The lifted copy to package is gone: make the original as-is copy again.');
    pages = saved.pages;
    excludedHosts = saved.excludedHosts;
    lifted = { ...saved.lift, reusedFrom: path.basename(fromDir) };
    ctx.report.pages = await repackPages(fromDir, pages);
  } else {
    pages = ctx.discovery?.pages ?? [];
    if (!pages.length) throw new RecreateError('No page was captured for the as-is copy.');
  }
  const siteUrl = pages[0].url;
  const report = { stack, mode: 'as-is', pages: pages.map((p) => ({ url: p.url, path: localOfOutPath(p.outPath) })), createdAt: new Date().toISOString() };
  const browser = await chromium.launch();
  const servers = [];
  try {
    if (fromDir) {
      ctx.progress(0.1, 'Reusing the lifted copy');
      await rm(copyDir, { recursive: true, force: true });
      await mkdir(path.dirname(copyDir), { recursive: true });
      // The copy as it was lifted, before the fixes of that job (an older job kept only its fixed copy: that one, then).
      const liftedFrom = path.join(fromDir, ASIS_DIR, 'lifted');
      const from = (await readdir(liftedFrom).then((l) => l.length > 0, () => false)) ? liftedFrom : path.join(fromDir, ASIS_DIR, 'copy');
      await cp(from, copyDir, { recursive: true });
      // A job lifted before uncaptured pages were left out may hold another page's document under such a page's address: the
      // capture's record of that job decides again, and those files go (a notice page "not captured" takes their place).
      if (!lifted.notCaptured) {
        const record = await readRecordIndex(path.join(fromDir, 'capture', '.network')).catch(() => null);
        const missing = record ? pages.filter((p, i) => i > 0 && !pageDocumentOf(record, p.url)).map((p) => ({ url: p.url, outPath: p.outPath })) : [];
        if (missing.length) {
          for (const p of missing) await rm(path.join(copyDir, p.outPath), { force: true });
          lifted.notCaptured = missing;
          const skip = new Set(missing.map((p) => p.url));
          pages = pages.filter((p) => !skip.has(p.url));
          ctx.report.pages = ctx.report.pages.filter((p) => !skip.has(p.url));
          report.pages = report.pages.filter((p) => !skip.has(p.url));
          ctx.report.warnings.push(`${missing.length} page(s) were not captured, so the copy has a notice page in their place: ${missing.map((p) => new URL(p.url).pathname).join(', ')}.`);
        }
      }
      // The baseline pictures travel with the copy: a repack needs no capture and no live site.
      await cp(path.join(fromDir, ASIS_DIR, 'baseline'), path.join(ctx.dir, ASIS_DIR, 'baseline'), { recursive: true }).catch(() => {});
      // This job keeps the lifted copy and its page set too: a later repack takes them from here, and the retention that keeps
      // the newest finished jobs never removes the only copy of the lift.
      await mkdir(path.join(ctx.dir, ASIS_DIR), { recursive: true });
      await writeFile(path.join(ctx.dir, ASIS_PAGES_FILE), `${JSON.stringify({
        createdAt: new Date().toISOString(), pages, excludedHosts, lift: lifted, reusedFrom: path.basename(fromDir),
      }, null, 1)}\n`, 'utf8');
    } else {
      // The record is written when the job ends; the lift needs it now (every page's document), so it is saved here first.
      await ctx.netCache?.record?.save?.().catch(() => {});
      ctx.progress(0.05, 'Excluding the parts that are not the site');
      excludedHosts = await excludedHostsOf(captureRoot, siteUrl);
      ctx.progress(0.1, 'Lifting the pages');
      await rm(copyDir, { recursive: true, force: true });
      const lift = await liftSite({ captureRoot, pages, siteUrl, outDir: copyDir, browser, excludedHosts, log: (m) => ctx.progress(0.2, m) });
      lifted = {
        files: lift.files.length,
        pages: lift.lifts,
        completion: lift.completion,
        hosts: lift.hosts.length,
        network: lift.network,
      };
      // Pages with no document of their own in the record were not lifted: they become notice pages below, never a copy of
      // another page.
      if (lift.notCaptured?.length) {
        lifted.notCaptured = lift.notCaptured;
        const skip = new Set(lift.notCaptured.map((p) => p.url));
        pages = pages.filter((p) => !skip.has(p.url));
        report.pages = report.pages.filter((p) => !skip.has(p.url));
        ctx.report.warnings.push(`${lift.notCaptured.length} page(s) were not captured, so the copy has a notice page in their place: ${lift.notCaptured.map((p) => new URL(p.url).pathname).join(', ')}.`);
      }
      if (lift.network?.stillFailed) {
        ctx.report.warnings.push(`${lift.network.stillFailed} file(s) the original serves could not be downloaded because the network was down while copying; they are missing from the copy. Make the copy again, or run scripts/refetch-missing.js on it.`);
      }
      if (lift.lifts.some((l) => l.blockers?.length)) lifted.blockers = lift.lifts.flatMap((l) => l.blockers.map((b) => ({ page: l.path, ...b })));
      // The capture's own picture of each page is the baseline the checks use when the original does not answer: kept with the lift.
      await mkdir(path.join(ctx.dir, ASIS_DIR, 'baseline'), { recursive: true });
      for (const p of pages) {
        const slug = slugFor(p.outPath);
        await cp(path.join(captureRoot, slug, 'desktop-full.webp'), path.join(ctx.dir, ASIS_DIR, 'baseline', `${slug}.webp`)).catch(() => {});
      }
      // The lifted copy and its page set stay with the job: another stack is packaged from them without lifting again.
      await mkdir(path.join(ctx.dir, ASIS_DIR), { recursive: true });
      await writeFile(path.join(ctx.dir, ASIS_PAGES_FILE), `${JSON.stringify({
        createdAt: new Date().toISOString(), pages: pages.map((p) => ({ url: p.url, outPath: p.outPath })), excludedHosts, lift: lifted,
      }, null, 1)}\n`, 'utf8');
    }
    // The copy as lifted is kept apart: the fixes below change copyDir, and a later repack starts again from this one.
    const liftedDir = path.join(ctx.dir, ASIS_DIR, 'lifted');
    await rm(liftedDir, { recursive: true, force: true });
    await cp(copyDir, liftedDir, { recursive: true });
    report.excludedByRule = excludedHosts;
    report.lift = lifted;
    // The addresses the copy answers from the original (mapped, the same as the original, two sizes of one path): see complete.js.
    report.sameOrigin = lifted?.completion?.sameOrigin ?? null;
    // Files the original serves in pieces (?range=): held whole and sliced by the copy (ranged.js).
    report.ranged = lifted?.completion?.ranged ?? null;

    // A preload of a file the copy does not hold is removed before packaging, so every stack inherits it (see preloads.js).
    report.preloadsRemoved = await dropMissingPreloads(copyDir);
    // A link to a page of the site that was not copied opens a local notice page that says so, never the live original or a
    // 404 of the copy (copy/noticePages.js: files only). Before the link pass, so it has those links no more to check.
    report.notices = await addNoticePages({
      dir: copyDir,
      pages,
      notCaptured: lifted?.notCaptured ?? [],
      siteUrl,
      brokenOnOriginal: ctx.audit && !ctx.audit.isDummy ? (ctx.audit.brokenLinks?.broken ?? []).map((b) => b.url) : [],
      siteName: new URL(siteUrl).hostname.replace(/^www\./, ''),
    }).catch((err) => ({ error: String(err?.message ?? err).slice(0, 200), pages: [], links: 0, files: 0, left: [] }));
    // Copy my site: every link of the copy is re-checked in a real browser and the safe fixes are written into the copy
    // before it is packaged (copy/linkPass.js). The copy is otherwise left exactly as it was lifted.
    ctx.progress(0.3, 'Checking the links');
    const linkChecker = await openLinkChecker().catch((err) => ({ error: String(err.message ?? err).slice(0, 200) }));
    try {
      report.links = linkChecker.check
        ? await linkPass({ dir: copyDir, originalUrl: siteUrl, pages: pages.map((p) => ({ path: localOfOutPath(p.outPath) })), checker: linkChecker })
        : { error: linkChecker.error, links: [], changed: 0, files: 0, skippedForTime: 0 };
    } finally {
      await linkChecker.close?.();
    }
    // Copy my site §2: the fixes that change neither the look nor the behaviour, each page proven unchanged by them.
    ctx.progress(0.33, 'Fixing what can be fixed without changing the look');
    // The new address is written only when usable and confirmed for this copy (copy/address.js); else none is, and that is open.
    const address = addressForCopy({ saved: newSiteOf(ctx.baseUrl, siteUrl), confirmed: ctx.asIs?.address ?? null, siteUrl });
    report.address = address.origin ? { used: address.origin } : { used: null, ...address.skipped };
    // The check's own lines (every look's measurements) are the server's log; the app is told in words which page is being
    // checked, and how far it is (they used to be shown as they are, raw measurements and all).
    const fixedSeen = new Set();
    const fixLine = (m) => {
      const page = m.match(/^(?:fixes|speed plan) (\S+?):?(?:\s|$)/)?.[1] ?? m.match(/^stylesheets .*? on (\S+?):/)?.[1];
      if (!page) return 'Fixing what can be fixed without changing the look';
      if (m.startsWith('stylesheets')) return `Checking that the smaller stylesheets leave ${page} looking the same`;
      if (m.startsWith('speed plan')) return `Measuring ${page} for faster images`;
      fixedSeen.add(page);
      return `Checking that the fixes leave ${page} looking the same (page ${fixedSeen.size} of ${pages.length})`;
    };
    report.fixes = await fixAndProve({
      browser, copyDir, gateDir: path.join(ctx.dir, ASIS_DIR, 'unfixed'), pages, siteUrl,
      newSiteUrl: address.origin, addressSkipped: address.skipped, fetchLlms: fetchLlmsTxt,
      log: (m) => {
        console.log(`[recreate ${String(ctx.recreateId ?? '').slice(0, 8)}] ${m}`);
        ctx.progress(0.34, fixLine(m));
      },
    });
    await packageCopy({ ctx, stack, copyDir, outDir, pages, siteUrl, report });
    const converted = report.convert?.mode === 'converted';
    // A converted copy run by its own server (MERN) is served by that server; a static export is static files.
    const ownServer = converted && CONVERTERS[stack].runs === 'server';
    report.forms = await formsInCopy(copyDir, pages.map((p) => p.outPath));
    // Where each form's data goes in the downloaded copy (copy/formRoutes.js, the form guard's rules); a converted copy's own
    // list (MERN: the forms its server stores) says it for that stack.
    report.formRoutes = converted && report.convert.forms ? report.convert.forms : await formRoutesOfCopy(copyDir, pages);
    // A form of another service, or a mail form, goes where the original sent it; one that went to the original's own server
    // needs a person (FORM_ENDPOINT), except in a converted MERN copy, whose server stores it unless it is one it must not.
    const waiting = report.formRoutes.filter((f) => f.goesTo === 'not-connected' || f.goesTo === 'not-stored').length;
    report.needsAPerson = waiting ? [{
      kind: 'form', count: waiting,
      why: ownServer ? 'it went to the original\'s own server and is one the copy\'s server does not store (a sign-in, an upload, a search, a script\'s own address); the forms list says which' : 'it went to the original\'s own server and is never sent there from the copy; connect FORM_ENDPOINT in sas-forms.json',
    }] : [];
    report.javascript = await javascriptOf(copyDir);

    ctx.progress(0.55, 'Running the copy and checking it');
    let base;
    if (stack === 'html') {
      const served = await serveCopy(copyDir);
      servers.push(served);
      base = served.url.replace(/\/$/, '');
    } else if (ownServer) {
      // The project's own server (MERN: Express serving client/dist and the forms). Submissions are kept in memory while it is
      // checked, so the form check sees what a visitor sees once MongoDB is set.
      const s = await startStack(stack, outDir, { env: { FORMS_STORE: 'memory', MONGODB_URI: '' } });
      servers.push(s);
      base = s.url;
    } else if (converted) {
      // A static export: served as the static files it is (what any static host does); there is no server of the stack to run.
      const served = await serveCopy(path.join(outDir, CONVERTERS[stack].exportDir));
      servers.push(served);
      base = served.url.replace(/\/$/, '');
    } else {
      const s = await startStack(stack, outDir);
      servers.push(s);
      base = s.url;
    }
    // What the packaged copy really serves: a fix counts only where it takes effect (copy/served.js).
    if (report.fixes) {
      const fixedPages = report.fixes.pages.filter((p) => !p.reverted && p.fixes.length)
        .map((p) => ({ path: p.path, outPath: pages.find((q) => localOfOutPath(q.outPath) === p.path)?.outPath ?? 'index.html', kinds: [...new Set(p.fixes.map((f) => f.kind))] }));
      // A converted static export: its security headers are the host's, as for plain HTML; a converted MERN copy's server sends them.
      report.fixes.served = await measureServed({ base, stack, copyDir, fixedPages, files: report.fixes.files?.written ?? [], ...(converted && !ownServer && { takeEffect: 'host' }) })
        .catch((err) => ({ error: String(err?.message ?? err).slice(0, 160) }));
    }
    // The original is asked once: when it does not answer, the checks that need it say so and the copy is still finished.
    // The baseline is the capture's own picture of each page (kept with the lift), so the visual check does not need the site.
    const originalReachable = await probeOriginal(siteUrl);
    // Per page: the capture's picture (`<slug>.webp`) and the original's own pictures from an earlier check (`<slug>@<width>.png`,
    // written below whenever the original is compared live), which the check prefers: the capture's picture is taken without
    // the scroll-through, so a page whose sections appear on scroll has them blank in it (makememo: 4.7 % off an identical copy).
    const baselineDir = path.join(ctx.dir, ASIS_DIR, 'baseline');
    const baselines = {};
    const slugOfPath = {};
    for (const p of pages) {
      const slug = slugFor(p.outPath);
      const one = {};
      const capture = await readFile(path.join(baselineDir, `${slug}.webp`)).catch(() => null);
      if (capture) one.capture = capture;
      for (const width of [1440, 390]) {
        // The original's own pictures of an earlier live check: `<slug>@<width>.png`, then `-2`, `-3` (one per round, so the
        // baseline check maps the original's noise too; an older job kept one).
        const pngs = [];
        for (let i = 1; i <= NOISE_SHOTS; i++) {
          const png = await readFile(path.join(baselineDir, `${slug}@${width}${i > 1 ? `-${i}` : ''}.png`)).catch(() => null);
          if (png) pngs.push(png);
        }
        if (pngs.length) one[width] = pngs;
      }
      slugOfPath[localOfOutPath(p.outPath)] = slug;
      if (Object.keys(one).length) baselines[localOfOutPath(p.outPath)] = one;
    }
    report.baseline = {
      pages: Object.keys(baselines).length,
      of: pages.length,
      originalPictures: Object.values(baselines).filter((b) => b[1440] || b[390]).length,
    };
    const keepOriginalPicture = async (pagePath, width, pngs) => {
      await mkdir(baselineDir, { recursive: true });
      for (const [i, png] of [pngs].flat().entries()) {
        await writeFile(path.join(baselineDir, `${slugOfPath[pagePath]}@${width}${i ? `-${i + 1}` : ''}.png`), png).catch(() => {});
      }
    };
    // The Plain HTML base: the same copy as plain files. It is the comparison when the original cannot be compared and no saved
    // picture exists (docs/COPY-MY-SITE.md §4); the plain HTML stack needs none, it is the base.
    let htmlBase = null;
    if (stack !== 'html') {
      const plain = await serveCopy(copyDir);
      servers.push(plain);
      htmlBase = plain.url.replace(/\/$/, '');
    }
    const checks = await checkCopy({
      browser, base, excludedHosts, originalReachable, baselines, htmlBase, onOriginalPicture: keepOriginalPicture,
      pages: pages.map((p) => ({ path: localOfOutPath(p.outPath), url: p.url })),
      log: (m) => ctx.progress(0.55, m),
    });
    report.checks = checks;
    // Outside services that serve their part only to the original's domain (domainLock.js): kept in the copy, refused there.
    for (const p of checks.pages) {
      p.domainLocked = await domainLockedParts(browser, base, p.path, p.original).catch((err) => {
        ctx.progress(0.56, `outside services ${p.path}: ${String(err?.message ?? err).slice(0, 160)}`);
        return [];
      });
    }
    if (!originalReachable) ctx.report.warnings.push('The original did not answer: the checks that compare with it say so; the copy and its download are complete.');
    const external = checks.pages.reduce((n, p) => n + p.offline.external.length, 0);
    report.safety = { safe: external === 0, mode: 'as-is', note: 'The original\'s own code is kept as it is; the check is that nothing leaves the copy.' };

    ctx.progress(0.9, 'Measuring with Lighthouse (desktop)');
    const lhFile = path.join(ctx.dir, ASIS_DIR, 'lighthouse-desktop.json');
    await mkdir(path.dirname(lhFile), { recursive: true });
    try {
      const summary = await runLighthouse(`${base}/`, 'desktop', { timeout: 240000, outFile: lhFile, signal: ctx.signal });
      const j = JSON.parse(await readFile(lhFile, 'utf8'));
      report.lighthouse = { after: scoresOf(j), ...(summary?.contention && { contention: summary.contention }) };
    } catch (err) {
      report.lighthouse = { error: String(err.message ?? err).slice(0, 200) };
    }
    // "Before" is the original's own Lighthouse result from the project's Check (never a stand-in): null until a Check ran.
    const checked = ctx.audit && !ctx.audit.isDummy ? ctx.audit.scores?.desktop ?? null : null;
    report.lighthouse = { ...report.lighthouse, before: checked };

    // Copy my site: the per-page checks, the open items and the server log (docs/COPY-MY-SITE.md §1, §5, §1h).
    const copyPages = copyChecksOf(checks.pages, { copy: report.lighthouse?.after ?? null, original: null });
    const openItems = copyPages.flatMap((p) => p.problems.map((pr) => ({
      page: p.path,
      check: pr.width ? `${pr.check} ${pr.width}px` : pr.check,
      values: `${typeof pr.value === 'number' ? Math.round(pr.value * 100) / 100 : pr.value} (min ${typeof pr.min === 'number' ? Math.round(pr.min * 100) / 100 : pr.min})`,
      tried: 'checked after the copy was made; no fallback rebuild in this run',
      // A request the copy makes to another site (the original's own third-party script) is third-party code (reason a).
      reason: checks.pages.find((x) => x.path === p.path)?.offline?.external?.length ? 'third_party' : 'unresolved',
    })));
    // No usable, confirmed new address: nothing in the copy names one (copy/address.js); the owner decides (reason c).
    if (report.address && !report.address.used) {
      openItems.unshift({ page: '/', check: 'new-site address', values: report.address.detail, tried: 'canonical, link previews, robots.txt, sitemap.xml and structured data were left without an address', reason: 'owner' });
    }
    // With an address: the original's structured data that still names its own address, kept as written (addressOpenItems).
    openItems.push(...addressOpenItems(report.fixes?.open));
    openItems.push(...noticeOpenItems(report.notices));
    // What the packaged copy serves decides what counts: headers only where its own server sends them; files and fixed pages
    // that are not served are open, never fixed.
    const served = report.fixes?.served && !report.fixes.served.error ? servedOutcome(report.fixes.served) : null;
    if (served) openItems.push(...served.open.map((o) => ({ page: o.page ?? '/', ...o })));
    openItems.push(...lockedItems(checks.pages));
    const logOpen = issueLogger(LOGS_DIR);
    for (const o of openItems) await logOpen({ site: new URL(siteUrl).hostname, stack, ...o });
    // Every part the conversion kept as original HTML is recorded for the owner too (site, page, tag / attribute, reason).
    for (const f of report.convert?.fallbacks ?? []) {
      await logOpen({ site: new URL(siteUrl).hostname, stack, page: f.page, check: `kept as original HTML: <${f.tag}>${f.attribute ? ` ${f.attribute}` : ''} at ${f.where}`, values: f.reason, tried: 'kept as the original HTML inside its component; the page is unchanged', reason: 'converted' });
    }
    ctx.report.copy = {
      stack,
      pages: copyPages,
      links: linkCounts(report.links?.links ?? []),
      linkDecisions: report.links?.links ?? [],
      linkError: report.links?.error ?? null,
      openItems,
      counts: { pages: copyPages.length, asIs: copyPages.length, rebuilt: 0 },
      // The safe fixes kept (per kind), the pages whose fixes were reverted (reason d) and what was left for a person.
      fixes: report.fixes ? {
        counts: report.fixes.counts,
        total: report.fixes.total,
        reverted: report.fixes.pages.filter((p) => p.reverted).map((p) => ({ page: p.path, ...p.reverted })),
        // The groups of fixes dropped on pages that kept their other fixes (each with the width and what it changed).
        dropped: report.fixes.pages.filter((p) => !p.reverted && p.dropped?.length).flatMap((p) => p.dropped.map((d) => ({ page: p.path, ...d }))),
        open: report.fixes.open,
        // Site files the packaged copy really serves (measured); `_headers` is never one of them: it is a host setting.
        files: (report.fixes.files?.written ?? []).filter((f) => f !== '_headers' && (!served || report.fixes.served.files[f] === 200)),
        // Security headers counted as applied: sent by the copy's own server (Next.js, MERN); none for a static stack.
        headers: served ? { applied: served.applied, takeEffect: report.fixes.served.takeEffect } : null,
      } : null,
    };
    ctx.report.asIs = report;
    // dist: the folder of the project that answers `/` (after the build above), so the preview and the re-audit serve the copy,
    // not the project around it. The download still takes the whole project (`dir`).
    ctx.report.outputs[stack] = { status: 'ready', dir: path.join('stacks', stack), dist: servedDir(stack, outDir), mode: 'as-is', pages: pages.map((p) => ({ outPath: p.outPath, path: localOfOutPath(p.outPath) })) };
    ctx.report.safety = report.safety;
    if (!report.safety.safe) ctx.report.warnings.push(`The as-is copy asked for ${external} address(es) off its own server; see the checks.`);
    ctx.progress(1, 'The as-is copy is ready');
    return {};
  } finally {
    for (const s of servers) await (s.stop ? s.stop() : s.close?.()).catch(() => {});
    await browser.close().catch(() => {});
    // Next's build folder is only needed while the copy is built and checked (next start of a packed copy reads it): once the
    // servers are stopped it goes. What is kept, previewed and zipped is the source and out/ (public/ for a packed copy);
    // `npm run dev` and `npm run build` write their own .next, and "Package again" converts and builds from the kept as-is copy.
    if (stack === 'nextjs') await dropBuildFolder(outDir).catch(() => {});
  }
}
