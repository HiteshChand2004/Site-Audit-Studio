// After a build (src/buildmode/edit.js, publish.js, sourcetext.js): the owner fills in what is missing and changes the text
// of a built site without the agent, on the same run (files changed, checks still pass, every place written the way its file
// type needs, refusals in plain words, a failed rebuild or check rolled back), and shares it with a link served like a
// preview (every document sandboxed by header, nothing outside the published copy, kept over a restart, gone when unshared).
// Runs are made with startBuild and a fake agent; the React + Vite one is built for real with the pinned toolchain.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { BUILDS_DIR, getBuild, siteDirOf, startBuild } from '../src/buildmode/builds.js';
import { editSite, pageBlocks, siteTexts } from '../src/buildmode/edit.js';
import { publishBuild, PUBLISHED_PREFIX, publishedPath, resolvePublished, unpublishBuild } from '../src/buildmode/publish.js';
import { fileRuns, findText, jsRuns, replaceHits } from '../src/buildmode/sourcetext.js';
import { buildProject } from '../src/buildmode/project.js';
import { checkBuiltSite } from '../src/buildmode/check.js';
import { previewRouter } from '../src/recreate/previewRoute.js';
import { inlineScriptHashes } from '../src/recreate/inlineScripts.js';
import { toolchainStatus } from '../src/toolchains/index.js';
import buildRouter from '../src/routes/build.js';

const reactReady = (await toolchainStatus('react-vite')).installed;

const UNDERSTANDING = {
  task: 'build-new', site_type: 'restaurant', goal: 'bookings', audience: 'Local families', tone: 'warm',
  pages: [{ path: '/', purpose: 'Bookings', change: 'create' }, { path: '/menu', purpose: 'The menu', change: 'create' }],
  must_haves: [], keep_unchanged: [], quality_focus: [], facts: ['Business name: Trattoria Rosa'], unknowns: [], questions: [],
};
const direction = (name) => ({
  name, palette: [{ role: 'primary', hex: '#b5482b' }], fonts: { heading: 'Fraunces', body: 'Inter' },
  layout: 'full-bleed', imagery: 'food photography', motion: 'subtle', why: 'warmth',
});
const BRIEF = {
  summary: 'A warm site for Trattoria Rosa.',
  design: { mode: 'new', existing_notes: '', directions: [direction('Terracotta')] },
  pages: [{ path: '/', title: 'Trattoria Rosa', description: 'Handmade pasta in Pune.', purpose: 'Bookings', sections: [{ name: 'Hero', content: 'Pizza.', notes: '' }] }],
  requirements: [{ id: 'R1', text: 'Book a table button', check: 'visible' }],
  keep_unchanged: [], placeholders: ['[Phone]'], structured_data: [],
};
const request = (stack) => ({ input: { kind: 'scratch' }, stack, description: 'An Italian restaurant', understanding: UNDERSTANDING, brief: BRIEF, direction: 0 });
// Every build here counts as a first build: a repeat would draw a new design with the model.
const NO_MODEL = { claimBuild: async () => false };

