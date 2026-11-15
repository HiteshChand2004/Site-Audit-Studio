// A speed row measured once per side does not decide "got worse" (pitchlight, 2026-11-14: "Eliminate render-blocking
// resources" read 330 → 910 ms on the phone for the same six files, the copy's run made while other jobs ran). The Lighthouse
// rows of the checklist compare one run of the copy's homepage with one run of the original's; only when one of them would turn
// "got worse" and is a time (a speed row: a metric, an estimated saving in ms), that page is measured again on that device until
// each side has REPEAT_RUNS runs (the runs the page comparison already made are used first: no run is made twice), and the
// row is decided by each side's median run. Every run keeps the computer's CPU benchmark and how many other jobs ran beside it.
// Rows that are not times (bytes, element counts, checks of the page's code) give the same answer on every run: never repeated.
import { readFile } from 'node:fs/promises';
import { EXTRA_RUNS, MODES, measureRun, pageSlug, runFileOf } from './lighthousePages.js';

/** Runs per side a repeated speed row is decided by (the first run plus EXTRA_RUNS). */
export const REPEAT_RUNS = 1 + EXTRA_RUNS;
/** The audits a chosen run also lends the row's explanation (copy/gotWorse.js reads the page's requests, weight, largest element). */
const SUPPORT = ['network-requests', 'metrics', 'total-byte-weight', 'largest-contentful-paint-element'];

/** A time an audit measured (ms: a metric, or the time it says could be saved), or null for anything else. */
export function timeOf(a) {
  if (!a) return null;
  if (Number.isFinite(a.details?.overallSavingsBytes)) return null;
  if (Number.isFinite(a.numericValue)) return a.numericUnit === 'millisecond' ? a.numericValue : null;
  const saved = Object.values(a.metricSavings ?? {}).filter(Number.isFinite);
  return saved.length ? saved.reduce((x, y) => x + y, 0) : null;
}

/**
 * The speed rows a first comparison turns "got worse": regressed Lighthouse rows (lighthouse.<id>) whose audit is a time, on
 * each device where the copy's run is worse than the original's (a lower grade, or a longer time). Map(mode → Set(id)).
 */
export function speedCandidates(items, oldLh, newLh) {
  const out = new Map();
  for (const it of items ?? []) {
    if (it.status !== 'regressed' || !String(it.key ?? '').startsWith('lighthouse.')) continue;
    const id = it.key.slice('lighthouse.'.length);
    for (const mode of MODES) {
      const a = newLh?.[mode]?.audits?.[id];
      const t = timeOf(a);
      if (t == null) continue;
      const b = oldLh?.[mode]?.audits?.[id];
      const tb = timeOf(b);
      const lowerGrade = typeof a.score === 'number' && typeof b?.score === 'number' && a.score < b.score;
      if (!lowerGrade && !(tb == null || t > tb)) continue;
      if (!out.has(mode)) out.set(mode, new Set());
      out.get(mode).add(id);
    }
  }
  return out;
}

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);

/** The run whose value is the median of the runs that measured one (sorted by value; the middle one, the lower of two). */
function medianRun(runs, id) {
  const known = runs.filter((r) => Number.isFinite(r.values[id])).sort((a, b) => a.values[id] - b.values[id]);
  return known.length ? known[Math.floor((known.length - 1) / 2)] : null;
}

/**
 * Measures the page again for the candidate rows and keeps, per device and side, the audits of each row's median run.
 * @param {object} o
 * @param {Map<string, Set<string>>} o.candidates  speedCandidates
 * @param {{ path: string, url: string, copyUrl: string, originalUrl?: string, originalCacheDir?: string }} o.page  the homepage, as the page comparison lists it
 * @param {string} o.cacheDir  the original's run cache (lighthousePages)
 * @param {string} o.outDir    this re-audit's runs of the copy (lighthousePages)
 * @param {(url: string, mode: string, outFile: string) => Promise<object>} o.run
 * @returns {Promise<object>}  { page, modes: { [mode]: { ids, runs: { original, copy }, chosen, patch } }, runs, refreshedOriginal, errors }
 */
