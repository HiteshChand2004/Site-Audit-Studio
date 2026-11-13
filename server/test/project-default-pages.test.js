// A new website's "Pages to check" is the most a check reads (user, 2026-11-13: was 25), so its first check covers the whole site.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db } from '../src/db/index.js';
import projectsRouter, { DEFAULT_MAX_PAGES } from '../src/routes/projects.js';

test('a new website starts with 100 pages to check; the user can still lower it', async () => {
  assert.equal(DEFAULT_MAX_PAGES, 100);
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
  assert.equal(db.prepare('SELECT max_pages FROM projects WHERE id = ?').get(project.id).max_pages, 100);
  const lowered = await fetch(`${base}/${project.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_pages: 30 }) });
  assert.equal(lowered.status, 200, await lowered.clone().text());
  assert.equal(db.prepare('SELECT max_pages FROM projects WHERE id = ?').get(project.id).max_pages, 30);
});
