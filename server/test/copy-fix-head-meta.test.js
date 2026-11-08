// Step 3: the invisible head fixes of an as-is copy (copy/fixAsIs.js): title / description length, theme-color, icon, and how the
// re-check reads them (reaudit/compare/rules.js asIsEvidence: review; copy/gotWorse.js: an open row says why).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixAsIsCopy } from '../src/copy/fixAsIs.js';
import { asIsEvidence } from '../src/reaudit/compare/rules.js';
import { explainWorse } from '../src/copy/gotWorse.js';

const SITE = 'https://example-original.test/';
const LONG_PARA = 'Our tools help small teams plan, build and ship their work without the clutter of large suites they never needed.';

const page = ({ title, description, head = '', body = `<h1>Acme</h1><p>${LONG_PARA}</p>` }) => `<!doctype html><html lang="en"><head><meta charset="utf-8">`
  + `${title != null ? `<title>${title}</title>` : ''}${description != null ? `<meta name="description" content="${description}">` : ''}${head}</head><body>${body}</body></html>`;

async function site(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-headmeta-'));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return dir;
}
const PAGES = [{ path: '/', outPath: 'index.html', url: SITE }, { path: '/blog/', outPath: 'blog/index.html', url: `${SITE}blog/` }];
const fixesOf = (r, i, field) => r.pages[i].fixes.filter((f) => f.field === field);

