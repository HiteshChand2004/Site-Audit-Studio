// A speed row one run per side turns "got worse" is measured again (reaudit/speedRepeat.js): only that page and device, up to
// three runs per side counting the runs the page comparison already made, each side's median run decides, and every run keeps
// the CPU benchmark and the other jobs beside it. Rows that are not times are never repeated. With a stand-in runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditDir, DATA_DIR } from '../src/config/paths.js';
import { compareAudits } from '../src/reaudit/compare/index.js';
import { buildChecklist, checklistSides, reauditDir } from '../src/reaudit/index.js';
import { compareLighthousePages } from '../src/reaudit/lighthousePages.js';
import { REPEAT_RUNS, repeatNote, repeatOf, repeatSpeedRows, speedCandidates, timeOf, withMedianAudits } from '../src/reaudit/speedRepeat.js';

const blockingAudit = (ms) => ({ id: 'render-blocking-resources', score: ms > 300 ? 0.5 : 1, numericValue: ms, numericUnit: 'millisecond', displayValue: `Est savings of ${ms} ms`, details: { items: [{ url: 'http://x/a.css', totalBytes: 1000 }] } });
const report = (ms, { perf = 90, benchmark = 1200 } = {}) => ({
  fetchTime: new Date().toISOString(), finalDisplayedUrl: 'x', environment: { benchmarkIndex: benchmark },
  categories: { performance: { score: perf / 100, auditRefs: [] }, accessibility: { score: 1, auditRefs: [] }, 'best-practices': { score: 1, auditRefs: [] }, seo: { score: 1, auditRefs: [] } },
  audits: { 'render-blocking-resources': blockingAudit(ms), 'total-byte-weight': { score: 1, numericValue: 400000 }, 'network-requests': { details: { items: [{ url: 'http://x/', resourceType: 'Document', networkRequestTime: 1 }] } } },
});

test('speed candidates: regressed time rows, per device where the copy read worse; bytes and passing rows never', () => {
  const lh = (rb, bytes) => ({ audits: { 'render-blocking-resources': blockingAudit(rb), 'unused-css-rules': { score: 0.5, numericValue: 9000, numericUnit: 'byte', details: { overallSavingsBytes: bytes } } } });
  const items = [
    { key: 'lighthouse.render-blocking-resources', status: 'regressed' },
    { key: 'lighthouse.unused-css-rules', status: 'regressed' },
    { key: 'lighthouse.largest-contentful-paint', status: 'open' },
  ];
  const c = speedCandidates(items, { mobile: lh(330, 1000), desktop: lh(260, 1000) }, { mobile: lh(910, 5000), desktop: lh(250, 5000) });
  assert.deepEqual([...c].map(([m, ids]) => [m, [...ids]]), [['mobile', ['render-blocking-resources']]], 'the phone only: the computer read 260 → 250');
  assert.equal(timeOf({ metricSavings: { FCP: 300, LCP: 300 } }), 600);
  assert.equal(timeOf({ numericValue: 5, numericUnit: 'element' }), null);
});

