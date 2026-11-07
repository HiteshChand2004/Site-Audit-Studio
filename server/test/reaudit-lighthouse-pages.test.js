// Lighthouse on every page of an as-is copy against the original's (reaudit/lighthousePages.js), with a stand-in runner: the
// measuring rule (one run per side when the copy leads by 5 in every category, else three per side and medians), the reuse of the
// original's runs across re-audits, the rows it adds to the checklist, and that a run that fails is listed, never fatal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { betterThanOriginal, compareLighthousePages, decide, lighthousePageItems, lighthousePagesNote, LEAD, medianScores, pageSlug, runsOverlap, singleRunDecides, trimReport } from '../src/reaudit/lighthousePages.js';

const report = (scores, { weight = 400000, lcp = 'img.hero', failing = {}, dom = 900 } = {}) => ({
  fetchTime: '2026-10-23T10:00:00Z', requestedUrl: 'x', finalDisplayedUrl: 'x', environment: { benchmarkIndex: 1200 },
  categories: Object.fromEntries(Object.entries(scores).map(([c, s]) => [c, { score: s == null ? null : s / 100, auditRefs: c === 'performance' ? [{ id: 'speed-index' }] : [] }])),
  audits: {
    'total-byte-weight': { score: 1, numericValue: weight },
    'dom-size': { score: 1, numericValue: dom },
    ...(scores.performance == null && { 'speed-index': { id: 'speed-index', scoreDisplayMode: 'error', errorMessage: 'Chrome did not collect any screenshots during the page load. (SPEEDINDEX_OF_ZERO)' } }),
    'largest-contentful-paint-element': { score: null, scoreDisplayMode: 'informative', details: { items: [{ items: [{ node: { selector: lcp, snippet: `<${lcp}>` } }] }] } },
    ...Object.fromEntries(Object.entries(failing).map(([id, urls]) => [id, { score: 0.3, title: id, details: { items: urls.map((url) => ({ url })) } }])),
  },
});
const ALL = (p, a = 100, b = 100, s = 100) => ({ performance: p, accessibility: a, 'best-practices': b, seo: s });

/** A runner answering from a script: `plan[side][path][mode]` = the reports of successive runs. Counts its calls. */
function fakeRunner(plan) {
  const calls = [];
  const run = async (url, mode, outFile) => {
    const side = url.startsWith('http://127.0.0.1') ? 'copy' : 'original';
    const p = new URL(url).pathname;
    const queue = plan[side][p][mode];
    const lhr = queue.length > 1 ? queue.shift() : queue[0];
    calls.push({ side, path: p, mode });
    await writeFile(outFile, JSON.stringify(lhr));
  };
  return { run, calls };
}

async function dirs(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-lhpages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { cacheDir: path.join(root, 'cache'), outDir: path.join(root, 'out') };
}

test('the rule: one run decides when the copy leads by 5 in every category; medians over three runs decide otherwise', () => {
  assert.ok(singleRunDecides({ scores: ALL(70, 90, 90, 90) }, { scores: ALL(75, 95, 95, 95) }));
  assert.ok(!singleRunDecides({ scores: ALL(70, 90, 90, 90) }, { scores: ALL(76, 94, 95, 95) }), 'one category only 4 ahead');
  assert.ok(!singleRunDecides({ scores: ALL(70) }, { scores: ALL(70) }));
  assert.ok(!singleRunDecides({ scores: { ...ALL(70, 90, 90, 90), seo: null } }, { scores: ALL(75, 95, 95, 95) }), 'a category a run could not score decides nothing: extra runs');
  assert.equal(LEAD, 5);
  assert.deepEqual(medianScores([{ scores: ALL(70) }, { scores: ALL(90) }, { scores: ALL(80) }]).performance, 80);
  assert.deepEqual(medianScores([{ scores: ALL(70) }, { scores: ALL(90) }]).performance, 80, 'an even count: the mean of the middle two');
  const v = decide([{ scores: ALL(70) }, { scores: ALL(72) }, { scores: ALL(71) }], [{ scores: ALL(69) }, { scores: ALL(80) }, { scores: ALL(70) }]);
  assert.deepEqual(v.worse, [], 'copy median 70 < original median 71, but the copy\'s runs spread 69-80: within run noise');
  assert.deepEqual(v.noise, ['performance']);
  const real = decide([{ scores: ALL(80) }, { scores: ALL(81) }, { scores: ALL(82) }], [{ scores: ALL(72) }, { scores: ALL(70) }, { scores: ALL(75) }]);
  assert.deepEqual(real.worse, ['performance'], 'a gap of 9, beyond either side\'s spread (2 and 5), is worse');
  assert.deepEqual(real.noise, []);
  assert.deepEqual(decide([{ scores: ALL(71) }], [{ scores: ALL(70) }]).noise, [], 'one run per side has no spread: never noise');
  assert.equal(v.accepted, 'median of runs');
  assert.deepEqual(decide([{ scores: ALL(70) }], [{ scores: ALL(70) }]).worse, [], 'equal is not lower');
});

