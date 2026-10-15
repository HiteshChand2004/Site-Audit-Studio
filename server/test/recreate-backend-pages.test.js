// Every page of a site is recreated, whatever its backend does (recreate/discover.js, recreate/inspect.js,
// recreate/recover.js): an unavailable backend may limit what a page can do, but it never takes the page out of the copy.
// The fixture's pages each fail in their own way:
//   /login      a sign-in form (an address that "needs a backend")      → recreated as rendered, flagged
//   /dashboard  answers 401 with its own "please sign in" page           → recreated as rendered, flagged degraded
//   /orders     renders, but its data request answers 503                → recreated with the site's own error state
//   /status     the server drops the connection: nothing renders at all  → rebuilt from evidence (the homepage's header
//               and footer, the analysis's title and headings, a marked empty state), still linked although the
//               analysis listed it as a broken link
//   /admin      robots.txt asks crawlers not to read it                   → a page all the same, flagged robotsBlocked
//   /missing    404: an address that does not exist                       → not a page (a broken link), reported
// Run through the real pipeline (capture, assets, generate, build) in normal mode and in exact mode.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { evidenceFor, nameFromPath, reasonText } from '../src/recreate/recover.js';
import { seedAnalysis, seedProject } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
const PORT = 4243;
const origin = `http://localhost:${PORT}`;

