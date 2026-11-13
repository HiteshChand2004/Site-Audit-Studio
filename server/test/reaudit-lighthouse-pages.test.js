// Lighthouse on every page of an as-is copy against the original's (reaudit/lighthousePages.js), with a stand-in runner: the
// measuring rule (one run per side when the copy leads by 5 in every category, else three per side and medians), the reuse of the
// original's runs across re-audits, the rows it adds to the checklist, and that a run that fails is listed, never fatal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { betterThanOriginal, compareLighthousePages, decide, probeOwnFiles, lighthousePageItems, lighthousePagesNote, medianScores, pageSlug, runsOverlap, singleRunDecides, trimReport } from '../src/reaudit/lighthousePages.js';

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

test('the rule: one run decides unless the copy\'s speed is lower; medians over three runs decide otherwise', () => {
  assert.ok(singleRunDecides({ scores: ALL(70, 90, 90, 90) }, { scores: ALL(75, 95, 95, 95) }));
  assert.ok(singleRunDecides({ scores: ALL(70) }, { scores: ALL(70) }), 'the same speed: one run is enough');
  assert.ok(singleRunDecides({ scores: ALL(70, 90, 90, 90) }, { scores: ALL(70, 90, 90, 90) }), 'an as-is copy scoring like the original (SEO 90 = 90) needs no repeat');
  assert.ok(singleRunDecides({ scores: ALL(70, 90, 90, 90) }, { scores: ALL(72, 85, 90, 90) }), 'a lower code score (accessibility) is decided by one run: another run reads the same code');
  assert.ok(!singleRunDecides({ scores: ALL(70, 90, 90, 90) }, { scores: ALL(69, 99, 99, 99) }), 'speed 1 lower: the medians of three decide');
  assert.ok(!singleRunDecides({ scores: { ...ALL(70, 90, 90, 90), seo: null } }, { scores: ALL(75, 95, 95, 95) }), 'a category a run could not score decides nothing: extra runs');
  assert.deepEqual(decide([{ scores: ALL(70, 90, 90, 90) }], [{ scores: ALL(72, 85, 90, 90) }]).worse, ['accessibility'], 'one run, a lower code score: got worse, never noise');
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

test('compareLighthousePages: one run per side unless the copy is slower, three when it is, rows per page x mode x category, the original reused next time', { timeout: 60000 }, async (t) => {
  const { cacheDir, outDir } = await dirs(t);
  const plan = () => ({
    original: {
      '/': { mobile: [report(ALL(60, 90, 90, 90))], desktop: [report(ALL(80, 90, 90, 90))] },
      '/about/': { mobile: [report(ALL(70, 90, 90, 90)), report(ALL(72, 90, 90, 90)), report(ALL(71, 90, 90, 90))], desktop: [report(ALL(90, 90, 90, 90))] },
    },
    copy: {
      // Homepage: faster on the phone and on the computer (85 vs 80; accessibility 90 = 90 no longer asks for more runs): one run each.
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
  assert.equal(r.pages[0].modes.desktop.accepted, 'single run', 'speed 85 vs 80 and the code scores equal: one run decides');
  assert.deepEqual(r.pages[0].modes.desktop.runs, { original: 1, copy: 1 });
  assert.deepEqual(r.pages[0].modes.desktop.worse, []);
  assert.deepEqual(r.pages[1].modes.mobile.original, ALL(71, 90, 90, 90));
  assert.deepEqual(r.pages[1].modes.mobile.copy, ALL(70, 95, 95, 85));
  assert.deepEqual(r.pages[1].modes.mobile.worse, ['seo'], 'SEO 85 vs 90, no spread on either side');
  assert.deepEqual(r.pages[1].modes.mobile.noise, ['performance'], 'performance 70 vs 71, the copy\'s runs 69-80');
  assert.deepEqual(r.pages[1].modes.desktop.worse, []);
  assert.deepEqual(r.worse.map((w) => `${w.path} ${w.mode} ${w.category} ${w.original}>${w.copy}`), ['/about/ mobile seo 90>85']);
  assert.deepEqual(r.extraRunPages, [{ path: '/about/', modes: ['mobile'] }], 'only the page whose copy was slower on its first run');
  // Runs: / mobile 1+1, / desktop 1+1, /about mobile 3+3, /about desktop 1+1 = 6 per side (8 under the old "lead by 5" rule).
  assert.deepEqual(r.runs, { original: 6, copy: 6, reusedOriginal: 0 });
  assert.equal(calls.length, 12);
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
  assert.match(note, /1 page needed three runs per side \(\/about\/ on phone\)/);

  // A second comparison (another re-audit of the same project): the original's runs come from the cache, only the copy is run.
  const again = fakeRunner(plan());
  const r2 = await compareLighthousePages({ pages, cacheDir, outDir: `${outDir}-2`, run: again.run });
  assert.deepEqual(r2.runs, { original: 0, copy: 6, reusedOriginal: 6 });
  assert.ok(again.calls.every((c) => c.side === 'copy'));
  assert.match(lighthousePagesNote(r2), /6 runs of the original reused/);
  assert.equal((await readdir(cacheDir)).filter((f) => !f.endsWith('.full.json')).length, 6, 'one trimmed file per run of the original');
});

test('an original with lifted files is measured from them (its own address and cache), the rest live, and the note says which', { timeout: 30000 }, async (t) => {
  const { cacheDir, outDir } = await dirs(t);
  const liftedCache = path.join(path.dirname(cacheDir), 'lifted-runs');
  const asked = [];
  const run = async (url, mode, outFile) => {
    asked.push(url);
    await writeFile(outFile, JSON.stringify(report(ALL(90))));
  };
  const pages = [
    { path: '/', url: 'https://site.test/', copyUrl: 'http://127.0.0.1:5000/', originalUrl: 'http://127.0.0.1:6000/', originalFrom: 'lifted', originalCacheDir: liftedCache },
    { path: '/live/', url: 'https://site.test/live/', copyUrl: 'http://127.0.0.1:5000/live/' },
  ];
  const r = await compareLighthousePages({ pages, cacheDir, outDir, run });
  assert.deepEqual(r.pages.map((p) => p.originalFrom), ['lifted', 'live']);
  assert.ok(asked.includes('http://127.0.0.1:6000/'), 'the lifted original is loaded from its own address');
  assert.ok(!asked.includes('https://site.test/'), 'never from the live site when lifted files exist');
  assert.ok(asked.includes('https://site.test/live/'), 'a page without lifted files is measured live');
  assert.equal((await readdir(liftedCache)).filter((f) => !f.endsWith('.full.json')).length, 2, 'the lifted runs are kept apart (one per mode)');
  assert.equal((await readdir(cacheDir)).filter((f) => !f.endsWith('.full.json')).length, 2, 'the live runs stay in the project cache');
  assert.equal(r.pages[0].slug, pageSlug('/', 'https://site.test/'), 'the page keeps its identity (the original address)');
  assert.match(lighthousePagesNote(r), /measured from its own files as captured, through the same host as the copy, on 1 of 2 pages/);
  const all = await compareLighthousePages({ pages: [pages[0]], cacheDir, outDir: `${outDir}-2`, run });
  assert.match(lighthousePagesNote(all), /so both sides had the same network/);
});

test('a run whose own scripts or styles did not load is not scored on that side, and the copy gets a row naming the files', () => {
  const withRequests = (scores, url, requests) => ({ ...report(scores), finalDisplayedUrl: url, audits: { ...report(scores).audits, 'network-requests': { details: { items: requests } } } });
  const ok = (u, type = 'Script') => ({ url: u, resourceType: type, statusCode: 200, mimeType: type === 'Script' ? 'text/javascript' : 'text/css' });
  const copyLhr = withRequests(ALL(100, 100, 100, 100), 'http://127.0.0.1:5000/', [
    { url: 'http://127.0.0.1:5000/_next/static/chunks/a.css', resourceType: 'Stylesheet', statusCode: 404, mimeType: 'text/plain' },
    { url: 'http://127.0.0.1:5000/assets/index.js', resourceType: 'Script', statusCode: 200, mimeType: 'text/html' },
    { url: 'http://127.0.0.1:5000/img/hero.webp', resourceType: 'Image', statusCode: -1, finished: true },
    { url: 'http://127.0.0.1:5000/media/intro.mp4', resourceType: 'Media', statusCode: -1, finished: false },
    { url: 'http://127.0.0.1:5000/api/blogs', resourceType: 'Fetch', statusCode: 404 },
    { url: 'https://cdn.other.test/x.js', resourceType: 'Script', statusCode: 404 },
    ok('http://127.0.0.1:5000/ok.js'),
  ]);
  const f = trimReport(copyLhr).ownFailures;
  assert.equal(f.count, 3, 'the 404 stylesheet, the script answered with HTML, the image with no answer — not the data request, another host, or a video still downloading when the run ended');
  assert.equal(f.critical, 2);
  assert.deepEqual(f.byType, { Stylesheet: 1, Script: 1, Image: 1 });
  assert.ok(f.sample.includes('/assets/index.js (an HTML page instead of the file)'));
  assert.ok(f.sample.includes('/img/hero.webp (no answer)'));

  const original = { ...trimReport(withRequests(ALL(68, 95, 100, 100), 'https://site.test/', [ok('https://site.test/a.css', 'Stylesheet')])) };
  const copy = trimReport(copyLhr);
  assert.ok(!singleRunDecides(original, copy), 'a copy missing its own scripts asks for the extra runs, however high it scored');
  const v = decide([original, original, original], [copy, copy, copy]);
  assert.deepEqual(v.worse, [], 'an unstyled page scoring 100 is not "better" or "worse": it is not the copy');
  assert.match(v.unscored.performance.copy.errors[0], /2 of the copy's own script and style files did not load/);
  assert.equal(v.copy.performance, null);
  assert.equal(v.copyMissing.count, 3);
  assert.equal(v.copyMissing.original, 0);
  assert.equal(v.brokenRuns.copy, 3);

  const items = lighthousePageItems({ pages: [{ path: '/', modes: { mobile: { ...v, runScores: { original: [], copy: [] }, detail: {} } } }] });
  const row = items.find((i) => i.key === 'lighthouse-files./');
  assert.equal(row.status, 'regressed', 'the original loaded its own files: the copy got worse');
  assert.match(row.after.detail, /3 files \(1 stylesheet, 1 script, 1 image\) did not load in 3 of 3 runs \(phone\)/);
  assert.ok(items.some((i) => i.status === 'recheck' && /could not be scored/.test(i.title)), 'its scores are measured again, not judged');

  // A file the original misses as well is the site's own problem, kept: open, not "got worse".
  const both = decide([copy], [copy]);
  const kept = lighthousePageItems({ pages: [{ path: '/', modes: { mobile: { ...both, runScores: { original: [], copy: [] }, detail: {} } } }] }).find((i) => i.key === 'lighthouse-files./');
  assert.equal(kept.status, 'open');
});

test('a run that never painted (no request list) has its own scripts and styles checked directly, and the copy gets its row', { timeout: 30000 }, async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url === '/yatra/destinations/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><link rel="stylesheet" href="/yatra/assets/index-B2y0GRyK.css"><script type="module" src="/yatra/assets/index-DdEuaEXJ.js"></script><script src="/ok.js"></script><script src="/saved-as.js"></script><script src="https://cdn.other.test/x.js"></script>');
    if (req.url === '/yatra/assets/index-DdEuaEXJ.js') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!DOCTYPE html><html></html>');
    if (req.url === '/ok.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end('1');
    // An HTML page saved under a script's name: the host sends it as JavaScript, by its name.
    if (req.url === '/saved-as.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end('\n<!DOCTYPE html><html lang="en"></html>');
    res.writeHead(404, { 'content-type': 'text/plain' }).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const probed = await probeOwnFiles(`${origin}/yatra/destinations/`);
  assert.equal(probed.critical, 3, 'the bundle answered with HTML, the HTML page sent as JavaScript, the missing stylesheet; not the working script or another host');
  assert.ok(probed.sample.includes('/saved-as.js (an HTML page instead of the file)'), 'found by its first bytes');
  assert.ok(probed.sample.includes('/yatra/assets/index-DdEuaEXJ.js (an HTML page instead of the file)'));
  assert.ok(probed.sample.includes('/yatra/assets/index-B2y0GRyK.css (404)'));
  assert.equal(await probeOwnFiles('https://site.test/'), null, 'the live site is never asked');

  // Through the comparison: Lighthouse gives a blank run (NO_FCP: no scores, no request list) on both sides.
  const { cacheDir, outDir } = await dirs(t);
  const noPaint = { ...report({ performance: null, accessibility: null, 'best-practices': null, seo: null }), runtimeError: { code: 'NO_FCP' } };
  const run = async (url, mode, outFile) => writeFile(outFile, JSON.stringify(noPaint));
  const pages = [{ path: '/yatra/destinations/', url: 'https://site.test/yatra/destinations', copyUrl: `${origin}/yatra/destinations/` }];
  const r = await compareLighthousePages({ pages, cacheDir, outDir, run });
  const m = r.pages[0].modes.mobile;
  assert.equal(m.copyMissing.critical, 3);
  const row = lighthousePageItems(r).find((i) => i.key === 'lighthouse-files./yatra/destinations/');
  assert.equal(row.status, 'regressed', 'the original (live, not probed) is not known to miss them: the copy got worse');
  assert.match(row.after.detail, /an HTML page instead of the file/);
});

test('an original that drew next to nothing is not compared: the working copy is not "worse", and the row says what happened', () => {
  // sankalpam.ai /pratishthan/ live: 24 elements (a blank screen and a chat bar) scoring 96; the copy shows the store at 55.
  const blankOriginal = trimReport(report(ALL(96, 92, 96, 82), { dom: 24 }));
  const copy = trimReport(report(ALL(55, 84, 100, 82), { dom: 900 }));
  const v = decide([blankOriginal, blankOriginal, blankOriginal], [copy, copy, copy]);
  assert.deepEqual(v.worse, [], 'not "got worse" for showing the page');
  assert.equal(v.original.performance, null);
  assert.match(v.unscored.performance.original.errors[0], /the original rendered 24 elements against the copy's 900: the original page did not show/);
  assert.deepEqual(v.originalBlank, { runs: 3, of: 3, elements: 24, copyElements: 900 });

  const rows = (originalFrom) => lighthousePageItems({ pages: [{ path: '/pratishthan/', originalFrom, modes: { mobile: { ...v, runScores: { original: [], copy: [] }, detail: {} } } }] });
  const live = rows('live').find((i) => i.key === 'lighthouse-original-blank./pratishthan/');
  assert.equal(live.status, 'improved');
  assert.match(live.title, /The original page did not show on \/pratishthan\/; the copy does/);
  assert.equal(rows('live').filter((i) => i.status === 'regressed').length, 0);
  assert.equal(rows('lifted').find((i) => i.key === 'lighthouse-original-blank./pratishthan/').status, 'recheck', 'from the captured files it may be the capture\'s fault: measured again, not claimed');

  // A small page on both sides is not "blank": nothing changes.
  const small = decide([trimReport(report(ALL(96), { dom: 40 }))], [trimReport(report(ALL(90), { dom: 45 }))]);
  assert.equal(small.originalBlank, null);
  assert.deepEqual(small.worse, ['performance']);
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
