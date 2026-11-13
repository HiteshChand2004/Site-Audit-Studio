// Code the original's server answered with an HTML page, and code served at an address ending in / (behavior/preserve/pageLift.js).
// Both broke real copies: sankalpam.ai's inner page loads ./assets/index-DdEuaEXJ.js under /yatra/, which its server answers with
// its own HTML page, and the copy shipped that page as the script (a blank page); botza's Tailwind script from
// cdn.tailwindcss.com/?plugins=… was named index~….html, so every host served it as HTML and the browser refused to run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { hashedName, liftPage, localPathOf } from '../src/recreate/behavior/preserve/pageLift.js';

const sha = (t) => createHash('sha256').update(t).digest('hex');
const PAGE = 'https://site.test/yatra/destinations';

const DOCUMENT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Destinations</title>
<script src="https://cdn.test/?plugins=forms"></script>
<script type="module" crossorigin src="./assets/index-DdEuaEXJ.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-B2y0GRyK.css">
<script src="./assets/helper.js"></script>
</head><body><div id="root"></div></body></html>`;
const SPA_PAGE = '<!DOCTYPE html><html lang="en"><head><title>Sankalpam</title></head><body><div id="root"></div></body></html>';
const BUNDLE = 'document.getElementById("root").textContent = "Destinations";';
const STYLES = '#root { color: rgb(10, 80, 200); }';
const TAILWIND = 'window.tailwind = { config: {} };';

async function writeRecord(root) {
  const net = path.join(root, '.network');
  await mkdir(path.join(net, 'files'), { recursive: true });
  for (const b of [DOCUMENT, SPA_PAGE, BUNDLE, STYLES]) await writeFile(path.join(net, 'files', sha(b)), b);
  const entries = [
    { url: PAGE, status: 200, kind: 'document', type: 'text/html', sha: sha(DOCUMENT) },
    // What the server answered under the sub-folder: its own page, for every address it does not have.
    { url: 'https://site.test/yatra/assets/index-DdEuaEXJ.js', status: 200, kind: 'script', type: 'text/html', sha: sha(SPA_PAGE) },
    { url: 'https://site.test/yatra/assets/index-B2y0GRyK.css', status: 200, kind: 'style', type: 'text/html', sha: sha(SPA_PAGE) },
    { url: 'https://site.test/yatra/assets/helper.js', status: 200, kind: 'script', type: 'text/html', sha: sha(SPA_PAGE) },
    // The same build's files where the homepage loads them.
    { url: 'https://site.test/assets/index-DdEuaEXJ.js', status: 200, kind: 'script', type: 'application/javascript', sha: sha(BUNDLE) },
    { url: 'https://site.test/assets/index-B2y0GRyK.css', status: 200, kind: 'style', type: 'text/css', sha: sha(STYLES) },
  ];
  await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries }));
}

test('a web app manifest the record lacks is downloaded as data (JSON), and the icon it names comes with it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const net = path.join(root, '.network');
  await mkdir(path.join(net, 'files'), { recursive: true });
  const doc = '<!doctype html><html><head><meta charset="utf-8"><title>t</title><link rel="manifest" href="/manifest.json"></head><body>x</body></html>';
  await writeFile(path.join(net, 'files', sha(doc)), doc);
  await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries: [{ url: 'https://site.test/', status: 200, kind: 'document', type: 'text/html', sha: sha(doc) }] }));
  const MANIFEST = JSON.stringify({ name: 'Site', icons: [{ src: '/favicon.svg', type: 'image/svg+xml', sizes: 'any' }] });
  const ICON = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const asked = [];
  // As the real downloader: JSON is "not an asset" unless asked for as data.
  const fetchImpl = async (url, { dir, kind }) => {
    asked.push(`${kind} ${new URL(url).pathname}`);
    await mkdir(dir, { recursive: true });
    const body = url.endsWith('manifest.json') ? MANIFEST : url.endsWith('favicon.svg') ? ICON : null;
    if (!body) return { ok: false, reason: 'http-404', finalUrl: url };
    const mime = url.endsWith('.json') ? 'application/json' : 'image/svg+xml';
    if (mime === 'application/json' && kind !== 'data') return { ok: false, reason: 'not-an-asset', mime, finalUrl: url };
    const tmp = path.join(dir, `${sha(url)}.tmp`);
    await writeFile(tmp, body);
    return { ok: true, tmp, sha256: sha(body), bytes: body.length, mime, finalUrl: url, redirects: [] };
  };
  const out = path.join(root, 'copy');
  const lift = await liftPage({ captureRoot: root, pageUrl: 'https://site.test/', outDir: out, fetchImpl });
  assert.ok(asked.includes('data /manifest.json'), `the manifest is asked for as data (${asked.join(', ')})`);
  assert.equal(await readFile(path.join(out, 'manifest.json'), 'utf8'), MANIFEST);
  assert.equal(await readFile(path.join(out, 'favicon.svg'), 'utf8'), ICON, 'the icon it names is in the copy');
  assert.equal(lift.blockers.length, 0);
  assert.deepEqual(lift.downloads.failedUrls.map((f) => new URL(f.url).pathname), ['/robots.txt'], 'only the robots.txt this site does not have');
});

test('an icon the original does not serve at a sub-folder address takes the file an earlier page brought in (same hashed name)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-liftedtwin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const net = path.join(root, '.network');
  await mkdir(path.join(net, 'files'), { recursive: true });
  const doc = '<!doctype html><html><head><meta charset="utf-8"><title>t</title><link rel="icon" href="./assets/favicon-32x32-R45_galS.png"><link rel="icon" href="./assets/plain.png"></head><body>x</body></html>';
  await writeFile(path.join(net, 'files', sha(doc)), doc);
  await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries: [{ url: PAGE, status: 200, kind: 'document', type: 'text/html', sha: sha(doc) }] }));
  const out = path.join(root, 'copy');
  await mkdir(path.join(out, 'yatra/destinations'), { recursive: true });
  // The server answers its page for every address it does not have: the downloader refuses it.
  const fetchImpl = async (url) => ({ ok: false, reason: 'not-an-asset', mime: 'text/html', finalUrl: url });
  const lifted = [{ url: 'https://site.test/assets/favicon-32x32-R45_galS.png', local: '/assets/favicon-32x32-R45_galS.png', sha256: 'abc' }];
  const lift = await liftPage({ captureRoot: root, pageUrl: PAGE, outDir: out, entry: 'yatra/destinations/index.html', fetchImpl, lifted });
  const html = await readFile(path.join(out, 'yatra/destinations/index.html'), 'utf8');
  assert.match(html, /href="\/assets\/favicon-32x32-R45_galS\.png"/);
  assert.deepEqual(lift.healed.map((h) => h.to), ['https://site.test/assets/favicon-32x32-R45_galS.png']);
  assert.ok(lift.blockers.some((b) => b.url.endsWith('/yatra/assets/plain.png')), 'a name with no build hash is not guessed at');
});

test('names: an address ending in / is named by its content (or its tag), a document stays index.html; a build hash is recognised', () => {
  assert.match(localPathOf('https://cdn.test/?plugins=forms', 'text/javascript'), /^\/index~[0-9a-f]{8}\.js$/);
  assert.match(localPathOf('https://cdn.test/?plugins=forms', null, 'script'), /^\/index~[0-9a-f]{8}\.js$/, 'no type known: the tag that loads it');
  assert.match(localPathOf('https://cdn.test/theme/', 'text/css'), /^\/theme\/index\.css$/);
  assert.equal(localPathOf('https://site.test/about/', 'text/html'), '/about/index.html');
  assert.equal(localPathOf('https://site.test/', null), '/index.html', 'a page with nothing known stays a page');
  assert.equal(localPathOf('https://site.test/', 'text/html', 'script'), '/index.html', 'an HTML answer is named as what it is');
  assert.equal(localPathOf('https://site.test/app.js', 'text/javascript', 'script'), '/app.js', 'a named file is unchanged');
  for (const n of ['index-DdEuaEXJ.js', 'index-B2y0GRyK.css', 'main.4f2a9c1b.css', '2s_-x01tqnjnl.js', 'favicon-32x32-R45_galS.png']) assert.ok(hashedName(n), n);
  for (const n of ['helper.js', 'my-analytics.js', 'jquery-3.6.0.min.js', 'apple-touch-icon.png', 'index.html', 'page-AbCdEf12.html']) assert.ok(!hashedName(n), n);
});

test('a script or stylesheet the original answered with its HTML page takes the build\'s file of that name; a CDN script at / is named .js', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-codefallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeRecord(root);
  const out = path.join(root, 'copy');
  await mkdir(path.join(out, 'yatra/destinations'), { recursive: true }); // as asis.js does before each page
  const fetchImpl = async (url, { dir }) => {
    if (!url.startsWith('https://cdn.test/')) return { ok: false, reason: 'http-404', finalUrl: url };
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, 'tw.tmp');
    await writeFile(tmp, TAILWIND);
    return { ok: true, tmp, sha256: sha(TAILWIND), bytes: TAILWIND.length, mime: 'text/javascript', finalUrl: 'https://cdn.test/3.4.17?plugins=forms', redirects: [url] };
  };
  const lift = await liftPage({ captureRoot: root, pageUrl: PAGE, outDir: out, entry: 'yatra/destinations/index.html', fetchImpl });
  const html = await readFile(path.join(out, 'yatra/destinations/index.html'), 'utf8');

  assert.match(html, /src="\/assets\/index-DdEuaEXJ\.js"/, 'the script points at the build\'s bundle');
  assert.match(html, /href="\/assets\/index-B2y0GRyK\.css"/, 'and the stylesheet at its file');
  assert.equal(await readFile(path.join(out, 'assets/index-DdEuaEXJ.js'), 'utf8'), BUNDLE);
  assert.equal(await readFile(path.join(out, 'assets/index-B2y0GRyK.css'), 'utf8'), STYLES);
  assert.equal(await stat(path.join(out, 'yatra/assets/index-DdEuaEXJ.js')).then(() => true, () => false), false, 'the HTML page is not written under the script\'s name');
  assert.deepEqual(lift.healed.map((h) => [h.url, h.to]), [
    ['https://site.test/yatra/assets/index-DdEuaEXJ.js', 'https://site.test/assets/index-DdEuaEXJ.js'],
    ['https://site.test/yatra/assets/index-B2y0GRyK.css', 'https://site.test/assets/index-B2y0GRyK.css'],
  ]);

  // A name with no build hash has no safe twin: kept as the original has it, and said so.
  assert.match(html, /src="\/yatra\/assets\/helper\.js"/);
  assert.ok(lift.blockers.some((b) => b.url.endsWith('/yatra/assets/helper.js') && /answers this script or stylesheet with an HTML page/.test(b.reason)));

  const tw = html.match(/<script src="([^"]+)"><\/script>/)?.[1];
  assert.match(tw, /^\/index~[0-9a-f]{8}\.js$/, `the CDN script at / is a .js file (${tw})`);
  assert.equal(await readFile(path.join(out, tw), 'utf8'), TAILWIND);
});
