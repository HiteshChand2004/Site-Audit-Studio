// How the as-is copy is served (recreate/behavior/preserve/serve.js) answers a page's address in every form a static host
// answers it: /about/, /about (no slash: redirected to the folder, as GitHub Pages, nginx and Netlify do) and /about for
// about.html (a "clean URL"). The preview, the checks and the re-audit all use this server, so a form it does not answer
// would read as a broken page that a real host serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

test('a page is answered with and without its trailing slash, and a clean URL finds its .html file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-serve-paths-'));
  await mkdir(path.join(dir, 'about'), { recursive: true });
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<h1>Home</h1>');
  await writeFile(path.join(dir, 'about', 'index.html'), '<h1>About</h1>');
  await writeFile(path.join(dir, 'pricing.html'), '<h1>Pricing</h1>');
  await writeFile(path.join(dir, 'assets', 'app.js'), 'x');
  const served = await serveCopy(dir);
  try {
    const get = (p) => fetch(new URL(p, served.url), { redirect: 'manual' });
    assert.equal(await (await get('/about/')).text(), '<h1>About</h1>');

    const bare = await get('/about?x=1');
    assert.equal(bare.status, 301, 'a folder without its slash is redirected to it');
    assert.equal(bare.headers.get('location'), '/about/?x=1', 'the query is kept');
    assert.equal(await (await fetch(new URL('/about', served.url))).text(), '<h1>About</h1>', 'and the redirect lands on the page');

    assert.equal(await (await get('/pricing')).text(), '<h1>Pricing</h1>', 'a clean URL is answered from its .html file');
    assert.equal((await get('/assets')).status, 404, 'a folder with no page is not one');
    assert.equal((await get('/missing')).status, 404);
    assert.equal((await get('/assets/app.js')).status, 200);
    assert.equal((await get('/%2e%2e/%2e%2e/etc/passwd')).status >= 400, true, 'nothing outside the folder');
  } finally {
    await served.close();
    await rm(dir, { recursive: true, force: true });
  }
});
