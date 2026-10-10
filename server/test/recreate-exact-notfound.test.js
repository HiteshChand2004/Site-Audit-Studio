// Exact mode, phase B4: what the original answers for an address that does not exist. A copy that answers 200 with
// a blank page where the original answers 404 with a page of its own is wrong in a way no screenshot would show.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { probeNotFound } from '../src/recreate/discover.js';
import { crawlFiles } from '../src/recreate/ir/crawlFiles.js';
import { userPolicy, withNetPolicy } from '../src/security/netGuard.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4212;
const origin = `http://127.0.0.1:${PORT}`;

const DESIGNED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page not found - Example</title>
<link rel="stylesheet" href="/site.css"><style>body{font:16px system-ui}</style></head><body>
<header><a href="/">Example</a></header>
<main><h1>We could not find that page</h1><p>${'Try the menu above, or start from the homepage. '.repeat(8)}</p></main>
<footer>© Example</footer></body></html>`;

let server;
let mode = 'designed';

before(async () => {
  server = createServer((req, res) => {
    if (mode === 'designed') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(DESIGNED);
    }
    if (mode === 'bare') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    // A single-page app that answers everything with the shell, and so never really 404s.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><title>App</title><div id="root"></div>');
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
});

after(() => server.close());

const probe = () => withNetPolicy(userPolicy(), () => probeNotFound(origin));

test('a 404 page of the site own design is recognised, with its status and title', async () => {
  mode = 'designed';
  const r = await probe();
  assert.equal(r.status, 404);
  assert.equal(r.html, true);
  assert.equal(r.ownPage, true, 'worth capturing and rebuilding like any other page');
  assert.equal(r.title, 'Page not found - Example');
  assert.match(r.url, /sas-no-such-page-/, 'an address no site would really have');
});

test('a server bare "Not Found" is reported but not worth rebuilding', async () => {
  mode = 'bare';
  const r = await probe();
  assert.equal(r.status, 404);
  assert.equal(r.html, false);
  assert.equal(r.ownPage, false);
});

test('a site that answers 200 for everything is reported as exactly that', async () => {
  mode = 'spa';
  const r = await probe();
  assert.equal(r.status, 200, 'a soft 404: the status is the finding');
  assert.equal(r.html, true);
  // Too thin to be a page of its own, so nothing is rebuilt from it - but the 200 is in the report.
  assert.equal(r.ownPage, false);
});

test('the rebuilt 404 page is never offered to a search engine', () => {
  const page = (info, head = {}) => ({
    info,
    head: { title: 't', meta: [], ...head },
    root: { tag: 'body', attrs: {}, views: {}, children: [] },
  });
  const pages = [
    page({ path: '/', outPath: 'index.html', slug: 'index' }),
    page({ path: '/about', outPath: 'about.html', slug: 'about' }),
    page({ path: '/sas-no-such-page-abc', outPath: '404.html', slug: 'not-found', notFound: true }),
  ];
  const out = crawlFiles({ pages, baseUrl: 'https://example.com', robots: null, llms: null, siteName: 'Example' });
  const sitemap = out.files.find((f) => f.path.endsWith('sitemap.xml'));
  assert.ok(sitemap, JSON.stringify(out.files.map((f) => f.path)));
  assert.match(sitemap.content, /https:\/\/example\.com\//);
  assert.match(sitemap.content, /\/about/);
  assert.ok(!sitemap.content.includes('404'), sitemap.content);
  assert.ok(!sitemap.content.includes('sas-no-such-page'), 'and not under its probed address either');
  // And it is listed as excluded, so the report can say why it is not there.
  assert.ok(out.sitemap.excluded.includes('/sas-no-such-page-abc'), JSON.stringify(out.sitemap.excluded));
});
