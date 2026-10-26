// The number of pages an analysis crawls: a new project starts at the most the server allows, and more than that is refused.
// No network: the project's address is never fetched (the refused analysis never starts).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db } from '../src/db/index.js';
import projectsRouter from '../src/routes/projects.js';
import analyzeRouter, { DEFAULT_MAX_PAGES, MAX_PAGES } from '../src/routes/analyze.js';

let api;
let base;
const projectIds = [];

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use('/api/projects', analyzeRouter);
  await new Promise((resolve) => { api = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${api.address().port}/api/projects`;
});
after(() => {
  api.close();
  for (const id of projectIds) db.prepare('DELETE FROM projects WHERE id = ?').run(id);
});

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a new project reads the most pages the server allows, and an analysis of more pages is refused', async () => {
  assert.equal(DEFAULT_MAX_PAGES, 100);
  assert.equal(MAX_PAGES, 100);

  const res = await post(base, { url: 'https://example.com/', authorized: true });
  assert.equal(res.status, 201);
  const project = await res.json();
  projectIds.push(project.id);
  assert.equal(project.max_pages, 100);
  assert.equal(db.prepare('SELECT max_pages FROM projects WHERE id = ?').get(project.id).max_pages, 100);

  const refused = await post(`${base}/${project.id}/analyze`, { maxPages: 101 });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /from 1 to 100/);
});
