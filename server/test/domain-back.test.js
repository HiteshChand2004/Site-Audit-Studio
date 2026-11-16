// Go live → "Remove domain" back to the old server (deploy/domainBack.js): where the domain pointed before Remastly is noted
// when it is put on the site; the old server is checked as visitors reach it (HTTPS for the domain, a valid padlock); the
// domain is pointed back only then, and Remastly keeps answering it while the change spreads (hosting/store.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttps } from 'node:https';
import { createServer, request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorityConfig, checkOldServer, minutesToKeep, oldServerConfig, parseOldIp, pointsTo, rememberBefore, rememberedIp } from '../src/deploy/domainBack.js';
import { dnsConfig, parseDomain } from '../src/deploy/domain.js';
import { hostingPaths, hostsOf, publishRelease, readHosts, setHosts } from '../src/hosting/store.js';
import { sitesHandler } from '../src/hosting/server.js';

let dir;
let old;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-back-'));
  // The old server, with a certificate for its domain from a certificate authority of the test's own.
  const ssl = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Test CA']);
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'site.key', '-out', 'site.csr', '-subj', '/CN=shop.acme.test']);
  await import('node:fs/promises').then((f) => f.writeFile(path.join(dir, 'ext.cnf'), 'subjectAltName=DNS:shop.acme.test\n'));
  ssl(['x509', '-req', '-in', 'site.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'site.pem', '-days', '2', '-extfile', 'ext.cnf']);
  old = createHttps({ key: await readFile(path.join(dir, 'site.key')), cert: await readFile(path.join(dir, 'site.pem')) }, (req, res) => {
    res.writeHead(req.headers.host === 'shop.acme.test' ? 200 : 421).end('the old site');
  });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  Object.assign(oldServerConfig, { port: old.address().port, ca: await readFile(path.join(dir, 'ca.pem'), 'utf8') });
});
after(async () => {
  old?.close();
  Object.assign(oldServerConfig, { port: 443, ca: undefined });
  await rm(dir, { recursive: true, force: true });
});

test('the old server: it answers the site under its domain with a valid padlock, or why not', async () => {
  assert.deepEqual(await checkOldServer('127.0.0.1', 'shop.acme.test'), { works: true, status: 200 });
  const other = await checkOldServer('127.0.0.1', 'other.acme.test');
  assert.equal(other.works, false);
  assert.match(other.reason, /padlock .* not valid for other\.acme\.test/);
  const port = oldServerConfig.port;
  oldServerConfig.port = 1;
  try {
    assert.match((await checkOldServer('127.0.0.1', 'shop.acme.test')).reason, /refused|could not be reached/);
  } finally {
    oldServerConfig.port = port;
  }
  assert.deepEqual(parseOldIp(' 13.232.143.64 ', '13.205.53.133'), { ok: true, value: '13.232.143.64' });
  assert.equal(parseOldIp('13.205.53.133', '13.205.53.133').ok, false, 'not Remastly itself');
  assert.equal(parseOldIp('10.0.0.5', null).ok, false, 'not a private address');
  assert.equal(parseOldIp('old-server', null).ok, false);
});

test('what the domain pointed to is noted when it is put on the site, and kept once it points here', async () => {
  const P = '88888888-8888-4888-8888-888888888888';
  const saved = dnsConfig.resolver;
  const d = /** @type {any} */ (parseDomain('shop.acmeshop.com'));
  try {
    dnsConfig.resolver = { resolve4: async (h) => (h === 'shop.acmeshop.com' ? ['198.51.100.7'] : []), resolveCname: async () => [] };
    await rememberBefore(P, d, '13.205.53.133');
    assert.equal(await rememberedIp(P, 'shop.acmeshop.com'), '198.51.100.7');
    // Later it points here: what it was before stays noted.
    dnsConfig.resolver = { resolve4: async () => ['13.205.53.133'], resolveCname: async () => [] };
    await rememberBefore(P, d, '13.205.53.133');
    assert.equal(await rememberedIp(P, 'shop.acmeshop.com'), '198.51.100.7');
    assert.equal(await rememberedIp(P, 'another.acmeshop.com'), null);
  } finally {
    dnsConfig.resolver = saved;
  }
});