test('trimReport keeps what a comparison needs and drops the rest; pageSlug tells two sites\' pages apart', () => {
  const t = trimReport(report(ALL(55, 90, 80, 100), { weight: 123456, lcp: 'h1.title', failing: { 'unused-javascript': ['https://cdn.example.net/a.js'], 'other-failing': [] } }));
  assert.deepEqual(t.scores, { performance: 55, accessibility: 90, 'best-practices': 80, seo: 100 });
  assert.equal(t.weightBytes, 123456);
  assert.deepEqual(t.lcpElement, { selector: 'h1.title', snippet: '<h1.title>' });
  assert.deepEqual(Object.keys(t.audits), ['unused-javascript', 'other-failing'], 'failing audits with their urls; the informative one is left out');
  assert.deepEqual(t.audits['unused-javascript'].urls, ['https://cdn.example.net/a.js']);
  assert.notEqual(pageSlug('/about/', 'https://a.test/about/'), pageSlug('/about/', 'https://b.test/about/'));
  assert.match(pageSlug('/', 'https://a.test/'), /^index-[0-9a-f]{8}$/);
});

test('compareLighthousePages: one run per side when the copy leads, three when it does not, rows per page x mode x category, the original reused next time', { timeout: 60000 }, async (t) => {
  const { cacheDir, outDir } = await dirs(t);
  const plan = () => ({
    original: {
      '/': { mobile: [report(ALL(60, 90, 90, 90))], desktop: [report(ALL(80, 90, 90, 90))] },
      '/about/': { mobile: [report(ALL(70, 90, 90, 90)), report(ALL(72, 90, 90, 90)), report(ALL(71, 90, 90, 90))], desktop: [report(ALL(90, 90, 90, 90))] },
    },
    copy: {
      // Homepage: ahead by >= 5 everywhere on the phone (one run decides); on the computer accessibility 90 vs 90: three runs, copy median equal (not worse).
      '/': { mobile: [report(ALL(70, 96, 95, 100))], desktop: [report(ALL(85, 90, 95, 95))] },
      // /about/ phone: run 1 behind, medians 70 vs 71 -> performance worse; SEO 85 vs 90 worse too.
      '/about/': { mobile: [report(ALL(69, 95, 95, 85)), report(ALL(80, 95, 95, 85)), report(ALL(70, 95, 95, 85))], desktop: [report(ALL(95, 95, 95, 95))] },
    },
  });
  const { run, calls } = fakeRunner(plan());
  const pages = [{ path: '/', url: 'https://site.test/', copyUrl: 'http://127.0.0.1:5000/' }, { path: '/about/', url: 'https://site.test/about/', copyUrl: 'http://127.0.0.1:5000/about/' }];
  const messages = [];
  const r = await compareLighthousePages({ pages, cacheDir, outDir, run, progress: (f, m) => m && messages.push(m) });

  assert.equal(r.pages.length, 2);
  assert.equal(r.pages[0].modes.mobile.accepted, 'single run');
  assert.deepEqual(r.pages[0].modes.mobile.runs, { original: 1, copy: 1 });
  assert.equal(r.pages[0].modes.desktop.accepted, 'median of runs', 'accessibility 90 vs 90 is not a lead of 5');
  assert.deepEqual(r.pages[0].modes.desktop.worse, []);
  assert.deepEqual(r.pages[1].modes.mobile.original, ALL(71, 90, 90, 90));
  assert.deepEqual(r.pages[1].modes.mobile.copy, ALL(70, 95, 95, 85));
  assert.deepEqual(r.pages[1].modes.mobile.worse, ['seo'], 'SEO 85 vs 90, no spread on either side');
  assert.deepEqual(r.pages[1].modes.mobile.noise, ['performance'], 'performance 70 vs 71, the copy\'s runs 69-80');
  assert.deepEqual(r.pages[1].modes.desktop.worse, []);
  assert.deepEqual(r.worse.map((w) => `${w.path} ${w.mode} ${w.category} ${w.original}>${w.copy}`), ['/about/ mobile seo 90>85']);
  assert.deepEqual(r.extraRunPages, [{ path: '/', modes: ['desktop'] }, { path: '/about/', modes: ['mobile'] }]);
  // Runs: / mobile 1+1, / desktop 3+3, /about mobile 3+3, /about desktop 1+1 = 8 per side.
  assert.deepEqual(r.runs, { original: 8, copy: 8, reusedOriginal: 0 });
  assert.equal(calls.length, 16);
  assert.ok(messages.some((m) => /run 2 of 3 on both sides/.test(m)));

  const items = lighthousePageItems(r);
  const worse = items.filter((i) => i.status === 'regressed');
  assert.deepEqual(worse.map((i) => i.key), ['lighthouse-score.mobile.seo./about/']);
  assert.equal(worse[0].category, 'seo');
  assert.match(worse[0].after.detail, /85 on the copy — median of runs \(3 of the original, 3 of the copy\)/);
  const noisy = items.filter((i) => i.status === 'changed');
  assert.deepEqual(noisy.map((i) => [i.key, i.statusLabel]), [['lighthouse-score.mobile.performance./about/', 'Within run noise']]);
  assert.match(noisy[0].after.detail, /70 on the copy \(runs 69 \/ 80 \/ 70\)/);
  assert.equal(worse[0].lighthousePage.weight.original, 400000);
  assert.deepEqual(items.filter((i) => i.status === 'pass').map((i) => i.key), ['lighthouse-score.mobile.all./', 'lighthouse-score.desktop.all./', 'lighthouse-score.desktop.all./about/']);
  const note = lighthousePagesNote(r);
  assert.match(note, /run on 2 pages of the copy and of the original, phone and computer/);
  assert.match(note, /2 pages needed three runs per side \(\/ on computer; \/about\/ on phone\)/);

  // A second comparison (another re-audit of the same project): the original's runs come from the cache, only the copy is run.
  const again = fakeRunner(plan());
  const r2 = await compareLighthousePages({ pages, cacheDir, outDir: `${outDir}-2`, run: again.run });
  assert.deepEqual(r2.runs, { original: 0, copy: 8, reusedOriginal: 8 });
  assert.ok(again.calls.every((c) => c.side === 'copy'));
  assert.match(lighthousePagesNote(r2), /8 runs of the original reused/);
  assert.equal((await readdir(cacheDir)).filter((f) => !f.endsWith('.full.json')).length, 8, 'one trimmed file per run of the original');
});

