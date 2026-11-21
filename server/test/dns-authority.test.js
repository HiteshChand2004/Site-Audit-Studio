// A domain's records as its own DNS servers answer them now (deploy/authority.js), never from this machine's DNS cache, which
// kept old answers for minutes after a domain was pointed here: the Go live domain card (deploy/domain.js checkRecords) and the
// padlock list (hosting/certs.js) both read them. Against stand-in DNS servers over real UDP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorityConfig, lookup } from '../src/deploy/authority.js';
import { checkRecords, domainPlan, parseDomain } from '../src/deploy/domain.js';
import { refreshWantedCerts } from '../src/hosting/certs.js';
import { hostingPaths, setHosts } from '../src/hosting/store.js';

const HERE = '13.205.53.133';
const TYPES = { 1: 'A', 2: 'NS', 5: 'CNAME' };

/** A DNS name in wire format. @param {string} name */
const wireName = (name) => Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);

/** One answer for the name asked (a pointer to the question's name). @param {number} type @param {number} ttl @param {Buffer} data */
function answer(type, ttl, data) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0xc00c, 0);
  head.writeUInt16BE(type, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt32BE(ttl, 6);
  head.writeUInt16BE(data.length, 10);
  return Buffer.concat([head, data]);
}

/**
 * A stand-in DNS server answering from `zone` ({ name: { A?, CNAME?, NS?, ttl? } }; a name not in it does not exist), or never
 * when `silent`. `asked` lists every question ("A acme-shop.com").
 * @param {Record<string, { A?: string[], CNAME?: string, NS?: string[], ttl?: number }>} zone
 */
async function dnsServer(zone, { silent = false } = {}) {
  const socket = dgram.createSocket('udp4');
  /** @type {string[]} */
  const asked = [];
  socket.on('message', (msg, from) => {
    let i = 12;
    const labels = [];
    while (msg[i]) {
      labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString());
      i += msg[i] + 1;
    }
    const name = labels.join('.').toLowerCase();
    const type = msg.readUInt16BE(i + 1);
    asked.push(`${TYPES[type] ?? type} ${name}`);
    if (silent) return;
    const e = zone[name];
    const ttl = e?.ttl ?? 300;
    const answers = !e ? []
      : type === 1 ? (e.A ?? []).map((ip) => answer(1, ttl, Buffer.from(ip.split('.').map(Number))))
        : type === 5 ? (e.CNAME ? [answer(5, ttl, wireName(e.CNAME))] : [])
          : type === 2 ? (e.NS ?? []).map((n) => answer(2, ttl, wireName(n))) : [];
    const head = Buffer.alloc(12);
    head.writeUInt16BE(msg.readUInt16BE(0), 0);
    // A response, authoritative, recursion-desired as asked; "no such name" for a name not in the zone.
    head.writeUInt16BE(0x8400 | (msg.readUInt16BE(2) & 0x0100) | (e ? 0 : 3), 2);
    head.writeUInt16BE(1, 4);
    head.writeUInt16BE(answers.length, 6);
    socket.send(Buffer.concat([head, msg.subarray(12, i + 5), ...answers]), from.port, from.address);
  });
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  return { port: socket.address().port, asked, close: () => socket.close() };
}

let cache;
let own;
let quiet;
let pub;
const saved = { ...authorityConfig };
before(async () => {
  // This machine's resolver as the live server had it: it knows the name servers, and still the old (Framer) answers.
  cache = await dnsServer({
    'acme-shop.com': { NS: ['ns1.acme-dns.com', 'ns2.acme-dns.com', 'ns3.acme-dns.com'], A: ['31.43.160.6', '31.43.161.6'] },
    'www.acme-shop.com': { CNAME: 'sites.builder-host.com' },
    'host-co.com': { NS: ['ns1.host-dns.com'] },
    'ns1.acme-dns.com': { A: ['127.0.0.1'] },
    'ns2.acme-dns.com': { A: ['127.0.0.1'] },
    'ns3.acme-dns.com': { A: ['127.0.0.1'] },
    'ns1.host-dns.com': { A: ['127.0.0.1'] },
  });
  // The domains' own name servers, as they answer now.
  own = await dnsServer({
    'acme-shop.com': { A: [HERE], ttl: 600 },
    'www.acme-shop.com': { CNAME: 'acme-shop.com' },
    'shop.acme-shop.com': { CNAME: 'edge.host-co.com' },
    'edge.host-co.com': { A: ['198.51.100.20'] },
  });
  quiet = await dnsServer({}, { silent: true });
  pub = await dnsServer({ 'acme-shop.com': { A: [HERE] } });
  Object.assign(authorityConfig, { timeout: 300, port: own.port, nsServers: [`127.0.0.1:${cache.port}`], publicServers: [`127.0.0.1:${pub.port}`] });
});
after(() => {
  Object.assign(authorityConfig, saved);
  for (const s of [cache, own, quiet, pub]) s.close();
});

test('the domain\'s own name servers win over a cache that still has the old records', async () => {
  assert.deepEqual(await lookup('acme-shop.com'), { addresses: [HERE], ttl: 600, cnames: [], source: 'authoritative' });
  assert.deepEqual(await lookup('www.acme-shop.com'), { addresses: [HERE], ttl: 600, cnames: ['acme-shop.com'], source: 'authoritative' });
  assert.ok(!cache.asked.some((q) => q.startsWith('A acme-shop.com') || q.startsWith('CNAME')), 'the cache is asked for name servers only');

  // The domain card: both names point here, as the domain's own servers say.
  const checked = await checkRecords(domainPlan(/** @type {any} */ (parseDomain('acme-shop.com')), null, HERE).records);
  assert.deepEqual(checked.map((r) => [r.host, r.ok, r.source]), [['acme-shop.com', true, 'authoritative'], ['www.acme-shop.com', true, 'authoritative']]);
});

test('a CNAME into another zone is followed through that zone\'s own name servers', async () => {
  assert.deepEqual(await lookup('shop.acme-shop.com'), { addresses: ['198.51.100.20'], ttl: 300, cnames: ['edge.host-co.com'], source: 'authoritative' });
  assert.ok(cache.asked.includes('NS host-co.com'), 'the other zone\'s name servers were looked up');
});

test('when no name server answers, a public resolver is asked (never this machine\'s), and the answer says so', async () => {
  authorityConfig.port = quiet.port;
  try {
    assert.deepEqual(await lookup('acme-shop.com'), { addresses: [HERE], ttl: 300, cnames: [], source: 'public' });
    assert.equal(quiet.asked.length, 2, 'two of the three name servers tried, once each');
  } finally {
    authorityConfig.port = own.port;
  }
});

test('the padlock list names a domain as soon as its own name servers point it here', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-certs-'));
  const savedRoot = hostingPaths.root;
  hostingPaths.root = dir;
  try {
    await setHosts('33333333-cccc-4ccc-8ccc-333333333333', 'acme-shop.com', ['www.acme-shop.com', 'shop.acme-shop.com']);
    // shop.acme-shop.com still leads elsewhere: not listed (Let's Encrypt would refuse it).
    assert.deepEqual(await refreshWantedCerts(HERE), ['acme-shop.com', 'www.acme-shop.com']);
    assert.equal(await readFile(path.join(dir, 'certs-wanted.txt'), 'utf8'), 'acme-shop.com\nwww.acme-shop.com\n');
  } finally {
    hostingPaths.root = savedRoot;
    await rm(dir, { recursive: true, force: true });
  }
});
