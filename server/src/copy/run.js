// The pipeline behind "Copy my site" (docs/COPY-MY-SITE.md §1). The steps are injected: the orchestration, the per-page
// fallback (§1f), the time-boxed correction and the zero-regressions loop (§4) are decided here, and the browser and
// packaging work sits behind `deps`, so every decision can be tested without a browser.
import { COPY_STAGES } from './stages.js';
import { pageProblems } from './thresholds.js';
import { keepChange, summaryLine, worseItems } from './regress.js';
import { reasonFor } from './openItems.js';

/** Time box of the correction on one page (§6). */
export const CORRECTION_MS = 5 * 60 * 1000;
/** Zero-regressions rounds per project (§6). */
export const REGRESSION_ROUNDS = 3;

/** Lower is better: the number of failing checks, then the visual difference that is left. */
export function badness(problems) {
  const visual = problems.filter((p) => p.check === 'visual').reduce((a, p) => a + (p.min - p.value), 0);
  return problems.length * 100 + visual;
}

/**
 * @param {object} o
 * @param {{ path: string }[]} o.pages
 * @param {string} o.stack
 * @param {object} o.deps   the injected steps (see the function body for each)
 * @param {() => number} [o.now]
 * @param {(stage: string, detail?: string) => void} [o.progress]
 * @param {(entry: object) => void} [o.log]   the server log for unresolved pages
 */
export async function runCopy({ pages, stack, deps, now = Date.now, progress = () => {}, log = () => {}, budgetMs = Infinity }) {
  const started = now();
  const runEnd = started + budgetMs;
  const stages = [];
  const stage = (name, detail) => { stages.push(name); progress(name, detail); };

  // 1. Capture every page.                                   deps.capture(pages) -> captured page list
  stage(COPY_STAGES[0]);
  const captured = await deps.capture(pages);

  // 2. Original as-is for every page (the base).             deps.asIs(captured, stack) -> as-is page list
  stage(COPY_STAGES[1]);
  const asIs = await deps.asIs(captured, stack);

  // 3. Fixers on the as-is output.                           deps.fix(asIs) -> [{ id, page }]; deps.measure(page) -> measurements
  stage(COPY_STAGES[2]);
  const fixes = await deps.fix(asIs);

  // 4. Package in the chosen stack.                          deps.package(asIs, stack) -> output
  stage(COPY_STAGES[3]);
  const output = await deps.package(asIs, stack);

  // 5. Per-page checks, fallback, and the report.
  stage(COPY_STAGES[4]);
  const results = [];
  for (const page of asIs) {
    const first = await checkPage(page, { deps, stack, output, now, started, log, runEnd });
    results.push(first);
  }

  // 6. Zero regressions across the whole re-audit.           deps.reaudit(output) -> items
  const regressions = await zeroRegressions({ deps, output, stack, now, started, log, budgetMs });

  stage(COPY_STAGES[5]);
  const openItems = [
    ...results.flatMap((r) => r.open.map((o) => ({ ...o, page: r.path }))),
    ...regressions.open,
  ];
  const counts = {
    pages: results.length,
    asIs: results.filter((r) => r.how === 'as-is').length,
    rebuilt: results.filter((r) => r.how === 'rebuilt').length,
    gotWorse: regressions.gotWorse,
    fixed: fixes.length + regressions.fixed,
    stillOpen: openItems.length,
  };
  return {
    stages,
    pages: results,
    fixes,
    output,
    openItems,
    counts,
    summary: summaryLine({ stackLabel: stackLabel(stack), ...counts }),
    elapsedMs: now() - started,
  };
}

/**
 * One page: its own problems; if it fails, the auto-repair (re-checked once), then the clean rebuild with the
 * time-boxed correction; the better of the two versions is kept (§1f). A page that still fails is listed as open.
 */
async function checkPage(page, { deps, stack, output, now, started, log, runEnd }) {
  const first = pageProblems(await deps.measure(page, output));
  if (!first.length) return { path: page.path, how: 'as-is', problems: [], open: [] };

  // Known stack-specific repairs, then one re-check.
  const repaired = await deps.autoRepair(page, stack);
  const again = repaired ? pageProblems(await deps.measure(page, output)) : first;
  let best = { how: 'as-is', problems: again.length <= first.length ? again : first };
  if (!best.problems.length) return { path: page.path, how: 'as-is', problems: [], open: [], repaired: true };

  // Rebuild just this page clean in the chosen stack, then the time-boxed correction on it.
  const rebuilt = await deps.rebuildClean(page, stack);
  // The correction stops at its own time box or at the end of the whole run, whichever comes first.
  const boxEnd = Math.min(now() + CORRECTION_MS, runEnd);
  let corrected = rebuilt;
  if (rebuilt && now() < boxEnd) corrected = await deps.correct(rebuilt, { untilMs: boxEnd });
  if (corrected) {
    const cProblems = pageProblems(await deps.measure(corrected, output));
    if (badness(cProblems) < badness(best.problems)) best = { how: 'rebuilt', problems: cProblems };
  }

  if (!best.problems.length) return { path: page.path, how: best.how, problems: [], open: [] };
  const tried = `auto-repair${repaired ? '' : ' (none for this stack)'}, clean rebuild, correction ${Math.round(CORRECTION_MS / 60000)} min`;
  const open = best.problems.map((p) => ({
    check: p.width ? `${p.check} ${p.width}px` : p.check,
    values: `${round(p.value)} (min ${round(p.min)})`,
    tried,
    reason: deps.explain ? deps.explain(p) : 'd',
  }));
  for (const o of open) await log({ site: deps.site, stack, page: page.path, check: o.check, values: o.values, tried: o.tried, reason: o.reason });
  return { path: page.path, how: best.how, problems: best.problems, open, elapsedMs: now() - started };
}

/**
 * The re-audit's "got worse" items: each one is diagnosed by `deps.fixRegression(item)`; a fix is kept only when it adds
 * no failing check anywhere on its page (keepChange) and the item is no longer worse. Otherwise it stays open with the reason.
 */
async function zeroRegressions({ deps, output, stack, now, started, log, budgetMs }) {
  let items = await deps.reaudit(output);
  let fixed = 0;
  let worse = worseItems(items);
  for (let round = 0; round < REGRESSION_ROUNDS && worse.length; round++) {
    const next = [];
    for (const item of worse) {
      if (now() - started > budgetMs) { next.push(item); continue; }
      const before = await deps.problemsOf(item.page);
      const trial = await deps.fixRegression(item, output);
      const after = await deps.problemsOf(item.page);
      if (trial && keepChange(before, after).keep) {
        fixed++;
      } else {
        next.push({ ...item, reverted: true });
      }
    }
    if (!next.length) { worse = []; break; }
    worse = next;
  }
  const open = [];
  for (const item of worse) {
    // Never a reason by default: an item no rule explains is said to be unexplained (openItems.js 'unresolved').
    const reason = reasonFor(item) ?? 'unresolved';
    const entry = { check: item.key, values: item.note ?? 'got worse', tried: `fix attempted, reverted (up to ${REGRESSION_ROUNDS} rounds)`, reason };
    await log({ site: deps.site, stack, page: item.page ?? '-', check: entry.check, values: entry.values, tried: entry.tried, reason });
    open.push(entry);
  }
  return { gotWorse: worse.length, fixed, open };
}

const round = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);

const STACK_LABEL = { html: 'Plain HTML', 'react-vite': 'React + Vite', nextjs: 'Next.js', mern: 'MERN' };
const stackLabel = (stack) => STACK_LABEL[stack] ?? stack;
