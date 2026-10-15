// A page whose answer carries large headers (a Next.js export's CSP with one hash per inline script, ~20 KB) is still
// reachable: undici's default 16 KB limit made the re-audit of such a copy fail with "Could not reach".
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchPage } from '../src/audit/http.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

let server;
let origin;
before(async () => {
  const csp = `script-src 'self' ${Array.from({ length: 400 }, (_, i) => `'sha256-${Buffer.from(String(i).padStart(32, 'x')).toString('base64')}'`).join(' ')}`;
  // Node's own server refuses headers over its default as well; this one only answers.
  server = http.createServer({ maxHeaderSize: 256 * 1024 }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp });
    res.end('<!doctype html><title>ok</title><p>Large headers');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${server.address().port}`;
  assert.ok(csp.length > 20000, `header ${csp.length} bytes`);
});
after(() => new Promise((resolve) => server.close(resolve)));

test('a page with more than 16 KB of headers is fetched', async () => {
  const res = await fetchPage(`${origin}/`);
  assert.equal(res.status, 200, JSON.stringify({ status: res.status, error: res.error }));
  assert.match(res.body ?? res.text ?? '', /Large headers/);
});
