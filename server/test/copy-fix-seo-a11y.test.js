// The SEO and accessibility fixes of an as-is copy added in C2 (copy/seoA11yAsIs.js, wired in copy/fixAsIs.js), judged by the
// audits that score them: Lighthouse 12.8's own crawlable-anchors and link-text audit code, called with the links of the fixed
// page as a browser reads them, and axe-core's own heading-order and html-lang-valid rules, run in the page. Then the proof
// that they change nothing a visitor sees or does (preserve/stage.js fixAndProve): every fix is kept at 375 and 1440 px on a
// page where it is invisible; a role="button" the page's CSS restyles, or its script reacts to on a click, is dropped on its
// own (reason d) while the other fixes stay. Links with no href are only reported, never changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import CrawlableAnchors from 'lighthouse/core/audits/seo/crawlable-anchors.js';
import LinkText from 'lighthouse/core/audits/seo/link-text.js';
import { fixAsIsCopy } from '../src/copy/fixAsIs.js';
import { blocksZoom, isValidLang, MAX_ANCHORS, titleWithoutSite } from '../src/copy/seoA11yAsIs.js';
import { factsDiffer } from '../src/copy/served.js';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

const SITE = 'https://www.example-original.dev/';
const ENGLISH = 'This page is about the work we do for our customers and the people who use what we make every day. '
  + 'We write about it here so that you can find out what it is, how it works and why it matters to the people who need it.';
const axeSource = await readFile(createRequire(createRequire(import.meta.url).resolve('@axe-core/playwright')).resolve('axe-core/axe.min.js'), 'utf8');

/** A page that states everything the head and data fixes would add, so a test decides which C2 fixes it has. */
const page = ({ title, lang = 'en', css = '', body, viewport = 'width=device-width', extraHead = '' }) => `<!doctype html><html${lang == null ? '' : ` lang="${lang}"`}><head><meta charset="utf-8">
${viewport == null ? '' : `<meta name="viewport" content="${viewport}">`}<title>${title}</title>
<meta name="description" content="A page made to test the SEO and accessibility fixes of a copy, written for this test only: ${title}.">
<meta property="og:title" content="${title}"><meta property="og:description" content="A page made to test the SEO and accessibility fixes: ${title}.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":["Organization","WebSite"],"name":"Gate"}</script>${extraHead}
<style>body{margin:0;font:18px sans-serif;background:#fff}${css}</style></head><body>${body}</body></html>`;
const PRICING = page({ title: 'Pricing | Gate', body: `<h1>Pricing</h1><p>${ENGLISH}</p>` });

async function siteOf(t, pages) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-seoa11y-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-unfixed`, { recursive: true, force: true }); });
  for (const [file, html] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), html);
  }
  return dir;
}
const PAGES = [{ path: '/', outPath: 'index.html', url: SITE }, { path: '/pricing/', outPath: 'pricing/index.html', url: `${SITE}pricing/` }];
const fixOf = (r, kind, outPath = 'index.html') => r.pages.find((p) => p.outPath === outPath).fixes.filter((f) => f.kind === kind);

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

/** The links of a page as Lighthouse's AnchorElements gatherer reads them (innerText, attributes, resolved href); no listeners. */
async function anchorsOf(p) {
  const node = { lhId: 'x', devtoolsNodePath: '', selector: 'a', boundingRect: {}, snippet: '<a>', nodeLabel: 'a' };
  const raw = await p.evaluate(() => [...document.querySelectorAll('a')].map((a) => ({
    rawHref: a.getAttribute('href') || '', name: a.name, role: a.getAttribute('role') || '', id: a.id, href: a.href,
    attributeNames: a.getAttributeNames(), text: a.innerText, rel: a.rel, textLang: a.closest('[lang]')?.lang ?? '',
  })));
  return raw.map((a) => ({ ...a, node, listeners: [], ancestorListeners: [] }));
}
const lighthouse = (Audit, anchors, url) => Audit.audit({ AnchorElements: anchors, URL: { finalDisplayedUrl: url } });
async function axeRules(p, rules) {
  await p.addScriptTag({ content: axeSource });
  return p.evaluate(async (values) => (await window.axe.run(document, { runOnly: { type: 'rule', values } })).violations
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.html}`)), rules);
}

