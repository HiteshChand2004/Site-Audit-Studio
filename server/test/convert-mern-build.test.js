// The as-is copy converted into a MERN project (recreate/convert/mern.js: the React + Vite conversion as client/, an Express
// server, the forms in MongoDB) and built with the pinned toolchain, with no browser. The fixture site stands in for a finished
// as-is copy (with the copy's form guard and sas-forms.json), plus one page of forms of every kind and the original's own files
// at the addresses the server and Vite keep for themselves. Checked: client/dist holds the DOM of every as-is page and the
// copy's files byte for byte (sas-forms.json wired), nothing that runs is added; which forms are wired and why the others are
// not, in plain words; the server answers like a static host with the original's files first and stores the wired forms;
// `npm run dev` serves every page byte for byte as the build does, and the forms; DEPLOY.md names only what the package has.
// The browser proof against the original is convert-mern.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildConvertedMern, convertToMern, FORMS_ENDPOINT, formDestination, MERN_EXPORT_DIR, planForms, verifyConvertedMern } from '../src/recreate/convert/mern.js';
import { routeOf } from '../src/recreate/convert/react.js';
import { FORM_GUARD } from '../src/recreate/behavior/preserve/complete.js';
import { SECURITY_HEADERS } from '../src/copy/securityHeaders.js';
import { matchForm, pageFilesOf } from '../src/recreate/convert/mern/server/match.js';
import { toolchainDir, toolchainStatus } from '../src/toolchains/index.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recreate-site');
const ORIGIN = 'https://www.example-original.dev';

const FORMS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Forms</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header"><a href="/">Home</a></header>
  <main>
    <h1>Every kind of form</h1>
    <form id="signup" action="/subscribe" method="post">
      <label for="e">Email</label><input id="e" name="email" type="email" required>
      <input type="checkbox" name="news" checked>
      <select name="plan"><option value="a">A</option><option value="b" selected>B</option></select>
      <input type="hidden" name="token" value="x"><button>Send</button>
    </form>
    <form class="contact" method="post">
      <input name="name" required><textarea name="message" maxlength="500"></textarea><button>Write to us</button>
    </form>
    <textarea name="extra" form="signup">outside the form</textarea>
    <form class="service" action="https://forms.example-service.io/f/abc" method="post"><input name="email" type="email"><input name="company"><button>Join</button></form>
    <form class="mail" action="mailto:hello@example-original.dev" method="post"><input name="subject"><button>Mail</button></form>
    <form class="search" action="/search" method="get" role="search"><input type="search" name="q"><button>Search</button></form>
    <form class="absolute" action="${ORIGIN}/newsletter" method="post"><input name="newsletter-email" type="email"><button>Go</button></form>
  </main>
  <script>${FORM_GUARD}</script>
