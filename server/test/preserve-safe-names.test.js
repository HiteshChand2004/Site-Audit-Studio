// A copy stores every file under a name any file system can hold (recreate/behavior/preserve/pageLift.js fileSafePath), the
// same on every machine. Found on a live run: a page showing an image from https://commons.wikimedia.org/wiki/Special:FilePath/…
// failed the whole copy on Windows (a ":" cannot be in a file name). No network: the download is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileSafePath, localPathOf, storableAsIs } from '../src/recreate/behavior/preserve/pageLift.js';
import { fetchReferenced } from '../src/recreate/behavior/preserve/referenced.js';

test('a name no file system can hold is spelled so every one can; a plain one is left as it is', () => {
  assert.equal(localPathOf('https://commons.example.test/wiki/Special:FilePath/Logo.png'), '/wiki/Special~3aFilePath/Logo.png');
  assert.equal(localPathOf('https://cdn.example.test/a/b%3Cc%3E%7C.js'), '/a/b~3cc~3e~7c.js');
  assert.equal(localPathOf('https://cdn.example.test/x%5C..%5Cy.js'), '/x~5c..~5cy.js', 'a decoded backslash is no folder');
  assert.equal(localPathOf('https://cdn.example.test/a/%2e%2e%2Fb.js').includes('/../'), false, 'never a step out of the copy');
  assert.equal(fileSafePath('/a/../b'), '/a/~2e~2e/b');
  assert.equal(fileSafePath('/con.js'), '/con~.js');
  assert.equal(fileSafePath('/img/name. '), '/img/name~2e~20');
  assert.match(localPathOf('https://www.example.test/favicon.ico?v=2'), /^\/favicon~[0-9a-f]{8}\.ico$/, 'a query\'s name is as before');
  for (const p of ['/assets/app-1a2b.js', '/fonts/Inter Var.woff2', '/menu@0.0.29.js', '/a/b/index.html']) assert.ok(storableAsIs(p), p);
  assert.equal(storableAsIs('/wiki/Special:FilePath/x.png'), false);
});

test('a named file whose path has a ":" is fetched and held under its safe name, through the worker\'s map', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-safe-names-'));
  const SITE = 'https://www.example-original.test/';
  try {
    await writeFile(path.join(dir, 'index.html'),
      '<script>const a="/wiki/Special%3AFilePath/Logo.png";const b="https://upload.example-wiki.test/wiki/Special%3AFilePath/Map.svg"</script>');
    const fetchImpl = async (url, { dir: tmp }) => {
      const file = path.join(tmp, `f${url.length}`);
      await writeFile(file, url);
      return { ok: true, tmp: file, bytes: url.length };
    };
    const manifest = {};
    const r = await fetchReferenced({ outDir: dir, pageUrl: SITE, originHosts: new Set(['example-original.test', 'upload.example-wiki.test']), manifest, fetchImpl });
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.fetched.map((f) => f.path).sort(), ['/wiki/Special~3aFilePath/Logo.png', '/wiki/Special~3aFilePath/Map.svg']);
    assert.equal(manifest[`${SITE}wiki/Special%3AFilePath/Logo.png`], '/wiki/Special~3aFilePath/Logo.png', 'the site\'s own address is answered by the worker');
    assert.equal(await readFile(path.join(dir, 'wiki', 'Special~3aFilePath', 'Map.svg'), 'utf8'), 'https://upload.example-wiki.test/wiki/Special%3AFilePath/Map.svg');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
