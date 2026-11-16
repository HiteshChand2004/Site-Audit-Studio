// Go live → the domain's records changed at GoDaddy by Remastly (deploy/godaddy.js), against a stand-in GoDaddy over real
// HTTP that keeps one zone and answers both of GoDaddy's APIs (v1 for a key and secret, v3 for a personal access token):
// only the names the site answers to change, email stays, and the undo puts back what was there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { applyDns, credentialOf, DnsError, forgetDnsChange, godaddyClient, godaddyConfig, planDns, readDnsChange, readServerTokens, saveDnsChange, sealedOf, undoDns } from '../src/deploy/godaddy.js';
import { domainPlan, parseDomain } from '../src/deploy/domain.js';

const KEY = 'dLP4testkey_1234';
const SECRET = 'S3cretSecret99';
const PAT = 'eyJhbGciOiJSUzI1NiJ9.eyJzY29wZSI6ImRucyJ9.c2lnbmF0dXJl';
const IP = '13.205.53.133';
let server;
let zone;
let nameServers;
let nextId = 0;
const seen = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      const send = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(value === undefined ? '' : JSON.stringify(value));
      const url = new URL(req.url, 'http://x');
      const v3 = url.pathname.startsWith('/v3/');
      // Each API takes its own credential only, as GoDaddy's does.
      if (req.headers.authorization !== (v3 ? `Bearer ${PAT}` : `sso-key ${KEY}:${SECRET}`)) return send(401, { name: 'UNAUTHORIZED', message: 'Unable to authenticate' });
      if (v3) {
        if (url.pathname === '/v3/domains/domain-names') return send(200, { items: [{ domain: 'acme.com' }], links: [] });
        const d = url.pathname.match(/^\/v3\/domains\/domain-names\/([^/]+)$/);
        if (d) return d[1] === 'acme.com' ? send(200, { domain: 'acme.com', nameServers }) : send(404, { name: 'NOT_FOUND', message: 'Domain not found' });
        const z = url.pathname.match(/^\/v3\/domains\/zones\/([^/]+)\/dns-records(?:\/([^/]+))?$/);
        if (!z || z[1] !== 'acme.com') return send(404, { name: 'NOT_FOUND', message: 'Zone not found' });
        const id = z[2];
        if (req.method === 'GET') {
          const type = url.searchParams.get('type');
          const name = url.searchParams.get('name');
          return send(200, { items: zone.filter((r) => (!type || r.type === type) && (!name || r.name === name)).map((r) => ({ recordId: r.id, ...r })) });
        }
        if (req.method === 'DELETE') {
          if (!zone.some((r) => r.id === id)) return send(404, { name: 'NOT_FOUND', message: 'no record' });
          zone = zone.filter((r) => r.id !== id);
          return send(204);
        }
        const rec = JSON.parse(body);
        const clash = zone.some((r) => r.id !== id && r.name === rec.name && (r.type === 'CNAME' || rec.type === 'CNAME'));
        if (clash) return send(409, { name: 'CONFLICT', message: 'A CNAME cannot share its name' });
        if (req.method === 'POST') {
          zone.push({ id: `rec${++nextId}`, type: rec.type, name: rec.name, data: rec.data, ttl: rec.ttl });
          return send(201, rec);
        }
        if (req.method === 'PUT') {
          const at = zone.findIndex((r) => r.id === id);
          if (at < 0) return send(404, { name: 'NOT_FOUND', message: 'no record' });
          zone[at] = { id, type: rec.type, name: rec.name, data: rec.data, ttl: rec.ttl };
          return send(200, rec);
        }
        return send(405);
      }
      if (url.pathname === '/v1/domains') return send(200, [{ domain: 'acme.com' }]);
      const m = url.pathname.match(/^\/v1\/domains\/([^/]+)(?:\/records\/([A-Z]+)\/([^/]+))?$/);
      if (!m || m[1] !== 'acme.com') return send(404, { code: 'NOT_FOUND', message: 'Domain not found' });
      if (!m[2]) return send(200, { domain: 'acme.com', nameServers });
      const [, , type, name] = m;
      const others = zone.filter((r) => !(r.type === type && r.name === name));
      if (req.method === 'GET') return send(200, zone.filter((r) => r.type === type && r.name === name));
      if (req.method === 'DELETE') {
        if (others.length === zone.length) return send(404, { code: 'NOT_FOUND', message: 'no records' });
        zone = others;
        return send(204);
      }
      if (req.method === 'PUT') {
        // GoDaddy refuses a CNAME beside anything else of the same name, and anything beside a CNAME.
        const clash = others.some((r) => r.name === name && (r.type === 'CNAME' || type === 'CNAME'));
        if (clash) return send(422, { code: 'DUPLICATE_RECORD', message: 'A CNAME cannot share its name' });
        zone = [...others, ...JSON.parse(body).map((r) => ({ id: `rec${++nextId}`, type, name, data: r.data, ttl: r.ttl }))];
        return send(200);
      }
      return send(405);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  godaddyConfig.base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const reset = () => {
  // As a domain parked at GoDaddy, or still pointing at the old host: the site, www following it, email, a verification.
  zone = [
    { type: 'A', name: '@', data: '203.0.113.9', ttl: 3600 },
    { type: 'AAAA', name: '@', data: '2001:db8::9', ttl: 3600 },
    { type: 'CNAME', name: 'www', data: '@', ttl: 3600 },
    { type: 'MX', name: '@', data: 'mx.mail.test', ttl: 3600 },
    { type: 'TXT', name: '@', data: 'google-site-verification=x', ttl: 3600 },
  ].map((r) => ({ id: `rec${++nextId}`, ...r }));
  nameServers = ['NS01.DOMAINCONTROL.COM', 'ns02.domaincontrol.com'];
};
const sorted = (z) => [...z].map(({ type, name, data }) => `${type} ${name} ${data}`).sort();
const wanted = (host) => domainPlan(/** @type {any} */ (parseDomain(host)), null, IP).records;

