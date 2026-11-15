// Remastly as the host (Go live → "Remastly server"): the sites server answers each hosted domain from its live release,
// with the copy's own _headers and _redirects applied as Netlify applied them (hosting/rules.js, store.js, server.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { headersFor, matchPath, parseHeaders, parseRedirects, ruleFor } from '../src/hosting/rules.js';
import { currentRelease, hostingPaths, publishRelease, pruneReleases, setHosts, switchRelease } from '../src/hosting/store.js';
import { sitesHandler } from '../src/hosting/server.js';

let root;
let sites;
let old;
const seenByOld = [];
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-hosting-'));
  hostingPaths.root = root;
  sites = createServer(sitesHandler());
  await new Promise((r) => sites.listen(0, '127.0.0.1', r));
  // The old app, still answering its own paths (Logins and data).
  old = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seenByOld.push({ method: req.method, url: req.url, host: req.headers.host, forwardedHost: req.headers['x-forwarded-host'], cookie: req.headers.cookie, body });
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['sid=1; Path=/; HttpOnly'] });
      res.end('{"user":"asha"}');
    });
  });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
});
after(async () => {
  sites.close();
  old.close();
  await rm(root, { recursive: true, force: true });
});

/** A request to the sites server for `host`, as nginx sends it (fetch would drop the Host header, so plain http). */
function get(host, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: sites.address().port, path: p, method, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: { get: (k) => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } }, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the rule files are read as Netlify reads them; lines it would not apply are skipped', () => {
  assert.deepEqual(matchPath('/api/*', '/api/v1/x'), { splat: 'v1/x' });
  assert.deepEqual(matchPath('/api/*', '/api'), { splat: '' });
  assert.equal(matchPath('/api/*', '/apis'), null);
  assert.deepEqual(matchPath('/*', '/a/b'), { splat: 'a/b' });
  const rules = parseRedirects('# comment\n/old  /new  301\n/api/*  https://app.x.com/api/:splat  200!\n/q  /r  200  id=:id\n/x  /y  418\nbad line\n');
  assert.deepEqual(rules, [{ from: '/old', to: '/new', status: 301, force: false }, { from: '/api/*', to: 'https://app.x.com/api/:splat', status: 200, force: true }]);
  assert.deepEqual(ruleFor(rules, '/api/me', true).to, 'https://app.x.com/api/me');
  assert.equal(ruleFor(rules, '/old', true), null, 'not forced: only after the files');
  const blocks = parseHeaders('/*\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n/assets/*\n  Cache-Control: public, max-age=31536000\n');
  assert.deepEqual(headersFor(blocks, '/assets/a.css'), { 'x-frame-options': 'DENY', 'cache-control': 'public, max-age=31536000' });
  assert.deepEqual(headersFor(blocks, '/'), { 'x-frame-options': 'DENY', 'cache-control': 'no-cache' });
});

test('a domain belongs to one website; another cannot take it', async () => {
  await setHosts('p1', 'www.acme.com', ['acme.com']);
  await assert.rejects(setHosts('p2', 'acme.com'), /already a domain of another website/);
  await assert.rejects(setHosts('p2', '../etc'), /Not a host name/);
});

const SITE = (oldPort, marker) => [
  { name: 'index.html', content: Buffer.from(`<!doctype html><title>Home</title><h1>${marker}</h1>${'x'.repeat(2000)}`) },
  { name: 'about/index.html', content: Buffer.from('<h1>About</h1>') },
  { name: 'pricing.html', content: Buffer.from('<h1>Pricing</h1>') },
  { name: '404.html', content: Buffer.from('<h1>Lost?</h1>') },
  { name: 'css/site.css', content: Buffer.from('h1{color:red}') },
  { name: '_remastly/snapshot/1.json', content: Buffer.from('[{"title":"First post"}]') },
  { name: '_headers', content: Buffer.from('/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src \'self\'\n') },
  { name: '_redirects', content: Buffer.from(`/api/blogs  /_remastly/snapshot/1.json  200!\n/api/*  http://127.0.0.1:${oldPort}/api/:splat  200!\n/old-page  /pricing  301\n`) },
];

