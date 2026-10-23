// Lighthouse on every page of an as-is copy, against the original's same page, in both modes (phone, computer), on this
// computer with the same settings on both sides (docs/COPY-MY-SITE.md §4: the copy must not score lower than the original in
// any category, on either device).
//
// The measuring rule, as the user set it:
//   - each page is run once per mode on both sides; the single run is accepted when the copy is ahead by at least LEAD points
//     in EVERY category;
//   - otherwise both sides are run EXTRA_RUNS more times and the medians of the three decide; a copy median lower than the
//     original's in any category is a "got worse" row (reaudit/compare: status regressed) for that page, mode and category;
//   - the original's runs are kept per project (`lighthouse-original/`) and reused by later re-audits: a page of the original
//     is measured once per mode (plus its extra runs, when a comparison needed them), never again;
//   - the pages that needed extra runs are reported.
// A run of the copy here is never the calibrated homepage run of the analysis (that one is scaled against an OLDER measurement
// of the original); both sides are measured now, so no scaling is needed between them.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LH_SCORE_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
export const MODES = ['mobile', 'desktop'];
/** Points the copy must be ahead in every category for one run per side to decide. */
export const LEAD = 5;
/** Runs added on each side when one run does not decide (medians of 1 + EXTRA_RUNS). */
export const EXTRA_RUNS = 2;
/** A copy run with fewer than this share of the original's DOM elements did not render the page. */
export const BLANK_SHARE = 0.2;
/** Time given to one Lighthouse run (the analysis gives 120 s; a page of the original is fetched over the network). */
export const RUN_TIMEOUT_MS = 150000;

const CATEGORY_LABEL = { performance: 'Performance', accessibility: 'Accessibility', 'best-practices': 'Best practices', seo: 'SEO' };
const MODE_LABEL = { mobile: 'phone', desktop: 'computer' };

/** A page's file-name stem: its path, made safe, plus a short hash of the address (two sites' pages never collide). */
export function pageSlug(pagePath, url) {
  const stem = (pagePath === '/' ? 'index' : pagePath.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()).slice(0, 60) || 'index';
  return `${stem}-${createHash('sha256').update(String(url)).digest('hex').slice(0, 8)}`;
}

/** The scores (0–100) of one Lighthouse report, per category; a category the report lacks is null. */
export function scoresOf(lhr) {
  const out = {};
  for (const c of LH_SCORE_CATEGORIES) {
    const s = lhr?.categories?.[c]?.score;
    out[c] = typeof s === 'number' ? Math.round(s * 100) : null;
  }
  return out;
}

/**
 * What a run of a page keeps (a full report is ~1 MB; a comparison needs the scores, the page's weight, its largest element and
 * the audits that fail, so a row can be explained): the shape both sides are stored and compared in.
 */