test('the helpers: Lighthouse\'s viewport rule, axe\'s language list, a title without the site name', () => {
  assert.equal(blocksZoom('width=device-width, user-scalable=no'), true);
  assert.equal(blocksZoom('width=device-width, user-scalable=0'), true);
  assert.equal(blocksZoom('width=device-width, maximum-scale=1'), true);
  assert.equal(blocksZoom('width=device-width, maximum-scale=5'), false);
  assert.equal(blocksZoom('width=device-width, initial-scale=1'), false);
  for (const ok of ['en', 'en-GB', 'hi', 'de-DE', ' en ']) assert.equal(isValidLang(ok), true, ok);
  for (const bad of ['english', 'eng', 'EN_us', 'xx', '', 'zz-ZZ']) assert.equal(isValidLang(bad), false, bad);
  assert.equal(titleWithoutSite('Pricing | Gate', 'Gate'), 'Pricing');
  assert.equal(titleWithoutSite('Gate — Our team', 'Gate'), 'Our team');
  assert.equal(titleWithoutSite('Gate', 'Gate'), 'Gate');
});

test('crawlable-anchors: a javascript:void(0) link with a name gets role="button" and passes Lighthouse; no-href, file: and unnamed links are only reported', async (t) => {
  const voids = Array.from({ length: MAX_ANCHORS + 1 }, (_, i) => `<a href="javascript:void(0)">Open part ${i + 1}</a>`).join(' ');
  const body = `<h1>Links</h1><p>${ENGLISH}</p>${voids}
    <a href="javascript:void(0)"><span></span></a>
    <a class="card">A card a script opens</a><a class="card">Another card</a>
    <a href="file:///C:/notes.pdf">Our notes</a>
    <a href="mailto:hi@example.dev">Write to us</a><a href="javascript:void(0)" role="button">Already a button</a>`;
  const dir = await siteOf(t, { 'index.html': page({ title: 'Links | Gate', body }), 'pricing/index.html': PRICING });
  const before = await readFile(path.join(dir, 'index.html'), 'utf8');
  const r = await fixAsIsCopy({ dir, pages: PAGES, siteUrl: SITE });
  const fixed = fixOf(r, 'anchors');
  assert.equal(fixed.length, MAX_ANCHORS, JSON.stringify(fixed));
  assert.equal(r.counts.anchors, MAX_ANCHORS);
  const open = r.open.filter((o) => o.kind === 'anchors').map((o) => o.detail);
  assert.ok(open.some((d) => /only the first 8/.test(d)), 'the ninth is reported, not changed');
  assert.ok(open.some((d) => /has no name/.test(d)));
  assert.ok(open.some((d) => /2 link\(s\) with no href/.test(d)), 'no-href links are reported (option A)');
  assert.ok(open.some((d) => /file:\/\/\/C:\/notes\.pdf/.test(d)));
  const out = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.equal((out.match(/<a class="card">/g) ?? []).length, 2, 'no-href links are left byte for byte');
  assert.equal((out.match(/href="javascript:void\(0\)"/g) ?? []).length, (before.match(/href="javascript:void\(0\)"/g) ?? []).length, 'no href is changed');
  assert.ok(out.includes('<a href="javascript:void(0)" role="button">Already a button</a>'));

  // Lighthouse's own audit, on the links as the browser reads them: only what was reported still fails.
  const served = await serveCopy(dir);
  t.after(() => served.close());
  const p = await browser.newPage();
  t.after(() => p.close());
  await p.goto(`${served.url.replace(/\/$/, '')}/`);
  const a = lighthouse(CrawlableAnchors, await anchorsOf(p), p.url());
  // No listeners are known here, so the no-href links pass; the ninth void link, the unnamed one and the file: link fail.
  assert.equal(a.details.items.length, 3, JSON.stringify(a.details.items.length));
});

test('link-text: "Read more" to a page of the copy gets hidden text that passes Lighthouse; external, other-language and same-page links are left', async (t) => {
  const body = `<h1>News</h1><p>${ENGLISH}</p><a href="/pricing/">Read more</a> <a href="https://elsewhere.example/">Click here</a>
    <a href="#top">More</a> <a href="/pricing/" rel="nofollow">Learn more</a>`;
  const other = page({ title: 'Nachrichten | Gate', lang: 'de', body: `<h1>Neu</h1><p>Hier steht etwas.</p><a href="/pricing/">Learn more</a>` });
  // Declared as "english" (not a language code): the text decides, and it is English.
  const misdeclared = page({ title: 'Team | Gate', lang: 'english', body: `<h1>Team</h1><p>${ENGLISH}</p><a href="/pricing/">See more</a>` });
  const dir = await siteOf(t, { 'index.html': page({ title: 'News | Gate', body }), 'pricing/index.html': PRICING, 'de/index.html': other, 'team/index.html': misdeclared });
  const pages = [...PAGES, { path: '/de/', outPath: 'de/index.html', url: `${SITE}de/` }, { path: '/team/', outPath: 'team/index.html', url: `${SITE}team/` }];
  const r = await fixAsIsCopy({ dir, pages, siteUrl: SITE });
  assert.deepEqual(fixOf(r, 'linktext').map((f) => [f.text, f.value]), [['read more', ' about Pricing']]);
  assert.equal(fixOf(r, 'linktext', 'de/index.html').length, 0, 'English words are not written into a German page');
  assert.deepEqual(fixOf(r, 'linktext', 'team/index.html').map((f) => f.value), [' about Pricing'], 'an invalid declared language does not hide that the text is English');
  const open = r.open.filter((o) => o.kind === 'linktext').map((o) => o.detail);
  assert.ok(open.some((d) => /"click here".*outside the copy/.test(d)));
  assert.ok(open.some((d) => /not in English/.test(d)));
  const out = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(out, /<a href="\/pricing\/">Read more<span style="position:absolute;[^"]*"> about Pricing<\/span><\/a>/);

  const served = await serveCopy(dir);
  t.after(() => served.close());
  const p = await browser.newPage();
  t.after(() => p.close());
  await p.goto(`${served.url.replace(/\/$/, '')}/`);
  const items = lighthouse(LinkText, await anchorsOf(p), p.url()).details?.items ?? [];
  assert.deepEqual(items.map((i) => i.text), ['Click here'], 'only the reported link still fails');
  assert.match(await p.locator('a[href="/pricing/"]').first().innerText(), /^Read more\s+about Pricing$/, 'kept in innerText');
  assert.deepEqual(await p.locator('a[href="/pricing/"] span').first().boundingBox().then((b) => [b.width, b.height]), [1, 1], 'drawn nowhere');
});

