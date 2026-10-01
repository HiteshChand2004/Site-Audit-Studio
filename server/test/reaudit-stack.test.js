// Re-audit 6.6: the checklist is about the project's stack output (not always the plain-HTML build) —
// pages at the URLs the output serves them, the framework runtime kept on purpose, the JavaScript shipped.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runAnalysis } from '../src/audit/index.js';
import { DATA_DIR, db, projectDir } from '../src/db/index.js';
import { compareAudits } from '../src/reaudit/compare/index.js';
import { pairPages, toOriginalUrl } from '../src/reaudit/compare/scope.js';
import { recreateSection } from '../src/reaudit/contract.js';
import { runReaudit } from '../src/reaudit/index.js';
import { outputPages, outputRoot, targetStack } from '../src/recreate/export/fromIr.js';
import { servePreview } from '../src/recreate/preview.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { createNetPolicy } from '../src/security/netGuard.js';

delete process.env.SAS_ALLOW_LOCALHOST;

const FAST_SKIP = ['screenshots', 'lighthouse-mobile', 'lighthouse-desktop'];
const BASE_URL = 'https://example.com';

// ---- unit: output helpers, page mapping, rows ----

const report = (outputs, extra = {}) => ({ stack: 'nextjs', pages: [{ url: 'https://o.test/', outPath: 'index.html' }, { url: 'https://o.test/about.html', outPath: 'about.html' }], outputs, ...extra });

test('the audited output is the project stack when ready, else the plain-HTML build; its pages are where it serves them', () => {
  const r = report({ html: { status: 'ready', dir: 'dist' }, nextjs: { status: 'ready', dir: 'stacks/nextjs', dist: 'out', pages: [{ outPath: 'index.html', path: '/', file: 'index.html' }, { outPath: 'about.html', path: '/about/', file: 'about/index.html' }] }, mern: { status: 'failed', error: 'x' } });
  assert.equal(targetStack(r, 'nextjs'), 'nextjs');
  assert.equal(targetStack(r, 'mern'), 'html'); // failed
  assert.equal(targetStack(r, 'react-vite'), 'html'); // never built
  assert.equal(targetStack(report(undefined), 'html'), 'html');
  assert.equal(outputRoot('/r', r, 'nextjs'), path.join('/r', 'stacks/nextjs', 'out'));
  assert.equal(outputRoot('/r', r, 'html'), path.join('/r', 'dist'));
  assert.deepEqual(outputPages(r, 'nextjs'), [{ outPath: 'index.html', path: '/' }, { outPath: 'about.html', path: '/about/' }]);
  assert.deepEqual(outputPages(r, 'html'), [{ outPath: 'index.html', path: '/' }, { outPath: 'about.html', path: '/about.html' }]); // the original layout
});

test('a page the output moved is paired at its new URL, and links to it map back to the original', () => {
  const pages = [{ url: 'https://o.test/', outPath: 'index.html' }, { url: 'https://o.test/about.html', outPath: 'about.html', newPath: '/about/' }];
  const facts = { title: 't', links: [] };
  const crawl = (urls) => urls.map((url) => ({ url, facts }));
  const paired = pairPages({ reportPages: pages, oldPages: crawl(['https://o.test/', 'https://o.test/about.html']), newPages: crawl(['http://p/', 'http://p/about/']), newOrigin: 'http://p' });
  assert.deepEqual(paired.pairs.map((p) => p.path), ['/', '/about/']);
  assert.deepEqual([paired.missingInNew, paired.outOfScope], [[], []]);
  const ctx = { newOrigin: 'http://p', oldOrigin: 'https://o.test', reportPages: pages };
  assert.equal(toOriginalUrl('http://p/about/', ctx), 'https://o.test/about.html');
  assert.equal(toOriginalUrl('http://p/other', ctx), 'https://o.test/other');
});

const lhr = (scriptBytes) => ({
  categories: { performance: { auditRefs: [] }, 'best-practices': { auditRefs: [] } },
  audits: { 'resource-summary': { details: { items: [{ resourceType: 'script', transferSize: scriptBytes }, { resourceType: 'image', transferSize: 5 }] } } },
});
const audit = (techStack = []) => ({ url: 'https://o.test/', analysisId: 'a', techStack, seo: [], aeo: [], crawl: {}, accessibility: [], brokenLinks: { broken: [] }, scores: {} });
const compare = ({ oldScript, newScript, output, techStack }) => compareAudits({
  old: { audit: audit(techStack), crawl: null, lighthouse: oldScript == null ? {} : { mobile: lhr(oldScript) } },
  next: { audit: audit(), crawl: null, lighthouse: newScript == null ? {} : { mobile: lhr(newScript) } },
  report: report({}),
  newOrigin: 'http://p',
  output,
});
const row = (checklist, key) => checklist.items.find((i) => i.key === key);
const NEXT = { stack: 'nextjs', label: 'Next.js', runtimes: ['nextjs', 'react'], pages: [], build: { js: { gzipBytes: 240 * 1024 } } };
const REACT = { stack: 'react-vite', label: 'React + Vite', runtimes: ['react'], pages: [], build: { js: { gzipBytes: 60 * 1024 } } };

