// The whole product path through the real API, the way a person uses it with accounts on (verification required): Analyze →
// Copy my site (as-is, in each stack the tool offers) → the re-audit the copy queues by itself → Results → Compare (the preview) →
// the report → the download. An ordinary user and the owner share the four stacks, on a one-page site served on this computer.
// Found missing when every re-audit of an as-is MERN copy failed with "The homepage returned HTTP 404": the re-audit served
// stacks/mern instead of the copy inside it (client/dist), and each click on "Compare now" queued another job that failed alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySchema } from '../src/db/schema.js';
import { applyMigrations } from '../src/db/apply.js';
import { hashPassword } from '../src/accounts/passwords.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tiny Bakery — fresh bread every morning</title>
<meta name="description" content="Tiny Bakery bakes fresh bread, buns and cakes every morning in the middle of town. Come by before nine.">
<style>body{font-family:system-ui,sans-serif;margin:0;color:#222}header,main,footer{padding:24px}h1{font-size:40px}
.card{border:1px solid #ccc;border-radius:8px;padding:16px;margin:12px 0;transition:background .2s}.card:hover{background:#fdf2e9}</style></head>
<body><header><strong>Tiny Bakery</strong></header><main><h1>Fresh bread every morning</h1>
<p>${'We bake everything by hand, with flour from the mill down the road. '.repeat(6)}</p>
<div class="card"><h2>Sourdough</h2><p>Baked at six, gone by noon.</p></div><div class="card"><h2>Cinnamon buns</h2><p>Saturdays only.</p></div>
<form class="order" action="/order" method="post"><label>Name <input name="name" required></label><label>Email <input name="email" type="email" required></label><button>Order a cake</button></form>
</main><footer><p>Open every day from 7 to 15.</p></footer></body></html>`;

/** The original: one page and a robots.txt, on a loopback port. */
async function startSite() {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/' || url === '/index.html') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    if (url === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title><h1>Not found</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

/** A migrated data folder with a verified owner and a verified ordinary user, both with a password. */
async function dataFolder() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-flow-'));
  const d = new DatabaseSync(path.join(dir, 'app.db'));
  applySchema(d);
  applyMigrations(d, { ownerEmail: 'owner@example.com' });
  const now = new Date().toISOString();
  const pw = await hashPassword('password123');
  d.prepare("UPDATE users SET password_hash = ?, email_verified_at = ? WHERE role = 'owner'").run(pw, now);
  d.prepare("INSERT INTO users (id, email, password_hash, role, email_verified_at, created_at, updated_at) VALUES (?, 'user@example.com', ?, 'user', ?, ?, ?)").run(randomUUID(), pw, now, now, now);
  d.close();
  return dir;
}

async function startApi(t, dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: SERVER,
    env: {
      ...process.env, NODE_TEST_CONTEXT: '', SAS_DATA_DIR: dataDir, PORT: String(port), SAS_ACCOUNTS: '1', SAS_ALLOW_LOCALHOST: '1',
      SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0', SAS_COPY_LINK_CHECK: '0', SAS_JOB_MIN_FREE_MB: '0', SAS_CLEANUP_HOURS: '0',
      SAS_DEV_NO_VERIFY: '', SAS_BIND_HOST: '', NODE_ENV: '', SAS_COOKIE_SECURE: '', SAS_PUBLIC_ORIGIN: '', SMTP_HOST: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
  });
  for (let i = 0; i < 300 && !/API ready/.test(out); i++) await sleep(100);
  assert.match(out, /API ready/, out);
  const base = `http://127.0.0.1:${port}`;
  const signIn = async (email) => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
    assert.equal(res.status, 200, `${email} signs in`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, p, body) => {
      const r = await fetch(base + p, { method, redirect: 'manual', headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const buf = Buffer.from(await r.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
      return { status: r.status, json, text: buf.toString('utf8'), bytes: buf, type: r.headers.get('content-type') ?? '' };
    };
  };
  return { signIn, output: () => out };
}

/** Waits until `check` returns a value (polled), or fails with what the server said. */
async function until(what, check, { timeoutMs, output }) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(1500);
  }
  assert.fail(`${what}: not done after ${Math.round(timeoutMs / 1000)} s\n${output().slice(-4000)}`);
}

/** The names in a zip, from its central directory (the download is a plain zip; no library needed to list it). */
function zipNames(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'a zip');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const n = buf.readUInt16LE(at + 28);
    names.push(buf.toString('utf8', at + 46, at + 46 + n));
    at += 46 + n + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return names;
}

