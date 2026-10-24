// The measurement host (reaudit/measuredHost.js): the copy's files pass through unchanged, each answer waits the host's latency,
// and the bytes flow at the device's throughput over one shared link. No browser: an upstream server in this process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { brotliCompressSync } from 'node:zlib';
import { openMeasuredHost, HOST_LATENCY_MS, NETWORK_PROFILES, measuredHostDescription } from '../src/reaudit/measuredHost.js';

const BIG = 200 * 1024;

async function upstream() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host });
    if (req.url === '/big') return res.writeHead(200, { 'content-type': 'application/javascript', 'x-upstream': 'yes', 'cache-control': 'public, max-age=1' }).end(req.method === 'HEAD' ? undefined : Buffer.alloc(BIG, 97));
    if (req.url === '/br') return res.writeHead(200, { 'content-type': 'text/css', 'content-encoding': 'br' }).end(brotliCompressSync(Buffer.from('body-br')));
    if (req.url === '/moved') return res.writeHead(301, { location: '/moved/' }).end();
    if (req.url === '/empty') return res.writeHead(204).end();
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const timed = async (url, init) => {
  const t0 = Date.now();
  const res = await fetch(url, init);
  const headersAt = Date.now() - t0;
  const body = Buffer.from(await res.arrayBuffer());
  return { res, body, headersAt, totalMs: Date.now() - t0 };
};

test('answers pass through unchanged, after the host latency, at the phone throughput, sharing one link', async () => {
  const up = await upstream();
  const host = await openMeasuredHost(up.origin, 'mobile');
  try {
    assert.equal(host.kbps, NETWORK_PROFILES.mobile.kbps);
    assert.equal(host.latencyMs, HOST_LATENCY_MS);
    const expectedMs = (BIG * 8) / (host.kbps * 1000) * 1000; // ~1000 ms for 200 KB at 1638.4 kbit/s

    const one = await timed(`${host.origin}/big`);
    assert.equal(one.res.status, 200);
    assert.equal(one.res.headers.get('x-upstream'), 'yes', 'the upstream headers pass through');
    assert.equal(one.res.headers.get('content-type'), 'application/javascript');
    assert.equal(one.body.length, BIG, 'the body is complete');
    assert.ok(one.body.every((b) => b === 97));
    assert.ok(one.headersAt >= HOST_LATENCY_MS - 5, `headers after the latency (${one.headersAt} ms)`);
    assert.ok(one.totalMs >= expectedMs * 0.85 && one.totalMs <= expectedMs * 1.6 + HOST_LATENCY_MS, `200 KB at the phone throughput takes about ${Math.round(expectedMs)} ms, took ${one.totalMs}`);
    assert.equal(up.seen.at(-1).host, new URL(up.origin).host, 'the upstream is addressed by its own host');

    // Two at once share the link: both end around twice the single time, not each in the single time.
    const t0 = Date.now();
    const [a, b] = await Promise.all([timed(`${host.origin}/big`), timed(`${host.origin}/big`)]);
    const both = Date.now() - t0;
    assert.equal(a.body.length + b.body.length, 2 * BIG);
    assert.ok(both >= expectedMs * 1.7, `two downloads share one link (${both} ms for two)`);

    // Other answers pass through as they are.
    const miss = await timed(`${host.origin}/nowhere`);
    assert.equal(miss.res.status, 404);
    assert.equal(miss.body.toString(), 'not found');
    const br = await fetch(`${host.origin}/br`);
    assert.equal(br.headers.get('content-encoding'), 'br', 'compression is not undone');
    assert.equal(await br.text(), 'body-br', 'and the compressed body is the upstream one');
    const moved = await fetch(`${host.origin}/moved`, { redirect: 'manual' });
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get('location'), '/moved/');
    const empty = await fetch(`${host.origin}/empty`);
    assert.equal(empty.status, 204);
    const head = await timed(`${host.origin}/big`, { method: 'HEAD' });
    assert.equal(head.res.status, 200);
    assert.equal(head.body.length, 0);
    assert.ok(head.totalMs < expectedMs / 2, 'a HEAD sends no body and waits for none');
  } finally {
    await host.close();
    await up.close();
  }
});

test('the computer profile is faster, and the description names every value', async () => {
  const up = await upstream();
  const host = await openMeasuredHost(up.origin, 'desktop');
  try {
    const expectedMs = (BIG * 8) / (host.kbps * 1000) * 1000; // ~160 ms
    const one = await timed(`${host.origin}/big`);
    assert.equal(one.body.length, BIG);
    assert.ok(one.totalMs >= HOST_LATENCY_MS + expectedMs * 0.8 && one.totalMs <= HOST_LATENCY_MS + expectedMs * 2.5 + 100, `200 KB at the computer throughput (${one.totalMs} ms, expected ~${Math.round(expectedMs + HOST_LATENCY_MS)})`);
  } finally {
    await host.close();
    await up.close();
  }
  const d = measuredHostDescription();
  assert.equal(d.latencyMs, HOST_LATENCY_MS);
  assert.equal(d.profiles.mobile.kbps, 1638.4);
  assert.equal(d.profiles.desktop.kbps, 10240);
  assert.match(d.note, /50 ms before each answer/);
  assert.match(d.note, /1\.6 Mbit\/s \(phone, slow 4G\) \/ 10 Mbit\/s \(computer, dense 4G\)/);
  await assert.rejects(openMeasuredHost('http://127.0.0.1:1', 'tablet'), /No network profile/);
});

test('an upstream that is gone answers 502, and closing the host ends it', async () => {
  const up = await upstream();
  const host = await openMeasuredHost(up.origin, 'desktop');
  await up.close();
  const res = await fetch(`${host.origin}/big`);
  assert.equal(res.status, 502);
  await host.close();
  await assert.rejects(fetch(`${host.origin}/big`));
});
