// Recreate 4a.6: atomic production build, build verification (links, assets, HTML), fidelity
// threshold, and the static preview server (port range, one active preview, isolation, headers).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import { buildDist } from '../src/recreate/build/minify.js';
import { RecreateError } from '../src/recreate/errors.js';
import { activePreview, appOrigins, PREVIEW_PORTS, servePreview, startPreview, stopPreview } from '../src/recreate/preview.js';
import { flagFidelity } from '../src/recreate/verify/fidelity.js';
import { resolveRef, verifyFailure, verifySite } from '../src/recreate/verify/site.js';
import { recreateDir } from '../src/recreate/workspace.js';
import recreateRouter from '../src/routes/recreate.js';

const exists = (p) => access(p).then(() => true, () => false);
const temps = [];
const projectIds = [];
after(async () => {
  await stopPreview();
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-build-'));
  temps.push(dir);
  return dir;
};
async function writeTree(root, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}
const page = (body, head = '') => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>T</title>\n${head}</head>\n<body>${body}</body>\n</html>\n`;

/** A raw HTTP request (fetch cannot set Host); no keep-alive, since servers are closed and reopened. */
const get = (port, pathname, { host = `127.0.0.1:${port}`, method = 'GET' } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path: pathname, method, headers: { host }, agent: false }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

test('the production build is atomic: a failure names the file and leaves no partial dist/', async () => {
  const dir = await tempDir();
  const assetsDir = path.join(dir, 'assets');
  const distDir = path.join(dir, 'dist');
  await writeTree(dir, { 'assets/images/a.png': 'png', 'dist/old.html': 'previous build' });

  const ok = await buildDist({
    files: new Map([['index.html', page('<p>x</p>')], ['css/site.css', 'a {  color : red ; }\n']]),
    assets: ['images/a.png'], assetsDir, distDir,
  });
  assert.equal(ok.files, 3);
  assert.equal(await readFile(path.join(distDir, 'css', 'site.css'), 'utf8'), 'a{color:red}\n');
  assert.equal(await exists(path.join(distDir, 'old.html')), false); // replaced as a whole
  assert.equal(await exists(`${distDir}.tmp`), false);

  // Invalid JavaScript: the job error names the file; the previous dist/ stays, no dist.tmp.
  await assert.rejects(
    buildDist({ files: new Map([['index.html', 'x'], ['js/site.js', 'function (']]), assets: [], assetsDir, distDir }),
    (err) => err instanceof RecreateError && /^The production build failed on js\/site\.js: .+\(line 1\)$/.test(err.message),
  );
  assert.equal(await exists(`${distDir}.tmp`), false);
  assert.equal(await exists(path.join(distDir, 'css', 'site.css')), true);

  // A missing asset file fails the build too.
  await assert.rejects(
    buildDist({ files: new Map([['index.html', 'x']]), assets: ['images/gone.png'], assetsDir, distDir }),
    (err) => err instanceof RecreateError && /failed on assets\/images\/gone\.png/.test(err.message),
  );
  assert.equal(await exists(`${distDir}.tmp`), false);
});

test('references resolve relative to the file; schemes and protocol-relative URLs are external', () => {
  assert.deepEqual(resolveRef('services/index.html', '../about.html#team'), { file: 'about.html', hash: 'team', dir: false });
  assert.deepEqual(resolveRef('services/index.html', '../'), { file: '', hash: '', dir: true });
  assert.deepEqual(resolveRef('index.html', 'assets/images/a%20b.png'), { file: 'assets/images/a b.png', hash: '', dir: false });
  assert.deepEqual(resolveRef('index.html', 'https://x.test/a.png'), { external: true });
  assert.deepEqual(resolveRef('index.html', '//x.test/a.png'), { external: true });
});

test('build verification: a clean site passes', async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    'index.html': page('<header id="top"><a href="about.html">About</a> <a href="services/">Services</a> <a href="services">S</a> <a href="#main">Skip</a> <a href="https://live.test/team.html">Team</a> <a href="mailto:a@b.test">Mail</a></header><main id="main"><img src="assets/images/a.png" srcset="assets/images/a.png 1x, assets/images/b.png 2x" alt=""><svg><use href="assets/icons/i.svg#i"></use></svg><iframe src="https://www.youtube.com/embed/x" title="Video"></iframe></main>',
      '<link rel="icon" href="assets/images/a.png">\n<link rel="stylesheet" href="css/site.css">\n<link rel="canonical" href="https://live.test/">\n'),
    'about.html': page('<a href="./#main">Home</a><h1 id="team">Team</h1>'),
    'services/index.html': page('<a href="../about.html#team">Team</a><a href="../">Home</a>'),
    'css/site.css': '@font-face{src:url("../assets/fonts/f.woff2")} a{background:url(data:image/png;base64,AA)}',
    'assets/images/a.png': 'a', 'assets/images/b.png': 'b', 'assets/fonts/f.woff2': 'f',
    'assets/icons/i.svg': '<svg xmlns="http://www.w3.org/2000/svg"><use href="#i"/><image href="../images/a.png"/></svg>',
  });
  const v = await verifySite(dir, { expected: ['index.html', 'css/site.css', 'assets/images/a.png'] });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(v.checked, { pages: 3, links: 7, assets: 8, stylesheets: 1, svgFiles: 1 });
  assert.deepEqual(v.html, { valid: true, errors: 0, warnings: 0, pages: [] });
  assert.deepEqual(v.anchors, []);
});

test('build verification: broken links, missing / remote assets, missing files and HTML errors fail it', async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    'index.html': page('<a href="team.html">Team</a><a href="about.html#nowhere">A</a><img src="assets/gone.png" alt=""><img src="https://cdn.test/x.png" alt=""><i class="a" class="b"></i><a href="about.html"><button type="button">x</button></a>',
      '<link rel="stylesheet" href="css/site.css">\n'),
    'about.html': page('<p>About</p>'),
    'css/site.css': 'a{background:url("../assets/missing.png")}',
  });
  const v = await verifySite(dir, { expected: ['index.html', 'contact.html'] });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missingFiles, ['contact.html']);
  assert.deepEqual(v.brokenLinks, [{ file: 'index.html', href: 'team.html' }]);
  assert.deepEqual(v.missingAssets, [{ file: 'index.html', ref: 'assets/gone.png' }, { file: 'css/site.css', ref: '../assets/missing.png' }]);
  assert.deepEqual(v.externalAssets, [{ file: 'index.html', ref: 'https://cdn.test/x.png' }]);
  assert.deepEqual(v.anchors, [{ file: 'index.html', href: 'about.html#nowhere' }]); // a warning only
  // The duplicate attribute is an emitter error; the button inside a link comes from the original: a warning.
  const rules = v.html.pages[0].messages.map((m) => [m.rule, m.level]);
  assert.deepEqual(rules, [['no-dup-attr', 'error'], ['element-permitted-content', 'warning']]);
  assert.deepEqual([v.html.errors, v.html.warnings, v.html.valid], [1, 1, false]);
  assert.match(verifyFailure(v), /^The generated site failed verification: 1 file\(s\) missing from the build \(contact\.html\); 1 broken internal link\(s\) \(index\.html → team\.html\); 2 missing asset\(s\) \(index\.html → assets\/gone\.png, …\); 1 asset\(s\) loaded from another origin \(index\.html → https:\/\/cdn\.test\/x\.png\); 1 HTML error\(s\) \(index\.html:\d+ no-dup-attr: .+\)\. It was not kept\.$/);

  // HTML warnings alone do not fail the verification.
  const warnOnly = await tempDir();
  await writeTree(warnOnly, { 'index.html': page('<a href="index.html"><button type="button">x</button></a>') });
  const w = await verifySite(warnOnly);
  assert.equal(w.ok, true);
  assert.equal(w.html.warnings, 1);
});

test('fidelity below the threshold is flagged per view, page and site', () => {
  const view = (score) => ({ score });
  const f = {
    score: 84,
    pages: [
      { path: '/', score: 95, views: { desktop: view(98), mobile: view(92) } },
      { path: '/work.html', score: 72, views: { desktop: view(90), mobile: view(54) } },
    ],
  };
  const warnings = flagFidelity(f, 80);
  assert.equal(f.threshold, 80);
  assert.equal(f.status, 'mixed');
  assert.deepEqual(f.lowPages, ['/work.html']);
  assert.deepEqual(f.pages.map((p) => [p.low, p.lowViews]), [[false, []], [true, ['mobile']]]);
  assert.equal(f.pages[1].views.desktop.low, false);
  assert.deepEqual(warnings, ['Fidelity is below 80/100 on 1 page: /work.html (72).']);

  const low = { score: 61, pages: [{ path: '/', score: 61, views: { desktop: view(61) } }] };
  const w2 = flagFidelity(low, 80);
  assert.equal(low.status, 'low');
  assert.equal(w2.length, 2);
  assert.match(w2[0], /^Overall fidelity is 61\/100, below the 80 threshold/);
  const ok = { score: 97, pages: [{ path: '/', score: 97, views: { desktop: view(97) } }] };
  assert.deepEqual(flagFidelity(ok, 80), []);
  assert.equal(ok.status, 'ok');
});

test('preview server: serves only its own folder, with strict headers', async () => {
  const root = await tempDir();
  const dist = path.join(root, 'a', 'dist');
  await writeTree(root, {
    'a/dist/index.html': page('<a href="services/">S</a>'),
    'a/dist/services/index.html': page('<p>Services</p>'),
    'a/dist/css/site.css': 'a{}',
    'a/dist/.secret': 'dot',
    'a/secret.json': '{"other":"file of the same recreate"}',
    'b/dist/index.html': 'another project',
  });
  let linked = false;
  try {
    await symlink(path.join(root, 'b', 'dist', 'index.html'), path.join(dist, 'escape.html'));
    linked = true;
  } catch { /* symlinks need extra rights on Windows */ }

  const served = await servePreview(dist);
  try {
    const { port } = served;
    const home = await get(port, '/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /^text\/html/);
    const csp = home.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/); // no script at all (default-src 'none')
    assert.match(csp, /frame-ancestors http:\/\/localhost:5173 http:\/\/127\.0\.0\.1:5173/);
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    assert.equal(home.headers['referrer-policy'], 'no-referrer');
    assert.match((await get(port, '/css/site.css')).headers['content-type'], /^text\/css/);
    assert.equal((await get(port, '/localhost-name', { host: `localhost:${port}` })).status, 404); // allowed host

    // A folder without its slash redirects to it (same-origin path only).
    const dirRedirect = await get(port, '/services');
    assert.deepEqual([dirRedirect.status, dirRedirect.headers.location], [301, '/services/']);
    assert.equal((await get(port, '/services/')).status, 200);
    const protocolRelative = await get(port, '//evil.test/x');
    assert.equal(protocolRelative.headers.location, undefined); // never a redirect to another host

    // Nothing outside the folder, no dotfiles, other hosts and methods refused.
    for (const p of ['/../secret.json', '/%2e%2e/secret.json', '/..%2fsecret.json', '/..%5csecret.json', '/../../b/dist/index.html', '/.secret', '/%00index.html']) {
      const res = await get(port, p);
      assert.ok([400, 404].includes(res.status), `${p} → ${res.status}`);
      assert.doesNotMatch(res.body, /other|another project|dot/);
    }
    if (linked) assert.equal((await get(port, '/escape.html')).status, 404);
    assert.equal((await get(port, '/', { host: 'evil.test' })).status, 403);
    assert.equal((await get(port, '/', { host: `127.0.0.1:${port + 1}` })).status, 403);
    assert.equal((await get(port, '/', { method: 'POST' })).status, 405);
  } finally {
    await served.close();
  }
  assert.deepEqual(appOrigins('http://127.0.0.1:5173'), ['http://127.0.0.1:5173', 'http://localhost:5173']);
});

test('one preview per project, each on its own port in 5100–5199', async () => {
  const root = await tempDir();
  await writeTree(root, { 'a/index.html': 'site A', 'b/index.html': 'site B' });
  const a = await startPreview({ projectId: 'pa', recreateId: 'ra', root: path.join(root, 'a') });
  assert.ok(a.port >= PREVIEW_PORTS.first && a.port <= PREVIEW_PORTS.last);
  assert.equal(a.url, `http://127.0.0.1:${a.port}/`);
  assert.equal((await get(a.port, '/')).body, 'site A');
  // Same recreate again: the same preview.
  assert.equal((await startPreview({ projectId: 'pa', recreateId: 'ra', root: path.join(root, 'a') })).port, a.port);

  // Another project gets its own port; the first one keeps answering (two tabs side by side).
  const b = await startPreview({ projectId: 'pb', recreateId: 'rb', root: path.join(root, 'b') });
  assert.equal(activePreview().projectId, 'pb');
  assert.equal(activePreview('pa').port, a.port);
  assert.notEqual(b.port, a.port);
  assert.equal((await get(b.port, '/')).body, 'site B');
  assert.equal((await get(a.port, '/')).body, 'site A');
  // A newer recreate of the same project replaces that project's preview only.
  const a2 = await startPreview({ projectId: 'pa', recreateId: 'ra2', root: path.join(root, 'b') });
  assert.equal(activePreview('pa').recreateId, 'ra2');
  assert.equal((await get(a2.port, '/')).body, 'site B');
  assert.equal(activePreview('pb').port, b.port);

  // A port that is taken is skipped.
  const blocker = await servePreview(path.join(root, 'a'), { port: b.port + 1 <= PREVIEW_PORTS.last ? b.port + 1 : PREVIEW_PORTS.first });
  try {
    await stopPreview();
    const c = await startPreview({ projectId: 'pc', recreateId: 'rc', root: path.join(root, 'b') });
    assert.notEqual(c.port, blocker.port);
  } finally {
    await blocker.close();
  }

  // Stop filters by project / recreate; a missing build is refused.
  assert.equal(await stopPreview({ projectId: 'other' }), false);
  assert.equal(await stopPreview({ projectId: 'pc', recreateId: 'rc' }), true);
  assert.equal(activePreview(), null);
  await assert.rejects(startPreview({ projectId: 'pd', recreateId: 'rd', root: path.join(root, 'none') }), /no production build/);
  assert.equal(activePreview(), null);
});

