// The fix checklist: the analysis a recreate was built from (OLD) compared check by check with the
// re-audit of the recreated site (NEW).
//   - Scope: only pages recreated and crawled on both sides are compared. OLD issues on pages that were
//     not recreated are out of scope, never "fixed".
//   - Both sides are re-scored with the same analyzers on those pages (their saved crawl facts), so a
//     count means the same thing on both sides. Homepage-only checks (axe, Lighthouse) compare as they are.
//   - Matching: SEO/AEO by check key, crawl files by name, axe by rule id + count, broken links by
//     normalized URL (NEW URLs mapped back to the original site), Lighthouse by audit id (performance and
//     best practices; its SEO and accessibility audits repeat our own checks), platforms by detection id.
//   - Manual rebuild items are listed as manual and never marked fixed.
// General by design: nothing here knows a site or a platform.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeAeo, NO_QUESTIONS } from '../../audit/analyzers/aeo.js';
import { analyzeCrawl } from '../../audit/analyzers/crawlChecks.js';
import { analyzeSeo, crawlErrorsItem } from '../../audit/analyzers/seo.js';
import { examples, itemKey, pathOf, plural } from '../../audit/util.js';
import {
  CATEGORIES, classify, DEPLOY_CHECKS, DEPLOY_NOTE, evidenceFor, isCpuTiming, LOCAL_PERF_NOTE, NETWORK_FAILURES, NOISY_NOTE, rankOfImpact,
  rankOfScore, rankOfStatus, RECHECK_NOTE, STATUSES,
} from './rules.js';
import { normUrl, pairPages, toOriginalUrl } from './scope.js';

export const CHECKLIST_VERSION = 1;

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);

/** One side of the comparison: the audit JSON plus the raw results in its folder. */
export async function loadSide(dir, audit) {
  const [crawl, mobile, desktop] = await Promise.all([
    readJson(path.join(dir, 'crawl.json')),
    readJson(path.join(dir, 'lighthouse-mobile.json')),
    readJson(path.join(dir, 'lighthouse-desktop.json')),
  ]);
  return { audit, crawl, lighthouse: { mobile, desktop } };
}

// ---------- analyzer checks (SEO, AEO, crawl files) ----------

const CRAWL_TITLES = { sitemap: 'sitemap.xml', robots: 'robots.txt', metaTags: 'Meta tags' };
const CRAWL_KEYS = { sitemap: 'crawl.sitemap', robots: 'crawl.robots', metaTags: 'crawl.meta-tags' };

/** key → { key, title, status, detail, count? } for the SEO, AEO and crawl rows of one side. */
function analyzerRows({ seo = [], aeo = [], crawl = {} }) {
  const rows = new Map();
  for (const [section, items] of [['seo', seo], ['aeo', aeo]]) {
    for (const it of items) {
      const key = it.key ?? itemKey(section, it.title); // stored audits from before the keys
      if (!rows.has(key)) rows.set(key, { ...it, key });
    }
  }
  for (const [name, it] of Object.entries(crawl)) {
    if (CRAWL_KEYS[name] && it) rows.set(CRAWL_KEYS[name], { ...it, key: CRAWL_KEYS[name], title: CRAWL_TITLES[name] });
  }
  return rows;
}

/** The analyzers run again on one side's pages of the compared scope. */
function rescore(side, pages) {
  const { crawl } = side;
  const home = pages[0];
  return analyzerRows({
    seo: [...analyzeSeo(pages, home), crawlErrorsItem(pages)],
    aeo: analyzeAeo({ pages, home, robots: crawl.robots ?? { blockedAiCrawlers: [] }, llms: crawl.llms ?? { found: false }, renderedTextLength: crawl.renderedTextLength ?? null }),
    crawl: analyzeCrawl({ robots: crawl.robots ?? {}, sitemap: crawl.sitemap ?? { status: 'missing', urls: [], sources: [] }, homeFacts: home.facts }),
  });
}

const view = (row) => row && { status: row.status, detail: row.detail, ...(row.count != null && { count: row.count }), rank: rankOfStatus(row.status) };

