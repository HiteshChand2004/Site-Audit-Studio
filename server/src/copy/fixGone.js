// "Is the problem gone?" for the fixes of an as-is copy (Step 5b), from the markup alone: the same SEO, AEO and site-file
// analyzers the check runs (audit/analyzers), on the fixed page's HTML and on the page as lifted. No browser, no page load:
// only the two files of each page, read once. What a fix is for is the registry's (copy/fixRegistry.js: targets, the head's
// fields); only the checks whose key is read from the markup are judged by checkGone (goneBy 'markup'). axe rules are judged
// by judgeAxe below, from the look gate's own visit (Step 5c); Lighthouse audits only at re-check time.
//   A page's own checks are read with that page alone (it is its own "homepage"), so a check the real audit makes on the
//   homepage only (Open Graph, the meta tags, the language) still says whether this page had the problem. A duplicate is a
//   matter of the whole site: it is read on every page as shipped, with this page as fixed and as lifted.
// Per group of fixes (fixGroup), on positive evidence only:
//   gone      every check it targets that failed before passes now
//   improved  one of them is better (a lower count or a better status): kept
//   still     none of the checks it targets that failed before is any better: the fix had no effect
//   worse     a check of the page is worse than before (any check, not only the targets), and the page built again in memory
//             without this group is not: this group made it so. A check no single group explains undoes nothing ("not judged",
//             with the reason, under UNATTRIBUTED)
//   unjudged  none of its targets failed here, or none is read from the markup (axe, Lighthouse): nothing to say yet
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractPage } from '../audit/extract.js';
import { analyzeSeo } from '../audit/analyzers/seo.js';
import { analyzeAeo } from '../audit/analyzers/aeo.js';
import { analyzeCrawl } from '../audit/analyzers/crawlChecks.js';
import { FIELDS, FIXES, fixGroup, fixOf, goneBy } from './fixRegistry.js';

const RANK = { pass: 0, warn: 1, fail: 2 };
const STATUS = ['pass', 'warn', 'fail'];
// The meta tags the crawl check lists one by one (crawlChecks.js), by the head field that writes them.
const META_TAG = { 'theme-color': 'theme-color', icon: 'favicon' };

/**
 * Every markup check of a set of pages (the first is the homepage), as key → { rank, count }. The meta-tags row is also read
 * tag by tag (`crawl.meta-tags#theme-color`), because one fix writes one tag of it.
 */
export function readings(pages) {
  const home = pages[0];
  const out = new Map();
  const put = (key, status, count) => out.set(key, { rank: RANK[status] ?? 0, count: Number.isFinite(count) ? count : status === 'pass' ? 0 : 1 });
  for (const it of analyzeSeo(pages, home)) {
    put(it.key, it.status, it.count);
    for (const p of it.parts ?? []) put(`${it.key}.${p.id}`, p.status, p.count);
  }
  // robots.txt, llms.txt and the rendered text are the site's, not a page's: given as passing, so they never move here.
  for (const it of analyzeAeo({ pages, home, robots: { blockedAiCrawlers: [] }, llms: { found: true }, renderedTextLength: null })) put(it.key, it.status, it.count);
  const meta = analyzeCrawl({ robots: { status: 'found', sitemaps: ['-'] }, sitemap: { status: 'found', sources: [], urls: [] }, homeFacts: home.facts }).metaTags;
  put('crawl.meta-tags', meta.status, meta.count);
  for (const m of meta.detail.matchAll(/([\w:-]+) (✓|✗)/g)) put(`crawl.meta-tags#${m[1]}`, m[2] === '✓' ? 'pass' : 'warn', m[2] === '✓' ? 0 : 1);
  return out;
}

/** The markup checks a fix is meant to make pass (its kind's targets, or its head field's; a meta tag by its own name). */
export function markupTargets(fix) {
  let keys;
  if (fix.kind === 'head' || fix.kind === 'address') {
    const name = Object.keys(FIELDS).find((n) => FIELDS[n].match(fix.field));
    if (!name) return [];
    keys = META_TAG[fix.field] ? [`crawl.meta-tags#${META_TAG[fix.field]}`] : FIELDS[name].keys;
  } else keys = fixOf(fix.kind)?.targets ?? [];
  return keys.filter((k) => goneBy(k.split('#')[0]) === 'markup');
}

const isDuplicate = (key) => key.endsWith('.duplicate');
const better = (a, b) => a.rank < b.rank || (a.rank === b.rank && a.count < b.count);
const worse = (a, b) => better(b, a);
const said = (key, r) => `${key.split('#')[0]}${key.includes('#') ? ` (${key.split('#')[1]})` : ''} ${STATUS[r.rank]}${r.count ? `, ${r.count}` : ''}`;

