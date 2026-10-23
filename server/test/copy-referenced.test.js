// Files a lifted copy names but does not hold (recreate/behavior/preserve/referenced.js): read from the copy's own text, asked of
// the original's hosts once, stored where a static host answers them. No network: the download is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchReferenced, referencedAddresses } from '../src/recreate/behavior/preserve/referenced.js';
import { fixAsIsCopy } from '../src/copy/fixAsIs.js';

const SITE = 'https://www.example-original.test/';
const CDN = 'https://cdn.example-original-cdn.test';

test('the addresses a text names: root-relative, absolute, next to a module, relative imports', () => {
  const js = 'a="/assets/hero-1a2b.mp4";b=new URL("banner-9f.png",import.meta.url).href;c=import(`./page-77.mjs`);d="/about";e="//other.test/x.js"';
  const got = referencedAddresses(js, { fileUrl: `${CDN}/sites/1/main.mjs`, pageUrl: SITE });
  assert.ok(got.includes('https://www.example-original.test/assets/hero-1a2b.mp4'));
  assert.ok(got.includes(`${CDN}/sites/1/banner-9f.png`), 'a bundler\'s new URL(name, import.meta.url) is next to the module');
  assert.ok(got.includes(`${CDN}/sites/1/page-77.mjs`));
  assert.ok(!got.some((u) => u.endsWith('/about')), 'a page has no file extension: never fetched this way');
  assert.ok(!got.some((u) => u.includes('other.test')), 'a protocol-relative address is not root-relative');

  const rsc = String.raw`self.__next_f.push([1,"[\"$\",\"link\",\"15\",{\"rel\":\"icon\",\"href\":\"/favicon.ico?favicon.2v5.ico\"}]"])`;
  assert.deepEqual(referencedAddresses(rsc, { fileUrl: null, pageUrl: SITE }), ['https://www.example-original.test/favicon.ico?favicon.2v5.ico']);
  assert.deepEqual(referencedAddresses('import("./x.mjs")', { fileUrl: null, pageUrl: SITE }), [], 'relative names only inside a file of the original');
});

test('missing files are fetched once, chains of modules followed, renamed files given their bare path, pages not mistaken for files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-referenced-'));
  try {
    await mkdir(path.join(dir, 'sites/1'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), '<link rel="icon" href="/favicon~ab12.ico"><script src="/sites/1/main.mjs"></script><a href="/assets/brochure.pdf">x</a>');
    await writeFile(path.join(dir, 'favicon~ab12.ico'), 'icon');
    await writeFile(path.join(dir, 'sites/1/main.mjs'), 'import("./page-77.mjs");const v=new URL("hero-1a.mp4",import.meta.url);const s="/app-shell.js";');
    const manifest = {
      [`${SITE}favicon.ico?v=2`]: '/favicon~ab12.ico',
      [`${CDN}/sites/1/main.mjs`]: '/sites/1/main.mjs',
    };
    const asked = [];
    const answers = {
      [`${CDN}/sites/1/page-77.mjs`]: 'import("./deeper-5.mjs")',
      [`${CDN}/sites/1/deeper-5.mjs`]: 'export default 1',
      [`${CDN}/sites/1/hero-1a.mp4`]: 'video-bytes',
      'https://www.example-original.test/assets/brochure.pdf': null, // the original answers 404
      'https://www.example-original.test/app-shell.js': 'not-an-asset', // a single-page app answers every path with its page
    };
    const fetchImpl = async (url, { dir: tmp, maxBytes }) => {
      asked.push(url);
      const body = answers[url];
      if (body === undefined || body === null) return { ok: false, reason: 'http-404' };
      if (body === 'not-an-asset') return { ok: false, reason: 'not-an-asset' };
      assert.ok(maxBytes >= (url.endsWith('.mp4') ? 200 * 1024 * 1024 : 1), 'a video may be large');
      const tmpFile = path.join(tmp, `t${asked.length}`);
      await writeFile(tmpFile, body);
      return { ok: true, tmp: tmpFile, bytes: body.length };
    };
    const r = await fetchReferenced({ outDir: dir, pageUrl: SITE, originHosts: new Set(['example-original.test', 'cdn.example-original-cdn.test']), manifest, fetchImpl });
    assert.deepEqual(r.fetched.map((f) => f.path).sort(), ['/sites/1/deeper-5.mjs', '/sites/1/hero-1a.mp4', '/sites/1/page-77.mjs']);
    assert.equal(await readFile(path.join(dir, 'sites/1/deeper-5.mjs'), 'utf8'), 'export default 1', 'a module named by a fetched module is fetched next round');
    assert.equal(manifest[`${CDN}/sites/1/hero-1a.mp4`], '/sites/1/hero-1a.mp4', 'another host\'s file joins the worker\'s map');
    assert.deepEqual(r.bare, [{ path: '/favicon.ico', from: '/favicon~ab12.ico' }]);
    assert.equal(await readFile(path.join(dir, 'favicon.ico'), 'utf8'), 'icon', 'a first visit (no worker yet) still gets the icon');
    assert.equal(r.notOnOriginal, 2, 'a 404 and a page answer are not files of the site');
    assert.deepEqual(r.failed, []);
    assert.equal(new Set(asked).size, asked.length, 'each address asked once');
    await assert.rejects(stat(path.join(dir, 'assets/brochure.pdf')), 'nothing is written for what the original does not serve');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the original\'s own llms.txt is kept, naming the new site only where it named the original', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-llms-'));
  try {
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><title>Acme home page</title></head><body><h1>Acme</h1></body></html>');
    const own = '# Acme\n- [Pricing](https://example-original.test/pricing)\n- https://www.example-original.test/docs\n- https://example-original.test.evil.test/\n';
    const r = await fixAsIsCopy({
      dir, pages: [{ path: '/', outPath: 'index.html', url: SITE }], siteUrl: SITE, newSiteUrl: 'https://new.example.test',
      fetchLlms: async () => ({ text: own }),
    });
    assert.ok(r.files.written.includes('llms.txt'));
    const text = await readFile(path.join(dir, 'llms.txt'), 'utf8');
    assert.match(text, /\(https:\/\/new\.example\.test\/pricing\)/);
    assert.match(text, /- https:\/\/new\.example\.test\/docs/);
    assert.match(text, /example-original\.test\.evil\.test/, 'another host that only starts with the name is left alone');

    const plain = await mkdtemp(path.join(os.tmpdir(), 'sas-llms-'));
    await writeFile(path.join(plain, 'index.html'), '<!doctype html><html><head><title>Acme home page</title></head><body><h1>Acme</h1></body></html>');
    await fixAsIsCopy({ dir: plain, pages: [{ path: '/', outPath: 'index.html', url: SITE }], siteUrl: SITE, newSiteUrl: null, fetchLlms: async () => ({ text: own }) });
    assert.equal(await readFile(path.join(plain, 'llms.txt'), 'utf8'), own, 'no new address: kept exactly as the owner wrote it');
    await rm(plain, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
