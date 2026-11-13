// The lifted original served for Lighthouse (reaudit/index.js openLiftedOriginal): its own files on this computer, behind a
// measurement host per device like the copy's, and which pages it holds a document for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLiftedOriginal } from '../src/reaudit/index.js';
import { HOST_LATENCY_MS } from '../src/reaudit/measuredHost.js';

test('serves the lifted folder through a measurement host per device and tells which pages it holds', { timeout: 30000 }, async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sas-lifted-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  assert.equal(await openLiftedOriginal(folder), null, 'no lifted folder: nothing to serve');

  const dir = path.join(folder, 'as-is', 'lifted');
  await mkdir(path.join(dir, 'about'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>home</title><h1>Home</h1>');
  await writeFile(path.join(dir, 'about', 'index.html'), '<!doctype html><title>about</title>');
  await writeFile(path.join(dir, 'pricing.html'), '<!doctype html><title>pricing</title>');
  const lifted = await openLiftedOriginal(folder);
  try {
    assert.equal(await lifted.pathFor('/'), '/');
    assert.equal(await lifted.pathFor('/about/'), '/about/');
    assert.equal(await lifted.pathFor('/about'), '/about/', 'a folder page gets its slash: no redirect on the original\'s side');
    assert.equal(await lifted.pathFor('/pricing'), '/pricing', 'a clean URL answered from its .html file');
    assert.equal(await lifted.pathFor('/missing/'), null);
    assert.equal(await lifted.pathFor('/../../etc/passwd'), null, 'never outside the folder');
    const page = await fetch(`${lifted.origin}${await lifted.pathFor('/about')}`, { redirect: 'manual' });
    assert.equal(page.status, 200, 'the address given is answered without a redirect');

    const t0 = Date.now();
    const res = await fetch(`${lifted.measured.mobile.origin}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<h1>Home<\/h1>/, 'the measurement host passes the lifted page through');
    assert.ok(Date.now() - t0 >= HOST_LATENCY_MS - 5, 'with the host latency, like the copy');
    assert.notEqual(lifted.measured.mobile.origin, lifted.measured.desktop.origin, 'one host per device');
  } finally {
    await lifted.close();
  }
  await assert.rejects(fetch(`${lifted.origin}/`), 'closed with the comparison');
});
