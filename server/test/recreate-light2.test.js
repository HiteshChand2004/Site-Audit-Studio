// Light 2 (stop holding what is not used): the emitted files read back from disk give the same text, a reference shot kept as
// its small picture compares exactly as the full PNG did. (Step 9e: the rebuild pipeline only;
// the as-is server part of Light 2 is not re-applied, the first proof showed it gains nothing.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { filesOnDisk, writeProject } from '../src/recreate/emit/write.js';
import { thumb, visualSimilarity } from '../src/recreate/verify/layout.js';

test('emitted files once written: the same names and text, read back from disk', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-light2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([['index.html', '<!doctype html><p>Café — ü</p>'], ['css/site.css', 'p{color:red}']]);
  await writeProject(root, { files, assets: new Set() }, { assetsDir: root, known: new Set() });
  const disk = filesOnDisk(root, files);
  assert.equal(disk.size, 2);
  assert.deepEqual([...disk.keys()], [...files.keys()]);
  assert.deepEqual([...disk], [...files], 'iteration gives the same pairs');
  assert.equal(disk.get('index.html'), files.get('index.html'));
  assert.deepEqual([...disk.values()], [...files.values()]);
  assert.equal(disk.get('missing.html'), undefined);
});

test('a reference shot kept as its small picture compares exactly like the full PNG', async () => {
  const shot = (colour, h) => sharp({ create: { width: 400, height: h, channels: 3, background: colour } }).png().toBuffer();
  const a = await shot('#c2410c', 900);
  const b = await shot('#c2420d', 1000);
  const small = await thumb(a);
  assert.ok(small.data.length < (400 * 900 * 3) / 10, 'the kept picture is a small fraction of the full shot once decoded');
  assert.equal(await visualSimilarity(small, b), await visualSimilarity(a, b));
});
