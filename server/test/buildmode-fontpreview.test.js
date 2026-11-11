// The fonts of a design direction's preview card (src/buildmode/fontPreview.js): names are checked before anything is asked,
// the stylesheet points only at the app's own font route, files are served with the right type, the cache is reused (also
// after a restart), a family that cannot be fetched answers 404, and the cache stays within its limits. Fake fetchers, no network.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { checkFamily, checkFile, fontPreviewRouter, fontPreviewStore } from '../src/buildmode/fontPreview.js';

const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'sas-fontpreview-'));
  dirs.push(d);
  return d;
};
const servers = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const WOFF2 = (tag) => Buffer.concat([Buffer.from('wOF2'), Buffer.from(tag)]);
/** Google's answer for a family: cyrillic + latin faces at 400 and 700. */
const googleCss = (family) => {
  const s = family.toLowerCase().replace(/ /g, '');
  return [400, 700].map((w) => `/* cyrillic */\n@font-face { font-family: '${family}'; font-style: normal; font-weight: ${w}; font-display: swap; src: url(https://fonts.gstatic.com/s/${s}/v1/cyr-${w}.woff2) format('woff2'); unicode-range: U+0400-045F, U+0490-0491; }\n/* latin */\n@font-face { font-family: '${family}'; font-style: normal; font-weight: ${w}; font-display: swap; src: url(https://fonts.gstatic.com/s/${s}/v1/latin-${w}.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131, U+2000-206F; }`).join('\n');
};

/** Fetchers that know a few families and count what they were asked. */
function fakes(known = ['Inter', 'Playfair Display', 'Lora', 'Fraunces']) {
  const calls = { css: [], file: [] };
  return {
    calls,
    fetchCss: async (family) => {
      calls.css.push(family);
      return known.includes(family) ? googleCss(family) : null;
    },
    fetchFile: async (url) => {
      calls.file.push(url);
      return WOFF2(url);
    },
  };
}

async function serve(store) {
  const app = express();
  app.use('/api/build/fonts', fontPreviewRouter(store));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/api/build/fonts`;
}

test('family and file names: only plain names pass; path tricks and odd names are refused before anything is asked', async () => {
  assert.equal(checkFamily('Inter'), 'Inter');
  assert.equal(checkFamily('  Playfair   Display '), 'Playfair Display');
  assert.equal(checkFamily('M PLUS 1p'), 'M PLUS 1p');
  for (const bad of ['', '   ', '123', '../app', 'Inter/../../x', 'Inter;color:red', 'Inter"', "Open Sans'", 'Inter\nx', 'Inter\u0000', 'Ïnter', 'a'.repeat(49), null, 42, ['Inter']]) {
    assert.equal(checkFamily(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(checkFile('inter-0123456789ab.woff2'), 'inter-0123456789ab.woff2');
  for (const bad of ['index.json', '../index.json', 'inter-0123456789ab.woff', 'Inter-0123456789ab.woff2', 'inter-0123456789AB.woff2', 'inter-123.woff2', '..-0123456789ab.woff2', 'a/b-0123456789ab.woff2', `${'a'.repeat(90)}-0123456789ab.woff2`]) {
    assert.equal(checkFile(bad), null, `refused: ${bad}`);
  }

  const f = fakes();
  const base = await serve(fontPreviewStore({ dir: tempDir(), ...f }));
  for (const route of ['/..%2F..%2Fapp.db.css', '/Inter%3Cscript%3E.css', '/Inter.txt', '/Inter', `/${'A'.repeat(60)}.css`, '/%2e%2e.css', '/Inter%22%7D.css']) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 400, route);
  }
  for (const route of ['/files/index.json', '/files/..%2Findex.json', '/files/..%2F..%2Fapp.db', '/files/INTER-0123456789ab.woff2']) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 400, route);
  }
  // A name of the right shape that this cache never wrote is simply not there.
  assert.equal((await fetch(`${base}/files/inter-0123456789ab.woff2`)).status, 404);
  assert.deepEqual(f.calls.css, [], 'no refused name reached the fetcher');
});

test('the stylesheet points only at the app\'s own font route; the files are served as woff2', async () => {
  const f = fakes();
  const dir = tempDir();
  const base = await serve(fontPreviewStore({ dir, ...f }));
  const res = await fetch(`${base}/Playfair%20Display.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/css/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control'), /private/);
  const css = await res.text();
  assert.deepEqual(f.calls.css, ['Playfair Display']);
  assert.ok(!/gstatic|googleapis|https?:|\/\//i.test(css.replace(/\/\*[^]*?\*\//g, '')), 'no other address in the stylesheet');
  const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 2, 'the latin faces at 400 and 700, no cyrillic');
  for (const u of urls) assert.match(u, /^"files\/[a-z0-9-]+-[0-9a-f]{12}\.woff2"$/);
  assert.match(css, /font-family: "Playfair Display sas-preview";/);
  assert.match(css, /font-weight: 400;[\s\S]*font-weight: 700;/);
  assert.ok(!css.includes('U+0400'), 'only latin ranges');
  assert.ok(f.calls.file.every((u) => u.includes('/latin-')), 'only latin files were downloaded');

  const file = urls[0].slice(1, -1);
  const font = await fetch(`${base}/${file}`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.match(font.headers.get('cache-control'), /immutable/);
  assert.equal(font.headers.get('x-content-type-options'), 'nosniff');
  const body = Buffer.from(await font.arrayBuffer());
  assert.equal(body.subarray(0, 4).toString(), 'wOF2');
  assert.ok(existsSync(path.join(dir, file.slice('files/'.length))));
});

