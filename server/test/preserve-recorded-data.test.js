// The data the original answered while it was captured, kept in the copy (preserve/asis.js liftSite → complete.js completeCopy
// `recorded`). botza's FAQ pages read their question from an API that answers nothing without the page's token: asked again
// while the copy was made it refused, so the copy drew no heading (25 pages "no <h1>"). The record holds the answers; the copy
// keeps them at their addresses: a file at the bare path for a first visit, the worker's map for every address. No browser:
// the completion runs no pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { completeCopy } from '../src/recreate/behavior/preserve/complete.js';

const SITE = 'https://site.test/';
const HOSTS = ['site.test', 'api.site.test'];
const noFetch = async () => ({ ok: false, reason: 'offline' });
const exists = (f) => stat(f).then(() => true, () => false);

async function withCopy(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-recorded-'));
  const outDir = path.join(root, 'copy');
  const rec = path.join(root, 'record');
  try {
    await mkdir(outDir, { recursive: true });
    await mkdir(rec, { recursive: true });
    await writeFile(path.join(outDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
    const body = async (name, json) => {
      const f = path.join(rec, name);
      await writeFile(f, JSON.stringify(json));
      return f;
    };
    return await fn({ outDir, body });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const run = (outDir, recorded) => completeCopy({ browser: null, outDir, pageUrl: SITE, hosts: HOSTS, passes: 0, fetchImpl: noFetch, recorded });
const swSame = async (outDir) => JSON.parse((await readFile(path.join(outDir, 'sw.js'), 'utf8')).match(/const SAME = (.*);/)[1]);

test('a recorded answer of the API is a file at its bare path (a first visit) and in the worker\'s map', () => withCopy(async ({ outDir, body }) => {
  const one = await body('one', { id: 'abc', question: 'How do I reset?' });
  const done = await run(outDir, [{ url: 'https://api.site.test/api/v1/public/faqs/abc', body: one, type: 'application/json' }]);
  const bare = path.join(outDir, 'api', 'v1', 'public', 'faqs', 'abc');
  assert.deepEqual(JSON.parse(await readFile(bare, 'utf8')), { id: 'abc', question: 'How do I reset?' });
  const same = await swSame(outDir);
  assert.ok(same['/api/v1/public/faqs/abc'], JSON.stringify(same));
  assert.ok(await exists(path.join(outDir, same['/api/v1/public/faqs/abc'])));
  assert.deepEqual(done.sameOrigin.mapped.map((m) => [m.path, m.from, m.host]), [['/api/v1/public/faqs/abc', 'record', 'api.site.test']]);
}));

test('a list with a query and an item under the same path: the folder stands, both addresses answer through the worker', () => withCopy(async ({ outDir, body }) => {
  const list = await body('list', { items: [{ id: 'abc' }] });
  const item = await body('item', { id: 'abc' });
  const done = await run(outDir, [
    { url: 'https://api.site.test/api/faqs?page=1', body: list, type: 'application/json' },
    { url: 'https://api.site.test/api/faqs/abc', body: item, type: 'application/json' },
  ]);
  assert.ok((await stat(path.join(outDir, 'api', 'faqs'))).isDirectory());
  assert.deepEqual(JSON.parse(await readFile(path.join(outDir, 'api', 'faqs', 'abc'), 'utf8')), { id: 'abc' });
  const same = await swSame(outDir);
  assert.deepEqual(JSON.parse(await readFile(path.join(outDir, same['/api/faqs?page=1']), 'utf8')), { items: [{ id: 'abc' }] });
  assert.deepEqual(JSON.parse(await readFile(path.join(outDir, same['/api/faqs/abc']), 'utf8')), { id: 'abc' });
  assert.ok(done.sameOrigin.ambiguous.some((a) => a.path === '/api/faqs'), JSON.stringify(done.sameOrigin.ambiguous));
}));

test('an answer of a host the copy does not ask is not kept; of two answers for one address the first stays', () => withCopy(async ({ outDir, body }) => {
  const first = await body('first', { v: 1 });
  const second = await body('second', { v: 2 });
  const other = await body('other', { ip: '1.2.3.4' });
  const done = await run(outDir, [
    { url: 'https://site.test/data/config', body: first, type: 'application/json' },
    { url: 'https://api.site.test/data/config', body: second, type: 'application/json' },
    { url: 'https://tracker.example/json/', body: other, type: 'application/json' },
  ]);
  assert.deepEqual(JSON.parse(await readFile(path.join(outDir, 'data', 'config'), 'utf8')), { v: 1 });
  assert.equal(await exists(path.join(outDir, 'json')), false);
  assert.deepEqual(done.sameOrigin.mapped.map((m) => m.path), ['/data/config']);
}));