test('JavaScript shipped: always a row for a stack with a bundle, the build\'s gzipped size against the original', () => {
  // The original shipped 400 KB: React's 60 KB is an improvement, Next's 240 KB too; the cost is shown either way.
  const react = row(compare({ oldScript: 400 * 1024, newScript: 999999, output: REACT }), 'stack.javascript');
  assert.deepEqual([react.status, react.category, react.title], ['improved', 'performance', 'JavaScript shipped']);
  assert.equal(react.before.detail, '400 KB transferred (original analysis)');
  assert.equal(react.after.detail, '60 KB gzipped (React + Vite build)'); // not the uncompressed preview transfer
  assert.match(react.note, /ships its framework runtime and hydrates every page/);
  // A light original: the runtime is a regression, honestly.
  assert.equal(row(compare({ oldScript: 20 * 1024, output: NEXT }), 'stack.javascript').status, 'regressed');
  // About the same: still shown, as "changed".
  assert.equal(row(compare({ oldScript: 62 * 1024, output: REACT }), 'stack.javascript').status, 'changed');
  // Not measured on the original: shown, with only the build's size.
  const unknown = row(compare({ oldScript: null, output: REACT }), 'stack.javascript');
  assert.deepEqual([unknown.status, unknown.before], ['changed', null]);
  // Plain HTML ships none: all of the original's JavaScript is gone.
  const html = row(compare({ oldScript: 300 * 1024, newScript: 0, output: { stack: 'html', label: 'Plain HTML / CSS / JS', runtimes: [], pages: [] } }), 'stack.javascript');
  assert.deepEqual([html.status, html.after.detail], ['fixed', '0 B transferred (local preview)']);
  assert.match(html.note, /ships no JavaScript/);
  // Nothing to say when neither side has JavaScript, or nothing was measured.
  assert.equal(row(compare({ oldScript: 0, newScript: 0, output: { stack: 'html', label: 'x', runtimes: [], pages: [] } }), 'stack.javascript'), undefined);
  assert.equal(row(compare({ oldScript: null, newScript: null, output: null }), 'stack.javascript'), undefined);
});

test('a platform runtime the output stack is built on is kept on purpose (n/a), not a leftover', () => {
  const techStack = [{ id: 'nextjs', name: 'Next.js' }, { id: 'wordpress', name: 'WordPress' }, { id: 'custom', name: 'Custom' }];
  const c = compare({ oldScript: 1, newScript: 1, output: NEXT, techStack });
  const kept = row(c, 'platform.nextjs');
  assert.deepEqual([kept.status, kept.title], ['na', 'Next.js runtime kept on purpose (Next.js output)']);
  assert.match(kept.note, /built as Next\.js/);
  assert.equal(kept.before.rank, undefined);
  // Another platform is still judged by whether its runtime is gone.
  assert.equal(row(c, 'platform.wordpress').status, 'fixed');
  // The same site recreated as React + Vite: Next.js is a platform left behind (not detected any more).
  assert.equal(row(compare({ oldScript: 1, newScript: 1, output: REACT, techStack }), 'platform.nextjs').status, 'fixed');
  assert.deepEqual(c.stack, { id: 'nextjs', label: 'Next.js', jsBytes: { before: 1, after: 240 * 1024 } });
  assert.equal(compare({ oldScript: 1, output: null }).stack, null);
});

// ---- integration: a real re-audit of a stack output whose pages moved ----