test('only what is missing is measured, each side\'s median run decides, and every run says how fast the computer was', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-speed-repeat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'cache');
  const outDir = path.join(root, 'out');
  // Run 1 on each side, made by the page comparison (the copy's speed score is not lower: one run there).
  const queue = { copy: [report(910, { perf: 92 }), report(340, { benchmark: 1150 }), report(360)], original: [report(330, { perf: 90 }), report(350), report(320)] };
  const calls = [];
  const run = async (url, mode, outFile) => {
    const side = url.startsWith('http://127.0.0.1') ? 'copy' : 'original';
    calls.push(`${side} ${mode}`);
    await writeFile(outFile, JSON.stringify(queue[side].shift()));
    return { contention: { otherJobs: side === 'copy' && calls.length === 3 ? 2 : 0 } };
  };
  const page = { path: '/', url: 'https://site.test/', copyUrl: 'http://127.0.0.1:5000/' };
  await compareLighthousePages({ pages: [page], cacheDir, outDir, run: async (u, m, f) => (m === 'mobile' ? run(u, m, f) : writeFile(f, JSON.stringify(report(100)))) });
  assert.deepEqual(calls, ['copy mobile', 'original mobile']);

  const rec = await repeatSpeedRows({ candidates: new Map([['mobile', new Set(['render-blocking-resources'])]]), page, cacheDir, outDir, run });
  assert.equal(REPEAT_RUNS, 3);
  assert.deepEqual(calls.slice(2), ['copy mobile', 'original mobile', 'copy mobile', 'original mobile'], 'runs 2 and 3 on both sides; run 1 was not made again');
  assert.deepEqual(rec.runs, { original: 2, copy: 2, reusedOriginal: 1, reusedCopy: 1 });
  const m = rec.modes.mobile;
  assert.deepEqual(m.runs.copy.map((r) => [r.n, r.values['render-blocking-resources'], r.benchmark, r.otherJobs]), [[1, 910, 1200, 0], [2, 340, 1150, 2], [3, 360, 1200, 0]]);
  assert.deepEqual(m.runs.original.map((r) => r.values['render-blocking-resources']), [330, 350, 320]);
  assert.deepEqual(m.chosen, { copy: { 'render-blocking-resources': 3 }, original: { 'render-blocking-resources': 1 } }, 'the median runs: 360 ms and 330 ms');

  // The rows read the median runs' audits; the rest of each report stays the first run's.
  const first = { mobile: { audits: { 'render-blocking-resources': blockingAudit(910), other: { score: 1 } } }, desktop: { audits: {} } };
  const patched = withMedianAudits(first, rec, 'copy');
  assert.equal(patched.mobile.audits['render-blocking-resources'].numericValue, 360);
  assert.deepEqual(patched.mobile.audits.other, { score: 1 });
  assert.equal(first.mobile.audits['render-blocking-resources'].numericValue, 910, 'the reports passed in are not changed');
  assert.ok(patched.mobile.audits['network-requests'], 'the median run lends the page\'s requests to the explanation');
  assert.equal(withMedianAudits(first, null, 'copy'), first);

  const rep = repeatOf(rec, 'render-blocking-resources');
  assert.deepEqual(rep.mobile.copy, { runs: [{ n: 1, ms: 910, benchmark: 1200, otherJobs: 0 }, { n: 2, ms: 340, benchmark: 1150, otherJobs: 2 }, { n: 3, ms: 360, benchmark: 1200, otherJobs: 0 }], median: 3 });
  assert.equal(repeatOf(rec, 'largest-contentful-paint'), null);
  assert.match(repeatNote(rep), /measured 3 times on each side .*phone: original 330 ms \(CPU 1200\), 350 ms .*; copy 910 ms \(CPU 1200\), 340 ms \(CPU 1150, 2 other jobs\)/);

  // A second look finds every run there: nothing is measured again.
  const before = calls.length;
  const again = await repeatSpeedRows({ candidates: new Map([['mobile', new Set(['render-blocking-resources'])]]), page, cacheDir, outDir, run });
  assert.equal(calls.length, before);
  assert.deepEqual(again.modes.mobile.chosen, m.chosen);
});

