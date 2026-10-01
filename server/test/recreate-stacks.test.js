// Recreate 6.2: stack foundation — emitter registry, the shared IR walker, writeProject, toolchain
// status, report outputs and export from the saved IR (no recapture).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import { getEmitter, isReadyStack, listStacks, registerEmitter, stackIds, unregisterEmitter } from '../src/recreate/emit/index.js';
import { emitSite } from '../src/recreate/emit/html.js';
import { describeNode, headTags, refValue, relativeRefs } from '../src/recreate/emit/walk.js';
import { writeProject } from '../src/recreate/emit/write.js';
import { RecreateError } from '../src/recreate/errors.js';
import { reportOutputs } from '../src/recreate/export/fromIr.js';
import { recreateDir } from '../src/recreate/workspace.js';
import recreateRouter from '../src/routes/recreate.js';
import stacksRouter from '../src/routes/stacks.js';
import { STACKS } from '../src/routes/projects.js';
import { toolchainStatus } from '../src/toolchains/index.js';

const exists = (p) => access(p).then(() => true, () => false);
const temps = [];
const projectIds = [];
const registered = [];
after(async () => {
  for (const id of registered) unregisterEmitter(id);
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-stacks-'));
  temps.push(dir);
  return dir;
};
async function writeTree(root, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

test('the registry lists every stack: html, react-vite and nextjs are ready, mern is planned', () => {
  assert.deepEqual(stackIds(), ['html', 'react-vite', 'nextjs', 'mern']);
  assert.deepEqual(STACKS, stackIds()); // projects accept exactly the registered stacks
  assert.equal(isReadyStack('html'), true);
  for (const id of ['react-vite', 'nextjs']) assert.equal(isReadyStack(id), true);
  assert.equal(isReadyStack('mern'), false);
  assert.equal(isReadyStack('nope'), false);
  assert.equal(getEmitter('nope'), null);
  const list = listStacks();
  assert.equal(list.length, 4);
  assert.ok(list.every((s) => Object.values(s).every((v) => typeof v !== 'function')));
  assert.deepEqual(list.find((s) => s.id === 'nextjs'), { id: 'nextjs', label: 'Next.js', status: 'ready', toolchain: 'next', scripts: 'inline' });
  assert.deepEqual(list.find((s) => s.id === 'mern'), { id: 'mern', label: 'MERN', status: 'planned', toolchain: 'react-vite', scripts: true });
  assert.equal(getEmitter('html').scripts, false);
  assert.equal(getEmitter('html').assetsTarget, 'assets');
  assert.deepEqual([getEmitter('react-vite').scripts, getEmitter('react-vite').assetsTarget], [true, 'public/assets']);
});

test('refValue resolves every reference kind through the emitter-supplied targets', () => {
  const used = [];
  const refs = { ...relativeRefs('about/index.html', (f) => used.push(f)), };
  assert.equal(refValue('plain', refs), 'plain');
  assert.equal(refValue({ asset: 'images/a.png' }, refs), '../assets/images/a.png');
  assert.equal(refValue([{ asset: 'images/a.png', d: '1x' }, { asset: 'images/b.png', d: '2x' }], refs), '../assets/images/a.png 1x, ../assets/images/b.png 2x');
  assert.equal(refValue({ page: 'index.html', hash: '#x' }, refs), '../#x');
  assert.equal(refValue({ page: 'team/index.html' }, refs), '../team/');
  assert.equal(refValue({ anchor: '#top' }, refs), '#top');
  assert.equal(refValue({ live: 'https://a.test/x' }, refs), 'https://a.test/x');
  assert.equal(refValue({ external: 'mailto:a@b.test' }, refs), 'mailto:a@b.test');
  assert.deepEqual(used, ['images/a.png', 'images/a.png', 'images/b.png']);
  // A different target scheme (an app serving assets from the root) changes only the refs.
  const root = { ...refs, assetHref: (f) => `/assets/${f}` };
  assert.equal(refValue({ asset: 'x.png' }, root), '/assets/x.png');
});

test('describeNode gives plain data for text, svg and elements', () => {
  const refs = relativeRefs('index.html');
  assert.deepEqual(describeNode({ text: 'hi' }, refs), { kind: 'text', text: 'hi' });
  const svg = describeNode({ t: 'svg', raw: '<svg><use href="asset:icons/a.svg#i"/></svg>', class: 'logo', sid: 's1' }, refs);
  assert.deepEqual([svg.kind, svg.markup, svg.class, svg.sid], ['svg', '<svg><use href="assets/icons/a.svg#i"/></svg>', 'logo', 's1']);
  const el = describeNode({
    t: 'img', id: 'hero', class: 'card-image', sid: 's2', b: true,
    attrs: { src: { asset: 'images/a.png' }, alt: '', hidden: '', loading: 'lazy' }, children: [{ text: 'x' }],
  }, refs);
  assert.equal(el.tag, 'img');
  assert.equal(el.block, true);
  assert.deepEqual(el.attrs, [
    { name: 'src', value: 'assets/images/a.png', bare: false },
    { name: 'alt', value: '', bare: false }, // meaningful when empty
    { name: 'hidden', value: '', bare: true }, // boolean attribute
    { name: 'loading', value: 'lazy', bare: false },
  ]);
  assert.deepEqual(el.children, [{ text: 'x' }]);
});

const IR_PAGE = {
  outPath: 'index.html',
  head: {
    lang: 'en', title: 'Home', description: 'Desc', canonical: 'https://x.test/',
    meta: [{ property: 'og:title', content: 'Home' }, { name: 'robots', content: '' }],
    alternates: [{ hreflang: 'fr', href: 'https://x.test/fr' }, { hreflang: 'de', href: '/de' }],
    icons: [{ rel: 'icon', asset: 'icons/f.png', sizes: '32x32', type: 'image/png' }],
    preload: [{ asset: 'fonts/f.woff2', as: 'font', type: 'font/woff2' }],
    jsonLd: ['{"@type":"Thing","name":"\u003cb\u003e"}', 'not json'],
  },
  html: {},
  body: { t: 'body', children: [{ t: 'main', b: true, class: 'page', children: [{ t: 'h1', children: [{ text: 'Hi & <you>' }] }] }] },
};

test('headTags lists the head as data, in order; the stylesheet can be left to the stack', () => {
  const used = [];
  const tags = headTags(IR_PAGE, relativeRefs('index.html', (f) => used.push(f)));
  assert.deepEqual(tags.map((t) => t.tag), ['meta', 'meta', 'title', 'meta', 'link', 'meta', 'meta', 'link', 'link', 'link', 'link', 'script', 'script']);
  assert.deepEqual(tags.find((t) => t.tag === 'title'), { tag: 'title', attrs: [], text: 'Home' });
  assert.deepEqual(tags.filter((t) => t.attrs[0]?.[1] === 'alternate').length, 1); // only absolute http(s) alternates
  assert.deepEqual(tags.find((t) => t.attrs[0]?.[1] === 'preload').attrs, [['rel', 'preload'], ['href', 'assets/fonts/f.woff2'], ['as', 'font'], ['type', 'font/woff2'], ['crossorigin', null]]);
  assert.equal(tags.find((t) => t.role === 'stylesheet').attrs[1][1], 'css/site.css');
  assert.deepEqual(used, ['icons/f.png', 'fonts/f.woff2']);
  const app = headTags(IR_PAGE, { ...relativeRefs('index.html'), stylesheetHref: () => null });
  assert.equal(app.some((t) => t.role === 'stylesheet'), false);
});

test('the HTML emitter writes the described head and body (golden output)', () => {
  const ir = { pages: [IR_PAGE], files: [{ path: 'robots.txt', content: 'x' }], fontFaces: [], keyframes: [], tokens: {}, rules: [], breakpoints: { tablet: 1023.98, mobile: 767.98 } };
  const out = emitSite(ir);
  const html = out.files.get('index.html');
  assert.equal(html, [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Home</title>',
    '  <meta name="description" content="Desc">',
    '  <link rel="canonical" href="https://x.test/">',
    '  <meta property="og:title" content="Home">',
    '  <meta name="robots" content="">',
    '  <link rel="alternate" hreflang="fr" href="https://x.test/fr">',
    '  <link rel="icon" href="assets/icons/f.png" sizes="32x32" type="image/png">',
    '  <link rel="preload" href="assets/fonts/f.woff2" as="font" type="font/woff2" crossorigin>',
    '  <link rel="stylesheet" href="css/site.css">',
    '  <script type="application/ld+json">{"@type":"Thing","name":"\\u003cb\\u003e"}</script>',
    '</head>',
    '<body>',
    '  <main class="page"><h1>Hi &amp; &lt;you&gt;</h1></main>',
    '</body>',
    '</html>',
    '',
  ].join('\n'));
  assert.ok(html.includes('<h1>Hi &amp; &lt;you&gt;</h1>'));
  assert.deepEqual([...out.assets].sort(), ['fonts/f.woff2', 'icons/f.png']);
  assert.equal(out.files.get('robots.txt'), 'x');
  assert.ok(out.files.has('css/site.css'));
});

test('writeProject writes files, links only the known assets, and honours the assets folder', async () => {
  const root = await tempDir();
  const assetsDir = path.join(root, 'assets-src');
  await writeTree(assetsDir, { 'images/a.png': 'A', 'images/b.png': 'B' });
  const out = { files: new Map([['src/App.jsx', 'x'], ['index.html', 'y']]), assets: new Set(['images/a.png', 'images/missing.png', 'images/b.png']) };
  const project = path.join(root, 'project');
  await writeProject(project, out, { assetsDir, known: new Set(['images/a.png', 'images/b.png']), assetsTarget: 'public/assets' });
  assert.equal(await readFile(path.join(project, 'src', 'App.jsx'), 'utf8'), 'x');
  assert.equal(await readFile(path.join(project, 'public', 'assets', 'images', 'a.png'), 'utf8'), 'A');
  assert.equal(await exists(path.join(project, 'public', 'assets', 'images', 'missing.png')), false);
  // Run again over the same folder: existing links are fine.
  await writeProject(project, out, { assetsDir, known: new Set(['images/a.png']), assetsTarget: 'public/assets' });
  assert.ok((await stat(path.join(project, 'public', 'assets', 'images', 'b.png'))).isFile());
});

test('toolchain status reads the pinned packages; unknown or unsafe ids are not defined', async () => {
  const known = await toolchainStatus('react-vite');
  assert.equal(known.defined, true);
  assert.equal(known.installed, known.missing.length === 0);
  assert.match(known.setup, /setup:toolchains .*react-vite$/);
  assert.equal((await toolchainStatus('next')).defined, true);
  assert.deepEqual(await toolchainStatus('nope').then((s) => [s.defined, s.installed]), [false, false]);
  for (const id of ['../react-vite', 'React', '']) {
    const s = await toolchainStatus(id);
    assert.deepEqual([s.defined, s.installed, s.dir], [false, false, null]); // never builds a path from it
  }
});

test('reportOutputs: reports from before Phase 6 know their own stack only', () => {
  assert.deepEqual(reportOutputs({ stack: 'html' }), { html: { status: 'ready', dir: 'dist' } });
  assert.deepEqual(reportOutputs({}), { html: { status: 'ready', dir: 'dist' } });
  assert.deepEqual(reportOutputs({ stack: 'html', outputs: { html: { status: 'ready', dir: 'dist' }, x: { status: 'ready' } } }).x, { status: 'ready' });
});

async function serve() {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', recreateRouter);
  app.use('/api/stacks', stacksRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}/api` };
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('export from the saved IR: emit, write, record the output; idempotent; failures leave nothing', async () => {
  const { server, base } = await serve();
  let calls = 0;
  const fake = (id, extra = {}) => {
    registered.push(id);
    registerEmitter({
      id, label: `Fake ${id}`, status: 'ready', assetsTarget: 'public/assets',
      emit: (ir) => {
        calls++;
        return { files: new Map([['package.json', `{"pages":${ir.pages.length}}`], ['src/App.jsx', 'app']]), assets: new Set(['images/a.png', 'images/never-downloaded.png']) };
      },
      ...extra,
    });
  };
  fake('fake-ok', { build: async ({ dir, out }) => ({ built: true, buildFiles: out.files.size, sawDir: await exists(dir) }) });
  fake('fake-fail', { build: async () => { throw new RecreateError('The build failed on src/App.jsx.'); } });
  fake('fake-tool', { toolchain: 'no-such-toolchain' });
  try {
    const id = randomUUID();
    projectIds.push(id);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'p', 'https://example.com/', 'html', 1, ?, ?)`).run(id, now, now);
    const recreateId = randomUUID();
    const report = { recreateId, stack: 'html', outputs: { html: { status: 'ready', dir: 'dist' } }, pages: [{ outPath: 'index.html' }], safety: { safe: true } };
    db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`).run(recreateId, id, now, now, JSON.stringify(report));
    const dir = recreateDir(id, recreateId);
    await writeTree(dir, {
      'ir/site.json': JSON.stringify({ pages: [{}, {}], files: [] }),
      'assets/manifest.json': JSON.stringify({ files: [{ file: 'images/a.png' }] }),
      'assets/images/a.png': 'PNG',
      'report.json': JSON.stringify(report),
    });
    const url = `${base}/projects/${id}/recreate/${recreateId}/export`;

    // html is the reference output: nothing to emit.
    const html = await post(url, { stack: 'html' });
    assert.equal(html.status, 200);
    assert.equal((await html.json()).created, false);

    // A stack that is not built yet, an unknown one, bad input and a missing toolchain.
    const planned = await post(url, { stack: 'mern' });
    assert.equal(planned.status, 409);
    assert.match((await planned.json()).error, /MERN stack is not available yet/);
    assert.equal((await post(url, { stack: 'nope' })).status, 400);
    assert.equal((await post(url, {})).status, 400);
    const tool = await post(url, { stack: 'fake-tool' });
    assert.equal(tool.status, 409);
    assert.match((await tool.json()).error, /toolchain is not installed\. Run: npm run setup:toolchains/);
    assert.equal((await post(`${base}/projects/${id}/recreate/not-a-uuid/export`, { stack: 'fake-ok' })).status, 404);
    assert.equal((await post(`${base}/projects/${id}/recreate/${randomUUID()}/export`, { stack: 'fake-ok' })).status, 404);
    assert.equal(calls, 0); // none of the refusals reached an emitter

    // A successful export.
    const ok = await post(url, { stack: 'fake-ok' });
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.created, true);
    assert.equal(body.output.dir, 'stacks/fake-ok');
    assert.equal(body.output.from, 'ir');
    assert.deepEqual([body.output.built, body.output.buildFiles, body.output.sawDir], [true, 2, true]);
    assert.equal(await readFile(path.join(dir, 'stacks', 'fake-ok', 'package.json'), 'utf8'), '{"pages":2}');
    assert.equal(await readFile(path.join(dir, 'stacks', 'fake-ok', 'public', 'assets', 'images', 'a.png'), 'utf8'), 'PNG');
    assert.equal(await exists(path.join(dir, 'stacks', 'fake-ok', 'public', 'assets', 'images', 'never-downloaded.png')), false);
    assert.equal(await exists(path.join(dir, 'stacks', 'fake-ok.tmp')), false);
    const stored = JSON.parse(db.prepare('SELECT result_json FROM recreates WHERE id = ?').get(recreateId).result_json);
    assert.deepEqual(Object.keys(stored.outputs), ['html', 'fake-ok']);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')).outputs['fake-ok'].dir, 'stacks/fake-ok');

    // Idempotent: the existing output, no second emit.
    const again = await post(url, { stack: 'fake-ok' });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).created, false);
    assert.equal(calls, 1);

    // A failing build: the message reaches the user, no folder, no output entry.
    const fail = await post(url, { stack: 'fake-fail' });
    assert.equal(fail.status, 500);
    assert.equal((await fail.json()).error, 'The build failed on src/App.jsx.');
    assert.equal(await exists(path.join(dir, 'stacks', 'fake-fail')), false);
    assert.equal(await exists(path.join(dir, 'stacks', 'fake-fail.tmp')), false);
    const afterFail = JSON.parse(db.prepare('SELECT result_json FROM recreates WHERE id = ?').get(recreateId).result_json).outputs;
    assert.deepEqual(Object.keys(afterFail), ['html', 'fake-ok', 'fake-fail']);
    assert.deepEqual([afterFail['fake-fail'].status, afterFail['fake-fail'].error], ['failed', 'The build failed on src/App.jsx.']); // remembered, so the app can say why

    // The IR gone (retention): a clear message.
    await rm(path.join(dir, 'ir'), { recursive: true });
    fake('fake-late');
    const gone = await post(url, { stack: 'fake-late' });
    assert.equal(gone.status, 404);
    assert.match((await gone.json()).error, /saved IR .* is gone/);

    // The stack list the app reads.
    const stacks = (await (await fetch(`${base}/stacks`)).json()).stacks;
    assert.equal(stacks.find((s) => s.id === 'html').toolchainInstalled, true);
    const next = stacks.find((s) => s.id === 'mern');
    assert.equal(next.status, 'planned');
    assert.equal(typeof next.toolchainInstalled, 'boolean');
  } finally {
    server.close();
    while (registered.length) unregisterEmitter(registered.pop());
  }
});

test('Recreate refuses a stack that is not ready, naming the ones that are', async () => {
  const { server, base } = await serve();
  try {
    const id = randomUUID();
    projectIds.push(id);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'p', 'https://example.com/', 'mern', 1, ?, ?)`).run(id, now, now);
    const res = await post(`${base}/projects/${id}/recreate`, {});
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /^Only Plain HTML \/ CSS \/ JS, React \+ Vite, Next\.js can be recreated for now/);
  } finally {
    server.close();
  }
});
