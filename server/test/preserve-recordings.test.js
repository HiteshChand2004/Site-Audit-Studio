// An as-is copy's recordings of the original (page snapshots, animation and click recordings, pictures) travel with every repack,
// so a converted stack can rebuild the original's animations from them even after the job they were captured in is removed.
// Before, a repack kept only the pictures: a copy repacked twice had nothing left to rebuild from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { carryRecordings, recordingsOf } from '../src/recreate/behavior/preserve/recordings.js';

const PAGES = [{ outPath: 'index.html' }, { outPath: 'about/index.html' }];

async function captured(dir) {
  for (const [rel, text] of Object.entries({
    'capture/index/desktop.json': '{"view":"desktop"}',
    'capture/index/motion.json': '{"reveal":{"elements":[{"path":"body>main:1"}]}}',
    'capture/index/mobile-motion.json': '{"view":"mobile"}',
    'capture/index/desktop-full.webp': 'picture',
    'capture/about/desktop.json': '{"view":"desktop"}',
    'capture/manifest.json': '{"pages":[]}',
    'capture/.network/index.json': '{}',
  })) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text, 'utf8');
  }
}

test('which pages have their recordings: the desktop snapshot and the desktop animation recording', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-recordings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await captured(root);
  assert.deepEqual(await recordingsOf(root, PAGES), { pages: 2, recorded: 1, missing: ['about/index.html'] });
  assert.deepEqual(await recordingsOf(path.join(root, 'none'), PAGES), { pages: 2, recorded: 0, missing: ['index.html', 'about/index.html'] });
});

test('a repack of a repack still has the recordings after the first job is removed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-recordings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const third = path.join(root, 'third');
  await captured(first);

  const a = await carryRecordings(first, second, PAGES);
  assert.equal(a.files, 7, 'every file of the capture, the network record included');
  assert.equal(a.recorded, 1);
  assert.equal(a.from, 'first');
  // Hard links: the same file on disk, no extra space.
  assert.equal((await stat(path.join(second, 'capture', 'index', 'motion.json'))).ino, (await stat(path.join(first, 'capture', 'index', 'motion.json'))).ino);

  await rm(first, { recursive: true, force: true }); // retention removes the job the copy was captured in
  const b = await carryRecordings(second, third, PAGES);
  assert.equal(b.recorded, 1);
  assert.match(await readFile(path.join(third, 'capture', 'index', 'motion.json'), 'utf8'), /body>main:1/);
  assert.equal(await readFile(path.join(third, 'capture', 'index', 'desktop-full.webp'), 'utf8'), 'picture', 'the pictures travel too');
});

test('an earlier job without a capture (an older repack) carries nothing and says so', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-recordings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'old', 'as-is'), { recursive: true });
  const r = await carryRecordings(path.join(root, 'old'), path.join(root, 'new'), PAGES);
  assert.deepEqual(r, { from: 'old', files: 0, pages: 2, recorded: 0, missing: ['index.html', 'about/index.html'] });
});