// A check with several kinds of problem (missing / duplicate / too long …) is compared part by part when
// both sides list its parts, so fixing one kind is not hidden behind another that was there all along.
function analyzerItems(oldRows, newRows) {
  const items = [];
  for (const key of new Set([...oldRows.keys(), ...newRows.keys()])) {
    const o = oldRows.get(key);
    const n = newRows.get(key);
    const title = (n ?? o).title;
    const category = key.split('.')[0];
    if (o?.parts && n?.parts) {
      for (const p of n.parts) {
        const op = o.parts.find((x) => x.id === p.id);
        items.push({ key: `${key}.${p.id}`, category, title: `${title}: ${p.label}`, before: view(op), after: view(p) });
      }
    } else if (key === 'aeo.structured-answers' && o?.detail === NO_QUESTIONS && n?.detail === NO_QUESTIONS) {
      // Neither site has a question on its pages: there is nothing to answer, and content is never invented.
      items.push({ key, category, title, before: view(o), after: view(n), preset: 'na', note: 'Neither site has question headings, so there is nothing to answer; content is never invented. Add an FAQ section to the site to use this.' });
    } else {
      items.push({ key, category, title, before: view(o), after: view(n) });
    }
  }
  return items;
}

// ---------- accessibility (axe, homepage) ----------

function axeItems(oldRows = [], newRows = []) {
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  const o = byId(oldRows);
  const n = byId(newRows);
  const side = (r) => (r ? { status: 'fail', detail: `${plural(r.count, 'element')} (${r.impact})`, count: r.count, impact: r.impact, rank: rankOfImpact(r.impact) } : { status: 'pass', detail: 'No violations', count: 0, rank: 0 });
  return [...new Set([...o.keys(), ...n.keys()])].map((id) => ({
    key: `axe.${id}`,
    category: 'accessibility',
    title: (n.get(id) ?? o.get(id)).title,
    helpUrl: (n.get(id) ?? o.get(id)).helpUrl ?? null,
    before: side(o.get(id)),
    after: side(n.get(id)),
  }));
}

// ---------- broken links ----------

function linkItems({ oldLinks, newLinks, oldScopeLinks, map }) {
  const oldBroken = new Map();
  for (const l of oldLinks?.broken ?? []) if (oldScopeLinks.has(normUrl(l.url))) oldBroken.set(normUrl(l.url), l);
  const newBroken = new Map();
  for (const l of newLinks?.broken ?? []) {
    const url = toOriginalUrl(l.url, map);
    newBroken.set(normUrl(url), { ...l, url });
  }
  const fixed = [...oldBroken].filter(([k]) => !newBroken.has(k)).map(([, l]) => l);
  const open = [...oldBroken].filter(([k]) => newBroken.has(k)).map(([, l]) => l);
  const newOnly = [...newBroken].filter(([k]) => !oldBroken.has(k)).map(([, l]) => l);
  // A new failure that is only a network error (refused, DNS, timeout) is not trusted as a regression.
  const recheck = newOnly.filter((l) => NETWORK_FAILURES.has(String(l.status).toUpperCase()));
  const added = newOnly.filter((l) => !recheck.includes(l));
  const list = (ls) => ls.map((l) => ({ url: l.url, status: l.status, foundOn: l.foundOn ?? null }));
  const side = (n, ls) => ({ status: n ? 'fail' : 'pass', detail: n ? `${plural(n, 'broken link')}: ${examples(ls.map((l) => l.url))}.` : 'No broken links.', count: n, rank: n ? 2 : 0 });
  const items = [{
    key: 'links.broken',
    category: 'links',
    title: 'Broken links',
    before: side(oldBroken.size, [...oldBroken.values()]),
    after: side(open.length, open),
    links: { fixed: list(fixed), open: list(open) },
  }];
  if (added.length) {
    items.push({
      key: 'links.broken-new',
      category: 'links',
      title: 'New broken links',
      before: side(0, []),
      after: side(added.length, added),
      links: { new: list(added) },
    });
  }
  if (recheck.length) {
    items.push({
      key: 'links.broken-recheck',
      category: 'links',
      title: 'Links to recheck',
      status: 'recheck',
      note: RECHECK_NOTE,
      before: { status: 'pass', detail: 'Not broken on the original analysis.', count: 0 },
      after: { status: 'warn', detail: `${plural(recheck.length, 'link')} could not be reached on this run: ${examples(recheck.map((l) => l.url))}.`, count: recheck.length },
      links: { recheck: list(recheck) },
    });
  }
  return items;
}