test('preview routes start, report and stop the preview of the latest completed recreate', async () => {
  const app = express();
  app.use('/api/projects', recreateRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;
  try {
    const id = randomUUID();
    projectIds.push(id);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'p', 'https://example.com/', 'html', 1, ?, ?)`).run(id, now, now);

    assert.equal((await fetch(`${base}/${id}/preview`, { method: 'POST' })).status, 404); // nothing recreated yet
    const recreateId = randomUUID();
    db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at) VALUES (?, ?, 'done', 100, ?, ?)`).run(recreateId, id, now, now);
    await writeTree(path.join(recreateDir(id, recreateId), 'dist'), { 'index.html': 'the build' });

    const started = await (await fetch(`${base}/${id}/preview`, { method: 'POST' })).json();
    assert.equal(started.preview.recreateId, recreateId);
    assert.equal(await (await fetch(started.preview.url)).text(), 'the build');
    assert.deepEqual(await (await fetch(`${base}/${id}/preview`)).json(), started);
    assert.deepEqual(await (await fetch(`${base}/${randomUUID()}/preview`)).json().catch(() => null), { error: 'Project not found.' });

    assert.equal((await fetch(`${base}/${id}/preview`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await (await fetch(`${base}/${id}/preview`)).json(), { preview: null });
  } finally {
    server.close();
  }
});

test('capture screenshots of a completed recreate are served per page, and nothing else', async () => {
  const app = express();
  app.use('/api/projects', recreateRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;
  try {
    const now = new Date().toISOString();
    const makeProject = () => {
      const id = randomUUID();
      projectIds.push(id);
      db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'p', 'https://example.com/', 'html', 1, ?, ?)`).run(id, now, now);
      return id;
    };
    const id = makeProject();
    const other = makeProject();
    const recreateId = randomUUID();
    // An older report without page slugs: GET /recreate fills them in.
    const report = { recreateId, pages: [{ path: '/', outPath: 'index.html' }, { path: '/blog/post', outPath: 'blog/post/index.html' }] };
    db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`).run(recreateId, id, now, now, JSON.stringify(report));
    const running = randomUUID();
    db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at) VALUES (?, ?, 'running', 10, ?)`).run(running, id, now);
    const dir = recreateDir(id, recreateId);
    await writeTree(dir, { 'capture/index/desktop-full.webp': 'WEBP-home', 'capture/blog__post/mobile-fold.webp': 'WEBP-post', 'report.json': '{"secret":1}' });
    await writeTree(recreateDir(id, running), { 'capture/index/desktop-full.webp': 'WEBP-running' });

    const latest = await (await fetch(`${base}/${id}/recreate`)).json();
    assert.deepEqual(latest.result.pages.map((p) => p.slug), ['index', 'blog__post']);

    const home = await fetch(`${base}/${id}/recreate/${recreateId}/captures/index/desktop-full.webp`);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('content-type'), 'image/webp');
    assert.equal(await home.text(), 'WEBP-home');
    assert.equal(await (await fetch(`${base}/${id}/recreate/${recreateId}/captures/blog__post/mobile-fold.webp`)).text(), 'WEBP-post');

    for (const bad of [
      `${id}/recreate/${recreateId}/captures/index/desktop-full.png`, // not a capture screenshot name
      `${id}/recreate/${recreateId}/captures/index/desktop.json`,
      `${id}/recreate/${recreateId}/captures/..%2F..%2Freport.json/desktop-full.webp`, // encoded path tricks
      `${id}/recreate/${recreateId}/captures/%2E%2E/desktop-full.webp`,
      `${id}/recreate/${recreateId}/captures/blog__post/desktop-full.webp`, // file does not exist
      `${other}/recreate/${recreateId}/captures/index/desktop-full.webp`, // another project's recreate
      `${id}/recreate/${running}/captures/index/desktop-full.webp`, // not completed
    ]) {
      const res = await fetch(`${base}/${bad}`);
      assert.equal(res.status, 404, bad);
      assert.doesNotMatch(await res.text(), /secret|WEBP/);
    }
  } finally {
    server.close();
  }
});
