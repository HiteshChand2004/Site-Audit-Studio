// Build mode in React + Vite and Next.js (src/buildmode/stacks.js, project.js, sandbox.js): the fixed project the agent starts
// from, the files it may write, the source rules read before anything runs, and real builds with the pinned toolchains,
// driven through the agent's tool loop with a fake Claude client. A Next.js build runs the site's code, so it runs in the OS
// sandbox: a page that tries to read the server's files or reach the network gets nothing. Builds need the toolchains
// (npm run setup:toolchains -w server -- react-vite next); the Next.js ones need the sandbox (macOS).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/buildmode/agent.js';
import { runEditor, ToolError } from '../src/buildmode/workspace.js';
import { BUILD_STACKS, projectFile, writeScaffold } from '../src/buildmode/stacks.js';
import { buildProject, checkSource } from '../src/buildmode/project.js';
import { checkFormWiring, checkFormsFile } from '../src/buildmode/forms.js';
import { sandboxAvailable } from '../src/buildmode/sandbox.js';
import { checkBuiltSite } from '../src/buildmode/check.js';
import { toolchainStatus } from '../src/toolchains/index.js';
import { SERVER_DIR } from '../src/config/paths.js';

const REACT = BUILD_STACKS['react-vite'];
const NEXT = BUILD_STACKS.nextjs;
const dirs = [];
const temp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'sas-stack-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const reactReady = (await toolchainStatus('react-vite')).installed;
const nextReady = (await toolchainStatus('next')).installed && sandboxAvailable();