// ---------- Lighthouse (performance, best practices) ----------

const LH_CATEGORIES = ['performance', 'best-practices'];
const LH_MODES = new Set(['binary', 'numeric', 'metricSavings']);

// What an audit measured, lower = better: its value (elements, ms, bytes) or else the time it says could be saved.
const measured = (a) => {
  if (Number.isFinite(a.numericValue)) return { value: a.numericValue, unit: a.numericUnit ?? '' };
  const saved = Object.values(a.metricSavings ?? {}).filter(Number.isFinite);
  return saved.length ? { value: saved.reduce((x, y) => x + y, 0), unit: 'savings' } : null;
};

/** audit id → { score (worst of mobile/desktop), title, detail, category, values per device } for failing-capable audits. */
function lighthouseAudits(lh) {
  const out = new Map();
  for (const [device, lhr] of [['mobile', lh.mobile], ['desktop', lh.desktop]]) {
    if (!lhr?.categories) continue;
    for (const category of LH_CATEGORIES) {
      for (const ref of lhr.categories[category]?.auditRefs ?? []) {
        if (ref.group === 'metrics' || ref.group === 'hidden') continue;
        const a = lhr.audits?.[ref.id];
        if (!a || !LH_MODES.has(a.scoreDisplayMode) || typeof a.score !== 'number') continue;
        const prev = out.get(ref.id);
        const values = { ...prev?.values, ...(measured(a) && { [device]: measured(a) }) };
        if (!prev || a.score < prev.score) {
          out.set(ref.id, { score: a.score, title: a.title, detail: a.displayValue || null, category, cpuTiming: isCpuTiming(a), values });
        } else prev.values = values;
      }
    }
  }
  return out;
}

// A failing audit on both sides that still moved: lower on every device both measured by the margin or more = better,
// higher on one by the margin = worse. Times and bytes vary from run to run (10 %); an element count does not (2 %).
export function lighthouseTrend(before, after) {
  const ratios = [];
  let margin = 0.02;
  for (const d of ['mobile', 'desktop']) {
    const b = before?.values?.[d];
    const a = after?.values?.[d];
    if (!b || !a || b.unit !== a.unit || !(b.value > 0)) continue;
    ratios.push(a.value / b.value);
    if (b.unit !== 'element') margin = 0.1;
  }
  if (!ratios.length) return null;
  if (ratios.some((r) => r >= 1 + margin)) return 'worse';
  if (ratios.every((r) => r <= 1 - margin)) return 'better';
  return null;
}

function lighthouseItems(oldLh, newLh) {
  const o = lighthouseAudits(oldLh);
  const n = lighthouseAudits(newLh);
  if (!o.size && !n.size) return [];
  // Compared by score only: the number of rows in a Lighthouse table is not a count of problems.
  const side = (a) => a && { status: a.score >= 0.9 ? 'pass' : a.score >= 0.5 ? 'warn' : 'fail', detail: a.detail, score: a.score, rank: rankOfScore(a.score) };
  const items = [];
  for (const id of new Set([...o.keys(), ...n.keys()])) {
    const before = side(o.get(id));
    const after = side(n.get(id));
    if (!before?.rank && !after?.rank) continue; // passing on both sides: not worth a row
    const a = n.get(id) ?? o.get(id);
    items.push({
      key: `lighthouse.${id}`,
      category: a.category,
      title: a.title,
      before: o.size ? before ?? { status: 'pass', rank: 0 } : null,
      after: n.size ? after ?? { status: 'pass', rank: 0 } : null,
      ...((o.get(id)?.cpuTiming || n.get(id)?.cpuTiming) && { cpuTiming: true }),
      ...(lighthouseTrend(o.get(id), n.get(id)) && { trend: lighthouseTrend(o.get(id), n.get(id)) }),
    });
  }
  return items;
}