test('a hosted site is answered by its domain: pages, clean addresses, its headers, compression, its rules, its 404', async () => {
  await setHosts('p1', 'www.acme.com', ['acme.com']);
  await publishRelease('www.acme.com', 'r1', SITE(old.address().port, 'Version one'));
  assert.equal(await currentRelease('www.acme.com'), 'r1');

  let r = await get('www.acme.com', '/', { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('content-encoding'), 'br');
  assert.match(brotliDecompressSync(r.buf).toString(), /Version one/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY', 'the copy\'s _headers');
  assert.equal(r.headers.get('content-security-policy'), "default-src 'self'");
  const etag = r.headers.get('etag');
  assert.equal((await get('www.acme.com', '/', { headers: { 'if-none-match': etag } })).status, 304, 'revalidated, not sent again');

  assert.deepEqual([(r = await get('www.acme.com', '/about')).status, r.headers.get('location')], [301, '/about/']);
  assert.equal((await get('www.acme.com', '/about/')).buf.toString(), '<h1>About</h1>');
  assert.equal((await get('www.acme.com', '/pricing')).buf.toString(), '<h1>Pricing</h1>', 'clean address → .html');
  assert.deepEqual([(r = await get('www.acme.com', '/old-page?x=1')).status, r.headers.get('location')], [301, '/pricing?x=1']);
  assert.equal((await get('www.acme.com', '/_redirects')).status, 404, 'the rule files are not pages');
  assert.equal((await get('www.acme.com', '/../hosts.json')).status, 404);
  r = await get('www.acme.com', '/nothing-here');
  assert.deepEqual([r.status, r.buf.toString()], [404, '<h1>Lost?</h1>']);

  // The content snapshot answers its address; the rest of /api goes to the old app.
  r = await get('www.acme.com', '/api/blogs');
  assert.deepEqual([r.status, r.headers.get('content-type'), r.buf.toString()], [200, 'application/json; charset=utf-8', '[{"title":"First post"}]']);
  r = await get('www.acme.com', '/api/login?next=/', { method: 'POST', headers: { cookie: 'a=b', 'content-type': 'application/json' }, body: '{"email":"a@x.io"}' });
  assert.equal(r.status, 200);
  assert.equal(r.buf.toString(), '{"user":"asha"}');
  assert.match(r.headers.get('set-cookie'), /sid=1/, 'the old app\'s cookie reaches the visitor');
  const seen = seenByOld.at(-1);
  assert.deepEqual([seen.method, seen.url, seen.forwardedHost, seen.cookie, seen.body], ['POST', '/api/login?next=/', 'www.acme.com', 'a=b', '{"email":"a@x.io"}']);
  assert.equal(seen.host, `127.0.0.1:${old.address().port}`, 'asked by the old app\'s own name');
});

test('the other form of the name leads to the site; an unknown domain is not answered; HTTPS checks are', async () => {
  let r = await get('acme.com', '/pricing?x=1', { headers: { 'x-forwarded-proto': 'https' } });
  assert.deepEqual([r.status, r.headers.get('location')], [301, 'https://www.acme.com/pricing?x=1']);
  assert.equal((await get('elsewhere.com', '/')).status, 404);
  await mkdir(path.join(root, 'acme'), { recursive: true });
  await writeFile(path.join(root, 'acme', 'tok_123-abc'), 'tok_123-abc.thumbprint');
  r = await get('anything.com', '/.well-known/acme-challenge/tok_123-abc');
  assert.deepEqual([r.status, r.buf.toString()], [200, 'tok_123-abc.thumbprint']);
  assert.equal((await get('anything.com', '/.well-known/acme-challenge/..%2Fhosts.json')).status, 404);
});

test('a new release goes live in one step, an earlier one comes back the same way, old ones are pruned', async () => {
  await publishRelease('www.acme.com', 'r2', SITE(old.address().port, 'Version two'));
  assert.match((await get('www.acme.com', '/')).buf.toString(), /Version two/);
  await switchRelease('www.acme.com', 'r1');
  assert.match((await get('www.acme.com', '/')).buf.toString(), /Version one/, 'Go back');
  await publishRelease('www.acme.com', 'r3', SITE(old.address().port, 'Version three'));
  await pruneReleases('www.acme.com', ['r3', 'r2', 'r1'], 2);
  assert.deepEqual((await readdir(path.join(root, 'sites', 'www.acme.com', 'releases'))).sort(), ['r2', 'r3']);
});

test('a site with no live release yet says so', async () => {
  await setHosts('p3', 'new.example.org');
  assert.equal((await get('new.example.org', '/')).status, 503);
});
