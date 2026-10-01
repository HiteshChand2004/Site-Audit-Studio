import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CSP, createApp } from '../src/app.js';
import { createLimiter } from '../src/limiter.js';
import { createMemoryStore, disabledStore } from '../src/store.js';

const forms = [{
  id: 'contact-1',
  page: '/contact/',
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'email', type: 'email', required: true },
    { name: 'message', type: 'textarea' },
  ],
}];

let siteDir;
before(async () => {
  siteDir = await mkdtemp(path.join(os.tmpdir(), 'site-'));
  await mkdir(path.join(siteDir, 'about'));
  await mkdir(path.join(siteDir, 'assets'));
  await writeFile(path.join(siteDir, 'index.html'), '<!doctype html><title>Home</title><div id="root">home</div>');
  await writeFile(path.join(siteDir, 'about', 'index.html'), '<!doctype html><title>About</title>');
  await writeFile(path.join(siteDir, 'contact.html'), '<!doctype html><title>Contact</title>');
  await writeFile(path.join(siteDir, '404.html'), '<!doctype html><title>Gone</title>');
  await writeFile(path.join(siteDir, 'assets', 'a-1.txt'), 'asset');
});
after(() => rm(siteDir, { recursive: true, force: true }));

async function serve(options = {}) {
  const store = options.store ?? createMemoryStore();
  const app = createApp({ store, forms, siteDir, logger: { error() {} }, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, base, close: () => new Promise((resolve) => server.close(resolve)) };
}
const json = (base, body, headers = {}) => fetch(`${base}/api/forms/contact-1`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('serves the site: pages, folders, extensionless pages, 404.html, headers and caching', async () => {
  const s = await serve();
  try {
    const home = await fetch(s.base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<div id="root">home<\/div>/);
    assert.equal(home.headers.get('content-security-policy'), CSP);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(home.headers.get('x-powered-by'), null);
    assert.equal(home.headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(`${s.base}/about/`)).status, 200);
    assert.equal((await fetch(`${s.base}/contact`)).status, 200);
    assert.equal((await fetch(`${s.base}/contact.html`)).status, 200);
    assert.equal((await fetch(`${s.base}/assets/a-1.txt`)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const gone = await fetch(`${s.base}/nope`);
    assert.equal(gone.status, 404);
    assert.match(await gone.text(), /Gone/);
    assert.equal((await fetch(`${s.base}/../package.json`)).status, 404);
    assert.deepEqual(await (await fetch(`${s.base}/api/health`)).json(), { ok: true, forms: true });
  } finally {
    await s.close();
  }
});

test('a valid JSON submission is stored without anything the form does not define', async () => {
  const s = await serve();
  try {
    const res = await json(s.base, { name: ' Ada ', email: 'ada@example.com', message: 'Hello', isAdmin: true }, { 'user-agent': 'tester/1' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(s.store.docs.length, 1);
    const doc = s.store.docs[0];
    assert.deepEqual([doc.formId, doc.page, doc.values, doc.userAgent], ['contact-1', '/contact/', { name: 'Ada', email: 'ada@example.com', message: 'Hello' }, 'tester/1']);
    assert.ok(doc.receivedAt instanceof Date);
  } finally {
    await s.close();
  }
});

test('a browser form post (no JavaScript) is stored and redirected to the thank-you page', async () => {
  const s = await serve();
  try {
    const res = await fetch(`${s.base}/api/forms/contact-1`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }, body: 'name=Ada&email=ada%40example.com&message=Hi',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/thanks?from=%2Fcontact%2F');
    assert.equal(s.store.docs[0].values.email, 'ada@example.com');
    const thanks = await (await fetch(`${s.base}${res.headers.get('location')}`)).text();
    assert.match(thanks, /Thank you/);
    assert.match(thanks, /<a href="\/contact\/">Back to the site<\/a>/);
    // The back link is a path on this site, never markup or another site.
    assert.doesNotMatch(await (await fetch(`${s.base}/thanks?from=//evil.test`)).text(), /evil\.test/);
    assert.doesNotMatch(await (await fetch(`${s.base}/thanks?from=${encodeURIComponent('/"><script>x</script>')}`)).text(), /<script>/);
  } finally {
    await s.close();
  }
});

test('invalid, unknown, foreign and malformed requests are refused and nothing is stored', async () => {
  const s = await serve();
  try {
    const bad = await json(s.base, { name: 'Ada', email: 'nope' });
    assert.equal(bad.status, 422);
    assert.deepEqual((await bad.json()).errors, { email: 'must be an email address' });
    assert.equal((await fetch(`${s.base}/api/forms/other`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await json(s.base, { name: 'Ada', email: 'ada@example.com' }, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await fetch(`${s.base}/api/forms/contact-1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })).status, 400);
    assert.equal((await fetch(`${s.base}/api/forms/contact-1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(200000) }) })).status, 413);
    const html = await fetch(`${s.base}/api/forms/contact-1`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }, body: 'name=Ada' });
    assert.equal(html.status, 422);
    assert.match(await html.text(), /The form could not be sent/);
    assert.equal(s.store.docs.length, 0);
    // A same-site Origin is fine.
    const ok = await json(s.base, { name: 'Ada', email: 'ada@example.com' }, { origin: s.base });
    assert.equal(ok.status, 201);
  } finally {
    await s.close();
  }
});

test('without storage the endpoint says so (503) and the site still works', async () => {
  const s = await serve({ store: disabledStore() });
  try {
    const res = await json(s.base, { name: 'Ada', email: 'ada@example.com' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not configured/);
    assert.deepEqual(await (await fetch(`${s.base}/api/health`)).json(), { ok: true, forms: false });
    assert.equal((await fetch(s.base)).status, 200);
  } finally {
    await s.close();
  }
});

test('a failing store is a 503 that does not leak the reason; the limiter answers 429 with Retry-After', async () => {
  const failing = { enabled: true, kind: 'test', insert: async () => { throw new Error('secret connection string'); } };
  const a = await serve({ store: failing });
  try {
    const res = await json(a.base, { name: 'Ada', email: 'ada@example.com' });
    assert.equal(res.status, 503);
    assert.doesNotMatch(JSON.stringify(await res.json()), /secret/);
  } finally {
    await a.close();
  }
  const b = await serve({ limiter: createLimiter({ max: 2 }) });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await json(b.base, { name: 'Ada', email: 'ada@example.com' })).status, 201);
    const limited = await json(b.base, { name: 'Ada', email: 'ada@example.com' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(b.store.docs.length, 2);
  } finally {
    await b.close();
  }
});
