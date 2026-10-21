// The "Original as-is" stage of a Recreate job (mode "as-is"). It lifts the pages captured by the job's inspect step (or, for a
// repack, takes the lifted copy of an earlier as-is job: the lift is not repeated), keeps the copy with its page set in
// as-is/, packages the chosen stack, builds and runs it, checks it (check.js) and measures it once with Lighthouse on desktop.
// The result is recorded in the job's report with `mode: 'as-is'`, so the download, the report and the app's stacks read it
// the same way as a clean copy.
import { cp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { chromium } from 'playwright';
import { liftSite, localOfOutPath } from './asis.js';
import { packLifted } from './pack.js';
import { dropMissingPreloads } from './preloads.js';
import { buildStack, startStack } from './serveStack.js';
import { checkCopy, excludedHostsOf, fixGate, formsInCopy, probeOriginal } from './check.js';
import { fixAsIsCopy, revertPage } from '../../../copy/fixAsIs.js';
import { slugFor } from '../../discover.js';
import { serveCopy } from './serve.js';
import { runLighthouse } from '../../../audit/lighthouse/run.js';
import { RecreateError } from '../../errors.js';
import { openLinkChecker } from '../../../copy/linkBrowser.js';
import { linkCounts, linkPass } from '../../../copy/linkPass.js';
import { copyChecksOf } from '../../../copy/checks.js';
import { issueLogger } from '../../../copy/serverLog.js';
import { DATA_DIR } from '../../../db/index.js';

/** The stacks an as-is copy can be packaged into (the plain copy and the three app stacks). */
export const ASIS_STACKS = ['html', 'react-vite', 'nextjs', 'mern'];
const PORT = { 'react-vite': 4502, nextjs: 4503, mern: 4501 };
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
 * The safe fixes (copy/fixAsIs.js), then the proof: every page they changed is compared with itself before them (fixGate);
 * a page whose fixes are not invisible gets its lifted HTML back, and its fixes are listed as reverted (reason d).
 * A gate that cannot decide (an error) reverts too: a fix is kept only when it is shown to change nothing.
 */
export async function fixAndProve({ browser, copyDir, gateDir, pages, siteUrl, newSiteUrl, log = () => {} }) {
  await rm(gateDir, { recursive: true, force: true });
  await cp(copyDir, gateDir, { recursive: true });
  try {
    const fixed = await fixAsIsCopy({
      dir: copyDir, siteUrl, newSiteUrl,
      pages: pages.map((p) => ({ path: localOfOutPath(p.outPath), outPath: p.outPath, url: p.url })),
    });
    const changed = fixed.pages.filter((p) => p.fixes.length);
    const gate = [];
    if (changed.length) {
      const a = await serveCopy(copyDir);
      const b = await serveCopy(gateDir);
      try {
        for (const p of changed) {
          const g = await fixGate(browser, a.url.replace(/\/$/, ''), b.url.replace(/\/$/, ''), p.path)
            .catch((err) => ({ path: p.path, invisible: false, error: String(err?.message ?? err).split('\n')[0].slice(0, 160) }));
          gate.push(g);
          log(`fixes ${p.path} ${JSON.stringify(g)}`);
          if (!g.invisible) {
            await revertPage(copyDir, p.outPath, fixed.originals.get(p.outPath));
            p.reverted = { reason: 'd', why: g.error ? `the check could not prove them invisible: ${g.error}` : `they changed the page (${g.diffPct} % of pixels${g.newErrors?.length ? `, ${g.newErrors.length} new console error(s)` : ''})` };
          }
        }
      } finally {
        await a.close();
        await b.close();
      }
    }
    const counts = {};
    for (const p of fixed.pages) if (!p.reverted) for (const f of p.fixes) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    return {
      counts,
      total: Object.values(counts).reduce((s, n) => s + n, 0),
      pages: fixed.pages.map((p) => ({ path: p.path, fixes: p.fixes, ...(p.reverted && { reverted: p.reverted }) })),
      reverted: fixed.pages.filter((p) => p.reverted).length,
      open: fixed.open,
      files: fixed.files,
      gate,
    };
  } finally {
    await rm(gateDir, { recursive: true, force: true });
  }
}

/**
 * The as-is stage. `ctx.asIs`: { stack, pages?, fromDir? } — `fromDir` is the folder of an earlier as-is job whose copy is
 * reused (a repack): its page set and lift are taken from there, and nothing is captured or lifted again.
 */
export async function asIsStage(ctx) {
  const stack = ctx.asIs?.stack ?? 'html';
  if (!ASIS_STACKS.includes(stack)) throw new RecreateError(`The ${stack} stack has no as-is packaging.`);
  const fromDir = ctx.asIs?.fromDir ?? null;
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
      const lifted = path.join(fromDir, ASIS_DIR, 'lifted');
      const from = (await readdir(lifted).then((l) => l.length > 0, () => false)) ? lifted : path.join(fromDir, ASIS_DIR, 'copy');
      await cp(from, copyDir, { recursive: true });
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
      };
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

    // A preload of a file the copy does not hold is removed before packaging, so every stack inherits it (see preloads.js).
    report.preloadsRemoved = await dropMissingPreloads(copyDir);
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
    report.fixes = await fixAndProve({
      browser, copyDir, gateDir: path.join(ctx.dir, ASIS_DIR, 'unfixed'), pages, siteUrl,
      newSiteUrl: newSiteOf(ctx.baseUrl, siteUrl), log: (m) => ctx.progress(0.34, m),
    });
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
      ].join('\n'), 'utf8');
    } else {
      await packLifted({ stack, copyDir, outDir, pageUrl: siteUrl });
      ctx.progress(0.45, 'Building the stack');
      const built = await buildStack(stack, outDir);
      report.build = built?.steps?.map((s) => ({ label: s.label, ms: s.ms })) ?? null;
    }
    report.forms = await formsInCopy(copyDir, pages.map((p) => p.outPath));
    report.needsAPerson = report.forms ? [{ kind: 'form', count: report.forms, why: 'its data is never sent to the original site; connect FORM_ENDPOINT in sas-forms.json' }] : [];
    report.javascript = await javascriptOf(copyDir);

    ctx.progress(0.55, 'Running the copy and checking it');
    let base;
    if (stack === 'html') {
      const served = await serveCopy(copyDir);
      servers.push(served);
      base = served.url.replace(/\/$/, '');
    } else {
      const s = await startStack(stack, outDir, PORT[stack]);
      servers.push(s);
      base = s.url;
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
        const png = await readFile(path.join(baselineDir, `${slug}@${width}.png`)).catch(() => null);
        if (png) one[width] = png;
      }
      slugOfPath[localOfOutPath(p.outPath)] = slug;
      if (Object.keys(one).length) baselines[localOfOutPath(p.outPath)] = one;
    }
    report.baseline = {
      pages: Object.keys(baselines).length,
      of: pages.length,
      originalPictures: Object.values(baselines).filter((b) => b[1440] || b[390]).length,
    };
    const keepOriginalPicture = async (pagePath, width, png) => {
      await mkdir(baselineDir, { recursive: true });
      await writeFile(path.join(baselineDir, `${slugOfPath[pagePath]}@${width}.png`), png).catch(() => {});
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
    if (!originalReachable) ctx.report.warnings.push('The original did not answer: the checks that compare with it say so; the copy and its download are complete.');
    const external = checks.pages.reduce((n, p) => n + p.offline.external.length, 0);
    report.safety = { safe: external === 0, mode: 'as-is', note: 'The original\'s own code is kept as it is; the check is that nothing leaves the copy.' };

    ctx.progress(0.9, 'Measuring with Lighthouse (desktop)');
    const lhFile = path.join(ctx.dir, ASIS_DIR, 'lighthouse-desktop.json');
    await mkdir(path.dirname(lhFile), { recursive: true });
    try {
      await runLighthouse(`${base}/`, 'desktop', { timeout: 240000, outFile: lhFile });
      const j = JSON.parse(await readFile(lhFile, 'utf8'));
      report.lighthouse = { after: scoresOf(j) };
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
    const logOpen = issueLogger(DATA_DIR);
    for (const o of openItems) await logOpen({ site: new URL(siteUrl).hostname, stack, ...o });
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
        open: report.fixes.open,
        files: report.fixes.files?.written ?? [],
      } : null,
    };
    ctx.report.asIs = report;
    ctx.report.outputs[stack] = { status: 'ready', dir: path.join('stacks', stack), mode: 'as-is', pages: pages.map((p) => ({ outPath: p.outPath, path: localOfOutPath(p.outPath) })) };
    ctx.report.safety = report.safety;
    if (!report.safety.safe) ctx.report.warnings.push(`The as-is copy asked for ${external} address(es) off its own server; see the checks.`);
    ctx.progress(1, 'The as-is copy is ready');
    return {};
  } finally {
    for (const s of servers) await (s.stop ? s.stop() : s.close?.()).catch(() => {});
    await browser.close().catch(() => {});
  }
}