test('the cache is reused: one fetch per family, also for requests at the same time and after a restart', async () => {
  const f = fakes();
  const dir = tempDir();
  const base = await serve(fontPreviewStore({ dir, ...f }));
  const answers = await Promise.all([1, 2, 3].map(() => fetch(`${base}/Inter.css`).then((r) => r.text())));
  assert.equal(new Set(answers).size, 1);
  await fetch(`${base}/Inter.css`);
  assert.deepEqual(f.calls.css, ['Inter']);
  assert.equal(f.calls.file.length, 2);

  // A new server process on the same folder: the index is read back, nothing is fetched, the files are still served.
  const again = fakes();
  const base2 = await serve(fontPreviewStore({ dir, ...again }));
  const css = await (await fetch(`${base2}/Inter.css`)).text();
  assert.equal(css, answers[0]);
  const file = /url\("([^"]+)"\)/.exec(css)[1];
  assert.equal((await fetch(`${base2}/${file}`)).status, 200);
  assert.deepEqual(again.calls.css, []);

  // A stray file the index does not list (a crash between writes) is removed when the cache starts.
  writeFileSync(path.join(dir, 'stray-0123456789ab.woff2'), 'wOF2');
  const third = fontPreviewStore({ dir, ...fakes() });
  assert.deepEqual(await third.families(), ['Inter']);
  assert.ok(!existsSync(path.join(dir, 'stray-0123456789ab.woff2')));
});

test('a family that cannot be fetched answers 404, is remembered for a while, and is asked again later', async () => {
  let clock = 1_000_000;
  const f = fakes();
  const dir = tempDir();
  const base = await serve(fontPreviewStore({ dir, ...f, now: () => clock }));
  const res = await fetch(`${base}/Georgia.css`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/Georgia.css`)).status, 404);
  assert.deepEqual(f.calls.css, ['Georgia'], 'remembered: not asked twice');
  clock += 2 * 60 * 60 * 1000;
  assert.equal((await fetch(`${base}/Georgia.css`)).status, 404);
  assert.deepEqual(f.calls.css, ['Georgia', 'Georgia'], 'asked again after a while');

  // A failed request and files that are not woff2 count as not available too.
  const broken = await serve(fontPreviewStore({
    dir: tempDir(),
    fetchCss: async (family) => (family === 'Lora' ? googleCss(family) : Promise.reject(new Error('offline'))),
    fetchFile: async () => Buffer.from('<html>not a font</html>'),
  }));
  assert.equal((await fetch(`${broken}/Inter.css`)).status, 404);
  assert.equal((await fetch(`${broken}/Lora.css`)).status, 404);
});

test('the cache keeps at most its number of families, least recently used out first, with their files', async () => {
  let clock = 0;
  const dir = tempDir();
  const store = fontPreviewStore({ dir, ...fakes(), limits: { families: 2 }, now: () => (clock += 2 * 60 * 60 * 1000) });
  assert.ok(await store.css('Inter'));
  assert.ok(await store.css('Lora'));
  assert.ok(await store.css('Inter'), 'Inter used again');
  assert.ok(await store.css('Fraunces'));
  assert.deepEqual((await store.families()).sort(), ['Fraunces', 'Inter']);
  const files = readdirSync(dir).filter((n) => n.endsWith('.woff2'));
  assert.ok(files.length === 4 && !files.some((n) => n.startsWith('lora-')), 'Lora\'s files are gone with it');

  const small = fontPreviewStore({ dir: tempDir(), ...fakes(), limits: { bytes: 1 } });
  assert.ok(await small.css('Inter'), 'the family just asked for is served even when it alone is over the size limit');
  assert.ok(await small.css('Lora'));
  assert.deepEqual(await small.families(), ['Lora']);
});
