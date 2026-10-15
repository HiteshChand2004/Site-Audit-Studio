// Screenshot route (whitelisted names only) and the keep-latest-3 retention.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import screensRouter from '../src/routes/screens.js';
import { pruneScreenshots } from '../src/audit/retention.js';
import { seedAnalysis, seedProject } from './helpers/projects.js';

const projectId = randomUUID();
const analyses = Array.from({ length: 5 }, () => randomUUID());
const failed = randomUUID();
let server;
let base;

const screens = (id) => path.join(projectDir(projectId), 'audit', id, 'screens');

before(async () => {
  const now = Date.now();
  seedProject(db, { id: projectId, name: 'test', url: 'https://example.com/', stack: 'html', authorized: 1 });
  analyses.forEach((id, i) => seedAnalysis(db, projectId, null, { id, at: new Date(now + i * 1000).toISOString(), finished: false }));
  seedAnalysis(db, projectId, null, { id: failed, status: 'failed', at: new Date(now + 9000).toISOString(), finished: false });
  for (const id of [...analyses, failed]) {
    await mkdir(screens(id), { recursive: true });
    await writeFile(path.join(screens(id), 'desktop-fold.webp'), 'RIFF....WEBP');
  }

  const app = express();
  app.use('/api/projects', screensRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/projects/${projectId}/analyses`;
});

after(async () => {
  server.close();
  db.prepare('DELETE FROM analyses WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  await rm(projectDir(projectId), { recursive: true, force: true });
});

test('serves a whitelisted screenshot with immutable caching', async () => {
  const res = await fetch(`${base}/${analyses[4]}/screens/desktop-fold.webp`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('rejects unknown names, traversal and foreign analyses', async () => {
  const paths = [
    `${base}/${analyses[4]}/screens/secret.txt`,
    `${base}/${analyses[4]}/screens/..%2F..%2F..%2Fapp.db`,
    `${base}/${analyses[4]}/screens/desktop-full.webp`, // valid name, file does not exist
    `${base}/not-a-uuid/screens/desktop-fold.webp`,
    `${base.replace(projectId, randomUUID())}/${analyses[4]}/screens/desktop-fold.webp`,
  ];
  for (const url of paths) assert.equal((await fetch(url)).status, 404, url);
});

test('retention keeps screenshots of the latest 3 completed analyses', async () => {
  const removed = await pruneScreenshots(projectId);
  assert.deepEqual(removed.sort(), [analyses[0], analyses[1], failed].sort());
  for (const id of analyses.slice(2)) assert.deepEqual(await readdir(screens(id)), ['desktop-fold.webp']);
  // The JSON artifacts of an analysis would stay; only screens/ is removed.
  await assert.rejects(readdir(screens(analyses[0])));
});