test('the checklist: a speed row one run turns "got worse" is measured again and decided by the median runs', { timeout: 60000 }, async () => {
  // The test runner's own data folder (a temporary one), never the app's.
  assert.ok(process.env.SAS_DATA_DIR && DATA_DIR === path.resolve(process.env.SAS_DATA_DIR));
  // A row the checklist compares: graded as Lighthouse grades it (a longer wait, a lower grade).
  const rowAudit = (ms) => {
    const a = blockingAudit(ms);
    // Lighthouse reports it as an estimated saving (an opportunity), not a measured CPU time.
    return { ...a, title: 'Eliminate render-blocking resources', scoreDisplayMode: 'metricSavings', score: ms > 500 ? 0.3 : 0.5, details: { ...a.details, type: 'opportunity' } };
  };
  const lhr = (ms, perf = 90) => {
    const r = report(ms, { perf });
    r.categories.performance.auditRefs = [{ id: 'render-blocking-resources' }];
    r.audits['render-blocking-resources'] = rowAudit(ms);
    return r;
  };
  const project = { id: 'speed-repeat-project' };
  const [analysisId, recreateId, reauditId] = ['an1', 'rc1', 'ra1'];
  const side = (url) => ({ url, analysisId, seo: [], aeo: [], crawl: {}, accessibility: [], brokenLinks: { broken: [] }, techStack: [], manualRebuild: [], scores: { mobile: { performance: 90 }, desktop: null } });
  const oldAudit = side('https://site.test/');
  const audit = side('http://127.0.0.1:5000/');
  const report1 = { recreateId, analysisId, pages: [{ url: 'https://site.test/', outPath: 'index.html' }], fixes: [], autoGenerated: [], manual: [] };
  const analysis = { result_json: JSON.stringify(oldAudit) };
  // The Check's run of the original and this re-audit's run of the copy: 330 ms against 910 ms, one run each.
  await mkdir(auditDir(project.id, analysisId), { recursive: true });
  await writeFile(path.join(auditDir(project.id, analysisId), 'lighthouse-mobile.json'), JSON.stringify(lhr(330)));
  const outDir = reauditDir(project.id, recreateId, reauditId);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'lighthouse-mobile.json'), JSON.stringify(lhr(910, 92)));

  // The page comparison's runs (one per side: the copy's speed score is not lower), then the repeat as runReaudit makes it.
  const queue = { copy: [lhr(910, 92), lhr(340), lhr(360)], original: [lhr(330), lhr(350), lhr(320)] };
  const run = async (url, mode, file) => {
    const s = url.startsWith('http://127.0.0.1') ? 'copy' : 'original';
    await writeFile(file, JSON.stringify(mode === 'mobile' ? queue[s].shift() : report(100)));
    return { contention: { otherJobs: 0 } };
  };
  const page = { path: '/', url: 'https://site.test/', copyUrl: 'http://127.0.0.1:5000/', originalFrom: 'lifted' };
  const cacheDir = path.join(DATA_DIR, 'projects', project.id, 'lighthouse-original');
  const runsDir = path.join(outDir, 'lighthouse-pages');
  const lighthousePages = await compareLighthousePages({ pages: [page], cacheDir, outDir: runsDir, run });
  const sides = await checklistSides({ project, report: report1, analysis, audit, recreateId, reauditId, isAsIs: false });
  const draft = compareAudits({ old: sides.old, next: sides.next, report: report1, newOrigin: 'http://127.0.0.1:5000' });
  assert.equal(draft.items.find((i) => i.key === 'lighthouse.render-blocking-resources')?.status, 'regressed', 'one run per side: got worse');
  const candidates = speedCandidates(draft.items, sides.old.lighthouse, sides.next.lighthouse);
  assert.deepEqual([...candidates.keys()], ['mobile']);
  lighthousePages.speedRepeat = await repeatSpeedRows({ candidates, page, cacheDir, outDir: runsDir, run });

  const checklist = await buildChecklist({ project, report: report1, analysis, audit, recreateId, reauditId, origin: 'http://127.0.0.1:5000', output: null, outputPageList: [], motion: null, lighthousePages, isAsIs: false });
  const row = checklist.items.find((i) => i.key === 'lighthouse.render-blocking-resources');
  assert.equal(row.status, 'open', 'the median runs (330 ms and 360 ms) have the same grade: not got worse');
  assert.deepEqual(row.repeat.mobile.copy.runs.map((r) => r.ms), [910, 340, 360]);
  assert.equal(row.repeat.mobile.copy.median, 3);
  assert.equal(row.repeat.mobile.original.median, 1);
  assert.ok(row.repeat.mobile.copy.runs.every((r) => r.benchmark === 1200 && r.otherJobs === 0), 'each run keeps its CPU benchmark and the other jobs');
  assert.match(row.note, /measured 3 times on each side/);
  assert.deepEqual(checklist.speedRepeat.modes.mobile.chosen, { original: { 'render-blocking-resources': 1 }, copy: { 'render-blocking-resources': 3 } });
  assert.equal(checklist.summary.regressed ?? 0, 0);
});
