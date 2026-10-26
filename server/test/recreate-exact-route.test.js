// The exact comparison's picture route (GET …/recreate/:recreateId/exact/:slug/:file) against the names the comparison
// really writes: the original's bands (capture/exact.js bandFile), the copy's bands, the map and the crops
// (verify/exact/compare.js). The route's name check was once written with its backslashes lost ("d{3,4}" = the letter d),
// so every real name answered 404 and the pictures were never viewable; this test holds the check to the real names, so a
// regex that silently matches nothing can never come back.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import recreateRouter from '../src/routes/recreate.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { bandFile } from '../src/recreate/capture/exact.js';
import { copyBand, cropFile, mapFile } from '../src/recreate/verify/exact/compare.js';
import { seedProject } from './helpers/projects.js';

const projectId = randomUUID();
const recreateId = randomUUID();
const slug = 'index';
let server;
let base;

// What each side writes, by the functions that name the files: the original's full shot and bands with the capture, the
// copy's shots, the map and the crops with the fidelity output. Slot ids are a width or a width×height.
const ORIGINAL = [bandFile('1440', 0), bandFile('1440', 1), bandFile('1440x600', 0), bandFile('390', 3)];
const COPY = [copyBand('1440', 0), copyBand('1440', 2), copyBand('1440x600', 0), mapFile('1440'), cropFile('1440', 1), cropFile('1440x600', 3)];

before(async () => {
  seedProject(db, { id: projectId, name: 'exact', url: 'https://example.com/', stack: 'html', authorized: 1 });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at) VALUES (?, ?, ?, 100, ?, ?)')
    .run(recreateId, projectId, 'done', now, now);
  const dir = recreateDir(projectId, recreateId);
  await mkdir(path.join(dir, 'capture', slug, 'exact'), { recursive: true });
  await mkdir(path.join(dir, 'fidelity', slug, 'exact'), { recursive: true });
  for (const f of ORIGINAL) await writeFile(path.join(dir, 'capture', slug, 'exact', f), `RIFF....WEBP original ${f}`);
  for (const f of COPY) await writeFile(path.join(dir, 'fidelity', slug, 'exact', f), `RIFF....WEBP copy ${f}`);

  const app = express();
  app.use('/api/projects', recreateRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/projects/${projectId}/recreate/${recreateId}/exact/${slug}`;
});

after(async () => {
  server.close();
  db.prepare('DELETE FROM recreates WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  await rm(projectDir(projectId), { recursive: true, force: true });
});

test('every picture the comparison writes is served from the right folder, as WebP', async () => {
  // The names are what the pipeline's own functions produce, not retyped here.
  assert.deepEqual(ORIGINAL, ['1440-full.webp', '1440-b1.webp', '1440x600-full.webp', '390-b3.webp']);
  assert.deepEqual(COPY, ['copy-1440-full.webp', 'copy-1440-b2.webp', 'copy-1440x600-full.webp', '1440-map.webp', '1440-crop1.webp', '1440x600-crop3.webp']);
  for (const [files, side] of [[ORIGINAL, 'original'], [COPY, 'copy']]) {
    for (const f of files) {
      const res = await fetch(`${base}/${f}`);
      assert.equal(res.status, 200, `${f} → ${res.status}`);
      assert.equal(res.headers.get('content-type'), 'image/webp');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await res.text(), `RIFF....WEBP ${side} ${f}`, `${f} came from the wrong folder`);
    }
  }
});

test('a name outside the comparison\'s shape answers 404 before the disk is read', async () => {
  const bad = [
    'dddd-full.webp', // what the broken check used to accept in place of digits
    '1440-full.png', '1440-fullXwebp', '14-full.webp', '14400-full.webp', '1440-b4.webp', '1440-crop4.webp',
    '1440-map.webp.bak', 'copy-1440-map.webp', 'noise-1440-full.webp', '..', '%2e%2e%2f1440-full.webp',
  ];
  for (const f of bad) {
    const res = await fetch(`${base}/${f}`);
    assert.equal(res.status, 404, `${f} → ${res.status}`);
  }
  // A missing but well-formed name is a 404 from the disk, with the retention note.
  const res = await fetch(`${base}/${bandFile('1024', 0)}`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /latest 2 recreates/);
});

test('a recreate that is not finished, or another project\'s, has no pictures', async () => {
  const otherProject = randomUUID();
  const running = randomUUID();
  seedProject(db, { id: otherProject, name: 'other', url: 'https://example.org/', stack: 'html', authorized: 1 });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO recreates (id, project_id, status, progress, started_at) VALUES (?, ?, ?, 50, ?)').run(running, projectId, 'running', now);
  try {
    const port = server.address().port;
    const other = await fetch(`http://127.0.0.1:${port}/api/projects/${otherProject}/recreate/${recreateId}/exact/${slug}/${ORIGINAL[0]}`);
    assert.equal(other.status, 404);
    const notDone = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/recreate/${running}/exact/${slug}/${ORIGINAL[0]}`);
    assert.equal(notDone.status, 404);
  } finally {
    db.prepare('DELETE FROM recreates WHERE id = ?').run(running);
    db.prepare('DELETE FROM projects WHERE id = ?').run(otherProject);
  }
});
