// The new site's address given at download (Step 6): POST …/recreate { mode: 'as-is', addressOnly: true, recreateId,
// addressConfirmed } writes the address into the finished copy, files only (behavior/preserve/stage.js addressStage, no
// browser), packages it again as a new job and queues the usual re-check. "I don't know yet" sends no request: the finished
// copy downloads exactly as before and its address rows stay "Needs information from you".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { db } from '../src/db/index.js';
import recreateRouter from '../src/routes/recreate.js';
import { asIsStage } from '../src/recreate/behavior/preserve/stage.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { planZip } from '../src/recreate/export/zip.js';
import { explainWorse } from '../src/copy/gotWorse.js';
import { reauditJobs } from '../src/reaudit/jobs.js';
import { seedProject } from './helpers/projects.js';

const SITE = 'https://www.acme-original.dev/';
const NEW = 'https://www.acme-new.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = (title, canonical) => '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + `<title>${title}</title><meta name="description" content="Acme makes tools for people who build things, made to last every day.">`
  + `<link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}">`
  + `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"${SITE}"}</script>`
  + '<style>h1{color:#123}</style></head>'
  + `<body><h1>${title}</h1><p>Tools.</p><a href="/about/">About</a></body></html>`;

/** A finished as-is copy made without an address, as the full stage leaves it: lift, fixed copy, packaged output, report. */
async function finishedCopy(dir) {
  const pages = [{ url: SITE, outPath: 'index.html' }, { url: `${SITE}about/`, outPath: 'about/index.html' }];
  const files = { 'index.html': page('Acme tools for builders', SITE), 'about/index.html': page('About Acme tools', `${SITE}about/`), 'robots.txt': `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n` };
  for (const part of ['lifted', 'copy']) {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, 'as-is', part, rel)), { recursive: true });
      await writeFile(path.join(dir, 'as-is', part, rel), text, 'utf8');
    }
  }
  await mkdir(path.join(dir, 'as-is', 'baseline'), { recursive: true });
  await writeFile(path.join(dir, 'as-is', 'pages.json'), JSON.stringify({ pages, excludedHosts: [], lift: { files: 3 } }), 'utf8');
  await cp(path.join(dir, 'as-is', 'copy'), path.join(dir, 'stacks', 'html'), { recursive: true });
  await writeFile(path.join(dir, 'stacks', 'html', 'README.md'), '# Plain HTML copy\n', 'utf8');
  const noAddress = { used: null, reason: 'c', detail: 'no address was given for this copy' };
  const report = {
    stack: 'html', mode: 'as-is',
    pages: pages.map((p) => ({ url: p.url, path: new URL(p.url).pathname, outPath: p.outPath })),
    asIs: {
      stack: 'html', mode: 'as-is', pages: pages.map((p) => ({ url: p.url, path: new URL(p.url).pathname })),
      address: noAddress,
      fixes: { counts: { head: 1 }, total: 1, pages: [{ path: '/', fixes: [{ kind: 'head', field: 'theme-color', value: '#123' }] }], open: [{ kind: 'address', page: null, ...noAddress }], files: { written: ['_headers'] } },
      checks: { originalReachable: true, pages: [] }, safety: { safe: true, mode: 'as-is' },
    },
    copy: { openItems: [{ page: '/', check: 'new-site address', values: noAddress.detail, tried: 'left without an address', reason: 'owner' }], fixes: { counts: { head: 1 }, total: 1, open: [], files: [] } },
    outputs: { html: { status: 'ready', mode: 'as-is', dir: path.join('stacks', 'html'), dist: path.join('stacks', 'html') } },
    safety: { safe: true, mode: 'as-is' },
  };
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report), 'utf8');
  return report;
}

/** Every file of a folder with its hash: what "unchanged" means. */
async function hashes(dir) {
  const out = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const f = path.join(e.parentPath ?? e.path, e.name);
    out[path.relative(dir, f).split(path.sep).join('/')] = createHash('sha256').update(await readFile(f)).digest('hex');
  }
  return out;
}

/** The zip of a finished copy as planned for download: names, sizes and the text of what the plan writes itself. */
async function zipOf(dir, report) {
  const plan = await planZip({ dir, report, stack: 'html' });
  return plan.entries.map((e) => ({ name: e.name, size: e.size ?? null, content: e.content ?? null })).sort((a, b) => a.name.localeCompare(b.name));
}

