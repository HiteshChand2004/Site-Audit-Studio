// C5: what an as-is copy did about a check reaches the re-audit's rows (reaudit/compare/rules.js asIsEvidence), every EVIDENCE
// key is written once, a kept run of the original stands in for one made now only when it is fresh and was measured on a computer
// as fast (reaudit/lighthousePages.js staleOriginal), and every category under 90 names what fails and why (lighthouseTargets).
// No browser, no network: a stand-in Lighthouse runner, temp folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asIsEvidence, EVIDENCE, evidenceFor } from '../src/reaudit/compare/rules.js';
import { BENCHMARK_TOLERANCE, compareLighthousePages, COPY_ONLY, lighthousePagesNote, lighthouseTargets, ORIGINAL_MAX_AGE_MS, staleOriginal, TARGET_SCORE, trimReport, whyStillFailing } from '../src/reaudit/lighthousePages.js';

/** An as-is report as recreate/behavior/preserve/stage.js fixAndProve writes it (report.asIs.fixes). */
const asIsReport = () => ({
  asIs: {
    fixes: {
      counts: { alt: 3, lcp: 2, head: 1 },
      total: 6,
      pages: [
        { path: '/', fixes: [{ kind: 'alt' }, { kind: 'lcp' }, { kind: 'head', field: 'title' }] },
        // Its lazy loading was made but changed what a visitor sees at one width: dropped by the gate.
        { path: '/about/', fixes: [{ kind: 'alt' }, { kind: 'lcp' }], dropped: [{ group: 'lazy', reason: 'd', why: '375 px: 1200 pixels differ' }] },
        // A page that kept nothing: every fix it had is gone.
        { path: '/team/', fixes: [{ kind: 'webp' }, { kind: 'head', field: 'description' }], reverted: { reason: 'd' } },
      ],
      open: [{ kind: 'webp', page: '/', reason: 'b', detail: 'logo.png: lossless WebP not 10 % smaller' }, { kind: 'css', page: null, reason: 'd', detail: 'a.css is not minified' }],
      css: { files: [{ file: 'css/site.css', from: 9000, to: 6000, pages: ['/'] }], looks: [] },
    },
  },
});