</body>
</html>
`;

// The original's own files at addresses the server and Vite's development server keep for themselves.
const RESERVED = {
  'api/health': 'the original\'s health file',
  'api/forms/forms-1': 'the original\'s file under the forms address',
  thanks: 'the original\'s thanks file',
  '@vite/client': 'window.originalViteClient = 1;',
  'src/app.js': 'window.originalSrc = 1;',
  '_app/chunk.js': 'window.originalApp = 1;',
};

let root;
let copyDir;
let outDir;
let pages;
let result;
let built;
const junctions = [];

async function listFiles(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out;
}

/** A link to the MERN toolchain's packages (removed by itself, never what it points to). */
async function linkModules(dir) {
  const modules = path.join(dir, 'node_modules');
  await symlink(path.join(toolchainDir('mern'), 'node_modules'), modules, 'junction');
  junctions.push(modules);
}

before(async () => {
  const tc = await toolchainStatus('mern');
  if (!tc.installed) throw new Error('the mern toolchain is not installed: npm run setup:toolchains -w server -- mern');
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-convert-mern-'));
  copyDir = path.join(root, 'copy');
  await cp(FIXTURE, copyDir, { recursive: true });
  await rm(path.join(copyDir, 'private'), { recursive: true, force: true });
  await writeFile(path.join(copyDir, 'forms.html'), FORMS_PAGE, 'utf8');
  // Every page of an as-is copy carries the copy's form guard (complete.js registerServiceWorker), as forms.html does.
  for (const f of (await listFiles(copyDir)).filter((x) => x.endsWith('.html') && x !== 'forms.html')) {
    const file = path.join(copyDir, f);
    await writeFile(file, (await readFile(file, 'utf8')).replace('</body>', `<script>${FORM_GUARD}</script></body>`), 'utf8');
  }
  await writeFile(path.join(copyDir, 'sas-forms.json'), '{\n  "endpoint": ""\n}\n', 'utf8');
  for (const [rel, body] of Object.entries(RESERVED)) {
    await mkdir(path.dirname(path.join(copyDir, rel)), { recursive: true });
    await writeFile(path.join(copyDir, rel), body, 'utf8');
  }
  const files = await listFiles(copyDir);
  pages = files.filter((f) => f.endsWith('.html')).map((outPath) => ({ outPath, url: `${ORIGIN}/${outPath.replace(/(^|\/)index\.html$/, '$1')}` }));
  outDir = path.join(root, 'mern');
  result = await convertToMern({ copyDir, outDir, pages, pageUrl: `${ORIGIN}/` });
  built = await buildConvertedMern(outDir);
  await linkModules(outDir);
});

after(async () => {
  for (const j of junctions) await rmdir(j).catch(() => unlink(j)).catch(() => {});
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
});

test('where a form sent its data on the original, read from its action', () => {
  const page = `${ORIGIN}/contact/`;
  assert.deepEqual(formDestination('', page), { kind: 'own', relative: true });
  assert.equal(formDestination('/subscribe', page).kind, 'own');
  assert.equal(formDestination('thanks.php', page).kind, 'own');
  assert.equal(formDestination('https://example-original.dev/x', page).kind, 'own', 'the bare host and its www. twin are one site');
  assert.equal(formDestination('https://api.framer.com/forms/abc', page).kind, 'service');
  assert.equal(formDestination('//cdn.other.net/f', page).kind, 'service');
  assert.equal(formDestination('mailto:a@b.c', page).kind, 'app');
  assert.equal(formDestination('javascript:void(0)', page).kind, 'script');
});

test('which form a submission is: the page it came from and its fields', () => {
  assert.deepEqual(pageFilesOf('/'), ['index.html']);
  assert.deepEqual(pageFilesOf('/about/'), ['about/index.html']);
  assert.deepEqual(pageFilesOf('/about'), ['about.html', 'about/index.html']);
  assert.deepEqual(pageFilesOf('/about.html'), ['about.html']);
  const forms = [
    { id: 'a-1', file: 'a.html', action: '/x', names: ['email', 'plan'], wired: true },
    { id: 'a-2', file: 'a.html', action: null, names: ['email', 'company'], wired: false },
    { id: 'b-1', file: 'b/index.html', action: '/b/', names: ['name'], wired: true },
  ];
  assert.equal(matchForm(forms, { names: ['email', 'plan'], from: '/a.html' }).id, 'a-1');
  assert.equal(matchForm(forms, { names: ['email', 'company'], from: '/a' }).id, 'a-2');
  assert.equal(matchForm(forms, { names: ['anything'], from: '/b/' }).id, 'b-1', 'the only form of its page');
  assert.equal(matchForm(forms, { names: ['nothing'], from: '/a.html' }), null, 'two forms, no field to tell them apart');
  assert.equal(matchForm(forms, { names: ['name'], from: null }).id, 'b-1', 'no Referer: the fields decide');
  assert.equal(matchForm(forms, { names: ['email'], action: '/x' }).id, 'a-1', 'posted without script to its own action');
});

test('the forms: own-server ones wired to the copy\'s server, the others left as they are, each said in plain words', async () => {
  const forms = JSON.parse(await readFile(path.join(outDir, 'server', 'forms.json'), 'utf8'));
  const byPage = (file) => forms.filter((f) => f.file === file);
  const [signup, contact, service, mail, search, absolute] = byPage('forms.html');
  assert.equal(signup.wired, true);
  assert.equal(signup.action, '/subscribe');
  assert.deepEqual(signup.fields.map((f) => f.name), ['email', 'news', 'plan', 'extra'], 'a control outside the form that belongs to it is one of its fields; a hidden one is not');
  assert.ok(signup.names.includes('token'), 'a hidden field still tells the form apart');
  assert.equal(contact.wired, true);
  assert.equal(contact.action, '/forms.html', 'a form without action posts to its own page');
  assert.equal(service.wired, false);
  assert.match(service.refused, /forms\.example-service\.io/);
  assert.equal(mail.wired, false);
  assert.equal(search.wired, false);
  assert.match(search.refused, /a GET form|a search form/);
  assert.equal(absolute.wired, true, 'an action on the original\'s own host is the original\'s server');
  assert.equal(absolute.action, null, 'without script the browser posts it to the original: no address of this server');
  const [login] = byPage('login.html');
  assert.equal(login.wired, false);
  assert.match(login.refused, /password/);
  const [framer] = byPage('work.html');
  assert.equal(framer.wired, false, 'a builder\'s form service is another service');
  // The report: where each form went on the original and where it goes now.
  const report = result.forms;
  assert.equal(report.length, forms.length);
  const signupWords = report.find((f) => f.label === 'signup');
  assert.equal(signupWords.target, 'the original site (example-original.dev/subscribe)');
  assert.equal(signupWords.goesTo, 'copy-server');
  assert.match(signupWords.note, /copy's own server \(POST \/api\/forms\) and is saved in MongoDB/);
  // Another service's form goes to it in the download, as on the original (the form guard leaves it to the browser).
  const serviceWords = report.find((f) => f.id === service.id);
  assert.equal(serviceWords.goesTo, 'service');
  assert.match(serviceWords.note, /In the downloaded copy it sends its data to forms\.example-service\.io, exactly as the original does\..*The copy's server does not store it\./);
  assert.equal(report.find((f) => f.id === mail.id).goesTo, 'mail-app');
  assert.match(report.find((f) => f.id === login.id).note, /not stored: it is a login form/);
  assert.equal(result.wiredForms, 3);
  // Pure: a copy whose forms are already sent somewhere is left to that.
  const kept = planForms([{ outPath: 'forms.html', url: `${ORIGIN}/forms.html`, html: FORMS_PAGE }], { guardEndpoint: 'https://hooks.example/x' });
  assert.ok(kept.forms.every((f) => !f.wired));
  // A page without the form guard posts a form to its own action: a relative one reaches this server, one on the original does not.
  const bare = planForms([{ outPath: 'forms.html', url: `${ORIGIN}/forms.html`, html: FORMS_PAGE.replace(/<script>[\s\S]*?<\/script>/, '') }], { guardEndpoint: '' });
  assert.equal(bare.forms[0].wired, true);
  assert.equal(bare.forms[5].wired, false);
  assert.match(bare.report[5].note, /posts it to the original site's own address/);
});

test('client/dist holds the DOM of every as-is page and the copy\'s files, with sas-forms.json sending to the copy\'s server', { timeout: 10 * 60000 }, async () => {
  assert.deepEqual(built.steps.map((s) => s.label), ['vite build --ssr', 'prerender']);
  const v = await verifyConvertedMern({ copyDir, outDir, pages });
  assert.equal(v.pages, pages.length);
  assert.deepEqual(v.added, [], 'nothing the copy does not have but the pages and _headers');
  const dist = path.join(outDir, MERN_EXPORT_DIR);
  assert.deepEqual(JSON.parse(await readFile(path.join(dist, 'sas-forms.json'), 'utf8')), { endpoint: FORMS_ENDPOINT });
  assert.equal(await readFile(path.join(copyDir, 'sas-forms.json'), 'utf8'), '{\n  "endpoint": ""\n}\n', 'the copy itself is not changed');
  assert.equal(await readFile(path.join(outDir, 'client', 'public', 'sas-forms.json'), 'utf8'), await readFile(path.join(dist, 'sas-forms.json'), 'utf8'));
  const copyJs = (await listFiles(copyDir)).filter((f) => /\.m?js$/.test(f)).sort();
  assert.deepEqual((await listFiles(dist)).filter((f) => /\.m?js$/.test(f)).sort(), copyJs, 'no JavaScript but the copy\'s own');
  for (const p of pages) {
    const html = await readFile(path.join(dist, p.outPath), 'utf8');
    assert.doesNotMatch(html, /data-sas-raw|data-sas-comment|sas-render-start|type="module"/, p.outPath);
  }
  // A tampered build is refused, as for React + Vite.
  const file = path.join(dist, 'forms.html');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('action="/subscribe"', 'action="/api/forms/forms-1"'), 'utf8');
  try {
    await assert.rejects(verifyConvertedMern({ copyDir, outDir, pages }), /forms\.html is not the as-is page/);
  } finally {
    await writeFile(file, text, 'utf8');
  }
  // The project: client = the React + Vite project, server = Express, and nothing of React's development server at the top.
  const pkg = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.scripts), ['install:all', 'dev', 'build', 'start']);
  assert.deepEqual(Object.keys(pkg.dependencies), ['express', 'mongodb']);
  const client = JSON.parse(await readFile(path.join(outDir, 'client', 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(client.dependencies), ['react', 'react-dom']);
  const files = await listFiles(outDir);
  for (const f of ['server/src/app.js', 'server/src/index.js', 'server/src/dev.js', 'server/src/headers.js', 'server/src/store.js', 'server/forms.json', 'client/src/routes.js', 'client/scripts/prerender.mjs', 'README.md', '.env.example']) {
    assert.ok(files.includes(f), `${f} is written`);
  }
  const readme = await readFile(path.join(outDir, 'README.md'), 'utf8');
  assert.match(readme, /"signup" on \/forms\.html: on the original it sent its data to the original site \(example-original\.dev\/subscribe\)\. In the copy it goes to the copy's own server/);
});

/** The app of the built project, in this process (its own express, through the toolchain link). */
async function appOf(o) {
  const { createApp } = await import(pathToFileURL(path.join(outDir, 'server', 'src', 'app.js')).href);
  const { createMemoryStore, disabledStore } = await import(pathToFileURL(path.join(outDir, 'server', 'src', 'store.js')).href);
  const store = o.store === 'disabled' ? disabledStore() : createMemoryStore();
  const forms = JSON.parse(await readFile(path.join(outDir, 'server', 'forms.json'), 'utf8'));
  const server = createApp({ store, forms, siteDir: path.join(outDir, MERN_EXPORT_DIR), logger: { error() {} } }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { store, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** A form's fields as the copy's form guard sends them (FormData = multipart/form-data). */
function formData(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) fd.append(k, x);
  return fd;
}

test('npm start: the built site like a static host, the original\'s files first, the wired forms stored', { timeout: 3 * 60000 }, async () => {
  const s = await appOf({});
  try {
    const dist = path.join(outDir, MERN_EXPORT_DIR);
    for (const p of pages) {
      const builtPage = await readFile(path.join(dist, p.outPath));
      for (const address of new Set([routeOf(p.outPath), `/${p.outPath}`, routeOf(p.outPath).replace(/\.html$/, '')])) {
        const res = await fetch(`${s.base}${address}`);
        assert.equal(res.status, 200, address);
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), builtPage, `${address} is the built ${p.outPath}`);
      }
    }
    const page = await fetch(`${s.base}/forms.html`, { headers: { 'accept-encoding': 'br' } });
    for (const [name, value] of SECURITY_HEADERS) assert.equal(page.headers.get(name), value, name);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.equal(page.headers.get('content-encoding'), 'br');
    assert.equal(page.headers.get('content-security-policy'), null, 'no CSP: the original\'s inline scripts run');
    assert.equal(await page.text(), await readFile(path.join(dist, 'forms.html'), 'utf8'), 'compressed on the way, the built page once decoded');
    const css = await fetch(`${s.base}/styles.css`);
    assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000');
    assert.match(css.headers.get('content-type'), /text\/css/);
    // The original's own files at the addresses this server keeps for itself, and at Vite's.
    for (const [rel, body] of Object.entries(RESERVED)) {
      const res = await fetch(`${s.base}/${rel}`);
      assert.equal(res.status, 200, `/${rel}`);
      assert.equal(await res.text(), body, `/${rel} is the original's file`);
    }
    const folder = await fetch(`${s.base}/services`, { redirect: 'manual' });
    assert.equal(folder.status, 301);
    assert.equal(folder.headers.get('location'), '/services/');
    assert.equal((await fetch(`${s.base}/no-such-page.html`)).status, 404);

    // The copy's form guard sends the signup form from its page: stored.
    const headers = { referer: `${s.base}/forms.html`, origin: s.base };
    let res = await fetch(`${s.base}${FORMS_ENDPOINT}`, { method: 'POST', headers, body: formData({ email: 'a@b.co', news: 'on', plan: 'b', token: 'x', extra: 'hi' }) });
    assert.equal(res.status, 201, await res.clone().text());
    assert.equal((await res.json()).form, 'forms-1');
    assert.equal(s.store.docs.length, 1);
    assert.deepEqual(s.store.docs[0].values, { email: 'a@b.co', news: true, plan: 'b', extra: 'hi' }, 'only the fields the form defines; the hidden token is not kept');
    assert.equal(s.store.docs[0].page, '/forms.html');
    // The form without action, told apart by its fields.
    res = await fetch(`${s.base}${FORMS_ENDPOINT}`, { method: 'POST', headers, body: formData({ name: 'Ada', message: 'Hello' }) });
    assert.equal(res.status, 201);
    assert.equal(s.store.docs[1].formId, 'forms-2');
    // A form of another service, a sign-in, a mail form: refused in words, nothing kept.
    res = await fetch(`${s.base}${FORMS_ENDPOINT}`, { method: 'POST', headers, body: formData({ email: 'a@b.co', company: 'X' }) });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /forms\.example-service\.io/);
    res = await fetch(`${s.base}${FORMS_ENDPOINT}`, { method: 'POST', headers: { referer: `${s.base}/login.html`, origin: s.base }, body: formData({ p: 'secret' }) });
    assert.equal(res.status, 409);
    assert.equal(s.store.docs.length, 2, 'nothing of a refused form is kept');
    // Checked like the clean MERN server: required fields, another site, an unknown form.
    res = await fetch(`${s.base}${FORMS_ENDPOINT}/forms-1`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'b' }) });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).errors.email, 'is required');
    res = await fetch(`${s.base}${FORMS_ENDPOINT}`, { method: 'POST', headers: { referer: `${s.base}/forms.html`, origin: 'https://evil.example' }, body: formData({ name: 'x' }) });
    assert.equal(res.status, 403);
    res = await fetch(`${s.base}${FORMS_ENDPOINT}/nope`, { method: 'POST', headers, body: formData({ a: '1' }) });
    assert.equal(res.status, 404);
    // Without script: the form posts to its own action, as on the original, and the visitor lands on /thanks.
    res = await fetch(`${s.base}/subscribe`, { method: 'POST', redirect: 'manual', headers: { ...headers, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=c%40d.co&plan=a&token=x' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/thanks?from=%2Fforms.html');
    assert.equal(s.store.docs.at(-1).values.email, 'c@d.co');
    // POST to an address that is a file of the copy stays the API's: a file answers only reading.
    res = await fetch(`${s.base}/api/forms/forms-1`, { method: 'POST', headers, body: formData({ email: 'e@f.co', plan: 'a' }) });
    assert.equal(res.status, 201);
    assert.equal((await fetch(`${s.base}/index.html`, { method: 'POST', body: 'x' })).status, 405);
  } finally {
    await s.close();
  }
  const off = await appOf({ store: 'disabled' });
  try {
    const res = await fetch(`${off.base}${FORMS_ENDPOINT}`, { method: 'POST', headers: { referer: `${off.base}/forms.html`, origin: off.base }, body: formData({ name: 'Ada' }) });
    assert.equal(res.status, 503, 'without MONGODB_URI the site is served and the form endpoint says it cannot store');
    assert.equal((await fetch(`${off.base}/`)).status, 200);
  } finally {
    await off.close();
  }
});