test('a long title is shortened (tail part first) and a long description cut at a word; both inside the ranges', async () => {
  const longTitle = 'Acme tools for small teams who plan, build and ship | The friendliest toolkit on the whole wide web';
  const longDesc = `${LONG_PARA} ${LONG_PARA} ${LONG_PARA}`;
  const dir = await site({ 'index.html': page({ title: longTitle, description: longDesc }) });
  try {
    const r = await fixAsIsCopy({ dir, pages: PAGES.slice(0, 1), siteUrl: SITE });
    const [t] = fixesOf(r, 0, 'title');
    assert.ok(t && t.from === longTitle && /too long/.test(t.source), JSON.stringify(r.pages[0].fixes));
    assert.ok(t.value.length >= 10 && t.value.length <= 60, t.value);
    assert.ok(!t.value.includes('|'), 'the trailing part goes first');
    const [d] = fixesOf(r, 0, 'description');
    assert.ok(d && d.value.length >= 50 && d.value.length <= 160, d?.value);
    assert.ok(longDesc.startsWith(d.value.replace(/…$/, '').trim()), 'the description is the page\'s own text, cut');
    const out = await readFile(path.join(dir, 'index.html'), 'utf8');
    assert.ok(out.includes(`<title>${t.value}</title>`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a short description is completed from the page\'s own paragraph; with no words to use it is left open for the owner', async () => {
  const dir = await site({
    'index.html': page({ title: 'Acme small team tools', description: 'Tools for teams.' }),
    'blog/index.html': page({ title: 'The Acme blog', description: 'Short.', body: '<h1>Blog</h1>' }),
  });
  try {
    const r = await fixAsIsCopy({ dir, pages: PAGES, siteUrl: SITE });
    const [d] = fixesOf(r, 0, 'description');
    assert.ok(d && /too short/.test(d.source) && d.value.startsWith('Tools for teams.') && d.value.includes('Our tools help'), JSON.stringify(d));
    assert.ok(d.value.length >= 50 && d.value.length <= 160);
    assert.equal(fixesOf(r, 1, 'description').length, 0, 'nothing of its own to complete it with');
    assert.ok(r.open.some((o) => o.kind === 'head' && o.field === 'description' && o.page === '/blog/' && o.reason === 'c'));
    assert.equal(fixesOf(r, 0, 'title').length, 0, 'a title inside 10–60 is left as written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('theme-color: the manifest\'s own value (no review), else the links\' and buttons\' colour (review), else open; never over one already there', async () => {
  const css = 'body{color:#222;background:#fff} a.cta, .btn{background-color:#c2410c;color:#fff} .note{background:#eee} button{background:rgb(194, 65, 12)}';
  const dirs = [];
  try {
    // 1. A manifest states it.
    let dir = await site({ 'index.html': page({ title: 'Acme small team tools', head: '<link rel="manifest" href="/site.webmanifest"><style>a{background:#123456}</style>' }), 'site.webmanifest': '{"theme_color":"#0f766e"}' });
    dirs.push(dir);
    let r = await fixAsIsCopy({ dir, pages: PAGES.slice(0, 1), siteUrl: SITE });
    let [f] = fixesOf(r, 0, 'theme-color');
    assert.deepEqual([f.value, f.review], ['#0f766e', undefined], JSON.stringify(f));
    assert.match(await readFile(path.join(dir, 'index.html'), 'utf8'), /<meta name="theme-color" content="#0f766e">/);
    // 2. Only the stylesheets: the strong colour of links and buttons, marked for review; a grey is never taken.
    dir = await site({ 'index.html': page({ title: 'Acme small team tools', head: '<link rel="stylesheet" href="/css/site.css">' }), 'css/site.css': css });
    dirs.push(dir);
    r = await fixAsIsCopy({ dir, pages: PAGES.slice(0, 1), siteUrl: SITE });
    [f] = fixesOf(r, 0, 'theme-color');
    assert.deepEqual([f.value, f.review], ['#c2410c', true], JSON.stringify(f));
    // 3. Nothing states a colour: open, never invented.
    dir = await site({ 'index.html': page({ title: 'Acme small team tools', head: '<style>a{color:#333}</style>' }) });
    dirs.push(dir);
    r = await fixAsIsCopy({ dir, pages: PAGES.slice(0, 1), siteUrl: SITE });
    assert.equal(fixesOf(r, 0, 'theme-color').length, 0);
    assert.ok(r.open.some((o) => o.field === 'theme-color' && o.reason === 'c'));
    // 4. Already there: untouched.
    dir = await site({ 'index.html': page({ title: 'Acme small team tools', head: '<meta name="theme-color" content="#000000"><link rel="icon" href="/i.png">' }) });
    dirs.push(dir);
    r = await fixAsIsCopy({ dir, pages: PAGES.slice(0, 1), siteUrl: SITE });
    assert.equal(fixesOf(r, 0, 'theme-color').length + fixesOf(r, 0, 'icon').length, 0);
  } finally {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  }
});

test('icon: the site\'s own /favicon.ico (no review), else one letter icon for the whole site (review), linked from every page', async () => {
  const dirs = [];
  try {
    let dir = await site({ 'index.html': page({ title: 'Acme small team tools' }), 'favicon.ico': 'ico' });
    dirs.push(dir);
    let r = await fixAsIsCopy({ dir, pages: PAGES.slice(0, 1), siteUrl: SITE });
    let [f] = fixesOf(r, 0, 'icon');
    assert.deepEqual([f.value, f.review], ['favicon.ico', undefined]);

    dir = await site({ 'index.html': page({ title: 'Acme small team tools' }), 'blog/index.html': page({ title: 'The Acme blog' }) });
    dirs.push(dir);
    r = await fixAsIsCopy({ dir, pages: PAGES, siteUrl: SITE });
    [f] = fixesOf(r, 0, 'icon');
    assert.deepEqual([f.value, f.review], ['icons/favicon-generated.svg', true]);
    assert.match(await readFile(path.join(dir, 'icons', 'favicon-generated.svg'), 'utf8'), /^<svg[\s\S]*<\/svg>\s*$/);
    assert.match(await readFile(path.join(dir, 'blog', 'index.html'), 'utf8'), /<link rel="icon" href="\.\.\/icons\/favicon-generated\.svg" type="image\/svg\+xml">/);
  } finally {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  }
});

test('the re-check: a stylesheet colour or a letter icon asks for review on the meta-tags row; an open row says why, never a bug', () => {
  const report = (fixes, open = []) => ({ asIs: { fixes: { pages: [{ path: '/', fixes }], open } } });
  const ev = asIsEvidence('crawl.meta-tags', report([{ kind: 'head', field: 'theme-color', value: '#c2410c', review: true }, { kind: 'head', field: 'icon', value: 'favicon.ico' }]));
  assert.deepEqual(ev.map((e) => [e.asIs, e.review ?? false]), [['themeColor', true], ['icon', false]]);
  const own = asIsEvidence('crawl.meta-tags', report([{ kind: 'head', field: 'theme-color', value: '#0f766e' }]));
  assert.equal(own[0].review, undefined, 'the manifest\'s own colour needs no review');
  const length = asIsEvidence('seo.title-tag.length', report([{ kind: 'head', field: 'title', value: 'Acme | x' }]));
  assert.equal(length[0].review, true);

  const row = (key, detail) => ({ key, category: key.split('.')[0], status: 'open', title: key, before: { status: 'warn', detail }, after: { status: 'warn', detail } });
  const ctx = { siteUrl: SITE, copyOrigin: 'http://127.0.0.1:5101', copyPages: ['/', '/blog/'] };
  const noColour = explainWorse({ ...ctx, items: [row('crawl.meta-tags', 'viewport ✓, charset ✓, twitter:card ✗, theme-color ✗, favicon ✓')], fixOpen: [{ kind: 'head', field: 'theme-color', page: '/', reason: 'c' }] }).open;
  assert.notEqual(noColour[0].group, 'bug', JSON.stringify(noColour[0]));
  const noWords = explainWorse({ ...ctx, items: [row('seo.meta-description.length', 'Description too short on /blog/')], fixOpen: [{ kind: 'head', field: 'description', page: '/blog/', reason: 'c' }] }).open;
  assert.equal(noWords[0].group, 'needs-info', JSON.stringify(noWords[0]));
  const missed = explainWorse({ ...ctx, items: [row('crawl.meta-tags', 'viewport ✓, charset ✓, twitter:card ✓, theme-color ✓, favicon ✗')] }).open;
  assert.equal(missed[0].group, 'bug', 'an icon the copy should have added and did not is a bug');
});