test('heading-order and html-lang-valid: aria-level and a real language code, judged by axe in the page; an own aria-level is left', async (t) => {
  const body = `<h1>Title</h1><p>${ENGLISH}</p><h4>Part one</h4><p>Text.</p><h4>Part two</h4><h6>Detail</h6><h2 aria-level="5">Own level</h2>`;
  const html = page({ title: 'Headings | Gate', lang: 'english', body });
  const dir = await siteOf(t, { 'index.html': html, 'pricing/index.html': PRICING });
  const served0 = await serveCopy(dir);
  const p = await browser.newPage();
  t.after(() => p.close());
  await p.goto(`${served0.url.replace(/\/$/, '')}/`);
  const before = await axeRules(p, ['heading-order', 'html-lang-valid']);
  await served0.close();
  assert.ok(before.some((v) => v.startsWith('heading-order')) && before.some((v) => v.startsWith('html-lang-valid')), before.join('\n'));

  const r = await fixAsIsCopy({ dir, pages: PAGES, siteUrl: SITE });
  assert.deepEqual(fixOf(r, 'headings').map((f) => [f.from, f.value]), [['h4', '2'], ['h4', '2'], ['h6', '3']]);
  assert.deepEqual(fixOf(r, 'lang').map((f) => [f.from, f.value]), [['english', 'en']]);
  assert.ok(r.open.some((o) => o.kind === 'headings' && /own aria-level 5/.test(o.detail)));
  const out = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(out, /<h4 aria-level="2">Part one<\/h4>/, 'the tag stays');
  assert.match(out, /<h2 aria-level="5">Own level<\/h2>/, 'an own aria-level is left as the original says');

  const served1 = await serveCopy(dir);
  t.after(() => served1.close());
  await p.goto(`${served1.url.replace(/\/$/, '')}/`);
  const now = await axeRules(p, ['heading-order', 'html-lang-valid']);
  assert.deepEqual(now, ['heading-order: <h2 aria-level="5">Own level</h2>'], 'only the reported heading still fails');
});

test('a description from the page\'s own og:description when its paragraphs are too short; viewports reported, never changed', async (t) => {
  const short = page({ title: 'Short | Gate', viewport: null, body: '<h1>Short</h1><p>Hi.</p>' })
    .replace(/<meta name="description"[^>]*>/, '')
    .replace(/<meta property="og:description"[^>]*>/, '<meta property="og:description" content="Everything about the short page, as its owner describes it on social sites.">');
  const zoom = page({ title: 'Zoom | Gate', viewport: 'width=device-width, maximum-scale=1', body: `<h1>Zoom</h1><p>${ENGLISH}</p>` });
  const dir = await siteOf(t, { 'index.html': short, 'zoom/index.html': zoom });
  const pages = [PAGES[0], { path: '/zoom/', outPath: 'zoom/index.html', url: `${SITE}zoom/` }];
  const r = await fixAsIsCopy({ dir, pages, siteUrl: SITE });
  const d = r.pages[0].fixes.find((f) => f.field === 'description');
  assert.equal(d?.value, 'Everything about the short page, as its owner describes it on social sites.');
  assert.equal(d.source, 'the page\'s own og:description');
  const views = r.open.filter((o) => o.kind === 'viewport');
  assert.deepEqual(views.map((o) => [o.page, o.reason]), [['/', 'd'], ['/zoom/', 'd']]);
  assert.match(await readFile(path.join(dir, 'zoom', 'index.html'), 'utf8'), /content="width=device-width, maximum-scale=1"/);
  assert.doesNotMatch(await readFile(path.join(dir, 'index.html'), 'utf8'), /name="viewport"/);
});

