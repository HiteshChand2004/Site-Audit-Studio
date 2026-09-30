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
import { analyzeAeo } from '../../audit/analyzers/aeo.js';
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

/** audit id → { score (worst of mobile/desktop), title, detail, category } for failing-capable audits. */
function lighthouseAudits(lh) {
  const out = new Map();
  for (const lhr of [lh.mobile, lh.desktop]) {
    if (!lhr?.categories) continue;
    for (const category of LH_CATEGORIES) {
      for (const ref of lhr.categories[category]?.auditRefs ?? []) {
        if (ref.group === 'metrics' || ref.group === 'hidden') continue;
        const a = lhr.audits?.[ref.id];
        if (!a || !LH_MODES.has(a.scoreDisplayMode) || typeof a.score !== 'number') continue;
        const prev = out.get(ref.id);
        if (!prev || a.score < prev.score) {
          out.set(ref.id, { score: a.score, title: a.title, detail: a.displayValue || null, category, cpuTiming: isCpuTiming(a) });
        }
      }
    }
  }
  return out;
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
    });
  }
  return items;
}

// ---------- platform runtime ----------

function platformItems(oldStack = [], newStack = []) {
  const platforms = (stack) => stack.filter((t) => t.id && t.id !== 'custom');
  const newIds = new Set(platforms(newStack).map((t) => t.id));
  return platforms(oldStack).map((t) => ({
    key: `platform.${t.id}`,
    category: 'platform',
    title: `No ${t.name} runtime or CDN left`,
    before: { status: 'fail', detail: `${t.name} detected on the original site.`, rank: 1 },
    after: newIds.has(t.id)
      ? { status: 'fail', detail: `${t.name} is still detected on the recreated site.`, rank: 1 }
      : { status: 'pass', detail: `${t.name} is no longer detected.`, rank: 0 },
  }));
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
  if (item.status === 'manual') return item;
  if (item.status === 'recheck') return item;
  let status = DEPLOY_CHECKS.has(item.key) ? 'na' : classify(item.before, item.after);
  const out = { ...item, status };
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
 * @returns {object} the checklist
 */
export function compareAudits({ old, next, report, newOrigin }) {
  const reportPages = report.pages ?? [];
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
    ...lighthouseItems(old.lighthouse ?? {}, next.lighthouse ?? {}),
    ...analyzerItems(oldRows, newRows),
    ...axeItems(old.audit.accessibility, next.audit.accessibility),
    ...linkItems({ oldLinks: old.audit.brokenLinks, newLinks: next.audit.brokenLinks, oldScopeLinks, map }),
    ...platformItems(old.audit.techStack, next.audit.techStack),
    ...manualItems(old.audit.manualRebuild, report.manual),
  ];
  const items = raw
    .map((it) => finish(it, report))
    .sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category) || statusOrder(a.status) - statusOrder(b.status) || a.title.localeCompare(b.title));

  const summary = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const it of items) summary[it.status]++;
  summary.total = items.length;
  if (items.some((it) => it.category === 'performance')) notes.push(LOCAL_PERF_NOTE);

  return {
    version: CHECKLIST_VERSION,
    comparedAt: new Date().toISOString(),
    analysisId: old.audit.analysisId ?? null,
    recreateId: report.recreateId ?? null,
    scope,
    summary,
    scores: { before: old.audit.scores ?? null, after: next.audit.scores ?? null },
    metrics: { before: old.audit.metricsByDevice ?? null, after: next.audit.metricsByDevice ?? null },
    categories: CATEGORIES.filter((c) => items.some((it) => it.category === c.id)),
    items,
    notes,
  };
}
