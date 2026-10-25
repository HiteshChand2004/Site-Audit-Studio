// A part an outside service serves only to the original's domain (recreate/behavior/preserve/domainLock.js): the copy keeps its
// script, the service refuses the copy's origin (CORS allow-list), and the report says so in plain words. Three stand-in
// services on one local port: one allowing only the original's domain (preflight and request), one open to every domain but
// answering 404 (broken for everybody, not locked), one refusing every domain (not locked either).
process.env.SAS_ALLOW_LOCALHOST = '1';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { domainLockedParts, lockedItems, lockedText } from '../src/recreate/behavior/preserve/domainLock.js';

const SERVICE_PORT = 4256;
const SERVICE = `http://127.0.0.1:${SERVICE_PORT}`;
// The original lives on www.; the service lists only that name.
const ORIGINAL = 'https://example-original.test/';
const ALLOWED = 'https://www.example-original.test';

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Widget page</title></head><body><h1>Home</h1>
<div id="widget">loading</div>
<script>
const ask = (p) => fetch('${SERVICE}' + p, { headers: { 'Content-Type': 'application/json' } }).then((r) => r.json());
ask('/locked/cfg').then((c) => { document.getElementById('widget').textContent = c.title; }, () => {});
fetch('${SERVICE}/gone/cfg').catch(() => {});
fetch('${SERVICE}/closed/cfg').catch(() => {});
</script></body></html>`;

let service;
let copy;
let browser;
let dir;

before(async () => {
  service = createServer((req, res) => {
    const origin = req.headers.origin;
    const kind = req.url.split('/')[1];
    const allowed = kind === 'gone' || (kind === 'locked' && origin === ALLOWED);
    if (!allowed) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"message":"Not allowed by CORS"}');
    }
    const cors = { 'access-control-allow-origin': kind === 'gone' ? '*' : origin, 'access-control-allow-headers': 'Content-Type', vary: 'Origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (kind === 'gone') { res.writeHead(404, cors); return res.end('{}'); }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end('{"title":"Ask us anything"}');
  });
  await new Promise((r) => service.listen(SERVICE_PORT, '127.0.0.1', r));
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-domain-lock-'));
  await writeFile(path.join(dir, 'index.html'), PAGE);
  copy = await serveCopy(dir);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await copy?.close?.();
  await new Promise((r) => { service?.closeAllConnections?.(); service ? service.close(() => r()) : r(); });
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test('a service locked to the original\'s domain is found with its evidence; one broken or closed for everybody is not', { timeout: 120000 }, async () => {
  const locked = await domainLockedParts(browser, copy.url.replace(/\/$/, ''), '/', ORIGINAL);
  assert.deepEqual(locked.map((l) => l.url), [`${SERVICE}/locked/cfg`]);
  const [l] = locked;
  assert.equal(l.host, '127.0.0.1');
  assert.equal(l.original.origin, ALLOWED, 'the www. twin of the original is asked too');
  assert.equal(l.original.allowed, true);
  assert.equal(l.original.status, 200);
  assert.deepEqual([l.other.allowed, l.other.step, l.other.status], [false, 'preflight', 500], 'another domain is refused at the preflight');
});

test('the report says it in plain words, once per service and page', () => {
  const item = { url: `${SERVICE}/locked/cfg`, host: 'chat.example.net', method: 'GET', original: { origin: ALLOWED, allowed: true, status: 200 }, other: { origin: 'https://example.com', allowed: false, status: 500, answer: '{"message":"Not allowed by CORS"}' } };
  const items = lockedItems([{ path: '/', domainLocked: [item, { ...item, url: `${SERVICE}/locked/other` }] }, { path: '/about/', domainLocked: [] }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].values, "This part (chat.example.net) only loads on the original's domain. It will appear once your new domain is allowed in that service's settings.");
  assert.equal(items[0].values, lockedText('chat.example.net'));
  assert.equal(items[0].reason, 'third_party');
  assert.match(items[0].tried, /refused another \(https:\/\/example\.com: 500 \{"message":"Not allowed by CORS"\}\)/);
});
