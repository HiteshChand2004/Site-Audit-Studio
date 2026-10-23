// Lighthouse on every page of an as-is copy against the original's (reaudit/lighthousePages.js), with a stand-in runner: the
// measuring rule (one run per side when the copy leads by 5 in every category, else three per side and medians), the reuse of the
// original's runs across re-audits, the rows it adds to the checklist, and that a run that fails is listed, never fatal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareLighthousePages, decide, lighthousePageItems, lighthousePagesNote, LEAD, medianScores, pageSlug, singleRunDecides, trimReport } from '../src/reaudit/lighthousePages.js';

const report = (scores, { weight = 400000, lcp = 'img.hero', failing = {} } = {}) => ({
  fetchTime: '2026-10-23T10:00:00Z', requestedUrl: 'x', finalDisplayedUrl: 'x', environment: { benchmarkIndex: 1200 },
  categories: Object.fromEntries(Object.entries(scores).map(([c, s]) => [c, { score: s == null ? null : s / 100 }])),
  audits: {
    'total-byte-weight': { score: 1, numericValue: weight },
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
  assert.ok(singleRunDecides({ scores: { ...ALL(70, 90, 90, 90), seo: null } }, { scores: ALL(75, 95, 95, 95) }), 'a category one side lacks cannot block');
  assert.equal(LEAD, 5);
  assert.deepEqual(medianScores([{ scores: ALL(70) }, { scores: ALL(90) }, { scores: ALL(80) }]).performance, 80);
  assert.deepEqual(medianScores([{ scores: ALL(70) }, { scores: ALL(90) }]).performance, 80, 'an even count: the mean of the middle two');
  const v = decide([{ scores: ALL(70) }, { scores: ALL(72) }, { scores: ALL(71) }], [{ scores: ALL(69) }, { scores: ALL(80) }, { scores: ALL(70) }]);
  assert.deepEqual(v.worse, ['performance'], 'copy median 70 < original median 71');
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
  assert.deepEqual(r.pages[1].modes.mobile.worse, ['performance', 'seo']);
  assert.deepEqual(r.pages[1].modes.desktop.worse, []);
  assert.deepEqual(r.worse.map((w) => `${w.path} ${w.mode} ${w.category} ${w.original}>${w.copy}`), ['/about/ mobile performance 71>70', '/about/ mobile seo 90>85']);
  assert.deepEqual(r.extraRunPages, [{ path: '/', modes: ['desktop'] }, { path: '/about/', modes: ['mobile'] }]);
  // Runs: / mobile 1+1, / desktop 3+3, /about mobile 3+3, /about desktop 1+1 = 8 per side.
  assert.deepEqual(r.runs, { original: 8, copy: 8, reusedOriginal: 0 });
  assert.equal(calls.length, 16);
  assert.ok(messages.some((m) => /run 2 of 3 on both sides/.test(m)));

  const items = lighthousePageItems(r);
  const worse = items.filter((i) => i.status === 'regressed');
  assert.deepEqual(worse.map((i) => i.key), ['lighthouse-score.mobile.performance./about/', 'lighthouse-score.mobile.seo./about/']);
  assert.equal(worse[0].category, 'performance');
  assert.equal(worse[1].category, 'seo');
  assert.match(worse[0].after.detail, /70 on the copy — median of runs \(3 of the original, 3 of the copy\)/);
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
