// An as-is copy's stack server (vite preview, next start, the MERN server; behavior/preserve/serveStack.js startStack) runs on
// a port picked free for that run, not a fixed one per stack (4501-4503 before), so two jobs side by side (SAS_MAX_JOBS above 1)
// never meet on one, and an answer from a port held by someone else is never taken for the copy. The MERN stack runs the
// project's server/src/index.js with PORT, so a stand-in project is enough: no build, no browser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freePort, startStack } from '../src/recreate/behavior/preserve/serveStack.js';
import { toolchainStatus } from '../src/toolchains/index.js';

const dirs = [];
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}); });

/** A MERN project whose server answers with its own name on PORT (and dies on a taken port, as the real one does). */
async function project(name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `sas-stack-ports-${name}-`));
  dirs.push(dir);
  await mkdir(path.join(dir, 'server', 'src'), { recursive: true });
  await writeFile(path.join(dir, 'server', 'src', 'index.js'), `require('node:http').createServer((req, res) => res.end(${JSON.stringify(name)}))
  .listen(Number(process.env.PORT), '127.0.0.1');\n`);
  return dir;
}

test('two copies started side by side each get a port of their own and answer with their own content', { timeout: 120000 }, async () => {
  assert.ok((await toolchainStatus('mern')).installed, 'the mern toolchain is installed (npm run setup:toolchains -w server -- mern)');
  const [a, b] = await Promise.all([project('copy-a'), project('copy-b')]);
  const [sa, sb] = await Promise.all([startStack('mern', a), startStack('mern', b)]);
  try {
    assert.notEqual(sa.port, sb.port);
    for (const p of [4501, 4502, 4503]) assert.ok(![sa.port, sb.port].includes(p), 'not the old fixed ports');
    assert.equal(await (await fetch(`${sa.url}/`)).text(), 'copy-a');
    assert.equal(await (await fetch(`${sb.url}/`)).text(), 'copy-b');
  } finally {
    await sa.stop();
    await sb.stop();
  }
});

test('a port someone else holds is never taken for the copy: our server could not bind it, so the start fails instead', { timeout: 120000 }, async () => {
  const port = await freePort();
  const other = createServer((req, res) => res.end('another job\'s copy'));
  await new Promise((r) => other.listen(port, '127.0.0.1', r));
  try {
    const dir = await project('ours');
    let started = null;
    try {
      started = await startStack('mern', dir, { port });
    } catch (err) {
      assert.match(err.message, /already in use/);
      assert.equal(err.portLost, true, 'recognised as a lost port (a free port would be tried next)');
    }
    if (started) await started.stop();
    assert.equal(started, null, `another server's answer was taken for the copy: ${started?.url}`);
  } finally {
    await new Promise((r) => other.close(r));
  }
});