test('a domain taken off while DNS moves it back is still answered for a while, and is no longer the website\'s', async () => {
  const savedRoot = hostingPaths.root;
  hostingPaths.root = path.join(dir, 'hosting');
  const sites = createServer(sitesHandler());
  await new Promise((r) => sites.listen(0, '127.0.0.1', r));
  const get = (host) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: sites.address().port, path: '/', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const A = '11111111-aaaa-4aaa-8aaa-111111111111';
    const B = '22222222-bbbb-4bbb-8bbb-222222222222';
    await setHosts(A, 'shop.acme.test', ['www.shop.acme.test']);
    await publishRelease(A, 'r1', [{ name: 'index.html', content: Buffer.from('<h1>copy</h1>') }]);
    await setHosts(A, null, [], { keepMinutes: 60 });
    assert.equal((await get('shop.acme.test')).body, '<h1>copy</h1>', 'still answered meanwhile');
    assert.deepEqual(await hostsOf(A), { primary: null, aliases: [] }, 'no longer its domain');
    // Another website may take it now.
    await setHosts(B, 'shop.acme.test');
    assert.equal((await readHosts())['shop.acme.test'].projectId, B);
    // Once its time has passed it is not answered, and the next change forgets it.
    const hosts = await readHosts();
    hosts['www.shop.acme.test'].until = new Date(Date.now() - 1000).toISOString();
    await import('node:fs/promises').then((f) => f.writeFile(path.join(hostingPaths.root, 'hosts.json'), JSON.stringify(hosts)));
    assert.equal((await get('www.shop.acme.test')).status, 404);
    await setHosts(B, 'shop.acme.test');
    assert.equal((await readHosts())['www.shop.acme.test'], undefined);
  } finally {
    sites.close();
    hostingPaths.root = savedRoot;
  }
});

test('how long the domain is still answered: its records\' own lifetime, at least 10 minutes; let go by hand only once moved', async () => {
  const saved = authorityConfig.ask;
  const zone = { 'shop.acmeshop.com': [{ address: '13.205.53.133', ttl: 600 }], 'www.shop.acmeshop.com': [{ address: '13.205.53.133', ttl: 300 }] };
  authorityConfig.ask = async (host) => zone[host] ?? null;
  try {
    const hosts = ['shop.acmeshop.com', 'www.shop.acmeshop.com'];
    assert.equal(await minutesToKeep(hosts, 'acmeshop.com'), 10, 'GoDaddy\'s 600 seconds');
    zone['www.shop.acmeshop.com'] = [{ address: '13.205.53.133', ttl: 3600 }];
    assert.equal(await minutesToKeep(hosts, 'acmeshop.com'), 60, 'the longest of the names');
    zone['shop.acmeshop.com'] = [{ address: '13.205.53.133', ttl: 60 }];
    zone['www.shop.acmeshop.com'] = [{ address: '13.205.53.133', ttl: 120 }];
    assert.equal(await minutesToKeep(hosts, 'acmeshop.com'), 10, 'never less than 10 minutes');
    assert.equal(await minutesToKeep(['unknown.acmeshop.com'], 'acmeshop.com'), 60, 'unreadable: GoDaddy\'s default hour');

    assert.equal(await pointsTo(hosts, 'acmeshop.com', '198.51.100.7'), false, 'not changed yet');
    zone['shop.acmeshop.com'] = [{ address: '198.51.100.7', ttl: 600 }];
    assert.equal(await pointsTo(hosts, 'acmeshop.com', '198.51.100.7'), false, 'one name still points here');
    zone['www.shop.acmeshop.com'] = [{ address: '198.51.100.7', ttl: 600 }];
    assert.equal(await pointsTo(hosts, 'acmeshop.com', '198.51.100.7'), true);
  } finally {
    authorityConfig.ask = saved;
  }
});