test('npm run dev shows every page byte for byte as the build ships it, the original\'s files first, and the forms', { timeout: 3 * 60000 }, async () => {
  await linkModules(path.join(outDir, 'client'));
  const port = 4293;
  const dev = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1' };
  delete env.MONGODB_URI;
  delete env.FORMS_STORE;
  const child = spawn(process.execPath, ['server/src/dev.js'], { cwd: outDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    let res;
    for (let i = 0; i < 60 && !res; i++) {
      res = await fetch(`${dev}/about.html`).catch(() => null);
      if (!res) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(res, `the dev server answered: ${out.slice(-500)}`);
    const dist = path.join(outDir, MERN_EXPORT_DIR);
    for (const p of pages) {
      const builtPage = await readFile(path.join(dist, p.outPath), 'utf8');
      for (const address of new Set([routeOf(p.outPath), `/${p.outPath}`, routeOf(p.outPath).replace(/\.html$/, '')])) {
        const page = await fetch(`${dev}${address}`);
        assert.equal(page.status, 200, `${address}: ${out.slice(-800)}`);
        assert.equal(await page.text(), builtPage, `${address} in development is the built ${p.outPath}`);
      }
    }
    for (const [rel, body] of Object.entries(RESERVED)) assert.equal(await (await fetch(`${dev}/${rel}`)).text(), body, `/${rel}`);
    assert.deepEqual(await (await fetch(`${dev}/sas-forms.json`)).json(), { endpoint: FORMS_ENDPOINT });
    for (const [name, value] of SECURITY_HEADERS) assert.equal(res.headers.get(name), value, name);
    assert.equal((await fetch(`${dev}/services`, { redirect: 'manual' })).status, 301);
    assert.equal((await fetch(`${dev}/no-such-page.html`)).status, 404);
    assert.equal((await fetch(`${dev}/@vite/env`)).status, 404, 'no Vite address the original does not have');
    const sent = await fetch(`${dev}${FORMS_ENDPOINT}`, { method: 'POST', headers: { referer: `${dev}/forms.html`, origin: dev }, body: formData({ name: 'Ada', message: 'Hi' }) });
    assert.equal(sent.status, 201, 'the forms work in development (kept in memory without MONGODB_URI)');
    // An edit to a component shows on the next load.
    const components = path.join(outDir, 'client', 'src', 'components');
    let edited = null;
    for (const name of await readdir(components)) {
      const text = await readFile(path.join(components, name), 'utf8');
      if (text.includes('Every kind of form')) { edited = { file: path.join(components, name), text }; break; }
    }
    assert.ok(edited, 'a component holds the heading');
    await writeFile(edited.file, edited.text.replace('Every kind of form', 'Edited in development'), 'utf8');
    try {
      assert.match(await (await fetch(`${dev}/forms.html`)).text(), /Edited in development/);
    } finally {
      await writeFile(edited.file, edited.text, 'utf8');
    }
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
  }
});

test('the download: DEPLOY.md names only scripts and folders the converted MERN package has', async () => {
  const { describePackage, runAndHost, deployMd, mentionsOf } = await import('../src/copy/deploy.js');
  const files = (await listFiles(outDir)).filter((f) => !/(^|\/)(node_modules|\.ssr|\.vite)\//.test(f) && !f.startsWith('client/dist/'));
  const d = describePackage({ files, read: (rel) => (files.includes(rel) ? readFileSync(path.join(outDir, rel), 'utf8') : null) });
  assert.equal(d.tool, 'node');
  assert.deepEqual(d.outputs, ['client/dist']);
  const md = deployMd({ stack: 'mern', shipped: d, siteName: 'example-original.dev', address: 'https://new.example', formsSaved: 3 });
  const { scripts, folders } = mentionsOf(md);
  for (const s of scripts) assert.ok(d.scripts[s], `npm ${s} exists`);
  for (const f of folders) assert.ok(d.folders.includes(f) || d.outputs.includes(f), `${f}/ is in the package or written by its build`);
  assert.match(md, /`npm run install:all`/);
  assert.match(md, /`npm run build` writes the finished site to `client\/dist\/`/);
  assert.match(md, /MongoDB is not part of this copy/);
  assert.match(md, /3 forms? .*saved in MongoDB/);
  assert.doesNotMatch(md, /FORM_ENDPOINT/, 'a MERN copy\'s forms go to its own server, not to a FORM_ENDPOINT');
  assert.ok(runAndHost(d).run.length);
});

test('the zip: the converted project\'s source (no client/dist, no node_modules), its README, DEPLOY.md with the forms', async () => {
  const { planZip } = await import('../src/recreate/export/zip.js');
  const report = {
    baseUrl: 'https://new.example', stack: 'mern', safety: { safe: true },
    outputs: { mern: { status: 'ready', dir: 'mern', mode: 'as-is' } },
    asIs: { address: { used: 'https://new.example' }, convert: { mode: 'converted', wiredForms: result.wiredForms, forms: result.forms, fallbacks: [] } },
  };
  const plan = await planZip({ dir: root, report, stack: 'mern' });
  const top = plan.name.replace(/\.zip$/, '');
  const names = plan.entries.map((e) => e.name.slice(top.length + 1));
  assert.ok(!names.some((n) => n.startsWith('client/dist/')), 'the build output is made by npm run build, not shipped');
  assert.ok(!names.some((n) => /(^|\/)node_modules\//.test(n) && !n.startsWith('client/public/')), 'no installed packages');
  for (const f of ['package.json', 'README.md', 'DEPLOY.md', 'server/src/app.js', 'server/forms.json', 'client/package.json', 'client/src/routes.js', 'client/public/sas-forms.json']) assert.ok(names.includes(f), f);
  const deploy = plan.entries.find((e) => e.name === `${top}/DEPLOY.md`).content;
  assert.match(deploy, /3 forms are saved in MongoDB by the copy's own server/);
  assert.match(deploy, /`npm run install:all`/);
});