let seq = 0;
const use = (name, input) => ({ type: 'tool_use', id: `tu_${++seq}`, name, input });
const turn = (...content) => ({ stop_reason: 'tool_use', content, usage: { input_tokens: 10, output_tokens: 10 }, model: 'claude-sonnet-5-5' });
const write = (p, text) => use('str_replace_based_edit_tool', { command: 'create', path: p, file_text: text });
const FINISH = { summary: 'Built.', requirements: [], placeholders: [], not_done: [] };
const PROMPT = { system: [{ type: 'text', text: 'You are the build agent.' }], messages: [{ role: 'user', content: [{ type: 'text', text: '<project>new</project>' }] }] };
function fakeClient(turns) {
  const calls = [];
  return { calls, beta: { messages: { stream(params) {
    calls.push(JSON.parse(JSON.stringify(params)));
    const next = turns.shift();
    return { finalMessage: async () => (typeof next === 'function' ? next(params) : next) };
  } } } };
}
const lastResults = (params) => params.messages.at(-1).content;
/** Writes a file of a project, its folders made. */
const put = (dir, rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

test('the agent writes only its part of an app project: the configuration, packages and build output stay fixed', async () => {
  const dir = temp();
  const rules = (stack) => ({ writable: stack.writable, writableText: stack.writableText, listed: projectFile });
  const create = (stack, p) => runEditor(dir, { command: 'create', path: p, file_text: 'x' }, rules(stack));
  for (const p of ['src/pages/home.jsx', 'index.html', 'menu/index.html', 'public/logo.svg', 'src/styles/site.css']) assert.ok((await create(REACT, p)).changed, p);
  for (const p of ['vite.config.js', 'package.json', 'postcss.config.js', 'package-lock.json', 'dist/index.html', 'node_modules/x.js', '.env', 'tailwind.config.js']) {
    await assert.rejects(create(REACT, p), (err) => err instanceof ToolError && /fixed setup|Only text files/.test(err.message), p);
  }
  for (const p of ['app/page.jsx', 'app/menu/page.jsx', 'components/Header.jsx', 'public/x.svg']) assert.ok((await create(NEXT, p)).changed, p);
  for (const p of ['next.config.mjs', 'middleware.js', 'instrumentation.js', 'src/app/page.jsx', 'out/index.html']) {
    await assert.rejects(create(NEXT, p), (err) => err instanceof ToolError, p);
  }
  // What the build leaves is never listed to the agent.
  writeFileSync(path.join(dir, 'README.md'), 'x');
  const listed = (await runEditor(dir, { command: 'view', path: '.' }, rules(REACT))).text;
  assert.doesNotMatch(listed, /dist\//);
});

test('the source is read before it is built: only the stack\'s packages, no script sink, no TypeScript', async () => {
  const dir = temp();
  const at = (rel, text) => put(dir, rel, text);
  at('index.html', '<div id="root"></div>');
  at('src/pages/home.jsx', "import { createRoot } from 'react-dom/client';\nimport Header from '../components/Header.jsx';\nimport './site.css';\ncreateRoot(document.getElementById('root')).render(<Header />);");
  at('src/components/Header.jsx', "import { useState } from 'react';\nexport default function Header() { return <header>Rosa</header>; }");
  assert.deepEqual(await checkSource(REACT, dir), []);
  at('src/lib/data.js', "import axios from 'axios';\nimport fs from 'node:fs';\nexport const load = () => fetch('/x');\nconst lazy = () => import('https://evil.example/x.js');");
  at('src/x.tsx', 'export const a: number = 1;');
  const problems = await checkSource(REACT, dir);
  assert.ok(problems.some((p) => /"axios" cannot be imported/.test(p)));
  assert.ok(problems.some((p) => /"node:fs" cannot be imported/.test(p)));
  assert.ok(problems.some((p) => /src\/lib\/data\.js: fetch\(\)/.test(p)));
  assert.ok(problems.some((p) => /https:\/\/evil\.example/.test(p)));
  assert.ok(problems.some((p) => /src\/x\.tsx: write JavaScript/.test(p)));
  // Nothing is built while the source breaks the rules.
  let ran = false;
  const out = await buildProject({ stack: REACT, dir, tmp: path.join(dir, '..', 'tmp-x'), run: async () => { ran = true; } });
  assert.equal(out.ok, false);
  assert.equal(ran, false);
});

const REACT_PAGE = (title, entry) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Trattoria Rosa, a family-run Italian restaurant in Pune.">
<link rel="stylesheet" href="/css/fonts.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/src/pages/${entry}.jsx"></script>
</body>
</html>
`;
const REACT_ENTRY = (Page) => `import { createRoot } from 'react-dom/client';
import ${Page} from '../components/${Page}.jsx';
import '../styles/site.css';
createRoot(document.getElementById('root')).render(<${Page} />);
`;

test('React + Vite: the agent\'s project is built, each page drawn into its HTML, checked, and rebuilt only after a change', { skip: !reactReady && 'react-vite toolchain not installed', timeout: 180000 }, async () => {
  const root = temp();
  const site = path.join(root, 'site');
  const written = await writeScaffold(REACT, site, { name: 'Trattoria Rosa' });
  assert.deepEqual(written.sort(), ['.gitignore', 'README.md', 'package-lock.json', 'package.json', 'vite.config.js']);
  const pkg = JSON.parse(readFileSync(path.join(site, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'trattoria-rosa');
  assert.deepEqual(Object.keys(pkg.dependencies), ['react', 'react-dom']);
  assert.ok(JSON.parse(readFileSync(path.join(site, 'package-lock.json'), 'utf8')).packages['node_modules/vite'], 'the lockfile pins the toolchain');
  put(site, 'public/css/fonts.css', '/* fonts */');

  const builds = [];
  const build = async (o) => { const out = await buildProject(o); builds.push(out); return out; };
  const looks = [];
  const preview = async (dir) => { looks.push(dir); return { pages: ['/'], findings: [], shots: [] }; };
  const client = fakeClient([
    turn(
      write('index.html', REACT_PAGE('Trattoria Rosa', 'home')),
      write('menu/index.html', REACT_PAGE('Menu · Trattoria Rosa', 'menu')),
      write('src/pages/home.jsx', REACT_ENTRY('Home')),
      write('src/pages/menu.jsx', REACT_ENTRY('Menu')),
      // A mistake first: the build must report it to the agent.
      write('src/components/Home.jsx', 'export default function Home() { return <main><h1>Wood-fired pizza</h1><a href="/menu/">See the menu</a></main>; '),
      write('src/components/Menu.jsx', "import { useState } from 'react';\nexport default function Menu() { const [open, setOpen] = useState(false); return <main><h1>Menu</h1><button type=\"button\" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} desserts</button><a href=\"/\">Home</a></main>; }"),
      write('src/styles/site.css', 'body { margin: 0; font-family: Inter, system-ui, sans-serif; }'),
      use('preview_site', {})),
    (params) => {
      const r = lastResults(params).at(-1);
      assert.equal(r.is_error, true);
      assert.match(r.content, /did not build[\s\S]*Home\.jsx/);
      return turn(use('str_replace_based_edit_tool', { command: 'str_replace', path: 'src/components/Home.jsx', old_str: '</main>; ', new_str: '</main>; }' }), use('preview_site', {}), use('check_site', {}));
    },
    (params) => {
      assert.match(lastResults(params).at(-1).content, /All checks passed \(2 pages\)/);
      return turn(use('check_site', {}), use('finish', FINISH));
    },
  ]);
  const out = await runAgent({ prompt: PROMPT, siteDir: site, tmp: path.join(root, 'tmp'), stack: REACT, client, preview, build });
  assert.equal(out.checks.ok, true, out.checks.issues.join('\n'));
  assert.equal(builds.length, 2, 'built for the failing look, again after the fix, and not again for checks without a change');
  assert.deepEqual(looks, [path.join(site, 'dist')], 'the preview shows the built site');

  const home = readFileSync(path.join(site, 'dist/index.html'), 'utf8');
  assert.match(home, /<div id="root"><main><h1>Wood-fired pizza<\/h1><a href="\/menu\/">See the menu<\/a><\/main><\/div>/, 'the page carries its content');
  assert.match(home, /<script type="module" crossorigin src="\/_app\/[\w-]+\.js"><\/script>/);
  assert.match(readFileSync(path.join(site, 'dist/menu/index.html'), 'utf8'), /Show<!-- --> desserts|Show desserts/);
  assert.ok(!existsSync(path.join(site, 'node_modules')), 'the toolchain link is gone after the build');
  const system = client.calls[0].messages[0].content.at(-1).text;
  assert.match(system, /React 19 \+ Vite project, already set up/);
  assert.match(system, /<link rel="stylesheet" href="\/css\/fonts\.css">|Fonts: no font files/);
});

test('Next.js: built in the sandbox, exported, checked with the Next.js rules', { skip: !nextReady && 'next toolchain or sandbox not available', timeout: 300000 }, async () => {
  const root = temp();
  const site = path.join(root, 'site');
  await writeScaffold(NEXT, site, { name: 'Trattoria Rosa' });
  const client = fakeClient([
    turn(
      write('app/layout.jsx', "import './globals.css';\nimport Header from '../components/Header.jsx';\nexport const metadata = { title: 'Trattoria Rosa', description: 'A family-run Italian restaurant in Pune.' };\nexport default function Layout({ children }) { return <html lang=\"en\"><body><Header />{children}</body></html>; }"),
      write('app/globals.css', 'body { margin: 0; }'),
      write('app/page.jsx', "import Link from 'next/link';\nexport default function Home() { return <main><h1>Wood-fired pizza</h1><Link href=\"/menu/\">See the menu</Link></main>; }"),
      write('app/menu/page.jsx', "export const metadata = { title: 'Menu · Trattoria Rosa', description: 'Pizza, pasta and desserts.' };\nexport default function Menu() { return <main><h1>Menu</h1><a href=\"/\">Home</a></main>; }"),
      write('components/Header.jsx', "'use client';\nimport { useState } from 'react';\nexport default function Header() { const [open, setOpen] = useState(false); return <header><button type=\"button\" aria-expanded={open} onClick={() => setOpen(!open)}>Menu</button></header>; }"),
      use('check_site', {})),
    (params) => {
      assert.match(lastResults(params).at(-1).content, /All checks passed/, lastResults(params).at(-1).content);
      return turn(use('preview_site', {}), use('finish', FINISH));
    },
  ]);
  const out = await runAgent({ prompt: PROMPT, siteDir: site, tmp: path.join(root, 'tmp'), stack: NEXT, client, preview: async () => ({ pages: ['/'], findings: [], shots: [] }) });
  assert.equal(out.checks.ok, true, out.checks.issues.join('\n'));
  assert.match(readFileSync(path.join(site, 'out/index.html'), 'utf8'), /<h1>Wood-fired pizza<\/h1>/);
  assert.match(readFileSync(path.join(site, 'out/menu/index.html'), 'utf8'), /<title>Menu · Trattoria Rosa<\/title>/);
  assert.ok(!existsSync(path.join(site, '.next')), 'the build cache is not kept');
  assert.equal((await checkBuiltSite(path.join(site, 'out'), { app: 'next' })).ok, true);
});

test('Next.js: code that runs during the build cannot read the server\'s files, write outside its project, start programs or reach the network', { skip: !nextReady && 'next toolchain or sandbox not available', timeout: 300000 }, async () => {
  const root = temp();
  const site = path.join(root, 'site');
  await writeScaffold(NEXT, site);
  const secret = path.join(SERVER_DIR, 'package.json');
  const outside = path.join(path.dirname(SERVER_DIR), `sandbox-escape-${process.pid}.txt`);
  put(site, 'app/layout.jsx', 'export default function L({ children }) { return <html lang="en"><body>{children}</body></html>; }');
  // The source rules would refuse these imports and the fetch; the sandbox must hold even when they are let through.
  put(site, 'app/page.jsx', `import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const attempt = (f) => { try { return 'got ' + String(f()).slice(0, 8); } catch (e) { return 'blocked'; } };
const read = attempt(() => readFileSync(${JSON.stringify(secret)}, 'utf8'));
const wrote = attempt(() => { writeFileSync(${JSON.stringify(outside)}, 'x'); return 'yes'; });
const ran = attempt(() => execSync('/bin/echo hi'));
export default async function Page() {
  let net = 'blocked';
  try { await fetch('https://example.com', { signal: AbortSignal.timeout(5000) }); net = 'got'; } catch {}
  return <main><p id="read">{read}</p><p id="wrote">{wrote}</p><p id="ran">{ran}</p><p id="net">{net}</p></main>;
}
`);
  const built = await buildProject({ stack: NEXT, dir: site, tmp: path.join(root, 'tmp'), source: async () => [] });
  assert.equal(built.ok, true, built.problems.join('\n'));
  const html = readFileSync(path.join(site, 'out/index.html'), 'utf8');
  for (const id of ['read', 'wrote', 'ran', 'net']) assert.match(html, new RegExp(`id="${id}">blocked<`), id);
  assert.ok(!existsSync(outside));
});

const MERN = BUILD_STACKS.mern;
const mernReady = (await toolchainStatus('mern')).installed;

test('MERN forms: server/forms.json is read as data and every form on the built pages must match it', async () => {
  const dir = temp();
  assert.match((await checkFormsFile(dir)).problems[0], /forms\.json is missing/);
  put(dir, 'server/forms.json', '{ not json');
  assert.match((await checkFormsFile(dir)).problems[0], /not valid JSON/);
  put(dir, 'server/forms.json', JSON.stringify([
    { id: 'Booking!', page: 'contact', fields: [] },
    { id: 'news', page: '/', fields: [{ name: 'email', type: 'email', required: 'yes', script: 'x' }, { name: 'email', type: 'select' }] },
  ]));
  const bad = (await checkFormsFile(dir)).problems.join('\n');
  for (const want of [/"id" must be lower-case/, /"page" is the address/, /"fields" must list/, /"required" must be true or false/, /has "script"/, /a select needs "options"/, /"email" is listed twice/]) assert.match(bad, want);

  const good = [{ id: 'booking', page: '/contact/', fields: [{ name: 'name', type: 'text', required: true }, { name: 'guests', type: 'number', min: 1, max: 20 }] }];
  put(dir, 'server/forms.json', JSON.stringify(good));
  assert.deepEqual((await checkFormsFile(dir)).problems, []);
  const out = path.join(dir, 'client/dist');
  const page = (form) => `<!doctype html><html lang="en"><head><title>x</title></head><body><div id="root">${form}</div></body></html>`;
  put(out, 'index.html', page('<form method="get" action="/search"><input name="q"></form>'));
  put(out, 'contact/index.html', page('<form method="post" action="/api/forms/booking"><input name="guests"><input name="extra"><button type="submit">Send</button></form><form method="post" action="/api/forms/other"></form>'));
  const wiring = (await checkFormWiring(out, good)).join('\n');
  for (const want of [/form 1 on \/ must post to \/api\/forms\/<id>/, /sends "extra", which is not a field/, /has no "name", which "booking" requires/, /\/api\/forms\/other, which server\/forms\.json does not define/]) assert.match(wiring, want);
  put(out, 'index.html', page('<p>Welcome</p>'));
  put(out, 'contact/index.html', page('<form method="post" action="/api/forms/booking"><label>Name <input name="name" required></label><input type="number" name="guests"><button>Send</button></form>'));
  assert.deepEqual(await checkFormWiring(out, good), []);
  assert.match((await checkFormWiring(out, [...good, { id: 'news', page: '/', fields: [{ name: 'email', type: 'email' }] }])).join('\n'), /"news" .* says it is on \/, but no form there posts/);
});

const MERN_PAGE = (title, entry) => REACT_PAGE(title, entry);
const BOOKING = `import { useState } from 'react';
export default function Contact() {
  const [note, setNote] = useState('');
  return <main><h1>Book a table</h1>
    <form method="post" action="/api/forms/booking">
      <label>Your name <input name="name" required maxLength={100} /></label>
      <label>Guests <input type="number" name="guests" min={1} max={20} /></label>
      <label>A note <textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <button type="submit">Send the request</button>
    </form><a href="/">Home</a></main>;
}
`;

test('MERN: the client is built and drawn, its forms checked against forms.json, and the fixed server\'s own tests pass', { skip: !mernReady && 'mern toolchain not installed', timeout: 300000 }, async () => {
  const root = temp();
  const site = path.join(root, 'site');
  const written = await writeScaffold(MERN, site, { name: 'Trattoria Rosa' });
  for (const f of ['client/package.json', 'client/vite.config.js', 'client/package-lock.json', 'server/package.json', 'server/package-lock.json', 'server/forms.json', 'server/src/app.js', 'server/src/index.js', 'server/src/admin.js', 'server/test/admin.test.js', 'README.md']) assert.ok(written.includes(f), f);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(site, 'server/package.json'), 'utf8')).dependencies), ['compression', 'express', 'mongodb']);
  const rules = { writable: MERN.writable, writableText: MERN.writableText, listed: projectFile };
  await assert.rejects(runEditor(site, { command: 'create', path: 'server/src/app.js', file_text: 'x' }, rules), /fixed setup/, 'the server is not the agent\'s');
  put(site, 'client/public/css/fonts.css', '/* fonts */');

  const builds = [];
  const build = async (o) => { const out = await buildProject(o); builds.push(out); return out; };
  const client = fakeClient([
    turn(
      write('client/index.html', MERN_PAGE('Trattoria Rosa', 'home')),
      write('client/contact/index.html', MERN_PAGE('Book a table · Trattoria Rosa', 'contact')),
      write('client/src/pages/home.jsx', REACT_ENTRY('Home')),
      write('client/src/pages/contact.jsx', REACT_ENTRY('Contact')),
      write('client/src/components/Home.jsx', 'export default function Home() { return <main><h1>Wood-fired pizza</h1><a href="/contact/">Book a table</a></main>; }'),
      write('client/src/components/Contact.jsx', BOOKING),
      write('client/src/styles/site.css', 'body { margin: 0; }'),
      // The form sends "note", which this definition forgets: the check must say so.
      write('server/forms.json', JSON.stringify([{ id: 'booking', page: '/contact/', fields: [{ name: 'name', type: 'text', required: true, maxLength: 100 }, { name: 'guests', type: 'number', min: 1, max: 20 }] }])),
      use('check_site', {})),
    (params) => {
      assert.match(lastResults(params).at(-1).content, /sends "note", which is not a field of "booking"/);
      return turn(use('str_replace_based_edit_tool', { command: 'str_replace', path: 'server/forms.json', old_str: '"max":20}', new_str: '"max":20},{"name":"note","type":"textarea","maxLength":2000}' }), use('check_site', {}));
    },
    (params) => {
      assert.match(lastResults(params).at(-1).content, /All checks passed \(2 pages\)/, lastResults(params).at(-1).content);
      return turn(use('preview_site', {}), use('finish', FINISH));
    },
  ]);
  const looks = [];
  const out = await runAgent({ prompt: PROMPT, siteDir: site, tmp: path.join(root, 'tmp'), stack: MERN, client, build, preview: async (dir) => { looks.push(dir); return { pages: ['/'], findings: [], shots: [] }; } });
  assert.equal(out.checks.ok, true, out.checks.issues.join('\n'));
  assert.equal(builds.length, 2);
  assert.deepEqual(looks, [path.join(site, 'client/dist')]);
  assert.match(readFileSync(path.join(site, 'client/dist/contact/index.html'), 'utf8'), /<form method="post" action="\/api\/forms\/booking">/, 'the form is in the page as drawn');
  assert.ok(!existsSync(path.join(site, 'client/node_modules')) && !existsSync(path.join(site, 'server/node_modules')), 'the toolchain links are gone');
  assert.match(client.calls[0].messages[0].content.at(-1).text, /You never write server code/);

  // The project's own server, started as the owner would: a form sent from the site is stored and read on /admin.
  const { spawn } = await import('node:child_process');
  const { symlinkSync, unlinkSync } = await import('node:fs');
  const { toolchainDir } = await import('../src/toolchains/index.js');
  symlinkSync(path.join(toolchainDir('mern'), 'node_modules'), path.join(site, 'server/node_modules'), 'junction');
  const port = 4300 + (process.pid % 500);
  const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(site, 'server'), env: { PATH: process.env.PATH, PORT: String(port), FORMS_STORE: 'memory', ADMIN_PASSWORD: 'a long enough secret' }, stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50 && !(await fetch(`${base}/api/health`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(await (await fetch(`${base}/contact/`)).text(), /Book a table/);
    const sent = await fetch(`${base}/api/forms/booking`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: 'name=Asha&guests=4&note=Window+table' });
    assert.equal(sent.status, 303);
    assert.match(sent.headers.get('location'), /^\/thanks/);
    assert.equal((await fetch(`${base}/api/forms/booking`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', origin: base }, body: JSON.stringify({ guests: 99 }) })).status, 422, 'checked against forms.json');
    assert.equal((await fetch(`${base}/admin/`)).status, 401);
    const admin = await (await fetch(`${base}/admin/`, { headers: { authorization: `Basic ${Buffer.from('admin:a long enough secret').toString('base64')}` } })).text();
    assert.match(admin, /Asha/);
    assert.match(admin, /Window table/);
  } finally {
    server.kill();
    unlinkSync(path.join(site, 'server/node_modules'));
  }
});