// Per stack: the folder the preview and the re-audit must read inside the project (what that stack's own server serves), and the
// files the download must hold — the whole project, as before the fix (the fix changed only which folder is read).
const STACKS = {
  html: { served: '', project: ['README.md', 'index.html'] },
  // Converted into React pages and components (recreate/convert/react.js): the page is src/pages/Home.jsx, not a file of public/.
  'react-vite': { served: 'dist', project: ['package.json', 'vite.config.js', 'src/entry-server.jsx', 'src/routes.js', 'src/pages/Home.jsx', 'scripts/prerender.mjs', 'scripts/dev.mjs', 'public/_headers', 'README.md'], absent: ['public/index.html', 'dist/index.html'], converted: true },
  // Next.js: the copy converted into pages and components (recreate/convert/next.js), a static export served from out/; the
  // project ships the source (out/ is written by its own build, as DEPLOY.md says).
  nextjs: { served: 'out', project: ['package.json', 'next.config.mjs', 'pages/index.jsx', 'pages/_document.jsx', 'src/documents.js', 'scripts/after-build.mjs', 'README.md'], converted: true },
  // MERN: the React + Vite conversion as client/ (built by the project's own `npm run build`) and the Express server, which
  // serves client/dist and stores the forms that went to the original's own server (recreate/convert/mern.js).
  mern: { served: 'client/dist', project: ['package.json', 'server/src/index.js', 'server/src/app.js', 'server/src/dev.js', 'server/forms.json', 'client/package.json', 'client/src/routes.js', 'client/src/pages/Home.jsx', 'client/scripts/prerender.mjs', 'README.md'], absent: ['client/dist/index.html', 'client/public/index.html'], converted: true },
};

