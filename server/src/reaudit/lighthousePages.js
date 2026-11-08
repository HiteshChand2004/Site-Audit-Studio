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
/** A kept run of the original older than this is measured again (the site may have changed). */
export const ORIGINAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A kept run of the original is reused only when this computer's speed (benchmarkIndex) then and now differs by at most this share. */
export const BENCHMARK_TOLERANCE = 0.25;
/** The score a category is meant to reach (a goal, reported as reached or not; never a reason to change a score). */
export const TARGET_SCORE = 90;

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
      // details.items is a list for most audits; an insight with a checklist (document-latency-insight) keeps an object there.
      urls: [...new Set((Array.isArray(a.details?.items) ? a.details.items : []).map((i) => i.url ?? i.source?.url ?? i.sourceLocation?.url ?? i.entity ?? null).filter((u) => typeof u === 'string'))].slice(0, 20) };
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
  // Per category, the audits of it that fail (score < 0.9, not informative / manual), with their weight in the category: what a
  // category under TARGET_SCORE is made of.
  const failingByCategory = {};
  for (const c of LH_SCORE_CATEGORIES) {
    const refs = lhr?.categories?.[c]?.auditRefs ?? [];
    failingByCategory[c] = refs.filter((r) => {
      const a = lhr.audits?.[r.id];
      return typeof a?.score === 'number' && a.score < 0.9 && a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'manual';
    }).map((r) => ({ id: r.id, weight: r.weight ?? 0 }));
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
    failingByCategory,
  };
}

/**
 * Why a kept run of the original may not stand in for one measured now, against the copy's run it is compared with; null when it
 * may. Its age comes from when it was saved here (`measuredAt`), else Lighthouse's own `fetchTime`; an unknown age or an unknown
 * computer speed on either side is a reason too (nothing is assumed).
 */