/**
 * The verdict of each group of a page's fixes.
 * @param {object} o
 * @param {Map} o.before      readings of the page alone, as lifted
 * @param {Map} o.after       readings of the page alone, as fixed
 * @param {Map} o.siteBefore  readings of every page as shipped, with this page as lifted (duplicates)
 * @param {Map} o.siteAfter   readings of every page as shipped
 * @param {object[]} o.fixes  the page's kept fixes
 * @returns {Record<string, { result: string, keys: string[], why?: string }>}
 */
export function judgePage({ before, after, siteBefore, siteAfter, fixes }) {
  const pick = (key, side) => (isDuplicate(key) ? (side === 'before' ? siteBefore : siteAfter) : (side === 'before' ? before : after)).get(key);
  const groups = new Map();
  for (const f of fixes) {
    const g = fixGroup(f);
    groups.set(g, new Set([...(groups.get(g) ?? []), ...markupTargets(f)]));
  }
  const out = {};
  for (const [group, keySet] of groups) {
    const judged = [...keySet].filter((k) => {
      const b = pick(k, 'before');
      return b && pick(k, 'after') && (b.rank > 0 || b.count > 0);
    });
    if (!judged.length) {
      out[group] = { result: 'unjudged', keys: [] };
      continue;
    }
    const moved = judged.filter((k) => better(pick(k, 'after'), pick(k, 'before')));
    if (moved.length) {
      const allPass = judged.every((k) => pick(k, 'after').rank === 0 && pick(k, 'after').count === 0);
      out[group] = { result: allPass ? 'gone' : 'improved', keys: judged };
    } else {
      out[group] = { result: 'still', keys: judged, why: `the problem was still there after the fix: ${judged.slice(0, 3).map((k) => `${said(k, pick(k, 'before'))} → ${said(k, pick(k, 'after'))}`).join('; ')}` };
    }
  }
  return out;
}

/**
 * Every check of the page (any check, not only the fixes' targets) that is worse as fixed than as lifted: [{ key, from, to }].
 * Which group made it so is decided by checkGone, by building the page without each group.
 */
export function grownChecks({ before, after, siteBefore, siteAfter }) {
  const keysOf = (m, dup) => [...m.keys()].filter((k) => isDuplicate(k) === dup);
  return [...keysOf(before, false).filter((k) => after.has(k) && worse(after.get(k), before.get(k))).map((k) => ({ key: k, from: before.get(k), to: after.get(k) })),
    ...keysOf(siteBefore, true).filter((k) => siteAfter.has(k) && worse(siteAfter.get(k), siteBefore.get(k))).map((k) => ({ key: k, from: siteBefore.get(k), to: siteAfter.get(k) }))];
}

/** The verdict of a page whose worse check no single group explains: nothing is undone. */
export const UNATTRIBUTED = '(page)';

// ---------- axe (Step 5c) ----------
// The axe rules a group answers are its kind's axe targets (the registry). They are read by the look gate in the visit it makes
// anyway (preserve/check.js fixGate axeRules), on the page as lifted and as fixed, at the gate's widths (375, 1440), and only on a
// page that has such a fix. Besides every fix's own rules, the ARIA rules an attribute can break are read too (AXE_WATCH), so a
// fix that creates a failure there is seen.
export const AXE_WATCH = ['aria-allowed-role', 'aria-allowed-attr', 'aria-valid-attr', 'aria-roles', 'aria-required-children', 'aria-required-parent', 'nested-interactive'];
const axeIds = (keys) => keys.filter((k) => k.startsWith('axe.')).map((k) => k.slice('axe.'.length));

/** The axe rules a fix is meant to make pass. */
export const axeTargets = (fix) => axeIds(fixOf(fix.kind)?.targets ?? []);

/** The rules the gate reads on a page: none when no fix of it answers an axe rule; else every fix kind's axe rules and AXE_WATCH. */
export function axeRulesFor(fixes) {
  if (!fixes.some((f) => axeTargets(f).length)) return [];
  return [...new Set([...FIXES.flatMap((f) => axeIds(f.targets)), ...AXE_WATCH])];
}

