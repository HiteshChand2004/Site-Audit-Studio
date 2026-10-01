// Recreate 6.5: the MERN emitter — form detection and rewiring, project files, the generated server (validation, the
// MongoDB store against a stand-in driver, limits), and (when the mern toolchain is installed) a real export: the
// client build checked against the HTML build, the generated server tests run, the project zip.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import { emitSite } from '../src/recreate/emit/html.js';
import { describeForm, collectForms } from '../src/recreate/emit/mern/forms.js';
import { emitMern } from '../src/recreate/emit/mern/index.js';
import { writeProject } from '../src/recreate/emit/write.js';
import { planZip } from '../src/recreate/export/zip.js';
import { recreateDir } from '../src/recreate/workspace.js';
import recreateRouter from '../src/routes/recreate.js';
import { toolchainDir, toolchainStatus } from '../src/toolchains/index.js';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'recreate', 'emit', 'mern', 'template', 'server');
const exists = (p) => access(p).then(() => true, () => false);
const temps = [];
const projectIds = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-mern-'));
  temps.push(dir);
  return dir;
};
async function writeTree(root, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

let sid = 0;
const el = (t, props = {}, ...children) => ({ t, sid: ++sid, attrs: {}, children, ...props });
const text = (t) => ({ text: t });
const input = (attrs) => el('input', { attrs });

test('a form that collects text gets a definition; login, search and upload forms are left alone', () => {
  const contact = el('form', { b: 1, attrs: { method: 'post', enctype: 'multipart/form-data' } },
    input({ name: 'name', type: 'text', required: '', maxlength: '40' }),
    input({ name: 'email', type: 'email' }),
    input({ name: 'age', type: 'number', min: '18', max: '99' }),
    input({ name: 'token', type: 'hidden', value: 'x' }), // never stored
    input({ type: 'text' }), // no name
    input({ name: 'plan', type: 'radio', value: 'a', required: '' }), input({ name: 'plan', type: 'radio', value: 'b' }),
    input({ name: 'tags', type: 'checkbox', value: 'x' }), input({ name: 'tags', type: 'checkbox', value: 'y' }),
    input({ name: 'agree', type: 'checkbox' }),
    input({ name: 'news', type: 'checkbox', value: 'yes' }),
    el('select', { attrs: { name: 'topic', multiple: '' } }, el('option', { attrs: { value: 'a' } }, text('A')), el('option', {}, text('Other'))),
    el('textarea', { attrs: { name: 'message', maxlength: '500' } }),
    el('button', { attrs: { type: 'submit' } }, text('Send')));
  assert.deepEqual(describeForm(contact).fields, [
    { name: 'name', type: 'text', required: true, maxLength: 40 },
    { name: 'email', type: 'email', required: false },
    { name: 'age', type: 'number', required: false, min: 18, max: 99 },
    { name: 'plan', type: 'radio', options: ['a', 'b'], required: true },
    { name: 'tags', type: 'checkbox', options: ['x', 'y'], required: false, multiple: true },
    { name: 'agree', type: 'checkbox', required: false },
    { name: 'news', type: 'checkbox', required: false, value: 'yes' },
    { name: 'topic', type: 'select', options: ['a', 'Other'], multiple: true, required: false },
    { name: 'message', type: 'textarea', required: false, maxLength: 500 },
  ]);
  assert.match(describeForm(el('form', {}, input({ name: 'u' }), input({ name: 'p', type: 'password' }))).skip, /login/);
  assert.match(describeForm(el('form', {}, input({ name: 'f', type: 'file' }))).skip, /upload/);
  assert.match(describeForm(el('form', { attrs: { method: 'get' } }, input({ name: 'q' }))).skip, /GET/);
  assert.match(describeForm(el('form', { attrs: { role: 'search' } }, input({ name: 'q' }))).skip, /search/);
  assert.match(describeForm(el('form', {}, input({ name: 'q', type: 'search' }))).skip, /search/);
  assert.match(describeForm(el('form', {}, input({ type: 'text' }), el('button', {}, text('Go')))).skip, /without named fields/);
});

const page = (outPath, ...content) => ({
  outPath,
  head: { lang: 'en', title: outPath, description: 'd', canonical: `https://www.example.com/${outPath}`, meta: [], alternates: [], icons: [], preload: [], jsonLd: [] },
  html: {},
  body: el('body', { class: 'page' }, ...content),
});
const contactForm = () => el('form', { b: 1, attrs: { method: 'post', enctype: 'multipart/form-data', target: '_blank' } },
  el('label', { attrs: { for: 'n' } }, text('Name')), input({ id: 'n', name: 'name', type: 'text', required: '' }),
  input({ name: 'email', type: 'email' }), el('textarea', { attrs: { name: 'message' } }), el('button', { attrs: { type: 'submit' } }, text('Send')));
const loginForm = () => el('form', {}, input({ name: 'user' }), input({ name: 'pass', type: 'password' }));
const searchForm = () => el('form', { attrs: { role: 'search' } }, input({ name: 'q', type: 'search' }));

const irOf = (pages, files = []) => ({
  version: 1, baseUrl: 'https://www.example.com', siteName: 'Example', pages, tokens: {}, rules: [], fontFaces: [], keyframes: [],
  breakpoints: { tablet: 1023.98, mobile: 767.98 }, files,
});

test('collectForms rewires stored forms on a copy, numbers them per page and reports the rest', () => {
  const ir = irOf([
    page('index.html', el('main', { b: 1 }, searchForm(), contactForm())),
    page('contact/index.html', el('main', { b: 1 }, loginForm(), contactForm(), contactForm())),
  ]);
  const before = JSON.stringify(ir);
  const { ir: copy, forms, skipped } = collectForms(ir);
  assert.equal(JSON.stringify(ir), before); // the original IR is not touched
  assert.deepEqual(forms.map((f) => [f.id, f.page, f.fields.length]), [['home-2', '/', 3], ['contact-2', '/contact/', 3], ['contact-3', '/contact/', 3]]);
  assert.deepEqual(skipped.map((s) => s.page), ['/', '/contact/']);
  const stored = copy.pages[0].body.children[0].children[1];
  assert.deepEqual([stored.attrs.action, stored.attrs.method, 'enctype' in stored.attrs, stored.attrs.target], ['/api/forms/home-2', 'post', false, '_blank']);
  assert.equal('action' in copy.pages[0].body.children[0].children[0].attrs, false); // the search form
});

test('emitMern: a React client under client/, the fixed server, forms.json and the root files', () => {
  const ir = irOf([
    page('index.html', el('main', { b: 1 }, el('h1', {}, text('Home')))),
    page('contact.html', el('main', { b: 1 }, contactForm(), loginForm())),
  ], [{ path: 'robots.txt', content: 'User-agent: *' }]);
  const out = emitMern(ir);
  const keys = [...out.files.keys()];
  for (const f of ['client/package.json', 'client/src/pages/Contact.jsx', 'client/src/styles/site.css', 'client/public/robots.txt', 'client/scripts/prerender.mjs',
    'server/package.json', 'server/forms.json', 'server/src/app.js', 'server/src/forms.js', 'server/src/store.js', 'server/src/limiter.js', 'server/src/index.js',
    'server/test/app.test.js', 'server/test/forms.test.js', 'server/test/store.test.js', 'server/test/site.test.js', 'server/.env.example', 'server/.gitignore',
    'package.json', 'README.md', '.gitignore', 'docker-compose.yml']) assert.ok(keys.includes(f), f);
  assert.deepEqual(keys.filter((f) => !/^(client|server)\//.test(f) && !/^(package\.json|README\.md|\.gitignore|docker-compose\.yml)$/.test(f)), []);
  // The client posts the stored form to the server; the login form is untouched.
  const contact = out.files.get('client/src/pages/Contact.jsx');
  assert.match(contact, /<form action="\/api\/forms\/contact-1" method="post"/);
  assert.equal((contact.match(/action=/g) ?? []).length, 1);
  assert.deepEqual(JSON.parse(out.files.get('server/forms.json')), [{
    id: 'contact-1', page: '/contact.html',
    fields: [{ name: 'name', type: 'text', required: true }, { name: 'email', type: 'email', required: false }, { name: 'message', type: 'textarea', required: false }],
  }]);
  const pkg = JSON.parse(out.files.get('server/package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['compression', 'express', 'mongodb']);
  assert.ok(Object.values(pkg.dependencies).every((v) => /^\d+\.\d+\.\d+$/.test(v))); // pinned
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(JSON.parse(out.files.get('package.json')).scripts['install:all'], 'npm install --prefix client && npm install --prefix server');
  assert.match(out.files.get('README.md'), /`contact-1` on `\/contact\.html` — name, email, message/);
  assert.match(out.files.get('README.md'), /`\/contact\.html` — a login form/);
  assert.match(out.files.get('README.md'), /Without `MONGODB_URI`/);
  assert.deepEqual([out.stats.forms, out.stats.skippedForms], [1, 1]);
  assert.equal(out.assets instanceof Set, true);
});

test('the generated validator and MongoDB store (stand-in driver) work as shipped', async () => {
  const { validateSubmission } = await import(pathToFileURL(path.join(TEMPLATE, 'src', 'forms.js')));
  const { createMongoStore, createMemoryStore, disabledStore } = await import(pathToFileURL(path.join(TEMPLATE, 'src', 'store.js')));
  const form = { id: 'f', fields: [{ name: 'email', type: 'email', required: true }, { name: 'note', type: 'textarea' }] };
  assert.deepEqual(validateSubmission(form, { email: 'a@b.test', note: ' hi ', extra: 1 }).values, { email: 'a@b.test', note: 'hi' });
  assert.deepEqual(validateSubmission(form, { email: 'nope' }).errors, { email: 'must be an email address' });
  assert.deepEqual(validateSubmission(form, { email: { $ne: 1 } }).errors, { email: 'must be text' });

  const calls = [];
  class MongoClient {
    constructor(uri) { calls.push(['new', uri]); }
    async connect() { calls.push(['connect']); }
    db(name) { calls.push(['db', name]); return { collection: (c) => { calls.push(['collection', c]); return { createIndex: async (i) => calls.push(['index', i]), insertOne: async (d) => { calls.push(['insert', d]); return { insertedId: 'abc' }; } }; } }; }
    async close() { calls.push(['close']); }
  }
  const store = await createMongoStore({ uri: 'mongodb://x', dbName: 'd', collection: 'c', MongoClient });
  assert.equal(await store.insert({ formId: 'f', values: { email: 'a@b.test' } }), 'abc');
  await store.close();
  assert.deepEqual(calls.map((c) => c[0]), ['new', 'connect', 'db', 'collection', 'index', 'insert', 'close']);
  assert.equal(createMemoryStore().enabled, true);
  assert.equal(disabledStore().enabled, false);
});

// ---- the generated server's own tests, and a real export (need the mern toolchain) ----

const installed = async () => (await toolchainStatus('mern')).installed;

test('the generated server tests pass as shipped', { timeout: 120000 }, async (t) => {
  if (!(await installed())) return t.skip('mern toolchain not installed');
  const dir = await tempDir();
  await cp(TEMPLATE, path.join(dir, 'server'), { recursive: true });
  await writeFile(path.join(dir, 'server', 'package.json'), '{"name":"t","type":"module","version":"0.0.0"}');
  await writeFile(path.join(dir, 'server', 'forms.json'), '[]');
  await symlink(path.join(toolchainDir('mern'), 'node_modules'), path.join(dir, 'server', 'node_modules'), 'junction');
  // Not inside this test run's context: a nested `node --test` would report to it instead of printing.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test'], { cwd: path.join(dir, 'server'), encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stdout.slice(-1500));
  assert.match(run.stdout, /# fail 0/);
  assert.match(run.stdout, /# pass 1[4-9]|# pass [2-9]\d/);
  // Not built yet: the built-site test is skipped, not failed.
  assert.match(run.stdout, /# skipped 1/);
});

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('real export: client verified against the HTML build, server tests run, forms wired, zip and preview', { timeout: 300000 }, async (t) => {
  if (!(await installed())) return t.skip('mern toolchain not installed');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', recreateRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;
  try {
    const pages = [
      page('index.html', el('main', { b: 1 }, el('h1', {}, text('Home')), el('img', { attrs: { src: { asset: 'images/a.png' }, alt: 'A' } }), searchForm())),
      page('contact.html', el('main', { b: 1 }, el('h1', {}, text('Contact')), contactForm(), loginForm())),
    ];
    const ir = irOf(pages, [{ path: 'robots.txt', content: 'User-agent: *\n' }]);
    const id = randomUUID();
    projectIds.push(id);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'p', 'https://www.example.com/', 'mern', 1, ?, ?)`).run(id, now, now);
    const recreateId = randomUUID();
    const dir = recreateDir(id, recreateId);
    await writeTree(dir, { 'assets/images/a.png': TINY_PNG, 'assets/manifest.json': JSON.stringify({ files: [{ file: 'images/a.png' }] }), 'ir/site.json': JSON.stringify(ir) });
    await writeProject(path.join(dir, 'dist'), emitSite(ir), { assetsDir: path.join(dir, 'assets'), known: new Set(['images/a.png']) });
    const report = {
      recreateId, stack: 'mern', outputs: { html: { status: 'ready', dir: 'dist' } }, pages: pages.map((p) => ({ outPath: p.outPath })),
      safety: { safe: true }, fidelity: { score: 90, threshold: 80 }, baseUrl: 'https://www.example.com', warnings: [],
    };
    db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`).run(recreateId, id, now, now, JSON.stringify(report));

    const res = await fetch(`${base}/${id}/recreate/${recreateId}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack: 'mern' }) });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    const out = body.output;
    assert.deepEqual([out.status, out.dir, out.dist], ['ready', 'stacks/mern', 'client/dist']);
    assert.deepEqual(out.equivalence.dom, { equal: 2, total: 2 });
    assert.ok(out.equivalence.visual.min >= 0.97);
    assert.deepEqual([out.hydration.checked, out.hydration.failed], [2, 0], JSON.stringify(out.hydration));
    assert.deepEqual(out.forms.stored, [{ id: 'contact-1', page: '/contact.html', fields: 3 }]);
    assert.deepEqual(out.forms.skipped.map((s) => s.page).sort(), ['/', '/contact.html']);
    assert.ok(out.server.tests.pass >= 15 && out.server.tests.fail === 0 && out.server.tests.skipped === 0, JSON.stringify(out.server)); // the site test ran against the build
    assert.equal(out.fidelity.basis, 'equivalent-to-html');
    assert.ok(out.warnings.some((w) => /store submissions in MongoDB|stores submissions in MongoDB/.test(w)));

    const project = path.join(dir, 'stacks', 'mern');
    for (const f of ['client/dist/index.html', 'client/dist/contact.html', 'client/dist/robots.txt', 'client/dist/assets/images/a.png', 'server/forms.json', 'server/src/app.js']) assert.equal(await exists(path.join(project, f)), true, f);
    for (const f of ['client/node_modules', 'server/node_modules', 'client/.ssr']) assert.equal(await exists(path.join(project, f)), false, f);
    assert.equal((await toolchainStatus('mern')).installed, true);
    assert.match(await readFile(path.join(project, 'client', 'dist', 'contact.html'), 'utf8'), /<form action="\/api\/forms\/contact-1" method="post"/);
    assert.doesNotMatch(await readFile(path.join(project, 'client', 'dist', 'index.html'), 'utf8'), /action="\/api\/forms/); // the search form is not rewired

    // The zip: sources, not build output or dependencies.
    const plan = await planZip({ dir, report: { ...report, outputs: { ...report.outputs, mern: out } }, stack: 'mern' });
    const names = plan.entries.map((e) => e.name.replace(/^example\.com-mern\//, ''));
    for (const f of ['package.json', 'README.md', 'RECREATE-REPORT.md', 'client/package.json', 'client/public/assets/images/a.png', 'server/package.json', 'server/forms.json', 'server/test/app.test.js', 'server/.env.example']) assert.ok(names.includes(f), f);
    assert.deepEqual(names.filter((f) => /(^|\/)(node_modules|dist|\.ssr)(\/|$)/.test(f)), []);
    assert.match(plan.entries.find((e) => e.name.endsWith('RECREATE-REPORT.md')).content, /Forms: 1 stored in MongoDB .*Server tests: \d+\/\d+ passed/);

    // Preview: the client build with its scripts allowed.
    const preview = await (await fetch(`${base}/${id}/preview`, { method: 'POST' })).json();
    assert.equal(preview.preview.scripts, true);
    assert.equal((await fetch(`${preview.preview.url}contact.html`)).status, 200);
    await fetch(`${base}/${id}/preview`, { method: 'DELETE' });
    const head = await fetch(`${base}/${id}/recreate/${recreateId}/download?stack=mern`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-disposition'), 'attachment; filename="example.com-mern.zip"');
  } finally {
    server.close();
    await import('../src/recreate/preview.js').then((m) => m.stopPreview());
  }
});
