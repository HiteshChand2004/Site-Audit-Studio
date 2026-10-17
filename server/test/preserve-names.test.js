// A module whose file name ends in a version (menu.js@0.0.29) is renamed to a name the host knows (menu@0.0.29.js), and every
// reference to it follows: the page's own script tag, the module that imports it dynamically, and the copy's text. The copy is
// then served by a plain static server with default MIME settings (only the usual script and style types are known to it),
// the way a static host would serve it, and the module must still load as a module.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { liftPage, localPathOf } from '../src/recreate/behavior/preserve/pageLift.js';

const sha = (/** @type {string} */ t) => createHash('sha256').update(t).digest('hex');
const SITE = 'https://site.test/';
let browser;

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

const DOCUMENT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Names</title></head><body>
<div id="out">waiting</div>
<script type="module" src="https://site.test/modules/menu.js@0.0.29"></script>
<script type="module" src="https://site.test/modules/app.js"></script>
</body></html>`;

// The app imports the menu module by its relative name, as the original did.
// The second import builds the name at run time from parts, the way a loader does: the rewrite follows it as well.
const APP = `import('./menu.js@0.0.29').then((m) => { document.getElementById('out').textContent = 'loaded:' + m.name; });
const part = '.js@0.0.29';
import('./menu' + part).then((m) => { window.__built = m.name; });`;
const MENU = `export const name = 'menu';`;

/** The record of that page (what capture/index.js writes). */
async function writeRecord(root) {
  const net = path.join(root, '.network');
  await mkdir(path.join(net, 'files'), { recursive: true });
  const bodies = { doc: DOCUMENT, app: APP, menu: MENU };
  for (const b of Object.values(bodies)) await writeFile(path.join(net, 'files', sha(b)), b);
  const entries = [
    { url: SITE, status: 200, kind: 'document', type: 'text/html', sha: sha(bodies.doc) },
    { url: 'https://site.test/modules/app.js', status: 200, kind: 'script', type: 'text/javascript', sha: sha(bodies.app) },
    { url: 'https://site.test/modules/menu.js@0.0.29', status: 200, kind: 'script', type: 'text/javascript', sha: sha(bodies.menu) },
  ];
  await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries }));
  return root;
}

/** A static server with the defaults of the common hosts: a type comes from the extension, and unknown extensions are octet-stream. */
const DEFAULT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function staticServer(dir) {
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
    try {
      const body = await readFile(path.join(dir, rel));
      const type = DEFAULT_TYPES[path.extname(rel).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(() => r(undefined))) })));
}

test('a versioned file name gets a name the host knows, and the name is kept', () => {
  assert.equal(localPathOf('https://site.test/modules/menu.js@0.0.29'), '/modules/menu@0.0.29.js');
  assert.equal(localPathOf('https://site.test/modules/app.mjs'), '/modules/app.mjs', 'a known name is left alone');
  assert.equal(localPathOf('https://site.test/fonts/abc123', 'font/woff2'), '/fonts/abc123.woff2', 'no extension: the content type decides');
  assert.notEqual(localPathOf('https://site.test/m.js@1.0.0'), localPathOf('https://site.test/m.js@2.0.0'), 'two versions are two files');
});

test('the type of a renamed file is its extension, in both name forms (the copy server and the preview use it)', async () => {
  const { typeExtOf } = await import('../src/recreate/verify/server.js');
  assert.equal(typeExtOf('/m/material-icons/Add@0.0.32.js'), '.js', 'the version sits before the extension');
  assert.equal(typeExtOf('/modules/menu.js@0.0.29'), '.js', 'a version after the extension is stripped');
  assert.equal(typeExtOf('/sites/a/b.mjs'), '.mjs');
});

test('the copy server sends a renamed module as JavaScript, compressed', async () => {
  const { serveCopy } = await import('../src/recreate/behavior/preserve/serve.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-names-serve-'));
  try {
    await mkdir(path.join(root, 'm'), { recursive: true });
    await writeFile(path.join(root, 'm', 'Add@0.0.32.js'), `export const add = () => 1;\n${'// padding\n'.repeat(200)}`, 'utf8');
    const served = await serveCopy(root);
    try {
      const res = await fetch(`${served.url}m/Add@0.0.32.js`, { headers: { 'accept-encoding': 'br, gzip' } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/javascript/);
      assert.equal(res.headers.get('content-encoding') !== null, true, 'text is compressed');
    } finally {
      await served.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a versioned module loads from a static server with default MIME settings: its name and every reference follow the rename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-names-'));
  let server;
  try {
    await writeRecord(root);
    const out = path.join(root, 'copy');
    const lift = await liftPage({ captureRoot: root, pageUrl: SITE, outDir: out, fetch: false });
    assert.ok(lift.files.some((f) => f.local === '/modules/menu@0.0.29.js'), 'the module is copied under its new name');
    assert.equal(lift.downloads.renamed > 0, true, 'the references were rewritten');
    const html = await readFile(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /src="\/modules\/menu@0\.0\.29\.js"/, 'the page\'s own tag names the new file');
    assert.doesNotMatch(html, /menu\.js@0\.0\.29/, 'no old name is left in the document');
    const app = await readFile(path.join(out, 'modules/app.js'), 'utf8');
    assert.match(app, /import\('\.\/menu@0\.0\.29\.js'\)/, 'the module\'s dynamic import names the new file');

    server = await staticServer(out);
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('out').textContent.startsWith('loaded:') && window.__built === 'menu', null, { timeout: 15000 });
    assert.equal(await page.textContent('#out'), 'loaded:menu');
    assert.equal(await page.evaluate(() => window.__built), 'menu', 'the name built at run time loads too');
    assert.deepEqual(errors, [], 'no module was refused for its type');
    await page.close();
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
