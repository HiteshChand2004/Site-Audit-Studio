// Build mode from an existing site (src/buildmode/seed.js, polish.js, quality.js, agent.js createToolbox): the existing site is
// put in the project before the agent starts (code or a copy), paths that would leave the project are skipped, the room is
// measured from the existing site, the agent is asked once about pages gone, the copy's fix rules run on a built plain-HTML
// site, and the comparison with the original's Check says what got worse, what fails and what was fixed. No network, no model.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedSince, insideRoot, missingPages, placeSeed, seedNote } from '../src/buildmode/seed.js';
import { compareQuality, qualitySummary, qualityText, sitePages } from '../src/buildmode/quality.js';
import { polishSite } from '../src/buildmode/polish.js';
import { AGENT_LIMITS, createToolbox, toolsFor, workspaceNote } from '../src/buildmode/agent.js';
import { BUILD_STACKS } from '../src/buildmode/stacks.js';
import { WORKSPACE_LIMITS } from '../src/buildmode/workspace.js';

const dirs = [];
const temp = (p = 'sas-existing-') => {
  const d = mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const PAGE = (title, body) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

test('the owner\'s code is put in the project; paths that leave it and build folders are skipped', async () => {
  const site = temp();
  const seeded = await placeSeed({ kind: 'files', files: [
    { path: 'index.html', content: PAGE('Home', '<h1>Hi</h1>') },
    { path: 'about/index.html', content: PAGE('About', '<h1>About</h1>') },
    { path: 'css/site.css', content: 'body{margin:0}' },
    { path: '../escape.html', content: 'x' },
    { path: '/abs/../../x.html', content: 'x' },
    { path: 'C:/windows/x.html', content: 'x' },
    { path: 'node_modules/pkg/index.js', content: 'x' },
    { path: 'dist/index.html', content: 'x' },
  ] }, site);
  assert.deepEqual(seeded.files, ['about/index.html', 'css/site.css', 'index.html']);
  assert.deepEqual(seeded.pages, ['about/index.html', 'index.html']);
  assert.equal(seeded.skipped, 5);
  assert.ok(!existsSync(path.join(path.dirname(site), 'escape.html')));
  assert.equal(readFileSync(path.join(site, 'about/index.html'), 'utf8').includes('About'), true);
  assert.equal(insideRoot(site, '..'), null);
  assert.equal(insideRoot(site, 'a/../b'), null);
  assert.deepEqual(insideRoot(site, '/css/x.css')?.rel, 'css/x.css');
});

test('a copy made in the app is the starting point, without the copy\'s own notes', async () => {
  const copy = temp();
  writeFileSync(path.join(copy, 'index.html'), PAGE('Home', '<h1>Hi</h1>'));
  writeFileSync(path.join(copy, 'README.md'), '# About this copy');
  mkdirSync(path.join(copy, 'images'));
  writeFileSync(path.join(copy, 'images', 'a.webp'), Buffer.from([1, 2, 3]));
  const site = temp();
  const seeded = await placeSeed({ kind: 'copy', dir: copy }, site);
  assert.deepEqual(seeded.files, ['images/a.webp', 'index.html']);
  assert.match(seeded.from, /copy/);
  assert.equal(await placeSeed(null, site), null);
  assert.equal(await placeSeed({ kind: 'capture', url: 'https://x' }, site), null);
});

test('the room grows with the existing site, and the agent writes into it through the confined editor', async () => {
  const site = temp();
  const big = 'a'.repeat(WORKSPACE_LIMITS.fileBytes + 50 * 1024);
  const seeded = await placeSeed({ kind: 'files', files: [{ path: 'index.html', content: PAGE('Home', `<p>${big}</p>`) }] }, site);
  assert.ok(seeded.room.fileBytes > WORKSPACE_LIMITS.fileBytes);
  const box = createToolbox({ siteDir: site, stack: BUILD_STACKS.html, lim: AGENT_LIMITS, existing: seeded });
  // Without the seed's room this edit of a file already over 300 KB would be refused.
  const out = await box.call('str_replace_based_edit_tool', { command: 'str_replace', path: 'index.html', old_str: '<title>Home</title>', new_str: '<title>Home page</title>' });
  assert.ok(!out.isError, String(out.content));
  const escaped = await box.call('str_replace_based_edit_tool', { command: 'create', path: '../x.html', file_text: 'x' });
  assert.equal(escaped.isError, true);
});

test('which files the agent changed, and the pages of the site that are gone', async () => {
  const site = temp();
  const seeded = await placeSeed({ kind: 'files', files: [
    { path: 'index.html', content: PAGE('Home', '<h1>Hi</h1>') },
    { path: 'menu.html', content: PAGE('Menu', '<h1>Menu</h1>') },
    { path: 'css/site.css', content: 'body{}' },
  ] }, site);
  writeFileSync(path.join(site, 'index.html'), PAGE('Home', '<h1>Hello</h1>'));
  writeFileSync(path.join(site, 'contact.html'), PAGE('Contact', '<h1>Contact</h1>'));
  rmSync(path.join(site, 'menu.html'));
  assert.deepEqual(await changedSince(site, seeded, ['contact.html', 'css/site.css', 'index.html']), ['contact.html', 'index.html']);
  assert.deepEqual(await missingPages(site, seeded), ['menu.html']);
  assert.deepEqual(await changedSince(site, null, ['a', 'b']), ['a', 'b']);
});

test('finish asks once about pages of the existing site that are gone, then accepts', async () => {
  const site = temp();
  const seeded = await placeSeed({ kind: 'files', files: [
    { path: 'index.html', content: PAGE('Home', '<h1>Hi</h1>') },
    { path: 'menu.html', content: PAGE('Menu', '<h1>Menu</h1>') },
  ] }, site);
  rmSync(path.join(site, 'menu.html'));
  const box = createToolbox({
    siteDir: site, stack: BUILD_STACKS.html, lim: { ...AGENT_LIMITS, lookReminders: 0 }, existing: seeded,
    build: async () => ({ ok: true, out: site, problems: [] }),
  });
  const report = { summary: 'Done.', requirements: [], placeholders: [], not_done: [] };
  const first = await box.call('finish', report);
  assert.equal(first.isError, true);
  assert.match(String(first.content), /menu\.html/);
  const second = await box.call('finish', report);
  assert.ok(second.finished, String(second.content));
});

test('finish runs the fix rules, then refuses while the quality check finds problems (a few times at most)', async () => {
  const site = temp();
  writeFileSync(path.join(site, 'index.html'), PAGE('Home', '<h1>Hi</h1>'));
  let polished = 0;
  let assessed = 0;
  const box = createToolbox({
    siteDir: site, stack: BUILD_STACKS.html, lim: { ...AGENT_LIMITS, lookReminders: 0, qualityRounds: 1 },
    build: async () => ({ ok: true, out: site, problems: [] }),
    polish: async () => ({ changed: ++polished }),
    assess: async () => {
      assessed++;
      return { ok: false, worse: [{ area: 'Search', title: 'Title tag', detail: 'missing' }], failing: [], open: [], fixed: [], scores: [], text: 'fix the title' };
    },
  });
  const report = { summary: 'Done.', requirements: [], placeholders: [], not_done: [] };
  const first = await box.call('finish', report);
  assert.equal(first.isError, true);
  assert.equal(first.content, 'fix the title');
  const second = await box.call('finish', report);
  assert.ok(second.finished);
  assert.equal(second.finished.quality.ok, false);
  assert.equal(polished, 2);
  assert.equal(assessed, 2);
  // The tool itself, and the tool list with it.
  const tool = await box.call('audit_site', {});
  assert.equal(tool.content, 'fix the title');
  assert.ok(toolsFor(BUILD_STACKS.html, { audit: true }).some((t) => t.name === 'audit_site'));
  assert.ok(!toolsFor(BUILD_STACKS.html).some((t) => t.name === 'audit_site'));
});

test('the workspace note says the existing site is there, and how to work on it', () => {
  const seeded = { kind: 'files', from: 'your uploaded code', files: ['index.html', 'menu.html'], pages: ['index.html', 'menu.html'] };
  const note = workspaceNote({ stack: BUILD_STACKS.html, existing: seeded, audit: true });
  assert.match(note, /already holds the existing site \(2 files, from your uploaded code\)/);
  assert.match(note, /Read the existing site first/);
  assert.match(note, /audit_site/);
  assert.match(workspaceNote({ stack: BUILD_STACKS.html }), /Write the whole site/);
  assert.deepEqual(seedNote(null), []);
});

test('the built site against the original: worse, failing, fixed, scores', () => {
  const before = {
    seo: [{ key: 'seo.title-tag', title: 'Title tag', status: 'pass', detail: 'ok' }, { key: 'seo.meta-description', title: 'Meta description', status: 'fail', detail: 'missing' }],
    aeo: [{ key: 'aeo.json-ld-schema', title: 'JSON-LD schema', status: 'fail', detail: 'none' }],
    crawl: { sitemap: { status: 'fail', detail: '404' } },
    accessibility: [],
    scores: { mobile: { performance: 90, seo: 92, accessibility: 100, bestPractices: 100 } },
  };
  const after = {
    seo: [{ key: 'seo.title-tag', title: 'Title tag', status: 'fail', detail: 'missing on 1 page' }, { key: 'seo.meta-description', title: 'Meta description', status: 'pass', detail: 'ok' }, { key: 'seo.https', title: 'HTTPS', status: 'fail', detail: 'http' }],
    aeo: [{ key: 'aeo.json-ld-schema', title: 'JSON-LD schema', status: 'pass', detail: 'ok' }],
    crawl: { sitemap: { status: 'pass', detail: 'found' } },
    accessibility: [{ id: 'image-alt', impact: 'critical', title: 'Images need alt text', count: 2 }],
    brokenLinks: { broken: [] },
    scores: { mobile: { performance: 80, seo: 100, accessibility: 95, bestPractices: 100 } },
  };
  const q = compareQuality(after, before);
  assert.deepEqual(q.worse.map((c) => c.title), ['Title tag']);
  // A new accessibility failure has no row in the original, so it fails outright; HTTPS is the host's, never judged.
  assert.deepEqual(q.failing.map((c) => c.title), ['Images need alt text']);
  assert.deepEqual(q.fixed.map((c) => c.title).sort(), ['JSON-LD schema', 'Meta description', 'sitemap.xml']);
  assert.equal(q.ok, false);
  assert.deepEqual(q.scores.filter((s) => s.worse).map((s) => s.area), ['Speed', 'Easy for everyone']);
  assert.match(qualityText(q, { gate: true }), /cannot be finished yet[\s\S]*Worse than the original[\s\S]*Title tag/);
  const s = qualitySummary(q, true);
  assert.equal(s.compared, true);
  assert.equal(s.fixed, 3);
  // A new site: nothing to be worse than; only what fails.
  const fresh = compareQuality(after, null);
  assert.equal(fresh.worse.length, 0);
  assert.deepEqual(fresh.failing.map((c) => c.title).sort(), ['Images need alt text', 'Title tag']);
  assert.match(qualityText(compareQuality({ seo: [], aeo: [] }, null)), /all pass/);
});

test('the built site\'s pages, and the copy\'s fix rules run on a plain-HTML site', async () => {
  const site = temp();
  writeFileSync(path.join(site, 'index.html'), '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>A</title>\n</head>\n<body>\n<h1>Rosa\'s Bakery</h1>\n<p>Fresh bread every morning from our stone oven in the old town, baked before sunrise.</p>\n<img src="bread.png">\n</body>\n</html>\n');
  mkdirSync(path.join(site, 'menu'));
  writeFileSync(path.join(site, 'menu', 'index.html'), '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>A</title>\n</head>\n<body>\n<h1>Menu</h1>\n<p>Sourdough, rye and seeded loaves, every day of the week, and cakes on Sunday.</p>\n</body>\n</html>\n');
  assert.deepEqual(await sitePages(site), ['', 'menu/']);
  const before = readFileSync(path.join(site, 'index.html'), 'utf8');
  const out = await polishSite({ dir: site, siteUrl: 'https://rosa.example/', siteName: "Rosa's Bakery" });
  const fixed = readFileSync(path.join(site, 'index.html'), 'utf8');
  assert.ok(out.changed > 0);
  assert.notEqual(fixed, before);
  // The same rules as a copy: a description, link previews, structured data, alt text, and titles no longer repeated.
  assert.match(fixed, /<meta name="description" content="Fresh bread/);
  assert.match(fixed, /<meta property="og:title"/);
  assert.match(fixed, /"@type":"Organization"/);
  assert.match(fixed, /<img src="bread.png" alt="[^"]+"/);
  assert.notEqual(readFileSync(path.join(site, 'menu', 'index.html'), 'utf8').match(/<title>([^<]*)/)?.[1], fixed.match(/<title>([^<]*)/)?.[1]);
  // No homepage, nothing to fix.
  assert.equal((await polishSite({ dir: temp() })).changed, 0);
});

// --- An existing site keeps its own scripts; a copy's duplicate files fold; Improve / Redesign ------------------------------

const { checkBuiltSite } = await import('../src/buildmode/check.js');

/** A small app-like site as a copy holds it: pages running their own scripts, a query variant of a file, a vendor library. */
function appCopy() {
  const copy = temp();
  const put = (rel, text) => {
    mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
    writeFileSync(path.join(copy, rel), text);
  };
  put('index.html', PAGE('Home', '<h1>Labels</h1>\n<a href="app.html">Open the tool</a>\n<link rel="stylesheet" href="/css/site~1a2b3c4d.css">\n<script src="/js/app~1a2b3c4d.js"></script>\n<script>window.boot=1</script>\n<button onclick="go()">Go</button>'));
  put('app.html', PAGE('Tool', '<h1>Tool</h1>\n<div id="sheet"></div>\n<script src="vendor/lib.min.js"></script>\n<script src="js/app.js"></script>'));
  put('css/site.css', 'body{color:#111}');
  put('css/site~1a2b3c4d.css', 'body{color:#111}');
  put('js/app.js', "fetch('/api/me').then(() => {});\n");
  put('js/app~1a2b3c4d.js', "fetch('/api/me').then(() => {});\n");
  put('js/other~5e6f7a8b.js', 'console.log(2)\n');
  put('js/other.js', 'console.log(1)\n');
  put('vendor/lib.min.js', 'var x = new XMLHttpRequest();\n');
  put('sw.js', "const MAP = {\"https://site.test/js/app.js?v=1\":\"/js/app~1a2b3c4d.js\"};\nself.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));\n");
  put('README.md', '# The copy');
  return copy;
}

test('a copy\'s query variants identical to their plain file are folded into it, references and all', async () => {
  const site = temp();
  const seeded = await placeSeed({ kind: 'copy', dir: appCopy() }, site);
  assert.equal(seeded.folded, 2);
  assert.ok(!existsSync(path.join(site, 'css/site~1a2b3c4d.css')) && !existsSync(path.join(site, 'js/app~1a2b3c4d.js')));
  // A variant with content of its own stays.
  assert.ok(existsSync(path.join(site, 'js/other~5e6f7a8b.js')));
  const home = readFileSync(path.join(site, 'index.html'), 'utf8');
  assert.ok(home.includes('href="/css/site.css"') && home.includes('src="/js/app.js"'));
  assert.ok(readFileSync(path.join(site, 'sw.js'), 'utf8').includes('"/js/app.js"'));
  // A copy's vendor/ folder is the site's own: kept (a code project's vendor/ is not).
  assert.ok(seeded.files.includes('vendor/lib.min.js'));
  assert.ok(!seeded.files.includes('README.md'));
});

test('the site\'s own scripts pass the checks; a script the agent adds, or a new risk in an own file, does not', async () => {
  const site = temp();
  const seeded = await placeSeed({ kind: 'copy', dir: appCopy() }, site);
  // The old rule: every script of a working site counted as a problem.
  assert.ok((await checkBuiltSite(site)).issues.some((i) => /script/.test(i)));
  const own = await checkBuiltSite(site, { own: seeded.own });
  assert.deepEqual(own.issues, [], own.issues.join('\n'));
  // Moved to another page and the page rewritten around it: still the site's own.
  writeFileSync(path.join(site, 'app.html'), PAGE('Tool, new look', '<main><h1>Tool</h1><div id="sheet"></div></main>\n<script src="/vendor/lib.min.js"></script>\n<script src="/js/app.js"></script>\n<script>window.boot=1</script>'));
  assert.deepEqual((await checkBuiltSite(site, { own: seeded.own })).issues, []);
  // New inline code, a new handler, a new risk in an own file, a new oddly named script file: each refused.
  writeFileSync(path.join(site, 'index.html'), PAGE('Home', '<h1>Labels</h1><script>alert(1)</script><button onclick="steal()">x</button>'));
  writeFileSync(path.join(site, 'js/other.js'), 'eval("1")\n');
  mkdirSync(path.join(site, 'lib'), { recursive: true });
  writeFileSync(path.join(site, 'lib/new.js'), 'console.log(1)\n');
  const issues = (await checkBuiltSite(site, { own: seeded.own })).issues;
  assert.ok(issues.includes('index.html: <script> element'), issues.join('\n'));
  assert.ok(issues.includes('index.html: onclick on <button>'), issues.join('\n'));
  assert.ok(issues.includes('js/other.js: eval() in script'), issues.join('\n'));
  assert.ok(issues.includes('lib/new.js: unexpected script file'), issues.join('\n'));
});

test('an existing site\'s request decides the design: a rebuild gets new directions and starts as one', async () => {
  const { composePrompt } = await import('../src/buildmode/compose.js');
  const base = { selected: [], context: { input: 'url', text: '<project>x</project>' }, understanding: { task: 'redesign' }, description: 'Rebuild it' };
  const brief = (mode) => ({ summary: 's', design: { mode, directions: mode === 'new' ? [{ name: 'A' }, { name: 'B' }, { name: 'C' }] : [] }, pages: [], requirements: [] });
  const text = (p) => p.messages[0].content[1].text;
  assert.match(text(composePrompt({ ...base, brief: brief('new'), direction: 1 })), /asks for a new design[^]*keep every element, id, class/);
  assert.doesNotMatch(text(composePrompt({ ...base, brief: brief('evolve-existing') })), /asks for a new design/);
});