/** One person's whole path; returns the project id. */
async function wholeFlow({ api, as, siteUrl, stack, name, made = {} }) {
  const created = await as('POST', '/api/projects', { name, url: siteUrl, authorized: true });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;
  made.id = id;
  assert.equal((await as('PATCH', `/api/projects/${id}`, { stack })).status, 200);

  // 1. Analyze.
  const analyze = await as('POST', `/api/projects/${id}/analyze`, {});
  assert.equal(analyze.status, 202, analyze.text);
  await until('analysis', async () => !(await as('GET', `/api/projects/${id}/analyze/current`)).json, { timeoutMs: 8 * 60_000, output: api.output });
  const audit = (await as('GET', `/api/projects/${id}/audit`)).json;
  assert.equal(audit.isDummy, false, `the analysis finished
${api.output().slice(-3000)}`);

  // 2. Copy my site: the original as it is, packaged as the chosen stack.
  const copy = await as('POST', `/api/projects/${id}/recreate`, { mode: 'as-is', confirmed: true, stack });
  assert.equal(copy.status, 202, copy.text);
  const recreate = await until('copy', async () => {
    if ((await as('GET', `/api/projects/${id}/recreate/current`)).json) return null;
    return (await as('GET', `/api/projects/${id}/recreate`)).json;
  }, { timeoutMs: 20 * 60_000, output: api.output });
  assert.equal(recreate.last?.status, 'done', `the copy finished: ${recreate.last?.error ?? ''}
${api.output().slice(-3000)}`);
  const outputs = recreate.result?.outputs;
  assert.equal(outputs?.[stack]?.mode, 'as-is');
  if (STACKS[stack].converted) {
    const convert = recreate.result?.asIs?.convert;
    assert.equal(convert?.mode, 'converted', `the ${stack} copy is converted into code: ${JSON.stringify(convert ?? null).slice(0, 300)}`);
    assert.ok(convert.stats.components >= 1 && Array.isArray(convert.fallbacks) && Array.isArray(convert.forms), 'components, fallbacks and forms are reported');
    // React + Vite (and the MERN client, the same conversion) holds every built page against its as-is page (verifyConverted).
    if (stack === 'react-vite' || stack === 'mern') {
      assert.equal(convert.verified?.pages, convert.stats.pages, 'every built page was held against its as-is page');
      assert.deepEqual(convert.verified?.added, [], 'the build added no file');
    }
    // MERN: the order form went to the original's own server, so it is wired to the copy's and saved; the form check, run on
    // the copy's own server, sees it accepted.
    if (stack === 'mern') {
      assert.equal(convert.wiredForms, 1, JSON.stringify(convert.forms).slice(0, 400));
      assert.equal(convert.forms[0].goesTo, 'copy-server');
      assert.match(convert.forms[0].note, /saved in MongoDB/);
      const sent = recreate.result.asIs.checks.pages.flatMap((p) => p.forms?.forms ?? []);
      assert.deepEqual(sent.map((f) => f.note), ['Thank you. Your message was sent.'], `the copy's server stored the submission: ${JSON.stringify(recreate.result.asIs.checks.pages.map((p) => [p.path, p.forms ?? null]))}`);
      assert.equal(recreate.result.asIs.needsAPerson.length, 0, 'no form needs a person');
    }
  }

  // 3. The re-audit the copy queued by itself: it runs once and succeeds.
  const reaudit = await until('re-audit', async () => {
    if ((await as('GET', `/api/projects/${id}/reaudit/current`)).json) return null;
    const r = await as('GET', `/api/projects/${id}/reaudit`);
    return r.json?.last && r.json.last.status !== 'queued' && r.json.last.status !== 'running' ? r.json : null;
  }, { timeoutMs: 20 * 60_000, output: api.output });
  assert.equal(reaudit.last.status, 'done', `the re-audit succeeded: ${reaudit.last.error ?? ''}\n${api.output().slice(-3000)}`);
  assert.ok(reaudit.result?.checklist?.items?.length, 'the comparison has rows');
  assert.equal(path.normalize(outputs[stack].dist), path.normalize(STACKS[stack].served), `the ${stack} output names the folder its server serves`);

  // 4. Results: the audit carries the comparison of the copy.
  const results = await as('GET', `/api/projects/${id}/audit`);
  assert.equal(results.json.recreate?.status, 'done', JSON.stringify(results.json.recreate ?? {}).slice(0, 400));
  assert.ok(results.json.recreate.items.length);
  assert.equal(results.json.recreate.lastError ?? null, null);

  // 5. Compare: the copy's preview opens on its home page, with the original's heading.
  const preview = await as('POST', `/api/projects/${id}/preview`, {});
  assert.equal(preview.status, 200, preview.text);
  const home = await as('GET', preview.json.preview.url);
  assert.equal(home.status, 200, `the preview's home page answers (${preview.json.preview.url})`);
  assert.match(home.text, /Fresh bread every morning/);
  // A converted copy is prerendered and never hydrated: the page carries no script of the stack and none of the build's leftovers.
  if (STACKS[stack].converted) assert.ok(!/__next|data-next-head|data-sas-raw/.test(home.text) && !home.text.includes('_next/'), 'no runtime of the stack in the page');

  // 6. The report, in every format.
  const json = await as('GET', `/api/projects/${id}/report?format=json`);
  assert.equal(json.status, 200);
  assert.ok(json.json.audit?.recreate?.items?.length, 'the JSON report holds the comparison');
  const html = await as('GET', `/api/projects/${id}/report?format=html`);
  assert.equal(html.status, 200);
  assert.match(html.type, /text\/html/);
  const pdf = await as('GET', `/api/projects/${id}/report?format=pdf`);
  assert.equal(pdf.status, 200, pdf.text.slice(0, 300));
  assert.equal(pdf.bytes.subarray(0, 5).toString('latin1'), '%PDF-');

  // 7. The download: the chosen stack's whole project, never only the folder the preview reads.
  const zip = await as('GET', `/api/projects/${id}/recreate/${recreate.last.id}/download?stack=${stack}`);
  assert.equal(zip.status, 200, zip.text.slice(0, 300));
  const names = zipNames(zip.bytes).map((n) => n.split('/').slice(1).join('/')).filter(Boolean);
  for (const f of STACKS[stack].project) assert.ok(names.includes(f), `the ${stack} download holds ${f} (it has: ${names.slice(0, 30).join(', ')})`);
  for (const f of STACKS[stack].absent ?? []) assert.ok(!names.includes(f), `the ${stack} download does not hold ${f}`);
  assert.ok(!names.some((n) => n.split('/').includes('node_modules')), 'no node_modules');
  return id;
}

