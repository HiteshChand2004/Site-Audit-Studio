// A runtime builds addresses from a base URL: new URL(path, "<original host URL>"). The host rewrite (hostRewrite.js) turns
// that base into a root-relative path, which `new URL` refuses ("Invalid base URL") and which made a framer CMS module disable
// its own UI. The URL base shim (complete.js URL_BASE_SHIM) resolves such a base against the page; this test keeps it so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { registerServiceWorker, URL_BASE_SHIM } from '../src/recreate/behavior/preserve/complete.js';
import { rewriteHosts } from '../src/recreate/behavior/preserve/hostRewrite.js';
import { serveFolder } from '../src/recreate/behavior/preserve/render.js';

const HOST = 'original.test';

test('the host rewrite turns an absolute base into a relative one, which new URL refuses (the pattern this guards)', () => {
  const code = `const u = new URL('./chunk.framercms', 'https://${HOST}/modules/app.js').href;`;
  const { text, count } = rewriteHosts(code, [HOST]);
  assert.equal(count, 1);
  assert.match(text, /new URL\('\.\/chunk\.framercms', '\/modules\/app\.js'\)/);
  assert.throws(() => new URL('./chunk.framercms', '/modules/app.js'), TypeError);
});

test('a copy whose modules build URLs from a relative base keeps working: the shim resolves the base, absolute URLs are unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-urlbase-'));
  const browser = await chromium.launch();
  try {
    const dir = path.join(root, 'copy');
    await mkdir(path.join(dir, 'modules'), { recursive: true });
    const moduleCode = `window.__built = new URL('./chunk.framercms', '/modules/app.js').href;`
      + `window.__absolute = new URL('https://${HOST}/x.json').href;`
      + `window.__canParse = URL.canParse('/a', 'https://example.test');`;
    await writeFile(path.join(dir, 'modules', 'app.js'), rewriteHosts(moduleCode, [HOST]).text, 'utf8');
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head>'
      + '<body><script type="module" src="modules/app.js"></script></body></html>', 'utf8');
    // A copy always has its worker (sw.js) next to the page; the registration it gets points at it.
    await writeFile(path.join(dir, 'sw.js'), "self.addEventListener('install', () => self.skipWaiting());\n", 'utf8');
    await registerServiceWorker(dir);
    const html = await readFile(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes(URL_BASE_SHIM), 'the shim is in the page, at the end of the body');
    assert.ok(html.indexOf(URL_BASE_SHIM) > html.indexOf('</script>'), 'the shim comes after the module tag, before the body closes');

    const server = await serveFolder(dir);
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${server.url}index.html`, { waitUntil: 'load' });
      const seen = await page.evaluate(() => ({
        built: window.__built,
        absolute: window.__absolute,
        canParse: window.__canParse,
        instance: new URL('/q', 'https://e.test') instanceof URL,
        origin: location.origin,
      }));
      assert.equal(seen.built, `${seen.origin}/modules/chunk.framercms`, 'the relative base resolved against the page');
      // The host rewrite made the original's address a local path, so the copy resolves it against its own origin.
      assert.equal(seen.absolute, `${seen.origin}/x.json`, 'an absolute address of the original resolves to the copy');
      assert.equal(seen.canParse, true);
      assert.equal(seen.instance, true);
      assert.deepEqual(errors, [], 'no page error');
      await page.close();
    } finally {
      await server.close();
    }
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