test('every EVIDENCE key is written once in the source (a later duplicate silently replaced the earlier entry)', async () => {
  const src = await readFile(new URL('../src/reaudit/compare/rules.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('export const EVIDENCE = {'), src.indexOf('};', src.indexOf('export const EVIDENCE = {')));
  const keys = [...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
  const seen = new Set();
  const twice = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  assert.deepEqual(twice, []);
  assert.equal(keys.length, Object.keys(EVIDENCE).length);
  // The entries that were in effect are kept, and the replaced ones are merged into them.
  assert.deepEqual(EVIDENCE['axe.color-contrast'], { fixes: ['contrast'], auto: ['color'] });
  assert.deepEqual(EVIDENCE['lighthouse.modern-image-formats'].fixes, ['images', 'responsive-images']);
  assert.deepEqual(EVIDENCE['lighthouse.total-byte-weight'].fixes, ['images', 'responsive-images', 'page-css']);
});

test('an as-is copy: kept, dropped and open fixes of each kind reach the row of the check they answer', () => {
  const report = asIsReport();
  const alt = asIsEvidence('axe.image-alt', report);
  assert.deepEqual(alt, [{ fix: 'as-is:alt', asIs: 'alt', title: 'Image descriptions', status: 'fixed', count: 3, open: 0, droppedOnPages: 0 }]);
  const lazy = asIsEvidence('lighthouse.offscreen-images', report);
  assert.deepEqual(lazy, [{ fix: 'as-is:lazy', asIs: 'lazy', title: 'Images below the first screen load later', status: 'open', count: 0, open: 0, droppedOnPages: 1 }], 'dropped by the gate is said, not hidden');
  // WebP: none kept, the reverted page lost one, one left open with its reason.
  const webp = asIsEvidence('lighthouse.modern-image-formats', report).find((e) => e.asIs === 'webp');
  assert.deepEqual(webp, { fix: 'as-is:webp', asIs: 'webp', title: 'Lossless WebP for PNG images', status: 'open', count: 0, open: 1, droppedOnPages: 1 });
  // The title is text taken from the page: a kept fix asks for a review. Counted per field: the reverted page lost a description,
  // not a title, so the title row shows its one kept fix and nothing lost, and the description row shows the loss.
  assert.deepEqual(asIsEvidence('seo.title-tag', report), [{ fix: 'as-is:title', asIs: 'title', title: 'Page title', status: 'fixed', count: 1, open: 0, droppedOnPages: 0, review: true }]);
  assert.deepEqual(asIsEvidence('seo.meta-description', report), [{ fix: 'as-is:description', asIs: 'description', title: 'Page description', status: 'open', count: 0, open: 0, droppedOnPages: 1 }]);
  // CSS: the files minified, never a byte total built from a character count.
  const css = asIsEvidence('lighthouse.unminified-css', report);
  assert.deepEqual(css, [{ fix: 'as-is:css', asIs: 'css', title: 'Stylesheets without whitespace', status: 'partial', count: 1, open: 1, droppedOnPages: 0, files: ['css/site.css'] }]);
  // A kind that did nothing at all says nothing; a check no kind answers says nothing; a clean copy's report has no as-is part.
  assert.deepEqual(asIsEvidence('axe.heading-order', report), []);
  assert.deepEqual(asIsEvidence('seo.language', report), []);
  assert.deepEqual(asIsEvidence('axe.image-alt', { fixes: [{ id: 'img-alt' }] }), []);
});

test('an as-is fix is attached only to rows it can change: no head fix on the meta-tag row, aria-level only on heading order', () => {
  const report = { asIs: { fixes: { counts: { head: 2, headings: 4 }, pages: [{ path: '/', fixes: [{ kind: 'head', field: 'title' }, { kind: 'head', field: 'canonical' }] }], open: [] } } };
  // The head fixes write title, description, canonical and og:* — none of what the meta-tag row checks.
  assert.deepEqual(asIsEvidence('crawl.meta-tags', report), []);
  assert.equal(asIsEvidence('seo.canonical-url', report)[0].asIs, 'canonical');
  // aria-level changes no tag and adds no h1: the tag-counting rows and the h1 rule are not its rows.
  assert.equal(asIsEvidence('axe.heading-order', report)[0].count, 4);
  for (const k of ['axe.page-has-heading-one', 'seo.headings', 'seo.headings.none', 'seo.headings.many', 'aeo.heading-hierarchy']) {
    assert.deepEqual(asIsEvidence(k, report), [], k);
  }
});

test('each head row shows only its own field: the fixture copy of 2026-11-01 (description + og:description written, no address)', () => {
  const report = { asIs: { fixes: {
    counts: { alt: 1, headings: 2, head: 2, data: 3 }, total: 8,
    pages: [{ path: '/', fixes: [{ kind: 'alt' }, { kind: 'headings' }, { kind: 'headings' }, { kind: 'head', field: 'description' },
      { kind: 'head', field: 'og:description' }, { kind: 'data' }, { kind: 'data' }, { kind: 'data' }] }],
    open: [{ kind: 'address', page: null, reason: 'c', detail: 'No address was written into the copy: no address was given for the new site.' }],
  } } };
  // Before: the canonical, description and Open Graph rows all showed "Page title and description: fixed (2)", though no canonical
  // was written and only one of the two fixes was a description.
  assert.deepEqual(asIsEvidence('seo.canonical-url', report), [{ fix: 'as-is:canonical', asIs: 'canonical', title: 'Canonical address', status: 'open', count: 0, open: 1, droppedOnPages: 0 }]);
  assert.deepEqual(asIsEvidence('seo.meta-description.missing', report), [{ fix: 'as-is:description', asIs: 'description', title: 'Page description', status: 'fixed', count: 1, open: 0, droppedOnPages: 0, review: true }]);
  assert.deepEqual(asIsEvidence('seo.open-graph-tags', report), [{ fix: 'as-is:og', asIs: 'og', title: 'Open Graph tags', status: 'fixed', count: 1, open: 0, droppedOnPages: 0, review: true }]);
  assert.deepEqual(asIsEvidence('seo.title-tag', report), [], 'no title was written');
  // A canonical and og:url moved to the new site by the address kind count on their rows (an address, not page text: no review);
  // the gate dropping head:meta on a page is said there too.
  const moved = { asIs: { fixes: { pages: [
    { path: '/', fixes: [{ kind: 'address', field: 'canonical' }, { kind: 'address', field: 'og:url' }] },
    { path: '/about/', fixes: [], dropped: [{ group: 'head:meta', reason: 'd', why: '375 px: 300 pixels differ' }] },
  ], open: [] } } };
  assert.deepEqual(asIsEvidence('seo.canonical-url', moved), [{ fix: 'as-is:canonical', asIs: 'canonical', title: 'Canonical address', status: 'partial', count: 1, open: 0, droppedOnPages: 1 }]);
  assert.deepEqual(asIsEvidence('seo.open-graph-tags', moved), [{ fix: 'as-is:og', asIs: 'og', title: 'Open Graph tags', status: 'partial', count: 1, open: 0, droppedOnPages: 1 }]);
});

test('every as-is entry has the shape the Results page reads for a fix (FixReport.jsx Evidence: e.fix, e.title, e.count, e.open)', () => {
  const report = asIsReport();
  const keys = ['axe.image-alt', 'seo.title-tag', 'lighthouse.offscreen-images', 'lighthouse.modern-image-formats', 'lighthouse.unminified-css',
    'lighthouse.total-byte-weight', 'lighthouse.prioritize-lcp-image'];
  const entries = keys.flatMap((k) => evidenceFor(k, report)?.evidence ?? []);
  assert.ok(entries.length >= keys.length);
  for (const e of entries) {
    // The page draws an entry with `fix` as a fix; one without it is read as auto-generated values (e.fields.join): never that.
    assert.match(e.fix, /^as-is:[a-z]+$/, JSON.stringify(e));
    assert.equal(typeof e.title, 'string');
    assert.equal(typeof e.count, 'number');
    assert.equal(typeof e.open, 'number');
    assert.ok(['fixed', 'partial', 'open'].includes(e.status));
    assert.equal(e.fields, undefined);
  }
  // Within one row the page keys its list items by e.fix: no two entries of a row share it.
  for (const k of keys) {
    const ids = (evidenceFor(k, report)?.evidence ?? []).map((e) => e.fix);
    assert.equal(new Set(ids).size, ids.length, k);
  }
});

test('evidenceFor: a clean copy is unchanged; an as-is copy gets its own evidence and a review only for page text', () => {
  const clean = { fixes: [{ id: 'img-alt', title: 'Alt', status: 'partial', count: 3, open: 1 }], autoGenerated: [{ field: 'alt', value: 'Team photo', source: 'file name' }] };
  const ev = evidenceFor('seo.image-alt-text', clean);
  assert.equal(ev.evidence.length, 2);
  assert.equal(ev.evidence[0].fix, 'img-alt');
  assert.equal(ev.review, true);
  assert.equal(evidenceFor('seo.language', { fixes: [], autoGenerated: [] }), null);
  // As-is: a check EVIDENCE does not list (prioritize-lcp-image is listed; unminified-css is not) still gets the as-is entry.
  const asIs = asIsReport();
  assert.deepEqual(evidenceFor('lighthouse.unminified-css', asIs).evidence.map((e) => e.asIs), ['css']);
  const lcp = evidenceFor('lighthouse.prioritize-lcp-image', asIs);
  assert.deepEqual(lcp.evidence, [{ fix: 'as-is:lcp', asIs: 'lcp', title: 'Largest image loads first', status: 'fixed', count: 2, open: 0, droppedOnPages: 0 }]);
  assert.equal(lcp.review, false, 'a speed fix changes no text: nothing to review');
  assert.equal(evidenceFor('seo.title-tag.length', asIs).review, true);
});

test('staleOriginal: fresh and as fast is reused; old, a computer of another speed, or unknown is measured again', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const copy = { benchmarkIndex: 1000 };
  assert.equal(staleOriginal({ measuredAt: now - 3600000, benchmarkIndex: 1100 }, copy, now), null);
  assert.match(staleOriginal({ measuredAt: now - ORIGINAL_MAX_AGE_MS - 86400000, benchmarkIndex: 1000 }, copy, now), /8 days old/);
  const slower = staleOriginal({ measuredAt: now, benchmarkIndex: 1500 }, copy, now);
  assert.match(slower, /33 % slower than when it was kept \(benchmark 1500 then, 1000 now\)/);
  // The share is of the faster run: 1250 against 1000 is 20 % off (reused), 1400 against 1000 is 29 % off (measured again).
  assert.equal(staleOriginal({ measuredAt: now, benchmarkIndex: 1250 }, copy, now), null, 'within the tolerance: still reused');
  assert.match(staleOriginal({ measuredAt: now, benchmarkIndex: 1400 }, copy, now), /29 % slower/);
  assert.equal(BENCHMARK_TOLERANCE, 0.25);
  // An older kept run has no measuredAt: Lighthouse's fetchTime gives its age.
  assert.equal(staleOriginal({ fetchTime: '2026-10-31T12:00:00Z', benchmarkIndex: 1000 }, copy, now), null);
  assert.match(staleOriginal({ benchmarkIndex: 1000 }, copy, now), /age is not known/);
  assert.match(staleOriginal({ measuredAt: now, benchmarkIndex: null }, copy, now), /speed .* not known/);
  assert.match(staleOriginal({ measuredAt: now, benchmarkIndex: 1000 }, null, now), /speed .* not known/);
});

const lhr = (scores, { bench = 1000, failing = {} } = {}) => ({
  fetchTime: new Date().toISOString(), requestedUrl: 'x', finalDisplayedUrl: 'x', environment: { benchmarkIndex: bench },
  categories: Object.fromEntries(Object.entries(scores).map(([c, s]) => [c, { score: s / 100, auditRefs: (failing[c] ?? []).map(([id, weight]) => ({ id, weight })) }])),
  audits: {
    'dom-size': { score: 1, numericValue: 900 },
    ...Object.fromEntries(Object.values(failing).flat().map(([id]) => [id, { id, score: 0.2, title: `title of ${id}` }])),
  },
});
const ALL = (p, a = 95, b = 95, s = 95) => ({ performance: p, accessibility: a, 'best-practices': b, seo: s });

test('compareLighthousePages: a kept original measured on a slower computer, or too long ago, is measured again and said so', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-c5-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'cache');
  let bench = { original: 1000, copy: 1000 };
  const calls = [];
  const run = async (url, mode, outFile) => {
    const side = url.startsWith('http://127.0.0.1') ? 'copy' : 'original';
    calls.push(side);
    // The copy leads by 5 everywhere: one run per side decides, so each side is run once per mode.
    await writeFile(outFile, JSON.stringify(lhr(side === 'copy' ? ALL(80, 100, 100, 100) : ALL(70, 90, 90, 90), { bench: bench[side] })));
  };
  const pages = [{ path: '/', url: 'https://site.test/', copyUrl: 'http://127.0.0.1:1/' }];
  const first = await compareLighthousePages({ pages, cacheDir, outDir: path.join(root, 'o1'), run });
  assert.deepEqual(first.runs, { original: 2, copy: 2, reusedOriginal: 0 });
  assert.deepEqual(calls.slice(0, 2), ['copy', 'original'], 'the copy is measured first: it decides whether a kept original may stand in');
  // Same speed now: the kept runs stand in.
  calls.length = 0;
  const second = await compareLighthousePages({ pages, cacheDir, outDir: path.join(root, 'o2'), run });
  assert.deepEqual(second.runs, { original: 0, copy: 2, reusedOriginal: 2 });
  assert.deepEqual(second.refreshedOriginal, []);
  // This computer is now much slower than when the original was kept (copy benchmark 600 against 1000): measured again.
  bench = { original: 600, copy: 600 };
  const third = await compareLighthousePages({ pages, cacheDir, outDir: path.join(root, 'o3'), run });
  assert.deepEqual(third.runs, { original: 2, copy: 2, reusedOriginal: 0 });
  assert.equal(third.refreshedOriginal.length, 2);
  assert.match(third.refreshedOriginal[0].reason, /40 % slower/);
  assert.match(lighthousePagesNote(third), /2 kept runs of the original measured again \(\/ on phone: this computer measured 40 % slower/);
  // A kept run made too long ago: its file is aged by hand, and the next comparison measures it again.
  const kept = path.join(cacheDir, (await readdir(cacheDir)).find((f) => /-mobile-1\.json$/.test(f)));
  const old = JSON.parse(await readFile(kept, 'utf8'));
  await writeFile(kept, JSON.stringify({ ...old, measuredAt: Date.now() - ORIGINAL_MAX_AGE_MS - 1000 }));
  const fourth = await compareLighthousePages({ pages, cacheDir, outDir: path.join(root, 'o4'), run });
  assert.equal(fourth.runs.original, 1, 'only the aged run is measured again');
  assert.match(fourth.refreshedOriginal[0].reason, /days old/);
});

test('lighthouseTargets: every category says whether 90 was reached; under 90 it names what fails and why, scores untouched', () => {
  const failing = { performance: [['unused-javascript', 0], ['largest-contentful-paint', 25], ['some-new-audit', 0], ['legacy-javascript', 0]], accessibility: [['color-contrast', 7]] };
  const trimmed = trimReport(lhr(ALL(72, 88, 100, 100), { failing }));
  assert.deepEqual(trimmed.failingByCategory.performance.map((f) => f.id), ['unused-javascript', 'largest-contentful-paint', 'some-new-audit', 'legacy-javascript']);
  // On the original's run: unused-javascript, color-contrast and some-new-audit fail too; legacy-javascript fails on the copy only.
  const onOriginal = ['unused-javascript', 'color-contrast', 'some-new-audit'];
  const comparison = { pages: [{ path: '/', modes: {
    mobile: { original: ALL(60, 80, 100, 100), copy: ALL(72, 88, 100, 100), detail: { copyAudits: trimmed.audits, copyFailingByCategory: trimmed.failingByCategory, failing: { original: onOriginal, copy: Object.keys(trimmed.audits) } } },
    desktop: { original: { ...ALL(90), seo: null }, copy: { ...ALL(95), seo: null }, detail: { copyAudits: {}, copyFailingByCategory: null } },
    broken: { error: 'Lighthouse wrote no report' },
  } }] };
  const rows = lighthouseTargets(comparison);
  assert.equal(rows.length, 8, 'two modes x four categories; a mode that failed has no rows');
  const perf = rows.find((r) => r.mode === 'mobile' && r.category === 'performance');
  assert.deepEqual([perf.original, perf.copy, perf.reached], [60, 72, false], 'the measured numbers, as measured');
  assert.deepEqual(perf.failing.map((f) => f.id), ['largest-contentful-paint', 'unused-javascript', 'some-new-audit', 'legacy-javascript'], 'heaviest first');
  assert.equal(perf.failing[0].why, "a load timing: follows the page's own files and scripts");
  assert.equal(perf.failing[1].why, "the original's own JavaScript: kept as it is, by choice", 'fails on the original too');
  assert.equal(perf.failing[2].why, 'fails on the original too: not changed by the copy', 'an audit with no known reason claims none');
  assert.equal(perf.failing[3].why, COPY_ONLY, 'a script audit failing on the copy alone is not called the original\'s');
  assert.equal(rows.find((r) => r.mode === 'mobile' && r.category === 'accessibility').failing[0].why, "the original's colours: kept, by choice");
  assert.equal(rows.find((r) => r.mode === 'mobile' && r.category === 'seo').reached, true);
  const seo = rows.find((r) => r.mode === 'desktop' && r.category === 'seo');
  assert.deepEqual([seo.reached, seo.note], [null, 'not scored'], 'a category not scored is neither reached nor missed');
  assert.equal(rows.find((r) => r.mode === 'desktop' && r.category === 'performance').reached, true);
  assert.equal(TARGET_SCORE, 90);
  assert.equal(whyStillFailing('render-blocking-resources', true), "the original's scripts and stylesheets load where the original loads them: kept, by choice");
  for (const id of ['render-blocking-resources', 'color-contrast', 'unused-javascript', 'some-new-audit']) assert.equal(whyStillFailing(id, false), COPY_ONLY, id);
});