export function trimReport(lhr) {
  const audits = {};
  for (const [id, a] of Object.entries(lhr?.audits ?? {})) {
    if (typeof a?.score !== 'number' || a.score >= 0.9 || a.scoreDisplayMode === 'informative' || a.scoreDisplayMode === 'manual') continue;
    audits[id] = { score: a.score, title: a.title, displayValue: a.displayValue ?? null, numericValue: a.numericValue ?? null, numericUnit: a.numericUnit ?? null,
      ...(Number.isFinite(a.details?.overallSavingsBytes) && { savingsBytes: a.details.overallSavingsBytes }),
      urls: [...new Set((a.details?.items ?? []).map((i) => i.url ?? i.source?.url ?? i.sourceLocation?.url ?? i.entity ?? null).filter((u) => typeof u === 'string'))].slice(0, 20) };
  }
  const lcp = lhr?.audits?.['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node;
  // A category Lighthouse could not score (null): the audits of it that errored, with their message, so the comparison can say
  // why instead of leaving the run out (a copy that paints nothing during the load gets no performance score at all).
  const unscored = {};
  for (const c of LH_SCORE_CATEGORIES) {
    const cat = lhr?.categories?.[c];
    if (!cat || typeof cat.score === 'number') continue;
    unscored[c] = [...new Set((cat.auditRefs ?? []).map((r) => lhr.audits?.[r.id]).filter((a) => a?.scoreDisplayMode === 'error')
      .map((a) => `${a.id}: ${String(a.errorMessage ?? '').replace(/\s+/g, ' ').slice(0, 160)}`))].slice(0, 3);
  }
  return {
    fetchTime: lhr?.fetchTime ?? null,
    requestedUrl: lhr?.requestedUrl ?? null,
    finalUrl: lhr?.finalDisplayedUrl ?? lhr?.finalUrl ?? null,
    benchmarkIndex: lhr?.environment?.benchmarkIndex ?? null,
    scores: scoresOf(lhr),
    unscored,
    // How much of a page Lighthouse saw: a copy whose script failed renders a shell of a few elements, and every score of that
    // run (a perfect accessibility score on an empty page) is about nothing.
    domElements: lhr?.audits?.['dom-size']?.numericValue ?? null,
    weightBytes: lhr?.audits?.['total-byte-weight']?.numericValue ?? null,
    lcpElement: lcp ? { selector: lcp.selector ?? null, snippet: String(lcp.snippet ?? lcp.selector ?? '').slice(0, 100) } : null,
    audits,
  };
}

export const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Medians per category over several runs' scores. */
export function medianScores(runs) {
  const out = {};
  for (const c of LH_SCORE_CATEGORIES) out[c] = median(runs.map((r) => r.scores?.[c]));
  return out;
}

/** One run per side decides when the copy is ahead by LEAD or more in every category both sides measured. */
export function singleRunDecides(original, copy) {
  return LH_SCORE_CATEGORIES.every((c) => {
    const o = original.scores?.[c];
    const k = copy.scores?.[c];
    if (o == null || k == null) return false; // a category a run could not score decides nothing: the extra runs are taken
    return k - o >= LEAD;
  });
}

/**
 * The verdict for one page and mode from the runs of both sides: medians per category and the categories where the copy's
 * median is lower than the original's.
 */
export function decide(originalRuns, copyRuns) {
  const original = originalRuns.length === 1 ? { ...originalRuns[0].scores } : medianScores(originalRuns);
  const copy = copyRuns.length === 1 ? { ...copyRuns[0].scores } : medianScores(copyRuns);
  // A copy run that rendered a fraction of the original's elements did not show the page (its script failed, a blank shell
  // was measured): none of its scores is about the page, so the run counts as unscored in every category.
  const originalDom = median(originalRuns.map((r) => r.domElements));
  const blank = (r) => originalDom != null && r.domElements != null && originalDom >= 50 && r.domElements < originalDom * BLANK_SHARE;
  const blankRuns = copyRuns.filter(blank);
  // A category one run could not score on a side is not compared: a median over the runs that happened to score would pass
  // off one number as three. It is reported with the side, how many runs, and the reason.
  const unscored = {};
  for (const c of LH_SCORE_CATEGORIES) {
    for (const [side, runs] of [['original', originalRuns], ['copy', copyRuns]]) {
      const bad = runs.filter((r) => r.scores?.[c] == null || (side === 'copy' && blank(r)));
      if (!bad.length) continue;
      const errors = [...new Set(bad.flatMap((r) => [...(blank(r) ? [`the copy rendered ${Math.round(r.domElements)} elements against the original's ${Math.round(originalDom)}: the page did not show`] : []), ...(r.unscored?.[c] ?? [])]))].slice(0, 3);
      unscored[c] = { ...(unscored[c] ?? {}), [side]: { runs: bad.length, of: runs.length, errors } };
    }
    if (unscored[c]) { original[c] = null; copy[c] = null; }
  }
  const worse = LH_SCORE_CATEGORIES.filter((c) => !unscored[c] && copy[c] < original[c]);
  return { original, copy, worse, unscored, blankRuns: blankRuns.length, runs: { original: originalRuns.length, copy: copyRuns.length }, accepted: originalRuns.length === 1 && copyRuns.length === 1 ? 'single run' : 'median of runs' };
}

/** A run's file in the original's cache or the re-audit's folder. */
const runFile = (dir, slug, mode, n) => path.join(dir, `${slug}-${mode}-${n}.json`);

async function readJson(file) {
  return readFile(file, 'utf8').then(JSON.parse, () => null);
}

/**
 * The comparison on every page.
 * @param {object} o
 * @param {{ path: string, url: string, copyUrl: string }[]} o.pages  the copy's pages: path, the original's address, the copy's
 * @param {string} o.cacheDir   where the original's runs are kept per project (reused across re-audits)
 * @param {string} o.outDir     where the copy's runs are written (this re-audit's folder)
 * @param {(url: string, mode: 'mobile'|'desktop', outFile: string) => Promise<void>} o.run  one Lighthouse run, writing the full report to outFile
 * @param {(fraction: number, message?: string) => void} [o.progress]
 * @param {number} [o.deadline]  ms since epoch; pages not started by then are listed as skipped (what was measured is kept)
 * @returns {Promise<{ pages: object[], worse: object[], extraRunPages: object[], skipped: string[], errors: object[], runs: { original: number, copy: number, reusedOriginal: number } }>}
 */
export async function compareLighthousePages({ pages, cacheDir, outDir, run, progress = () => {}, deadline = Infinity }) {
  await mkdir(cacheDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  const result = { pages: [], worse: [], unscored: [], extraRunPages: [], skipped: [], errors: [], runs: { original: 0, copy: 0, reusedOriginal: 0 } };
  const total = pages.length * MODES.length;
  let done = 0;
  // One run of one side, as the trimmed report. The original's run n is taken from the cache when it is there.
  const measure = async (side, p, slug, mode, n) => {
    const dir = side === 'original' ? cacheDir : outDir;
    const file = runFile(dir, slug, mode, n);
    if (side === 'original') {
      const cached = await readJson(file);
      if (cached?.scores) {
        result.runs.reusedOriginal++;
        return cached;
      }
    }
    const raw = `${file}.full.json`;
    await run(side === 'original' ? p.url : p.copyUrl, mode, raw);
    const lhr = await readJson(raw);
    if (!lhr?.categories) throw new Error(`Lighthouse wrote no report for ${side} ${p.path} (${mode})`);
    const trimmed = trimReport(lhr);
    await writeFile(file, JSON.stringify(trimmed), 'utf8');
    result.runs[side]++;
    return trimmed;
  };
  for (const p of pages) {
    const slug = pageSlug(p.path, p.url);
    const entry = { path: p.path, url: p.url, slug, modes: {} };
    for (const mode of MODES) {
      if (Date.now() > deadline) {
        result.skipped.push(`${p.path} (${mode})`);
        continue;
      }
      progress(done / total, `Lighthouse (${MODE_LABEL[mode]}) on ${p.path}: original and copy`);
      try {
        const originalRuns = [await measure('original', p, slug, mode, 1)];
        const copyRuns = [await measure('copy', p, slug, mode, 1)];
        let extra = false;
        if (!singleRunDecides(originalRuns[0], copyRuns[0])) {
          extra = true;
          for (let n = 2; n <= 1 + EXTRA_RUNS; n++) {
            progress(done / total, `Lighthouse (${MODE_LABEL[mode]}) on ${p.path}: run ${n} of ${1 + EXTRA_RUNS} on both sides (one run did not decide)`);
            originalRuns.push(await measure('original', p, slug, mode, n));
            copyRuns.push(await measure('copy', p, slug, mode, n));
          }
        }
        const verdict = decide(originalRuns, copyRuns);
        entry.modes[mode] = {
          ...verdict, extra,
          runScores: { original: originalRuns.map((r) => r.scores), copy: copyRuns.map((r) => r.scores) },
          // For the reasons of a row that got worse: the page's weight, its largest element and what fails on each side (the medians' runs: the first).
          detail: {
            weight: { original: originalRuns[0].weightBytes, copy: copyRuns[0].weightBytes },
            lcp: { original: originalRuns[0].lcpElement, copy: copyRuns[0].lcpElement },
            failing: { original: Object.keys(originalRuns[0].audits), copy: Object.keys(copyRuns[0].audits) },
            copyAudits: copyRuns[0].audits,
          },
        };
        for (const c of verdict.worse) result.worse.push({ path: p.path, mode, category: c, original: verdict.original[c], copy: verdict.copy[c], runs: verdict.runs });
        for (const [c, sides] of Object.entries(verdict.unscored)) for (const [side, u] of Object.entries(sides)) result.unscored.push({ path: p.path, mode, category: c, side, ...u });
      } catch (err) {
        entry.modes[mode] = { error: String(err?.message ?? err).split('\n')[0].slice(0, 200) };
        result.errors.push({ path: p.path, mode, error: entry.modes[mode].error });
      }
      done++;
    }
    if (Object.values(entry.modes).some((m) => m.extra)) result.extraRunPages.push({ path: p.path, modes: MODES.filter((m) => entry.modes[m]?.extra) });
    result.pages.push(entry);
  }
  progress(1);
  return result;
}

/**
 * The checklist rows of the comparison: one "regressed" row per page, mode and category where the copy's median is lower than the
 * original's; one "pass" row per page and mode where it is not (so the comparison is on record, not only its failures).
 * The key names the page and mode, so every row is its own.
 */
export function lighthousePageItems(comparison) {
  const items = [];
  for (const p of comparison.pages) {
    for (const [mode, m] of Object.entries(p.modes)) {
      if (m.error) continue;
      const basis = `${m.accepted}${m.runs.original > 1 || m.runs.copy > 1 ? ` (${m.runs.original} of the original, ${m.runs.copy} of the copy)` : ''}`;
      const scored = LH_SCORE_CATEGORIES.filter((c) => !m.unscored?.[c]);
      const text = (scores) => scored.map((c) => `${CATEGORY_LABEL[c]} ${scores[c] ?? '–'}`).join(', ');
      // A category a run could not score is its own row, measured again rather than judged (status recheck).
      for (const [c, sides] of Object.entries(m.unscored ?? {})) {
        const why = Object.entries(sides).map(([side, u]) => `the ${side} in ${u.runs} of ${u.of} run${u.of === 1 ? '' : 's'}${u.errors.length ? ` (${u.errors.join('; ')})` : ''}`).join('; ');
        items.push({
          key: `lighthouse-score.${mode}.${c}.${p.path}`, category: c, page: p.path,
          title: `Lighthouse ${CATEGORY_LABEL[c]} score (${MODE_LABEL[mode]}) on ${p.path}: could not be scored`,
          status: 'recheck',
          before: { status: 'pass', detail: sides.original ? 'not scored' : `${m.runScores.original.map((s) => s[c] ?? '–').join(' / ')} on the original` },
          after: { status: 'fail', detail: `not comparable: Lighthouse gave no ${CATEGORY_LABEL[c]} score for ${why}` },
          note: 'Measured again, not judged: a run that could not score the page says nothing about it, and the runs that did are too few for a median of three.',
        });
      }
      if (!m.worse.length) {
        if (!scored.length) continue;
        items.push({
          key: `lighthouse-score.${mode}.all.${p.path}`, category: 'performance', page: p.path,
          title: `Lighthouse scores (${MODE_LABEL[mode]}) on ${p.path}: copy not below the original${scored.length < LH_SCORE_CATEGORIES.length ? ' in the categories scored' : ''}`,
          status: 'pass', before: { status: 'pass', detail: text(m.original) }, after: { status: 'pass', detail: `${text(m.copy)} — ${basis}` },
        });
        continue;
      }
      for (const c of m.worse) {
        items.push({
          key: `lighthouse-score.${mode}.${c}.${p.path}`, category: c, page: p.path,
          title: `Lighthouse ${CATEGORY_LABEL[c]} score (${MODE_LABEL[mode]}) on ${p.path}`,
          status: 'regressed',
          before: { status: 'pass', detail: `${m.original[c]} on the original`, score: m.original[c] },
          after: { status: 'fail', detail: `${m.copy[c]} on the copy — ${basis}`, score: m.copy[c] },
          lighthousePage: { mode, category: c, ...m.detail, runScores: m.runScores },
          note: 'Both sides measured on this computer with the same settings; a single run is accepted only when the copy is 5 or more points ahead in every category, else the medians of three runs per side decide.',
        });
      }
    }
  }
  return items;
}

/** The one line the notes carry. */
export function lighthousePagesNote(comparison) {
  const measured = comparison.pages.filter((p) => Object.values(p.modes).some((m) => !m.error)).length;
  const parts = [`Lighthouse was run on ${measured} page${measured === 1 ? '' : 's'} of the copy and of the original, phone and computer, on this computer with the same settings`];
  parts.push(comparison.extraRunPages.length
    ? `${comparison.extraRunPages.length} page${comparison.extraRunPages.length === 1 ? '' : 's'} needed three runs per side (${comparison.extraRunPages.map((p) => `${p.path} on ${p.modes.map((m) => MODE_LABEL[m]).join(' and ')}`).join('; ')})`
    : 'one run per side decided every page');
  if (comparison.runs.reusedOriginal) parts.push(`${comparison.runs.reusedOriginal} run${comparison.runs.reusedOriginal === 1 ? '' : 's'} of the original reused from an earlier comparison`);
  if (comparison.unscored?.length) parts.push(`${comparison.unscored.length} categor${comparison.unscored.length === 1 ? 'y' : 'ies'} could not be scored and ${comparison.unscored.length === 1 ? 'is' : 'are'} not compared (${[...new Set(comparison.unscored.map((u) => `${u.path} ${MODE_LABEL[u.mode]} ${CATEGORY_LABEL[u.category]}: the ${u.side} in ${u.runs} of ${u.of}`))].slice(0, 6).join('; ')})`);
  if (comparison.skipped.length) parts.push(`not measured for time: ${comparison.skipped.join(', ')}`);
  if (comparison.errors.length) parts.push(`${comparison.errors.length} run${comparison.errors.length === 1 ? '' : 's'} failed (${comparison.errors.slice(0, 3).map((e) => `${e.path} ${e.mode}: ${e.error}`).join('; ')})`);
  return `${parts.join('; ')}.`;
}
