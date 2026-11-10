// Step 5b: "is the problem gone?" from the markup (copy/fixGone.js) and the rollback of a fix that had no effect
// (preserve/stage.js fixAndProve, reason noEffect), and how the re-check words such a row (copy/gotWorse.js: our bug).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { extractPage } from '../src/audit/extract.js';
import { UNATTRIBUTED, checkGone, judgePage, markupTargets, readings } from '../src/copy/fixGone.js';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';
import { explainWorse } from '../src/copy/gotWorse.js';

const URL_HOME = 'https://example-original.test/';
const doc = (head, body = '<h1>Page</h1><p>Some words on the page.</p>') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${head}</head><body>${body}</body></html>`;
const page = (html, url = URL_HOME) => ({ url, facts: extractPage(html, url) });
const judge = (beforeHtml, afterHtml, fixes) => {
  const b = page(beforeHtml);
  const a = page(afterHtml);
  return judgePage({ before: readings([b]), after: readings([a]), siteBefore: readings([b]), siteAfter: readings([a]), fixes });
};
const LONG = 'A title that is far too long for any search result to show it whole, really';

test('markup targets: a head field by its own checks, a meta tag by its name, axe and Lighthouse targets are not read here', () => {
  assert.deepEqual(markupTargets({ kind: 'head', field: 'title' }), ['seo.title-tag', 'seo.title-tag.missing', 'seo.title-tag.length', 'seo.title-tag.duplicate']);
  assert.deepEqual(markupTargets({ kind: 'head', field: 'theme-color' }), ['crawl.meta-tags#theme-color']);
  assert.deepEqual(markupTargets({ kind: 'head', field: 'icon' }), ['crawl.meta-tags#favicon']);
  assert.deepEqual(markupTargets({ kind: 'alt' }), ['seo.image-alt-text']);
  assert.deepEqual(markupTargets({ kind: 'prohibited' }), [], 'an axe rule: the next step');
  assert.deepEqual(markupTargets({ kind: 'lcp' }), [], 'a Lighthouse audit: the re-check');
});

test('gone, improved, still and unjudged, on positive evidence only', () => {
  const titleFix = [{ kind: 'head', field: 'title' }];
  assert.equal(judge(doc(`<title>${LONG}</title>`), doc('<title>A title that fits | Site</title>'), titleFix)['head:title'].result, 'gone');
  const still = judge(doc(`<title>${LONG}</title>`), doc(`<title>${LONG}!</title>`), titleFix)['head:title'];
  assert.equal(still.result, 'still');
  assert.match(still.why, /seo\.title-tag\.length warn, 1 → seo\.title-tag\.length warn, 1/);
  // og:title + og:description added, no og:image: better, not gone.
  const og = judge(doc('<title>A fine title here</title>'), doc('<title>A fine title here</title><meta property="og:title" content="x"><meta property="og:description" content="y">'), [{ kind: 'head', field: 'og:title' }, { kind: 'head', field: 'og:description' }]);
  assert.equal(og['head:meta'].result, 'improved');
  // A theme colour that was there already is no evidence either way.
  const meta = judge(doc('<title>A fine title here</title><meta name="theme-color" content="#c2410c">'), doc('<title>A fine title here</title><meta name="theme-color" content="#c2410c">'), [{ kind: 'head', field: 'theme-color' }]);
  assert.equal(meta['head:meta'].result, 'unjudged');
  assert.equal(judge(doc('<title>A fine title here</title>'), doc('<title>A fine title here</title>'), [{ kind: 'prohibited' }]).prohibited.result, 'unjudged', 'axe only: not judged here');
});

test('two groups on one page, only one makes a check worse: the page built without each says which, and only that one is "worse"', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-gone-worse-'));
  try {
    await mkdir(path.join(dir, 'lifted'));
    await mkdir(path.join(dir, 'fixed'));
    const desc = '<meta name="description" content="A description of this page long enough to pass the check of fifty.">';
    const img = (alt) => `<h1>Page</h1><p>Some words on the page.</p><img src="a.png"${alt ? ' alt="A chart"' : ''}>`;
    // As lifted: a description, an image with no alt. As fixed: the alt is written (alt) and the description is lost (head:description).
    const html = (groups) => doc(`<title>A fine title here</title>${groups.includes('head:description') ? '' : desc}`, img(groups.includes('alt')));
    await writeFile(path.join(dir, 'lifted', 'index.html'), html([]), 'utf8');
    await writeFile(path.join(dir, 'fixed', 'index.html'), html(['alt', 'head:description']), 'utf8');
    const pages = [{ outPath: 'index.html', url: URL_HOME }];
    const fixes = [{ kind: 'alt' }, { kind: 'head', field: 'description' }];
    const built = [];
    const rebuild = async (_p, groups) => {
      built.push(groups.join(','));
      return html(groups);
    };
    const r = (await checkGone({ copyDir: path.join(dir, 'fixed'), gateDir: path.join(dir, 'lifted'), pages, fixed: [{ outPath: 'index.html', fixes }], rebuild })).get('index.html');
    assert.equal(r['head:description'].result, 'worse', JSON.stringify(r));
    assert.match(r['head:description'].why, /seo\.meta-description/);
    assert.equal(r.alt.result, 'gone', 'the alt fix did its job and made nothing worse');
    assert.equal(r[UNATTRIBUTED], undefined);
    assert.deepEqual(built.sort(), ['alt', 'head:description'], 'one build without each group, in memory');

    // Without a way to build the page without each group, nothing is blamed: "not judged", with the reason, and nothing undone.
    const n = (await checkGone({ copyDir: path.join(dir, 'fixed'), gateDir: path.join(dir, 'lifted'), pages, fixed: [{ outPath: 'index.html', fixes }] })).get('index.html');
    assert.notEqual(n['head:description'].result, 'worse');
    assert.equal(n[UNATTRIBUTED].result, 'unjudged');
    assert.match(n[UNATTRIBUTED].why, /no single group of fixes explains it.*nothing was undone/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('duplicates are read across the site, with the page as fixed and as lifted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-gone-'));
  try {
    await mkdir(path.join(dir, 'lifted', 'about'), { recursive: true });
    await mkdir(path.join(dir, 'fixed', 'about'), { recursive: true });
    const same = '<title>Same title for both</title>';
    for (const side of ['lifted', 'fixed']) await writeFile(path.join(dir, side, 'index.html'), doc(same), 'utf8');
    await writeFile(path.join(dir, 'lifted', 'about', 'index.html'), doc(same), 'utf8');
    await writeFile(path.join(dir, 'fixed', 'about', 'index.html'), doc('<title>About | Same title</title>'), 'utf8');
    const pages = [{ outPath: 'index.html', url: URL_HOME }, { outPath: 'about/index.html', url: `${URL_HOME}about/` }];
    const r = await checkGone({ copyDir: path.join(dir, 'fixed'), gateDir: path.join(dir, 'lifted'), pages, fixed: [{ outPath: 'about/index.html', fixes: [{ kind: 'head', field: 'title' }] }] });
    assert.equal(r.get('about/index.html')['head:title'].result, 'gone');
    assert.equal(r.has('index.html'), false, 'a page with no fix is not judged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the re-check: a fix undone for having no effect is our bug, with what was still there', () => {
  const row = { key: 'seo.title-tag.length', status: 'open', category: 'seo', title: 'Title tag', before: { status: 'warn', detail: '1 title' }, after: { status: 'warn', detail: '1 title' } };
  const ctx = { siteUrl: URL_HOME, copyOrigin: 'http://127.0.0.1:5101', copyPages: ['/'] };
  const fixOpen = [{ kind: 'head', field: 'title', group: 'head:title', page: '/', reason: 'noEffect', detail: 'the problem was still there after the fix' }];
  const r = explainWorse({ ...ctx, items: [row], fixOpen }).open[0];
  assert.equal(r.group, 'bug', JSON.stringify(r));
  assert.match(r.evidence, /did not remove the problem.*undone.*a bug to report/);
  // A noEffect of another field says nothing about this row.
  const other = explainWorse({ ...ctx, items: [row], fixOpen: [{ ...fixOpen[0], field: 'description', group: 'head:description' }] }).open[0];
  assert.doesNotMatch(other.evidence, /did not remove the problem/);
});

test('in a real browser: a group the look gate keeps but whose problem is still there is undone (noEffect); the others stay', { timeout: 5 * 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-gone-stage-'));
  const browser = await chromium.launch();
  try {
    await writeFile(path.join(dir, 'index.html'), doc(`<title>${LONG}</title><meta name="description" content="Short.">`,
      '<h1>Gone check</h1><p>A paragraph of the page that is long enough to complete a short description with the words it has.</p>'), 'utf8');
    const pages = [{ path: '/', outPath: 'index.html', url: URL_HOME }];
    // The real check, except that it is told the description fix changed nothing (a stand-in for a fix that has no effect).
    const gone = async (o) => {
      const real = await checkGone(o);
      for (const v of real.values()) if (v['head:description']) v['head:description'] = { result: 'still', keys: ['seo.meta-description.length'], why: 'the problem was still there after the fix: seo.meta-description.length warn, 1 → seo.meta-description.length warn, 1' };
      return real;
    };
    const r = await fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages, siteUrl: URL_HOME, newSiteUrl: null, speed: false, gone });
    const p = r.pages[0];
    assert.equal(p.reverted, undefined, JSON.stringify(p));
    assert.deepEqual(p.dropped.map((d) => [d.group, d.reason]), [['head:description', 'noEffect']]);
    assert.ok(!p.fixes.some((f) => f.field === 'description'), 'the description fix is gone from the kept fixes');
    assert.ok(p.fixes.some((f) => f.field === 'title'), 'the title fix stays');
    const out = await readFile(path.join(dir, 'index.html'), 'utf8');
    assert.match(out, /<meta name="description" content="Short.">/, 'the description is back as lifted');
    assert.doesNotMatch(out, new RegExp(`<title>${LONG}</title>`), 'the title is still fixed');
    assert.ok(r.open.some((o) => o.reason === 'noEffect' && o.field === 'description' && o.page === '/'), JSON.stringify(r.open));
    assert.equal(r.noEffect, 1);
    assert.ok(r.gone.some((g) => g.path === '/' && g.group === 'head:title' && g.result === 'gone'), JSON.stringify(r.gone));
    // Without the stand-in, the real check finds every fix of this page effective: nothing undone.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), doc(`<title>${LONG}</title><meta name="description" content="Short.">`,
      '<h1>Gone check</h1><p>A paragraph of the page that is long enough to complete a short description with the words it has.</p>'), 'utf8');
    const real = await fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages, siteUrl: URL_HOME, newSiteUrl: null, speed: false });
    assert.equal(real.noEffect, 0, JSON.stringify(real.gone));
    assert.deepEqual(real.pages[0].dropped ?? [], []);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}-unfixed`, { recursive: true, force: true });
  }
});