test('Analyze → Copy my site → re-audit → Results → Compare → report → download, for every stack, as an ordinary user and as the owner', { timeout: 90 * 60_000 }, async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const dataDir = await dataFolder();
  const api = await startApi(t, dataDir);
  // SAS_FLOW_KEEP=1 keeps the data folder (its path is printed) to look into a failure.
  if (process.env.SAS_FLOW_KEEP === '1') console.log(`kept data folder: ${dataDir}`);
  else t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5 }));

  const user = await api.signIn('user@example.com');
  const owner = await api.signIn('owner@example.com');
  // Both people go through it even when the first fails, so a failure says whom it hits.
  const failures = [];
  const made = {};
  // Every stack the tool offers; the ordinary user and the owner share them out (the user's MERN copy is the reported case).
  // SAS_FLOW_STACKS (comma-separated) runs only those stacks, e.g. while one stack is being worked on.
  const only = process.env.SAS_FLOW_STACKS?.split(',').map((s) => s.trim()).filter(Boolean);
  for (const [who, as, stack] of [['ordinary user', user, 'mern'], ['ordinary user', user, 'react-vite'], ['owner', owner, 'html'], ['owner', owner, 'nextjs']].filter(([, , s]) => !only?.length || only.includes(s))) {
    made[`${who} ${stack}`] = {};
    try {
      await wholeFlow({ api, as, siteUrl: site.url, stack, name: `Bakery (${who}, ${stack})`, made: made[`${who} ${stack}`] });
    } catch (err) {
      failures.push(`${who} (${stack}): ${String(err.message).split('\n')[0]}`);
      // Let a job the failure left behind end before the next person starts one (one job at a time on this server).
      await sleep(3000);
    }
  }

  // A copy that cannot be compared fails once, with the reason: a click on "Compare now" is refused, no job is queued.
  // (A newer finished copy whose folder lost its home page.) It needs the MERN copy: not run when SAS_FLOW_STACKS leaves it out.
  // After a failed flow (a job it left may still run) this check would only time out: the flow's own failure is said first.
  if (!made['ordinary user mern']?.id || failures.length) {
    assert.deepEqual(failures, [], failures.join('\n'));
    return;
  }
  const userProject = made['ordinary user mern'].id;
  const d = new DatabaseSync(path.join(dataDir, 'app.db'));
  try {
    const last = d.prepare("SELECT result_json FROM recreates WHERE project_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1").get(userProject);
    const report = JSON.parse(last.result_json);
    const broken = randomUUID();
    const later = new Date(Date.now() + 1000).toISOString();
    d.prepare("INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)").run(broken, userProject, later, later, JSON.stringify({ ...report, recreateId: broken }));
    await mkdir(path.join(dataDir, 'projects', userProject, 'recreate', broken, 'stacks', 'mern', 'client', 'dist'), { recursive: true });
    await writeFile(path.join(dataDir, 'projects', userProject, 'recreate', broken, 'stacks', 'mern', 'package.json'), '{}');
    const rows = () => d.prepare('SELECT count(*) AS n FROM reaudits WHERE project_id = ?').get(userProject).n;
    const before = rows();
    const answers = [];
    for (let i = 0; i < 3; i++) {
      answers.push(await user('POST', `/api/projects/${userProject}/reaudit`, {}));
      // A queued job fails in a moment; the next click comes after it, as a person's would.
      await until('the re-audit to end', async () => !(await user('GET', `/api/projects/${userProject}/reaudit/current`)).json, { timeoutMs: 60_000, output: api.output });
    }
    const queued = rows() - before;
    if (queued || answers.some((r) => r.status !== 409)) {
      failures.push(`"Compare now" ×3 on a copy with no home page: answers ${answers.map((r) => r.status).join(', ')}, ${queued} re-audit(s) queued (expected 409 ×3 and none)`);
    }
    for (const r of answers.filter((a) => a.status === 409)) {
      assert.equal(r.json.blocked, true);
      assert.match(r.json.error, /The copy has no page at its home address \(\/\) in stacks[\\/]mern[\\/]client[\\/]dist.*Make the copy again\./);
    }
  } finally {
    d.close();
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});