const head = (title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Trattoria Rosa, a family-run Italian restaurant in Pune.">
</head>
<body>
<header><nav><a href="/">Home</a> <a href="/menu/">Our menu</a></nav></header>
`;
const HOME = `${head('Trattoria Rosa')}<main>
<h1>Wood-fired pizza</h1>
<p>Fish &amp; chips on Fridays. Call <a href="tel:[Phone]">[Phone]</a> to book.</p>
<p>Book a table</p>
<p>Book a table</p>
</main>
</body>
</html>
`;
const MENU = `${head('Menu · Trattoria Rosa')}<main>
<h1>Our dishes</h1>
<ul><li>Margherita</li><li>Diavola</li></ul>
<p>Questions? Call [Phone].</p>
</main>
</body>
</html>
`;

/** Writes files into a project folder, folders made. */
const put = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
};
const fakeAgent = (files, { build } = {}) => async ({ siteDir, stack }) => {
  put(siteDir, files);
  if (build) {
    const out = await buildProject({ stack, dir: siteDir, tmp: path.join(siteDir, '..', 'tmp') });
    assert.equal(out.ok, true, out.problems.join('\n'));
  }
  return { checks: { ok: true, issues: [], pages: 2 }, report: { summary: 'Built.', requirements: [], placeholders: ['[Phone]', 'Photos of the dining room'], notDone: [] }, turns: 1, usage: {}, model: 'fake' };
};
const finished = async (run, ownerId) => {
  while ((run = await getBuild(run.id, ownerId)).status === 'running') await new Promise((r) => setTimeout(r, 10));
  return run;
};
const read = (id, rel) => readFileSync(path.join(siteDirOf(id), rel), 'utf8');

let htmlRun;
before(async () => {
  htmlRun = await finished(await startBuild(request('html'), { ownerId: 'owner-a', agent: fakeAgent({ 'index.html': HOME, 'menu/index.html': MENU }), fonts: async () => null, deps: NO_MODEL }), 'owner-a');
  assert.equal(htmlRun.status, 'done');
});

test('sourcetext: each place is written the way its file needs it, and only words are ever runs', () => {
  const jsx = [
    "import Link from 'next/link';",
    "const items = ['Margherita', \"Rosa's \\\"best\\\"\"];",
    'const re = /a<b/g;',
    'export default function Home({ n }) {',
    '  return (<main className="hero"><h1>Wood-fired &amp; pizza</h1>{/* note */}<img alt="Photo of [Chef]" src="/x.png" />{n < 3 ? <b>few</b> : \'many\'}</main>);',
    '}',
  ].join('\n');
  const runs = jsRuns(jsx);
  const swap = (from, to, whole = true) => replaceHits(jsx, findText(jsx, runs, from, { whole }), to);
  assert.ok(!runs.some((r) => jsx.slice(r.start, r.end) === 'next/link'), 'an import specifier is never words');
  assert.match(swap('Wood-fired & pizza', 'A {b} <c> & d'), /<h1>A &#123;b&#125; &lt;c&gt; &amp; d<\/h1>/, 'JSX text: entities for { } < > &');
  assert.match(swap("Rosa's \"best\"", 'It\'s \\ "new"'), /"It's \\\\ \\"new\\""/, 'a string: backslash and its quote escaped');
  assert.match(swap('[Chef]', 'Mario "M" & co', false), /alt="Photo of Mario &quot;M&quot; &amp; co"/, 'a JSX attribute: entities, no backslashes');
  assert.match(swap('many', 'a\'b'), /: 'a\\'b'\}/);
  assert.equal(findText(jsx, runs, 'few', { whole: true }).length, 1);

  const html = '<p title=[x]>Fish &amp; chips</p><script>var s = "Fish & chips";</script><script type="application/ld+json">{"telephone":"[Phone]"}</script>';
  const hr = fileRuns('a.html', html);
  assert.equal(findText(html, hr, 'Fish & chips', { whole: true }).length, 1, 'a script is not text of the page');
  assert.match(replaceHits(html, findText(html, hr, '[x]', { whole: false }), 'a "b"'), /title="a &quot;b&quot;"/, 'an unquoted value is quoted');
  assert.match(replaceHits(html, findText(html, hr, '[Phone]', { whole: false }), '+91 "1"'), /"telephone":"\+91 \\"1\\""/, 'JSON-LD is written as JSON');
});

test('plain HTML: the words of each page, its placeholders, and what can be changed here', async () => {
  const texts = await siteTexts(htmlRun.id, 'owner-a');
  assert.deepEqual(texts.pages.map((p) => p.path), ['/', '/menu/']);
  const home = texts.pages[0].blocks;
  const block = (text) => home.find((b) => b.text === text);
  assert.deepEqual(block('Wood-fired pizza'), { text: 'Wood-fired pizza', kind: 'heading', editable: true });
  assert.equal(block('Our menu').kind, 'link');
  assert.equal(block('Our menu').editable, true, 'the menu is written once in every page: changed on every page');
  assert.equal(block('Fish & chips on Fridays. Call').editable, true);
  assert.equal(block('Book a table').editable, false);
  assert.match(block('Book a table').why, /more than one place/);
  assert.deepEqual(texts.placeholders, [{ token: '[Phone]', label: 'Phone', pages: ['/', '/menu/'], fillable: true }]);
  assert.deepEqual(texts.notMarked, ['Photos of the dining room'], 'a missing fact not marked on a page is still told');
});

test('plain HTML: a placeholder is filled everywhere and a text block changed, escaped, checked and recorded', async () => {
  const filled = await editSite(htmlRun.id, 'owner-a', { kind: 'fill', token: '[Phone]', value: '  +91 98765\n43210 <ext> & "1" ' });
  assert.deepEqual(filled.files.sort(), ['index.html', 'menu/index.html']);
  assert.match(read(htmlRun.id, 'index.html'), /<a href="tel:\+91 98765 43210 &lt;ext&gt; &amp; &quot;1&quot;">\+91 98765 43210 &lt;ext&gt; &amp; "1"<\/a>/);
  assert.match(read(htmlRun.id, 'menu/index.html'), /Call \+91 98765 43210 &lt;ext&gt; &amp; "1"\./);
  assert.equal(filled.run.revision, 1);
  assert.equal(filled.run.checks.ok, true);

  const changed = await editSite(htmlRun.id, 'owner-a', { kind: 'text', page: '/', from: 'Our menu', to: 'Menu & <drinks>' });
  assert.deepEqual(changed.files.sort(), ['index.html', 'menu/index.html'], 'the menu changes on every page that shows it');
  assert.match(read(htmlRun.id, 'menu/index.html'), /<a href="\/menu\/">Menu &amp; &lt;drinks&gt;<\/a>/);
  assert.ok((await pageBlocks(siteDirOf(htmlRun.id), '/menu/')).some((b) => b.text === 'Menu & <drinks>'), 'the page shows exactly what was typed');
  assert.equal((await checkBuiltSite(siteDirOf(htmlRun.id))).ok, true, 'and still passes every check');

  const stored = JSON.parse(readFileSync(path.join(BUILDS_DIR, htmlRun.id, 'run.json'), 'utf8'));
  assert.equal(stored.revision, 2);
  assert.deepEqual(stored.edits.map((e) => [e.kind, e.from, e.to]), [['fill', '[Phone]', '+91 98765 43210 <ext> & "1"'], ['text', 'Our menu', 'Menu & <drinks>']]);
  assert.equal((await siteTexts(htmlRun.id, 'owner-a')).placeholders.length, 0, 'nothing left to fill in');
});

test('plain HTML: refusals in plain words, and a failed check puts every file back', async () => {
  const refuse = (body, re, status = 422) => assert.rejects(editSite(htmlRun.id, 'owner-a', body), (e) => e.status === status && re.test(e.message));
  await refuse({ kind: 'text', page: '/', from: 'Book a table', to: 'Reserve' }, /more than one place/);
  await refuse({ kind: 'text', page: '/', from: 'Not on the page', to: 'x' }, /not on the page/, 409);
  await refuse({ kind: 'text', page: '/', from: 'Wood-fired pizza', to: '   ' }, /cannot be empty/, 400);
  await refuse({ kind: 'text', page: '/', from: 'Wood-fired pizza', to: 'x'.repeat(2001) }, /under 2000/, 400);
  await refuse({ kind: 'text', page: '/nope/', from: 'Wood-fired pizza', to: 'x' }, /not part of the site/, 400);
  await refuse({ kind: 'fill', token: 'Phone', value: 'x' }, /not a placeholder/, 400);
  await refuse({ kind: 'fill', token: '[Fax]', value: 'x' }, /put together by the site/);
  await refuse({ kind: 'delete' }, /kind must be/, 400);

  const before = read(htmlRun.id, 'index.html');
  await assert.rejects(
    editSite(htmlRun.id, 'owner-a', { kind: 'text', page: '/', from: 'Wood-fired pizza', to: 'Pizza' }, { check: async () => ({ ok: false, issues: ['index.html: broken'], pages: 2 }) }),
    (e) => e.status === 422 && /would not pass its checks, so nothing was changed/.test(e.message),
  );
  assert.equal(read(htmlRun.id, 'index.html'), before, 'rolled back');
  assert.equal((await getBuild(htmlRun.id, 'owner-a')).revision, 2, 'and not recorded');
});

test('owner checks: another account\'s run is not found, for reading, changing and sharing', async () => {
  for (const work of [siteTexts(htmlRun.id, 'owner-b'), editSite(htmlRun.id, 'owner-b', { kind: 'fill', token: '[Phone]', value: 'x' }), publishBuild(htmlRun.id, 'owner-b'), unpublishBuild(htmlRun.id, 'owner-b'), siteTexts(htmlRun.id, null)]) {
    await assert.rejects(work, (e) => e.status === 404);
  }
});

/** A GET with the path exactly as written (no client-side normalisation of "..") → { status, headers, body }. */
const rawGet = (port, pathname) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});

let server;
let port;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/build', buildRouter);
  app.use(PUBLISHED_PREFIX, previewRouter({ inlineScriptHashes, resolve: resolvePublished, pathOf: publishedPath, missing: 'No such site.' }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('API: the words, an edit and its refusal over HTTP', async () => {
  const run = await finished(await startBuild(request('html'), { agent: fakeAgent({ 'index.html': HOME, 'menu/index.html': MENU }), fonts: async () => null, deps: NO_MODEL }));
  const base = `http://127.0.0.1:${port}/api/build/runs/${run.id}`;
  const texts = await (await fetch(`${base}/texts`)).json();
  assert.equal(texts.pages.length, 2);
  const post = (body) => fetch(`${base}/edits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ok = await post({ kind: 'text', page: '/menu/', from: 'Our dishes', to: 'What we cook' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).run.revision, 1);
  const refused = await post({ kind: 'text', page: '/', from: 'Book a table', to: 'x' });
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error, /more than one place/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/build/runs/${htmlRun.id}/texts`)).status, 404, 'another account\'s run (accounts off: nobody\'s) is not found');
});