const frame = (main) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backend fixture</title><style>
body { margin: 0; font: 16px/1.5 Arial, sans-serif; color: #1f2937 }
header { display: flex; gap: 20px; align-items: center; padding: 18px 32px; background: #0f172a; color: #fff }
header a { color: #fff; text-decoration: none } .brand { font-weight: 700; margin-right: auto }
main { max-width: 900px; margin: 0 auto; padding: 48px 24px; min-height: 300px }
footer { padding: 24px 32px; background: #e5e7eb; text-align: center }
table { border-collapse: collapse; width: 100% } th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left }
</style></head><body>
<header><span class="brand">Fixture Co</span><nav><a href="/">Home</a> <a href="/login">Sign in</a> <a href="/dashboard">Dashboard</a> <a href="/orders">Orders</a> <a href="/status">Status</a> <a href="/admin">Admin</a> <a href="/missing">Old page</a></nav></header>
${main}
<footer><p>&copy; Fixture Co. All rights reserved.</p></footer>
</body></html>`;

const HOME = frame('<main><h1>Welcome to Fixture Co</h1><p>We make things that work, even when the server does not.</p><section><h2>What we do</h2><p>Plenty.</p></section></main>');
const LOGIN = frame('<main><h1>Sign in</h1><form method="post" action="/api/session"><label>Email <input type="email" name="email" required></label><label>Password <input type="password" name="password" required></label><button type="submit">Sign in</button></form></main>');
const ADMIN = frame('<main><h1>Admin panel</h1><button type="button">Publish changes</button></main>');
const DASHBOARD = frame('<main><h1>Please sign in</h1><p>Your dashboard is only available to signed-in customers.</p><a href="/login">Go to sign in</a></main>');
const ORDERS = frame(`<main><h1>Your orders</h1><table><thead><tr><th>Order</th><th>Date</th><th>Total</th></tr></thead><tbody id="rows"></tbody></table><p id="state">Loading orders…</p>
<script>fetch('/api/orders').then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(function (rows) { document.getElementById('state').textContent = rows.length + ' orders'; })
  .catch(function () { document.getElementById('state').textContent = 'Orders could not be loaded right now.'; });</script></main>`);

let server;
const projectIds = [];
before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, origin);
    const send = (status, body, type = 'text/html') => res.writeHead(status, { 'content-type': type }).end(body);
    if (u.pathname === '/') return send(200, HOME);
    if (u.pathname === '/login') return send(200, LOGIN);
    if (u.pathname === '/dashboard') return send(401, DASHBOARD);
    if (u.pathname === '/admin') return send(200, ADMIN);
    if (u.pathname === '/orders') return send(200, ORDERS);
    if (u.pathname === '/api/orders') return send(503, '{"error":"backend down"}', 'application/json');
    // The backend of this page is gone: the connection drops without an answer.
    if (u.pathname === '/status') return req.socket.destroy();
    if (u.pathname === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /admin\n', 'text/plain');
    return send(404, '<!doctype html><title>Not found</title><h1>Not found</h1>');
  });
  await new Promise((r) => { server.listen(PORT, r); });
});
after(async () => {
  server?.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

/** A project with an analysis: what it read of /status (it rendered once), and its link check calling /status broken. */
async function newProject() {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  const analysisId = randomUUID();
  seedProject(db, { id, name: 'backend', url: `${origin}/`, stack: 'html', authorized: 1, recreatePages: -1 });
  seedAnalysis(db, id, { url: `${origin}/`, analyzedAt: now, brokenLinks: { broken: [{ url: `${origin}/status`, status: 'refused' }, { url: `${origin}/missing`, status: 404 }] } }, { id: analysisId });
  const dir = path.join(projectDir(id), 'audit', analysisId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'crawl.json'), JSON.stringify({
    pages: [
      { url: `${origin}/`, status: 200, facts: { title: 'Backend fixture', links: [] } },
      { url: `${origin}/status`, status: 200, facts: { title: 'Service status | Fixture Co', metaDescription: 'Live status of every Fixture Co service.', headings: [{ level: 1, text: 'Service status' }, { level: 2, text: 'Uptime' }, { level: 2, text: 'Incidents' }] } },
    ],
  }));
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

const stub = async () => {};
async function run(mode) {
  const project = await newProject();
  const recreateId = randomUUID();
  const report = await runRecreate({
    project, recreateId, progress: () => {}, ...(mode === 'exact' && { exact: true }),
    stages: { ...STAGES, sweep: stub, exactCapture: stub, exact: stub, responsive: stub, stack: stub },
  });
  const dist = path.join(recreateDir(project.id, recreateId), 'dist');
  const read = (p) => readFile(path.join(dist, ...p.split('/')), 'utf8');
  return { report, read };
}

test('evidence: the best name and sections there are, said where they came from', () => {
  const ev = evidenceFor({ url: `${origin}/status`, path: '/status' }, { title: 'Service status | X', headings: [{ level: 1, text: 'Service status' }, { level: 2, text: 'Uptime' }] });
  assert.equal(ev.title, 'Service status');
  assert.deepEqual(ev.headings.map((h) => h.text), ['Uptime']);
  assert.ok(ev.sources.includes('heading read by the analysis'));
  const bare = evidenceFor({ url: `${origin}/my-account/order-history/`, path: '/my-account/order-history/' }, null);
  assert.equal(bare.title, 'Order history');
  assert.deepEqual(bare.sources, ['the page address']);
  assert.equal(nameFromPath('/'), 'Page');
  assert.match(reasonText({ degraded: { status: 503 } }), /error \(503\)/);
  assert.match(reasonText({ degraded: { status: 0, error: 'refused' } }), /could not be reached/);
});

for (const mode of ['normal', 'exact']) {
  test(`${mode} mode: every page is recreated whatever its backend does, and says what it could not have`, async () => {
    const { report, read } = await run(mode);
    const byPath = Object.fromEntries(report.pages.map((p) => [p.path, p]));
    assert.deepEqual(Object.keys(byPath).sort(), ['/', '/admin', '/dashboard', '/login', '/orders', '/status'], JSON.stringify({ pages: report.pages.map((p) => p.path), skipped: report.discovery?.skipped, notRecreated: report.notRecreated }));
    assert.deepEqual(report.notRecreated, []);
    // /missing does not exist: a broken link, never a page.
    assert.ok(report.discovery.skipped.some((s) => s.url.endsWith('/missing') && s.reason === 'not-found'), JSON.stringify(report.discovery.skipped));

    // A page robots.txt closes is in the copy all the same, with its UI.
    assert.equal(byPath['/admin'].robotsBlocked, true);
    assert.match(await read('admin/index.html'), /Publish changes/);
    // A sign-in page: its form is there; it is flagged, and nothing pretends it can sign anyone in.
    assert.equal(byPath['/login'].needsBackend, true);
    const login = await read('login/index.html');
    assert.match(login, /type="email"/);
    assert.match(login, /type="password"/);
    assert.doesNotMatch(login, /action="[^"]*api\/session/, 'the form does not post to the original');
    // A page the server answers with 401: recreated as it rendered.
    assert.equal(byPath['/dashboard'].degraded?.status, 401);
    assert.match(await read('dashboard/index.html'), /Please sign in/);
    // A page whose data did not load: the site's own error state, and the report says the data was missing.
    assert.ok(byPath['/orders'].dataUnavailable?.count >= 1, JSON.stringify(byPath['/orders']));
    assert.match(await read('orders/index.html'), /Orders could not be loaded right now\./);
    // A page that never rendered: rebuilt from evidence - the site's frame, the analysis's headings, a marked empty state.
    const status = byPath['/status'];
    assert.ok(status.recovered, JSON.stringify(status));
    assert.ok(status.recovered.evidence.includes("the site's header from its homepage"), JSON.stringify(status.recovered));
    assert.ok(status.recovered.evidence.includes("the site's footer from its homepage"));
    assert.ok(status.recovered.evidence.includes('heading read by the analysis'));
    const html = await read('status/index.html');
    for (const text of ['Service status', 'Uptime', 'Incidents', 'Content not available in this copy', 'Fixture Co. All rights reserved', 'Dashboard']) {
      assert.ok(html.includes(text), `${text} on the rebuilt page`);
    }
    assert.doesNotMatch(html, /Welcome to Fixture Co/, "the homepage's own content is not passed off as this page's");
    // Links to the pages that failed stay links (the analysis called /status broken; it is a page of the copy now).
    const home = await read('index.html');
    assert.match(home, /href="status\/"[^>]*>Status</);
    assert.match(home, /href="dashboard\/"[^>]*>Dashboard</);
    // Every page that needs a backend, lost its data or was rebuilt is named for a person to look at.
    const manual = report.manual.filter((m) => m.kind === 'page').map((m) => m.title);
    for (const p of ['/login', '/dashboard', '/orders', '/status']) assert.ok(manual.some((t) => t.startsWith(`${p} `)), `${p} in ${JSON.stringify(manual)}`);
  });
}