export async function repeatSpeedRows({ candidates, page, cacheDir, outDir, run, signal = null, progress = () => {} }) {
  const slug = pageSlug(page.path, page.url);
  const record = { page: page.path, runsPerSide: REPEAT_RUNS, modes: {}, runs: { original: 0, copy: 0, reusedOriginal: 0, reusedCopy: 0 }, refreshedOriginal: [], errors: [] };
  for (const [mode, idSet] of candidates) {
    const ids = [...idSet];
    const sides = { original: [], copy: [] };
    for (let n = 1; n <= REPEAT_RUNS; n++) {
      if (signal?.aborted) throw Object.assign(new Error('Stopped before it finished.'), { stopped: true });
      progress(`Lighthouse (${mode === 'mobile' ? 'phone' : 'computer'}) on ${page.path}: run ${n} of ${REPEAT_RUNS} on both sides (a speed check read worse once)`);
      try {
        // The copy's runs of this re-audit are used as they are (the page comparison made run 1, and more when it needed them).
        const copy = await measureRun({ side: 'copy', p: page, slug, mode, n, cacheDir, outDir, run, reuseCopy: true, result: record });
        const original = await measureRun({ side: 'original', p: page, slug, mode, n, copyRun: copy, cacheDir, outDir, run, result: record });
        for (const [side, trimmed, dir] of [['copy', copy, outDir], ['original', original, page.originalCacheDir ?? cacheDir]]) {
          const lhr = await readJson(`${runFileOf(dir, slug, mode, n)}.full.json`);
          if (!lhr?.audits) continue;
          sides[side].push({
            n,
            benchmark: Number.isFinite(trimmed?.benchmarkIndex) ? Math.round(trimmed.benchmarkIndex) : null,
            otherJobs: typeof trimmed?.contention?.otherJobs === 'number' ? trimmed.contention.otherJobs : null,
            values: Object.fromEntries(ids.map((id) => [id, timeOf(lhr.audits[id])])),
            lhr,
          });
        }
      } catch (err) {
        if (err?.stopped) throw err;
        record.errors.push({ mode, run: n, error: String(err?.message ?? err).split('\n')[0].slice(0, 200) });
        break;
      }
    }
    const chosen = { original: {}, copy: {} };
    const patch = { original: {}, copy: {} };
    for (const side of ['original', 'copy']) {
      const picks = new Map();
      for (const id of ids) {
        const m = medianRun(sides[side], id);
        if (!m) continue;
        chosen[side][id] = m.n;
        patch[side][id] = m.lhr.audits[id];
        picks.set(m, (picks.get(m) ?? 0) + 1);
      }
      // The page's requests, weight and largest element from the run that decided the most rows (the explanation reads them).
      const lead = [...picks].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (lead) for (const id of SUPPORT) if (lead.lhr.audits[id] && !(id in patch[side])) patch[side][id] = lead.lhr.audits[id];
    }
    record.modes[mode] = {
      ids,
      runs: Object.fromEntries(Object.entries(sides).map(([side, list]) => [side, list.map(({ n, benchmark, otherJobs, values }) => ({ n, benchmark, otherJobs, values }))])),
      chosen,
      patch,
    };
  }
  return record;
}

/**
 * One side's Lighthouse reports ({ mobile, desktop }) with the audits of the median runs put in place of the first run's; the
 * rest of each report is left as it was. Nothing changes without a repeat.
 */
export function withMedianAudits(lh, repeat, side) {
  if (!repeat?.modes || !lh) return lh;
  const out = { ...lh };
  for (const [mode, m] of Object.entries(repeat.modes)) {
    const audits = m.patch?.[side];
    if (!out[mode] || !audits || !Object.keys(audits).length) continue;
    out[mode] = { ...out[mode], audits: { ...out[mode].audits, ...audits } };
  }
  return out;
}

/** The checklist row's record of its repeat: per device, each side's runs (value, benchmark, other jobs) and the median run. */
export function repeatOf(repeat, id) {
  const out = {};
  for (const [mode, m] of Object.entries(repeat?.modes ?? {})) {
    if (!m.ids.includes(id)) continue;
    const side = (s) => ({ runs: m.runs[s].map((r) => ({ n: r.n, ms: r.values[id] == null ? null : Math.round(r.values[id]), benchmark: r.benchmark, otherJobs: r.otherJobs })), median: m.chosen[s][id] ?? null });
    out[mode] = { original: side('original'), copy: side('copy') };
  }
  return Object.keys(out).length ? out : null;
}

/** The row's sentence: how many runs per side decided it, and under what load. */
export function repeatNote(rep) {
  const parts = Object.entries(rep).map(([mode, r]) => {
    const list = (s) => r[s].runs.map((x) => `${x.ms ?? '–'} ms${x.benchmark != null ? ` (CPU ${x.benchmark}${x.otherJobs ? `, ${x.otherJobs} other job${x.otherJobs === 1 ? '' : 's'}` : ''})` : ''}`).join(', ');
    return `${mode === 'mobile' ? 'phone' : 'computer'}: original ${list('original')}; copy ${list('copy')}`;
  });
  return `One run read worse, so the page was measured ${REPEAT_RUNS} times on each side and each side's median run decides (${parts.join(' — ')}).`;
}
