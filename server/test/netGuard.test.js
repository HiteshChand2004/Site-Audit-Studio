// SSRF guard: address classes, URL prechecks, redirect hops and the Chromium egress proxy.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { classifyAddress, createNetPolicy, precheckUrl, resolveChecked, userPolicy, withNetPolicy } from '../src/security/netGuard.js';
import { startEgressProxy } from '../src/security/egressProxy.js';
import { fetchPage } from '../src/audit/http.js';
import { classifyLink } from '../src/audit/linkChecker.js';

// Two local servers: "internal" (allowed by the platform policy) redirects to "secret" (not allowed).
let secret;
let internal;
const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
const portOf = (s) => s.address().port;

before(async () => {
  secret = await listen((_req, res) => res.end('secret'));
  internal = await listen((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `http://127.0.0.1:${portOf(secret)}/` });
      return res.end();
    }
    if (req.url === '/redirect-name') {
      res.writeHead(302, { Location: `http://localtest-${portOf(secret)}.localhost:${portOf(secret)}/` });
      return res.end();
    }
    res.end('ok');
  });
});
after(() => {
  secret.close();
  internal.close();
});

test('address classes', () => {
  const cases = {
    '8.8.8.8': 'public',
    '2606:4700::1111': 'public',
    '127.0.0.1': 'loopback',
    '127.8.9.10': 'loopback',
    '::1': 'loopback',
    '[::1]': 'loopback',
    '10.1.2.3': 'private',
    '172.16.0.1': 'private',
    '172.31.255.255': 'private',
    '172.32.0.1': 'public',
    '192.168.1.1': 'private',
    '100.64.0.1': 'private',
    'fd00::1': 'private',
    '169.254.169.254': 'link-local',
    'fe80::1': 'link-local',
    '0.0.0.0': 'reserved',
    '::': 'reserved',
    '224.0.0.1': 'reserved',
    '::ffff:127.0.0.1': 'loopback',
    '::ffff:7f00:1': 'loopback',
    '::ffff:a9fe:a9fe': 'link-local',
    '64:ff9b::a00:1': 'private',
    '2002:c0a8:0101::1': 'private',
    'not-an-ip': 'invalid',
  };
  for (const [ip, kind] of Object.entries(cases)) assert.equal(classifyAddress(ip), kind, ip);
});

test('user policy blocks private and loopback; the dev flag allows loopback only', () => {
  const saved = process.env.SAS_ALLOW_LOCALHOST;
  try {
    delete process.env.SAS_ALLOW_LOCALHOST;
    assert.match(precheckUrl('http://localhost:4100/'), /loopback/);
    assert.match(precheckUrl('http://169.254.169.254/latest/meta-data/'), /link-local/);
    assert.match(precheckUrl('http://[::ffff:10.0.0.1]/'), /private/);
    assert.match(precheckUrl('file:///etc/passwd'), /http/);
    assert.match(precheckUrl('http://user:pw@example.com/'), /credentials/);
    assert.equal(precheckUrl('https://example.com/'), null);

    process.env.SAS_ALLOW_LOCALHOST = '1';
    assert.equal(precheckUrl('http://localhost:4100/'), null);
    assert.match(precheckUrl('http://localhost:4000/'), /loopback/, 'the API port stays blocked');
    assert.match(precheckUrl('http://10.0.0.5/'), /private/);
    assert.match(precheckUrl('http://169.254.169.254/'), /link-local/);
  } finally {
    if (saved === undefined) delete process.env.SAS_ALLOW_LOCALHOST;
    else process.env.SAS_ALLOW_LOCALHOST = saved;
  }
});

test('the internal allowlist is per policy and never part of the user policy', () => {
  const platform = createNetPolicy({ internalPorts: [5100] });
  assert.equal(platform.check('127.0.0.1', 5100), null);
  assert.equal(platform.check('127.0.0.1', 5101), 'loopback');
  assert.equal(platform.check('10.0.0.1', 5100), 'private', 'internal ports are loopback only');
  assert.equal(userPolicy().internalPorts.size, 0);
});

test('names are checked after DNS resolution', async () => {
  const policy = createNetPolicy();
  // *.localhost resolves to loopback without any network.
  await assert.rejects(resolveChecked('anything.localhost', 80, policy), { code: 'ESSRFBLOCKED' });
  await assert.rejects(resolveChecked('localhost', 80, policy), { code: 'ESSRFBLOCKED' });
});

test('fetchPage re-checks every redirect hop', async () => {
  const policy = createNetPolicy({ internalPorts: [portOf(internal)] });
  await withNetPolicy(policy, async () => {
    const ok = await fetchPage(`http://127.0.0.1:${portOf(internal)}/`);
    assert.equal(ok.status, 200);

    const hop = await fetchPage(`http://127.0.0.1:${portOf(internal)}/redirect`);
    assert.equal(hop.error, 'blocked');
    assert.equal(hop.redirects.length, 1);

    // A redirect to a *.localhost name (loopback) on the blocked port.
    const named = await fetchPage(`http://127.0.0.1:${portOf(internal)}/redirect-name`);
    assert.equal(named.error, 'blocked');
  });
  assert.equal(classifyLink(0, 'blocked'), 'unverified');
});

test('egress proxy refuses blocked targets and tunnels allowed ones', async () => {
  const proxy = await startEgressProxy(createNetPolicy({ internalPorts: [portOf(internal)] }));
  const [host, port] = proxy.url.replace('http://', '').split(':');
  const viaProxy = (target) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host, port, method: 'GET', path: target, headers: { Host: new URL(target).host } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  const tunnel = (authority) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host, port, method: 'CONNECT', path: authority });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
  try {
    assert.deepEqual(await viaProxy(`http://127.0.0.1:${portOf(internal)}/`), { status: 200, body: 'ok' });
    assert.equal((await viaProxy(`http://127.0.0.1:${portOf(secret)}/`)).status, 403);
    assert.equal(await tunnel(`127.0.0.1:${portOf(internal)}`), 200);
    assert.equal(await tunnel(`127.0.0.1:${portOf(secret)}`), 403);
    assert.equal(await tunnel('169.254.169.254:443'), 403);
    assert.equal(await tunnel(`blocked.localhost:${portOf(secret)}`), 403);
    assert.ok(proxy.blocked().some((h) => h.startsWith('169.254.169.254')));
  } finally {
    await proxy.close();
  }
});
