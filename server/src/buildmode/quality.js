// @ts-check
// How good a built site is, measured the way the Check measures any site, and held against the original's Check when there is
// one: the same pipeline (audit/index.js runAnalysis, the re-audit's way of measuring a local build), on the built site served
// from 127.0.0.1. Two weights, so a build stays quick:
//   fast   SEO, AI-answer, site-file, link and accessibility checks of every page: seconds; the agent's audit_site tool and the
//          gate before it may finish (agent.js createToolbox).
//   full   the same plus Lighthouse on the homepage, phone and computer: about a minute; once, at the end, for the run's report.
// What blocks a finish is what a person would call a problem: anything worse than the original, and every check that fails
// outright (a warning is reported, never blocking). Lighthouse speed scores are never a gate: they move from run to run.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAnalysis } from '../audit/index.js';
import { servePreview } from '../recreate/preview.js';
import { openMeasuredHost } from '../reaudit/measuredHost.js';
import { createNetPolicy, userPolicy } from '../security/netGuard.js';
import { listFiles } from './workspace.js';

const RANK = { pass: 0, warn: 1, fail: 2 };
const SERIOUS = new Set(['critical', 'serious']);
/** Points a Lighthouse category may drop before it counts as worse (run-to-run noise). */
export const SCORE_SLACK = 3;
const AREAS = { performance: 'Speed', seo: 'Found on Google', accessibility: 'Easy for everyone', bestPractices: 'Safe & modern' };

/** The built site's pages as addresses below its root: index.html first. */
export async function sitePages(/** @type {string} */ dir) {
  const pages = (await listFiles(dir)).filter((f) => /\.html?$/i.test(f) && !/^(404|_)/.test(path.basename(f)));
  return pages.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)))
    .map((f) => f.replace(/(^|\/)index\.html$/i, '$1'));
}

/**
 * Measures the built site in `dir` like the Check does.
 * @param {{ dir: string, lighthouse?: boolean, scripts?: any, signal?: AbortSignal, analyze?: typeof runAnalysis }} o
 * @returns {Promise<any>} the audit, in the Check's own shape (audit/assemble.js)
 */
