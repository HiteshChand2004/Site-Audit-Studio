// A fix counts only where it takes effect (copy/served.js): security headers only when the copy's own server sends them, never for
// a static stack whose `_headers` depends on the host; a site file or a fixed page the packaged copy does not serve is open.
// And for real: the Next.js as-is package sends the security headers from next.config.mjs, which next start applies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureServed, servedOutcome } from '../src/copy/served.js';
import { SECURITY_HEADERS } from '../src/copy/securityHeaders.js';
import { packLifted } from '../src/recreate/behavior/preserve/pack.js';
import { buildStack, startStack } from '../src/recreate/behavior/preserve/serveStack.js';
import { toolchainStatus } from '../src/toolchains/index.js';

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixed page</title><link rel="canonical" href="https://www.acme-new.dev/"></head><body><h1>Hi</h1></body></html>';

async function site(t, { headers = {}, files = {}, page = PAGE }) {
  const server = createServer((req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html', ...headers }).end(page);
    if (files[req.url]) return res.writeHead(200).end(files[req.url]);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixedCopy(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-served-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), PAGE);
  return dir;
}

const ALL = Object.fromEntries(SECURITY_HEADERS);

test('a static stack never counts its _headers as applied: it is open with reason e', async (t) => {
  const base = await site(t, { headers: ALL, files: { '/robots.txt': 'ok', '/sitemap.xml': 'ok' } });
  const dir = await fixedCopy(t);
  for (const stack of ['html', 'react-vite']) {
    const m = await measureServed({ base, stack, copyDir: dir, fixedPages: [{ path: '/', outPath: 'index.html' }], files: ['_headers', 'robots.txt', 'sitemap.xml'] });
    const o = servedOutcome(m);
    assert.deepEqual(o.applied, [], `${stack}: even a local server that sends them is not the host`);
    assert.equal(o.open.length, 1);
    assert.equal(o.open[0].reason, 'deploy');
    assert.ok(!('_headers' in m.files), '_headers is not a served site file');
  }
});

test('a stack with its own server: what it sends is applied, what it does not send is open', async (t) => {
  const dir = await fixedCopy(t);
  const all = await site(t, { headers: ALL, files: { '/robots.txt': 'ok' } });
  const full = servedOutcome(await measureServed({ base: all, stack: 'nextjs', copyDir: dir, fixedPages: [{ path: '/', outPath: 'index.html' }], files: ['robots.txt'] }));
  assert.deepEqual(full.applied, SECURITY_HEADERS.map(([n]) => n));
  assert.equal(full.open.length, 0);

  const { 'Strict-Transport-Security': _hsts, ...noHsts } = ALL;
  const partial = servedOutcome(await measureServed({ base: await site(t, { headers: noHsts }), stack: 'mern', copyDir: dir }));
  assert.equal(partial.applied.length, SECURITY_HEADERS.length - 1);
  assert.match(partial.open[0].values, /Strict-Transport-Security/);
});

test('a site file the copy does not serve, and a page served differently from the fixed file, are open', async (t) => {
  const dir = await fixedCopy(t);
  const base = await site(t, { headers: ALL, files: { '/robots.txt': 'ok' }, page: PAGE.replace('acme-new', 'someone-else') });
  const o = servedOutcome(await measureServed({ base, stack: 'nextjs', copyDir: dir, fixedPages: [{ path: '/', outPath: 'index.html' }], files: ['robots.txt', 'sitemap.xml'] }));
  assert.ok(o.open.some((x) => x.check === 'site file sitemap.xml'));
  assert.ok(!o.open.some((x) => x.check === 'site file robots.txt'));
  assert.ok(o.open.some((x) => x.check === 'fixes served' && x.page === '/'));
});

test('a page rendered differently but stating the same fixes is served as fixed; one that lost a fix names what it lost', async (t) => {
  const fixed = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixed page</title><meta name="description" content="A page about things.">'
    + '<link rel="canonical" href="https://www.acme-new.dev/"><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script></head>'
    + '<body><!-- note --><div class="a  b" id="x"><img src="/a.png" alt="A cat"><button aria-label="Open menu" class="m">≡</button></div></body></html>';
  // The same page as React writes it: attributes in another order and quoting, white space and comments gone, `<img />`.
  const rendered = '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>Fixed page</title><meta content="A page about things." name="description"/>'
    + '<link href="https://www.acme-new.dev/" rel="canonical"/><script type="application/ld+json">{"name":"Acme","@type":"Organization"}</script></head>'
    + '<body><div id="x" class="a  b"><img alt="A cat" src="/a.png"/><button class="m" aria-label="Open menu">≡</button></div><script src="/x.js"></script></body></html>';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-served-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), fixed);
  const page = [{ path: '/', outPath: 'index.html', kinds: ['alt', 'names', 'head', 'data'] }];
  const same = await measureServed({ base: await site(t, { page: rendered }), stack: 'nextjs', copyDir: dir, fixedPages: page });
  assert.deepEqual(same.pages, [{ path: '/', status: 200, servedAsFixed: true, compared: 'meaning' }]);

  const lost = await measureServed({ base: await site(t, { page: rendered.replace(' aria-label="Open menu"', '') }), stack: 'nextjs', copyDir: dir, fixedPages: page });
  assert.deepEqual(lost.pages[0].differs, ['a11y']);
  assert.match(servedOutcome(lost).open.find((o) => o.check === 'fixes served').values, /without these fixes: a11y/);
  // A difference no recorded fix wrote (the head, when the page's only fix was an alt text) is not the fixes' concern.
  const other = await measureServed({ base: await site(t, { page: rendered.replace('<title>Fixed page', '<title>Other') }), stack: 'nextjs', copyDir: dir, fixedPages: [{ ...page[0], kinds: ['alt'] }] });
  assert.equal(other.pages[0].servedAsFixed, true);
});

test('the Next.js as-is package sends the security headers (next start applies next.config.mjs)', { timeout: 10 * 60000 }, async (t) => {
  if (!(await toolchainStatus('next')).installed) return t.skip('the next toolchain is not installed');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-served-next-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copyDir = path.join(root, 'copy');
  await mkdir(copyDir, { recursive: true });
  await writeFile(path.join(copyDir, 'index.html'), PAGE);
  await writeFile(path.join(copyDir, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  const outDir = path.join(root, 'next');
  await packLifted({ stack: 'nextjs', copyDir, outDir, pageUrl: 'https://www.example-original.dev/' });
  await buildStack('nextjs', outDir);
  const server = await startStack('nextjs', outDir);
  try {
    const m = await measureServed({ base: server.url, stack: 'nextjs', copyDir, fixedPages: [{ path: '/', outPath: 'index.html' }], files: ['robots.txt'] });
    const o = servedOutcome(m);
    assert.deepEqual(o.applied, SECURITY_HEADERS.map(([n]) => n), JSON.stringify(m.headers));
    assert.equal(m.files['robots.txt'], 200);
    assert.equal(m.pages[0].servedAsFixed, true, 'next start serves the fixed page itself');
  } finally {
    await server.stop();
  }
});