test('sharing: a stable public address served like a preview, updated by sharing again, kept over a restart, gone when unshared', async () => {
  const shared = await publishBuild(htmlRun.id, 'owner-a');
  const url = shared.published.url;
  assert.match(url, /^\/sites\/[A-Za-z0-9_-]{24}\/$/);
  assert.equal(shared.published.outdated, false);

  const page = await rawGet(port, `${url}menu/`);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /^sandbox allow-scripts; default-src 'none'/, 'every document sandboxed, as a preview is');
  assert.match(page.headers['content-security-policy'], /form-action 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.body, /Menu &amp; &lt;drinks&gt;/);
  assert.match(page.body, new RegExp(`href="${url}menu/"`), 'its links stay under the shared address');

  for (const p of [`${url}../run.json`, `${url}%2e%2e/run.json`, `${url}%2e%2e%2frun.json`, `${url}..%5crun.json`, `${url}.%2e/.%2e/builds`, `${url}%00`, '/sites/AAAAAAAAAAAAAAAAAAAAAAAA/', '/sites/../api/build/sites']) {
    const res = await rawGet(port, p);
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(res.body, /"status"|ownerId/, p);
  }

  // A change after sharing: the link keeps the shared version until it is shared again, at the same address.
  const edited = await editSite(htmlRun.id, 'owner-a', { kind: 'text', page: '/', from: 'Wood-fired pizza', to: 'Pizza from the oven' });
  assert.equal(edited.run.published.outdated, true);
  assert.match((await rawGet(port, url)).body, /Wood-fired pizza/);
  const again = await publishBuild(htmlRun.id, 'owner-a');
  assert.equal(again.published.url, url, 'the same address');
  assert.equal(again.published.outdated, false);
  assert.match((await rawGet(port, url)).body, /Pizza from the oven/);

  // A restart: the lookup is read again from the runs on disk (a fresh copy of the module has none in memory).
  const fresh = await import(`../src/buildmode/publish.js?restart=${Date.now()}`);
  const slug = url.split('/')[2];
  assert.equal((await fresh.resolvePublished(slug))?.root, path.join(BUILDS_DIR, htmlRun.id, 'published'));

  await unpublishBuild(htmlRun.id, 'owner-a');
  assert.equal((await rawGet(port, url)).status, 404);
  assert.equal((await getBuild(htmlRun.id, 'owner-a')).published, null);
  assert.ok(!existsSync(path.join(BUILDS_DIR, htmlRun.id, 'published')));
});

