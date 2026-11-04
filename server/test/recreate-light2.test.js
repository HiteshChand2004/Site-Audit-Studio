// Light 2 (stop holding what is not used): the emitted files read back from disk give the same text, a reference shot kept as
// its small picture compares exactly as the full PNG did, and the as-is server keeps text (compressed once) but not pictures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { filesOnDisk, writeProject } from '../src/recreate/emit/write.js';
import { thumb, visualSimilarity } from '../src/recreate/verify/layout.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

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

test('the as-is server keeps text it compressed, and reads pictures from disk each time', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-light2-serve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'img'));
  await writeFile(path.join(root, 'index.html'), '<p>one</p>');
  await writeFile(path.join(root, 'img', 'a.png'), Buffer.from('first'));
  const server = await serveCopy(root);
  t.after(() => server.close());
  const get = async (p) => Buffer.from(await (await fetch(`${server.url.replace(/\/$/, '')}${p}`, { headers: { 'accept-encoding': 'identity' } })).arrayBuffer()).toString();
  assert.equal(await get('/img/a.png'), 'first');
  assert.equal(await get('/'), '<p>one</p>');
  await writeFile(path.join(root, 'img', 'a.png'), Buffer.from('second'));
  await writeFile(path.join(root, 'index.html'), '<p>two</p>');
  assert.equal(await get('/img/a.png'), 'second', 'a picture is not held in memory');
  assert.equal(await get('/'), '<p>one</p>', 'text is compressed once and kept, as before');
});