test('served facts: a stack that drops a link\'s hidden text is caught', () => {
  const fixed = '<html><body><a href="/p/">Read more<span style="position:absolute"> about Pricing</span></a></body></html>';
  const dropped = '<html><body><a href="/p/">Read more</a></body></html>';
  assert.deepEqual(factsDiffer(fixed, dropped, ['linktext']), ['links']);
  assert.deepEqual(factsDiffer(fixed, fixed, ['linktext']), []);
  assert.deepEqual(factsDiffer(fixed, dropped, ['alt']), [], 'other kinds do not look at link text');
});

// The gate. One page with every C2 fix; a script on the void link opens a panel, the same on both sides.
const PANEL = '<div id="panel" hidden>Details shown.</div><script>document.getElementById("open").addEventListener("click", () => { document.getElementById("panel").hidden = false; });</script>';
const gateBody = (extra = '') => `<h1>Gate</h1><p>${ENGLISH}</p><h4>Part</h4><p><a id="open" href="javascript:void(0)">Show details</a></p>
  <p><a href="/pricing/">Read more</a></p>${PANEL}${extra}`;
const prove = (dir) => fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages: PAGES, siteUrl: SITE, newSiteUrl: null, speed: false });

test('every C2 fix that changes nothing is kept at 375 and 1440 px; the link given a role is clicked on both sides and does the same', { timeout: 10 * 60000 }, async (t) => {
  const html = page({ title: 'Gate | Gate', body: gateBody() });
  const dir = await siteOf(t, { 'index.html': html, 'pricing/index.html': PRICING });
  const r = await prove(dir);
  const home = r.pages.find((p) => p.path === '/');
  assert.equal(home.reverted, undefined, JSON.stringify(r.gate));
  assert.deepEqual(home.dropped ?? [], []);
  const g = r.gate.find((x) => x.path === '/');
  assert.deepEqual(g.views.map((v) => [v.width, v.invisible]), [[375, true], [1440, true]]);
  assert.ok(g.clicks?.clicked >= 1 && g.clicks.differs.length === 0, JSON.stringify(g.clicks));
  for (const kind of ['anchors', 'linktext', 'headings']) assert.equal(r.counts[kind], 1, kind);
  const out = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(out, /<a id="open" href="javascript:void\(0\)" role="button">Show details<\/a>/);
  assert.match(out, /<h4 aria-level="2">Part<\/h4>/);
});

test('a role the page\'s CSS restyles is dropped on its own at the width where it shows; the other fixes stay', { timeout: 10 * 60000 }, async (t) => {
  const html = page({ title: 'Gate | Gate', css: '@media (max-width:600px){a[role=button]{display:block;padding:40px}}', body: gateBody() });
  const dir = await siteOf(t, { 'index.html': html, 'pricing/index.html': PRICING });
  const r = await prove(dir);
  const home = r.pages.find((p) => p.path === '/');
  assert.equal(home.reverted, undefined, JSON.stringify(r.gate));
  assert.deepEqual(home.dropped.map((d) => d.group), ['anchors']);
  assert.match(home.dropped[0].why, /at 375 px/);
  const out = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.doesNotMatch(out, /role="button"/);
  assert.match(out, /aria-level="2"/);
  assert.match(out, / about Pricing<\/span>/);
});

// The click opens the panel on both sides; on the fixed side the page's script ALSO writes a line because of the role. Both
// pages change, so this is caught only by comparing what each click changed (anchorClicks' text delta), not whether it changed.
test('a role the page\'s script reacts to on a click is dropped: invisible at load, not the same when clicked', { timeout: 10 * 60000 }, async (t) => {
  const reacts = '<script>document.addEventListener("click", (e) => { const a = e.target.closest("a"); if (a?.getAttribute("role") === "button") document.body.append("role seen"); });</script>';
  const html = page({ title: 'Gate | Gate', body: gateBody(reacts) });
  const dir = await siteOf(t, { 'index.html': html, 'pricing/index.html': PRICING });
  const r = await prove(dir);
  const home = r.pages.find((p) => p.path === '/');
  assert.equal(home.reverted, undefined, JSON.stringify(r.gate));
  assert.deepEqual(home.dropped.map((d) => d.group), ['anchors']);
  assert.match(home.dropped[0].why, /does not do the same when clicked at 375 px/);
  const first = r.gate.find((x) => x.path === '/' && !x.groups);
  assert.ok(first.views.every((v) => v.invisible), 'the pictures alone could not see it');
  assert.doesNotMatch(await readFile(path.join(dir, 'index.html'), 'utf8'), /role="button"/);
});