test('a run that fails is listed for its page and mode, the rest is measured; past the deadline pages are skipped, not guessed', { timeout: 30000 }, async (t) => {
  const { cacheDir, outDir } = await dirs(t);
  const good = fakeRunner({ original: { '/': { mobile: [report(ALL(50, 80, 80, 80))], desktop: [report(ALL(50, 80, 80, 80))] } }, copy: { '/': { mobile: [report(ALL(60, 90, 90, 90))], desktop: [report(ALL(60, 90, 90, 90))] } } });
  let n = 0;
  const run = async (url, mode, outFile) => {
    if (mode === 'desktop' && n++ === 0) throw new Error('Lighthouse worker died');
    return good.run(url, mode, outFile);
  };
  const r = await compareLighthousePages({ pages: [{ path: '/', url: 'https://site.test/', copyUrl: 'http://127.0.0.1:5000/' }], cacheDir, outDir, run });
  assert.equal(r.pages[0].modes.mobile.accepted, 'single run');
  assert.deepEqual(r.errors, [{ path: '/', mode: 'desktop', error: 'Lighthouse worker died' }]);
  assert.equal(lighthousePageItems(r).length, 1, 'no row for the mode that failed');
  assert.match(lighthousePagesNote(r), /1 run failed \(\/ desktop: Lighthouse worker died\)/);

  const late = await compareLighthousePages({ pages: [{ path: '/', url: 'https://site.test/', copyUrl: 'http://127.0.0.1:5000/' }], cacheDir: `${cacheDir}-l`, outDir: `${outDir}-l`, run: good.run, deadline: Date.now() - 1 });
  assert.deepEqual(late.skipped, ['/ (mobile)', '/ (desktop)']);
  assert.deepEqual(late.pages[0].modes, {});
});