test('a token, or a key and secret, as pasted; a wrong one is refused in plain words', async () => {
  assert.deepEqual(credentialOf({ token: ` Bearer ${PAT} ` }), { kind: 'token', token: PAT, ending: PAT.slice(-4) });
  assert.deepEqual(credentialOf({ key: ` ${KEY} `, secret: SECRET }), { kind: 'key', key: KEY, secret: SECRET, ending: '1234' });
  assert.equal(credentialOf({ token: 'too short' }), null);
  assert.equal(credentialOf({ key: KEY, secret: 'has space in it' }), null);
  assert.equal(credentialOf({ key: KEY }), null);
  await godaddyClient(sealedOf(credentialOf({ token: PAT }))).check();
  await godaddyClient(`${KEY}:${SECRET}`).check();
  await assert.rejects(godaddyClient(`${KEY}:wrongsecret1`).check(), (e) => e instanceof DnsError && e.code === 'key' && /key and secret/.test(e.message));
  await assert.rejects(godaddyClient('bearer wrong.token.value_123456').check(), (e) => e instanceof DnsError && e.code === 'key' && /this token/.test(e.message));
  assert.ok(seen.every((x) => /^(sso-key|Bearer) /.test(x.auth ?? '')), 'the credential travels only in the header');
});

// Every case runs with both credentials: the same changes, through either API.
const KINDS = [['a personal access token (v3)', () => sealedOf({ kind: 'token', token: PAT, ending: '' })], ['a key and secret (v1)', () => `${KEY}:${SECRET}`]];

for (const [kind, sealed] of KINDS) {
test(`${kind}: pointing a domain here changes only its own names, keeps email, and the undo puts back exactly what was there`, async () => {
  reset();
  const original = sorted(zone);
  const client = godaddyClient(sealed());
  const changes = await planDns(client, 'acme.com', wanted('acme.com'));
  assert.deepEqual(changes.map((c) => [c.host, c.type, c.needed]), [['acme.com', 'A', true], ['www.acme.com', 'A', true]]);
  assert.deepEqual(changes[0].before, { A: ['203.0.113.9'], AAAA: ['2001:db8::9'], CNAME: [] });

  await applyDns(client, 'acme.com', changes);
  assert.deepEqual(sorted(zone), ['A @ 13.205.53.133', 'A www 13.205.53.133', 'MX @ mx.mail.test', 'TXT @ google-site-verification=x']);
  assert.ok(zone.filter((r) => r.type === 'A').every((r) => r.ttl === 600));

  // In place now: nothing more to do.
  assert.equal((await planDns(client, 'acme.com', wanted('acme.com'))).some((c) => c.needed), false);

  await undoDns(client, 'acme.com', changes);
  assert.deepEqual(sorted(zone), original);
});

test(`${kind}: a www domain, a domain not in the account, and one whose DNS is run elsewhere`, async () => {
  reset();
  const client = godaddyClient(sealed());
  const changes = await planDns(client, 'acme.com', wanted('www.acme.com'));
  await applyDns(client, 'acme.com', changes);
  assert.deepEqual(sorted(zone).filter((r) => r.startsWith('A ') || r.startsWith('CNAME')), ['A @ 13.205.53.133', 'A www 13.205.53.133']);

  await assert.rejects(planDns(client, 'other.com', wanted('other.com')), /not in this GoDaddy account/);
  nameServers = ['ana.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
  await assert.rejects(planDns(client, 'acme.com', wanted('acme.com')), (e) => e.code === 'elsewhere' && /cloudflare/.test(e.message));
});

test(`${kind}: a second change keeps the first "before", so the undo goes back to what was there before Remastly`, async () => {
  const P = '66666666-6666-4666-8666-666666666666';
  reset();
  const client = godaddyClient(sealed());
  const first = await planDns(client, 'acme.com', wanted('acme.com'));
  await saveDnsChange(P, 'acme.com', first);
  await applyDns(client, 'acme.com', first);
  // Someone points www elsewhere by hand; Remastly is asked again.
  zone = zone.filter((r) => r.name !== 'www').concat({ id: `rec${++nextId}`, type: 'A', name: 'www', data: '198.51.100.1', ttl: 600 });
  const second = await planDns(client, 'acme.com', wanted('acme.com'));
  await saveDnsChange(P, 'acme.com', second);
  await applyDns(client, 'acme.com', second);
  const saved = await readDnsChange(P);
  assert.deepEqual(saved.changes.map((c) => [c.host, c.needed, c.before.CNAME]), [['acme.com', true, []], ['www.acme.com', true, ['@']]]);
  await undoDns(client, 'acme.com', saved.changes);
  assert.ok(sorted(zone).includes('CNAME www @') && sorted(zone).includes('A @ 203.0.113.9'));
  await forgetDnsChange(P);
  assert.equal(await readDnsChange(P), null);
});
}

test('tokens set on the server: one per account, read once and taken out of the environment', () => {
  process.env.SAS_GODADDY_TOKENS = ` ${PAT}, ${KEY}:${SECRET}\n second.token-value_9999 `;
  assert.deepEqual(readServerTokens(), [`bearer ${PAT}`, `${KEY}:${SECRET}`, 'bearer second.token-value_9999']);
  assert.equal(process.env.SAS_GODADDY_TOKENS, undefined, 'nothing Remastly starts inherits them');
  assert.deepEqual(readServerTokens(), []);
});
