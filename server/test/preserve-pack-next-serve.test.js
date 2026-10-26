// The packed Next.js project serves both kinds of /_next address: the copy's own file (moved to public/next-assets and rewritten
// by name) and Next's own build output (its chunks), and a missing page shows Next's own 404. Built and run with the pinned
// Next.js toolchain, the same way the app does it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packLifted } from '../src/recreate/behavior/preserve/pack.js';
import { buildStack, startStack } from '../src/recreate/behavior/preserve/serveStack.js';

test('the packed Next.js copy serves its own /_next file, Next\'s own chunk, and Next\'s 404 for a missing page', { timeout: 15 * 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-pack-next-serve-'));
  const copy = path.join(root, 'copy');
  await mkdir(path.join(copy, '_next', 'static'), { recursive: true });
  await writeFile(path.join(copy, '_next', 'static', 'site.js'), 'window.__siteFile = 1;', 'utf8');
  await writeFile(path.join(copy, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head>'
    + '<body><script src="/_next/static/site.js"></script><p>home</p></body></html>', 'utf8');
  const out = path.join(root, 'project');
  await packLifted({ stack: 'nextjs', copyDir: copy, outDir: out, pageUrl: 'https://site.test/' });
  await buildStack('nextjs', out, { timeoutMs: 8 * 60000 });
  const server = await startStack('nextjs', out);
  // The server stops before its folder is removed (Windows keeps a running server's files locked).
  t.after(async () => { await server.stop(); await rm(root, { recursive: true, force: true }).catch(() => {}); });

  const own = await fetch(`${server.url}/_next/static/site.js`);
  assert.equal(own.status, 200, 'the copy\'s own /_next file');
  assert.match(await own.text(), /__siteFile/);

  const chunks = await readdir(path.join(out, '.next', 'static', 'chunks')).catch(() => []);
  const chunk = chunks.find((f) => f.endsWith('.js'));
  assert.ok(chunk, 'Next built its own chunks');
  const nextOwn = await fetch(`${server.url}/_next/static/chunks/${chunk}`);
  assert.equal(nextOwn.status, 200, 'Next\'s own /_next chunk');

  const missing = await fetch(`${server.url}/no-such-page/`);
  const missingText = await missing.text();
  assert.equal(missing.status, 404, 'a missing page is a 404');
  assert.match(missingText, /could not be found/i, 'and shows Next\'s own 404 page');
});
