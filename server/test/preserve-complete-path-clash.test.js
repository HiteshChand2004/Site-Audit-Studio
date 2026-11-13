// A copy page asked the original for /blog and then for /blog/post.json. The completion had written /blog's bare file at
// copy/blog, so making the folder copy/blog/ for the second answer failed (EEXIST). The error was thrown inside a Playwright
// route handler, which nothing catches: it ended the API process, and the copy resumed after the restart ended it again on
// the same page (live, 2026-11-13: three restarts in ten minutes, every job on the server interrupted each time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { completeCopy } from '../src/recreate/behavior/preserve/complete.js';

const SITE = 'site.test';

async function copyWith(t, script) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-complete-clash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'copy');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head>'
    + `<body><h1>Copy</h1><script>${script}</script></body></html>`, 'utf8');
  return outDir;
}

/** The original: each address answers JSON naming itself; `throwFor` makes the download itself fail (not a refusal). */
function original({ throwFor = null } = {}) {
  return async (url, { dir }) => {
    const u = new URL(url);
    if (u.hostname !== SITE) return { ok: false, reason: 'HTTP 404' };
    if (throwFor && u.pathname === throwFor) throw new Error('the download broke');
    if (!['/blog', '/blog/post.json', '/ok.json'].includes(u.pathname)) return { ok: false, reason: 'HTTP 404' };
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${u.pathname.replace(/\W+/g, '-')}.json`);
    await writeFile(tmp, JSON.stringify({ path: u.pathname }), 'utf8');
    return { ok: true, tmp, mime: 'application/json', sha256: u.pathname, bytes: 1, head: Buffer.alloc(0), finalUrl: url, redirects: [] };
  };
}

test('a path asked as a file and then as a folder (/blog, /blog/post.json): both answered, the bare file gives way, nothing ends the process', { timeout: 5 * 60000 }, async (t) => {
  const outDir = await copyWith(t, "fetch('/blog').then((r) => r.text()).then(() => fetch('/blog/post.json')).then((r) => r.text()).then((x) => { window.__post = x; });");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const result = await completeCopy({ browser, outDir, pageUrl: `https://${SITE}/`, hosts: [SITE], fetchImpl: original(), passes: 1, files: [], entries: ['index.html'] });
  assert.deepEqual(result.answerErrors, [], 'no answer failed');
  const mapped = Object.fromEntries(result.sameOrigin.mapped.map((m) => [m.path, m.file]));
  assert.ok(mapped['/blog'], '/blog is answered from the original');
  assert.ok(mapped['/blog/post.json'], '/blog/post.json is answered too');
  assert.equal(JSON.parse(await readFile(path.join(outDir, mapped['/blog/post.json']), 'utf8')).path, '/blog/post.json');
  assert.equal(JSON.parse(await readFile(path.join(outDir, mapped['/blog']), 'utf8')).path, '/blog', '/blog keeps its own named file');
  assert.ok((await stat(path.join(outDir, 'blog'))).isDirectory(), 'copy/blog is the folder now');
  assert.ok(result.sameOrigin.ambiguous.some((a) => a.path === '/blog'), 'the path without a bare file is listed');
});

test('an answer that fails gets an error status and is listed; the completion goes on and answers the rest', { timeout: 5 * 60000 }, async (t) => {
  const outDir = await copyWith(t, "fetch('/blog').catch(() => {}).finally(() => fetch('/ok.json').then((r) => r.text()).then((x) => { window.__ok = x; }));");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const result = await completeCopy({ browser, outDir, pageUrl: `https://${SITE}/`, hosts: [SITE], fetchImpl: original({ throwFor: '/blog' }), passes: 1, files: [], entries: ['index.html'] });
  assert.ok(result.sameOrigin.mapped.some((m) => m.path === '/ok.json'), 'the next address is still answered');
  const failed = [...result.answerErrors.map((e) => new URL(e.url).pathname), ...result.sameOrigin.sameAsOriginal.map((s) => s.path)];
  assert.ok(failed.includes('/blog'), `the broken one is reported (answer errors or left as the original): ${JSON.stringify(failed)}`);
});

test('the referenced-files step: a leftover bare file (blog) gives way to the folder /blog/hero.png needs; a named file never does, and the copy goes on', async (t) => {
  const { fetchReferenced } = await import('../src/recreate/behavior/preserve/referenced.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-referenced-clash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'copy');
  await mkdir(outDir, { recursive: true });
  // What the completion left: the bare copy of /blog (no extension) and a named file with one.
  await writeFile(path.join(outDir, 'blog'), '{"path":"/blog"}', 'utf8');
  await writeFile(path.join(outDir, 'data.json'), '{}', 'utf8');
  await writeFile(path.join(outDir, 'index.html'), '<!doctype html><img src="/blog/hero.png"><script>const x = "/data.json/thumb.png";</script>', 'utf8');
  const fetchImpl = async (url, { dir }) => {
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `f-${Math.random().toString(36).slice(2)}.png`);
    await writeFile(tmp, 'png-bytes', 'utf8');
    return { ok: true, tmp, mime: 'image/png', sha256: url, bytes: 9, head: Buffer.alloc(0), finalUrl: url, redirects: [] };
  };
  const result = await fetchReferenced({ outDir, pageUrl: `https://${SITE}/`, originHosts: new Set([SITE]), manifest: {}, fetchImpl });
  assert.equal(await readFile(path.join(outDir, 'blog', 'hero.png'), 'utf8'), 'png-bytes', '/blog/hero.png is in the copy');
  assert.ok((await stat(path.join(outDir, 'blog'))).isDirectory(), 'the bare file gave way to the folder');
  assert.ok((await stat(path.join(outDir, 'data.json'))).isFile(), 'a named file is never removed');
  assert.ok(result.failed.some((f) => f.url.endsWith('/data.json/thumb.png')), 'the file that cannot get its folder is listed, not thrown');
});