test('the address stage writes the address into the finished copy, files only, and carries the checks over', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-address-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const earlier = await finishedCopy(source);
  // What the capture recorded of the homepage (behavior/preserve/recordings.js): the about page has no recording.
  await mkdir(path.join(source, 'capture', 'index'), { recursive: true });
  await writeFile(path.join(source, 'capture', 'index', 'desktop.json'), '{"view":"desktop"}', 'utf8');
  await writeFile(path.join(source, 'capture', 'index', 'motion.json'), '{"reveal":{"elements":[]}}', 'utf8');
  const before = await hashes(source);
  const ws = path.join(root, 'addressed');
  await mkdir(ws, { recursive: true });
  const ctx = { dir: ws, baseUrl: NEW, asIs: { stack: 'html', fromDir: source, address: NEW, addressOnly: true }, progress: () => {}, report: { outputs: {}, warnings: [] } };
  await asIsStage(ctx);
  // The recordings travel with the new job (hard links), so they outlive the job it was made from.
  const ino = async (dir) => (await stat(path.join(dir, 'capture', 'index', 'motion.json'))).ino;
  assert.equal(await ino(ws), await ino(source), 'the recording is hard-linked into the new job');
  assert.deepEqual({ recorded: ctx.report.asIs.recordings.recorded, missing: ctx.report.asIs.recordings.missing }, { recorded: 1, missing: ['about/index.html'] });

  const out = path.join(ws, 'stacks', 'html');
  const home = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(home, /<link rel="canonical" href="https:\/\/www\.acme-new\.dev\/">/);
  assert.match(home, /<meta property="og:url" content="https:\/\/www\.acme-new\.dev\/">/);
  assert.match(home, /"url":"https:\/\/www\.acme-original\.dev\/"/, 'the JSON-LD is kept as the original wrote it');
  assert.match(home, /<h1>Acme tools for builders<\/h1><p>Tools\.<\/p>/, 'the page itself is untouched');
  assert.match(await readFile(path.join(out, 'sitemap.xml'), 'utf8'), /https:\/\/www\.acme-new\.dev\/about\//);
  assert.match(await readFile(path.join(out, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/www\.acme-new\.dev\/sitemap\.xml/);

  const r = ctx.report;
  assert.equal(r.asIs.address.used, NEW);
  assert.equal(r.asIs.addressPass.ok, true);
  assert.ok(r.asIs.fixes.counts.address >= 2, JSON.stringify(r.asIs.fixes.counts));
  assert.ok(!r.asIs.fixes.open.some((o) => o.kind === 'address' && o.page == null), 'the "no address" item is answered');
  assert.ok(r.asIs.fixes.open.some((o) => o.field === 'json-ld'), 'the JSON-LD naming the original is listed');
  assert.ok(!r.copy.openItems.some((o) => o.check === 'new-site address'));
  assert.ok(r.copy.openItems.some((o) => o.check === 'structured data names the original' && /kept as the original wrote it/.test(o.values)));
  assert.deepEqual(r.asIs.checks, earlier.asIs.checks, 'what was measured is carried over, nothing is measured again');
  assert.equal(r.safety.safe, true);
  assert.equal(r.outputs.html.status, 'ready');
  assert.match(r.asIs.carried.what, /head tags and site files/);
  assert.deepEqual(await hashes(source), before, 'the finished copy it came from is never changed');
});

test('POST …/recreate addressOnly: refused without a usable address or a finished copy; runs with no browser and queues the re-check', { timeout: 120000 }, async (t) => {
  const projectId = randomUUID();
  seedProject(db, { id: projectId, name: 'address', url: SITE, stack: 'html', authorized: 1, analysis: { url: SITE } });
  t.after(() => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId));
  const sourceId = randomUUID();
  const sourceDir = recreateDir(projectId, sourceId);
  const report = await finishedCopy(sourceDir);
  db.prepare(`INSERT INTO recreates (id, project_id, status, started_at, finished_at, result_json) VALUES (?, ?, 'done', ?, ?, ?)`)
    .run(sourceId, projectId, '2026-01-01T10:00:00Z', '2026-01-01T10:05:00Z', JSON.stringify(report));
  const zipBefore = await zipOf(sourceDir, report);
  const sourceBefore = await hashes(sourceDir);
  // The re-check the job queues is recorded, not run: this test has no audit files and opens no browser.
  const queued = [];
  const realStart = reauditJobs.start;
  reauditJobs.start = (_project, payload) => { queued.push(payload.recreateId); return { id: randomUUID() }; };
  t.after(() => { reauditJobs.start = realStart; });

  const app = express();
  app.use(express.json());
  app.use('/api/projects', recreateRouter);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/projects/${projectId}/recreate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'as-is', confirmed: true, addressOnly: true, ...body }),
  });

  for (const bad of [undefined, '', 'not a web address', 'https://new.example.com', 'https://shop.test', 'https://www.acme-original.dev']) {
    const res = await post({ recreateId: sourceId, addressConfirmed: bad });
    assert.equal(res.status, 400, String(bad));
  }
  assert.equal((await post({ recreateId: randomUUID(), addressConfirmed: NEW })).status, 409, 'no such finished copy');
  assert.equal((await post({ recreateId: 'nope', addressConfirmed: NEW })).status, 409);
  assert.equal(db.prepare('SELECT target_domain FROM projects WHERE id = ?').get(projectId).target_domain ?? null, null, 'nothing saved on a refusal');

  const res = await post({ recreateId: sourceId, addressConfirmed: `${NEW}/some/page` });
  assert.equal(res.status, 202, await res.clone().text());
  const { recreateId } = await res.json();
  assert.equal(db.prepare('SELECT target_domain FROM projects WHERE id = ?').get(projectId).target_domain, NEW, 'saved on the website');
  let row;
  for (let i = 0; i < 600; i++) {
    row = db.prepare('SELECT status, error, result_json FROM recreates WHERE id = ?').get(recreateId);
    if (row?.status === 'done' || row?.status === 'failed') break;
    await sleep(100);
  }
  assert.equal(row.status, 'done', row.error ?? '');
  const done = JSON.parse(row.result_json);
  assert.equal(done.asIs.address.used, NEW);
  assert.equal(done.asIs.addressedFrom, sourceId);
  assert.match(await readFile(path.join(recreateDir(projectId, recreateId), 'stacks', 'html', 'index.html'), 'utf8'), /href="https:\/\/www\.acme-new\.dev\/"/);

  // The usual re-check is queued by itself (decision 3).
  for (let i = 0; i < 100 && !queued.includes(recreateId); i++) await sleep(100);
  assert.deepEqual(queued, [recreateId], 'a re-check was queued for the addressed copy');

  // The copy it came from is kept by retention, unchanged, and downloads exactly as before.
  assert.deepEqual(await hashes(sourceDir), sourceBefore);
  assert.deepEqual(await zipOf(sourceDir, report), zipBefore);
  // Asked again with the addressed copy: it starts again from the finished copy; an addressed copy is never addressed twice.
  const again = await post({ recreateId, addressConfirmed: 'https://www.acme-other.dev' });
  assert.equal(again.status, 202, await again.clone().text());
  const { recreateId: secondId } = await again.json();
  for (let i = 0; i < 600; i++) {
    row = db.prepare('SELECT status, error, result_json FROM recreates WHERE id = ?').get(secondId);
    if (row?.status === 'done' || row?.status === 'failed') break;
    await sleep(100);
  }
  assert.equal(row.status, 'done', row.error ?? '');
  assert.equal(JSON.parse(row.result_json).asIs.addressedFrom, sourceId);
  for (let i = 0; i < 100 && !queued.includes(secondId); i++) await sleep(100);
  assert.deepEqual(queued, [recreateId, secondId]);
  assert.deepEqual(await hashes(sourceDir), sourceBefore, 'still kept and unchanged after the second address');
});