const REACT_PAGE = (title, entry) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Trattoria Rosa, a family-run Italian restaurant in Pune.">
</head>
<body>
<div id="root"></div>
<script type="module" src="/src/pages/${entry}.jsx"></script>
</body>
</html>
`;
const REACT_FILES = {
  'index.html': REACT_PAGE('Trattoria Rosa', 'home'),
  'src/pages/home.jsx': "import { createRoot } from 'react-dom/client';\nimport Home from '../components/Home.jsx';\ncreateRoot(document.getElementById('root')).render(<Home />);\n",
  'src/data.js': "export const DISHES = ['Margherita', \"Rosa's special\"];\nexport const DAYS = 7;\n",
  'src/components/Home.jsx': [
    "import { DISHES, DAYS } from '../data.js';",
    'export default function Home() {',
    '  return (',
    '    <main>',
    '      <h1>Wood-fired pizza</h1>',
    '      <p>Open {DAYS} days a week.</p>',
    '      <ul>{DISHES.map((d) => <li key={d}>{d}</li>)}</ul>',
    '      <p>Call [Phone] to book.</p>',
    '      <footer><p>Wood-fired pizza</p></footer>',
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n'),
};

test('React + Vite: a change in the agent\'s source is rebuilt for real, escaped for JSX and strings; a failed rebuild is rolled back', { skip: !reactReady && 'react-vite toolchain not installed', timeout: 240000 }, async () => {
  const run = await finished(await startBuild(request('react-vite'), { ownerId: 'owner-a', agent: fakeAgent(REACT_FILES, { build: true }), fonts: async () => null, deps: NO_MODEL }), 'owner-a');
  assert.equal(run.status, 'done', run.error ?? '');
  const texts = await siteTexts(run.id, 'owner-a');
  const block = (text) => texts.pages[0].blocks.find((b) => b.text === text) ?? assert.fail(`no block "${text}" in ${JSON.stringify(texts.pages[0].blocks)}`);
  assert.equal(block('Rosa\'s special').editable, true, 'a string in a data file');
  assert.equal(block('Open 7 days a week.').editable, false, 'a number the code puts into the text');
  assert.match(block('Open 7 days a week.').why, /put together by the site’s code/);
  assert.equal(block('Wood-fired pizza').editable, false, 'written twice in the source');
  assert.equal(texts.placeholders[0].token, '[Phone]');

  const scaffold = readFileSync(path.join(siteDirOf(run.id), 'vite.config.js'), 'utf8');
  const changed = await editSite(run.id, 'owner-a', { kind: 'text', page: '/', from: 'Rosa\'s special', to: 'Rosa\'s "best" {pie} <3 & more' });
  assert.deepEqual(changed.files, ['src/data.js']);
  assert.match(read(run.id, 'src/data.js'), /"Rosa's \\"best\\" \{pie\} <3 & more"/);
  const filled = await editSite(run.id, 'owner-a', { kind: 'fill', token: '[Phone]', value: '{x} <b> & 1' });
  assert.deepEqual(filled.files, ['src/components/Home.jsx']);
  assert.match(read(run.id, 'src/components/Home.jsx'), /<p>Call &#123;x&#125; &lt;b&gt; &amp; 1 to book\.<\/p>/);
  const built = readFileSync(path.join(siteDirOf(run.id), 'dist/index.html'), 'utf8');
  assert.match(built, /Rosa&#x27;s &quot;best&quot; \{pie\} &lt;3 &amp; more|Rosa's "best" \{pie\} &lt;3 &amp; more/, 'rebuilt: the page shows it');
  assert.match(built, /Call \{x\} &lt;b&gt; &amp; 1 to book\./);
  assert.equal(readFileSync(path.join(siteDirOf(run.id), 'vite.config.js'), 'utf8'), scaffold, 'the fixed setup is never touched');
  assert.equal(filled.run.checks.ok, true);

  // A rebuild that fails: the source and the built site come back as they were.
  const source = read(run.id, 'src/components/Home.jsx');
  const dist = readFileSync(path.join(siteDirOf(run.id), 'dist/index.html'), 'utf8');
  await assert.rejects(
    editSite(run.id, 'owner-a', { kind: 'text', page: '/', from: 'Margherita', to: 'Marinara' }, { build: async ({ stack, dir }) => {
      assert.match(readFileSync(path.join(dir, 'src/data.js'), 'utf8'), /Marinara/, 'the change is written before the build');
      return { ok: false, out: path.join(dir, stack.out), problems: ['The build failed.'], ms: 1 };
    } }),
    (e) => e.status === 422 && /could not be built with this change/.test(e.message),
  );
  assert.doesNotMatch(read(run.id, 'src/data.js'), /Marinara/);
  assert.equal(read(run.id, 'src/components/Home.jsx'), source);
  assert.equal(readFileSync(path.join(siteDirOf(run.id), 'dist/index.html'), 'utf8'), dist, 'the built site is put back');
  assert.equal((await getBuild(run.id, 'owner-a')).revision, 2);

  // A restart in the middle of a change: the next start puts the files and the built site back from the journal.
  const runDir = path.join(BUILDS_DIR, run.id);
  writeFileSync(path.join(runDir, 'edit-journal.json'), JSON.stringify({ files: [{ rel: 'src/data.js', text: read(run.id, 'src/data.js') }], out: 'dist' }));
  writeFileSync(path.join(siteDirOf(run.id), 'src/data.js'), 'half-written');
  renameSync(path.join(siteDirOf(run.id), 'dist'), path.join(runDir, 'edit-backup'));
  const restarted = await import(`../src/buildmode/builds.js?restart=${Date.now()}`);
  const back = await restarted.getBuild(run.id, 'owner-a');
  assert.ok(back.previewUrl, 'the built site is back, so it has a preview');
  assert.doesNotMatch(read(run.id, 'src/data.js'), /half-written/);
  assert.equal(readFileSync(path.join(siteDirOf(run.id), 'dist/index.html'), 'utf8'), dist);
  assert.ok(!existsSync(path.join(runDir, 'edit-journal.json')) && !existsSync(path.join(runDir, 'edit-backup')));
});