export async function measureSite({ dir, lighthouse = false, scripts = true, signal, analyze = runAnalysis }) {
  const pages = await sitePages(dir);
  const served = await servePreview(dir, { connectSelf: true, compress: true, scripts });
  const measured = lighthouse ? { mobile: await openMeasuredHost(served.origin, 'mobile'), desktop: await openMeasuredHost(served.origin, 'desktop') } : null;
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'sas-build-audit-'));
  try {
    const netPolicy = createNetPolicy({ allowLoopback: userPolicy().allowLoopback, internalPorts: [served.port, ...(measured ? [measured.mobile.port, measured.desktop.port] : [])] });
    return await analyze({
      project: { id: 'build', url: `${served.origin}/`, name: 'build' },
      analysisId: 'build',
      url: `${served.origin}/`,
      maxPages: Math.max(1, pages.length),
      seedUrls: pages.map((p) => `${served.origin}/${p}`),
      outDir,
      skip: ['screenshots', ...(lighthouse ? [] : ['lighthouse-mobile', 'lighthouse-desktop'])],
      netPolicy,
      progress: () => {},
      linksBesideLighthouse: true,
      ...(measured && { lighthouseOrigin: (/** @type {'mobile' | 'desktop'} */ d) => measured[d].origin }),
      signal,
    });
  } finally {
    await served.close?.();
    if (measured) await Promise.all([measured.mobile.close(), measured.desktop.close()]).catch(() => {});
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Every check of an audit by a key that is the same on both sides: SEO and AI-answer items, site files, accessibility rules. */
function checksOf(/** @type {any} */ audit) {
  /** @type {Map<string, { area: string, title: string, status: string, detail: string, count?: number }>} */
  const out = new Map();
  if (!audit) return out;
  for (const [area, items] of [['Search', audit.seo], ['AI answers', audit.aeo]]) {
    for (const i of /** @type {any[]} */ (items ?? [])) {
      if (!i?.title) continue;
      out.set(`${area}:${i.key ?? i.title}`, { area: /** @type {string} */ (area), title: i.title, status: i.status, detail: i.detail ?? '' });
    }
  }
  for (const [k, v] of Object.entries(audit.crawl ?? {})) {
    const item = /** @type {any} */ (v);
    if (item?.status) out.set(`Site files:${k}`, { area: 'Site files', title: { sitemap: 'sitemap.xml', robots: 'robots.txt', metaTags: 'Meta tags' }[k] ?? k, status: item.status, detail: item.detail ?? '' });
  }
  for (const a of /** @type {any[]} */ (audit.accessibility ?? [])) {
    out.set(`Accessibility:${a.id ?? a.title}`, { area: 'Accessibility', title: a.title, status: SERIOUS.has(a.impact) ? 'fail' : 'warn', detail: `${a.count} element(s), ${a.impact}`, count: a.count });
  }
  const broken = audit.brokenLinks?.broken ?? [];
  if (broken.length) out.set('Links:broken', { area: 'Links', title: 'Broken links', status: 'fail', detail: broken.slice(0, 5).map((/** @type {any} */ b) => `${b.url} (${b.status ?? b.error ?? 'broken'})`).join(', '), count: broken.length });
  return out;
}

/**
 * The built site against the original: what got worse, what still fails, what was fixed, and the scores side by side.
 * Checks that only make sense on a live host (HTTPS, the server's headers) are judged by the original's own result.
 * @param {any} after  the built site's audit
 * @param {any} [before]  the original's Check (null for a new site)
 */
export function compareQuality(after, before = null) {
  const now = checksOf(after);
  const then = checksOf(before);
  /** @type {any[]} */ const worse = [];
  /** @type {any[]} */ const failing = [];
  /** @type {any[]} */ const fixed = [];
  /** @type {any[]} */ const open = [];
  for (const [key, c] of now) {
    // Only a host can serve HTTPS: a local build cannot pass it, and it is not the build's to fix.
    if (/https/i.test(c.title)) continue;
    const old = then.get(key);
    const r = RANK[/** @type {keyof typeof RANK} */ (c.status)] ?? 0;
    const o = old ? RANK[/** @type {keyof typeof RANK} */ (old.status)] ?? 0 : null;
    if (o != null && (r > o || (r === o && r > 0 && (c.count ?? 0) > (old?.count ?? 0)))) worse.push({ ...c, before: old?.detail ?? '' });
    else if (r === 2) failing.push(c);
    else if (r === 1) open.push(c);
  }
  for (const [key, c] of then) {
    if (/https/i.test(c.title) || (RANK[/** @type {keyof typeof RANK} */ (c.status)] ?? 0) === 0) continue;
    const n = now.get(key);
    if (!n || (RANK[/** @type {keyof typeof RANK} */ (n.status)] ?? 0) < (RANK[/** @type {keyof typeof RANK} */ (c.status)] ?? 0)) fixed.push({ ...c, now: n?.detail ?? 'passes' });
  }
  /** @type {any[]} */
  const scores = [];
  for (const device of ['mobile', 'desktop']) {
    for (const [cat, label] of Object.entries(AREAS)) {
      const a = after?.scores?.[device]?.[cat];
      const b = before?.scores?.[device]?.[cat];
      if (a == null) continue;
      scores.push({ device, area: label, before: b ?? null, after: a, worse: b != null && a < b - SCORE_SLACK });
    }
  }
  return { worse, failing, open, fixed, scores, ok: !worse.length && !failing.length };
}

/** The comparison as a run keeps it for the app: short lists, the scores side by side. compared: an original's Check existed. */
export function qualitySummary(/** @type {ReturnType<typeof compareQuality>} */ q, /** @type {boolean} */ compared) {
  const pick = (/** @type {any} */ c) => ({ area: c.area, title: c.title, detail: c.detail, ...(c.before && { before: c.before }), ...(c.now && { now: c.now }) });
  return {
    compared, ok: q.ok, scores: q.scores,
    worse: q.worse.map(pick), failing: q.failing.map(pick),
    open: q.open.length, openList: q.open.slice(0, 10).map(pick),
    fixed: q.fixed.length, fixedList: q.fixed.slice(0, 20).map(pick),
  };
}

/** The comparison as the agent reads it: what to fix before it may finish. */
export function qualityText(/** @type {ReturnType<typeof compareQuality>} */ q, { gate = false } = {}) {
  const row = (/** @type {any} */ c) => `- [${c.area}] ${c.title}: ${c.detail}${c.before ? ` (the original: ${c.before})` : ''}`;
  const lines = [];
  if (q.worse.length) lines.push('Worse than the original site:', ...q.worse.map(row));
  if (q.failing.length) lines.push('Failing checks:', ...q.failing.map(row));
  if (q.open.length) lines.push('Warnings (fix the ones you can):', ...q.open.slice(0, 15).map(row));
  if (q.fixed.length) lines.push(`Fixed compared with the original: ${q.fixed.length} check(s).`);
  const scores = q.scores.filter((s) => s.after != null);
  if (scores.length) lines.push(`Scores: ${scores.map((s) => `${s.device} ${s.area} ${s.before != null ? `${s.before} → ` : ''}${s.after}`).join('; ')}`);
  if (!lines.length) return 'The SEO, AI-answer, site-file, link and accessibility checks all pass.';
  return [gate && !q.ok ? 'The site cannot be finished yet: fix what is worse than the original and every failing check, then call finish again.' : 'Quality checks of the site, as the site audit measures them:', ...lines].join('\n');
}