test('"I don\'t know yet": the zip is exactly as today and the address rows stay "Needs information from you"', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-address-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const report = await finishedCopy(source);
  // No request is sent: the download is the finished copy's own plan, read twice, the same both times and naming no address.
  const first = await zipOf(source, report);
  assert.deepEqual(await zipOf(source, report), first);
  const deploy = first.find((e) => e.name.endsWith('/DEPLOY.md'));
  assert.ok(deploy, first.map((e) => e.name).join(', '));
  assert.match(deploy.content, /address was not set/);
  assert.doesNotMatch(deploy.content, /acme-new/);

  const rows = [
    { key: 'crawl.sitemap', title: 'Sitemap', status: 'open', before: { detail: 'none' }, after: { detail: 'sitemap.xml not found' } },
    { key: 'crawl.robots', title: 'robots.txt', status: 'open', before: { detail: 'x' }, after: { detail: 'robots.txt names no sitemap' } },
    { key: 'seo.canonical-url', title: 'Canonical', status: 'open', before: { detail: 'x' }, after: { detail: 'canonical names another site' } },
    { key: 'aeo.llms-txt', title: 'llms.txt', status: 'open', before: { detail: 'x' }, after: { detail: 'no llms.txt' } },
  ];
  const out = explainWorse({ items: rows, siteUrl: SITE, copyOrigin: 'http://127.0.0.1:5101', copyPages: ['/', '/about/'], address: report.asIs.address, fixOpen: report.asIs.fixes.open });
  assert.equal(out.open.length, rows.length);
  for (const r of out.open) {
    assert.equal(r.reason, 'owner', r.key);
    assert.equal(r.group, 'needs-info', r.key);
    assert.match(r.evidence, /No new-site address was given/, r.key);
  }
});

test('a structured-data row says in plain words that the JSON-LD still names the original, only when it does', () => {
  const row = { key: 'aeo.json-ld-schema', title: 'Structured data', status: 'open', before: { detail: 'Invalid JSON-LD' }, after: { detail: 'Invalid JSON-LD on /' } };
  const args = { items: [row], siteUrl: SITE, copyOrigin: 'http://127.0.0.1:5101', copyPages: ['/'], address: { used: NEW } };
  const withNote = explainWorse({ ...args, fixOpen: [{ kind: 'address', field: 'json-ld', page: '/', reason: 'c', detail: 'x' }] }).open[0];
  assert.match(withNote.evidence, /still names the original site's address: it is kept as the original wrote it\.$/);
  assert.equal(withNote.reason, 'owner', 'the note adds words, it never changes the reason');
  const without = explainWorse({ ...args, fixOpen: [] }).open[0];
  assert.doesNotMatch(without.evidence, /still names the original/);
  const other = explainWorse({ ...args, items: [{ ...row, key: 'seo.title-tag.length' }], fixOpen: [{ kind: 'address', field: 'json-ld', page: '/' }] }).open[0];
  assert.doesNotMatch(other.evidence ?? '', /still names the original/, 'only structured-data rows carry it');
});