// ---------- platform runtime ----------

function platformItems(oldStack = [], newStack = [], output = null) {
  const platforms = (stack) => stack.filter((t) => t.id && t.id !== 'custom');
  const newIds = new Set(platforms(newStack).map((t) => t.id));
  const kept = new Set(output?.runtimes ?? []);
  return platforms(oldStack).map((t) => (kept.has(t.id) ? {
    // The output stack IS this framework: its runtime is expected, not a leftover of the original platform.
    key: `platform.${t.id}`,
    category: 'platform',
    title: `${t.name} runtime kept on purpose (${output.label} output)`,
    before: { status: 'warn', detail: `${t.name} detected on the original site.` },
    after: { status: 'pass', detail: `${output.label} ships ${t.name}'s runtime.` },
    preset: 'na',
    note: `The recreate was built as ${output.label}, so this framework's runtime is expected. Its cost is under "JavaScript shipped".`,
  } : {
    key: `platform.${t.id}`,
    category: 'platform',
    title: `No ${t.name} runtime or CDN left`,
    before: { status: 'fail', detail: `${t.name} detected on the original site.`, rank: 1 },
    after: newIds.has(t.id)
      ? { status: 'fail', detail: `${t.name} is still detected on the recreated site.`, rank: 1 }
      : { status: 'pass', detail: `${t.name} is no longer detected.`, rank: 0 },
  }));
}

// ---------- JavaScript shipped (the honest cost of a stack with a runtime) ----------

/** Script transfer size of a Lighthouse run's homepage (resource-summary), desktop first (the same on both sides when one of them was checked while only desktop was measured). */
function scriptBytes(lh) {
  for (const lhr of [lh?.desktop, lh?.mobile]) {
    const item = lhr?.audits?.['resource-summary']?.details?.items?.find((i) => i.resourceType === 'script');
    if (item && typeof item.transferSize === 'number') return item.transferSize;
  }
  return null;
}

const kb = (n) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/**
 * One row that always shows what JavaScript the recreate ships against the original. The original's figure is the
 * transfer size Lighthouse measured; the recreated figure is the gzipped size of the stack's own bundles (a local
 * preview does not compress, so its transfer size would overstate the cost) or, for a build without a bundle,
 * what Lighthouse measured (none). Never hidden as "passing": a framework runtime is a real cost.
 */
function scriptItem(oldLh, newLh, output) {
  const before = scriptBytes(oldLh);
  const bundled = output?.build?.js?.gzipBytes;
  const after = bundled ?? scriptBytes(newLh);
  if ((before == null && after == null) || (!before && !after)) return [];
  let preset = 'changed';
  if (before != null && after != null) preset = after === 0 ? 'fixed' : after < before * 0.9 ? 'improved' : after > before * 1.1 ? 'regressed' : 'changed';
  const label = output?.label ?? 'The recreate';
  // `changed` means "noisy locally" for CPU timings; here it means the two sizes are about the same (or the original's is unknown).
  const statusLabel = preset === 'changed' ? (before == null ? 'Not compared' : 'About the same') : undefined;
  return [{
    key: 'stack.javascript',
    category: 'performance',
    title: 'JavaScript shipped',
    before: before == null ? null : { status: before ? 'warn' : 'pass', detail: `${kb(before)} transferred (original analysis)`, bytes: before },
    after: after == null ? null : { status: after ? 'warn' : 'pass', detail: bundled != null ? `${kb(after)} gzipped (${label} build)` : `${kb(after)} transferred (local preview)`, bytes: after },
    preset,
    ...(statusLabel && { statusLabel }),
    note: bundled != null
      ? `${label} ships its framework runtime and hydrates every page. The plain-HTML build ships no JavaScript. The original's figure is the transfer size Lighthouse measured; this one is the gzipped size of the build's bundles.`
      : 'The recreated site ships no JavaScript.',
  }];
}

// ---------- manual rebuild ----------

function manualItems(oldManual = [], reportManual = []) {
  const items = new Map();
  for (const m of [...reportManual, ...oldManual]) {
    const key = itemKey('manual', m.title);
    if (!items.has(key)) items.set(key, { key, category: 'manual', title: m.title, detail: m.detail ?? null, kind: m.kind ?? null, status: 'manual', before: null, after: null });
  }
  return [...items.values()];
}

