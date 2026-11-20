// A new website's "Pages to check" is the most a check reads (user, 2026-11-13: was 25; 2026-11-14: 150, was 100; 2026-11-16: 300; 2026-11-18: 1500), so its first
// check covers the whole site. A number the user sets is marked, so a later change of the default never moves it, and the one-time
// migration moves only projects still at the old default.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { db } from '../src/db/index.js';
import { applySchema } from '../src/db/schema.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { applyStartMigrations } from '../src/db/apply.js';
import { MAX_CHECK_PAGES, parseMaxPages } from '../src/routes/analyze.js';

const PAGES_150 = MIGRATIONS.find((m) => m.id === '2026-11-14-check-pages-150');
const PAGES_300 = MIGRATIONS.find((m) => m.id === '2026-11-16-check-pages-300');
const PAGES_1500 = MIGRATIONS.find((m) => m.id === '2026-11-18-check-pages-1500');
// The change tables for Growth OS (src/changes/) are a start migration too, applied after these.
const START = [PAGES_150.id, PAGES_300.id, PAGES_1500.id, '2026-11-20-change-requests'];

// The order of a real start: the projects route is loaded first (src/index.js imports it), then the server applies its start
// migrations. The route looks for the column when a number is set, so it marks choices from then on without a restart.
const { default: projectsRouter, DEFAULT_MAX_PAGES } = await import('../src/routes/projects.js');
assert.deepEqual(applyStartMigrations(db), START, 'the test database is new: it has only the required migrations');

test('a new website starts with 1500 pages to check, the most allowed; the user can lower it and that number is marked as chosen', async () => {
  assert.equal(MAX_CHECK_PAGES, 1500);
  assert.equal(DEFAULT_MAX_PAGES, 1500);
  assert.equal(parseMaxPages(1500), 1500);
  assert.equal(parseMaxPages(1501), null);
  assert.equal(parseMaxPages(0), null);
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;
  const made = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://default-pages.example/', authorized: true }) });
  assert.equal(made.status, 201, await made.clone().text());
  const project = await made.json();
  after(() => db.prepare('DELETE FROM projects WHERE id = ?').run(project.id));
  const row = () => ({ ...db.prepare('SELECT max_pages, max_pages_chosen FROM projects WHERE id = ?').get(project.id) });
  assert.deepEqual(row(), { max_pages: 1500, max_pages_chosen: 0 }, 'the default is not a choice');
  const patch = (n) => fetch(`${base}/${project.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_pages: n }) });
  const tooMany = await patch(1501);
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /from 1 to 1500/);
  assert.equal(row().max_pages_chosen, 0, 'a refused number marks nothing');
  const lowered = await patch(30);
  assert.equal(lowered.status, 200, await lowered.clone().text());
  assert.deepEqual(row(), { max_pages: 30, max_pages_chosen: 1 });
  const highest = await patch(1500);
  assert.equal(highest.status, 200);
  assert.deepEqual(row(), { max_pages: 1500, max_pages_chosen: 1 });
});

test('the server applies the migrations when it starts: projects at the old default (100, then 150, then 300) move to 1500, any other number stays, and they run once', () => {
  assert.equal(PAGES_150.onStart, true);
  assert.ok(!PAGES_150.required, 'not required: a database without it still starts');
  assert.equal(PAGES_300.onStart, true);
  assert.ok(!PAGES_300.required);
  assert.equal(PAGES_1500.onStart, true);
  assert.ok(!PAGES_1500.required);
  const mem = new DatabaseSync(':memory:');
  applySchema(mem);
  const add = mem.prepare("INSERT INTO projects (id, name, url, max_pages, created_at, updated_at) VALUES (?, ?, 'https://x.dev', ?, 't', 't')");
  add.run('at-100', 'A', 100);
  add.run('at-25', 'B', 25);
  add.run('at-60', 'C', 60);
  add.run('at-150', 'D', 150);
  add.run('at-300', 'E', 300);
  const pages = () => Object.fromEntries(mem.prepare('SELECT id, max_pages, max_pages_chosen FROM projects').all().map((r) => [r.id, [r.max_pages, r.max_pages_chosen]]));
  const records = () => mem.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id);
  assert.deepEqual(applyStartMigrations(mem), START, 'only the start migrations, none of the others');
  assert.deepEqual(pages(), { 'at-100': [1500, 0], 'at-25': [25, 0], 'at-60': [60, 0], 'at-150': [1500, 0], 'at-300': [1500, 0] });
  assert.deepEqual(records(), START);
  // The next start: recorded, so nothing runs, even for a project the user has since set to 100 (marked).
  mem.prepare("UPDATE projects SET max_pages = 100, max_pages_chosen = 1 WHERE id = 'at-60'").run();
  assert.deepEqual(applyStartMigrations(mem), []);
  assert.deepEqual(pages(), { 'at-100': [1500, 0], 'at-25': [25, 0], 'at-60': [100, 1], 'at-150': [1500, 0], 'at-300': [1500, 0] });
  assert.deepEqual(records(), START);
  // Safe if run again without its record: a project the user set to 100 is a choice and stays.
  PAGES_150.up(mem, {});
  PAGES_300.up(mem, {});
  PAGES_1500.up(mem, {});
  assert.deepEqual(pages(), { 'at-100': [1500, 0], 'at-25': [25, 0], 'at-60': [100, 1], 'at-150': [1500, 0], 'at-300': [1500, 0] });
  mem.close();
});

test('a database that already has the column (another branch, a manual run) still gets its projects at the old defaults moved, once; a number chosen stays', () => {
  const mem = new DatabaseSync(':memory:');
  applySchema(mem);
  mem.exec('ALTER TABLE projects ADD COLUMN max_pages_chosen INTEGER NOT NULL DEFAULT 0');
  const add = mem.prepare("INSERT INTO projects (id, name, url, max_pages, max_pages_chosen, created_at, updated_at) VALUES (?, ?, 'https://x.dev', ?, ?, 't', 't')");
  add.run('default', 'A', 100, 0);
  add.run('chosen', 'B', 100, 1);
  add.run('other', 'C', 40, 0);
  add.run('chose-150', 'D', 150, 1);
  add.run('chose-300', 'E', 300, 1);
  assert.deepEqual(applyStartMigrations(mem), START);
  const pages = () => Object.fromEntries(mem.prepare('SELECT id, max_pages FROM projects').all().map((r) => [r.id, r.max_pages]));
  assert.deepEqual(pages(), { default: 1500, chosen: 100, other: 40, 'chose-150': 150, 'chose-300': 300 });
  assert.deepEqual(applyStartMigrations(mem), []);
  mem.close();
});

test('the crawl step is given more time for more pages: 75 s up to about 100 pages, about 115 s for 150, 231 s for 300', async () => {
  const { crawlMaxMs } = await import('../src/audit/index.js');
  assert.equal(crawlMaxMs(25), 75000);
  assert.equal(crawlMaxMs(97), 75000);
  assert.ok(crawlMaxMs(150) >= 115000 && crawlMaxMs(150) <= 116000, String(crawlMaxMs(150)));
  assert.equal(crawlMaxMs(300), 231000);
});