/**
 * The axe verdict of each group of a page's kept fixes, from the gate's views of the look that kept them.
 * Width rule: a rule counts only at a width where axe read both sides and the lifted page failed it; a group whose problem was
 * seen at none of them is "unjudged" (confirm at re-check), never undone. On positive evidence only, as for the markup:
 *   gone / improved  fewer elements fail its rules (none at all: gone);  still  none fewer anywhere it was seen.
 * A rule failing on more elements as fixed than as lifted (any rule read) is worse; it is charged to a group only when that is
 * certain: the page has one group, or a look at one group alone (the gate's own retries) shows that group makes it worse.
 * Otherwise nothing is undone and the page gets an UNATTRIBUTED "unjudged" verdict that says why.
 * @param {object} o
 * @param {object[]} o.fixes   the page's kept fixes
 * @param {object[]} o.views   the views of the look that kept them (each may hold axe { width, before, after } or { error })
 * @param {Map<string, object[]>} [o.alone]  group → the views of a look at that group alone
 * @returns {Record<string, object>}
 */
export function judgeAxe({ fixes, views, alone = new Map() }) {
  const groups = new Map();
  for (const f of fixes) groups.set(fixGroup(f), new Set([...(groups.get(fixGroup(f)) ?? []), ...axeTargets(f)]));
  const read = views.filter((v) => v.axe && !v.axe.error && v.axe.before && v.axe.after).map((v) => v.axe);
  const errors = views.filter((v) => v.axe?.error).map((v) => `${v.width} px: ${v.axe.error}`);
  const widths = read.map((a) => a.width);
  const out = {};
  for (const [group, rules] of groups) {
    if (!rules.size) continue;
    const seen = read.flatMap((a) => [...rules].filter((r) => a.before[r] > 0).map((r) => ({ r, w: a.width, b: a.before[r], a: a.after[r] ?? 0 })));
    if (!seen.length) {
      const where = errors.length ? `axe could not read the page (${errors.join('; ')})` : `axe did not see the problem at ${widths.length ? widths.map((w) => `${w}`).join(' or ') : 'any'} px in the gate's visit`;
      out[group] = { result: 'unjudged', keys: [], by: 'axe', why: `${where}: confirm at re-check` };
      continue;
    }
    const keys = [...new Set(seen.map((s) => `axe.${s.r}`))];
    if (seen.some((s) => s.a < s.b)) out[group] = { result: seen.every((s) => s.a === 0) ? 'gone' : 'improved', keys, by: 'axe' };
    else out[group] = { result: 'still', keys, by: 'axe', why: `the problem was still there after the fix: ${seen.slice(0, 3).map((s) => `axe ${s.r} at ${s.w} px ${s.b} → ${s.a}`).join('; ')}` };
  }
  // Worse: any rule read, at any width read.
  const unexplained = [];
  for (const a of read) {
    for (const r of Object.keys(a.after)) {
      if (!((a.after[r] ?? 0) > (a.before[r] ?? 0))) continue;
      const what = `axe ${r} at ${a.width} px ${a.before[r] ?? 0} → ${a.after[r]}`;
      let blamed = [];
      if (groups.size === 1) blamed = [...groups.keys()];
      else {
        for (const g of groups.keys()) {
          const v = alone.get(g)?.find((x) => x.width === a.width)?.axe;
          if (v && !v.error && (v.after?.[r] ?? 0) > (v.before?.[r] ?? 0)) blamed.push(g);
        }
      }
      if (!blamed.length) {
        unexplained.push(what);
        continue;
      }
      for (const g of blamed) {
        out[g] = out[g]?.result === 'worse'
          ? { ...out[g], keys: [...out[g].keys, `axe.${r}`], why: `${out[g].why}; ${what}` }
          : { result: 'worse', keys: [...(out[g]?.keys ?? []), `axe.${r}`], by: 'axe', why: `the fix made ${what}` };
      }
    }
  }
  if (unexplained.length) out[UNATTRIBUTED] = { result: 'unjudged', keys: [], by: 'axe', why: `an accessibility rule got worse after the fixes (${unexplained.join('; ')}) and no single group of fixes is shown to cause it: nothing was undone` };
  return out;
}

/**
 * One group's verdicts from the markup and from axe, as one: worse wins; then any check that got better (gone only when every
 * judged one is gone); then still; else unjudged (with the reasons given).
 */
export function mergeVerdicts(a, b) {
  if (!a) return b;
  if (!b) return a;
  const keys = [...new Set([...a.keys, ...b.keys])];
  const why = [a.why, b.why].filter(Boolean).join('; ') || undefined;
  if (a.result === 'worse' || b.result === 'worse') {
    const w = [a, b].filter((x) => x.result === 'worse');
    return { result: 'worse', keys, why: w.map((x) => x.why).join('; ') };
  }
  const judged = [a, b].filter((x) => x.result !== 'unjudged');
  if (judged.some((x) => x.result === 'gone' || x.result === 'improved')) return { result: judged.every((x) => x.result === 'gone') ? 'gone' : 'improved', keys };
  if (judged.some((x) => x.result === 'still')) return { result: 'still', keys, why: judged.filter((x) => x.result === 'still').map((x) => x.why).join('; ') };
  return { result: 'unjudged', keys, ...(why && { why }) };
}

