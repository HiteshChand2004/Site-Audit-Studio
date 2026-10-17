// A form in a lifted copy is never sent to the original's backend. The site's own submit handler (which posts to the original)
// runs in the page as it did; the copy's guard (complete.js FORM_GUARD) stops that submit before it reaches the handler.
// With no endpoint set (sas-forms.json) a visible note says the form is not connected and nothing is sent. With an endpoint
// set, the form's data goes there, and nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { registerServiceWorker, FORMS_CONFIG } from '../src/recreate/behavior/preserve/complete.js';
import { serveFolder } from '../src/recreate/behavior/preserve/render.js';

const ORIGIN_HOST = 'original.test';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Form</title></head><body>
<form id="signup"><input type="email" name="email" required><button type="submit">Send</button></form>
<script>
document.getElementById('signup').addEventListener('submit', function (e) {
  e.preventDefault();
  // The site's own handler: it posts to its original backend.
  fetch('https://${ORIGIN_HOST}/api/submit', { method: 'POST', body: new FormData(e.target) }).catch(function () {});
});
</script></body></html>`;

async function copyWith(endpoint) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-forms-'));
  const dir = path.join(root, 'copy');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), PAGE, 'utf8');
  await registerServiceWorker(dir);
  await writeFile(path.join(dir, 'sas-forms.json'), `${JSON.stringify({ endpoint }, null, 2)}\n`, 'utf8');
  return { root, dir };
}

/** Submits the form once; returns the requests the page attempted off its own server, and the note it shows. */
async function submitOnce(browser, copyUrl, endpoint = null) {
  const off = [];
  const context = await browser.newContext();
  try {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(copyUrl) || url.startsWith('data:')) return route.continue();
      // The endpoint the copy is connected to is the one place its form data may go.
      if (endpoint && url.startsWith(endpoint)) return route.continue();
      off.push(`${route.request().method()} ${url}`);
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(`${copyUrl}index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await page.fill('input[name=email]', 'check@example.test');
    await page.click('button[type=submit]');
    await page.waitForTimeout(800);
    const note = await page.locator('[data-sas-form-note]').textContent().catch(() => null);
    return { off, note: note?.trim() ?? null };
  } finally {
    await context.close();
  }
}

test('with no endpoint: the site\'s own submit never reaches the original, and the form says it is not connected', async () => {
  assert.equal(FORMS_CONFIG.endpoint, '', 'empty by default');
  const { root, dir } = await copyWith('');
  const server = await serveFolder(dir);
  const browser = await chromium.launch();
  try {
    const { off, note } = await submitOnce(browser, server.url);
    assert.deepEqual(off.filter((u) => u.includes(ORIGIN_HOST)), [], 'nothing was sent to the original host');
    assert.match(note ?? '', /not connected yet, so nothing was sent/);
  } finally {
    await browser.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('with an endpoint set: the data goes there, and not to the original', async () => {
  const received = [];
  const endpoint = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('ok');
    });
  });
  await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${endpoint.address().port}/collect`;
  const { root, dir } = await copyWith(target);
  const server = await serveFolder(dir);
  const browser = await chromium.launch();
  try {
    const { off, note } = await submitOnce(browser, server.url, target);
    assert.deepEqual(off.filter((u) => u.includes(ORIGIN_HOST)), [], 'nothing was sent to the original host');
    assert.equal(received.length, 1, 'the endpoint got one submission');
    assert.equal(received[0].method, 'POST');
    assert.match(received[0].body, /check@example\.test/, 'the form data is in the submission');
    assert.match(note ?? '', /Thank you/);
  } finally {
    await browser.close();
    await server.close();
    endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});
