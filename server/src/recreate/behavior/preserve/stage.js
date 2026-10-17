// The "Original as-is" stage of a Recreate job (mode "as-is"): after the capture of the selected pages (the job's inspect step,
// with the preserve fetch on), it lifts the pages, completes them, packages the chosen stack, builds and runs it, checks it
// (check.js) and measures it once with Lighthouse on desktop. The result is recorded in the job's report like any other copy,
// with `mode: 'as-is'`, so the download, the report and the app's stacks read it the same way.
import { cp, mkdir, rm, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { chromium } from 'playwright';
import { liftSite } from './asis.js';
import { packLifted } from './pack.js';
import { buildStack, startStack } from './serveStack.js';
import { checkCopy, excludedHostsOf, formsInCopy } from './check.js';
import { serveCopy } from './serve.js';
import { runLighthouse } from '../../../audit/lighthouse/run.js';
import { RecreateError } from '../../errors.js';

/** The stacks an as-is copy can be packaged into (the plain copy and the three app stacks). */
export const ASIS_STACKS = ['html', 'react-vite', 'nextjs', 'mern'];
const PORT = { 'react-vite': 4502, nextjs: 4503, mern: 4501 };

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

/** The as-is stage: lift, package, build, check, measure. Throws only when there is nothing to copy. */
export async function asIsStage(ctx) {
  const stack = ctx.asIs?.stack ?? 'html';
  if (!ASIS_STACKS.includes(stack)) throw new RecreateError(`The ${stack} stack has no as-is packaging.`);
  const pages = ctx.discovery?.pages ?? [];
  if (!pages.length) throw new RecreateError('No page was captured for the as-is copy.');
  const siteUrl = pages[0].url;
  const captureRoot = path.join(ctx.dir, 'capture');
  const copyDir = path.join(ctx.dir, 'as-is', 'copy');
  const outDir = path.join(ctx.dir, 'stacks', stack);
  const report = { stack, mode: 'as-is', pages: pages.map((p) => ({ url: p.url, path: p.outPath })), createdAt: new Date().toISOString() };
  const browser = await chromium.launch();
  const servers = [];
  try {
    ctx.progress(0.05, 'Excluding the parts that are not the site');
    const excludedHosts = await excludedHostsOf(captureRoot, siteUrl);
    report.excludedByRule = excludedHosts;

    ctx.progress(0.1, 'Lifting the pages');
    await rm(copyDir, { recursive: true, force: true });
    const lift = await liftSite({ captureRoot, pages, siteUrl, outDir: copyDir, browser, excludedHosts, log: (m) => ctx.progress(0.2, m) });
    report.lift = { files: lift.files.length, pages: lift.lifts, completion: lift.completion, hosts: lift.hosts.length };
    if (lift.lifts.some((l) => l.blockers?.length)) report.lift.blockers = lift.lifts.flatMap((l) => l.blockers.map((b) => ({ page: l.path, ...b })));

    ctx.progress(0.35, 'Packaging the copy');
    await rm(outDir, { recursive: true, force: true });
    if (stack === 'html') {
      await cp(copyDir, outDir, { recursive: true });
    } else {
      await packLifted({ stack, copyDir, outDir, pageUrl: siteUrl });
      ctx.progress(0.45, 'Building the stack');
      const built = await buildStack(stack, outDir);
      report.build = built?.steps?.map((s) => ({ label: s.label, ms: s.ms })) ?? null;
    }
    report.forms = await formsInCopy(copyDir, lift.entries);
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
    const checks = await checkCopy({
      browser, base, excludedHosts,
      pages: pages.map((p) => ({ path: localOf(p.outPath), url: p.url })),
      log: (m) => ctx.progress(0.55, m),
    });
    report.checks = checks;
    const external = checks.pages.reduce((n, p) => n + p.offline.external.length, 0);
    report.safety = { safe: external === 0, mode: 'as-is', note: 'The original\'s own code is kept as it is; the check is that nothing leaves the copy.' };

    ctx.progress(0.9, 'Measuring with Lighthouse (desktop)');
    const lhFile = path.join(ctx.dir, 'as-is', 'lighthouse-desktop.json');
    await mkdir(path.dirname(lhFile), { recursive: true });
    try {
      await runLighthouse(`${base}/`, 'desktop', { timeout: 240000, outFile: lhFile });
      const j = JSON.parse(await readFile(lhFile, 'utf8'));
      report.lighthouse = { after: scoresOf(j) };
    } catch (err) {
      report.lighthouse = { error: String(err.message ?? err).slice(0, 200) };
    }
    report.lighthouse = { ...report.lighthouse, before: ctx.audit?.scores?.desktop ?? null };

    ctx.report.asIs = report;
    ctx.report.outputs[stack] = { status: 'ready', dir: path.join('stacks', stack), mode: 'as-is', pages: pages.map((p) => ({ outPath: p.outPath, path: localOf(p.outPath) })) };
    ctx.report.safety = report.safety;
    if (!report.safety.safe) ctx.report.warnings.push(`The as-is copy asked for ${external} address(es) off its own server; see the checks.`);
    ctx.progress(1, 'The as-is copy is ready');
    return {};
  } finally {
    for (const s of servers) await (s.stop ? s.stop() : s.close?.()).catch(() => {});
    await browser.close().catch(() => {});
  }
}

const localOf = (outPath) => (outPath === 'index.html' ? '/' : outPath.endsWith('/index.html') ? `/${outPath.slice(0, -'index.html'.length)}` : `/${outPath}`);

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