/**
 * The verdicts of every fixed page: its file as lifted (`gateDir`) and as fixed (`copyDir`), each read once.
 * @param {object} o
 * @param {string} o.copyDir
 * @param {string} o.gateDir
 * @param {{ outPath: string, url: string }[]} o.pages  every page of the copy, homepage first
 * @param {{ outPath: string, fixes: object[], reverted?: object }[]} o.fixed  the stage's pages (only those with kept fixes are judged)
 * @param {((page: object, groups: string[]) => Promise<string|null>)|null} [o.rebuild]  the page's HTML with only these groups,
 *   made in memory (preserve/stage.js: fixAsIsCopy write: false); without it a worse check of a page with several groups is
 *   never attributed
 * @returns {Promise<Map<string, Record<string, object>>>}  outPath → group → verdict
 */
export async function checkGone({ copyDir, gateDir, pages, fixed, rebuild = null }) {
  const read = (dir, p) => readFile(path.join(dir, p.outPath), 'utf8').then((html) => ({ url: p.url, facts: extractPage(html, p.url) }), () => null);
  const lifted = new Map();
  const shipped = new Map();
  for (const p of pages) {
    const a = await read(gateDir, p);
    if (!a) continue;
    lifted.set(p.outPath, a);
    shipped.set(p.outPath, (await read(copyDir, p)) ?? a);
  }
  const order = pages.map((p) => p.outPath).filter((o) => shipped.has(o));
  const siteAfter = readings(order.map((o) => shipped.get(o)));
  const out = new Map();
  for (const p of fixed) {
    if (p.reverted || !p.fixes?.length || !lifted.has(p.outPath)) continue;
    const siteBefore = readings(order.map((o) => (o === p.outPath ? lifted : shipped).get(o)));
    const sides = { before: readings([lifted.get(p.outPath)]), after: readings([shipped.get(p.outPath)]), siteBefore, siteAfter };
    const v = judgePage({ ...sides, fixes: p.fixes });
    const grew = grownChecks(sides);
    if (grew.length) await attribute({ v, grew, p, url: lifted.get(p.outPath).url, sides, order, shipped, rebuild });
    out.set(p.outPath, v);
  }
  return out;
}

/**
 * Which group made a check worse: the page is built again without one group at a time (rebuild: outPath, groups → HTML, made in
 * memory from the lifted pages, nothing written), read with the same analyzers, and a group whose absence leaves that check no
 * longer worse is the one; it becomes "worse" (undone). A check no single group explains undoes nothing: the page gets a
 * "not judged" verdict that says so.
 */
async function attribute({ v, grew, p, url, sides, order, shipped, rebuild }) {
  const groups = [...new Set(p.fixes.map(fixGroup))];
  const without = new Map();
  const readWithout = async (g) => {
    if (!without.has(g)) {
      const html = rebuild ? await rebuild(p, groups.filter((x) => x !== g)).catch(() => null) : null;
      without.set(g, html == null ? null : { url, facts: extractPage(html, url) });
    }
    return without.get(g);
  };
  const unexplained = [];
  for (const { key, from, to } of grew) {
    const blamed = [];
    if (groups.length === 1) blamed.push(groups[0]);
    else {
      for (const g of groups) {
        const page = await readWithout(g);
        if (!page) continue;
        const r = (isDuplicate(key) ? readings(order.map((o) => (o === p.outPath ? page : shipped.get(o)))) : readings([page])).get(key);
        const base = isDuplicate(key) ? sides.siteBefore.get(key) : sides.before.get(key);
        if (r && base && !worse(r, base)) blamed.push(g);
      }
    }
    const why = `${said(key, from)} → ${said(key, to)}`;
    if (!blamed.length) {
      unexplained.push(why);
      continue;
    }
    for (const g of blamed) {
      v[g] = v[g]?.result === 'worse'
        ? { ...v[g], keys: [...v[g].keys, key], why: `${v[g].why}; ${why}` }
        : { result: 'worse', keys: [...(v[g]?.keys ?? []), key], why: `the fix made ${why}` };
    }
  }
  if (unexplained.length) {
    v[UNATTRIBUTED] = { result: 'unjudged', keys: [], why: `a check got worse after the fixes (${unexplained.join('; ')}) and no single group of fixes explains it${rebuild ? '' : ' (the page could not be built without each group)'}: nothing was undone` };
  }
}