const ORIGINAL = {
  'index.html': '<h1>Home</h1><p><a href="/about.html">About</a></p>',
  'about.html': '<h1>About</h1><p><a href="/">Home</a></p>',
};
const html = (title, body, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${title}, a page of the test site used by the stack re-audit tests."></head><body><main>${body}</main>${extra}</body></html>`;
const origin = (files) => Object.fromEntries(Object.entries(files).map(([f, b]) => [f, html(f.replace('.html', ''), b)]));
// The Next-style output: about.html moved to about/index.html, framework scripts in the page.
const NEXT_SCRIPTS = '<script src="/_next/static/chunks/app.js" async></script><script>self.__next_f.push([0])</script>';
const OUTPUT = {
  'index.html': html('index', '<h1>Home</h1><p><a href="/about/">About</a></p>', NEXT_SCRIPTS),
  'about/index.html': html('about', '<h1>About</h1><p><a href="/">Home</a></p>', NEXT_SCRIPTS),
  '_next/static/chunks/app.js': 'window.__ok = true;',
  'sitemap.xml': `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${BASE_URL}/</loc></url></urlset>`,
  'robots.txt': `User-agent: *\nAllow: /\nSitemap: ${BASE_URL}/sitemap.xml\n`,
};
const HTML_BUILD = {
  'index.html': html('index', '<h1>Home</h1><p><a href="about.html">About</a></p>'),
  'about.html': html('about', '<h1>About</h1><p><a href="./">Home</a></p>'),
  'sitemap.xml': OUTPUT['sitemap.xml'],
  'robots.txt': OUTPUT['robots.txt'],
};

async function writeTree(dir, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
}

const projectIds = [];
function makeProject(stack) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'p', 'https://example.com/', ?, 1, ?, ?)`).run(id, stack, now, now);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

let originalRoot;
before(async () => {
  originalRoot = path.join(DATA_DIR, 'stack-original');
  await writeTree(originalRoot, origin(ORIGINAL));
});
after(async () => {
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

async function setup(stack, { nextReady = true } = {}) {
  const project = makeProject(stack);
  const served = await servePreview(originalRoot);
  const analysisId = randomUUID();
  let originUrl;
  try {
    originUrl = served.origin;
    const audit = await runAnalysis({ project, analysisId, url: `${served.origin}/`, maxPages: 5, skip: FAST_SKIP, netPolicy: createNetPolicy({ internalPorts: [served.port] }), progress: () => {} });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`).run(analysisId, project.id, now, now, JSON.stringify(audit));
  } finally {
    await served.close();
  }
  const recreateId = randomUUID();
  const rep = {
    recreateId, analysisId, baseUrl: BASE_URL, stack: 'nextjs',
    pages: [{ url: `${originUrl}/`, outPath: 'index.html' }, { url: `${originUrl}/about.html`, outPath: 'about.html' }],
    outputs: {
      html: { status: 'ready', dir: 'dist' },
      ...(nextReady && { nextjs: { status: 'ready', dir: 'stacks/nextjs', dist: 'out', pages: [{ outPath: 'index.html', path: '/', file: 'index.html' }, { outPath: 'about.html', path: '/about/', file: 'about/index.html' }], build: { toolchain: 'next', js: { files: 3, bytes: 800000, gzipBytes: 245760 }, css: { files: 1, bytes: 10 } } } }),
    },
    fixes: [], autoGenerated: [], manual: [],
  };
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`).run(recreateId, project.id, now, now, JSON.stringify(rep));
  const dir = recreateDir(project.id, recreateId);
  await writeTree(path.join(dir, 'dist'), HTML_BUILD);
  await writeTree(path.join(dir, 'stacks', 'nextjs', 'out'), OUTPUT);
  return { project, recreateId, report: rep };
}

const run = ({ project, recreateId }) => runReaudit({ project, reauditId: randomUUID(), recreateId, progress: () => {}, skip: FAST_SKIP });

test('a re-audit of a Next.js output pairs the moved page at its new URL and shows what the build ships', { timeout: 180000 }, async () => {
  const s = await setup('nextjs');
  const result = await run(s);
  assert.deepEqual([result.stack, result.stackLabel], ['nextjs', 'Next.js']);
  assert.deepEqual(result.pages, ['', 'about/']);
  const c = result.checklist;
  assert.equal(c.scope.mode, 'pages');
  assert.deepEqual(c.scope.pages.map((p) => p.path), ['/', '/about/']); // about.html was paired at /about/
  assert.deepEqual([c.scope.missingInNew, c.scope.missingInOld], [[], []]);
  assert.deepEqual(c.stack, { id: 'nextjs', label: 'Next.js', jsBytes: { before: null, after: 245760 } });
  const js = row(c, 'stack.javascript');
  assert.deepEqual([js.status, js.before, js.after.detail], ['changed', null, '240 KB gzipped (Next.js build)']);
  const section = (project, audit = null) => recreateSection(project, audit);
  db.prepare(`INSERT INTO reaudits (id, project_id, recreate_id, analysis_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, ?, ?, 'done', 100, ?, ?, ?)`)
    .run(result.reauditId, s.project.id, s.recreateId, s.report.analysisId, new Date().toISOString(), new Date().toISOString(), JSON.stringify(result));
  const fresh = section(s.project);
  assert.deepEqual([fresh.stack, fresh.stale, fresh.staleReasons, fresh.output.label], ['nextjs', false, [], 'Next.js']);
  // The project's stack changes to one whose output is ready: the checklist is about another build now.
  const rep = { ...s.report, outputs: { ...s.report.outputs, 'react-vite': { status: 'ready', dir: 'stacks/react-vite', dist: 'dist' } } };
  db.prepare('UPDATE recreates SET result_json = ? WHERE id = ?').run(JSON.stringify(rep), s.recreateId);
  db.prepare("UPDATE projects SET stack = 'react-vite' WHERE id = ?").run(s.project.id);
  const stale = section({ ...s.project, stack: 'react-vite' });
  assert.deepEqual([stale.stale, stale.staleReasons], [true, ['stack']]);
});

test('without a ready output for the project stack the plain-HTML build is audited', { timeout: 180000 }, async () => {
  const s = await setup('nextjs', { nextReady: false });
  const result = await run(s);
  assert.deepEqual([result.stack, result.stackLabel], ['html', 'Plain HTML / CSS / JS']);
  assert.deepEqual(result.pages, ['', 'about.html']);
  assert.deepEqual(result.checklist.scope.pages.map((p) => p.path), ['/', '/about.html']);
  assert.equal(row(result.checklist, 'stack.javascript'), undefined); // no JavaScript anywhere
});