test('a run Lighthouse could not score, or in which the copy rendered a blank shell, is reported as "could not be scored" (recheck), never averaged into a median', { timeout: 30000 }, async (t) => {
  // Phone: the copy's performance has no score in 2 of 3 runs (no screenshots during the load); the one scored run is 73 against
  // the original's 80 — one number is not a median of three, so the row is a recheck, not "got worse".
  const v = decide(
    [{ scores: ALL(81, 90, 96, 85), domElements: 1054 }, { scores: ALL(80, 90, 96, 85), domElements: 1054 }, { scores: ALL(78, 90, 96, 85), domElements: 1054 }],
    [{ scores: { ...ALL(null, 100, 96, 100) }, unscored: { performance: ['speed-index: no screenshots'] }, domElements: 1054 }, { scores: ALL(null, 100, 96, 100), unscored: { performance: ['speed-index: no screenshots'] }, domElements: 1054 }, { scores: ALL(73, 94, 96, 85), domElements: 1054 }],
  );
  assert.deepEqual(v.worse, [], 'performance is not compared, so it is not worse');
  assert.deepEqual(v.unscored.performance, { copy: { runs: 2, of: 3, errors: ['speed-index: no screenshots'] } });
  assert.equal(v.copy.performance, null);
  assert.equal(v.copy.accessibility, 100, 'the categories every run scored are compared as before');

  // A copy run that rendered 36 elements against the original's 1054 showed no page: a perfect accessibility score on it is about
  // nothing, so that run is unscored in every category.
  const b = decide([{ scores: ALL(80, 90, 96, 85), domElements: 1054 }], [{ scores: ALL(null, 100, 96, 100), unscored: { performance: ['speed-index: no screenshots'] }, domElements: 36 }]);
  assert.deepEqual(Object.keys(b.unscored), ['performance', 'accessibility', 'best-practices', 'seo']);
  assert.equal(b.blankRuns, 1);
  assert.match(b.unscored.seo.copy.errors[0], /rendered 36 elements against the original's 1054/);
  assert.deepEqual(b.worse, []);

  // Through the comparison: recheck rows per unscored category, a pass row only for what was scored, the note says it.
  const { cacheDir, outDir } = await dirs(t);
  const { run } = fakeRunner({
    original: { '/': { mobile: [report(ALL(81, 90, 96, 85)), report(ALL(80, 90, 96, 85)), report(ALL(78, 90, 96, 85))], desktop: [report(ALL(84, 90, 96, 85))] } },
    copy: { '/': { mobile: [report(ALL(null, 100, 96, 100)), report(ALL(null, 100, 96, 100)), report(ALL(73, 94, 96, 85))], desktop: [report(ALL(null, 100, 96, 100), { dom: 36 })] } },
  });
  const r = await compareLighthousePages({ pages: [{ path: '/', url: 'https://site.test/', copyUrl: 'http://127.0.0.1:5000/' }], cacheDir, outDir, run });
  assert.deepEqual(r.worse, []);
  assert.equal(r.unscored.filter((u) => u.mode === 'mobile').length, 1);
  assert.equal(r.unscored.filter((u) => u.mode === 'desktop').length, 4, 'a blank desktop run: every category');
  const items = lighthousePageItems(r);
  const recheck = items.filter((i) => i.status === 'recheck');
  assert.equal(recheck.length, 5);
  assert.match(recheck[0].title, /Performance score \(phone\) on \/: could not be scored/);
  assert.match(recheck[0].after.detail, /the copy in 2 of 3 runs \(speed-index: Chrome did not collect any screenshots/);
  const pass = items.filter((i) => i.status === 'pass');
  assert.equal(pass.length, 1, 'phone: the three scored categories pass; desktop: nothing scored, no pass row');
  assert.match(pass[0].title, /in the categories scored$/);
  assert.match(pass[0].after.detail, /^Accessibility 100, Best practices 96, SEO 100/);
  assert.match(lighthousePagesNote(r), /5 categories could not be scored and are not compared/);
});

test('noise only when the two sides\' runs overlap (Step 10a)', () => {
  const runs = (...xs) => xs.map((p) => ({ scores: ALL(p) }));
  // Saved gardener re-audit: the gap 9 is within the original's spread (79-88), but every copy run is under every original run.
  const apart = decide(runs(79, 82, 88), runs(70, 73, 74));
  assert.deepEqual(apart.noise, [], 'no run of the copy reaches the original\'s worst run: not noise');
  assert.deepEqual(apart.worse, ['performance']);
  const close = decide(runs(98, 99, 98), runs(97, 97, 97));
  assert.deepEqual(close.worse, ['performance'], 'a gap of 1 with no overlap is worse, however small');
  const touch = decide(runs(99, 99, 99), runs(99, 98, 98));
  assert.deepEqual(touch.noise, ['performance'], 'the copy\'s best run equals the original\'s worst: overlap, within noise');
  assert.ok(runsOverlap(runs(80, 90), runs(70, 80), 'performance'));
  assert.ok(!runsOverlap(runs(80, 90), runs(70, 79), 'performance'));
  assert.ok(!runsOverlap(runs(80), [{ scores: ALL(null) }], 'performance'), 'nothing scored on a side: no overlap');
  // Overlap alone is not enough: the gap must still be within the runs' spread (unchanged rule).
  const wide = decide(runs(85, 90, 90), runs(80, 80, 85));
  assert.deepEqual(wide.worse, ['performance'], 'overlapping runs, but a gap of 10 beyond the spread of 5: worse');
});

test('betterThanOriginal: one verdict per device and category, the line says it, and a fail names the page and its cost (Step 10b)', () => {
  const runs = (...xs) => xs.map((s) => ({ scores: s }));
  const mode = (o, k, extra = {}) => ({ ...decide(o, k), runScores: { original: o.map((r) => r.scores), copy: k.map((r) => r.scores) }, detail: {}, ...extra });
  const comparison = { pages: [
    { path: '/', modes: {
      mobile: mode(runs(ALL(80, 90, 92, 90), ALL(81, 90, 92, 90), ALL(82, 90, 92, 90)), runs(ALL(70, 95, 92, 100), ALL(71, 95, 92, 100), ALL(72, 95, 92, 100)),
        { detail: { copyFailingByCategory: { performance: [{ id: 'unused-javascript', weight: 0 }, { id: 'largest-contentful-paint', weight: 25 }] }, failing: { original: ['unused-javascript'] }, copyAudits: {} } }),
      desktop: mode(runs(ALL(95, 90, 92, 90)), runs(ALL(100, 96, 100, 100))),
    } },
    { path: '/about', modes: {
      mobile: mode(runs(ALL(90, 90, 92, 90), ALL(91, 90, 92, 90), ALL(90, 90, 92, 90)), runs(ALL(91, 92, 92, 90), ALL(89, 92, 92, 90), ALL(90, 92, 92, 90))),
      desktop: { error: 'run failed' },
    } },
  ] };
  const b = betterThanOriginal(comparison);
  assert.equal(b.passed, false);
  assert.equal(b.failed, 1);
  const pf = b.byMode.mobile.performance;
  assert.equal(pf.status, 'fail');
  assert.deepEqual([pf.worst.path, pf.worst.original, pf.worst.copy], ['/', 81, 71]);
  assert.deepEqual(pf.worst.cost.map((c) => c.id), ['largest-contentful-paint', 'unused-javascript'], 'heaviest first');
  assert.match(pf.worst.cost[1].why, /original's own JavaScript/);
  assert.equal(b.byMode.mobile.seo.status, 'pass');
  assert.equal(b.byMode.mobile.seo.ahead, 1, 'higher on / , equal on /about');
  assert.equal(b.byMode.mobile['best-practices'].status, 'pass', 'equal everywhere still passes (copy >= original)');
  assert.equal(b.byMode.desktop.performance.status, 'pass', 'a failed run on /about is not counted');
  assert.equal(b.byMode.desktop.performance.pages, 1);
  assert.match(b.line, /^Not yet better than the original in Lighthouse: phone 3 of 4 categories \(Performance lower: 71 against 81 on \/\); computer 4 of 4 categories\.$/);
  // Within noise: not a fail, said so.
  const noisy = betterThanOriginal({ pages: [{ path: '/', modes: { mobile: mode(runs(ALL(90), ALL(80), ALL(85)), runs(ALL(84), ALL(83), ALL(88))) } }] });
  assert.equal(noisy.byMode.mobile.performance.status, 'noise');
  assert.equal(noisy.passed, true);
  assert.match(noisy.line, /^At least as good as the original in Lighthouse: phone 3 of 4 categories \(Performance lower within run noise: 84 against 85 on \/\)\.$/);
  // Nothing measured: no verdict, no line.
  assert.deepEqual(betterThanOriginal({ pages: [] }), { rule: 'copy >= original, every Lighthouse category, phone and computer', passed: null, failed: 0, byMode: {}, line: null });
});