// ---------- assembly ----------

function finish(item, report) {
  if (item.preset) {
    // A status decided by the rule that built the row (target runtime, JavaScript shipped).
    const { preset, ...rest } = item;
    for (const s of ['before', 'after']) if (rest[s]) delete rest[s].rank;
    return { ...rest, status: preset };
  }
  if (item.status === 'manual') return item;
  if (item.status === 'recheck') return item;
  let status = DEPLOY_CHECKS.has(item.key) ? 'na' : classify(item.before, item.after);
  // Same severity on both sides, but the measured value moved clearly (fewer elements, fewer KiB to save, …).
  if (status === 'open' && item.trend) status = item.trend === 'better' ? 'improved' : 'regressed';
  const { trend, ...kept } = item;
  const out = { ...kept, status };
  if (DEPLOY_CHECKS.has(item.key)) out.note = DEPLOY_NOTE;
  else if (!item.after) out.note = 'Not measured on the recreated site.';
  else if (!item.before) out.note = 'Not measured on the original site.';
  if (item.category === 'performance' && status !== 'na') out.note = LOCAL_PERF_NOTE;
  if (item.cpuTiming && status === 'regressed') {
    status = 'changed';
    out.status = status;
    out.note = NOISY_NOTE;
  }
  const ev = evidenceFor(item.key, report);
  if (ev) {
    out.evidence = ev.evidence;
    if (ev.review && (status === 'fixed' || status === 'improved')) out.review = true;
  }
  for (const s of ['before', 'after']) if (out[s]) delete out[s].rank;
  return out;
}

const statusOrder = (s) => STATUSES.indexOf(s);
const categoryOrder = (c) => {
  const i = CATEGORIES.findIndex((x) => x.id === c);
  return i < 0 ? CATEGORIES.length : i;
};

/**
 * @param {object} o
 * @param {{ audit: object, crawl: object|null, lighthouse: object }} o.old   the analysis the recreate used
 * @param {{ audit: object, crawl: object|null, lighthouse: object }} o.next  the re-audit
 * @param {object} o.report     the recreate report (pages, fixes, autoGenerated, manual)
 * @param {string} o.newOrigin  the origin the re-audit served the build on
 * @param {{ stack: string, label: string, runtimes?: string[], pages?: { outPath: string, path: string }[], build?: object }} [o.output]
 *   the output that was audited (its stack, the framework runtimes it ships on purpose, where it put each page, its bundle sizes)
 * @returns {object} the checklist
 */