export function staleOriginal(kept, copyRun, now = Date.now()) {
  const at = Number.isFinite(kept?.measuredAt) ? kept.measuredAt : Date.parse(kept?.fetchTime ?? '');
  if (!Number.isFinite(at)) return 'its age is not known';
  if (now - at > ORIGINAL_MAX_AGE_MS) return `it is ${Math.floor((now - at) / 86400000)} days old (more than ${ORIGINAL_MAX_AGE_MS / 86400000})`;
  const a = kept?.benchmarkIndex;
  const b = copyRun?.benchmarkIndex;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 'the computer speed of one of the runs is not known';
  const off = Math.abs(a - b) / Math.max(a, b);
  if (off > BENCHMARK_TOLERANCE) return `this computer measured ${Math.round(off * 100)} % ${b < a ? 'slower' : 'faster'} than when it was kept (benchmark ${Math.round(a)} then, ${Math.round(b)} now)`;
  return null;
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

/** How far one side's runs spread in a category (max − min of the runs that scored it). */
export function spreadOf(runs, c) {
  const v = runs.map((r) => r.scores?.[c]).filter((x) => typeof x === 'number');
  return v.length ? Math.max(...v) - Math.min(...v) : 0;
}

/** The two sides' runs overlap in a category: the copy's highest run is not under the original's lowest. */
export function runsOverlap(originalRuns, copyRuns, c) {
  const vals = (runs) => runs.map((r) => r.scores?.[c]).filter((x) => typeof x === 'number');
  const o = vals(originalRuns);
  const k = vals(copyRuns);
  return o.length > 0 && k.length > 0 && Math.max(...k) >= Math.min(...o);
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
  // Lower on the copy by no more than the runs themselves spread (the medians of three on each side, the gap within the larger
  // of the two sides' max − min) AND the two sides' runs overlap (the copy's best run reaches the original's worst): within run
  // noise, said so, not "got worse". Every copy run under every original run is worse, however much the runs spread. One run per
  // side has no spread, so it never is noise.
  const lower = LH_SCORE_CATEGORIES.filter((c) => !unscored[c] && copy[c] < original[c]);
  const enough = originalRuns.length >= 1 + EXTRA_RUNS && copyRuns.length >= 1 + EXTRA_RUNS;
  const noise = enough ? lower.filter((c) => original[c] - copy[c] <= Math.max(spreadOf(originalRuns, c), spreadOf(copyRuns, c))
    && runsOverlap(originalRuns, copyRuns, c)) : [];
  const worse = lower.filter((c) => !noise.includes(c));
  return { original, copy, worse, noise, unscored, blankRuns: blankRuns.length, runs: { original: originalRuns.length, copy: copyRuns.length }, accepted: originalRuns.length === 1 && copyRuns.length === 1 ? 'single run' : 'median of runs' };
}

/**
 * Two runs measured under different load: other jobs ran during one and not the same number during the other. Unknown on
 * either side (a run of the original cached before this was recorded) decides nothing.
 */
export function unevenLoad(a, b) {
  return a?.contention != null && b?.contention != null && a.contention.otherJobs !== b.contention.otherJobs;
}

/** The most other jobs any of these runs was measured beside; null when none of them recorded it. */
const mostOthers = (runs) => {
  const known = runs.map((r) => r.contention?.otherJobs).filter((n) => typeof n === 'number');
  return known.length ? Math.max(...known) : null;
};

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
export async function compareLighthousePages({ pages, cacheDir, outDir, run, progress = () => {}, deadline = Infinity, signal = null }) {
  await mkdir(cacheDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  const result = { pages: [], worse: [], unscored: [], extraRunPages: [], skipped: [], errors: [], refreshedOriginal: [], runs: { original: 0, copy: 0, reusedOriginal: 0 } };
  const total = pages.length * MODES.length;
  let done = 0;
  // One run of one side, as the trimmed report. The original's run n is taken from the cache only when it may stand in for a run
  // made now (staleOriginal, against `copyRun`: the copy's run it is compared with, measured just before); else it is measured
  // again and the kept file replaced, and the reason is listed.
  const measure = async (side, p, slug, mode, n, copyRun = null) => {
    const dir = side === 'original' ? cacheDir : outDir;
    const file = runFile(dir, slug, mode, n);
    if (side === 'original') {
      const cached = await readJson(file);
      if (cached?.scores) {
        const why = staleOriginal(cached, copyRun);
        if (!why) {
          result.runs.reusedOriginal++;
          return cached;
        }
        result.refreshedOriginal.push({ path: p.path, mode, run: n, reason: why });
      }
    }
    const raw = `${file}.full.json`;
    const summary = await run(side === 'original' ? p.url : p.copyUrl, mode, raw);
    const lhr = await readJson(raw);
    if (!lhr?.categories) throw new Error(`Lighthouse wrote no report for ${side} ${p.path} (${mode})`);
    const trimmed = trimReport(lhr);
    // Kept with the run (also in the original's cache): what else ran on this server when it was measured, and when.
    trimmed.contention = summary?.contention ?? null;
    trimmed.measuredAt = Date.now();
    await writeFile(file, JSON.stringify(trimmed), 'utf8');
    result.runs[side]++;
    return trimmed;
  };
  for (const p of pages) {
    const slug = pageSlug(p.path, p.url);
    const entry = { path: p.path, url: p.url, slug, modes: {} };
    for (const mode of MODES) {
      // Stopped from the app: no further runs (each would take the Lighthouse lane from another job).
      if (signal?.aborted) throw Object.assign(new Error('Stopped before it finished.'), { stopped: true });
      if (Date.now() > deadline) {
        result.skipped.push(`${p.path} (${mode})`);
        continue;
      }
      progress(done / total, `Lighthouse (${MODE_LABEL[mode]}) on ${p.path}: original and copy`);
      try {
        // The copy first: its run tells whether a kept run of the original was made on a computer as fast as now.
        const copyRuns = [await measure('copy', p, slug, mode, 1)];
        const originalRuns = [await measure('original', p, slug, mode, 1, copyRuns[0])];
        let extra = false;
        // A single pair decides only when both sides were measured under the same load; else the medians of three do.
        const uneven = unevenLoad(originalRuns[0], copyRuns[0]);
        if (uneven || !singleRunDecides(originalRuns[0], copyRuns[0])) {
          extra = true;
          for (let n = 2; n <= 1 + EXTRA_RUNS; n++) {
            progress(done / total, `Lighthouse (${MODE_LABEL[mode]}) on ${p.path}: run ${n} of ${1 + EXTRA_RUNS} on both sides (one run did not decide)`);
            copyRuns.push(await measure('copy', p, slug, mode, n));
            originalRuns.push(await measure('original', p, slug, mode, n, copyRuns[copyRuns.length - 1]));
          }
        }
        const verdict = decide(originalRuns, copyRuns);
        entry.modes[mode] = {
          ...verdict, extra, uneven,
          // The most other jobs any run of each side was measured beside (null: not recorded).
          contention: { original: mostOthers(originalRuns), copy: mostOthers(copyRuns) },
          runScores: { original: originalRuns.map((r) => r.scores), copy: copyRuns.map((r) => r.scores) },
          // For the reasons of a row that got worse: the page's weight, its largest element and what fails on each side (the medians' runs: the first).
          detail: {
            weight: { original: originalRuns[0].weightBytes, copy: copyRuns[0].weightBytes },
            lcp: { original: originalRuns[0].lcpElement, copy: copyRuns[0].lcpElement },
            failing: { original: Object.keys(originalRuns[0].audits), copy: Object.keys(copyRuns[0].audits) },
            copyAudits: copyRuns[0].audits,
            // Per category, what fails on the copy (its first run; null for a run kept before this was recorded).
            copyFailingByCategory: copyRuns[0].failingByCategory ?? null,
          },
        };
        for (const c of verdict.worse) result.worse.push({ path: p.path, mode, category: c, original: verdict.original[c], copy: verdict.copy[c], runs: verdict.runs });
        for (const [c, sides] of Object.entries(verdict.unscored)) for (const [side, u] of Object.entries(sides)) result.unscored.push({ path: p.path, mode, category: c, side, ...u });
      } catch (err) {
        if (err?.stopped) throw err;
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
      const others = Math.max(m.contention?.original ?? 0, m.contention?.copy ?? 0);
      const load = others ? `; measured while up to ${others} other job${others === 1 ? '' : 's'} ran on this server` : '';
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
      // Lower on the copy, but by less than the runs of one side differ among themselves: shown with every run, not counted as worse.
      for (const c of m.noise ?? []) {
        const runs = (side) => m.runScores[side].map((s) => s[c] ?? '–').join(' / ');
        items.push({
          key: `lighthouse-score.${mode}.${c}.${p.path}`, category: c, page: p.path,
          title: `Lighthouse ${CATEGORY_LABEL[c]} score (${MODE_LABEL[mode]}) on ${p.path}`,
          status: 'changed', statusLabel: 'Within run noise',
          before: { status: 'pass', detail: `${m.original[c]} on the original (runs ${runs('original')})`, score: m.original[c] },
          after: { status: 'warn', detail: `${m.copy[c]} on the copy (runs ${runs('copy')}) — ${basis}${load}`, score: m.copy[c] },
          note: 'The copy\'s median is lower, but by no more than the runs of one side differ among themselves (the larger of the two sides\' highest − lowest run), and the copy\'s best run reaches the original\'s worst: within the noise of measuring on this computer, so not counted as worse. Confirm after deploying.',
        });
      }
      if (!m.worse.length) {
        if (!scored.length || m.noise?.length) continue;
        items.push({
          key: `lighthouse-score.${mode}.all.${p.path}`, category: 'performance', page: p.path,
          title: `Lighthouse scores (${MODE_LABEL[mode]}) on ${p.path}: copy not below the original${scored.length < LH_SCORE_CATEGORIES.length ? ' in the categories scored' : ''}`,
          status: 'pass', before: { status: 'pass', detail: text(m.original) }, after: { status: 'pass', detail: `${text(m.copy)} — ${basis}${load}` },
        });
        continue;
      }
      for (const c of m.worse) {
        items.push({
          key: `lighthouse-score.${mode}.${c}.${p.path}`, category: c, page: p.path,
          title: `Lighthouse ${CATEGORY_LABEL[c]} score (${MODE_LABEL[mode]}) on ${p.path}`,
          status: 'regressed',
          before: { status: 'pass', detail: `${m.original[c]} on the original`, score: m.original[c] },
          after: { status: 'fail', detail: `${m.copy[c]} on the copy — ${basis}${load}`, score: m.copy[c] },
          lighthousePage: { mode, category: c, ...m.detail, runScores: m.runScores },
          note: 'Both sides measured on this computer with the same settings; a single run is accepted only when the copy is 5 or more points ahead in every category, else the medians of three runs per side decide.',
        });
      }
    }
  }
  return items;
}

// Why an audit still fails on an as-is copy. A reason that says the copy kept something of the original's is given only when the
// original's own run fails the same audit; one that fails on the copy alone is said to be so, with no reason claimed (the rows
// that got worse explain it, from the files they name). A load timing is described, not explained.
const SCRIPT_AUDITS = new Set(['unused-javascript', 'unminified-javascript', 'legacy-javascript', 'duplicated-javascript', 'bootup-time',
  'mainthread-work-breakdown', 'third-party-facades', 'third-party-summary', 'total-blocking-time', 'long-tasks', 'bf-cache', 'max-potential-fid']);
const TIMING_AUDITS = new Set(['first-contentful-paint', 'largest-contentful-paint', 'speed-index', 'interactive', 'cumulative-layout-shift']);
export const COPY_ONLY = 'fails on the copy only: not explained here (see the rows that got worse)';
export function whyStillFailing(id, originalFails) {
  if (TIMING_AUDITS.has(id)) return "a load timing: follows the page's own files and scripts";
  if (!originalFails) return COPY_ONLY;
  if (SCRIPT_AUDITS.has(id)) return "the original's own JavaScript: kept as it is, by choice";
  if (id === 'color-contrast') return "the original's colours: kept, by choice";
  if (id === 'render-blocking-resources') return "the original's scripts and stylesheets load where the original loads them: kept, by choice";
  return 'fails on the original too: not changed by the copy';
}

/**
 * Per page, mode and category: the original's and the copy's score (as the comparison decided them), whether the copy reached
 * TARGET_SCORE, and for a category under it the audits that fail on the copy with their weight and why. Scores are reported as
 * measured; a category that could not be scored says so.
 */
export function lighthouseTargets(comparison) {
  const rows = [];
  for (const p of comparison.pages) {
    for (const [mode, m] of Object.entries(p.modes)) {
      if (m.error) continue;
      for (const c of LH_SCORE_CATEGORIES) {
        const copy = m.copy?.[c] ?? null;
        const row = { path: p.path, mode, category: c, original: m.original?.[c] ?? null, copy, reached: copy == null ? null : copy >= TARGET_SCORE };
        if (copy == null) row.note = 'not scored';
        else if (copy < TARGET_SCORE) {
          const failing = m.detail?.copyFailingByCategory?.[c];
          // What fails on the original's run the comparison used first (trimReport keeps every audit under 0.9).
          const onOriginal = new Set(m.detail?.failing?.original ?? []);
          row.failing = failing == null ? null : failing.slice().sort((a, b) => b.weight - a.weight).slice(0, 12)
            .map((f) => ({ id: f.id, title: m.detail.copyAudits?.[f.id]?.title ?? f.id, weight: f.weight, why: whyStillFailing(f.id, onOriginal.has(f.id)) }));
          if (failing == null) row.note = 'the failing audits of this run were not recorded';
        }
        rows.push(row);
      }
    }
  }
  return rows;
}

/**
 * The "copy scores at least as well as the original" rule, one verdict per device and Lighthouse category over every page measured
 * (the comparison's own medians and noise, nothing measured again):
 *   pass      the copy's score is not lower than the original's on any page (`ahead`: pages where it is higher);
 *   noise     lower on some page, but only within run noise (decide: the gap within the runs' spread and the runs overlap);
 *   fail      lower on some page beyond the noise; `worst` names the page, both scores and the audits that cost points
 *             on the copy, each with why it still fails;
 *   unscored  no page could be scored in this category on this device.
 * `passed` = no category fails on either device. `line` is the sentence the results show.
 */
export function betterThanOriginal(comparison) {
  const byMode = {};
  let failed = 0;
  for (const mode of MODES) {
    const cats = {};
    for (const c of LH_SCORE_CATEGORIES) {
      const pages = [];
      for (const p of comparison.pages) {
        const m = p.modes?.[mode];
        if (!m || m.error) continue;
        const o = m.original?.[c];
        const k = m.copy?.[c];
        if (o == null || k == null) { pages.push({ path: p.path, status: 'unscored' }); continue; }
        const status = (m.worse ?? []).includes(c) ? 'fail' : (m.noise ?? []).includes(c) ? 'noise' : k > o ? 'ahead' : 'same';
        pages.push({ path: p.path, status, original: o, copy: k, m });
      }
      if (!pages.length) continue;
      const scored = pages.filter((x) => x.status !== 'unscored');
      const pick = (s) => scored.filter((x) => x.status === s);
      const lowest = (list) => list.slice().sort((a, b) => (a.copy - a.original) - (b.copy - b.original))[0];
      let v;
      if (!scored.length) v = { status: 'unscored', pages: pages.length };
      else if (pick('fail').length) {
        const w = lowest(pick('fail'));
        const onOriginal = new Set(w.m.detail?.failing?.original ?? []);
        const cost = (w.m.detail?.copyFailingByCategory?.[c] ?? []).slice().sort((a, b) => b.weight - a.weight).slice(0, 5)
          .map((f) => ({ id: f.id, title: w.m.detail?.copyAudits?.[f.id]?.title ?? f.id, weight: f.weight, why: whyStillFailing(f.id, onOriginal.has(f.id)) }));
        v = { status: 'fail', pages: scored.length, lower: pick('fail').length, worst: { path: w.path, original: w.original, copy: w.copy, cost } };
        failed++;
      } else if (pick('noise').length) {
        const w = lowest(pick('noise'));
        v = { status: 'noise', pages: scored.length, lower: pick('noise').length, worst: { path: w.path, original: w.original, copy: w.copy } };
      } else v = { status: 'pass', pages: scored.length, ahead: pick('ahead').length };
      if (scored.length < pages.length) v.unscoredPages = pages.length - scored.length;
      cats[c] = v;
    }
    if (Object.keys(cats).length) byMode[mode] = cats;
  }
  const part = (mode) => {
    const cats = byMode[mode];
    const list = Object.entries(cats);
    const ok = list.filter(([, v]) => v.status === 'pass').length;
    const scored = list.filter(([, v]) => v.status !== 'unscored').length;
    const extra = list.filter(([, v]) => v.status !== 'pass').map(([c, v]) => (v.status === 'unscored'
      ? `${CATEGORY_LABEL[c]} not scored`
      : `${CATEGORY_LABEL[c]} ${v.status === 'noise' ? 'lower within run noise' : 'lower'}: ${v.worst.copy} against ${v.worst.original} on ${v.worst.path}`));
    return `${MODE_LABEL[mode]} ${ok} of ${scored} categor${scored === 1 ? 'y' : 'ies'}${extra.length ? ` (${extra.join('; ')})` : ''}`;
  };
  const modes = MODES.filter((m) => byMode[m]);
  const line = modes.length
    ? `${failed ? 'Not yet better than the original' : 'At least as good as the original'} in Lighthouse: ${modes.map(part).join('; ')}.`
    : null;
  return { rule: 'copy >= original, every Lighthouse category, phone and computer', passed: modes.length ? failed === 0 : null, failed, byMode, line };
}

/** The one line the notes carry. */
export function lighthousePagesNote(comparison) {
  const measured = comparison.pages.filter((p) => Object.values(p.modes).some((m) => !m.error)).length;
  const parts = [`Lighthouse was run on ${measured} page${measured === 1 ? '' : 's'} of the copy and of the original, phone and computer, on this computer with the same settings`];
  parts.push(comparison.extraRunPages.length
    ? `${comparison.extraRunPages.length} page${comparison.extraRunPages.length === 1 ? '' : 's'} needed three runs per side (${comparison.extraRunPages.map((p) => `${p.path} on ${p.modes.map((m) => MODE_LABEL[m]).join(' and ')}`).join('; ')})`
    : 'one run per side decided every page');
  if (comparison.runs.reusedOriginal) parts.push(`${comparison.runs.reusedOriginal} run${comparison.runs.reusedOriginal === 1 ? '' : 's'} of the original reused from an earlier comparison`);
  const refreshed = comparison.refreshedOriginal ?? [];
  if (refreshed.length) parts.push(`${refreshed.length} kept run${refreshed.length === 1 ? '' : 's'} of the original measured again (${refreshed.slice(0, 3).map((r) => `${r.path} on ${MODE_LABEL[r.mode]}: ${r.reason}`).join('; ')})`);
  if (comparison.unscored?.length) parts.push(`${comparison.unscored.length} categor${comparison.unscored.length === 1 ? 'y' : 'ies'} could not be scored and ${comparison.unscored.length === 1 ? 'is' : 'are'} not compared (${[...new Set(comparison.unscored.map((u) => `${u.path} ${MODE_LABEL[u.mode]} ${CATEGORY_LABEL[u.category]}: the ${u.side} in ${u.runs} of ${u.of}`))].slice(0, 6).join('; ')})`);
  const busy = comparison.pages.flatMap((p) => Object.entries(p.modes).filter(([, m]) => (m.contention?.original ?? 0) || (m.contention?.copy ?? 0)).map(([mode]) => `${p.path} on ${MODE_LABEL[mode]}`));
  if (busy.length) parts.push(`measured while other jobs ran on this server: ${busy.slice(0, 6).join('; ')}`);
  const uneven = comparison.pages.flatMap((p) => Object.entries(p.modes).filter(([, m]) => m.uneven).map(([mode]) => `${p.path} on ${MODE_LABEL[mode]}`));
  if (uneven.length) parts.push(`${uneven.length} comparison${uneven.length === 1 ? ' was' : 's were'} measured under different load on the two sides, so three runs per side decided ${uneven.length === 1 ? 'it' : 'them'} (${uneven.slice(0, 6).join('; ')})`);
  if (comparison.skipped.length) parts.push(`not measured for time: ${comparison.skipped.join(', ')}`);
  if (comparison.errors.length) parts.push(`${comparison.errors.length} run${comparison.errors.length === 1 ? '' : 's'} failed (${comparison.errors.slice(0, 3).map((e) => `${e.path} ${e.mode}: ${e.error}`).join('; ')})`);
  const sentence = `${parts.join('; ')}.`;
  return comparison.network?.note ? `${sentence} ${comparison.network.note}` : sentence;
}