export function compareAudits({ old, next, report, newOrigin, output = null, motion = null }) {
  // Lighthouse audits are compared only on a device both sides were measured on (a check made while only desktop was measured
  // has no phone run): otherwise "worst of phone / computer" on one side meets "computer" on the other.
  const oldLh = { ...old.lighthouse };
  const newLh = { ...next.lighthouse };
  for (const device of ['mobile', 'desktop']) {
    if (!oldLh[device] || !newLh[device]) oldLh[device] = newLh[device] = null;
  }
  // Pages as the recreated output has them (Next.js moves some URLs); without an output, the original layout.
  const moved = new Map((output?.pages ?? []).map((p) => [p.outPath, p.path]));
  const reportPages = (report.pages ?? []).map((p) => (moved.has(p.outPath) ? { ...p, newPath: moved.get(p.outPath) } : p));
  const oldOrigin = new URL(old.audit.url).origin;
  const map = { newOrigin, oldOrigin, reportPages };
  const notes = [];

  // Scope: pages both crawls have. Without both crawls (or without the homepage) the stored results
  // are compared as they are, site against site.
  let scope = { mode: 'site', pages: [], outOfScope: [], missingInNew: [], missingInOld: [] };
  let oldRows;
  let newRows;
  let oldScopeLinks = null;
  if (old.crawl?.pages && next.crawl?.pages) {
    const paired = pairPages({ reportPages, oldPages: old.crawl.pages, newPages: next.crawl.pages, newOrigin });
    if (paired.pairs.length && paired.pairs[0].path === '/') {
      scope = {
        mode: 'pages',
        pages: paired.pairs.map((p) => ({ path: p.path, url: p.url })),
        outOfScope: paired.outOfScope.map(pathOf),
        missingInNew: paired.missingInNew,
        missingInOld: paired.missingInOld,
      };
      oldRows = rescore(old, paired.pairs.map((p) => p.old));
      newRows = rescore(next, paired.pairs.map((p) => p.new));
      oldScopeLinks = new Set(paired.pairs.flatMap((p) => (p.old.facts.links ?? []).map((l) => normUrl(l.href))));
    }
  }
  const storedOld = analyzerRows(old.audit);
  const storedNew = analyzerRows(next.audit);
  if (scope.mode === 'pages') {
    // Checks a re-score cannot repeat (inputs not saved by older analyses) keep their stored result.
    for (const [k, v] of storedOld) if (!oldRows.has(k) && storedNew.has(k)) oldRows.set(k, v);
    for (const [k, v] of storedNew) if (!newRows.has(k) && oldRows.has(k)) newRows.set(k, v);
  } else {
    oldRows = storedOld;
    newRows = storedNew;
    oldScopeLinks = new Set((old.audit.brokenLinks?.broken ?? []).map((l) => normUrl(l.url)));
    notes.push('The raw crawl of one side is missing, so whole-site results are compared; issues on pages that were not recreated may show as fixed.');
  }
  if (scope.outOfScope.length) {
    notes.push(`${plural(scope.outOfScope.length, 'page')} of the original analysis ${scope.outOfScope.length === 1 ? 'was' : 'were'} not recreated; ${scope.outOfScope.length === 1 ? 'its' : 'their'} issues are out of scope.`);
  }

  const raw = [
    ...lighthouseItems(oldLh, newLh),
    ...analyzerItems(oldRows, newRows),
    ...axeItems(old.audit.accessibility, next.audit.accessibility),
    ...linkItems({ oldLinks: old.audit.brokenLinks, newLinks: next.audit.brokenLinks, oldScopeLinks, map }),
    ...platformItems(old.audit.techStack, next.audit.techStack, output),
    ...scriptItem(old.lighthouse, next.lighthouse, output),
    ...(motion?.items ?? []),
    ...manualItems(old.audit.manualRebuild, report.manual),
  ];
  const items = raw
    .map((it) => finish(it, report))
    .sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category) || statusOrder(a.status) - statusOrder(b.status) || a.title.localeCompare(b.title));

  const summary = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const it of items) summary[it.status]++;
  summary.total = items.length;
  if (items.some((it) => it.category === 'performance')) notes.push(LOCAL_PERF_NOTE);
  if (motion?.failed?.length) notes.push(`Motion could not be measured on ${plural(motion.failed.length, 'recreated page')} (${motion.failed.slice(0, 3).map((f) => f.error).join('; ')}).`);
  if (motion?.skipped?.length) notes.push(`Motion was measured on ${plural(motion.summary?.pages ?? 0, 'page')} only; ${plural(motion.skipped.length, 'page')} skipped to stay within the time limit.`);

  return {
    version: CHECKLIST_VERSION,
    comparedAt: new Date().toISOString(),
    analysisId: old.audit.analysisId ?? null,
    recreateId: report.recreateId ?? null,
    scope,
    summary,
    stack: output ? { id: output.stack, label: output.label, jsBytes: { before: scriptBytes(old.lighthouse), after: output.build?.js?.gzipBytes ?? scriptBytes(next.lighthouse) } } : null,
    scores: { before: old.audit.scores ?? null, after: next.audit.scores ?? null },
    metrics: { before: old.audit.metricsByDevice ?? null, after: next.audit.metricsByDevice ?? null },
    // Motion (reaudit/motion.js): pages measured on both sides and the totals; null when it was not measured.
    motion: motion ? { ...(motion.summary ?? {}), failed: motion.failed ?? [], skipped: motion.skipped ?? [] } : null,
    categories: CATEGORIES.filter((c) => items.some((it) => it.category === c.id)),
    items,
    notes,
  };
}
